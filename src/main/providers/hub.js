import { summarize } from './util.js'

function normalizedBase(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

function requestKey(session, request) {
  return request.id || `${session.provider}:${session.id}:${request.timestamp}:${request.model}:${request.total}`
}

function mergeSessions(sessions) {
  const groups = new Map()
  for (const candidate of sessions) {
    const key = `${candidate.provider}:${candidate.id}`
    let session = groups.get(key)
    if (!session) {
      session = { ...candidate, models: [...(candidate.models || [])], requests: [] }
      session._requests = new Map()
      groups.set(key, session)
    }
    for (const request of candidate.requests || []) session._requests.set(requestKey(candidate, request), request)
    if ((candidate.requests || []).length > (session.requests || []).length) {
      for (const field of ['title', 'device', 'user', 'sourceType', 'sourceLabel', 'freshness']) {
        if (candidate[field]) session[field] = candidate[field]
      }
    }
  }

  return [...groups.values()].map((session) => {
    const requests = [...session._requests.values()].sort((a, b) => a.timestamp - b.timestamp)
    const tokens = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
    let costUsd = 0
    for (const request of requests) {
      for (const key of Object.keys(tokens)) tokens[key] += Number(request[key]) || 0
      costUsd += Number(request.costUsd) || 0
    }
    const models = [...new Set(requests.map((request) => request.model).filter(Boolean))]
    models.sort((a, b) => requests.filter((r) => r.model === b).reduce((n, r) => n + r.total, 0) - requests.filter((r) => r.model === a).reduce((n, r) => n + r.total, 0))
    const startedAt = requests[0]?.timestamp ?? session.startedAt
    const endedAt = requests.reduce((latest, request) => Math.max(latest, request.timestamp + (Number(request.durationMs) || 0)), startedAt || 0)
    delete session._requests
    return {
      ...session, requests, tokens, costUsd,
      requestCount: requests.reduce((count, request) => count + (Number(request.aggregateCount) || 1), 0), models,
      primaryModel: models[0] || null, startedAt, endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      costKind: requests.some((request) => request.costKind === 'provider') ? 'provider' : 'estimated'
    }
  }).sort((a, b) => b.startedAt - a.startedAt)
}

function sessionEvents(sessions) {
  return sessions.flatMap((session) => (session.requests || []).map((request) => ({
    ts: request.timestamp, input: request.input, cachedInput: request.cachedInput,
    cacheWrite: request.cacheWrite, output: request.output, reasoning: request.reasoning,
    // Carried so the merged rollup can price the no-cache counterfactual per
    // model rather than falling back to the generic rate for everything.
    total: request.total, usd: request.costUsd, model: request.model || null
  })))
}

/**
 * Add two no-cache counterfactuals. Only used when the merge could not rebuild
 * a rollup from requests; the parts are already same-basis estimates, so
 * summing them keeps the saving comparable.
 */
function addNoCache(a, b) {
  if (!a) return b || null
  if (!b) return a
  const t = (x, k) => (x?.tokens?.[k] || 0)
  const total = (a.cost?.total || 0) + (b.cost?.total || 0)
  const baseline = (a.baseline?.total || 0) + (b.baseline?.total || 0)
  return {
    tokens: {
      input: t(a, 'input') + t(b, 'input'),
      cachedInput: 0,
      cacheWrite: 0,
      output: t(a, 'output') + t(b, 'output'),
      reasoning: t(a, 'reasoning') + t(b, 'reasoning'),
      total: t(a, 'total') + t(b, 'total')
    },
    cost: {
      today: (a.cost?.today || 0) + (b.cost?.today || 0),
      total,
      currency: 'USD',
      estimated: true
    },
    baseline: { today: (a.baseline?.today || 0) + (b.baseline?.today || 0), total: baseline },
    savings: total - baseline,
    multiple: baseline > 0 ? total / baseline : null,
    series: a.series || b.series
  }
}

/** Merge local and Hub snapshots while deduplicating matching session/request IDs. */
export function mergeSnapshots(local, remote, range) {
  const groups = new Map()
  for (const snapshot of [...(local || []), ...(remote || [])]) {
    const existing = groups.get(snapshot.id)
    if (!existing) {
      groups.set(snapshot.id, { ...snapshot, sessions: [...(snapshot.sessions || [])] })
      continue
    }
    const sessions = mergeSessions([...(existing.sessions || []), ...(snapshot.sessions || [])])
    const events = sessionEvents(sessions)
    const rollup = events.length ? summarize(events, range, { costEstimated: sessions.some((session) => session.costKind !== 'provider') }) : null
    const windows = new Map([...(existing.windows || []), ...(snapshot.windows || [])].map((window) => [window.id, window]))
    const models = [...new Set(sessions.flatMap((session) => session.models || []))]
    groups.set(snapshot.id, {
      ...existing,
      available: existing.available || snapshot.available,
      error: existing.error && snapshot.error ? `${existing.error}; ${snapshot.error}` : existing.error || snapshot.error,
      windows: [...windows.values()],
      tokens: rollup?.tokens || {
        input: (existing.tokens?.input || 0) + (snapshot.tokens?.input || 0),
        cachedInput: (existing.tokens?.cachedInput || 0) + (snapshot.tokens?.cachedInput || 0),
        cacheWrite: (existing.tokens?.cacheWrite || 0) + (snapshot.tokens?.cacheWrite || 0),
        output: (existing.tokens?.output || 0) + (snapshot.tokens?.output || 0),
        reasoning: (existing.tokens?.reasoning || 0) + (snapshot.tokens?.reasoning || 0),
        total: (existing.tokens?.total || 0) + (snapshot.tokens?.total || 0)
      },
      cost: rollup?.cost || {
        today: (existing.cost?.today || 0) + (snapshot.cost?.today || 0),
        total: (existing.cost?.total || 0) + (snapshot.cost?.total || 0),
        currency: 'USD', estimated: existing.cost?.estimated || snapshot.cost?.estimated
      },
      series: rollup?.series || existing.series,
      noCache: rollup?.noCache || addNoCache(existing.noCache, snapshot.noCache),
      sessions,
      coverage: {
        sourceType: 'local + hub',
        freshness: snapshot.coverage?.freshness || existing.coverage?.freshness || 'unknown',
        detail: existing.coverage?.detail === 'request' || snapshot.coverage?.detail === 'request' ? 'request' : 'aggregate',
        lastSyncedAt: Math.max(existing.coverage?.lastSyncedAt || 0, snapshot.coverage?.lastSyncedAt || 0) || null
      },
      meta: {
        ...existing.meta, sessions: sessions.length, totalSessions: sessions.length, models,
        model: models[0] || null,
        lastActivity: Math.max(existing.meta?.lastActivity || 0, snapshot.meta?.lastActivity || 0) || null
      }
    })
  }
  return [...groups.values()]
}

export async function fetchHub({ hubUrl, hubReadToken }, range) {
  const base = normalizedBase(hubUrl)
  if (!base) return []
  const url = new URL(`${base}/api/snapshot`)
  url.searchParams.set('from', String(range.from))
  url.searchParams.set('to', String(range.to))
  url.searchParams.set('granularity', range.granularity || 'auto')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, {
      headers: hubReadToken ? { Authorization: `Bearer ${hubReadToken}` } : {},
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`Hub returned ${response.status}`)
    const body = await response.json()
    return Array.isArray(body.snapshots) ? body.snapshots : []
  } finally {
    clearTimeout(timer)
  }
}
