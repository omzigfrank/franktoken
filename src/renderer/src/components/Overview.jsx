import React from 'react'
import Ring from './Ring.jsx'
import { TokenArea } from './Charts.jsx'
import { fmtTokens, fmtUsd, fmtReset } from '../format.js'

export default function Overview({ snapshots, onPick, rangeLbl = '30D' }) {
  const live = snapshots.filter((s) => s.available)
  const totalTokens = live.reduce((a, s) => a + s.tokens.total, 0)
  const totalCost = live.reduce((a, s) => a + s.cost.total, 0)
  const todayCost = live.reduce((a, s) => a + s.cost.today, 0)
  const peak = Math.max(0, ...live.flatMap((s) => s.windows.map((w) => w.usedPercent)).filter((p) => p != null))

  // merge token series by date
  const byDate = new Map()
  for (const s of live)
    for (const p of s.series.tokensByDay)
      byDate.set(p.date, (byDate.get(p.date) || 0) + p.total)
  const merged = [...byDate.entries()].map(([date, total]) => ({ date, total })).sort((a, b) => a.date.localeCompare(b.date))

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="section-title"><h2>Overview</h2><span className="pill">{live.length} active providers</span><span className="pill live">{rangeLbl}</span></div>

      <div className="grid cols-3">
        <div className="card"><h3>Total tokens ({rangeLbl})</h3><div className="big">{fmtTokens(totalTokens)}</div><div className="sub">across all providers</div></div>
        <div className="card"><h3>Est. spend ({rangeLbl})</h3><div className="big" style={{ color: '#34d399' }}>{fmtUsd(totalCost)}</div><div className="sub">{fmtUsd(todayCost)} today</div></div>
        <div className="card">
          <h3>Peak window</h3>
          <div className="ring-wrap"><Ring percent={peak} size={70} stroke={8} /><div className="sub">highest active limit</div></div>
        </div>
      </div>

      <div className="grid cols-2">
        {snapshots.map((s) => {
          const w = s.windows[0]
          return (
            <div className="card" key={s.id} style={{ cursor: 'pointer' }} onClick={() => onPick(s.id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Ring percent={w ? w.usedPercent : null} size={64} stroke={8} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: s.color, fontSize: 15 }}>{s.name}</div>
                  {s.available ? (
                    <>
                      <div className="sub">{fmtTokens(s.tokens.total)} tok · {fmtUsd(s.cost.total)} est.</div>
                      <div className="sub">
                        {w
                          ? w.usedPercent == null
                            ? `${w.label}: awaiting live data`
                            : `${w.label}: resets in ${fmtReset(w.resetsAt)}`
                          : 'no window data'}
                      </div>
                    </>
                  ) : (
                    <div className="sub" style={{ color: '#f87171' }}>not detected</div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="card chart-card">
        <div className="chart-head"><h3>Combined tokens / day</h3></div>
        {merged.length ? <TokenArea data={merged} color="#6ea8fe" /> : <div className="empty">No data yet.</div>}
      </div>
    </div>
  )
}
