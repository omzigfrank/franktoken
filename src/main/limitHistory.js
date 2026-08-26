// Account-wide limit history.
//
// The usage API is the only signal that is live no matter which device or
// surface the work happened on — local transcripts only ever describe this
// machine. But a single percentage is a reading, not a statistic: on its own it
// cannot say whether usage is climbing, how fast, or whether the cap will be
// reached before the window resets.
//
// So every successful live poll is sampled and persisted. That turns one live
// number into a trend, a burn rate and a projection, available at all times
// without anyone having to run anything locally.
//
// Everything here is pure and time-parameterized so the retention, reset
// detection and projection maths are testable without waiting for real hours
// to pass.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Full resolution for the recent past, coarse for the tail. At a 90s poll
// interval, 6h of full resolution is ~240 samples; the tail is bucketed to 15
// minutes so 30 days costs ~2,900 more rather than ~29,000.
export const FULL_RESOLUTION_MS = 6 * HOUR
export const COARSE_BUCKET_MS = 15 * MINUTE
export const MAX_AGE_MS = 30 * DAY

// A genuine rollover moves resets_at forward by the whole window — 5 hours or
// 7 days. The API also nudges that timestamp forward by seconds through normal
// rounding, so any-forward-movement is far too sensitive: it restarted the
// segment on nearly every poll, collapsing 35 samples to 1 and reporting "not
// enough data yet" forever. This threshold sits well above that jitter and well
// below the smallest real window.
export const ROLLOVER_JUMP_MS = 30 * MINUTE

/** Compact one live-window array into a single history sample. */
export function toSample(windows, now = Date.now()) {
  if (!Array.isArray(windows) || windows.length === 0) return null
  const w = {}
  for (const win of windows) {
    // Estimated windows carry no percentage — recording them would put holes
    // in the series that look like usage dropping to zero.
    if (!win?.id || win.estimated || win.usedPercent == null) continue
    w[win.id] = {
      pct: Number(win.usedPercent),
      ...(win.usedTokens != null ? { used: win.usedTokens } : {}),
      ...(win.budgetTokens != null ? { budget: win.budgetTokens } : {}),
      ...(win.resetsAt ? { resetsAt: win.resetsAt } : {})
    }
  }
  return Object.keys(w).length ? { at: now, w } : null
}

/**
 * Thin the tail: keep everything inside the full-resolution window, one sample
 * per coarse bucket before that, and nothing older than MAX_AGE_MS.
 */
export function pruneHistory(history, now = Date.now()) {
  if (!Array.isArray(history)) return []
  const cutoff = now - MAX_AGE_MS
  const fullFrom = now - FULL_RESOLUTION_MS
  const out = []
  const seenBuckets = new Set()
  // Walk newest-first so each coarse bucket keeps its most recent sample.
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i]
    if (!s?.at || s.at < cutoff) continue
    if (s.at >= fullFrom) {
      out.push(s)
      continue
    }
    const bucket = Math.floor(s.at / COARSE_BUCKET_MS)
    if (seenBuckets.has(bucket)) continue
    seenBuckets.add(bucket)
    out.push(s)
  }
  return out.reverse()
}

/** Append a sample and prune. Returns a new array; never mutates the input. */
export function addSample(history, windows, now = Date.now()) {
  const sample = toSample(windows, now)
  const base = Array.isArray(history) ? history : []
  if (!sample) return pruneHistory(base, now)
  // Guard against clock jumps or duplicate polls landing on the same instant.
  const last = base[base.length - 1]
  if (last && sample.at <= last.at) return pruneHistory(base, now)
  return pruneHistory([...base, sample], now)
}

/**
 * Samples for one window since its most recent reset. A rate-limit percentage
 * falls back toward zero when the window rolls over, so measuring across that
 * boundary would report a negative burn rate and a nonsense projection.
 */
export function currentSegment(history, id, now = Date.now()) {
  const points = []
  for (const s of Array.isArray(history) ? history : []) {
    const entry = s?.w?.[id]
    if (!entry || entry.pct == null || !s.at) continue
    points.push({ at: s.at, pct: Number(entry.pct), used: entry.used ?? null, resetsAt: entry.resetsAt ?? null })
  }
  if (points.length === 0) return []
  // Cut at the last point where the percentage dropped meaningfully, or where
  // the reported reset time moved forward (an explicit rollover).
  let start = 0
  for (let i = 1; i < points.length; i++) {
    // A percentage falling is the reliable rollover signal.
    const droppedPercent = points[i].pct < points[i - 1].pct - 1
    // A reset time jumping forward by most of a window is the other one. Small
    // forward drift is just the server rounding and must be ignored.
    const rolledOver =
      points[i].resetsAt &&
      points[i - 1].resetsAt &&
      points[i].resetsAt - points[i - 1].resetsAt > ROLLOVER_JUMP_MS
    if (droppedPercent || rolledOver) start = i
  }
  return points.slice(start).filter((p) => p.at <= now)
}

/**
 * Percentage-points per hour over the recent past, measured only within the
 * current window segment. Returns null when there is not enough spread to say
 * anything honest — a rate from two samples 90 seconds apart is noise.
 */
export function burnRate(history, id, now = Date.now(), lookbackMs = 2 * HOUR, minSpanMs = 10 * MINUTE) {
  const full = currentSegment(history, id, now)
  const recent = full.filter((p) => p.at >= now - lookbackMs)
  // Prefer the recent window, but fall back to the whole segment rather than
  // reporting no rate at all: after a restart, or once the tail has been
  // thinned, the last two hours may hold a single sample.
  const segment = recent.length >= 2 ? recent : full
  if (segment.length < 2) return null
  const first = segment[0]
  const last = segment[segment.length - 1]
  const spanMs = last.at - first.at
  if (spanMs < minSpanMs) return null
  const deltaPct = last.pct - first.pct
  return {
    perHour: (deltaPct / spanMs) * HOUR,
    spanMs,
    samples: segment.length,
    fromPct: first.pct,
    toPct: last.pct,
    usedDelta: first.used != null && last.used != null ? last.used - first.used : null
  }
}

/**
 * When the window would reach 100% at the current rate, and whether that lands
 * before it resets. Returns null when the rate is flat or falling — projecting
 * exhaustion from no usage would be invented precision.
 */
export function projectExhaustion(window, rate, now = Date.now()) {
  if (!window || window.usedPercent == null || !rate || rate.perHour <= 0) return null
  const remaining = 100 - Number(window.usedPercent)
  if (remaining <= 0) return { exhaustAt: now, beforeReset: true, hoursLeft: 0 }
  const hoursLeft = remaining / rate.perHour
  const exhaustAt = now + hoursLeft * HOUR
  const resetsAt = window.resetsAt || null
  return {
    exhaustAt,
    hoursLeft,
    // The useful question is not "when do I run out" but "do I run out before
    // this window resets anyway".
    beforeReset: resetsAt ? exhaustAt < resetsAt : null
  }
}

/** Charting series for one window: [{ t, pct }], oldest first. */
export function seriesFor(history, id, sinceMs = 0, now = Date.now()) {
  const from = sinceMs ? now - sinceMs : 0
  const out = []
  for (const s of Array.isArray(history) ? history : []) {
    const entry = s?.w?.[id]
    if (!entry || entry.pct == null || !s.at || s.at < from) continue
    out.push({ t: s.at, pct: Number(entry.pct), used: entry.used ?? null })
  }
  return out
}

/** Window ids present anywhere in the history, most recently seen first. */
export function knownWindows(history) {
  const seen = new Map()
  for (const s of Array.isArray(history) ? history : []) {
    for (const id of Object.keys(s?.w || {})) seen.set(id, s.at)
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/**
 * Everything the UI needs per window, derived from history alone so it works
 * whether or not anything ran on this machine.
 */
export function summarizeHistory(history, windows, now = Date.now(), sinceMs = 24 * HOUR) {
  const out = {}
  for (const win of Array.isArray(windows) ? windows : []) {
    if (!win?.id) continue
    const rate = burnRate(history, win.id, now)
    out[win.id] = {
      series: seriesFor(history, win.id, sinceMs, now),
      rate,
      projection: projectExhaustion(win, rate, now)
    }
  }
  return out
}
