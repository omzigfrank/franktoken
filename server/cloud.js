import crypto from 'node:crypto'
import { estimateCost } from '../src/main/providers/util.js'

const MINUTE = 60_000

function key(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}

function iso(value) {
  return new Date(value).toISOString()
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function providerJson(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    return response.json()
  } finally {
    clearTimeout(timer)
  }
}

function openAiEvent(bucket, result) {
  const timestamp = num(bucket.start_time) * 1000
  const cachedInput = num(result.input_cached_tokens)
  const input = Math.max(0, num(result.input_tokens) - cachedInput)
  const output = num(result.output_tokens)
  const model = result.model || 'OpenAI model'
  const sessionId = `openai-${bucket.start_time}-${result.project_id || 'all'}-${model}`
  return {
    key: key(['openai', bucket.start_time, bucket.end_time, result.project_id, result.user_id, result.api_key_id, model]),
    sessionId,
    ts: timestamp,
    durationMs: Math.max(MINUTE, num(bucket.end_time) * 1000 - timestamp),
    input, cachedInput, cacheWrite: 0, output, reasoning: 0,
    total: input + cachedInput + output,
    usd: estimateCost({ input, output, cacheRead: cachedInput }, model),
    costKind: 'estimated', model, provider: 'openai-api', product: 'OpenAI API', color: '#24d3ee',
    source: `openai://organization/${result.project_id || 'all'}/${bucket.start_time}`,
    sourceType: 'admin-api', sourceLabel: 'OpenAI Organization Usage API', freshness: 'minutes',
    user: result.user_id || null, device: null,
    title: `OpenAI API · ${model} · ${iso(timestamp).slice(11, 16)} UTC`,
    status: 'ok', requestCount: num(result.num_model_requests),
    reconciliationKey: `${Math.floor(num(bucket.start_time) / 86_400) * 86_400}|${result.project_id || 'all'}`
  }
}

function anthropicEvent(bucket, result) {
  const timestamp = Date.parse(bucket.starting_at || bucket.start_time)
  const cachedInput = num(result.cache_read_input_tokens)
  const cacheWrite = num(result.cache_creation_input_tokens)
    + num(result.cache_creation?.ephemeral_5m_input_tokens)
    + num(result.cache_creation?.ephemeral_1h_input_tokens)
  const input = num(result.uncached_input_tokens || result.input_tokens)
  const output = num(result.output_tokens)
  const model = result.model || 'Claude model'
  const workspace = result.workspace_id || 'all'
  const sessionId = `anthropic-${timestamp}-${workspace}-${model}`
  return {
    key: key(['anthropic', bucket.starting_at, bucket.ending_at, workspace, result.api_key_id, model, result.service_tier]),
    sessionId,
    ts: timestamp,
    durationMs: Math.max(MINUTE, Date.parse(bucket.ending_at || bucket.end_time) - timestamp || MINUTE),
    input, cachedInput, cacheWrite, output, reasoning: 0,
    total: input + cachedInput + cacheWrite + output,
    usd: estimateCost({ input, output, cacheRead: cachedInput, cacheWrite }, model),
    costKind: 'estimated', model, provider: 'claude-api', product: 'Claude API', color: '#d97757',
    source: `anthropic://organization/${workspace}/${timestamp}`,
    sourceType: 'admin-api', sourceLabel: 'Anthropic Usage & Cost API', freshness: '~5 minutes',
    user: null, device: null,
    title: `Claude API · ${model} · ${iso(timestamp).slice(11, 16)} UTC`,
    status: 'ok', requestCount: num(result.messages_count || result.request_count)
  }
}

const enterpriseProducts = {
  chat: { provider: 'claude', product: 'Claude', color: '#d97757' },
  claude_code: { provider: 'claude-code', product: 'Claude Code', color: '#d97757' },
  cowork: { provider: 'claude-cowork', product: 'Claude Cowork', color: '#f7b955' },
  office_agent: { provider: 'claude-office', product: 'Claude Office Agents', color: '#ff8b65' },
  claude_design: { provider: 'claude-design', product: 'Claude Design', color: '#a78bfa' },
  claude_in_chrome: { provider: 'claude-chrome', product: 'Claude in Chrome', color: '#f29b72' },
  'claude-in-slack': { provider: 'claude-slack', product: 'Claude in Slack', color: '#e99bce' }
}

function enterpriseUsageEvent(bucket, result, costs = new Map()) {
  const timestamp = Date.parse(bucket.starting_at)
  const cachedInput = num(result.cache_read_input_tokens)
  const cacheWrite = num(result.cache_creation?.ephemeral_5m_input_tokens) + num(result.cache_creation?.ephemeral_1h_input_tokens)
  const input = num(result.uncached_input_tokens)
  const output = num(result.output_tokens)
  const model = result.model || 'Claude model'
  const mapped = enterpriseProducts[result.product] || { provider: 'claude-other', product: result.product || 'Claude other', color: '#d97757' }
  const costKey = [bucket.starting_at, result.product || 'other', model].join('|')
  const providerCost = costs.get(costKey)
  const sessionId = `claude-enterprise-${timestamp}-${result.product || 'other'}-${model}`
  return {
    key: key(['claude-enterprise', bucket.starting_at, bucket.ending_at, result.product, model, result.context_window, result.inference_geo, result.speed]),
    sessionId, ts: timestamp,
    durationMs: Math.max(MINUTE, Date.parse(bucket.ending_at) - timestamp || MINUTE),
    input, cachedInput, cacheWrite, output, reasoning: 0,
    total: input + cachedInput + cacheWrite + output,
    usd: providerCost ?? estimateCost({ input, output, cacheRead: cachedInput, cacheWrite }, model),
    costKind: providerCost == null ? 'estimated' : 'provider',
    model, provider: mapped.provider, product: mapped.product, color: mapped.color,
    source: `anthropic-enterprise://organization/${result.product || 'other'}/${timestamp}`,
    sourceType: 'admin-api', sourceLabel: 'Claude Enterprise Analytics API', freshness: '4–24 hours',
    user: null, device: null,
    title: `${mapped.product} · ${model} · ${iso(timestamp).slice(11, 16)} UTC`,
    status: 'ok', requestCount: num(result.requests)
  }
}

async function openAiUsage(apiKey, since, until) {
  const events = []
  let page = null
  do {
    const url = new URL('https://api.openai.com/v1/organization/usage/completions')
    url.searchParams.set('start_time', String(Math.floor(since / 1000)))
    url.searchParams.set('end_time', String(Math.floor(until / 1000)))
    url.searchParams.set('bucket_width', '1m')
    url.searchParams.append('group_by', 'model')
    url.searchParams.append('group_by', 'project_id')
    url.searchParams.append('group_by', 'user_id')
    url.searchParams.append('group_by', 'api_key_id')
    url.searchParams.set('limit', '1440')
    if (page) url.searchParams.set('page', page)
    const body = await providerJson(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    for (const bucket of body.data || []) for (const result of bucket.results || []) events.push(openAiEvent(bucket, result))
    page = body.next_page || null
  } while (page)
  try {
    const costs = await openAiCosts(apiKey, since, until)
    const groups = new Map()
    for (const event of events) {
      const group = groups.get(event.reconciliationKey) || []
      group.push(event)
      groups.set(event.reconciliationKey, group)
    }
    for (const [groupKey, group] of groups) {
      const actual = costs.get(groupKey)
      if (actual == null) continue
      const estimated = group.reduce((sum, event) => sum + event.usd, 0)
      const tokenTotal = group.reduce((sum, event) => sum + event.total, 0)
      for (const event of group) {
        const weight = estimated > 0 ? event.usd / estimated : tokenTotal > 0 ? event.total / tokenTotal : 1 / group.length
        event.usd = actual * weight
        event.costKind = 'provider'
      }
    }
  } catch (error) {
    console.error('OpenAI cost reconciliation failed', error)
  }
  return events
}

async function openAiCosts(apiKey, since, until) {
  const costs = new Map()
  let page = null
  do {
    const url = new URL('https://api.openai.com/v1/organization/costs')
    url.searchParams.set('start_time', String(Math.floor(since / 1000)))
    url.searchParams.set('end_time', String(Math.floor(until / 1000)))
    url.searchParams.set('bucket_width', '1d')
    url.searchParams.append('group_by', 'project_id')
    url.searchParams.set('limit', '31')
    if (page) url.searchParams.set('page', page)
    const body = await providerJson(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    for (const bucket of body.data || []) {
      for (const result of bucket.results || []) {
        const groupKey = `${bucket.start_time}|${result.project_id || 'all'}`
        costs.set(groupKey, (costs.get(groupKey) || 0) + num(result.amount?.value))
      }
    }
    page = body.next_page || null
  } while (page)
  return costs
}

async function anthropicUsage(apiKey, since, until) {
  const events = []
  let page = null
  do {
    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages')
    url.searchParams.set('starting_at', new Date(since).toISOString())
    url.searchParams.set('ending_at', new Date(until).toISOString())
    url.searchParams.set('bucket_width', '1m')
    for (const value of ['model', 'workspace_id', 'api_key_id', 'service_tier']) url.searchParams.append('group_by[]', value)
    if (page) url.searchParams.set('page', page)
    const body = await providerJson(url, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    })
    for (const bucket of body.data || []) for (const result of bucket.results || []) events.push(anthropicEvent(bucket, result))
    page = body.next_page || null
  } while (page)
  return events
}

async function enterprisePages(apiKey, endpoint, since, until) {
  const rows = []
  let page = null
  do {
    const url = new URL(`https://api.anthropic.com/v1/organizations/analytics/${endpoint}`)
    url.searchParams.set('starting_at', new Date(since).toISOString())
    url.searchParams.set('ending_at', new Date(until).toISOString())
    url.searchParams.set('bucket_width', '1h')
    url.searchParams.append('group_by[]', 'product')
    url.searchParams.append('group_by[]', 'model')
    url.searchParams.set('limit', '168')
    if (page) url.searchParams.set('page', page)
    const body = await providerJson(url, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    })
    rows.push(...(body.data || []))
    page = body.next_page || null
  } while (page)
  return rows
}

async function anthropicEnterpriseUsage(apiKey, since, until) {
  const [usageBuckets, costBuckets] = await Promise.all([
    enterprisePages(apiKey, 'usage_report', since, until),
    enterprisePages(apiKey, 'cost_report', since, until)
  ])
  const costs = new Map()
  for (const bucket of costBuckets) {
    for (const result of bucket.results || []) {
      const costKey = [bucket.starting_at, result.product || 'other', result.model || 'Claude model'].join('|')
      costs.set(costKey, (costs.get(costKey) || 0) + num(result.amount) / 100)
    }
  }
  return usageBuckets.flatMap((bucket) => (bucket.results || []).map((result) => enterpriseUsageEvent(bucket, result, costs)))
}

/** Poll delayed provider admin APIs as a reconciliation layer behind real-time OTLP. */
export function startCloudPolling(store, onAccepted = () => {}) {
  const openAiKey = process.env.FRANKTOKEN_OPENAI_ADMIN_KEY || ''
  const anthropicKey = process.env.FRANKTOKEN_ANTHROPIC_ADMIN_KEY || ''
  const anthropicAnalyticsKey = process.env.FRANKTOKEN_ANTHROPIC_ANALYTICS_KEY || ''
  if (!openAiKey && !anthropicKey && !anthropicAnalyticsKey) return () => {}
  const intervalMs = Math.max(60_000, num(process.env.FRANKTOKEN_CLOUD_POLL_SECONDS || 60) * 1000)
  let running = false

  const poll = async () => {
    if (running) return
    running = true
    const until = Date.now()
    const since = until - 24 * 60 * MINUTE
    try {
      const tasks = []
      if (openAiKey) tasks.push(openAiUsage(openAiKey, since, until))
      if (anthropicKey) tasks.push(anthropicUsage(anthropicKey, since, until))
      if (anthropicAnalyticsKey) tasks.push(anthropicEnterpriseUsage(anthropicAnalyticsKey, since, until))
      const accepted = store.ingest((await Promise.all(tasks)).flat())
      if (accepted) onAccepted(accepted)
    } catch (error) {
      console.error('cloud reconciliation failed', error)
    } finally {
      running = false
    }
  }

  poll()
  const timer = setInterval(poll, intervalMs)
  return () => clearInterval(timer)
}

export const cloudInternals = { openAiEvent, anthropicEvent, enterpriseUsageEvent }
