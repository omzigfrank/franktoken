// OpenAI Codex provider.
// Reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//  - `rate_limits` events  -> primary (5h) + secondary (weekly) windows (current)
//  - `token_count` events  -> cumulative token usage; we diff consecutive
//    snapshots into time-stamped incremental events for range analysis.
import path from 'node:path'
import { HOME, exists, listJsonl, readJsonlLines, estimateCost, summarize, normalizeRange } from './util.js'
import { buildSessions, sessionCoverage } from './sessions.js'

const ROOT = path.join(HOME, '.codex')
const SESSIONS = path.join(ROOT, 'sessions')

function emptyTokens() {
  return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
}

function tokenNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function codexCumulativeUsage(usage) {
  const rawInput = tokenNumber(usage?.input_tokens)
  const cachedInput = tokenNumber(usage?.cached_input_tokens)
  const cacheWrite = tokenNumber(usage?.cache_write_input_tokens)
  const output = tokenNumber(usage?.output_tokens)
  return {
    rawInput,
    cachedInput,
    cacheWrite,
    output,
    reasoning: tokenNumber(usage?.reasoning_output_tokens),
    total: tokenNumber(usage?.total_tokens) || rawInput + output
  }
}

export function codexUsageDelta(current, previous = null) {
  // A lower total means the CLI reset its cumulative counter. Treat that
  // snapshot as a new baseline instead of silently losing the first turn.
  const reset = previous && current.total < previous.total
  const delta = (key) => (!previous || reset ? current[key] : Math.max(0, current[key] - previous[key]))
  const rawInput = delta('rawInput')
  const cachedInput = delta('cachedInput')
  const cacheWrite = delta('cacheWrite')
  return {
    input: Math.max(0, rawInput - cachedInput - cacheWrite),
    cachedInput,
    cacheWrite,
    output: delta('output'),
    reasoning: delta('reasoning'),
    total: delta('total')
  }
}

function windowFrom(snap, id, label) {
  if (!snap) return null
  return {
    id,
    label,
    usedPercent: Number(snap.used_percent) || 0,
    windowMinutes: snap.window_minutes ?? null,
    resetsAt: snap.resets_at ? snap.resets_at * 1000 : null,
    estimated: false
  }
}

export default {
  id: 'codex',
  name: 'OpenAI Codex',
  color: '#10a37f',

  detect() {
    return exists(SESSIONS) || exists(ROOT)
  },

  async fetch(range) {
    const r = normalizeRange(range)
    const base = {
      id: this.id,
      name: this.name,
      color: this.color,
      available: false,
      error: null,
      windows: [],
      tokens: emptyTokens(),
      cost: { today: 0, total: 0, currency: 'USD', estimated: true },
      series: { tokensByDay: [], costByDay: [] },
      sessions: [],
      coverage: sessionCoverage('local', 'seconds'),
      meta: { lastActivity: null, sessions: 0, model: null }
    }

    if (!this.detect()) {
      base.error = 'Codex not found (~/.codex). Install the Codex CLI to track usage.'
      return base
    }

    // scan enough history to cover the requested range (+1 day slack)
    const days = Math.max(2, Math.ceil((Date.now() - r.from) / 86_400_000) + 1)
    const files = listJsonl(SESSIONS, { days })
    if (files.length === 0) {
      base.available = true
      base.error = 'No Codex sessions found for this range.'
      return base
    }

    base.meta.sessions = files.length
    base.meta.lastActivity = files[0].mtimeMs

    const events = [] // granular incremental usage events
    let latestWindows = null
    let latestWindowTs = 0
    const modelCounts = new Map() // model -> incremental tokens across range

    for (const f of files) {
      // token_count is cumulative within a session -> diff into increments.
      let prev = null
      let sessionModel = null
      const snaps = [] // { ts, usage }
      await readJsonlLines(f.path, (obj) => {
        if (!obj) return
        const type = obj.type || obj.payload?.type
        const m = obj.payload?.model || obj.model || obj.payload?.turn_context?.model
        if (m) {
          sessionModel = m
        }
        const rl = obj.payload?.rate_limits || obj.rate_limits || obj.info?.rate_limits
        if (rl && (rl.primary || rl.secondary)) {
          const ts = (obj.timestamp ? Date.parse(obj.timestamp) : 0) || f.mtimeMs
          if (ts >= latestWindowTs) {
            latestWindowTs = ts
            latestWindows = rl
          }
        }
        const info = obj.info || obj.payload?.info
        const usage = info?.total_token_usage || obj.payload?.total_token_usage
        if (usage && (type === 'token_count' || usage.total_tokens != null)) {
          const ts = (obj.timestamp ? Date.parse(obj.timestamp) : 0) || f.mtimeMs
          snaps.push({ ts, usage, model: sessionModel })
        }
      })

      for (const s of snaps) {
        const cur = codexCumulativeUsage(s.usage)
        // incremental delta vs previous snapshot in this session
        const d = codexUsageDelta(cur, prev)
        prev = cur
        if (d.total === 0) continue
        const eventModel = s.model || sessionModel || null
        if (eventModel) modelCounts.set(eventModel, (modelCounts.get(eventModel) || 0) + d.total)
        const usd = estimateCost(
          { input: d.input, output: d.output, cacheWrite: d.cacheWrite, cacheRead: d.cachedInput },
          eventModel || 'gpt-5-codex'
        )
        events.push({ ts: s.ts, ...d, usd, model: eventModel, source: f.path })
      }
    }

    // All models seen in range, most-used first; meta.model stays the top one.
    const models = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
    base.meta.model = models[0] || null
    base.meta.models = models
    base.available = true

    if (latestWindows) {
      const w = []
      const p = windowFrom(latestWindows.primary, '5h', '5-Hour Window')
      const s = windowFrom(latestWindows.secondary, 'weekly', 'Weekly Window')
      if (p) w.push(p)
      if (s) w.push(s)
      base.windows = w
    }

    const sum = summarize(events, r, { costEstimated: true })
    base.tokens = sum.tokens
    base.cost = sum.cost
    base.series = sum.series
    base.range = sum.range
    base.sessions = buildSessions(events, r, {
      provider: 'codex',
      product: 'Codex',
      sourceType: 'local',
      sourceLabel: 'Codex transcript',
      freshness: 'seconds',
      costKind: 'estimated'
    })

    // Per-model breakdown so the UI can filter by clicking a model badge.
    // Models with zero tokens inside the range are dropped.
    base.byModel = {}
    for (const mName of models) {
      const ms = summarize(events.filter((e) => e.model === mName), r, { costEstimated: true })
      if (ms.tokens.total > 0) base.byModel[mName] = { tokens: ms.tokens, cost: ms.cost, series: ms.series }
    }
    base.meta.models = models.filter((m) => base.byModel[m])
    base.meta.model = base.meta.models[0] || base.meta.model
    return base
  }
}
