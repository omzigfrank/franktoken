import AccountWide from './AccountWide.jsx'
import React from 'react'
import { TokenArea } from './Charts.jsx'
import { fmtAgo, fmtDuration, fmtTokens, fmtUsd } from '../format.js'

function Delta({ children, tone = 'good' }) {
  return <span className={`delta ${tone}`}>{children}</span>
}

export default function Overview({ snapshots, sessions, onPick, rangeLbl = '30D', settings = null }) {
  const live = snapshots.filter((snapshot) => snapshot.available)
  const totalTokens = live.reduce((sum, snapshot) => sum + snapshot.tokens.total, 0)
  const totalCost = live.reduce((sum, snapshot) => sum + snapshot.cost.total, 0)
  const requestCount = sessions.reduce((sum, session) => sum + session.requestCount, 0)
  const activeModels = new Set(sessions.flatMap((session) => session.models || [])).size
  const cacheTokens = live.reduce((sum, snapshot) => sum + snapshot.tokens.cachedInput, 0)
  const cacheRate = totalTokens ? (cacheTokens / totalTokens) * 100 : 0
  // Opt-in from Settings: what the same range would have cost with no prompt
  // cache. Both figures come from the same price table so the delta is sound.
  const showNoCache = !!settings?.showWithoutCache
  const noCacheCost = live.reduce((sum, s) => sum + (s.noCache?.cost?.total || 0), 0)
  const cachedBaseline = live.reduce((sum, s) => sum + (s.noCache?.baseline?.total || 0), 0)
  const cacheSaved = noCacheCost - cachedBaseline

  const byDate = new Map()
  for (const snapshot of live) {
    for (const point of snapshot.series.tokensByDay) {
      byDate.set(point.date, (byDate.get(point.date) || 0) + point.total)
    }
  }
  const merged = [...byDate.entries()].map(([date, total]) => ({ date, total })).sort((a, b) => a.date.localeCompare(b.date))
  const heavy = [...sessions].sort((a, b) => b.tokens.total - a.tokens.total).slice(0, 5)
  const recent = [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, 6)
  const maxHeavy = Math.max(1, ...heavy.map((session) => session.tokens.total))

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow"><i className="live-pulse" /> LIVE INTELLIGENCE FABRIC</div>
          <h1>Every token.<br /><span>Every model.</span> One truth.</h1>
          <p>Trace AI consumption from individual requests to multi-model portfolio spend—without flattening away the details.</p>
          <div className="hero-chips"><span>{rangeLbl} window</span><span>{live.length} active sources</span><span>{sessions.length} traceable sessions</span></div>
        </div>
        <div className="orbit-wrap" aria-hidden="true">
          <div className="orbit orbit-one"><i /></div><div className="orbit orbit-two"><i /></div><div className="orbit orbit-three"><i /></div>
          <div className="orbit-core"><span>{fmtTokens(totalTokens)}</span><small>TOKENS</small></div>
        </div>
      </section>

      {snapshots.filter((s) => (s.windows || []).some((w) => !w.estimated && w.usedPercent != null))
        .map((s) => <AccountWide key={s.id} snapshot={s} />)}

      <section className="kpi-strip">
        <div className="glass-card metric-card violet"><span>Token volume</span><strong>{fmtTokens(totalTokens)}</strong><small>input + cache + output</small><Delta>{requestCount} requests</Delta></div>
        <div className="glass-card metric-card cyan"><span>USD consumption</span><strong>{fmtUsd(totalCost)}</strong><small>{live.some((snapshot) => snapshot.cost.estimated) ? 'estimated where billing is unavailable' : 'provider billed'}</small><Delta tone="cyan">{fmtUsd(totalCost / Math.max(1, sessions.length))} / session</Delta></div>
        <div className="glass-card metric-card pink"><span>Cache leverage</span><strong>{showNoCache && cacheSaved > 0 ? fmtUsd(cacheSaved) : `${cacheRate.toFixed(1)}%`}</strong><small>{showNoCache && cacheSaved > 0 ? `saved vs ${fmtUsd(noCacheCost)} with no cache` : `${fmtTokens(cacheTokens)} cache-read tokens`}</small><Delta tone="pink">{showNoCache && cacheSaved > 0 ? `${cacheRate.toFixed(1)}% of tokens cache-read` : 'context reused'}</Delta></div>
        <div className="glass-card metric-card lime"><span>Model surface</span><strong>{activeModels}</strong><small>models observed in range</small><Delta tone="lime">{live.length} products live</Delta></div>
      </section>

      <section className="grid cols-2 overview-viz">
        <div className="glass-card chart-shell overview-chart">
          <div className="card-heading"><div><span>Consumption pulse</span><b>Combined tokens over time</b></div><small>{rangeLbl}</small></div>
          {merged.length ? <TokenArea data={merged} color="#7c6cff" /> : <div className="empty-state">Waiting for token signals.</div>}
        </div>
        <div className="glass-card heavy-card">
          <div className="card-heading"><div><span>Top gravity wells</span><b>Heaviest sessions</b></div><small>click Sessions for detail</small></div>
          <div className="heavy-list">{heavy.map((session, index) => <div className="heavy-row" key={`${session.provider}:${session.id}`}><span className="heavy-rank">0{index + 1}</span><div className="heavy-name"><b>{session.title}</b><small>{session.primaryModel || 'Unknown model'} · {fmtDuration(session.durationMs)}</small><i style={{ width: `${(session.tokens.total / maxHeavy) * 100}%` }} /></div><div className="heavy-value"><b>{fmtTokens(session.tokens.total)}</b><small>{fmtUsd(session.costUsd)}</small></div></div>)}</div>
        </div>
      </section>

      <section className="grid cols-2 lower-grid">
        <div className="glass-card">
          <div className="card-heading"><div><span>Source health</span><b>Provider fabric</b></div><small>freshness-aware</small></div>
          <div className="provider-stack">{snapshots.map((snapshot) => <button key={snapshot.id} onClick={() => onPick(snapshot.id)}><i style={{ background: snapshot.color }} /><span><b>{snapshot.name}</b><small>{snapshot.coverage?.detail || 'aggregate'} · {snapshot.coverage?.freshness || 'unknown'}</small></span><strong>{fmtTokens(snapshot.tokens.total)}</strong><em className={snapshot.available ? 'online' : 'offline'}>{snapshot.available ? 'ONLINE' : 'OFFLINE'}</em></button>)}</div>
        </div>
        <div className="glass-card">
          <div className="card-heading"><div><span>Live tape</span><b>Newest sessions</b></div><small>updated {fmtAgo(Date.now())}</small></div>
          <div className="activity-tape">{recent.map((session) => <div key={`${session.provider}:${session.id}`}><i className={`source-dot ${session.provider}`} /><span><b>{session.title}</b><small>{session.product} · {session.requestCount} requests</small></span><strong>{fmtTokens(session.tokens.total)}</strong><time>{fmtAgo(session.startedAt)}</time></div>)}</div>
        </div>
      </section>
    </div>
  )
}
