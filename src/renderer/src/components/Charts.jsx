import React from 'react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, Legend,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, LabelList
} from 'recharts'
import { fmtTokens, fmtUsd } from '../format.js'

const axis = { stroke: '#5e6b7e', fontSize: 10 }
const grid = '#1b2230'
const tooltipStyle = {
  cursor: { fill: 'rgba(255,255,255,0.04)' },
  labelStyle: { color: '#e7ecf3' },
  itemStyle: { color: '#e7ecf3' },
  contentStyle: { background: '#0e131b', border: '1px solid #232b39', borderRadius: 10, color: '#e7ecf3' }
}

// Colorblind-validated compare slots (adjacent-safe on the app surface).
export const COMPARE_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500']

export function TokenArea({ data, color = '#6ea8fe' }) {
  const d = data.map((x) => ({ ...x, label: x.label || x.date.slice(5) }))
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={d} margin={{ top: 10, right: 18, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`g-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.5} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={grid} vertical={false} />
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: grid }} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={42} tickFormatter={fmtTokens} />
        <Tooltip
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          formatter={(v) => [fmtTokens(v), 'tokens']}
          labelStyle={{ color: '#e7ecf3' }}
          itemStyle={{ color: '#e7ecf3' }}
          contentStyle={{ background: '#0e131b', border: '1px solid #232b39', borderRadius: 10, color: '#e7ecf3' }}
        />
        <Area
          type="monotone"
          dataKey="total"
          stroke={color}
          strokeWidth={2}
          fill={`url(#g-${color})`}
          dot={d.length <= 2 ? { r: 4, fill: color, stroke: color } : false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Cumulative token sparkline for one session's flyout. data: [{ts,total}] */
export function SessionSpark({ timeline, color = '#6ea8fe', height = 140 }) {
  const start = timeline[0]?.ts || 0
  const d = timeline.map((p) => ({ min: (p.ts - start) / 60000, total: p.total, usd: p.usd }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={d} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`ss-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={grid} vertical={false} />
        <XAxis
          dataKey="min"
          type="number"
          domain={[0, 'dataMax']}
          tick={axis}
          tickLine={false}
          axisLine={{ stroke: grid }}
          tickFormatter={(v) => `${Math.round(v)}m`}
        />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={44} tickFormatter={fmtTokens} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(v) => `${Math.round(v)} min in`}
          formatter={(v, name) => (name === 'usd' ? [fmtUsd(v), 'est. cost'] : [fmtTokens(v), 'cumulative tokens'])}
        />
        <Area type="monotone" dataKey="total" stroke={color} strokeWidth={2} fill={`url(#ss-${color})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/**
 * Overlay cumulative timelines of up to 4 sessions, x = minutes from each
 * session's own start so different wall-clock sessions compare directly.
 * series: [{id, label, color, timeline:[{ts,total}]}]
 */
export function CompareTimelines({ series, height = 220 }) {
  const lines = series.map((s) => {
    const start = s.timeline[0]?.ts || 0
    return { ...s, points: s.timeline.map((p) => ({ min: (p.ts - start) / 60000, [s.id]: p.total })) }
  })
  // merge on the numeric axis: recharts handles separate arrays via separate Line data
  const merged = []
  for (const l of lines) merged.push(...l.points)
  merged.sort((a, b) => a.min - b.min)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={merged} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={grid} vertical={false} />
        <XAxis
          dataKey="min"
          type="number"
          domain={[0, 'dataMax']}
          tick={axis}
          tickLine={false}
          axisLine={{ stroke: grid }}
          tickFormatter={(v) => `${Math.round(v)}m`}
        />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={44} tickFormatter={fmtTokens} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(v) => `${Math.round(v)} min into session`}
          formatter={(v, name) => [fmtTokens(v), lines.find((l) => l.id === name)?.label || name]}
        />
        <Legend
          formatter={(value) => (
            <span style={{ color: '#93a0b4', fontSize: 11 }}>{lines.find((l) => l.id === value)?.label || value}</span>
          )}
        />
        {lines.map((l) => (
          <Line
            key={l.id}
            dataKey={l.id}
            stroke={l.color}
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

/**
 * One-metric horizontal comparison bars with direct value labels.
 * rows: [{label, value, color}]; fmt formats the value.
 */
export function MetricBars({ rows, fmt = fmtTokens, height }) {
  const d = rows.map((r) => ({ ...r }))
  return (
    <ResponsiveContainer width="100%" height={height || Math.max(90, d.length * 34 + 30)}>
      <BarChart data={d} layout="vertical" margin={{ top: 4, right: 64, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={grid} horizontal={false} />
        <XAxis type="number" tick={axis} tickLine={false} axisLine={{ stroke: grid }} tickFormatter={fmt} />
        <YAxis type="category" dataKey="label" tick={{ ...axis, fill: '#93a0b4' }} tickLine={false} axisLine={false} width={130} />
        <Tooltip {...tooltipStyle} formatter={(v) => [fmt(v), '']} />
        <Bar dataKey="value" barSize={18} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {d.map((r, i) => (
            <Cell key={i} fill={r.color} />
          ))}
          <LabelList dataKey="value" position="right" formatter={fmt} style={{ fill: '#e7ecf3', fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export function CostBars({ data, color = '#34d399' }) {
  const d = data.map((x) => ({ ...x, label: x.label || x.date.slice(5) }))
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={d} margin={{ top: 10, right: 18, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={grid} vertical={false} />
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: grid }} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={42} tickFormatter={(v) => '$' + v.toFixed(0)} />
        <Tooltip
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          formatter={(v) => [fmtUsd(v), 'est. cost']}
          labelStyle={{ color: '#e7ecf3' }}
          itemStyle={{ color: '#e7ecf3' }}
          contentStyle={{ background: '#0e131b', border: '1px solid #232b39', borderRadius: 10, color: '#e7ecf3' }}
        />
        <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
          {d.map((_, i) => (
            <Cell key={i} fill={color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
