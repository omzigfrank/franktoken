import React, { useState, useEffect } from 'react'

const PRESETS = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' }
]

// epoch ms -> value for <input type="datetime-local"> (local time, no tz suffix)
function toLocalInput(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(v) {
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : ms
}

export default function RangePicker({ spec, resolved, onApply }) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    if (resolved) {
      setFrom(toLocalInput(resolved.from))
      setTo(toLocalInput(resolved.to))
    }
  }, [resolved])

  const active = spec?.preset || '30d'

  return (
    <div className="rangepicker" style={{ WebkitAppRegion: 'no-drag' }}>
      {PRESETS.map((p) => (
        <button
          key={p.id}
          className={`rp-btn ${active === p.id ? 'on' : ''}`}
          onClick={() => onApply({ preset: p.id, granularity: 'auto' })}
        >
          {p.label}
        </button>
      ))}
      <button
        className={`rp-btn ${active === 'custom' ? 'on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Custom range"
      >
        Custom ▾
      </button>

      {open && (
        <div className="rp-pop" onMouseLeave={() => setOpen(false)}>
          <label>From</label>
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label>To</label>
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          <div className="rp-gran">
            {['auto', 'hour', 'day'].map((g) => (
              <button
                key={g}
                className={`rp-btn ${(spec?.granularity || 'auto') === g ? 'on' : ''}`}
                onClick={() =>
                  onApply({
                    preset: 'custom',
                    from: fromLocalInput(from),
                    to: fromLocalInput(to),
                    granularity: g
                  })
                }
              >
                {g}
              </button>
            ))}
          </div>
          <button
            className="rp-apply"
            onClick={() => {
              const f = fromLocalInput(from)
              const t = fromLocalInput(to)
              if (f == null || t == null || f >= t) return
              onApply({ preset: 'custom', from: f, to: t, granularity: spec?.granularity || 'auto' })
              setOpen(false)
            }}
          >
            Apply range
          </button>
        </div>
      )}
    </div>
  )
}
