import React from 'react'
import ConnectClaude from './ConnectClaude.jsx'

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
      <ConnectClaude />
      <div className="card">
        <div className="settings">
          <div className="setrow">
            <label>Refresh interval (seconds)</label>
            <input
              type="number" min="5" max="3600" value={settings.pollSeconds}
              onChange={(e) => onChange({ pollSeconds: Math.max(5, Number(e.target.value) || 5) })}
            />
          </div>
          <div className="setrow">
            <label>Launch at login</label>
            <Switch on={settings.launchAtLogin} onClick={() => onChange({ launchAtLogin: !settings.launchAtLogin })} />
          </div>
          <div className="setrow">
            <label>
              Show figures without cache leverage
              <small>
                Adds a side-by-side &ldquo;no prompt cache&rdquo; view. The token total is the same
                either way &mdash; the same prompt is sent regardless &mdash; but every cached token
                is re-priced as fresh input, which is where the difference shows up.
              </small>
            </label>
            <Switch
              on={settings.showWithoutCache}
              onClick={() => onChange({ showWithoutCache: !settings.showWithoutCache })}
            />
          </div>
          <div className="setrow setrow-stack">
            <label>FrankToken Hub URL <small>Merge telemetry from every configured device</small></label>
            <input
              type="url" placeholder="https://tokens.example.com" value={settings.hubUrl || ''}
              onChange={(e) => onChange({ hubUrl: e.target.value.trim() })}
            />
          </div>
          <div className="setrow setrow-stack">
            <label>Hub read token <small>Used only to read your private dashboard feed</small></label>
            <input
              type="password" placeholder="Optional when the Hub is private by network" value={settings.hubReadToken || ''}
              onChange={(e) => onChange({ hubReadToken: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>About</h3>
        <div className="sub" style={{ lineHeight: 1.6 }}>
          FrankToken is a fidelity-aware AI telemetry dashboard for Windows, macOS, Linux,
          and a deployable FrankToken Hub. This desktop build reads local CLI sessions
          (<b>~/.codex</b>, <b>~/.claude</b>) and will merge them with explicitly configured
          cloud and OpenTelemetry sources.
          <br /><br />
          Every source is labeled by freshness and detail. Costs marked <b>estimated</b> use
          token pricing; provider billing feeds remain the reconciliation source of truth.
        </div>
      </div>
    </div>
  )
}
