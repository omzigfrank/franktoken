import test from 'node:test'
import assert from 'node:assert/strict'

import {
  claudeUsageEvent,
  dedupeClaudeUsageEvents,
  selectClaudeHistoryFiles,
  limitsWindows,
  surfaceLabel,
  estimatedWindow,
  credentialHint,
  authStatus,
  setManualToken,
  probeUsage,
  emptyRangeMessage,
  suggestRanges,
  backoffDelay,
  restoreLiveCache,
  snapshotLiveCache
} from '../src/main/providers/claude.js'
import { cliCandidates, loginCommand, linuxTerminal } from '../src/main/claudeAuth.js'
import { codexCumulativeUsage, codexUsageDelta } from '../src/main/providers/codex.js'
import { estimateTextTokens, chatgptConversationEvents } from '../src/main/providers/chatgpt.js'
import {
  summarize,
  priceFor,
  PRICING,
  resolvePreset,
  RANGE_PRESETS,
  normalizeRange,
  estimateCost,
  estimateCostNoCache,
  tokensWithoutCache
} from '../src/main/providers/util.js'
import { buildSessions } from '../src/main/providers/sessions.js'
import { mergeSnapshots } from '../src/main/providers/hub.js'
import {
  toSample,
  pruneHistory,
  addSample,
  currentSegment,
  burnRate,
  projectExhaustion,
  summarizeHistory,
  knownWindows,
  FULL_RESOLUTION_MS,
  COARSE_BUCKET_MS,
  MIN_SAMPLE_GAP_MS,
  MAX_SERIES_POINTS,
  seriesFor
} from '../src/main/limitHistory.js'

test('Claude usage keeps one complete snapshot per message id', () => {
  const partial = claudeUsageEvent({
    timestamp: '2026-07-21T12:00:00Z',
    message: {
      id: 'msg_1',
      model: 'claude-opus',
      usage: { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }
    }
  })
  const complete = claudeUsageEvent({
    timestamp: '2026-07-21T12:00:01Z',
    message: {
      id: 'msg_1',
      model: 'claude-opus',
      usage: { input_tokens: 2, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }
    }
  })
  const copied = { ...complete, ts: complete.ts + 5_000 }

  const events = dedupeClaudeUsageEvents([partial, complete, copied])
  assert.equal(events.length, 1)
  assert.equal(events[0].total, 82)
  assert.equal(events[0].ts, complete.ts)
})

test('Claude history discovery keeps stored sessions visible outside a narrow range', () => {
  const now = Date.parse('2026-07-22T12:00:00Z')
  const files = [
    { path: 'recent.jsonl', mtimeMs: now - 12 * 60 * 60_000 },
    { path: 'older.jsonl', mtimeMs: now - 5 * 86_400_000 }
  ]

  assert.deepEqual(selectClaudeHistoryFiles(files, 2, now), [files[0]])
  assert.deepEqual(selectClaudeHistoryFiles(files, Number.POSITIVE_INFINITY, now), files)
})

test('OpenAI cached tokens are a subset of input, not extra total usage', () => {
  const first = codexCumulativeUsage({
    input_tokens: 1_000,
    cached_input_tokens: 600,
    cache_write_input_tokens: 100,
    output_tokens: 200,
    reasoning_output_tokens: 50,
    total_tokens: 1_200
  })
  const second = codexCumulativeUsage({
    input_tokens: 1_500,
    cached_input_tokens: 900,
    cache_write_input_tokens: 100,
    output_tokens: 300,
    reasoning_output_tokens: 80,
    total_tokens: 1_800
  })

  assert.deepEqual(codexUsageDelta(first), {
    input: 300,
    cachedInput: 600,
    cacheWrite: 100,
    output: 200,
    reasoning: 50,
    total: 1_200
  })
  assert.deepEqual(codexUsageDelta(second, first), {
    input: 200,
    cachedInput: 300,
    cacheWrite: 0,
    output: 100,
    reasoning: 30,
    total: 600
  })
})

test('limits[] parsing tolerates every observed usage-API shape', () => {
  // percent + kind/group (current shape)
  const current = limitsWindows([
    { kind: 'session', percent: 42, resets_at: '2026-08-16T04:00:00Z' },
    { kind: 'weekly_scoped', group: 'weekly', percent: 12, scope: { model: { display_name: 'Opus' } } }
  ])
  assert.equal(current.length, 2)
  assert.equal(current[0].id, 'five_hour')
  assert.equal(current[0].usedPercent, 42)
  assert.equal(current[1].label, 'Weekly · Opus')

  // utilization instead of percent; seven_day kind; surface scope
  const drifted = limitsWindows([
    { kind: 'five_hour', utilization: 9 },
    { kind: 'seven_day', utilization: 55 },
    { kind: 'weekly_scoped', group: 'weekly', percent: 3, scope: { surface: 'Cowork' } }
  ])
  assert.equal(drifted.length, 3)
  assert.equal(drifted[0].usedPercent, 9)
  assert.equal(drifted[1].windowMinutes, 10080)
  assert.equal(drifted[2].label, 'Weekly · Cowork')

  // used/limit pair fallback
  const ratio = limitsWindows([{ kind: 'session', used: 25, limit: 100 }])
  assert.equal(ratio[0].usedPercent, 25)

  assert.deepEqual(limitsWindows(null), [])
})

test('fallback windows report observed tokens and never invent a percentage', () => {
  const now = Date.parse('2026-08-16T12:00:00Z')
  const events = [
    { ts: now - 60 * 60_000, total: 5_000_000 }, // 1h ago — inside both windows
    { ts: now - 20 * 3_600_000, total: 3_000_000 }, // 20h ago — weekly only
    { ts: now - 40 * 86_400_000, total: 900_000_000 } // 40d ago — outside both
  ]

  const fiveHour = estimatedWindow('five_hour', '5-Hour Window', 300, events, now)
  assert.equal(fiveHour.usedTokens, 5_000_000)
  assert.equal(fiveHour.usedPercent, null)
  assert.equal(fiveHour.unknown, true)
  assert.equal(fiveHour.budgetTokens, null)

  const weekly = estimatedWindow('seven_day', 'Weekly Window', 10080, events, now)
  assert.equal(weekly.usedTokens, 8_000_000)
  // A huge local history must never render as "100% of quota used".
  assert.equal(weekly.usedPercent, null)
})

test('credential hint names the paths checked and distinguishes real problems', () => {
  const missing = credentialHint({ checked: ['C:\\Users\\x\\.claude\\.credentials.json'], problems: [] }, 'win32')
  assert.match(missing, /Looked in C:\\Users\\x\\\.claude\\\.credentials\.json/)
  assert.doesNotMatch(missing, /Keychain/) // never mention Keychain off macOS
  assert.match(missing, /sign in once/)

  const onMac = credentialHint({ checked: ['/home/f/.claude/.credentials.json'], problems: [] }, 'darwin')
  assert.match(onMac, /login Keychain/)

  const broken = credentialHint({ checked: ['/x/.credentials.json'], problems: ['/x/.credentials.json — EACCES'] }, 'linux')
  assert.match(broken, /could not use: \/x\/\.credentials\.json — EACCES/)
})

test('surface labels map transcript entrypoints to human names', () => {
  assert.equal(surfaceLabel('cli'), 'Claude Code · CLI')
  assert.equal(surfaceLabel('remote_desktop'), 'Claude Code · web')
  assert.equal(surfaceLabel('cowork-local'), 'Cowork')
  assert.equal(surfaceLabel(null), null)
})

test('sessions carry per-event surface products and titles through buildSessions', () => {
  const start = Date.parse('2026-08-15T10:00:00Z')
  const sessions = buildSessions(
    [
      { ts: start, sessionId: 's1', title: 'franktoken', product: 'Cowork', model: 'claude-opus-5', input: 5, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0, total: 10, usd: 0.001 },
      { ts: start + 1_000, sessionId: 's1', title: 'franktoken', product: 'Cowork', model: 'claude-opus-5', input: 5, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0, total: 10, usd: 0.001 }
    ],
    { from: start - 1, to: start + 10_000 },
    { provider: 'claude', product: 'Claude Code', sourceType: 'local' }
  )
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].product, 'Cowork')
  assert.equal(sessions[0].title, 'franktoken')
  assert.equal(sessions[0].tokens.total, 20)
})

test('pricing matches most-specific model key first', () => {
  assert.equal(priceFor('claude-opus-4-8'), PRICING['claude-opus-4-8'])
  assert.equal(priceFor('claude-opus-4-20250514'), PRICING['claude-opus-4'])
  assert.equal(priceFor('claude-fable-5'), PRICING['claude-fable-5'])
  assert.equal(priceFor('gpt-5-codex-mini'), PRICING['gpt-5-codex'])
  assert.equal(priceFor('mystery-model'), PRICING.default)
})

test('ChatGPT export conversations become estimated usage events', () => {
  assert.equal(estimateTextTokens('abcdefgh'), 2)
  const convo = {
    conversation_id: 'c1',
    title: 'Test chat',
    create_time: 1755200000,
    mapping: {
      a: { message: { author: { role: 'user' }, create_time: 1755200000, content: { content_type: 'text', parts: ['hello there, how are you?'] } } },
      b: {
        message: {
          author: { role: 'assistant' },
          create_time: 1755200060,
          metadata: { model_slug: 'gpt-5' },
          content: { content_type: 'text', parts: ['I am doing great, thanks for asking!'] }
        }
      },
      root: { message: null }
    }
  }
  const events = chatgptConversationEvents(convo)
  assert.equal(events.length, 2)
  assert.equal(events[0].input > 0 && events[0].output === 0, true)
  assert.equal(events[1].output > 0 && events[1].input === 0, true)
  assert.equal(events[1].model, 'gpt-5')
  assert.ok(events[1].usd > 0)
})

test('summary preserves cache-write tokens without inflating provider totals', () => {
  const now = Date.now()
  const result = summarize(
    [{ ts: now, input: 3, cachedInput: 4, cacheWrite: 5, output: 6, reasoning: 2, total: 18, usd: 0 }],
    { from: now - 1, to: now + 1, granularity: 'day' }
  )
  assert.deepEqual(result.tokens, {
    input: 3,
    cachedInput: 4,
    cacheWrite: 5,
    output: 6,
    reasoning: 2,
    total: 18
  })
})

test('request events roll up into comparable sessions without losing detail', () => {
  const start = Date.parse('2026-08-15T12:00:00Z')
  const sessions = buildSessions([
    {
      key: 'request-1', source: 'C:/sessions/alpha/session-a.jsonl', ts: start,
      model: 'claude-sonnet-5', input: 10, cachedInput: 20, cacheWrite: 5,
      output: 7, reasoning: 0, total: 42, usd: 0.01, durationMs: 2_000
    },
    {
      key: 'request-2', source: 'C:/sessions/alpha/session-a.jsonl', ts: start + 4_000,
      model: 'claude-opus-4-8', input: 11, cachedInput: 0, cacheWrite: 0,
      output: 9, reasoning: 0, total: 20, usd: 0.03, durationMs: 1_000
    }
  ], { from: start - 1, to: start + 10_000 }, {
    provider: 'claude', product: 'Claude Code', sourceType: 'local'
  })

  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].requestCount, 2)
  assert.equal(sessions[0].tokens.total, 62)
  assert.equal(sessions[0].tokens.cachedInput, 20)
  assert.equal(sessions[0].durationMs, 5_000)
  assert.deepEqual(sessions[0].models, ['claude-sonnet-5', 'claude-opus-4-8'])
  assert.equal(sessions[0].requests[1].id, 'request-2')
})

test('desktop and Hub snapshots merge matching sessions without double counting requests', () => {
  const start = Date.parse('2026-08-15T12:00:00Z')
  const base = {
    id: 'codex', name: 'Codex', color: '#10a37f', available: true, error: null,
    windows: [], tokens: { input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0, total: 15 },
    cost: { today: 0.01, total: 0.01, currency: 'USD', estimated: true },
    series: { tokensByDay: [], costByDay: [] },
    coverage: { sourceType: 'local', freshness: 'seconds', detail: 'request', lastSyncedAt: start },
    meta: { sessions: 1, model: 'gpt-5-codex', lastActivity: start }
  }
  const request = {
    id: 'request-1', timestamp: start, durationMs: 100, model: 'gpt-5-codex',
    input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0, total: 15,
    costUsd: 0.01, costKind: 'estimated', status: 'ok'
  }
  const session = {
    id: 'session-1', provider: 'codex', product: 'Codex', sourceType: 'local',
    title: 'One session', startedAt: start, endedAt: start + 100, durationMs: 100,
    requestCount: 1, models: ['gpt-5-codex'], primaryModel: 'gpt-5-codex',
    tokens: base.tokens, costUsd: 0.01, costKind: 'estimated', requests: [request]
  }
  const remoteRequest = { ...request, id: 'request-2', timestamp: start + 1_000, output: 10, total: 20, costUsd: 0.02 }
  const merged = mergeSnapshots(
    [{ ...base, sessions: [session] }],
    [{ ...base, sessions: [{ ...session, sourceType: 'otel', requests: [request, remoteRequest] }] }],
    { from: start - 1, to: start + 5_000, granularity: 'hour' }
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].sessions.length, 1)
  assert.equal(merged[0].sessions[0].requestCount, 2)
  assert.equal(merged[0].tokens.total, 35)
  assert.equal(merged[0].cost.total, 0.03)
})


// --- Connect Claude ------------------------------------------------------ //

test('CLI candidate paths match the platform they are asked about', () => {
  const win = cliCandidates('win32', 'C:\\Users\\frank', { APPDATA: 'C:\\Users\\frank\\AppData\\Roaming' })
  // Windows must look for the .exe/.cmd forms and the npm global shim; a bare
  // "claude" would never be found there.
  assert.ok(win.some((p) => p.endsWith('claude.exe')))
  assert.ok(win.some((p) => p.endsWith('claude.cmd')))
  assert.ok(win.some((p) => p.includes('AppData') && p.includes('npm')))
  assert.ok(!win.some((p) => p.endsWith('/claude')))

  const mac = cliCandidates('darwin', '/Users/frank', {})
  assert.ok(mac.includes('/Users/frank/.local/bin/claude'))
  assert.ok(mac.includes('/opt/homebrew/bin/claude'))

  // Homebrew's path is macOS-only; don't offer it on Linux.
  const linux = cliCandidates('linux', '/home/frank', {})
  assert.ok(linux.includes('/home/frank/.local/bin/claude'))
  assert.ok(!linux.includes('/opt/homebrew/bin/claude'))

  // No duplicates, or the panel would report the same path twice.
  assert.equal(new Set(linux).size, linux.length)
})

test('login command opens a real terminal per platform', () => {
  const win = loginCommand('C:\\Users\\frank\\.local\\bin\\claude.exe', 'win32')
  assert.equal(win.file, 'cmd.exe')
  // The empty argument is the window title: without it `start` consumes the
  // command path as the title and opens an empty shell.
  assert.deepEqual(win.args.slice(0, 3), ['/c', 'start', ''])
  assert.ok(win.args.includes('C:\\Users\\frank\\.local\\bin\\claude.exe'))

  const mac = loginCommand('/Users/frank/.local/bin/claude', 'darwin')
  assert.equal(mac.file, 'osascript')
  assert.ok(mac.args[1].includes('do script'))
  assert.ok(mac.args[1].includes("'/Users/frank/.local/bin/claude'"))

  // Linux needs a terminal emulator; without one the caller must be told
  // rather than silently spawning nothing.
  assert.equal(loginCommand('/home/frank/.local/bin/claude', 'linux', null), null)
  const linux = loginCommand('/home/frank/.local/bin/claude', 'linux', { file: 'konsole', flag: '-e' })
  assert.deepEqual(linux, { file: 'konsole', args: ['-e', '/home/frank/.local/bin/claude'] })

  assert.equal(loginCommand(null, 'darwin'), null)
})

test('login command escapes quotes so a path cannot break out of the AppleScript', () => {
  const cmd = loginCommand('/Users/frank/we"ird/claude', 'darwin')
  // A raw " would terminate the `do script` string early and run whatever
  // followed it as AppleScript.
  assert.ok(cmd.args[1].includes('we\\"ird'))
  assert.ok(!/[^\\]"we/.test(cmd.args[1]))
})

test('linuxTerminal reports nothing when no emulator is on PATH', () => {
  assert.equal(linuxTerminal(['/nonexistent-bin', '']), null)
})

test('a manually pasted token is tracked as its own credential source', () => {
  assert.equal(setManualToken('  sk-test-token  '), true)
  assert.equal(authStatus().hasManualToken, true)
  // Clearing must actually clear, or a revoked token lingers forever.
  assert.equal(setManualToken(''), false)
  assert.equal(authStatus().hasManualToken, false)
  assert.equal(setManualToken(null), false)
})

test('authStatus always explains itself', () => {
  const s = authStatus()
  assert.equal(typeof s.hint, 'string')
  assert.ok(s.hint.length > 0)
  assert.ok(Array.isArray(s.checked))
  assert.ok(Array.isArray(s.problems))
  assert.equal(s.platform, process.platform)
})

test('probeUsage reports why a token failed instead of guessing', async () => {
  const realFetch = globalThis.fetch
  const reply = (status, body) => () =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body)
    })
  try {
    assert.deepEqual(await probeUsage('  '), { ok: false, reason: 'empty' })

    globalThis.fetch = reply(401, {})
    assert.deepEqual(await probeUsage('t'), { ok: false, reason: 'rejected', status: 401 })

    globalThis.fetch = reply(429, {})
    assert.deepEqual(await probeUsage('t'), { ok: false, reason: 'rate-limited', status: 429 })

    globalThis.fetch = reply(500, {})
    assert.deepEqual(await probeUsage('t'), { ok: false, reason: 'http-500', status: 500 })

    // Authenticated but unrecognizable: distinct from a rejection, because the
    // fix is different (the API shape moved, the token is fine).
    globalThis.fetch = reply(200, { limits: [] })
    assert.deepEqual(await probeUsage('t'), { ok: false, reason: 'no-windows' })

    globalThis.fetch = () => Promise.reject(new Error('offline'))
    assert.deepEqual(await probeUsage('t'), { ok: false, reason: 'network' })

    globalThis.fetch = reply(200, {
      limits: [
        { kind: 'session', utilization: 42, resets_at: '2026-08-26T20:00:00Z' },
        { group: 'weekly', utilization: 7, scope: { model: { display_name: 'Opus' } } }
      ]
    })
    const ok = await probeUsage('t')
    assert.equal(ok.ok, true)
    assert.equal(ok.windowCount, 2)
    assert.deepEqual(ok.labels, ['5-Hour Limit', 'Weekly · Opus'])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('CLI candidates use the target platform separators, not the host OS', () => {
  // path.join follows whatever OS the test runs on, so cliCandidates must not
  // use it: on a Windows runner a darwin lookup came back with backslashes and
  // failed the assertions above, which is what broke run #17.
  for (const p of cliCandidates('darwin', '/Users/frank', {})) {
    assert.ok(!p.includes('\\'), `darwin candidate carries a backslash: ${p}`)
  }
  for (const p of cliCandidates('linux', '/home/frank', {})) {
    assert.ok(!p.includes('\\'), `linux candidate carries a backslash: ${p}`)
  }
  for (const p of cliCandidates('win32', 'C:\\Users\\frank', { APPDATA: 'C:\\AppData' })) {
    assert.ok(!p.includes('/'), `win32 candidate carries a forward slash: ${p}`)
  }
})

test('Windows lookup covers npm global shims, which a stale PATH misses', () => {
  const win = cliCandidates('win32', 'C:\\Users\\FrankDiaz', {
    APPDATA: 'C:\\Users\\FrankDiaz\\AppData\\Roaming',
    ProgramFiles: 'C:\\Program Files'
  })
  const npmDir = 'C:\\Users\\FrankDiaz\\AppData\\Roaming\\npm\\'
  // `npm install -g` writes claude, claude.cmd and claude.ps1 here. A shell or
  // app started before that install never sees the directory on PATH, so
  // `where claude` fails and only a direct check finds it.
  assert.ok(win.includes(npmDir + 'claude.cmd'))
  assert.ok(win.includes(npmDir + 'claude.ps1'))
  assert.ok(win.includes(npmDir + 'claude'))
  // .cmd must be preferred over .ps1: `cmd /k` cannot run a PowerShell script.
  assert.ok(win.indexOf(npmDir + 'claude.cmd') < win.indexOf(npmDir + 'claude.ps1'))
  assert.ok(win.includes('C:\\Program Files\\nodejs\\claude.cmd'))
})

// --- range presets and interval reliability ------------------------------ //

test('every range preset resolves to the span it advertises', () => {
  const now = Date.parse('2026-08-26T19:00:00Z')
  const day = 86_400_000
  for (const [preset, days] of Object.entries(RANGE_PRESETS)) {
    const r = resolvePreset({ preset }, now)
    assert.equal(r.to, now, `${preset} must end at now`)
    assert.equal(r.from, now - days * day, `${preset} must span ${days} days`)
  }
  // An unknown preset must not produce NaN bounds — that would filter out
  // every event and render as "no data" rather than as a bug.
  const bogus = resolvePreset({ preset: '12h' }, now)
  assert.equal(bogus.from, now - 30 * day)
  assert.ok(Number.isFinite(bogus.from) && Number.isFinite(bogus.to))

  const custom = resolvePreset({ preset: 'custom', from: 100, to: 200 }, now)
  assert.deepEqual(custom, { from: 100, to: 200, granularity: 'auto' })
  // Custom with holes falls back rather than emitting null bounds.
  assert.equal(resolvePreset({ preset: 'custom' }, now).to, now)
})

test('auto granularity switches to hourly only for short ranges', () => {
  const now = Date.parse('2026-08-26T19:00:00Z')
  assert.equal(normalizeRange(resolvePreset({ preset: '24h' }, now)).granularity, 'hour')
  assert.equal(normalizeRange(resolvePreset({ preset: '7d' }, now)).granularity, 'day')
  assert.equal(normalizeRange(resolvePreset({ preset: '30d' }, now)).granularity, 'day')
  assert.equal(normalizeRange(resolvePreset({ preset: '90d' }, now)).granularity, 'day')
})

test('each preset aggregates exactly the events inside it', () => {
  const now = Date.parse('2026-08-26T19:00:00Z')
  const hour = 3_600_000
  const day = 86_400_000
  // One event per age band, each with a distinct token count so the totals
  // identify precisely which ones were counted.
  const ages = [
    { label: '30m', ts: now - hour / 2, total: 1 },
    { label: '20h', ts: now - 20 * hour, total: 2 },
    { label: '3d', ts: now - 3 * day, total: 4 },
    { label: '20d', ts: now - 20 * day, total: 8 },
    { label: '60d', ts: now - 60 * day, total: 16 },
    { label: '200d', ts: now - 200 * day, total: 32 }
  ]
  const events = ages.map((a, i) => ({
    ts: a.ts,
    sessionId: `s${i}`,
    model: 'claude-opus-5',
    input: a.total,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: a.total,
    usd: a.total / 1000
  }))

  // Sums are powers of two, so the expected value is a bitmask of which bands
  // belong to each preset — an off-by-one in the bounds changes the number.
  const expected = { '24h': 1 + 2, '7d': 1 + 2 + 4, '30d': 1 + 2 + 4 + 8, '90d': 1 + 2 + 4 + 8 + 16 }
  for (const [preset, total] of Object.entries(expected)) {
    const range = resolvePreset({ preset }, now)
    const s = summarize(events, range)
    assert.equal(s.tokens.total, total, `${preset} token total`)
    // buildSessions must agree with summarize about what is in range, or the
    // session list and the KPI tiles contradict each other.
    const sessions = buildSessions(events, normalizeRange(range), { provider: 'claude' })
    assert.equal(
      sessions.reduce((m, x) => m + x.tokens.total, 0),
      total,
      `${preset} session total`
    )
  }
})

test('range bounds are inclusive at both ends, and identically so in both aggregators', () => {
  const from = Date.parse('2026-08-01T00:00:00Z')
  const to = Date.parse('2026-08-31T00:00:00Z')
  const mk = (ts, total) => ({
    ts, sessionId: `s${ts}`, model: 'claude-opus-5',
    input: total, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total, usd: 0
  })
  const events = [mk(from - 1, 100), mk(from, 1), mk(to, 2), mk(to + 1, 200)]
  const range = { from, to, granularity: 'day' }

  // Exactly the two boundary events count; neither neighbour leaks in.
  assert.equal(summarize(events, range).tokens.total, 3)
  const sessions = buildSessions(events, range, { provider: 'claude' })
  assert.equal(sessions.reduce((m, s) => m + s.tokens.total, 0), 3)
  assert.equal(sessions.length, 2)
})

test('history file window is wide enough for every preset', () => {
  const now = Date.parse('2026-08-26T19:00:00Z')
  const day = 86_400_000
  // A transcript's mtime is always >= its newest event, so selecting files by
  // mtime is sound — but only if the window the provider computes covers the
  // whole range. This is that arithmetic, mirrored from the provider.
  const windowDays = (range) => Math.max(2, Math.ceil((now - range.from) / day) + 1)
  for (const [preset, days] of Object.entries(RANGE_PRESETS)) {
    const range = resolvePreset({ preset }, now)
    const w = windowDays(range)
    assert.ok(w >= days, `${preset}: window ${w}d must cover ${days}d`)
    // A file whose newest event sits at the far edge of the range must survive.
    const edgeFile = { path: 'edge.jsonl', mtimeMs: range.from }
    assert.deepEqual(selectClaudeHistoryFiles([edgeFile], w, now), [edgeFile], `${preset} edge file`)
  }
})

test('the empty-range explanation never claims more than was actually scanned', () => {
  const now = Date.parse('2026-08-26T19:00:00Z')
  const day = 86_400_000

  // No transcripts at all.
  assert.match(emptyRangeMessage({ totalFiles: 0, now }), /No local Claude sessions found/)

  // Data in range needs no explanation.
  assert.equal(emptyRangeMessage({ totalFiles: 5, sessionsInRange: 2, now }), null)

  // Everything scanned, nothing recorded a model call: the /login case. Safe to
  // say so, and widening the range would not help — so it must not suggest it.
  const loginOnly = emptyRangeMessage({ totalFiles: 1, scannedFiles: 1, usageRows: 0, now })
  assert.match(loginOnly, /none records a model call yet/)
  assert.doesNotMatch(loginOnly, /7D or 30D/)

  // Only some files scanned: the claim must be scoped to those, and it must
  // point at the wider range that would actually surface the older calls.
  const partial = emptyRangeMessage({ totalFiles: 70, scannedFiles: 1, usageRows: 0, now })
  assert.match(partial, /in the 1 transcript active in this range/)
  assert.match(partial, /69 older transcripts not scanned/)
  // Cannot name an age here (the files holding usage were never read), so it
  // must not name a specific preset either — just say to widen.
  assert.match(partial, /widen the range/)
  // Regression: `files.length` once counted the characters of a label string,
  // yielding "19 transcripts" and "-17 older" from two files.
  assert.doesNotMatch(partial, /-\d/)

  // Calls exist but all predate the range: report the newest one's real age.
  const stale = emptyRangeMessage({
    totalFiles: 70, scannedFiles: 70, usageRows: 40,
    newestEventAt: now - 3 * day, from: now - day, now
  })
  assert.match(stale, /Newest recorded call: 3d ago/)
  // A 3-day-old call is reachable by every wider preset.
  assert.match(stale, /try 7D, 30D or 90D/)

  // Hours, not days, for a recent one — and no "try wider" when it is already
  // inside the range.
  const recent = emptyRangeMessage({
    totalFiles: 2, scannedFiles: 2, usageRows: 3,
    newestEventAt: now - 5 * 3_600_000, from: now - day, now
  })
  assert.match(recent, /Newest recorded call: 5h ago/)
  assert.doesNotMatch(recent, /try 7D or 30D/)

  // Undated rows are disclosed rather than silently mis-bucketed.
  assert.match(
    emptyRangeMessage({ totalFiles: 1, scannedFiles: 1, usageRows: 0, undatedRows: 4, now }),
    /4 usage rows had no readable timestamp/
  )
})

test('range suggestions name only ranges that would actually contain the call', () => {
  const now = Date.parse('2026-08-26T19:40:00Z')
  const day = 86_400_000
  const from = now - day // a 24H range

  // Inside the range already: nothing to suggest.
  assert.equal(suggestRanges(now - day / 2, from, now), '')
  assert.equal(suggestRanges(null, from, now), '')

  // 3 days: every wider preset reaches it.
  assert.equal(suggestRanges(now - 3 * day, from, now), ' — try 7D, 30D or 90D')

  // 12 days: 7D must NOT be offered — it would be empty too. This is the bug
  // the dashboard showed: "Newest recorded call: 12d ago — try 7D or 30D".
  const twelve = suggestRanges(now - 12 * day, from, now)
  assert.equal(twelve, ' — try 30D or 90D')
  assert.doesNotMatch(twelve, /7D/)

  assert.equal(suggestRanges(now - 45 * day, from, now), ' — try 90D')

  // Beyond every preset, only a custom range reaches it.
  assert.match(suggestRanges(now - 200 * day, from, now), /older than 90D, so use Custom/)
})

test('live-limit backoff escalates and honors Retry-After', () => {
  const min = 60_000
  // Retrying a 429 on the normal 90s interval is what keeps an account
  // rate-limited, so consecutive failures must back off hard.
  assert.equal(backoffDelay(1), 2 * min)
  assert.equal(backoffDelay(2), 5 * min)
  assert.equal(backoffDelay(3), 15 * min)
  assert.equal(backoffDelay(4), 30 * min)
  assert.equal(backoffDelay(9), 30 * min, 'caps rather than growing forever')
  // A streak of 0 or nonsense must still produce a real delay, never 0.
  assert.equal(backoffDelay(0), 2 * min)

  // Trust a server-provided Retry-After (seconds), but never sleep longer than
  // the largest step — a hostile or buggy header shouldn't wedge live limits.
  assert.equal(backoffDelay(1, '30'), 30_000)
  assert.equal(backoffDelay(1, 120), 2 * min)
  assert.equal(backoffDelay(1, 99_999), 30 * min)
  // Garbage headers fall through to the streak schedule.
  assert.equal(backoffDelay(2, 'soon'), 5 * min)
  assert.equal(backoffDelay(2, '-5'), 5 * min)
  assert.equal(backoffDelay(2, null), 5 * min)
})

test('persisted live windows are restored only while still plausible', () => {
  const now = Date.parse('2026-08-26T20:00:00Z')
  const saved = {
    windows: [{ id: 'five_hour', label: '5-Hour Limit', usedPercent: 13 }],
    extra: null,
    at: now - 5 * 60_000
  }
  // Five minutes old: worth showing (labelled stale) instead of N/A.
  assert.equal(restoreLiveCache(saved, now), true)

  // An hour old: the percentages have likely moved, so N/A is more honest.
  assert.equal(restoreLiveCache({ ...saved, at: now - 60 * 60_000 }, now), false)

  // Malformed or empty payloads must never be adopted.
  assert.equal(restoreLiveCache(null, now), false)
  assert.equal(restoreLiveCache({ windows: [], at: now }, now), false)
  assert.equal(restoreLiveCache({ windows: saved.windows }, now), false)
})

// --- account-wide limit history ------------------------------------------ //

test('samples skip estimated windows so the series has no false zeros', () => {
  const now = Date.parse('2026-08-26T20:00:00Z')
  const s = toSample(
    [
      { id: 'five_hour', usedPercent: 13, usedTokens: 1_200_000, budgetTokens: 12_000_000, resetsAt: now + 3 * 3_600_000 },
      // Estimated windows carry no real percentage; recording them would look
      // like account usage collapsing to zero.
      { id: 'seven_day', usedPercent: null, estimated: true, usedTokens: 187_000_000 }
    ],
    now
  )
  assert.deepEqual(Object.keys(s.w), ['five_hour'])
  assert.equal(s.w.five_hour.pct, 13)
  assert.equal(s.w.five_hour.used, 1_200_000)
  assert.equal(s.at, now)

  // Nothing live at all produces no sample rather than an empty one.
  assert.equal(toSample([{ id: 'x', estimated: true, usedPercent: null }], now), null)
  assert.equal(toSample([], now), null)
  assert.equal(toSample(null, now), null)
})

test('history keeps recent samples in full and thins the tail', () => {
  const now = Date.parse('2026-08-26T20:00:00Z')
  const mk = (at, pct) => ({ at, w: { five_hour: { pct } } })
  const history = []
  // Two days of samples every 5 minutes.
  for (let t = now - 2 * 86_400_000; t <= now; t += 5 * 60_000) history.push(mk(t, 1))

  const pruned = pruneHistory(history, now)
  const recent = pruned.filter((s) => s.at >= now - FULL_RESOLUTION_MS)
  const older = pruned.filter((s) => s.at < now - FULL_RESOLUTION_MS)

  // Recent window untouched: every 5-minute sample survives.
  assert.equal(recent.length, history.filter((s) => s.at >= now - FULL_RESOLUTION_MS).length)
  // Tail thinned to at most one per coarse bucket.
  const buckets = new Set(older.map((s) => Math.floor(s.at / COARSE_BUCKET_MS)))
  assert.equal(older.length, buckets.size)
  assert.ok(older.length < history.length / 2, 'tail must actually shrink')
  // Chronological order preserved, which the charts depend on.
  for (let i = 1; i < pruned.length; i++) assert.ok(pruned[i].at > pruned[i - 1].at)

  // Anything past the retention horizon is dropped outright.
  const ancient = pruneHistory([mk(now - 40 * 86_400_000, 5), mk(now, 5)], now)
  assert.equal(ancient.length, 1)
})

test('addSample never mutates its input and ignores clock regressions', () => {
  const now = Date.parse('2026-08-26T20:00:00Z')
  const first = addSample([], [{ id: 'five_hour', usedPercent: 10 }], now)
  assert.equal(first.length, 1)

  const second = addSample(first, [{ id: 'five_hour', usedPercent: 12 }], now + 90_000)
  assert.equal(second.length, 2)
  assert.equal(first.length, 1, 'input array must not be mutated')

  // A duplicate poll or a clock that jumped backwards must not corrupt order.
  const same = addSample(second, [{ id: 'five_hour', usedPercent: 99 }], now + 90_000)
  assert.equal(same.length, 2)
  const backwards = addSample(second, [{ id: 'five_hour', usedPercent: 99 }], now - 5_000)
  assert.equal(backwards.length, 2)
})

test('burn rate measures only within the current window, not across a reset', () => {
  const now = Date.parse('2026-08-26T20:00:00Z')
  const hour = 3_600_000
  // Climbs to 80%, the window resets, then climbs again from 5%.
  const history = [
    { at: now - 6 * hour, w: { five_hour: { pct: 40, resetsAt: now - 4 * hour } } },
    { at: now - 5 * hour, w: { five_hour: { pct: 80, resetsAt: now - 4 * hour } } },
    { at: now - 3 * hour, w: { five_hour: { pct: 5, resetsAt: now + hour } } },
    { at: now - 1 * hour, w: { five_hour: { pct: 25, resetsAt: now + hour } } }
  ]

  const segment = currentSegment(history, 'five_hour', now)
  assert.equal(segment.length, 2, 'segment starts after the reset')
  assert.equal(segment[0].pct, 5)

  const rate = burnRate(history, 'five_hour', now, 4 * hour)
  // 5% -> 25% across 2 hours = 10 points/hour. Measuring across the reset
  // would have produced a negative rate and a nonsense projection.
  assert.ok(rate)
  assert.equal(Math.round(rate.perHour), 10)
  assert.ok(rate.perHour > 0)

  // Too little spread to be honest about.
  const twoClose = [
    { at: now - 60_000, w: { five_hour: { pct: 10 } } },
    { at: now, w: { five_hour: { pct: 11 } } }
  ]
  assert.equal(burnRate(twoClose, 'five_hour', now), null)
  assert.equal(burnRate([], 'five_hour', now), null)
})

test('projection says whether the cap arrives before the window resets', () => {
  const now = Date.parse('2026-08-26T20:00:00Z')
  const hour = 3_600_000

  // 25% used, climbing 10 points/hour -> 100% in 7.5h.
  const rate = { perHour: 10 }
  const soon = projectExhaustion({ usedPercent: 25, resetsAt: now + 20 * hour }, rate, now)
  assert.equal(Math.round(soon.hoursLeft * 10) / 10, 7.5)
  assert.equal(soon.beforeReset, true)

  // Same rate, but the window resets in 2h — the cap is not the real risk.
  const safe = projectExhaustion({ usedPercent: 25, resetsAt: now + 2 * hour }, rate, now)
  assert.equal(safe.beforeReset, false)

  // Flat or falling usage must not produce an invented exhaustion time.
  assert.equal(projectExhaustion({ usedPercent: 25 }, { perHour: 0 }, now), null)
  assert.equal(projectExhaustion({ usedPercent: 25 }, { perHour: -3 }, now), null)
  assert.equal(projectExhaustion({ usedPercent: 25 }, null, now), null)
  assert.equal(projectExhaustion({ usedPercent: null }, rate, now), null)

  // Already at the cap.
  assert.equal(projectExhaustion({ usedPercent: 100, resetsAt: now + hour }, rate, now).hoursLeft, 0)
})

test('summarizeHistory produces series, rate and projection per window', () => {
  const now = Date.parse('2026-08-26T20:00:00Z')
  const hour = 3_600_000
  const history = [
    { at: now - 3 * hour, w: { five_hour: { pct: 5 }, seven_day: { pct: 40 } } },
    { at: now - 1 * hour, w: { five_hour: { pct: 25 }, seven_day: { pct: 44 } } }
  ]
  const windows = [
    { id: 'five_hour', usedPercent: 25, resetsAt: now + 4 * hour },
    { id: 'seven_day', usedPercent: 44, resetsAt: now + 3 * 86_400_000 }
  ]
  const out = summarizeHistory(history, windows, now)

  assert.equal(out.five_hour.series.length, 2)
  assert.equal(Math.round(out.five_hour.rate.perHour), 10)
  assert.equal(out.five_hour.projection.beforeReset, false, '100% is 7.5h out, reset is 4h out')
  assert.equal(Math.round(out.seven_day.rate.perHour), 2)
  assert.ok(out.seven_day.projection.hoursLeft > 24)
  assert.deepEqual(knownWindows(history), ['five_hour', 'seven_day'])
})

test('a reset time drifting forward by seconds is not a window rollover', () => {
  const now = Date.parse('2026-08-26T21:40:00Z')
  const resets = Date.parse('2026-08-26T23:28:00Z')
  // 35 samples, steady percentage, resets_at nudged forward a second each poll
  // by server rounding. Treating any forward movement as a rollover restarted
  // the segment on every sample, so 35 samples reported "not enough data yet".
  const drifting = []
  for (let i = 34; i >= 0; i--) {
    drifting.push({ at: now - i * 90_000, w: { five_hour: { pct: 27, resetsAt: resets + (34 - i) * 1000 } } })
  }
  assert.equal(currentSegment(drifting, 'five_hour', now).length, 35)
  const flat = burnRate(drifting, 'five_hour', now)
  assert.ok(flat, 'a steady window still reports a rate — of zero')
  assert.equal(flat.perHour, 0)
  assert.equal(flat.samples, 35)

  // The same drift must not suppress a genuine climb.
  const climbing = []
  for (let i = 34; i >= 0; i--) {
    climbing.push({
      at: now - i * 90_000,
      w: { five_hour: { pct: 13 + (34 - i) * 0.4, resetsAt: resets + (34 - i) * 1000 } }
    })
  }
  assert.equal(Math.round(burnRate(climbing, 'five_hour', now).perHour), 16)

  // A real rollover — reset time jumping a whole window — still cuts.
  const rolled = []
  for (let i = 20; i >= 0; i--) {
    rolled.push({ at: now - (i + 20) * 90_000, w: { five_hour: { pct: 60 + (20 - i), resetsAt: now } } })
  }
  for (let i = 19; i >= 0; i--) {
    rolled.push({ at: now - i * 90_000, w: { five_hour: { pct: 3 + (19 - i) * 0.5, resetsAt: now + 5 * 3_600_000 } } })
  }
  const seg = currentSegment(rolled, 'five_hour', now)
  assert.equal(seg.length, 20)
  assert.equal(seg[0].pct, 3, 'segment starts after the rollover, not before')
})

test('sampling is floored so a fast poll loop cannot flood the history', () => {
  const now = Date.parse('2026-08-26T22:00:00Z')
  const windows = [{ id: 'five_hour', usedPercent: 27, estimated: false }]
  // The dashboard polls every ~5s while the usage API is called every 90s. Once
  // this recorded a sample per poll: 720 an hour instead of 40, with the whole
  // history rewritten to disk each time.
  let history = []
  for (let s = 0; s < 3600; s += 5) history = addSample(history, windows, now + s * 1000)
  const gaps = history.slice(1).map((h, i) => h.at - history[i].at)
  assert.ok(history.length < 130, `expected the floor to cap growth, got ${history.length}`)
  assert.ok(Math.min(...gaps) >= MIN_SAMPLE_GAP_MS, 'no two samples closer than the floor')

  // Stamped with the API's own timestamp — the real path — it is exactly one
  // sample per API response.
  let stamped = []
  for (let s = 0; s < 3600; s += 5) {
    stamped = addSample(stamped, windows, now + Math.floor(s / 90) * 90_000)
  }
  assert.equal(stamped.length, 40)
})

test('a history bloated by the old sampler is thinned on load', () => {
  const now = Date.parse('2026-08-26T23:00:00Z')
  const bloat = []
  for (let t = now - 6 * 3_600_000; t <= now; t += 5000) bloat.push({ at: t, w: { five_hour: { pct: 27 } } })
  assert.ok(bloat.length > 4000)

  const cleaned = pruneHistory(bloat, now)
  assert.ok(cleaned.length < bloat.length / 5, 'dense legacy runs must actually shrink')
  const gaps = cleaned.slice(1).map((s, i) => s.at - cleaned[i].at)
  assert.ok(Math.min(...gaps) >= MIN_SAMPLE_GAP_MS)
  // Newest sample survives: the current reading must never be pruned away.
  assert.equal(cleaned[cleaned.length - 1].at, now)
})

test('the charting series is capped and still ends at the newest point', () => {
  const now = Date.parse('2026-08-26T23:00:00Z')
  const history = []
  for (let i = 2000; i >= 0; i--) history.push({ at: now - i * 30_000, w: { five_hour: { pct: 20 + i * 0.01 } } })

  const series = seriesFor(history, 'five_hour', 24 * 3_600_000, now)
  assert.ok(series.length <= MAX_SERIES_POINTS, `got ${series.length}`)
  assert.ok(series.length > 10, 'thinning must not collapse the series')
  // The line has to end at "now", or the chart lies about the current value.
  assert.equal(series[series.length - 1].t, now)
  for (let i = 1; i < series.length; i++) assert.ok(series[i].t > series[i - 1].t, 'still chronological')

  // Under the cap nothing is touched.
  const small = seriesFor(history.slice(-50), 'five_hour', 24 * 3_600_000, now)
  assert.equal(small.length, 50)
})

// --- without-cache counterfactual ---------------------------------------- //

test('dropping the cache re-prices prompt tokens without changing the count', () => {
  const usage = { input: 1_000, output: 500, cacheWrite: 4_000, cacheRead: 95_000 }
  const model = 'claude-sonnet-5' // input 3, output 15, cacheWrite 3.75, cacheRead 0.3

  const withCache = estimateCost(usage, model)
  const without = estimateCostNoCache(usage, model)

  // With cache: 1k*3 + 500*15 + 4k*3.75 + 95k*0.3 = 3000+7500+15000+28500 per 1M
  assert.equal(Number(withCache.toFixed(6)), 0.054)
  // Without: every prompt token (100k) at the plain input rate, output unchanged.
  assert.equal(Number(without.toFixed(6)), 0.3075)
  assert.ok(without > withCache, 'no cache is the expensive world, always')

  // The point the UI has to state plainly: the same tokens were sent either
  // way, so the total must not move.
  const tokens = { input: 1_000, cachedInput: 95_000, cacheWrite: 4_000, output: 500, reasoning: 0, total: 100_500 }
  const nc = tokensWithoutCache(tokens)
  assert.equal(nc.total, tokens.total)
  assert.equal(nc.input, 100_000, 'every prompt token becomes uncached input')
  assert.equal(nc.cachedInput, 0)
  assert.equal(nc.cacheWrite, 0)
  assert.equal(nc.output, tokens.output)
})

test('summarize reports the no-cache counterfactual against its own baseline', () => {
  const now = Date.now()
  const range = { from: now - 3_600_000, to: now + 1_000, granularity: 'hour' }
  const events = [
    {
      ts: now - 60_000,
      model: 'claude-sonnet-5',
      input: 1_000,
      cachedInput: 95_000,
      cacheWrite: 4_000,
      output: 500,
      total: 100_500,
      // Deliberately NOT the estimate: a provider-billed figure. The saving
      // must be measured against summarize's own baseline, not against this,
      // or the two numbers would come from different price bases.
      usd: 999
    }
  ]

  const sum = summarize(events, range)
  assert.equal(sum.cost.total, 999, 'the real cost is passed through untouched')
  assert.equal(Number(sum.noCache.cost.total.toFixed(6)), 0.3075)
  assert.equal(Number(sum.noCache.baseline.total.toFixed(6)), 0.054)
  assert.equal(Number(sum.noCache.savings.toFixed(6)), 0.2535)
  assert.ok(sum.noCache.multiple > 5.6 && sum.noCache.multiple < 5.7, sum.noCache.multiple)
  assert.equal(sum.noCache.tokens.total, sum.tokens.total, 'token volume is identical')
  assert.equal(sum.noCache.series.costByDay.length, 1)
  assert.equal(
    sum.noCache.series.costByDay[0].date,
    sum.series.costByDay[0].date,
    'both cost series bucket identically'
  )
})

test('a range with no cached tokens reports no saving rather than a fake one', () => {
  const now = Date.now()
  const range = { from: now - 3_600_000, to: now + 1_000, granularity: 'hour' }
  const events = [
    { ts: now - 1_000, model: 'gpt-5', input: 2_000, cachedInput: 0, cacheWrite: 0, output: 100, total: 2_100, usd: 0.0035 }
  ]
  const sum = summarize(events, range)
  assert.equal(sum.noCache.savings, 0)
  assert.equal(sum.noCache.multiple, 1)
  assert.equal(sum.noCache.tokens.input, 2_000)
})

test('events with no model fall back to the caller-declared default price', () => {
  const now = Date.now()
  const range = { from: now - 3_600_000, to: now + 1_000, granularity: 'hour' }
  const events = [{ ts: now - 1_000, input: 0, cachedInput: 10_000, cacheWrite: 0, output: 0, total: 10_000, usd: 0 }]

  const guessed = summarize(events, range, { defaultModel: 'claude-opus-4-1' })
  // 10k cache-read tokens re-billed at the opus-4-1 input rate of $15/1M.
  assert.equal(Number(guessed.noCache.cost.total.toFixed(6)), 0.15)

  // Without a default it still produces a figure from the fallback table
  // rather than dropping the comparison entirely.
  const generic = summarize(events, range)
  assert.equal(Number(generic.noCache.cost.total.toFixed(6)), 0.03)
})

test('an empty range leaves the multiple null instead of dividing by zero', () => {
  const now = Date.now()
  const sum = summarize([], { from: now - 3_600_000, to: now, granularity: 'hour' })
  assert.equal(sum.noCache.cost.total, 0)
  assert.equal(sum.noCache.multiple, null)
  assert.equal(sum.noCache.savings, 0)
  assert.deepEqual(sum.noCache.series.costByDay, [])
})
