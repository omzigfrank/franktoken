// OpenAI Codex provider.
// Reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//  - `rate_limits` events  -> primary (5h) + secondary (weekly) windows (current)
//  - `token_count` events  -> cumulative token usage; we diff consecutive
//    snapshots into time-stamped incremental events for range analysis.
import path from 'node:path'
import { HOME, exists, listJsonl, readJsonlLines, estimateCost, summarize, normalizeRange } from './util.js'

const ROOT = path.join(HOME, '.codex')
const SESSIONS = path.join(ROOT, 'sessions')

function emptyTokens() {
  return { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 }
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
      meta: { lastActivity: null, sessions: 0, model: null }
    }

    if (!this.detect()) {
      base.error = 'Codex not found (~/.codex). Install the Codex CLI to track usage.'
      return base
    }

    // scan enough history to cover the requested range (+1 day slack)
    const days = Math.max(2, Math.ceil((Date.now() - r.from) / 86_400_000) + 1)
    const files = listJsonl(SESSIONS, { days, limit: 800 })
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
    let model = null

    for (const f of files) {
      // token_count is cumulative within a session -> diff into increments.
      let prev = null
      const snaps = [] // { ts, usage }
      await readJsonlLines(f.path, (obj) => {
        if (!obj) return
        const type = obj.type || obj.payload?.type
        if (!model) {
          model = obj.payload?.model || obj.model || obj.payload?.turn_context?.model || model
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
          snaps.push({ ts, usage })
        }
      })

      for (const s of snaps) {
        const cur = {
          input: s.usage.input_tokens || 0,
          cachedInput: s.usage.cached_input_tokens || 0,
          output: s.usage.output_tokens || 0,
          reasoning: s.usage.reasoning_output_tokens || 0,
          total: s.usage.total_tokens || 0
        }
        // incremental delta vs previous snapshot in this session
        const d = prev
          ? {
              input: Math.max(0, cur.input - prev.input),
              cachedInput: Math.max(0, cur.cachedInput - prev.cachedInput),
              output: Math.max(0, cur.output - prev.output),
              reasoning: Math.max(0, cur.reasoning - prev.reasoning),
              total: Math.max(0, cur.total - prev.total)
            }
          : cur
        prev = cur
        if (d.total === 0) continue
        const usd = estimateCost(
          { input: d.input - d.cachedInput, output: d.output, cacheRead: d.cachedInput },
          model || 'gpt-5-codex'
        )
        events.push({ ts: s.ts, ...d, usd })
      }
    }

    base.meta.model = model
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
    return base
  }
}
