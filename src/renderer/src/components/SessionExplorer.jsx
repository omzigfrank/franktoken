import React, { useMemo, useState } from 'react'
import { SessionScatter, TokenStackedBars } from './Charts.jsx'
import { fmtDateTime, fmtDuration, fmtTokens, fmtUsd } from '../format.js'

function TokenMeter({ tokens }) {
  const parts = [
    ['input', tokens.input, '#7c6cff'],
    ['cache read', tokens.cachedInput, '#24d3ee'],
    ['cache write', tokens.cacheWrite, '#f7b955'],
    ['output', tokens.output, '#ff6b9a'],
    ['reasoning', tokens.reasoning, '#9af57f']
  ].filter(([, value]) => value > 0)
  const total = Math.max(1, parts.reduce((sum, [, value]) => sum + value, 0))
  return (
    <div className="token-meter-wrap">
      <div className="token-meter">
        {parts.map(([label, value, color]) => (
          <span key={label} title={`${label}: ${fmtTokens(value)}`} style={{ width: `${(value / total) * 100}%`, background: color }} />
        ))}
      </div>
      <div className="token-legend">
        {parts.map(([label, value, color]) => <span key={label}><i style={{ background: color }} />{label} {fmtTokens(value)}</span>)}
      </div>
    </div>
  )
}

function SessionDrawer({ session, onClose }) {
  if (!session) return null
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <div className="eyebrow">SESSION FORENSICS</div>
            <h2>{session.title}</h2>
            <p>{session.product} · {session.sourceLabel}</p>
            <code className="drawer-id">{session.id}</code>
          </div>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="drawer-stats">
          <div><span>Total tokens</span><strong>{fmtTokens(session.tokens.total)}</strong></div>
          <div><span>Cost</span><strong>{fmtUsd(session.costUsd)}</strong><small>{session.costKind}</small></div>
          <div><span>Duration</span><strong>{fmtDuration(session.durationMs)}</strong></div>
          <div><span>Requests</span><strong>{session.requestCount}</strong></div>
        </div>
        <TokenMeter tokens={session.tokens} />

        <div className="detail-grid">
          <div><span>Started</span><b>{fmtDateTime(session.startedAt)}</b></div>
          <div><span>Ended</span><b>{fmtDateTime(session.endedAt)}</b></div>
          <div><span>Models</span><b>{session.models.join(', ') || 'Unknown'}</b></div>
          <div><span>Freshness</span><b>{session.freshness}</b></div>
          {session.user && <div><span>User</span><b>{session.user}</b></div>}
          {session.device && <div><span>Device</span><b>{session.device}</b></div>}
        </div>

        <div className="request-head"><h3>Request timeline</h3><span>{session.requests.length} events</span></div>
        <div className="request-list">
          {session.requests.map((request, index) => (
            <div className="request-row" key={request.id || index}>
              <span className="request-seq">{String(index + 1).padStart(2, '0')}</span>
              <div className="request-main">
                <b>{request.model || 'Unknown model'}</b>
                <span>{fmtDateTime(request.timestamp)} · {fmtDuration(request.durationMs)}{request.aggregateCount > 1 ? ` · ${request.aggregateCount} requests` : ''}{request.tool ? ` · ${request.tool}` : ''}</span>
              </div>
              <div className="request-usage">
                <b>{fmtTokens(request.total)}</b>
                <span>{fmtUsd(request.costUsd)}</span>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}

export default function SessionExplorer({ sessions }) {
  const [query, setQuery] = useState('')
  const [product, setProduct] = useState('all')
  const [model, setModel] = useState('all')
  const [selected, setSelected] = useState(null)
  const [sort, setSort] = useState('startedAt')

  const products = [...new Set(sessions.map((session) => session.product).filter(Boolean))]
  const models = [...new Set(sessions.flatMap((session) => session.models || []).filter(Boolean))]
  const filtered = useMemo(() => sessions
    .filter((session) => product === 'all' || session.product === product)
    .filter((session) => model === 'all' || session.models.includes(model))
    .filter((session) => !query || `${session.title} ${session.id} ${session.user || ''} ${session.device || ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => {
      if (sort === 'cost') return b.costUsd - a.costUsd
      if (sort === 'tokens') return b.tokens.total - a.tokens.total
      if (sort === 'duration') return b.durationMs - a.durationMs
      return b.startedAt - a.startedAt
    }), [sessions, product, model, query, sort])

  const chartData = filtered.slice(0, 120).map((session) => ({
    ...session,
    durationMinutes: Math.max(0.02, session.durationMs / 60_000),
    totalTokens: session.tokens.total,
    label: session.title
  }))

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><div className="eyebrow">DEEP DIVE</div><h1>Session explorer</h1><p>Every trace, turn, model and dollar—queryable down to the request.</p></div>
        <span className="count-chip">{filtered.length} sessions</span>
      </div>

      <div className="filterbar glass-card">
        <input className="search-input" placeholder="Search session, ID, or user…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select value={product} onChange={(event) => setProduct(event.target.value)}><option value="all">All products</option>{products.map((value) => <option key={value}>{value}</option>)}</select>
        <select value={model} onChange={(event) => setModel(event.target.value)}><option value="all">All models</option>{models.map((value) => <option key={value}>{value}</option>)}</select>
        <select value={sort} onChange={(event) => setSort(event.target.value)}><option value="startedAt">Newest first</option><option value="tokens">Most tokens</option><option value="cost">Highest cost</option><option value="duration">Longest</option></select>
      </div>

      <div className="grid cols-2 session-viz-grid">
        <div className="glass-card chart-shell"><div className="card-heading"><div><span>Duration × consumption</span><b>Session gravity map</b></div><small>Bubble size = cost</small></div><SessionScatter data={chartData} onPick={setSelected} /></div>
        <div className="glass-card chart-shell"><div className="card-heading"><div><span>Token composition</span><b>Heaviest sessions</b></div><small>Top 10</small></div><TokenStackedBars data={filtered.slice(0, 10)} /></div>
      </div>

      <div className="glass-card session-table-card">
        <div className="session-table-head"><span>Session / product</span><span>Model</span><span>Started</span><span>Duration</span><span>Requests</span><span>Tokens</span><span>Cost</span></div>
        <div className="session-table-body">
          {filtered.map((session) => (
            <button className="session-table-row" key={`${session.provider}:${session.id}`} onClick={() => setSelected(session)}>
              <span className="session-name"><i className={`source-dot ${session.provider}`} /><b>{session.title}</b><small>{session.product} · {session.sourceType}</small></span>
              <span className="model-cell">{session.primaryModel || 'Unknown'}</span>
              <span>{fmtDateTime(session.startedAt)}</span><span>{fmtDuration(session.durationMs)}</span><span>{session.requestCount}</span><span className="mono bright">{fmtTokens(session.tokens.total)}</span><span className="mono money">{fmtUsd(session.costUsd)}</span>
            </button>
          ))}
          {!filtered.length && <div className="empty-state">No sessions match these filters.</div>}
        </div>
      </div>
      <SessionDrawer session={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
