import React from 'react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
  ScatterChart, Scatter, ZAxis, Legend, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis
} from 'recharts'
import { fmtDuration, fmtTokens, fmtUsd } from '../format.js'

const axis = { stroke: '#5e6b7e', fontSize: 10 }
const grid = '#1b2230'

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

const tooltipStyle = { background: '#101521', border: '1px solid #293248', borderRadius: 12, color: '#eef2ff', boxShadow: '0 18px 60px rgba(0,0,0,.45)' }
const palette = ['#7c6cff', '#24d3ee', '#ff6b9a', '#f7b955', '#9af57f']

export function SessionScatter({ data, onPick }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ScatterChart margin={{ top: 22, right: 20, bottom: 12, left: 4 }}>
        <CartesianGrid stroke="#242d42" strokeDasharray="3 6" />
        <XAxis type="number" dataKey="durationMinutes" name="duration" tick={axis} tickFormatter={(value) => fmtDuration(value * 60_000)} />
        <YAxis type="number" dataKey="totalTokens" name="tokens" tick={axis} width={48} tickFormatter={fmtTokens} />
        <ZAxis type="number" dataKey="costUsd" range={[80, 900]} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={tooltipStyle} formatter={(value, name) => name === 'tokens' ? fmtTokens(value) : name === 'duration' ? fmtDuration(value * 60_000) : value} labelFormatter={(_, payload) => payload?.[0]?.payload?.label || 'Session'} />
        <Scatter data={data} fill="#7c6cff" onClick={(point) => onPick?.(point)}>
          {data.map((entry, index) => <Cell key={`${entry.id}:${index}`} fill={palette[index % palette.length]} fillOpacity={0.82} stroke="#ffffff" strokeOpacity={0.18} />)}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  )
}

export function TokenStackedBars({ data }) {
  const rows = [...data].reverse().map((session) => ({
    label: session.title.length > 16 ? `${session.title.slice(0, 16)}…` : session.title,
    input: session.tokens.input,
    cached: session.tokens.cachedInput,
    cacheWrite: session.tokens.cacheWrite,
    output: session.tokens.output,
    reasoning: session.tokens.reasoning
  }))
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} layout="vertical" margin={{ top: 10, right: 16, bottom: 4, left: 22 }}>
        <CartesianGrid stroke="#242d42" horizontal={false} />
        <XAxis type="number" tick={axis} tickFormatter={fmtTokens} />
        <YAxis type="category" dataKey="label" width={105} tick={axis} />
        <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [fmtTokens(value), name]} />
        <Bar dataKey="input" stackId="tokens" fill="#7c6cff" />
        <Bar dataKey="cached" stackId="tokens" fill="#24d3ee" />
        <Bar dataKey="cacheWrite" stackId="tokens" fill="#f7b955" />
        <Bar dataKey="output" stackId="tokens" fill="#ff6b9a" />
        <Bar dataKey="reasoning" stackId="tokens" fill="#9af57f" radius={[0, 5, 5, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function ModelBars({ data }) {
  return (
    <ResponsiveContainer width="100%" height={330}>
      <BarChart data={data} margin={{ top: 24, right: 16, bottom: 58, left: 2 }}>
        <CartesianGrid stroke="#242d42" vertical={false} />
        <XAxis dataKey="model" tick={axis} angle={-25} textAnchor="end" interval={0} />
        <YAxis tick={axis} width={48} tickFormatter={fmtTokens} />
        <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [fmtTokens(value), name]} />
        <Legend verticalAlign="top" height={30} wrapperStyle={{ color: '#8994aa', fontSize: 11 }} />
        <Bar dataKey="input" stackId="tokens" fill="#7c6cff" />
        <Bar dataKey="cachedInput" name="cache read" stackId="tokens" fill="#24d3ee" />
        <Bar dataKey="cacheWrite" name="cache write" stackId="tokens" fill="#f7b955" />
        <Bar dataKey="output" stackId="tokens" fill="#ff6b9a" radius={[5, 5, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function ModelRadar({ data }) {
  const max = (key) => Math.max(1, ...data.map((row) => row[key] || 0))
  const axes = [
    ['Tokens', 'total'], ['Cost', 'cost'], ['Sessions', 'sessions'], ['Requests', 'requests'], ['Cache %', 'cacheRate'], ['Output %', 'outputRate']
  ]
  const rows = axes.map(([metric, key]) => ({
    metric,
    ...Object.fromEntries(data.map((row) => [row.model, ((row[key] || 0) / max(key)) * 100]))
  }))
  return (
    <ResponsiveContainer width="100%" height={330}>
      <RadarChart data={rows} outerRadius="72%">
        <PolarGrid stroke="#2a3349" />
        <PolarAngleAxis dataKey="metric" tick={{ fill: '#8994aa', fontSize: 11 }} />
        <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
        {data.map((row, index) => <Radar key={row.model} name={row.model} dataKey={row.model} stroke={palette[index % palette.length]} fill={palette[index % palette.length]} fillOpacity={0.12} strokeWidth={2} />)}
        <Legend wrapperStyle={{ color: '#8994aa', fontSize: 11 }} />
        <Tooltip contentStyle={tooltipStyle} formatter={(value) => `${Number(value).toFixed(0)}%`} />
      </RadarChart>
    </ResponsiveContainer>
  )
}
