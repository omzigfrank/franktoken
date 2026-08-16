import React from 'react'
import { fmtAgo } from '../format.js'

const catalog = [
  { id: 'claude', product: 'Claude', family: 'Anthropic', transport: 'Enterprise Analytics / Compliance', ceiling: 'Cloud aggregate', cadence: '4h–3d' },
  { id: 'claude-code', product: 'Claude Code', family: 'Anthropic', transport: 'OpenTelemetry traces + local transcript', ceiling: 'Request + session', cadence: '5s' },
  { id: 'claude-design', product: 'Claude Design', family: 'Anthropic', transport: 'Enterprise Analytics', ceiling: 'Product / model', cadence: '4h–3d' },
  { id: 'claude-cowork', product: 'Claude Cowork', family: 'Anthropic', transport: 'OpenTelemetry logs + traces', ceiling: 'Prompt + request + tool', cadence: 'Seconds' },
  { id: 'claude-powerpoint', product: 'Claude for PowerPoint', family: 'Anthropic', transport: 'Office agent OTLP/HTTP', ceiling: 'Turn + request + tool', cadence: 'Seconds' },
  { id: 'claude-word', product: 'Claude for Word', family: 'Anthropic', transport: 'Office agent OTLP/HTTP', ceiling: 'Turn + request + tool', cadence: 'Seconds' },
  { id: 'codex', product: 'Codex', family: 'OpenAI', transport: 'Local transcript / workspace analytics', ceiling: 'Local request; cloud aggregate', cadence: 'Seconds / aggregate' },
  { id: 'chatgpt', product: 'ChatGPT', family: 'OpenAI', transport: 'Workspace analytics / compliance', ceiling: 'Workspace activity', cadence: 'Provider-defined' },
  { id: 'chatgpt-work', product: 'ChatGPT Work', family: 'OpenAI', transport: 'Workspace analytics / compliance', ceiling: 'Workspace activity', cadence: 'Provider-defined' },
  { id: 'openai-api', product: 'OpenAI API', family: 'OpenAI', transport: 'Organization Usage + Costs API', ceiling: 'Minute × model × project', cadence: '1m+' },
  { id: 'claude-api', product: 'Claude API', family: 'Anthropic', transport: 'Usage + Cost Admin API', ceiling: 'Minute × model × workspace', cadence: '~5m' }
]

export default function Sources({ snapshots, sessions }) {
  const activity = new Map()
  for (const session of sessions) {
    const key = session.product.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    activity.set(key, Math.max(activity.get(key) || 0, session.endedAt || session.startedAt || 0))
    if (session.provider) activity.set(session.provider, Math.max(activity.get(session.provider) || 0, session.endedAt || 0))
  }
  for (const snapshot of snapshots) activity.set(snapshot.id, Math.max(activity.get(snapshot.id) || 0, snapshot.meta?.lastActivity || 0))

  return (
    <div className="page-stack">
      <div className="page-heading"><div><div className="eyebrow">DATA CONTRACT</div><h1>Coverage control room</h1><p>FrankToken shows the most granular source each product officially exposes—never invented precision.</p></div><span className="count-chip"><i className="live-pulse" /> capability-aware</span></div>
      <div className="source-summary grid cols-3"><div className="glass-card"><span>Real-time surfaces</span><b>4</b><small>Claude Code, Cowork, Word, PowerPoint</small></div><div className="glass-card"><span>Cloud reconciliation</span><b>7</b><small>Provider aggregates and billed costs</small></div><div className="glass-card"><span>Unsupported promise</span><b>0</b><small>No scraping or guessed token totals</small></div></div>
      <div className="source-grid">
        {catalog.map((source) => {
          const last = activity.get(source.id)
          const active = !!last
          return <div className={`glass-card source-card ${active ? 'connected' : ''}`} key={source.id}><div className="source-card-top"><span className={`source-logo ${source.family.toLowerCase()}`}>{source.family === 'Anthropic' ? 'A' : 'O'}</span><span className={`status ${active ? 'live' : 'ready'}`}>{active ? 'Receiving' : 'Supported'}</span></div><h3>{source.product}</h3><p>{source.transport}</p><div className="source-meta"><span><small>Best detail</small>{source.ceiling}</span><span><small>Freshness</small>{source.cadence}</span></div><div className="source-last">{active ? `Last signal ${fmtAgo(last)}` : 'Configure this source on the Hub'}</div></div>
        })}
      </div>
    </div>
  )
}
