import React, { useState } from 'react'
import { fmtReset, fmtTokens, usageColor } from '../format.js'

// Account-wide live statistics. Everything here is derived from the usage API
// and its recorded history, so it is populated regardless of which device or
// surface did the work — unlike the token/cost tiles, which can only ever
// describe local transcripts.

function fmtRate(perHour) {
  if (perHour == null) return null
  const v = Math.abs(perHour)
  if (v < 0.05) return 'flat'
  const sign = perHour > 0 ? '+' : '−'
  return `${sign}${v < 1 ? v.toFixed(2) : v.toFixed(1)} pts/hr`
}

function fmtHours(h) {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`
  return `${Math.round(h / 24)}d`
}

// Sparkline over the recorded percentages. Flat-line safe: a constant series
// would otherwise divide by a zero range and disappear.
function Spark({ series, color }) {
  if (!series || series.length < 2) return null
  const w = 220
  const h = 34
  const ts = series.map((p) => p.t)
  const t0 = Math.min(...ts)
  const t1 = Math.max(...ts)
  const span = t1 - t0 || 1
  // Percentages are inherently 0-100. Scaling to the series max would amplify
  // noise and make a window hovering at 52-55% look completely full.
  const pts = series.map((p) => {
    const x = ((p.t - t0) / span) * w
    const y = h - (Math.max(0, Math.min(100, p.pct)) / 100) * (h - 3) - 1.5
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg className="aw-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
      aria-label={`Trend over the recorded window, ${Math.round(series[series.length - 1].pct)} percent now`}>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.6" />
      <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={color} opacity="0.12" />
    </svg>
  )
}

export default function AccountWide({ snapshot }) {
  const [open, setOpen] = useState(true)
  const windows = (snapshot?.windows || []).filter((w) => !w.estimated && w.usedPercent != null)
  const stats = snapshot?.limitStats || {}
  const samples = snapshot?.limitSamples || 0

  if (windows.length === 0) return null

  return (
    <div className="card aw">
      <div className="aw-head">
        <div>
          <span>Account-wide · live</span>
          <h3>Every device and surface</h3>
        </div>
        <button className="rp-btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </div>
      <p className="aw-note">
        Read from your Claude account, so this is current no matter where the work happened —
        Claude.ai, Claude Code (CLI, web, desktop, IDE), Cowork, Design, the Office plugins.
        {samples > 1 ? ` Trend and burn rate from ${samples} recorded samples.` : ' Trend appears as samples accumulate.'}
      </p>

      <div className="aw-grid">
        {windows.map((w) => {
          const st = stats[w.id] || {}
          const color = usageColor(w.usedPercent)
          const rate = st.rate ? fmtRate(st.rate.perHour) : null
          const proj = st.projection
          return (
            <div className="aw-win" key={w.id}>
              <div className="aw-top">
                <span className="aw-label">{w.label}</span>
                <span className="aw-pct" style={{ color }}>{Math.round(w.usedPercent)}%</span>
              </div>
              <div className="track">
                <div
                  className="fill"
                  style={{
                    width: `${Math.max(2, Math.min(100, w.usedPercent))}%`,
                    background: `linear-gradient(90deg, ${color}, ${color}cc)`
                  }}
                />
              </div>
              <div className="aw-meta">
                {w.resetsAt ? `resets in ${fmtReset(w.resetsAt)}` : 'reset time not reported'}
                {w.usedTokens != null && (
                  <>
                    {' · '}
                    {fmtTokens(w.usedTokens)}
                    {w.budgetTokens != null ? ` / ${fmtTokens(w.budgetTokens)}` : ''} tok
                  </>
                )}
              </div>
              {open && (
                <>
                  <Spark series={st.series} color={color} />
                  <div className="aw-stats">
                    <div>
                      <em>Burn rate</em>
                      <b>{rate || 'not enough data yet'}</b>
                    </div>
                    <div>
                      <em>Reaches 100%</em>
                      <b>
                        {proj
                          ? `in ${fmtHours(proj.hoursLeft)}`
                          : rate === 'flat'
                            ? 'not at this rate'
                            : '—'}
                      </b>
                    </div>
                    {proj && proj.beforeReset != null && (
                      <div className={proj.beforeReset ? 'aw-warn' : 'aw-ok'}>
                        <em>Before reset?</em>
                        <b>{proj.beforeReset ? 'yes — may run out' : 'no — resets first'}</b>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      {snapshot?.windowsNote && <div className="aw-stale">{snapshot.windowsNote}</div>}
    </div>
  )
}
