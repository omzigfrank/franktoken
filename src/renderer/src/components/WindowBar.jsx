import React from 'react'
import { fmtReset, usageColor, fmtTokens } from '../format.js'

export default function WindowBar({ w }) {
  const unknown = w.unknown || w.usedPercent == null
  const color = unknown ? '#5e6b7e' : usageColor(w.usedPercent)
  return (
    <div className="wbar">
      <div className="row">
        <span className="name">{w.label}</span>
        <span className="val" style={{ color }}>{unknown ? 'N/A' : `${Math.round(w.usedPercent)}%`}</span>
      </div>
      <div className="track">
        {!unknown && (
          <div
            className="fill"
            style={{
              width: `${Math.max(2, Math.min(100, w.usedPercent))}%`,
              background: `linear-gradient(90deg, ${color}, ${color}cc)`
            }}
          />
        )}
      </div>
      <div className="reset">
        {unknown ? 'no live limit available' : `resets in ${fmtReset(w.resetsAt)}`}
        {w.usedTokens != null
          ? w.budgetTokens != null
            ? ` · ${fmtTokens(w.usedTokens)} / ${fmtTokens(w.budgetTokens)} tok`
            : ` · ${fmtTokens(w.usedTokens)} tok on this device`
          : ''}
        {w.estimated && w.budgetTokens != null ? ' · est.' : ''}
      </div>
    </div>
  )
}
