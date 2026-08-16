import test from 'node:test'
import assert from 'node:assert/strict'

import { claudeUsageEvent, dedupeClaudeUsageEvents, selectClaudeHistoryFiles } from '../src/main/providers/claude.js'
import { codexCumulativeUsage, codexUsageDelta } from '../src/main/providers/codex.js'
import { summarize } from '../src/main/providers/util.js'
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

