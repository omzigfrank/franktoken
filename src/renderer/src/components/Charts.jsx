import React from 'react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell
} from 'recharts'
import { fmtTokens, fmtUsd } from '../format.js'

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
        <Area type="monotone" dataKey="total" stroke={color} strokeWidth={2} fill={`url(#g-${color})`} />
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
