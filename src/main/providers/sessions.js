import path from 'node:path'

function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function emptyUsage() {
  return {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0
  }
}

export function addUsage(target, event) {
  target.input += finite(event.input)
  target.cachedInput += finite(event.cachedInput)
  target.cacheWrite += finite(event.cacheWrite)
  target.output += finite(event.output)
  target.reasoning += finite(event.reasoning)
  target.total += finite(event.total)
  return target
}

function sessionLabel(file, fallback) {
  if (!file) return fallback
  const project = path.basename(path.dirname(file))
  if (project && project !== 'sessions') return project.replace(/^-+/, '').replace(/-+/g, ' ')
  return fallback
}

/**
 * Convert request-level usage events into a transport-safe session shape for
 * the dashboard and remote hub. Events outside the selected range are omitted.
 */
export function buildSessions(events, range, options = {}) {
  const from = range?.from ?? 0
  const to = range?.to ?? Number.POSITIVE_INFINITY
  const groups = new Map()

  for (const event of events) {
    if (!event || event.ts < from || event.ts > to) continue
    const source = event.source || options.source || 'unknown'
    const id = event.sessionId || path.basename(source, path.extname(source)) || `session-${event.ts}`
    const key = `${options.provider || 'unknown'}:${id}`
    let session = groups.get(key)
    if (!session) {
      session = {
        id,
        provider: options.provider || 'unknown',
        // Events may carry a per-session product (e.g. the Claude surface the
        // session ran on: CLI / web / desktop / IDE / Cowork).
        product: event.product || options.product || options.provider || 'unknown',
        sourceType: options.sourceType || 'local',
        sourceLabel: options.sourceLabel || 'Local session',
        title: event.title || sessionLabel(source, `Session ${id.slice(0, 8)}`),
        device: event.device || options.device || null,
        user: event.user || options.user || null,
        startedAt: event.ts,
        endedAt: event.ts,
        durationMs: 0,
        requestCount: 0,
        models: [],
        primaryModel: null,
        tokens: emptyUsage(),
        costUsd: 0,
        costKind: options.costKind || 'estimated',
        freshness: options.freshness || 'local',
        requests: []
      }
      groups.set(key, session)
    }

    session.startedAt = Math.min(session.startedAt, event.ts)
    session.endedAt = Math.max(session.endedAt, event.ts + finite(event.durationMs))
    session.requestCount += finite(event.requestCount) || 1
    addUsage(session.tokens, event)
    session.costUsd += finite(event.usd)
    if (event.model && !session.models.includes(event.model)) session.models.push(event.model)
    session.requests.push({
      id: event.key || event.requestId || `${id}:${session.requestCount}`,
      timestamp: event.ts,
      durationMs: finite(event.durationMs),
      model: event.model || null,
      input: finite(event.input),
      cachedInput: finite(event.cachedInput),
      cacheWrite: finite(event.cacheWrite),
      output: finite(event.output),
      reasoning: finite(event.reasoning),
      total: finite(event.total),
      costUsd: finite(event.usd),
      costKind: event.costKind || options.costKind || 'estimated',
      status: event.status || 'ok',
      tool: event.tool || null,
      aggregateCount: finite(event.requestCount) || 1
    })
  }

  return [...groups.values()]
    .map((session) => {
      session.requests.sort((a, b) => a.timestamp - b.timestamp)
      session.models.sort((a, b) => {
        const used = (model) => session.requests
          .filter((request) => request.model === model)
          .reduce((sum, request) => sum + request.total, 0)
        return used(b) - used(a)
      })
      session.primaryModel = session.models[0] || null
      session.durationMs = Math.max(0, session.endedAt - session.startedAt)
      return session
    })
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function sessionCoverage(sourceType, freshness, detail = 'request') {
  return {
    sourceType,
    freshness,
    detail,
    lastSyncedAt: Date.now()
  }
}
