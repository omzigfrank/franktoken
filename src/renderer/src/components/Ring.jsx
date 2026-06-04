import React from 'react'
import { usageColor } from '../format.js'

export default function Ring({ percent = 0, size = 96, stroke = 10, caption = '' }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const unknown = percent == null || Number.isNaN(percent)
  const p = unknown ? 0 : Math.max(0, Math.min(100, percent))
  const dash = (p / 100) * c
  const color = unknown ? '#5e6b7e' : usageColor(p)
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#0e131b" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray .6s ease, stroke .3s' }}
        />
      </svg>
      <div className="label">
        <div>
          <div className="pct" style={{ color, fontSize: unknown ? 18 : undefined }}>{unknown ? 'N/A' : `${Math.round(p)}%`}</div>
          {caption ? <div className="cap">{caption}</div> : null}
        </div>
      </div>
    </div>
  )
}
