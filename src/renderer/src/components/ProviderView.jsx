import React, { useState } from 'react'
import Ring from './Ring.jsx'
import WindowBar from './WindowBar.jsx'
import AccountWide from './AccountWide.jsx'
import { TokenArea, CostBars } from './Charts.jsx'
import { fmtTokens, fmtUsd, fmtAgo } from '../format.js'

function StatusPill({ s }) {
  if (!s.available) return <span className="pill off">Not detected</span>
  if (s.windowsUnknown) return <span className="pill off">Limits N/A</span>
  if (s.windowsStale) return <span className="pill est">Live · stale</span>
  const est = s.windows.some((w) => w.estimated)
  return est ? <span className="pill est">Estimated</span> : <span className="pill live">Live</span>
}

/**
 * The no-cache counterfactual.
 *
 * Deliberately states that the token TOTAL does not move. Without a prompt
 * cache the same conversation still sends the same prompt every turn — what
 * changes is that each of those tokens bills as fresh input instead of a
 * ~0.1x cache read. Showing a smaller token number here would be inventing a
 * saving that caching never made.
 */
function NoCacheBlock({ nc, rangeLbl }) {
  const savings = nc.savings || 0
  const multiple = nc.multiple
  return (
    <div className="nocache">
      <div className="nocache-head">
        <h4>Without cache leverage</h4>
        <span className="pill est">counterfactual</span>
      </div>
      <div className="kpis" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="kpi"><div className="k">Tokens ({rangeLbl})</div><div className="v">{fmtTokens(nc.tokens.total)}</div></div>
        <div className="kpi"><div className="k">Uncached input</div><div className="v">{fmtTokens(nc.tokens.input)}</div></div>
        <div className="kpi"><div className="k">Output</div><div className="v">{fmtTokens(nc.tokens.output)}</div></div>
        <div className="kpi"><div className="k">Cost {rangeLbl} (no cache)</div><div className="v" style={{ color: '#f7b955' }}>{fmtUsd(nc.cost.total)}</div></div>
      </div>
      <div className="sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
        Same {fmtTokens(nc.tokens.total)} tokens — the identical prompt goes over the wire either
        way. Caching changes the price, not the volume: every cache read here is re-billed as
        fresh input.{' '}
        {savings > 0 ? (
          <b style={{ color: '#34d399' }}>
            Cache saved {fmtUsd(savings)}
            {multiple ? ` (${multiple.toFixed(1)}× cheaper)` : ''} in this range.
          </b>
        ) : (
          <b>No cache reads recorded in this range, so there is nothing to compare.</b>
        )}
      </div>
    </div>
  )
}

export default function ProviderView({ s, rangeLbl = '30D', settings = null }) {
  const primary = s.windows[0]
  // Model filter: click a model badge to scope tokens/cost/charts to it.
  // (Rate-limit windows stay account-wide — they aren't metered per model.)
  const [modelFilter, setModelFilter] = useState(null)
  const models = s.meta?.models?.length ? s.meta.models : s.meta?.model ? [s.meta.model] : []
  const filtered = modelFilter && s.byModel?.[modelFilter] ? s.byModel[modelFilter] : null
  const tokens = filtered ? filtered.tokens : s.tokens
  const cost = filtered ? filtered.cost : s.cost
  const series = filtered ? filtered.series : s.series
  // The "what if there were no prompt cache" counterfactual, opt-in from
  // Settings. Absent on snapshots produced before it existed, so guarded.
  const noCache = settings?.showWithoutCache ? (filtered ? filtered.noCache : s.noCache) : null
  const sessions = s.meta?.sessions || 0
  const totalSessions = s.meta?.totalSessions ?? sessions
  const sessionSummary = totalSessions > sessions
    ? `${sessions} in ${rangeLbl} · ${totalSessions} stored · last ${fmtAgo(s.meta?.lastActivity)}`
    : `${sessions} sessions · ${fmtAgo(s.meta?.lastActivity)}`
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="section-title">
        <h2 style={{ color: s.color }}>{s.name}</h2>
        <StatusPill s={s} />
        {models.map((m) => {
          const active = modelFilter === m
          return (
            <span
              key={m}
              className="pill"
              onClick={() => setModelFilter(active ? null : m)}
              title={active ? 'Click to clear model filter' : `Filter to ${m}`}
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                ...(active ? { borderColor: s.color, color: s.color, fontWeight: 600 } : null),
                ...(modelFilter && !active ? { opacity: 0.45 } : null)
              }}
            >
              {m}
            </span>
          )
        })}
        <span className="pill">{sessionSummary}</span>
        {modelFilter ? (
          <span className="pill est" style={{ cursor: 'pointer' }} onClick={() => setModelFilter(null)}>
            filtering: {modelFilter} ✕
          </span>
        ) : null}
      </div>

      {!s.available || s.error ? (
        <div className="card empty">{s.error || 'No data available.'}</div>
      ) : null}

      {s.available && (
        <>
          <AccountWide snapshot={s} />
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
              <h3>Tokens & cost{modelFilter ? ` · ${modelFilter}` : ''}</h3>
              <div className="kpis" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="kpi"><div className="k">Tokens ({rangeLbl})</div><div className="v">{fmtTokens(tokens.total)}</div></div>
                <div className="kpi"><div className="k">Uncached input</div><div className="v">{fmtTokens(tokens.input)}</div></div>
                <div className="kpi"><div className="k">Output</div><div className="v">{fmtTokens(tokens.output)}</div></div>
                <div className="kpi"><div className="k">Cache read</div><div className="v">{fmtTokens(tokens.cachedInput)}</div></div>
                {tokens.cacheWrite > 0 ? <div className="kpi"><div className="k">Cache write</div><div className="v">{fmtTokens(tokens.cacheWrite)}</div></div> : null}
                <div className="kpi"><div className="k">Reasoning</div><div className="v">{fmtTokens(tokens.reasoning)}</div></div>
                <div className="kpi"><div className="k">Cost today (est.)</div><div className="v" style={{ color: '#34d399' }}>{fmtUsd(cost.today)}</div></div>
                <div className="kpi"><div className="k">Cost {rangeLbl} (est.)</div><div className="v" style={{ color: '#34d399' }}>{fmtUsd(cost.total)}</div></div>
              </div>
              {noCache ? <NoCacheBlock nc={noCache} rangeLbl={rangeLbl} /> : null}
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card chart-card">
              <div className="chart-head"><h3>Tokens / day{modelFilter ? ` · ${modelFilter}` : ''}</h3></div>
              {series.tokensByDay.length ? (
                <TokenArea data={series.tokensByDay} color={s.color} />
              ) : <div className="empty">No daily data.</div>}
            </div>
            <div className="card chart-card">
              <div className="chart-head"><h3>Est. cost / day{modelFilter ? ` · ${modelFilter}` : ''}</h3></div>
              {series.costByDay.length ? (
                <CostBars data={series.costByDay} color={s.color} />
              ) : <div className="empty">No daily data.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

