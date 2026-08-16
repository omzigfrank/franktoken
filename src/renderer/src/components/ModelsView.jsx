import React, { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from 'recharts'
import { MetricBars, COMPARE_COLORS } from './Charts.jsx'
import { fmtTokens, fmtUsd } from '../format.js'

const axis = { stroke: '#5e6b7e', fontSize: 10 }
const grid = '#1b2230'

export default function ModelsView({ snapshots, rangeLbl = '30D' }) {
  const [metric, setMetric] = useState('tokens') // tokens | cost

  const rows = useMemo(() => {
    const out = []
    for (const snap of snapshots) {
      const byModel = snap.byModel || {}
      for (const [model, m] of Object.entries(byModel)) {
        const sessions = (snap.sessions || []).filter((s) => s.models?.some((x) => x.model === model)).length
        out.push({
          model,
          provider: snap.id,
          providerName: snap.name,
          color: snap.color,
          tokens: m.tokens,
          cost: m.cost,
          series: m.series,
          sessions,
          perMtok: m.tokens.total > 0 ? (m.cost.total / m.tokens.total) * 1e6 : 0
        })
      }
    }
    return out.sort((a, b) => b.tokens.total - a.tokens.total)
  }, [snapshots])

  const top = rows.slice(0, 4)
  const daily = useMemo(() => {
    const byDate = new Map()
    top.forEach((r, i) => {
      for (const p of r.series.tokensByDay) {
        const row = byDate.get(p.date) || { date: p.date, label: p.label || p.date.slice(5) }
        row[`m${i}`] = (row[`m${i}`] || 0) + p.total
        byDate.set(p.date, row)
      }
    })
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [top])

  if (rows.length === 0) {
    return (
      <div className="grid" style={{ gap: 14 }}>
        <div className="section-title"><h2>Models</h2><span className="pill">{rangeLbl}</span></div>
        <div className="card empty">No model usage in this range yet.</div>
      </div>
    )
  }

  const barRows = rows.slice(0, 10).map((r) => ({
    label: r.model,
    value: metric === 'tokens' ? r.tokens.total : r.cost.total,
    color: r.color
  }))

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="section-title">
        <h2>Models</h2>
        <span className="pill">{rows.length} models · {rangeLbl}</span>
        <span className="pill est">costs estimated</span>
        <div className="grow" />
        <button className={`chip ${metric === 'tokens' ? 'on' : ''}`} onClick={() => setMetric('tokens')}>Tokens</button>
        <button className={`chip ${metric === 'cost' ? 'on' : ''}`} onClick={() => setMetric('cost')}>Cost</button>
      </div>

      <div className="card">
        <h3>{metric === 'tokens' ? 'Tokens by model' : 'Est. cost by model (USD)'} — color keyed to provider</h3>
        <MetricBars rows={barRows} fmt={metric === 'tokens' ? fmtTokens : fmtUsd} />
        <div className="legendrow" style={{ marginTop: 6 }}>
          {[...new Map(rows.map((r) => [r.provider, r])).values()].map((r) => (
            <span key={r.provider} className="legenditem"><span className="dotkey" style={{ background: r.color }} />{r.providerName}</span>
          ))}
        </div>
      </div>

      {daily.length > 1 && top.length > 0 && (
        <div className="card chart-card">
          <div className="chart-head"><h3>Daily tokens — top {top.length} models head-to-head</h3></div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={daily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={grid} vertical={false} />
              <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: grid }} />
              <YAxis tick={axis} tickLine={false} axisLine={false} width={44} tickFormatter={fmtTokens} />
              <Tooltip
                cursor={{ stroke: '#2e3a4d' }}
                labelStyle={{ color: '#e7ecf3' }}
                itemStyle={{ color: '#e7ecf3' }}
                contentStyle={{ background: '#0e131b', border: '1px solid #232b39', borderRadius: 10 }}
                formatter={(v, name) => [fmtTokens(v), top[Number(name.slice(1))]?.model || name]}
              />
              <Legend formatter={(value) => <span style={{ color: '#93a0b4', fontSize: 11 }}>{top[Number(value.slice(1))]?.model || value}</span>} />
              {top.map((r, i) => (
                <Line key={r.model} dataKey={`m${i}`} stroke={COMPARE_COLORS[i]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="stable">
          <thead>
            <tr>
              <th>Model</th><th>Provider</th><th>Sessions</th><th>Uncached in</th><th>Cache read</th><th>Output</th><th>Tokens</th><th>Cost</th><th>$/1M tok</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.provider}:${r.model}`}>
                <td className="tcell-title"><span className="dotkey" style={{ background: r.color }} /><span className="ttl">{r.model}</span></td>
                <td>{r.providerName}</td>
                <td>{r.sessions || '—'}</td>
                <td>{fmtTokens(r.tokens.input)}</td>
                <td>{fmtTokens(r.tokens.cachedInput)}</td>
                <td>{fmtTokens(r.tokens.output)}</td>
                <td className="strong">{fmtTokens(r.tokens.total)}</td>
                <td className="strong" style={{ color: '#34d399' }}>{fmtUsd(r.cost.total)}</td>
                <td>{fmtUsd(r.perMtok)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
