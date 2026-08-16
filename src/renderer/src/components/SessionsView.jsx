import React, { useMemo, useState } from 'react'
import { SessionSpark, CompareTimelines, MetricBars, COMPARE_COLORS } from './Charts.jsx'
import { fmtTokens, fmtUsd, fmtDuration, fmtTime } from '../format.js'

const COLUMNS = [
  { id: 'title', label: 'Session', sort: (s) => s.title || '' },
  { id: 'provider', label: 'Provider', sort: (s) => s.providerName || '' },
  { id: 'start', label: 'Start', sort: (s) => s.start },
  { id: 'durationMs', label: 'Length', sort: (s) => s.durationMs },
  { id: 'events', label: 'Calls', sort: (s) => s.events },
  { id: 'input', label: 'Input', sort: (s) => s.tokens.input },
  { id: 'output', label: 'Output', sort: (s) => s.tokens.output },
  { id: 'total', label: 'Tokens', sort: (s) => s.tokens.total },
  { id: 'usd', label: 'Cost', sort: (s) => s.usd }
]

function ModelSplit({ session }) {
  const total = session.tokens.total || 1
  return (
    <div className="modelsplit">
      {session.models.map((m, i) => (
        <div key={m.model} className="modelsplit-row">
          <span className="dotkey" style={{ background: COMPARE_COLORS[i % COMPARE_COLORS.length] }} />
          <span className="modelsplit-name" title={m.model}>{m.model}</span>
          <span className="modelsplit-val">{fmtTokens(m.total)} · {fmtUsd(m.usd)}</span>
          <div className="track" style={{ flexBasis: '100%' }}>
            <div
              className="fill"
              style={{ width: `${Math.max(2, (m.total / total) * 100)}%`, background: COMPARE_COLORS[i % COMPARE_COLORS.length] }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function SessionFlyout({ session, onClose }) {
  if (!session) return null
  const pace = session.durationMs > 60_000 ? session.tokens.total / (session.durationMs / 60000) : null
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="flyout" role="dialog" aria-label="Session detail">
        <div className="flyout-head">
          <div>
            <div className="flyout-title">{session.title || session.id}</div>
            <div className="sub">
              <span className="pill" style={{ color: session.color, borderColor: session.color }}>{session.providerName}</span>{' '}
              {session.surface ? <span className="pill">{session.surface}</span> : null}{' '}
              {session.branch ? <span className="pill">⎇ {session.branch}</span> : null}
            </div>
          </div>
          <button className="iconbtn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="kpis" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div className="kpi"><div className="k">Started</div><div className="v">{fmtTime(session.start)}</div></div>
          <div className="kpi"><div className="k">Ended</div><div className="v">{fmtTime(session.end)}</div></div>
          <div className="kpi"><div className="k">Length</div><div className="v">{fmtDuration(session.durationMs)}</div></div>
          <div className="kpi"><div className="k">Model calls</div><div className="v">{session.events}</div></div>
          <div className="kpi"><div className="k">Tokens</div><div className="v">{fmtTokens(session.tokens.total)}</div></div>
          <div className="kpi"><div className="k">Cost (est.)</div><div className="v" style={{ color: '#34d399' }}>{fmtUsd(session.usd)}</div></div>
          <div className="kpi"><div className="k">Uncached input</div><div className="v">{fmtTokens(session.tokens.input)}</div></div>
          <div className="kpi"><div className="k">Cache read</div><div className="v">{fmtTokens(session.tokens.cachedInput)}</div></div>
          <div className="kpi"><div className="k">Output</div><div className="v">{fmtTokens(session.tokens.output)}</div></div>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <h3>Cumulative tokens over the session</h3>
          <SessionSpark timeline={session.timeline} color={session.color} />
          {pace ? <div className="sub">≈ {fmtTokens(Math.round(pace))} tokens/min over {fmtDuration(session.durationMs)}</div> : null}
        </div>

        {session.models.length > 0 && (
          <div className="card" style={{ marginTop: 12 }}>
            <h3>Models in this session</h3>
            <ModelSplit session={session} />
          </div>
        )}
        {session.cwd ? <div className="sub" style={{ marginTop: 10 }}>Workspace: {session.cwd}</div> : null}
      </div>
    </>
  )
}

function CompareOverlay({ sessions, onClose }) {
  if (sessions.length < 2) return null
  const series = sessions.map((s, i) => ({
    id: `s${i}`,
    label: `${s.title || s.id} · ${fmtTime(s.start)}`,
    color: COMPARE_COLORS[i % COMPARE_COLORS.length],
    timeline: s.timeline
  }))
  const rows = (fn) => sessions.map((s, i) => ({ label: s.title || String(s.id).slice(0, 14), value: fn(s), color: COMPARE_COLORS[i % COMPARE_COLORS.length] }))
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="overlay" role="dialog" aria-label="Compare sessions">
        <div className="flyout-head">
          <div className="flyout-title">Comparing {sessions.length} sessions</div>
          <button className="iconbtn" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="legendrow">
          {series.map((s) => (
            <span key={s.id} className="legenditem"><span className="dotkey" style={{ background: s.color }} />{s.label}</span>
          ))}
        </div>
        <div className="card" style={{ marginTop: 10 }}>
          <h3>Token burn, minute by minute (aligned to each session's start)</h3>
          <CompareTimelines series={series} />
        </div>
        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <div className="card"><h3>Total tokens</h3><MetricBars rows={rows((s) => s.tokens.total)} /></div>
          <div className="card"><h3>Est. cost (USD)</h3><MetricBars rows={rows((s) => s.usd)} fmt={fmtUsd} /></div>
          <div className="card"><h3>Length (minutes)</h3><MetricBars rows={rows((s) => Math.round(s.durationMs / 60000))} fmt={(v) => `${v}m`} /></div>
          <div className="card"><h3>Tokens per minute</h3><MetricBars rows={rows((s) => (s.durationMs > 60000 ? Math.round(s.tokens.total / (s.durationMs / 60000)) : s.tokens.total))} /></div>
        </div>
      </div>
    </>
  )
}

export default function SessionsView({ snapshots, rangeLbl = '30D' }) {
  const [providerFilter, setProviderFilter] = useState(null)
  const [surfaceFilter, setSurfaceFilter] = useState(null)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState('start')
  const [sortDir, setSortDir] = useState(-1)
  const [openSession, setOpenSession] = useState(null)
  const [picked, setPicked] = useState([]) // session ids selected for compare
  const [comparing, setComparing] = useState(false)

  const all = useMemo(() => snapshots.flatMap((s) => s.sessions || []), [snapshots])
  const surfaces = useMemo(() => [...new Set(all.map((s) => s.surface).filter(Boolean))], [all])
  const providers = useMemo(
    () => snapshots.filter((s) => (s.sessions || []).length > 0).map((s) => ({ id: s.id, name: s.name, color: s.color })),
    [snapshots]
  )

  const shown = useMemo(() => {
    const col = COLUMNS.find((c) => c.id === sortBy) || COLUMNS[2]
    const q = query.trim().toLowerCase()
    return all
      .filter((s) => !providerFilter || s.provider === providerFilter)
      .filter((s) => !surfaceFilter || s.surface === surfaceFilter)
      .filter((s) => !q || `${s.title} ${s.id} ${s.model} ${s.surface}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const av = col.sort(a)
        const bv = col.sort(b)
        return (av > bv ? 1 : av < bv ? -1 : 0) * sortDir
      })
  }, [all, providerFilter, surfaceFilter, query, sortBy, sortDir])

  const pickedSessions = picked.map((id) => all.find((s) => s.id === id)).filter(Boolean)

  const toggleSort = (id) => {
    if (sortBy === id) setSortDir(-sortDir)
    else {
      setSortBy(id)
      setSortDir(-1)
    }
  }
  const togglePick = (id) => {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 4 ? p : [...p, id]))
  }

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="section-title">
        <h2>Sessions</h2>
        <span className="pill">{shown.length} in {rangeLbl}</span>
        <span className="pill est">costs estimated</span>
      </div>

      <div className="filterrow">
        {providers.map((p) => (
          <button
            key={p.id}
            className={`chip ${providerFilter === p.id ? 'on' : ''}`}
            style={providerFilter === p.id ? { borderColor: p.color, color: p.color } : null}
            onClick={() => setProviderFilter(providerFilter === p.id ? null : p.id)}
          >
            <span className="dotkey" style={{ background: p.color }} />
            {p.name}
          </button>
        ))}
        {surfaces.map((sf) => (
          <button key={sf} className={`chip ${surfaceFilter === sf ? 'on' : ''}`} onClick={() => setSurfaceFilter(surfaceFilter === sf ? null : sf)}>
            {sf}
          </button>
        ))}
        <input className="search" placeholder="Search sessions…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {shown.length === 0 ? (
        <div className="card empty">No sessions in this range. Widen the range, or start a Claude/Codex session on this machine.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table className="stable">
            <thead>
              <tr>
                <th style={{ width: 30 }} title="Pick up to 4 sessions to compare">⇄</th>
                {COLUMNS.map((c) => (
                  <th key={c.id} onClick={() => toggleSort(c.id)} className={sortBy === c.id ? 'sorted' : ''}>
                    {c.label}
                    {sortBy === c.id ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={`${s.provider}:${s.id}`} onClick={() => setOpenSession(s)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={picked.includes(s.id)} onChange={() => togglePick(s.id)} />
                  </td>
                  <td className="tcell-title">
                    <span className="dotkey" style={{ background: s.color }} />
                    <span className="ttl">{s.title || s.id}</span>
                    {s.surface ? <span className="mini">{s.surface}</span> : null}
                  </td>
                  <td>{s.providerName}</td>
                  <td>{fmtTime(s.start)}</td>
                  <td>{fmtDuration(s.durationMs)}</td>
                  <td>{s.events}</td>
                  <td>{fmtTokens(s.tokens.input)}</td>
                  <td>{fmtTokens(s.tokens.output)}</td>
                  <td className="strong">{fmtTokens(s.tokens.total)}</td>
                  <td className="strong" style={{ color: '#34d399' }}>{fmtUsd(s.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picked.length >= 2 && (
        <div className="comparebar">
          <span>{picked.length} sessions selected</span>
          <button className="rp-apply" style={{ marginTop: 0, width: 'auto', padding: '7px 14px' }} onClick={() => setComparing(true)}>
            Compare
          </button>
          <button className="chip" onClick={() => setPicked([])}>Clear</button>
        </div>
      )}

      {openSession && <SessionFlyout session={openSession} onClose={() => setOpenSession(null)} />}
      {comparing && <CompareOverlay sessions={pickedSessions} onClose={() => setComparing(false)} />}
    </div>
  )
}
