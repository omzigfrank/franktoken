import test from 'node:test'
import assert from 'node:assert/strict'

import {
  claudeUsageEvent,
  dedupeClaudeUsageEvents,
  selectClaudeHistoryFiles,
  limitsWindows,
  surfaceLabel
} from '../src/main/providers/claude.js'
import { codexCumulativeUsage, codexUsageDelta } from '../src/main/providers/codex.js'
import { estimateTextTokens, chatgptConversationEvents } from '../src/main/providers/chatgpt.js'
import { summarize, buildSessionSummary, cumulativeTimeline, selectSessions, priceFor, PRICING } from '../src/main/providers/util.js'

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

test('surface labels map transcript entrypoints to human names', () => {
  assert.equal(surfaceLabel('cli'), 'Claude Code · CLI')
  assert.equal(surfaceLabel('remote_desktop'), 'Claude Code · web')
  assert.equal(surfaceLabel('cowork-local'), 'Cowork')
  assert.equal(surfaceLabel(null), null)
})

test('session summary aggregates tokens, duration, models, and a bounded timeline', () => {
  const t0 = Date.parse('2026-08-15T10:00:00Z')
  const events = Array.from({ length: 200 }, (_, i) => ({
    ts: t0 + i * 60_000,
    input: 10,
    cachedInput: 5,
    cacheWrite: 0,
    output: 20,
    reasoning: 0,
    total: 35,
    usd: 0.001,
    model: i % 2 ? 'claude-opus-5' : 'claude-haiku-4-5'
  }))
  const s = buildSessionSummary(events, { id: 'sess-1', title: 'proj', surface: 'Claude Code · CLI' })
  assert.equal(s.events, 200)
  assert.equal(s.tokens.total, 7000)
  assert.equal(s.durationMs, 199 * 60_000)
  assert.equal(s.models.length, 2)
  assert.ok(s.timeline.length <= 60)
  assert.equal(s.timeline.at(-1).total, 7000)
  assert.equal(buildSessionSummary([], { id: 'empty' }), null)
})

test('cumulative timeline keeps first and last points when downsampling', () => {
  const events = Array.from({ length: 500 }, (_, i) => ({ ts: i, total: 1, usd: 0 }))
  const tl = cumulativeTimeline(events, 50)
  assert.equal(tl.length, 50)
  assert.equal(tl[0].total, 1)
  assert.equal(tl.at(-1).total, 500)
})

test('session selection clips to range, sorts newest-first, and caps volume', () => {
  const day = 86_400_000
  const now = Date.now()
  const mk = (offset) => ({ id: String(offset), start: now - offset * day, end: now - offset * day + 3600_000 })
  const picked = selectSessions([mk(1), mk(40), mk(2)], { from: now - 30 * day, to: now })
  assert.deepEqual(picked.map((s) => s.id), ['1', '2'])
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

