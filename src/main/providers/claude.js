// Claude provider — covers every Anthropic surface tied to the signed-in
// Claude account: Claude.ai (web/desktop/mobile), Claude Code (CLI, web,
// desktop), Claude Cowork, Claude Design, and the Office plugins.
//
// - Rate-limit windows: LIVE from https://api.anthropic.com/api/oauth/usage —
//   the same account-wide endpoint every Claude surface draws down, so these
//   numbers reflect usage from ANY device you sign into, within seconds of
//   the API updating. Authed with the local OAuth token (credentials file or
//   macOS Keychain). When the access token expires we refresh it with the
//   stored refresh token so live limits keep working without manual /login.
// - Tokens, cost & per-session detail: parsed from local transcripts
//   (~/.claude/projects/<slug>/<session>.jsonl and any extra roots). Local
//   transcripts exist only on machines where a Claude Code-family surface
//   ran, so session granularity is per-machine while the windows are global.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  HOME,
  exists,
  listJsonl,
  readJsonlLines,
  estimateCost,
  summarize,
  normalizeRange,
  RANGE_PRESETS
} from './util.js'
import { buildSessions, sessionCoverage } from './sessions.js'

// Config dir: Claude Code honors CLAUDE_CONFIG_DIR; XDG installs may use
// ~/.config/claude. Scan every root that exists so no surface is missed.
export function claudeRoots() {
  const roots = []
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(process.env.CLAUDE_CONFIG_DIR)
  roots.push(path.join(HOME, '.claude'))
  roots.push(path.join(HOME, '.config', 'claude'))
  return [...new Set(roots)]
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
// Claude Code's public OAuth client id (PKCE app — not a secret).
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/**
 * Fallback window shown when the live usage API is unavailable. Plan limits
 * are not published anywhere, so any percentage we invented here would be
 * fiction — and a fabricated "100%" reads as "you are out of quota". Report
 * the token volume actually observed on this device and leave the gauge
 * explicitly unknown instead.
 */
export function estimatedWindow(id, label, minutes, events, now = Date.now()) {
  const start = now - minutes * 60_000
  const used = events.reduce((sum, e) => (e.ts >= start ? sum + (e.total || 0) : sum), 0)
  return {
    id,
    label,
    usedPercent: null,
    unknown: true,
    windowMinutes: minutes,
    resetsAt: null,
    estimated: true,
    usedTokens: used,
    budgetTokens: null
  }
}

function credentialsCandidates() {
  return claudeRoots().map((r) => path.join(r, '.credentials.json'))
}

// Why the last credential lookup came up empty. Without this, a permission
// error, a half-written file, and "never signed in here" all look identical
// to the user — and live limits silently never work.
let credentialSearch = { checked: [], problems: [] }

function readCredentialsFile() {
  for (const file of credentialsCandidates()) {
    credentialSearch.checked.push(file)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      // ENOENT is the normal "not signed in on this machine" case; anything
      // else (EACCES, EPERM, EBUSY) is a real problem worth surfacing.
      if (err?.code && err.code !== 'ENOENT') credentialSearch.problems.push(`${file} — ${err.code}`)
      continue
    }
    let cred
    try {
      cred = JSON.parse(text)
    } catch {
      credentialSearch.problems.push(`${file} — not valid JSON`)
      continue
    }
    const o = cred.claudeAiOauth || cred
    if (o?.accessToken || o?.refreshToken) return { file, raw: cred, oauth: o }
    credentialSearch.problems.push(`${file} — no OAuth token inside`)
  }
  return null
}

/** Human-readable account of where we looked for a token and what we found. */
export function credentialHint(search = credentialSearch, platform = process.platform) {
  const parts = []
  if (search.problems.length) {
    parts.push(`Found but could not use: ${search.problems.join('; ')}.`)
  } else if (search.checked.length) {
    parts.push(`Looked in ${search.checked.join(', ')}${platform === 'darwin' ? ' and the login Keychain' : ''}.`)
  }
  parts.push('Run `claude` on this machine and sign in once (/login) to enable live account-wide limits.')
  return parts.join(' ')
}

// Newer Claude Code builds on macOS store credentials in the login Keychain
// instead of ~/.claude/.credentials.json.
function readKeychainCredentials() {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const cred = JSON.parse(out.trim())
    const o = cred.claudeAiOauth || cred
    if (o?.accessToken || o?.refreshToken) return { file: null, raw: cred, oauth: o }
  } catch {
    /* keychain entry absent or locked */
  }
  return null
}

// In-memory token from a refresh we could not persist (keychain-backed creds).
let memoryToken = null // { accessToken, expiresAt, refreshToken }

// Token pasted into Settings -> Connect Claude, for machines where the CLI's
// own credentials are unreadable. It arrives without a refresh token, so it is
// strictly a last resort and expires on its own schedule.
let manualToken = null

/** Set (or clear, with a falsy value) the manually supplied access token. */
export function setManualToken(token) {
  const next = token == null ? '' : String(token).trim()
  manualToken = next || null
  // Any cached live result was produced under the old credential; drop it and
  // clear the failure backoff so the next poll re-tests immediately.
  liveCache = null
  lastFailure = null
  lastAttemptAt = 0
  failStreak = 0
  retryAfterAt = 0
  return !!manualToken
}

function readToken() {
  if (memoryToken?.accessToken && memoryToken.expiresAt > Date.now() + 120_000) {
    return {
      token: memoryToken.accessToken,
      expired: false,
      hasRefresh: !!memoryToken.refreshToken,
      source: 'refreshed',
      file: null
    }
  }
  credentialSearch = { checked: [], problems: [] }
  const cred = readCredentialsFile() || readKeychainCredentials()
  if (!cred?.oauth?.accessToken) {
    if (cred?.oauth?.refreshToken) {
      return {
        token: null,
        expired: true,
        hasRefresh: true,
        source: cred.file ? 'file' : 'keychain',
        file: cred.file || null
      }
    }
    return null
  }
  const o = cred.oauth
  return {
    token: o.accessToken,
    // expiresAt is epoch ms; treat as expired 2 min early so we refresh
    // before the API starts rejecting us mid-poll.
    expired: !!(o.expiresAt && o.expiresAt < Date.now() + 120_000),
    hasRefresh: !!o.refreshToken,
    source: cred.file ? 'file' : 'keychain',
    file: cred.file || null,
    expiresAt: o.expiresAt || null
  }
}

// --- automatic token refresh -------------------------------------------- //
// Single-flight + failure backoff so concurrent polls can't stampede the
// token endpoint or burn a rotated refresh token twice.
let refreshInFlight = null
let lastRefreshFailAt = 0
const REFRESH_FAIL_BACKOFF = 10 * 60_000 // after a failure, wait 10 min

async function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight
  if (Date.now() - lastRefreshFailAt < REFRESH_FAIL_BACKOFF) return null
  refreshInFlight = (async () => {
    try {
      const source = readCredentialsFile() || readKeychainCredentials()
      // Prefer the newest refresh token we hold. Keychain-backed credentials
      // can't be rewritten by us, so after a rotation the keychain still
      // carries the OLD refresh token — using it again would fail once the
      // server invalidates rotated tokens. File-backed credentials are kept
      // current (we persist rotations below), so the file wins there.
      const refreshToken = source?.file
        ? source.oauth?.refreshToken || memoryToken?.refreshToken
        : memoryToken?.refreshToken || source?.oauth?.refreshToken
      if (!refreshToken) return null
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 10_000)
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: OAUTH_CLIENT_ID
        }),
        signal: ctrl.signal
      })
      clearTimeout(t)
      if (!res.ok) {
        lastRefreshFailAt = Date.now()
        return null
      }
      const d = await res.json()
      if (!d.access_token) {
        lastRefreshFailAt = Date.now()
        return null
      }
      memoryToken = {
        accessToken: d.access_token,
        expiresAt: Date.now() + (d.expires_in || 3600) * 1000,
        refreshToken: d.refresh_token || refreshToken
      }
      // Persist rotated pair back to the credentials FILE (never the
      // keychain — Claude Code owns that entry). Re-read just before writing:
      // Claude Code may have rewritten it while we were talking to the token
      // endpoint — merge, don't clobber.
      if (source?.file) {
        try {
          let cur
          try {
            cur = JSON.parse(fs.readFileSync(source.file, 'utf8'))
          } catch {
            cur = source.raw
          }
          const curO = cur.claudeAiOauth || cur
          const upd = {
            ...curO,
            accessToken: memoryToken.accessToken,
            expiresAt: memoryToken.expiresAt
          }
          if (d.refresh_token) upd.refreshToken = d.refresh_token
          const next = cur.claudeAiOauth ? { ...cur, claudeAiOauth: upd } : upd
          fs.writeFileSync(source.file, JSON.stringify(next))
        } catch {
          /* keep the in-memory token */
        }
      }
      return d.access_token
    } catch {
      lastRefreshFailAt = Date.now()
      return null
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

// Map an API window object {utilization, resets_at} -> our Window shape.
function apiWindow(id, label, w) {
  if (!w || w.utilization == null) return null
  return {
    id,
    label,
    usedPercent: Number(w.utilization) || 0,
    windowMinutes: id === 'five_hour' ? 300 : 10080,
    resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
    estimated: false
  }
}

// Generic limits[] array parsing. The shape has drifted repeatedly (legacy
// top-level fields -> limits[] with kind:"session"/group:"weekly" ->
// weekly_scoped entries with scope.model / scope.surface), so accept every
// variant we have observed rather than expecting one.
export function limitsWindows(limits) {
  if (!Array.isArray(limits)) return []
  const out = []
  for (const l of limits) {
    if (!l) continue
    const pct = l.percent ?? l.utilization ?? (l.used != null && l.limit ? (l.used / l.limit) * 100 : null)
    if (pct == null) continue
    // When the API reports raw counts, keep them: an account-wide token total
    // is live on every device, unlike the local-transcript figures. Previously
    // these were read only to derive a percentage and then thrown away.
    const usedTokens = numberOrNull(l.used ?? l.used_tokens ?? l.usage)
    const budgetTokens = numberOrNull(l.limit ?? l.limit_tokens ?? l.max)
    const counts = usedTokens == null && budgetTokens == null ? {} : { usedTokens, budgetTokens }
    const kind = String(l.kind || l.type || '')
    const group = String(l.group || '')
    const resetsAt = l.resets_at ? Date.parse(l.resets_at) : null
    const scopeName =
      l.scope?.model?.display_name || l.scope?.model?.name || l.scope?.surface || l.scope?.display_name || null
    if (kind === 'session' || kind === 'five_hour' || group === 'session') {
      out.push({
        id: 'five_hour',
        label: '5-Hour Limit',
        usedPercent: Number(pct) || 0,
        windowMinutes: 300,
        resetsAt,
        estimated: false,
        ...counts
      })
    } else if (group === 'weekly' || kind.startsWith('weekly') || kind === 'seven_day') {
      out.push({
        id: scopeName ? `weekly_${scopeName.toLowerCase().replace(/\W+/g, '_')}` : 'seven_day',
        label: scopeName ? `Weekly · ${scopeName}` : 'Weekly · all models',
        usedPercent: Number(pct) || 0,
        windowMinutes: 10080,
        resetsAt,
        estimated: false,
        ...counts
      })
    } else if (group === 'monthly' || kind.startsWith('monthly')) {
      out.push({
        id: scopeName ? `monthly_${scopeName.toLowerCase().replace(/\W+/g, '_')}` : 'monthly',
        label: scopeName ? `Monthly · ${scopeName}` : 'Monthly',
        usedPercent: Number(pct) || 0,
        windowMinutes: 43200,
        resetsAt,
        estimated: false,
        ...counts
      })
    }
  }
  return out
}

// One place that knows how to call the account-wide usage endpoint, shared by
// the poller and by the Connect Claude panel's "test this token" probe.
function usageFetch(token, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'franktoken'
    },
    signal: ctrl.signal
  }).finally(() => clearTimeout(t))
}

/**
 * Test a token against the live usage endpoint and report what actually
 * happened. The Connect Claude panel never claims a pasted token works —
 * it shows the result of this call.
 */
export async function probeUsage(token) {
  const trimmed = token == null ? '' : String(token).trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  let res
  try {
    res = await usageFetch(trimmed, 10_000)
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected', status: res.status }
  if (res.status === 429) return { ok: false, reason: 'rate-limited', status: 429 }
  if (!res.ok) return { ok: false, reason: `http-${res.status}`, status: res.status }
  let body
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  let windows = limitsWindows(body.limits)
  if (windows.length === 0) {
    windows = [
      apiWindow('five_hour', '5-Hour Limit', body.five_hour),
      apiWindow('seven_day', 'Weekly · all models', body.seven_day)
    ].filter(Boolean)
  }
  // Authenticated but the payload carried no window we recognize — worth
  // distinguishing from a flat rejection, since it means the API shape moved.
  if (windows.length === 0) return { ok: false, reason: 'no-windows' }
  return { ok: true, windowCount: windows.length, labels: windows.map((w) => w.label) }
}

/**
 * Everything the Connect Claude panel needs to explain the current state:
 * which credential we are using, when it expires, why the last live call
 * failed, and where we looked if we found nothing.
 */
export function authStatus() {
  const auth = readToken()
  const usable = !!(auth?.token && !auth.expired) || (!!manualToken && !auth?.token)
  return {
    connected: usable,
    source: auth?.source || (manualToken ? 'manual' : null),
    file: auth?.file || null,
    expiresAt: auth?.expiresAt || null,
    expired: !!auth?.expired,
    canRefresh: !!auth?.hasRefresh,
    hasManualToken: !!manualToken,
    checked: [...credentialSearch.checked],
    problems: [...credentialSearch.problems],
    platform: process.platform,
    lastFailure: lastFailure?.reason || null,
    liveAt: liveCache?.at || null,
    hint: credentialHint()
  }
}

// Cache the last successful live response across polls so transient failures
// (429 rate limiting, brief network blips) don't wipe the real numbers.
let liveCache = null // { windows, extra, at }
let lastAttemptAt = 0
let lastFailure = null // { reason }
// The 5-hour and weekly windows move over hours, so polling the API every few
// seconds buys nothing and earns a 429 — which then shows N/A and is strictly
// worse than a value a minute old. Cadence is deliberately slow; the local
// transcript watchers still refresh tokens/cost within seconds.
const LIVE_TTL = 90_000 // serve cached without hitting the API for 90s
const MIN_INTERVAL = 90_000 // never hit the API more than every 90s
// Escalating cooldown after a rejection. Retrying a 429 on the normal interval
// keeps the account rate-limited; waiting minutes costs almost nothing here.
const BACKOFF_STEPS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]
let failStreak = 0
let retryAfterAt = 0 // absolute ms before which we must not call the API again

/**
 * How long to wait after a rejected live call. Honors a server-provided
 * Retry-After (seconds) when present, otherwise escalates through
 * BACKOFF_STEPS by consecutive-failure count.
 */
export function backoffDelay(streak, retryAfterSeconds = null) {
  const seconds = Number(retryAfterSeconds)
  if (Number.isFinite(seconds) && seconds > 0) {
    // Trust the server, but never sleep longer than the largest step.
    return Math.min(seconds * 1000, BACKOFF_STEPS[BACKOFF_STEPS.length - 1])
  }
  const i = Math.min(Math.max(streak, 1) - 1, BACKOFF_STEPS.length - 1)
  return BACKOFF_STEPS[i]
}

// Last good windows, persisted by the main process so a restart that lands on
// a 429 can still show the numbers from minutes ago instead of N/A. Older than
// this and the percentages are too likely to have moved to be worth showing.
const MAX_RESTORE_AGE = 30 * 60_000

/** Serializable view of the last successful live response, or null. */
export function snapshotLiveCache() {
  if (!liveCache?.windows?.length || !liveCache.at) return null
  return { windows: liveCache.windows, extra: liveCache.extra || null, at: liveCache.at }
}

/** Re-seed the cache at startup. Ignores anything too old to still be true. */
export function restoreLiveCache(saved, now = Date.now()) {
  if (!saved?.windows?.length || !saved.at) return false
  if (now - saved.at > MAX_RESTORE_AGE) return false
  liveCache = { windows: saved.windows, extra: saved.extra || null, at: saved.at }
  return true
}

// Returns { ok, windows, extra, at, reason } — reason set when not ok.
async function fetchLiveWindows() {
  const now = Date.now()
  // Serve fresh cache without calling the API (avoids triggering 429).
  if (liveCache && now - liveCache.at < LIVE_TTL) {
    return { ok: true, ...liveCache, cached: true }
  }
  // Hard cooldown from a previous rejection takes precedence: calling again
  // before it expires is what keeps a 429 alive.
  if (now < retryAfterAt) {
    const reason = lastFailure?.reason || 'cooldown'
    if (liveCache) return { ok: true, ...liveCache, stale: true, reason, retryAt: retryAfterAt }
    return { ok: false, reason, retryAt: retryAfterAt }
  }
  // Backoff: don't retry too soon after any attempt.
  if (now - lastAttemptAt < MIN_INTERVAL) {
    if (liveCache) return { ok: true, ...liveCache, stale: true, reason: lastFailure?.reason || 'cooldown' }
    return { ok: false, reason: lastFailure?.reason || 'cooldown' }
  }
  lastAttemptAt = now
  let auth = readToken()
  // Expired (or missing) access token but a refresh token available: refresh
  // automatically, so live limits never require a manual /login.
  if ((!auth || auth.expired || !auth.token) && (auth?.hasRefresh || !auth)) {
    const fresh = await refreshAccessToken()
    if (fresh) auth = { token: fresh, expired: false, source: 'refreshed' }
  }
  // Nothing usable from the CLI's own credentials: fall back to a token the
  // user pasted in Settings. Cannot be refreshed, so it simply stops working
  // when it expires — the panel surfaces that as an expired-token state.
  if ((!auth || auth.expired || !auth.token) && manualToken) {
    auth = { token: manualToken, expired: false, hasRefresh: false, source: 'manual' }
  }
  if (!auth || auth.expired || !auth.token) {
    const reason = auth?.expired ? 'token-expired' : 'no-token'
    lastFailure = { reason }
    return liveCache ? { ok: true, ...liveCache, stale: true, reason } : { ok: false, reason }
  }
  try {
    let res = await usageFetch(auth.token)
    // Server rejected the token even though it looked valid locally (e.g.
    // revoked or clock skew): refresh once and retry.
    if (res.status === 401) {
      const fresh = await refreshAccessToken()
      if (fresh) res = await usageFetch(fresh)
    }
    if (!res.ok) {
      const reason = res.status === 429 ? 'rate-limited' : `http-${res.status}`
      lastFailure = { reason }
      failStreak += 1
      retryAfterAt = now + backoffDelay(failStreak, res.headers?.get?.('retry-after'))
      // keep showing last good data if we have it
      return liveCache
        ? { ok: true, ...liveCache, stale: true, reason, retryAt: retryAfterAt }
        : { ok: false, reason, retryAt: retryAfterAt }
    }
    lastFailure = null
    failStreak = 0
    retryAfterAt = 0
    const d = await res.json()
    // Prefer the newer limits[] array (carries per-model scoped windows);
    // fall back to the legacy top-level fields for older API responses.
    let windows = limitsWindows(d.limits)
    if (windows.length === 0) {
      windows = [
        apiWindow('five_hour', '5-Hour Limit', d.five_hour),
        apiWindow('seven_day', 'Weekly · all models', d.seven_day),
        apiWindow('seven_day_opus', 'Weekly · Opus', d.seven_day_opus),
        apiWindow('seven_day_sonnet', 'Weekly · Sonnet', d.seven_day_sonnet)
      ].filter(Boolean)
    }
    liveCache = { windows, extra: d.extra_usage || null, at: Date.now() }
    return { ok: true, ...liveCache }
  } catch {
    lastFailure = { reason: 'network' }
    failStreak += 1
    retryAfterAt = now + backoffDelay(failStreak)
    return liveCache
      ? { ok: true, ...liveCache, stale: true, reason: 'network', retryAt: retryAfterAt }
      : { ok: false, reason: 'network', retryAt: retryAfterAt }
  }
}

function emptyTokens() {
  return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
}

function numberOrNull(value) {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function tokenNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Map a transcript row's entrypoint to a human surface label.
export function surfaceLabel(entrypoint) {
  if (!entrypoint) return null
  const e = String(entrypoint).toLowerCase()
  if (e.includes('cowork')) return 'Cowork'
  if (e.includes('design')) return 'Design'
  if (e.includes('remote')) return 'Claude Code · web'
  if (e.includes('desktop')) return 'Claude Code · desktop'
  if (e === 'cli' || e.includes('terminal')) return 'Claude Code · CLI'
  if (e.includes('sdk')) return 'Agent SDK'
  if (e.includes('vscode') || e.includes('ide') || e.includes('jetbrains')) return 'Claude Code · IDE'
  return entrypoint
}

// Claude Code can persist the same API message repeatedly while streaming tool
// calls, and copied conversation history can appear in branched transcripts.
// Message IDs are globally unique, so retain only the most complete usage
// snapshot for each ID. Without this, a single model call can be counted many
// times (we have observed 10+ identical rows for one message).
export function claudeUsageEvent(obj, fallbackTs = 0) {
  if (!obj) return null
  const msg = obj.message || obj
  const usage = msg?.usage
  if (!usage) return null

  const input = tokenNumber(usage.input_tokens)
  const output = tokenNumber(usage.output_tokens)
  const cacheWrite = tokenNumber(usage.cache_creation_input_tokens)
  const cacheRead = tokenNumber(usage.cache_read_input_tokens)
  const total = input + output + cacheWrite + cacheRead
  if (total === 0) return null

  return {
    key: msg.id ? `message:${msg.id}` : null,
    ts: (obj.timestamp ? Date.parse(obj.timestamp) : 0) || fallbackTs,
    input,
    output,
    cachedInput: cacheRead,
    cacheWrite,
    reasoning: 0,
    total,
    model: msg.model || obj.model || null,
    sessionId: obj.sessionId || null
  }
}

export function dedupeClaudeUsageEvents(candidates) {
  const keyed = new Map()
  const unkeyed = []
  for (const event of candidates) {
    if (!event?.key) {
      if (event) unkeyed.push(event)
      continue
    }
    const previous = keyed.get(event.key)
    // Streaming snapshots grow as the response completes. Prefer the largest
    // provider-reported total; for identical copies keep the earliest time so
    // range boundaries reflect when the model response first completed.
    if (!previous || event.total > previous.total || (event.total === previous.total && event.ts < previous.ts)) {
      keyed.set(event.key, event)
    }
  }
  return [...keyed.values(), ...unkeyed]
}

export function selectClaudeHistoryFiles(allFiles, days, now = Date.now()) {
  if (!Number.isFinite(days)) return [...allFiles]
  const cutoff = now - days * 86_400_000
  return allFiles.filter((file) => file.mtimeMs >= cutoff)
}

/**
 * Name only the presets that would actually contain the newest recorded call.
 * Telling someone to "try 7D" when their newest call is 12 days old just sends
 * them to another empty screen.
 */
export function suggestRanges(newestEventAt, from, now = Date.now()) {
  if (!newestEventAt || newestEventAt >= from) return ''
  const usable = Object.entries(RANGE_PRESETS)
    .filter(([, days]) => now - days * 86_400_000 <= newestEventAt)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id.toUpperCase())
  if (usable.length === 0) {
    // Older than every preset — Custom is the only range that reaches it.
    return ' — older than 90D, so use Custom to see it'
  }
  const list = usable.length === 1 ? usable[0] : `${usable.slice(0, -1).join(', ')} or ${usable[usable.length - 1]}`
  return ` — try ${list}`
}

/**
 * Explain an empty range honestly. The hard part is not the wording: the
 * provider only reads transcripts recent enough to matter for the requested
 * range, so "no usage rows" can mean either "nothing here records a model
 * call" or "the files that do were not opened". Saying the former when the
 * latter is true sends the user to a wider range that will not help, or stops
 * them trying one that would.
 *
 * Returns null when the range has data and needs no explanation.
 */
export function emptyRangeMessage({
  totalFiles = 0,
  scannedFiles = 0,
  usageRows = 0,
  sessionsInRange = 0,
  newestEventAt = null,
  undatedRows = 0,
  from = 0,
  now = Date.now()
} = {}) {
  if (totalFiles === 0) {
    return (
      'No local Claude sessions found. Account-wide limits still shown live; session detail ' +
      'appears once a Claude surface runs on this machine.'
    )
  }
  if (sessionsInRange > 0) return null

  const fileLabel = `${totalFiles} local transcript${totalFiles === 1 ? '' : 's'}`
  const elsewhere =
    'Work done in Claude Code on the web, on another machine, or in Claude.ai / Cowork leaves no ' +
    'transcript here; that usage still counts against the account-wide windows above.'
  let message

  if (usageRows === 0 && scannedFiles >= totalFiles) {
    // Everything was scanned, so this claim is actually supported: signing in
    // writes a transcript without ever calling the model. A wider range cannot
    // help, so do not suggest one.
    message =
      `${fileLabel} found, and none records a model call yet — signing in writes a transcript ` +
      `without using the model. Ask Claude Code something on this machine and it appears here ` +
      `within seconds. ${elsewhere}`
  } else if (usageRows === 0) {
    const skipped = totalFiles - scannedFiles
    message =
      `No Claude model calls in the ${scannedFiles} transcript${scannedFiles === 1 ? '' : 's'} ` +
      `active in this range. ${skipped} older transcript${skipped === 1 ? '' : 's'} not scanned ` +
      `for it — widen the range to include them. ${elsewhere}`
  } else {
    const hours = newestEventAt ? Math.round((now - newestEventAt) / 3_600_000) : null
    const age = hours == null ? 'not datable' : hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
    message =
      `No Claude model calls on this device in this range. Newest recorded call: ${age}` +
      `${suggestRanges(newestEventAt, from, now)}. ${fileLabel} scanned. ${elsewhere}`
  }

  if (undatedRows > 0) {
    message +=
      ` (${undatedRows} usage row${undatedRows === 1 ? '' : 's'} had no readable timestamp and ` +
      `were dated from the file instead.)`
  }
  return message
}

export default {
  id: 'claude',
  name: 'Claude',
  // Series colors are CVD-validated as a set against the app's dark surface
  // (claude #cf6a45 · codex #159d74 · chatgpt #9080e8) — change together.
  color: '#cf6a45',

  detect() {
    return claudeRoots().some((r) => exists(r))
  },

  async fetch(range) {
    const r = normalizeRange(range)
    const base = {
      id: this.id,
      name: this.name,
      color: this.color,
      available: false,
      error: null,
      windows: [],
      tokens: emptyTokens(),
      cost: { today: 0, total: 0, currency: 'USD', estimated: true },
      series: { tokensByDay: [], costByDay: [] },
      sessions: [],
      // Rate-limit windows come from the account-wide usage API and cover
      // every surface & device (Claude.ai, Code, Cowork, Design, plugins).
      // Session detail is parsed from this machine's transcripts (plus the
      // Hub's remote sessions, merged upstream in the poller).
      coverage: sessionCoverage('local', 'seconds'),
      meta: { lastActivity: null, sessions: 0, model: null }
    }

    if (!this.detect()) {
      base.error = 'No Claude data found (~/.claude). Sign in to Claude Code, Cowork, or the desktop app to track usage.'
      return base
    }

    base.available = true

    const days = Math.max(2, Math.ceil((Date.now() - r.from) / 86_400_000) + 1)
    // Discover the complete local history first. A narrow range must not make
    // an installed Claude history look like it has never existed.
    const allFiles = claudeRoots()
      .map((root) => listJsonl(path.join(root, 'projects'), { days: Number.POSITIVE_INFINITY }))
      .flat()
    const files = selectClaudeHistoryFiles(allFiles, days)
    base.meta.totalSessions = allFiles.length
    base.meta.lastActivity = allFiles.reduce((m, f) => Math.max(m, f.mtimeMs), 0) || null

    // No local sessions in the selected range is NOT a fatal state: the
    // rate-limit windows below come from the live API and reflect "right now"
    // plan usage independent of the chosen historical range, so we still want
    // to render them. We just note that the token/cost charts have no data.
    const candidates = [] // raw transcript rows; deduplicated below by API message id
    let events = [] // one complete event per unique model response
    const modelTokens = new Map() // model -> total tokens (for badge ordering)
    const fileMeta = new Map() // path -> {sessionId, cwd, branch, entrypoint}
    let undatedRows = 0 // usage rows whose own timestamp was missing/unparseable

    if (files.length > 0) {
      for (const f of files) {
        const meta = { sessionId: null, cwd: null, branch: null, entrypoint: null }
        fileMeta.set(f.path, meta)
        await readJsonlLines(f.path, (obj) => {
          if (!obj) return
          if (obj.sessionId && !meta.sessionId) meta.sessionId = obj.sessionId
          if (obj.cwd && !meta.cwd) meta.cwd = obj.cwd
          if (obj.gitBranch && !meta.branch) meta.branch = obj.gitBranch
          if (obj.entrypoint) meta.entrypoint = obj.entrypoint
          const event = claudeUsageEvent(obj, f.mtimeMs)
          if (event) {
            // A row with no parseable timestamp falls back to the file mtime,
            // which distorts which range it lands in. Count them so the UI can
            // say so instead of silently mis-bucketing.
            if (!(obj.timestamp && Number.isFinite(Date.parse(obj.timestamp)))) undatedRows += 1
            candidates.push({ ...event, source: f.path })
          }
        })
      }

      events = dedupeClaudeUsageEvents(candidates)
      const rangeEvents = events.filter((event) => event.ts >= r.from && event.ts <= r.to)
      base.meta.sessions = new Set(
        rangeEvents.map((event) => event.sessionId || event.source).filter(Boolean)
      ).size

      for (const event of events) {
        const m = event.model
        if (event.ts >= r.from && event.ts <= r.to && m && !/<synthetic>/.test(m)) {
          modelTokens.set(m, (modelTokens.get(m) || 0) + event.total)
        }
        event.usd = estimateCost(
          {
            input: event.input,
            output: event.output,
            cacheWrite: event.cacheWrite,
            cacheRead: event.cachedInput
          },
          m || 'claude-sonnet-4'
        )
      }

      // All models seen in range, heaviest-usage first. meta.model stays the
      // top one for back-compat; meta.models carries the full list for the UI.
      const models = [...modelTokens.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
      base.meta.model = models[0] || null
      base.meta.models = models

      // ---- per-session granularity ---------------------------------- //
      // Enrich events with transcript metadata so buildSessions can name each
      // session after its project and tag it with the surface it ran on
      // (CLI / web / desktop / IDE / Cowork), then emit the shared session
      // shape the dashboard, hub sync, and report all consume.
      for (const event of events) {
        const meta = fileMeta.get(event.source) || {}
        if (meta.cwd) event.title = path.basename(meta.cwd)
        event.product = surfaceLabel(meta.entrypoint) || 'Claude Code'
      }
      base.sessions = buildSessions(events, r, {
        provider: 'claude',
        product: 'Claude Code',
        sourceType: 'local',
        sourceLabel: 'Claude transcript',
        freshness: 'seconds',
        costKind: 'estimated'
      })
    }

    // Diagnostics the UI can state plainly rather than leaving the user to
    // reconcile a fresh file mtime against an empty token total.
    base.meta.usageRows = candidates.length
    base.meta.undatedRows = undatedRows
    base.meta.newestEventAt = events.reduce((m, e) => Math.max(m, e.ts || 0), 0) || null

    base.error =
      emptyRangeMessage({
        totalFiles: allFiles.length,
        scannedFiles: files.length,
        usageRows: candidates.length,
        sessionsInRange: base.meta.sessions,
        newestEventAt: base.meta.newestEventAt,
        undatedRows,
        from: r.from
      }) || base.error

    const now = Date.now()

    // Real plan-usage windows from the official API (cached, with backoff).
    const live = await fetchLiveWindows()
    // Name the recovery time: "rate-limited" with no horizon reads as broken.
    const retryIn =
      live?.retryAt && live.retryAt > now
        ? ` — retrying in ${Math.max(1, Math.round((live.retryAt - now) / 60_000))} min`
        : ''
    const reasonText = {
      'rate-limited': `Live limits rate-limited by the API${retryIn}`,
      'token-expired': 'OAuth token expired and auto-refresh failed — run `claude` and /login once',
      'no-token': `No Claude OAuth token found. ${credentialHint()}`,
      network: `Network unavailable${retryIn}`
    }

    if (live?.ok && live.windows?.length) {
      base.windows = live.windows
      // When the API actually produced these numbers. The poll loop runs far
      // more often than the API is called, so consumers need this to avoid
      // recording the same response over and over.
      base.windowsAt = live.at || now
      if (live.extra && live.extra.is_enabled && live.extra.monthly_limit) {
        base.extraUsage = {
          usedCredits: live.extra.used_credits || 0,
          monthlyLimit: live.extra.monthly_limit,
          currency: live.extra.currency || 'USD'
        }
      }
      if (live.stale) {
        const ageMin = Math.round((Date.now() - live.at) / 60_000)
        const why = (reasonText[live.reason] || 'Live update failed').replace(/[.\s]+$/, '')
        base.windowsNote = `${why}. Showing last known limits (${ageMin}m ago).`
        base.windowsStale = true
      }
    } else {
      // Live API unavailable: report the token volume seen on this device and
      // leave the gauge unknown — we have no real limit to measure against.
      base.windows = [
        estimatedWindow('five_hour', '5-Hour Window', 300, events, now),
        estimatedWindow('seven_day', 'Weekly Window', 10080, events, now)
      ]
      base.windowsEstimated = true
      const why = (reasonText[live?.reason] || 'Live limits unavailable').replace(/[.\s]+$/, '')
      base.windowsNote =
        `${why}. Percentages need the live API — the figures below are only the tokens this ` +
        `device recorded in each window.` +
        // A 429 is not an account problem, and reads like one without saying so.
        (live?.reason === 'rate-limited' ? ' This resolves on its own; nothing is wrong with your account.' : '')
    }

    const sum = summarize(events, r, { costEstimated: true, defaultModel: 'claude-sonnet-4' })
    base.tokens = sum.tokens
    base.cost = sum.cost
    base.noCache = sum.noCache
    base.series = sum.series
    base.range = sum.range
    base.sessions = buildSessions(events, r, {
      provider: 'claude',
      product: 'Claude Code',
      sourceType: 'local',
      sourceLabel: 'Claude Code transcript',
      freshness: 'seconds',
      costKind: 'estimated'
    })

    // Per-model breakdown so the UI can filter by clicking a model badge.
    // Models with zero tokens inside the range are dropped (recently-touched
    // files can carry old events from models not actually used in the range).
    base.byModel = {}
    for (const mName of base.meta.models || []) {
      const ms = summarize(events.filter((e) => e.model === mName), r, { costEstimated: true, defaultModel: 'claude-sonnet-4' })
      if (ms.tokens.total > 0) base.byModel[mName] = { tokens: ms.tokens, cost: ms.cost, series: ms.series, noCache: ms.noCache }
    }
    base.meta.models = (base.meta.models || []).filter((m) => base.byModel[m])
    base.meta.model = base.meta.models[0] || null

    return base
  }
}
