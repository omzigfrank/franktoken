import React from 'react'
import Ring from './Ring.jsx'
import WindowBar from './WindowBar.jsx'
import { TokenArea, CostBars } from './Charts.jsx'
import { fmtTokens, fmtUsd, fmtAgo } from '../format.js'

function StatusPill({ s }) {
  if (!s.available) return <span className="pill off">Not detected</span>
  if (s.windowsUnknown) return <span className="pill off">Limits N/A</span>
  if (s.windowsStale) return <span className="pill est">Live · stale</span>
  const est = s.windows.some((w) => w.estimated)
  return est ? <span className="pill est">Estimated</span> : <span className="pill live">Live</span>
}

export default function ProviderView({ s, rangeLbl = '30D' }) {
  const primary = s.windows[0]
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="section-title">
        <h2 style={{ color: s.color }}>{s.name}</h2>
        <StatusPill s={s} />
        {(s.meta?.models?.length ? s.meta.models : s.meta?.model ? [s.meta.model] : []).map((m) => (
          <span key={m} className="pill">{m}</span>
        ))}
        <span className="pill">{s.meta?.sessions || 0} sessions · {fmtAgo(s.meta?.lastActivity)}</span>
      </div>

      {!s.available || s.error ? (
        <div className="card empty">{s.error || 'No data available.'}</div>
      ) : null}

      {s.available && (
        <>
          <div className="grid cols-2">
            <div className="card">
              <h3>Rate-limit windows</h3>
              <div className="ring-wrap" style={{ marginTop: 8 }}>
                <Ring percent={primary ? primary.usedPercent : null} caption={primary?.label || ''} />
                <div style={{ flex: 1 }}>
                  {s.windows.length === 0 ? (
                    <div className="sub">No window data reported.</div>
                  ) : (
                    s.windows.map((w) => <WindowBar key={w.id} w={w} />)
                  )}
                </div>
              </div>
              {s.windowsNote ? <div className="reset" style={{ marginTop: 10 }}>⚠ {s.windowsNote}</div> : null}
            </div>

            <div className="card">
              <h3>Tokens & cost</h3>
              <div className="kpis" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="kpi"><div className="k">Tokens ({rangeLbl})</div><div className="v">{fmtTokens(s.tokens.total)}</div></div>
                <div className="kpi"><div className="k">Output</div><div className="v">{fmtTokens(s.tokens.output)}</div></div>
                <div className="kpi"><div className="k">Cached input</div><div className="v">{fmtTokens(s.tokens.cachedInput)}</div></div>
                <div className="kpi"><div className="k">Reasoning</div><div className="v">{fmtTokens(s.tokens.reasoning)}</div></div>
                <div className="kpi"><div className="k">Cost today (est.)</div><div className="v" style={{ color: '#34d399' }}>{fmtUsd(s.cost.today)}</div></div>
                <div className="kpi"><div className="k">Cost {rangeLbl} (est.)</div><div className="v" style={{ color: '#34d399' }}>{fmtUsd(s.cost.total)}</div></div>
              </div>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card chart-card">
              <div className="chart-head"><h3>Tokens / day</h3></div>
              {s.series.tokensByDay.length ? (
                <TokenArea data={s.series.tokensByDay} color={s.color} />
              ) : <div className="empty">No daily data.</div>}
            </div>
            <div className="card chart-card">
              <div className="chart-head"><h3>Est. cost / day</h3></div>
              {s.series.costByDay.length ? (
                <CostBars data={s.series.costByDay} color={s.color} />
              ) : <div className="empty">No daily data.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
