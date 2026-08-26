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
  probeUsage
} from '../src/main/providers/claude.js'
import { cliCandidates, loginCommand, linuxTerminal } from '../src/main/claudeAuth.js'
import { codexCumulativeUsage, codexUsageDelta } from '../src/main/providers/codex.js'
import { estimateTextTokens, chatgptConversationEvents } from '../src/main/providers/chatgpt.js'
import { summarize, priceFor, PRICING } from '../src/main/providers/util.js'
import { buildSessions } from '../src/main/providers/sessions.js'
import { mergeSnapshots } from '../src/main/providers/hub.js'

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
