export function fmtTokens(n) {
  if (n == null) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

export function fmtUsd(n) {
  if (n == null) return '—'
  if (n >= 1000) return '$' + n.toFixed(0)
  if (n >= 1) return '$' + n.toFixed(2)
  return '$' + n.toFixed(3)
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '<1s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function fmtDateTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'
  })
}

export function fmtReset(ms) {
  if (!ms) return '—'
  const diff = ms - Date.now()
  if (diff <= 0) return 'now'
  const d = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function fmtAgo(ms) {
  if (!ms) return 'never'
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function rangeLabel(spec, resolved) {
  if (spec && spec.preset && spec.preset !== 'custom') return spec.preset.toUpperCase()
  if (resolved) {
    const f = new Date(resolved.from)
    const t = new Date(resolved.to)
    const opt = { month: 'short', day: 'numeric' }
    const sameYear = f.getFullYear() === t.getFullYear()
    const fmt = (d) => d.toLocaleDateString(undefined, opt)
    return `${fmt(f)} – ${fmt(t)}${sameYear ? '' : ' ' + t.getFullYear()}`
  }
  return '30D'
}

export function usageColor(pct) {
  if (pct >= 90) return '#f87171'
  if (pct >= 70) return '#fbbf24'
  return '#34d399'
}
