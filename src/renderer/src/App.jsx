import React, { useEffect, useState, useCallback } from 'react'
import Overview from './components/Overview.jsx'
import ProviderView from './components/ProviderView.jsx'
import Settings from './components/Settings.jsx'
import RangePicker from './components/RangePicker.jsx'
import { fmtAgo, usageColor, rangeLabel } from './format.js'

export default function App() {
  const [snapshots, setSnapshots] = useState([])
  const [updatedAt, setUpdatedAt] = useState(null)
  const [view, setView] = useState('overview')
  const [settings, setSettings] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [range, setRange] = useState(null) // { spec, resolved }

  const apply = useCallback((payload) => {
    if (!payload) return
    setSnapshots(payload.snapshots || [])
    setUpdatedAt(payload.at || Date.now())
    if (payload.range) setRange(payload.range)
  }, [])

  const applyRange = async (spec) => {
    setRefreshing(true)
    try {
      apply(await window.api.setRange(spec))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    window.api.getSnapshot().then(apply)
    window.api.getSettings().then(setSettings)
    const off = window.api.onUpdate(apply)
    return off
  }, [apply])

  const refresh = async () => {
    setRefreshing(true)
    try { apply(await window.api.refresh()) } finally { setRefreshing(false) }
  }

  const changeSettings = async (patch) => {
    const next = await window.api.setSettings(patch)
    setSettings(next)
  }

  const tabs = [{ id: 'overview', label: '◎', name: 'Overview' }]
    .concat(snapshots.map((s) => ({ id: s.id, label: s.name.slice(0, 2).toUpperCase(), name: s.name, color: s.color, snap: s })))
    .concat([{ id: 'settings', label: '⚙', name: 'Settings' }])

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand"><div className="brand-mark" /> FrankToken</div>
        <RangePicker spec={range?.spec} resolved={range?.resolved} onApply={applyRange} />
        <div className="grow" />
        <span className="updated">{updatedAt ? `updated ${fmtAgo(updatedAt)}` : 'loading…'}</span>
        <div className="ctrls">
          <button className="iconbtn" title="Refresh" onClick={refresh} style={{ opacity: refreshing ? 0.5 : 1 }}>⟳</button>
          <button className="iconbtn" title="Minimize" onClick={() => window.api.minimize()}>—</button>
          <button className="iconbtn" title="Hide to tray" onClick={() => window.api.hide()}>▾</button>
          <button className="iconbtn danger" title="Quit" onClick={() => window.api.quit()}>✕</button>
        </div>
      </div>

      <div className="body">
        <div className="rail">
          {tabs.map((t) => {
            const w = t.snap?.windows?.[0]
            const active = view === t.id
            return (
              <div
                key={t.id}
                className={`dot ${active ? 'active' : ''}`}
                style={{ color: t.color || '#6ea8fe' }}
                title={t.name}
                onClick={() => setView(t.id)}
              >
                {t.label}
                {w && w.usedPercent != null ? (
                  <span className="badge" style={{ color: usageColor(w.usedPercent) }}>
                    {Math.round(w.usedPercent)}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>

        <div className="main">
          {view === 'overview' && <Overview snapshots={snapshots} onPick={setView} rangeLbl={rangeLabel(range?.spec, range?.resolved)} />}
          {view === 'settings' && <Settings settings={settings} onChange={changeSettings} />}
          {snapshots.filter((s) => s.id === view).map((s) => <ProviderView key={s.id} s={s} rangeLbl={rangeLabel(range?.spec, range?.resolved)} />)}
          {snapshots.length === 0 && view === 'overview' && (
            <div className="empty">Scanning local CLI sessions…</div>
          )}
        </div>
      </div>

      <div className="foot">
        <span><b>On-device</b> · parses ~/.codex &amp; ~/.claude locally</span>
        <span><b>Costs &amp; Claude windows are estimates</b></span>
      </div>
    </div>
  )
}
