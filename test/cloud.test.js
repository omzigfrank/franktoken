import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cloudInternals } from '../server/cloud.js'
import { EventStore } from '../server/store.js'

test('Claude Enterprise analytics preserves product, model, token mix, and provider cost', () => {
  const bucket = { starting_at: '2026-08-15T12:00:00Z', ending_at: '2026-08-15T13:00:00Z' }
  const result = {
    product: 'claude_design', model: 'claude-sonnet-5', requests: 14,
    uncached_input_tokens: 1_000, cache_read_input_tokens: 400,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
    output_tokens: 300
  }
  const costs = new Map([['2026-08-15T12:00:00Z|claude_design|claude-sonnet-5', 1.23]])
  const event = cloudInternals.enterpriseUsageEvent(bucket, result, costs)

  assert.equal(event.provider, 'claude-design')
  assert.equal(event.product, 'Claude Design')
  assert.equal(event.total, 2_000)
  assert.equal(event.cacheWrite, 300)
  assert.equal(event.requestCount, 14)
  assert.equal(event.usd, 1.23)
  assert.equal(event.costKind, 'provider')
})

test('OpenAI organization usage treats cached input as a subset', () => {
  const event = cloudInternals.openAiEvent(
    { start_time: 1786795200, end_time: 1786795260 },
    { model: 'gpt-5.4', project_id: 'proj_1', input_tokens: 1_000, input_cached_tokens: 600, output_tokens: 200, num_model_requests: 3 }
  )
  assert.equal(event.input, 400)
  assert.equal(event.cachedInput, 600)
  assert.equal(event.total, 1_200)
  assert.equal(event.requestCount, 3)
})

test('Hub revisions replace estimates when delayed provider costs arrive', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'franktoken-test-'))
  try {
    const store = new EventStore(path.join(directory, 'events.jsonl'))
    const base = {
      key: 'reconciled-event', sessionId: 'session', ts: Date.now(), provider: 'claude-design',
      product: 'Claude Design', model: 'claude-sonnet-5', input: 10, cachedInput: 0,
      cacheWrite: 0, output: 5, reasoning: 0, total: 15, usd: 0.01, costKind: 'estimated'
    }
    assert.equal(store.ingest([base]), 1)
    assert.equal(store.ingest([base]), 0)
    assert.equal(store.ingest([{ ...base, usd: 0.008, costKind: 'provider' }]), 1)
    assert.equal(store.events.get(base.key).usd, 0.008)
    assert.equal(store.events.get(base.key).costKind, 'provider')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
