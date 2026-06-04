import React from 'react'

function Switch({ on, onClick }) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={onClick}><div className="knob" /></div>
  )
}

export default function Settings({ settings, onChange }) {
  if (!settings) return null
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="section-title"><h2>Settings</h2></div>
      <div className="card">
        <div className="settings">
          <div className="setrow">
            <label>Refresh interval (seconds)</label>
            <input
              type="number" min="10" max="3600" value={settings.pollSeconds}
              onChange={(e) => onChange({ pollSeconds: Math.max(10, Number(e.target.value) || 30) })}
            />
          </div>
          <div className="setrow">
            <label>Launch at login</label>
            <Switch on={settings.launchAtLogin} onClick={() => onChange({ launchAtLogin: !settings.launchAtLogin })} />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>About</h3>
        <div className="sub" style={{ lineHeight: 1.6 }}>
          FrankToken is an OS-agnostic, GUI-rich usage monitor for AI coding assistants for
          Windows / macOS / Linux. It parses local CLI session files on-device
          (<b>~/.codex</b>, <b>~/.claude</b>); nothing is sent anywhere.
          <br /><br />
          Costs and Claude windows are <b>estimates</b> derived from local token counts and a
          pricing table — treat them as guidance, not billing.
        </div>
      </div>
    </div>
  )
}
