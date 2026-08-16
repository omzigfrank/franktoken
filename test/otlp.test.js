import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeOtlp, otlpInternals } from '../server/otlp.js'
import { normalizeOtlp } from '../server/store.js'

const startedAt = Date.parse('2026-08-15T12:00:00Z')
const traceDocument = {
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'office-agent' } }] },
    scopeSpans: [{ spans: [{
      traceId: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      spanId: Buffer.from('0011223344556677', 'hex'),
      name: 'agent.stream',
      startTimeUnixNano: String(BigInt(startedAt) * 1_000_000n),
      endTimeUnixNano: String(BigInt(startedAt + 2_500) * 1_000_000n),
      attributes: [
        { key: 'agent.surface', value: { stringValue: 'slide' } },
        { key: 'session.id', value: { stringValue: 'office-session-1' } },
        { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
        { key: 'input_tokens', value: { intValue: 100 } },
        { key: 'cache_read_tokens', value: { intValue: 40 } },
        { key: 'output_tokens', value: { intValue: 20 } }
      ]
    }] }]
  }]
}

test('OTLP JSON traces become request-granular Office sessions', () => {
  const items = decodeOtlp(Buffer.from(JSON.stringify(traceDocument)), 'traces', { 'content-type': 'application/json' })
  const events = normalizeOtlp(items)
  assert.equal(events.length, 1)
  assert.equal(events[0].product, 'Claude for PowerPoint')
  assert.equal(events[0].sessionId, 'office-session-1')
  assert.equal(events[0].model, 'claude-sonnet-5')
  assert.equal(events[0].total, 160)
  assert.equal(events[0].durationMs, 2_500)
})

test('OTLP protobuf traces decode through the same normalization path', () => {
  const type = otlpInternals.types.traces
  const encoded = type.encode(type.fromObject(traceDocument)).finish()
  const items = decodeOtlp(Buffer.from(encoded), 'traces', { 'content-type': 'application/x-protobuf' })
  const events = normalizeOtlp(items)
  assert.equal(events.length, 1)
  assert.equal(events[0].provider, 'claude-powerpoint')
  assert.equal(events[0].cachedInput, 40)
})
