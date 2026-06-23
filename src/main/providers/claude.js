// Claude Code provider.
// - Rate-limit windows: LIVE from https://api.anthropic.com/api/oauth/usage,
//   the same endpoint Claude Code uses, authed with the local OAuth token in
//   ~/.claude/.credentials.json. We only READ that token (never refresh/rewrite
//   it) so we don't clobber Claude Code's own credentials.
// - Tokens & cost charts: parsed from ~/.claude/projects/<slug>/<session>.jsonl.
import fs from 'node:fs'
import path from 'node:path'
import { HOME, exists, listJsonl, readJsonlLines, estimateCost, summarize, normalizeRange } from './util.js'

const ROOT = path.join(HOME, '.claude')
const PROJECTS = path.join(ROOT, 'projects')
const CREDENTIALS = path.join(ROOT, '.credentials.json')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

// Soft reference budgets (tokens) — only used as a FALLBACK when the live
// usage API is unavailable (no/expired token, offline).
const BUDGET = { '5h': 12_000_000, weekly: 70_000_000 }

function readToken() {
  try {
    const cred = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'))
    const o = cred.claudeAiOauth || cred
    if (!o?.accessToken) return null
    // expiresAt is epoch ms; treat as expired 60s early
    if (o.expiresAt && o.expiresAt < Date.now() + 60_000) return { expired: true }
    return { token: o.accessToken }
  } catch {
    return null
  }
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

// Cache the last successful live response across polls so transient failures
// (429 rate limiting, brief network blips) don't wipe the real numbers.
let liveCache = null // { windows, extra, at }
let lastAttemptAt = 0
let lastFailure = null // { reason }
const LIVE_TTL = 120_000 // serve cached without hitting the API for 2 min
const MIN_INTERVAL = 60_000 // never hit the API more than once per minute

// Returns { ok, windows, extra, at, reason } — reason set when not ok.
async function fetchLiveWindows() {
  const now = Date.now()
  // Serve fresh cache without calling the API (avoids triggering 429).
  if (liveCache && now - liveCache.at < LIVE_TTL) {
    return { ok: true, ...liveCache, cached: true }
  }
  // Backoff: don't retry too soon after any attempt.
  if (now - lastAttemptAt < MIN_INTERVAL) {
    if (liveCache) return { ok: true, ...liveCache, stale: true, reason: lastFailure?.reason || 'cooldown' }
    return { ok: false, reason: lastFailure?.reason || 'cooldown' }
  }
  lastAttemptAt = now
  const auth = readToken()
  if (!auth || auth.expired || !auth.token) {
    const reason = auth?.expired ? 'token-expired' : 'no-token'
    lastFailure = { reason }
    return liveCache ? { ok: true, ...liveCache, stale: true, reason } : { ok: false, reason }
  }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'franktoken'
      },
      signal: ctrl.signal
    })
    clearTimeout(t)
    if (!res.ok) {
      const reason = res.status === 429 ? 'rate-limited' : `http-${res.status}`
      lastFailure = { reason }
      // keep showing last good data if we have it
      return liveCache ? { ok: true, ...liveCache, stale: true, reason } : { ok: false, reason }
    }
    lastFailure = null
    const d = await res.json()
    const windows = [
      apiWindow('five_hour', '5-Hour Limit', d.five_hour),
      apiWindow('seven_day', 'Weekly · all models', d.seven_day),
      apiWindow('seven_day_opus', 'Weekly · Opus', d.seven_day_opus),
      apiWindow('seven_day_sonnet', 'Weekly · Sonnet', d.seven_day_sonnet)
    ].filter(Boolean)
    liveCache = { windows, extra: d.extra_usage || null, at: Date.now() }
    return { ok: true, ...liveCache }
  } catch {
    lastFailure = { reason: 'network' }
    return liveCache ? { ok: true, ...liveCache, stale: true, reason: 'network' } : { ok: false, reason: 'network' }
  }
}

function emptyTokens() {
  return { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 }
}

export default {
  id: 'claude',
  name: 'Claude Code',
  color: '#d97757',

  detect() {
    return exists(PROJECTS) || exists(ROOT)
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
      meta: { lastActivity: null, sessions: 0, model: null }
    }

    if (!this.detect()) {
      base.error = 'Claude Code not found (~/.claude). Install the Claude Code CLI to track usage.'
      return base
    }

    const days = Math.max(2, Math.ceil((Date.now() - r.from) / 86_400_000) + 1)
    const files = listJsonl(PROJECTS, { days, limit: 600 })
    if (files.length === 0) {
      base.available = true
      base.error = 'No Claude Code sessions found for this range.'
      return base
    }

    base.meta.sessions = files.length
    base.meta.lastActivity = files[0].mtimeMs

    const events = [] // granular per-message usage events
    let model = null
    let lastTs = 0

    for (const f of files) {
      await readJsonlLines(f.path, (obj) => {
        if (!obj) return
        const msg = obj.message || obj
        const usage = msg?.usage
        if (!usage) return
        const m = msg.model || obj.model
        if (m && !/<synthetic>/.test(m)) model = m

        const input = usage.input_tokens || 0
        const output = usage.output_tokens || 0
        const cacheWrite = usage.cache_creation_input_tokens || 0
        const cacheRead = usage.cache_read_input_tokens || 0
        const total = input + output + cacheWrite + cacheRead
        if (total === 0) return

        const ts = obj.timestamp ? Date.parse(obj.timestamp) : f.mtimeMs
        if (ts > lastTs) lastTs = ts

        const usd = estimateCost({ input, output, cacheWrite, cacheRead }, m || 'claude-sonnet-4')
        events.push({ ts, input, output, cachedInput: cacheRead, reasoning: 0, total, usd })
      })
    }

    base.meta.model = model
    base.meta.lastActivity = lastTs || base.meta.lastActivity
    base.available = true

    const now = Date.now()

    // Real plan-usage windows from the official API (cached, with backoff).
    const live = await fetchLiveWindows()
    const reasonText = {
      'rate-limited': 'Live limits temporarily rate-limited',
      'token-expired': 'OAuth token expired — open Claude Code to refresh',
      'no-token': 'No Claude OAuth token found',
      network: 'Network unavailable'
    }

    if (live?.ok && live.windows?.length) {
      base.windows = live.windows
      if (live.extra && live.extra.is_enabled && live.extra.monthly_limit) {
        base.extraUsage = {
          usedCredits: live.extra.used_credits || 0,
          monthlyLimit: live.extra.monthly_limit,
          currency: live.extra.currency || 'USD'
        }
      }
      if (live.stale) {
        const ageMin = Math.round((Date.now() - live.at) / 60_000)
        base.windowsNote = `${reasonText[live.reason] || 'Live update failed'} — showing last known limits (${ageMin}m ago).`
        base.windowsStale = true
      }
    } else {
      // Live API unavailable: show an ESTIMATED consumption gauge from local
      // token volume so usage is still visible (clearly labeled "est.").
      const mkWindow = (id, label, minutes, budget) => {
        const start = now - minutes * 60_000
        const inWin = events.filter((e) => e.ts >= start)
        const used = inWin.reduce((s, e) => s + e.total, 0)
        const oldest = inWin.length ? Math.min(...inWin.map((e) => e.ts)) : null
        return {
          id,
          label: `${label} (est.)`,
          usedPercent: budget ? Math.min(100, (used / budget) * 100) : null,
          windowMinutes: minutes,
          resetsAt: oldest ? oldest + minutes * 60_000 : null,
          estimated: true,
          usedTokens: used,
          budgetTokens: budget
        }
      }
      base.windows = [
        mkWindow('five_hour', '5-Hour Window', 300, BUDGET['5h']),
        mkWindow('seven_day', 'Weekly Window', 10080, BUDGET.weekly)
      ]
      base.windowsEstimated = true
      const why = reasonText[live?.reason] || 'Live limits unavailable'
      base.windowsNote = `${why}. Showing an estimate from local tokens — run \`claude\` (or /login) to restore exact live limits.`
    }

    const sum = summarize(events, r, { costEstimated: true })
    base.tokens = sum.tokens
    base.cost = sum.cost
    base.series = sum.series
    base.range = sum.range

    return base
  }
}
