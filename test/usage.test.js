import test from 'node:test'
import assert from 'node:assert/strict'

import { claudeUsageEvent, dedupeClaudeUsageEvents, selectClaudeHistoryFiles } from '../src/main/providers/claude.js'
import { codexCumulativeUsage, codexUsageDelta } from '../src/main/providers/codex.js'
import { summarize } from '../src/main/providers/util.js'

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

