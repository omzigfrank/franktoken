import React, { useMemo, useState } from 'react'
import { ModelBars, ModelRadar } from './Charts.jsx'
import { fmtTokens, fmtUsd } from '../format.js'

function aggregate(sessions) {
  const models = new Map()
  for (const session of sessions) {
    for (const request of session.requests || []) {
      const name = request.model || 'Unknown'
      const row = models.get(name) || { model: name, sessions: new Set(), requests: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, cost: 0 }
      row.sessions.add(`${session.provider}:${session.id}`)
      row.requests += request.aggregateCount || 1
      row.input += request.input || 0
      row.cachedInput += request.cachedInput || 0
      row.cacheWrite += request.cacheWrite || 0
      row.output += request.output || 0
      row.reasoning += request.reasoning || 0
      row.total += request.total || 0
      row.cost += request.costUsd || 0
      models.set(name, row)
    }
  }
  return [...models.values()].map((row) => ({ ...row, sessions: row.sessions.size, cacheRate: row.total ? (row.cachedInput / row.total) * 100 : 0, outputRate: row.total ? (row.output / row.total) * 100 : 0 })).sort((a, b) => b.total - a.total)
}

export default function ModelCompare({ sessions }) {
  const rows = useMemo(() => aggregate(sessions), [sessions])
  const [picked, setPicked] = useState([])
  const compared = picked.length ? rows.filter((row) => picked.includes(row.model)) : rows.slice(0, 4)
  const toggle = (name) => setPicked((current) => current.includes(name) ? current.filter((item) => item !== name) : current.length < 5 ? [...current, name] : current)

  return (
    <div className="page-stack">
      <div className="page-heading"><div><div className="eyebrow">HEAD TO HEAD</div><h1>Model arena</h1><p>Compare consumption shape, cache efficiency, output density, request volume and spend.</p></div><span className="count-chip">{rows.length} models</span></div>
      <div className="model-picker">{rows.map((row) => <button key={row.model} className={picked.includes(row.model) || (!picked.length && rows.indexOf(row) < 4) ? 'active' : ''} onClick={() => toggle(row.model)}>{row.model}</button>)}</div>
      <div className="grid cols-2 compare-grid">
        <div className="glass-card chart-shell"><div className="card-heading"><div><span>Absolute usage</span><b>Token mix by model</b></div></div><ModelBars data={compared} /></div>
        <div className="glass-card chart-shell radar-shell"><div className="card-heading"><div><span>Normalized profile</span><b>Model fingerprints</b></div></div><ModelRadar data={compared} /></div>
      </div>
      <div className="compare-cards">
        {compared.map((row, index) => <div className="glass-card model-score" key={row.model} style={{ '--model-index': index }}><span className="rank">#{index + 1}</span><h3>{row.model}</h3><div className="model-score-grid"><div><span>Total</span><b>{fmtTokens(row.total)}</b></div><div><span>Cost</span><b>{fmtUsd(row.cost)}</b></div><div><span>Sessions</span><b>{row.sessions}</b></div><div><span>Requests</span><b>{row.requests}</b></div><div><span>Cache share</span><b>{row.cacheRate.toFixed(1)}%</b></div><div><span>Output share</span><b>{row.outputRate.toFixed(1)}%</b></div></div></div>)}
      </div>
    </div>
  )
}
