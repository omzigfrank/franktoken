// Shared helpers for providers. OS-agnostic: all paths derive from os.homedir().
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

export const HOME = os.homedir()

/**
 * Approximate USD price per 1M tokens. Used for cost ESTIMATES only.
 * Matching is first-key-that-the-model-id-contains, so more specific keys
 * MUST appear before their prefixes (claude-opus-4-8 before claude-opus-4).
 */
export const PRICING = {
  // Anthropic (Claude) — list rates per 1M tokens; cacheWrite = 1.25x input,
  // cacheRead = 0.1x input (Anthropic's standard cache pricing).
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-mythos': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-3-7-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  // OpenAI (Codex / ChatGPT)
  'gpt-5-codex': { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  'gpt-5.1': { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  'gpt-4.1': { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
  'o4-mini': { input: 1.1, output: 4.4, cacheWrite: 1.1, cacheRead: 0.275 },
  o3: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
  'gpt-4o': { input: 2.5, output: 10, cacheWrite: 2.5, cacheRead: 1.25 },
  default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }
}

export function priceFor(model = '') {
  const m = String(model).toLowerCase()
  const key = Object.keys(PRICING).find((k) => k !== 'default' && m.includes(k))
  return PRICING[key] || PRICING.default
}

/** Estimate USD cost from a token-usage breakdown + model. */
export function estimateCost(usage, model) {
  const p = priceFor(model)
  const input = usage.input || 0
  const output = usage.output || 0
  const cacheWrite = usage.cacheWrite || 0
  const cacheRead = usage.cacheRead || 0
  return (
    (input * p.input +
      output * p.output +
      cacheWrite * p.cacheWrite +
      cacheRead * p.cacheRead) /
    1_000_000
  )
}

/** YYYY-MM-DD in local time. */
export function dayKey(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Days spanned by each range preset the UI offers. */
export const RANGE_PRESETS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }

/**
 * Resolve a stored range spec {preset, from, to, granularity} into concrete
 * {from, to, granularity} epoch ms. Lives here rather than in the Electron
 * main process so the preset arithmetic every chart depends on is testable.
 */
export function resolvePreset(spec, now = Date.now()) {
  const r = spec || { preset: '30d' }
  const granularity = r.granularity || 'auto'
  if (r.preset && r.preset !== 'custom') {
    // An unrecognized preset falls back to 30d rather than producing NaN
    // bounds, which would silently filter out every event.
    const days = RANGE_PRESETS[r.preset] || RANGE_PRESETS['30d']
    return { from: now - days * 86_400_000, to: now, granularity }
  }
  return {
    from: r.from ?? now - RANGE_PRESETS['30d'] * 86_400_000,
    to: r.to ?? now,
    granularity
  }
}

/** Normalize a range. {from,to} epoch ms; granularity 'hour'|'day'|'auto'. */
export function normalizeRange(range) {
  const to = range?.to ?? Date.now()
  const from = range?.from ?? to - 30 * 86_400_000
  let granularity = range?.granularity || 'auto'
  if (granularity === 'auto') granularity = to - from <= 2 * 86_400_000 ? 'hour' : 'day'
  return { from, to, granularity }
}

/** Bucket key + short axis label for an instant at the given granularity. */
export function bucketOf(ms, granularity) {
  const d = new Date(ms)
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const D = String(d.getDate()).padStart(2, '0')
  const H = String(d.getHours()).padStart(2, '0')
  if (granularity === 'hour') {
    return { key: `${d.getFullYear()}-${M}-${D} ${H}`, label: `${M}/${D} ${H}h` }
  }
  return { key: `${d.getFullYear()}-${M}-${D}`, label: `${M}-${D}` }
}

/**
 * Aggregate granular events within a range.
 * event: { ts, total, input, output, cachedInput, reasoning, usd }
 * Returns { tokens, cost:{today,total,currency,estimated}, series:{tokensByDay,costByDay}, range }
 */
export function summarize(events, range, { costEstimated = true } = {}) {
  const r = normalizeRange(range)
  const tokens = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
  let costTotal = 0
  let costToday = 0
  const todayKey = dayKey(Date.now())
  const tokenBuckets = new Map() // key -> {label, total}
  const costBuckets = new Map()

  for (const e of events) {
    if (e.ts < r.from || e.ts > r.to) {
      // still count "today" cost for the tray, independent of selected range
      if (dayKey(e.ts) === todayKey) costToday += e.usd || 0
      continue
    }
    tokens.input += e.input || 0
    tokens.cachedInput += e.cachedInput || 0
    tokens.cacheWrite += e.cacheWrite || 0
    tokens.output += e.output || 0
    tokens.reasoning += e.reasoning || 0
    tokens.total += e.total || 0
    costTotal += e.usd || 0
    if (dayKey(e.ts) === todayKey) costToday += e.usd || 0

    const b = bucketOf(e.ts, r.granularity)
    const tb = tokenBuckets.get(b.key) || { label: b.label, total: 0 }
    tb.total += e.total || 0
    tokenBuckets.set(b.key, tb)
    const cb = costBuckets.get(b.key) || { label: b.label, cost: 0 }
    cb.cost += e.usd || 0
    costBuckets.set(b.key, cb)
  }

  const tokensByDay = [...tokenBuckets.entries()]
    .map(([date, v]) => ({ date, label: v.label, total: v.total }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const costByDay = [...costBuckets.entries()]
    .map(([date, v]) => ({ date, label: v.label, cost: v.cost }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    tokens,
    cost: { today: costToday, total: costTotal, currency: 'USD', estimated: costEstimated },
    series: { tokensByDay, costByDay },
    range: r
  }
}

/** Recursively list *.jsonl files under dir, newest-first, modified within `days`. */
export function listJsonl(dir, { days = 30, limit = Infinity } = {}) {
  const out = []
  const cutoff = Date.now() - days * 86_400_000
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full)
          if (st.mtimeMs >= cutoff) out.push({ path: full, mtimeMs: st.mtimeMs })
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, limit)
}

/** Stream a JSONL file, calling onLine(parsedObjOrNull, rawLine) per line. */
export function readJsonlLines(file, onLine) {
  return new Promise((resolve) => {
    let stream
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' })
    } catch {
      return resolve()
    }
    stream.on('error', () => resolve())
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (!line) return
      let obj = null
      try {
        obj = JSON.parse(line)
      } catch {
        /* tolerate partial/garbage lines */
      }
      onLine(obj, line)
    })
    rl.on('close', resolve)
  })
}

export function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

