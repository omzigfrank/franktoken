import React, { useEffect, useMemo, useState, useCallback } from 'react'
import Overview from './components/Overview.jsx'
import ProviderView from './components/ProviderView.jsx'
import SessionExplorer from './components/SessionExplorer.jsx'
import ModelCompare from './components/ModelCompare.jsx'
import Sources from './components/Sources.jsx'
import Settings from './components/Settings.jsx'
import RangePicker from './components/RangePicker.jsx'
import { fmtAgo, rangeLabel } from './format.js'
import { dataApi, isDesktop } from './data-api.js'

const nav = [
  { id: 'overview', icon: '⌁', label: 'Overview' },
  { id: 'sessions', icon: '◫', label: 'Sessions' },
  { id: 'compare', icon: '⌘', label: 'Compare' },
  { id: 'sources', icon: '⊛', label: 'Sources' },
  { id: 'settings', icon: '⚙', label: 'Settings' }
]

export default function App() {
  const [snapshots, setSnapshots] = useState([])
  const [updatedAt, setUpdatedAt] = useState(null)
  const [view, setView] = useState('overview')
  const [settings, setSettings] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [range, setRange] = useState(null)

  const sessions = useMemo(() => snapshots.flatMap((snapshot) => snapshot.sessions || []), [snapshots])
  const apply = useCallback((payload) => {
    if (!payload) return
    setSnapshots(payload.snapshots || [])
    setUpdatedAt(payload.at || Date.now())
    if (payload.range) setRange(payload.range)
  }, [])

  const applyRange = async (spec) => {
    setRefreshing(true)
    try { apply(await dataApi.setRange(spec)) } finally { setRefreshing(false) }
  }

  useEffect(() => {
    dataApi.getSnapshot().then(apply)
    dataApi.getSettings().then(setSettings)
    return dataApi.onUpdate(apply)
  }, [apply])

  const refresh = async () => {
    setRefreshing(true)
    try { apply(await dataApi.refresh()) } finally { setRefreshing(false) }
  }
  const changeSettings = async (patch) => setSettings(await dataApi.setSettings(patch))
  const label = rangeLabel(range?.spec, range?.resolved)

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand"><div className="brand-mark"><i /></div><span>FRANK<b>TOKEN</b></span></div>
        <div className="title-divider" />
        <RangePicker spec={range?.spec} resolved={range?.resolved} onApply={applyRange} />
        <div className="grow" />
        <span className="sync-badge"><i className="live-pulse" />{updatedAt ? `synced ${fmtAgo(updatedAt)}` : 'connecting'}</span>
        <div className="ctrls"><button className="iconbtn" title="Refresh" onClick={refresh} disabled={refreshing}>↻</button>{isDesktop && <><button className="iconbtn" title="Minimize" onClick={() => dataApi.minimize()}>—</button><button className="iconbtn" title="Hide to tray" onClick={() => dataApi.hide()}>⌄</button><button className="iconbtn danger" title="Quit" onClick={() => dataApi.quit()}>×</button></>}</div>
      </header>

      <div className="body">
        <aside className="side-nav">
          <div className="nav-label">INTELLIGENCE</div>
          {nav.filter((item) => isDesktop || item.id !== 'settings').map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><span>{item.icon}</span>{item.label}{item.id === 'sessions' && <em>{sessions.length}</em>}</button>)}
          <div className="nav-label source-label">PROVIDERS</div>
          {snapshots.map((snapshot) => <button key={snapshot.id} className={view === snapshot.id ? 'active provider' : 'provider'} onClick={() => setView(snapshot.id)}><i style={{ background: snapshot.color }} />{snapshot.name}<em className={snapshot.available ? 'up' : 'down'} /></button>)}
          <div className="nav-spacer" />
          <div className="nav-hub"><span className="hub-orb" /><div><b>FrankToken Hub</b><small>{isDesktop ? (settings?.hubUrl ? 'Local + remote' : 'Local collector') : 'Live shared report'}</small></div></div>
        </aside>

        <main className="main">
          {view === 'overview' && <Overview snapshots={snapshots} sessions={sessions} onPick={setView} rangeLbl={label} />}
          {view === 'sessions' && <SessionExplorer sessions={sessions} />}
          {view === 'compare' && <ModelCompare sessions={sessions} />}
          {view === 'sources' && <Sources snapshots={snapshots} sessions={sessions} />}
          {view === 'settings' && <Settings settings={settings} onChange={changeSettings} />}
          {snapshots.filter((snapshot) => snapshot.id === view).map((snapshot) => <ProviderView key={snapshot.id} s={snapshot} rangeLbl={label} />)}
          {!snapshots.length && view === 'overview' && <div className="empty-state">Building the intelligence fabric…</div>}
        </main>
      </div>
    </div>
  )
}
