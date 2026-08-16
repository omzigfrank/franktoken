import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildSessions } from '../src/main/providers/sessions.js'
import { estimateCost, summarize } from '../src/main/providers/util.js'

function number(attributes, ...keys) {
  for (const key of keys) {
    const value = Number(attributes?.[key])
    if (Number.isFinite(value)) return value
  }
  return 0
}

function text(attributes, ...keys) {
  for (const key of keys) if (attributes?.[key] != null) return String(attributes[key])
  return null
}

function productOf(attributes, resource = {}) {
  const service = `${text(resource, 'service.name') || ''} ${text(attributes, 'service.name') || ''}`.toLowerCase()
  const surface = String(text(attributes, 'agent.surface', 'surface') || '').toLowerCase()
  if (service.includes('office') || ['slide', 'powerpoint', 'doc', 'word', 'sheet', 'excel', 'mail', 'outlook'].includes(surface)) {
    const product = ['slide', 'powerpoint'].includes(surface) ? 'Claude for PowerPoint'
      : ['doc', 'word'].includes(surface) ? 'Claude for Word'
        : ['sheet', 'excel'].includes(surface) ? 'Claude for Excel'
          : ['mail', 'outlook'].includes(surface) ? 'Claude for Outlook' : 'Claude Office Agents'
    return {
      provider: product === 'Claude for PowerPoint' ? 'claude-powerpoint'
        : product === 'Claude for Word' ? 'claude-word'
          : product === 'Claude for Excel' ? 'claude-excel'
            : product === 'Claude for Outlook' ? 'claude-outlook' : 'claude-office',
      product,
      color: '#ff8b65'
    }
  }
  if (service.includes('cowork')) return { provider: 'claude-cowork', product: 'Claude Cowork', color: '#f7b955' }
  if (service.includes('claude') || Object.keys(attributes || {}).some((key) => key.startsWith('claude_code.'))) return { provider: 'claude-code', product: 'Claude Code', color: '#d97757' }
  if (service.includes('codex')) return { provider: 'codex', product: 'Codex', color: '#10a37f' }
  if (service.includes('openai')) return { provider: 'openai-api', product: 'OpenAI API', color: '#24d3ee' }
  return { provider: 'telemetry', product: 'AI telemetry', color: '#7c6cff' }
}

function tokenUsage(attributes) {
  const input = number(attributes, 'input_tokens', 'gen_ai.usage.input_tokens', 'token.input')
  const cachedInput = number(attributes, 'cache_read_tokens', 'cached_input_tokens', 'gen_ai.usage.cached_input_tokens', 'token.cache_read')
  const cacheWrite = number(attributes, 'cache_creation_tokens', 'cache_write_input_tokens', 'token.cache_creation')
  const output = number(attributes, 'output_tokens', 'gen_ai.usage.output_tokens', 'token.output')
  const reasoning = number(attributes, 'reasoning_tokens', 'reasoning_output_tokens', 'gen_ai.usage.reasoning_tokens')
  return { input, cachedInput, cacheWrite, output, reasoning, total: input + cachedInput + cacheWrite + output + reasoning }
}

function stableId(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

export function normalizeOtlp(items) {
  const events = []
  for (const item of items) {
    const attributes = { ...(item.resource || {}), ...(item.attributes || {}) }
    const product = productOf(attributes, item.resource)
    const timestamp = item.startedAt || item.timestamp || Date.now()
    let usage = tokenUsage(attributes)

    if (item.signal === 'metrics' && /token\.usage$/i.test(item.name || '')) {
      const count = Number(item.value) || number(attributes, 'token_usage.token_count', 'token.count')
      const type = text(attributes, 'token_usage.type', 'type', 'token.type')
      usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: count }
      if (/cache.?read/i.test(type || '')) usage.cachedInput = count
      else if (/cache.?creation|cache.?write/i.test(type || '')) usage.cacheWrite = count
      else if (/output/i.test(type || '')) usage.output = count
      else if (/reason/i.test(type || '')) usage.reasoning = count
      else usage.input = count
    }

    if (usage.total === 0) continue
    const model = text(attributes, 'model', 'gen_ai.request.model', 'token_usage.model', 'token.model') || 'Unknown'
    const suppliedCost = number(attributes, 'cost_usd', 'estimated_cost_usd', 'gen_ai.usage.cost_usd')
    const usd = suppliedCost || estimateCost({ input: usage.input, output: usage.output, cacheRead: usage.cachedInput, cacheWrite: usage.cacheWrite }, model)
    const sessionId = text(attributes, 'session.id', 'session_id', 'conversation.id') || item.traceId || item.spanId || `otel-${timestamp}`
    const event = {
      key: text(attributes, 'request_id', 'gen_ai.response.id') || item.spanId || stableId([item.signal, item.name, sessionId, timestamp, usage]),
      requestId: text(attributes, 'request_id', 'gen_ai.response.id'),
      sessionId,
      ts: timestamp,
      durationMs: item.endedAt ? Math.max(0, item.endedAt - timestamp) : number(attributes, 'duration_ms', 'interaction.duration_ms'),
      ...usage,
      usd,
      costKind: suppliedCost ? 'provider' : 'estimated',
      model,
      provider: product.provider,
      product: product.product,
      color: product.color,
      source: `otel://${text(item.resource, 'service.name') || product.provider}/${sessionId}`,
      sourceType: 'otel',
      sourceLabel: 'OpenTelemetry',
      freshness: 'seconds',
      device: text(attributes, 'host.name', 'device.id', 'office.platform', 'terminal_type'),
      user: text(attributes, 'user.email', 'user.account_uuid', 'user.id'),
      title: text(attributes, 'session.title', 'conversation.title') || `${product.product} · ${String(sessionId).slice(0, 8)}`,
      status: text(attributes, 'success') === 'false' ? 'error' : 'ok'
    }
    events.push(event)
  }
  return events
}

export class EventStore {
  constructor(file) {
    this.file = file
    this.events = new Map()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.load()
  }

  load() {
    if (!fs.existsSync(this.file)) return
    for (const line of fs.readFileSync(this.file, 'utf8').split(/\r?\n/)) {
      if (!line) continue
      try {
        const event = JSON.parse(line)
        this.events.set(event.key, event)
      } catch { /* tolerate a partial final line */ }
    }
  }

  ingest(events) {
    const accepted = []
    for (const event of events) {
      const key = event.key || stableId(event)
      const normalized = { ...event, key }
      const existing = this.events.get(key)
      if (existing && JSON.stringify(existing) === JSON.stringify(normalized)) continue
      this.events.set(key, normalized)
      accepted.push(normalized)
    }
    if (accepted.length) fs.appendFileSync(this.file, `${accepted.map((event) => JSON.stringify(event)).join('\n')}\n`)
    return accepted.length
  }

  snapshots(range = {}) {
    const from = Number(range.from) || Date.now() - 30 * 86_400_000
    const to = Number(range.to) || Date.now()
    const granularity = range.granularity || (to - from <= 2 * 86_400_000 ? 'hour' : 'day')
    const events = [...this.events.values()].filter((event) => event.ts >= from && event.ts <= to)
    const groups = new Map()
    for (const event of events) {
      const group = groups.get(event.provider) || { id: event.provider, name: event.product, color: event.color, events: [] }
      group.events.push(event)
      groups.set(event.provider, group)
    }
    return [...groups.values()].map((group) => {
      const sum = summarize(group.events, { from, to, granularity }, { costEstimated: group.events.some((event) => event.costKind !== 'provider') })
      const models = [...new Set(group.events.map((event) => event.model).filter(Boolean))]
      const sourceTypes = [...new Set(group.events.map((event) => event.sourceType).filter(Boolean))]
      const isRealtime = sourceTypes.includes('otel')
      const isAggregate = sourceTypes.length > 0 && sourceTypes.every((type) => type === 'admin-api')
      const freshness = isRealtime ? 'seconds' : group.events[0]?.freshness || 'provider-defined'
      const sessions = buildSessions(group.events, { from, to }, {
        provider: group.id,
        product: group.name,
        sourceType: sourceTypes.join(' + ') || 'ingest',
        sourceLabel: group.events[0]?.sourceLabel || 'FrankToken Hub',
        freshness
      })
      const byModel = Object.fromEntries(models.map((model) => {
        const modelSum = summarize(group.events.filter((event) => event.model === model), { from, to, granularity }, { costEstimated: true })
        return [model, { tokens: modelSum.tokens, cost: modelSum.cost, series: modelSum.series }]
      }))
      return {
        id: group.id, name: group.name, color: group.color, available: true, error: null,
        windows: [], tokens: sum.tokens, cost: sum.cost, series: sum.series, sessions, byModel,
        coverage: {
          sourceType: sourceTypes.join(' + ') || 'ingest',
          freshness,
          detail: isAggregate ? 'minute aggregate' : 'request',
          lastSyncedAt: Math.max(...group.events.map((event) => event.ts))
        },
        meta: { sessions: sessions.length, totalSessions: sessions.length, models, model: models[0] || null, lastActivity: Math.max(...group.events.map((event) => event.ts)) }
      }
    })
  }
}
