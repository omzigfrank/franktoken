import React, { useCallback, useEffect, useRef, useState } from 'react'

// Why a pasted token was refused, in words that name the actual next move.
function describe(r) {
  switch (r.reason) {
    case 'empty':
      return 'Paste a token first.'
    case 'rejected':
      return `Anthropic rejected that token (HTTP ${r.status}). Not every Claude token can read account usage — if this keeps failing, use Sign in above instead.`
    case 'rate-limited':
      return 'Rate limited (HTTP 429). Wait a minute and try again.'
    case 'no-windows':
      return 'The token authenticated, but the response carried no limit window we recognize. The API shape may have moved.'
    case 'network':
      return 'Could not reach api.anthropic.com. Check the network and try again.'
    case 'unreadable':
      return 'The API replied with something that was not JSON.'
    default:
      return `The API refused the token (${r.reason}).`
  }
}

function sourceLabel(auth) {
  if (!auth?.source) return null
  if (auth.source === 'file') return auth.file || 'credentials file'
  if (auth.source === 'keychain') return 'macOS login Keychain'
  if (auth.source === 'manual') return 'token pasted here'
  if (auth.source === 'refreshed') return 'auto-refreshed access token'
  return auth.source
}

export default function ConnectClaude() {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const [token, setToken] = useState('')
  const wasConnected = useRef(false)

  const load = useCallback(async () => {
    const next = await window.api.claudeStatus()
    setSt(next)
    return next
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const connected = !!st?.auth?.connected

  // Keep re-checking while disconnected. Both things the user does next happen
  // outside this app — installing the CLI, finishing /login in a browser — and
  // neither notifies us. Polling means "Re-check" is a convenience, not a step
  // they have to know about.
  useEffect(() => {
    if (!st || connected) return
    const id = setInterval(load, 6000)
    return () => clearInterval(id)
  }, [st, connected, load])

  // Announce the transition once, so a login finished in the browser produces
  // visible confirmation here rather than a silently changed pill.
  useEffect(() => {
    if (connected && !wasConnected.current) {
      setMsg({ kind: 'ok', text: 'Signed in. Live account-wide limits are active.' })
    }
    wasConnected.current = connected
  }, [connected])

  async function signIn() {
    setBusy('login')
    setMsg(null)
    const r = await window.api.claudeLaunchLogin()
    setBusy(null)
    if (r.ok) {
      setMsg({
        kind: 'ok',
        text: 'A terminal is open running Claude Code. Type /login at its prompt (not the shell prompt) and finish in the browser — this panel updates on its own.'
      })
    } else if (r.reason === 'cli-not-found') {
      setMsg({ kind: 'err', text: 'Claude Code is not installed on this machine yet — install it with the command above, then try again.' })
    } else if (r.reason === 'no-terminal') {
      setMsg({ kind: 'err', text: `No terminal emulator found. Run ${r.cliPath} yourself, then type /login at its prompt.` })
    } else {
      setMsg({ kind: 'err', text: `Could not open a terminal (${r.reason}).` })
    }
    await load()
  }

  async function saveToken(clear = false) {
    setBusy('token')
    setMsg(null)
    const r = await window.api.claudeSetToken(clear ? '' : token)
    setBusy(null)
    if (r.ok && r.cleared) {
      setToken('')
      setMsg({ kind: 'ok', text: 'Pasted token removed.' })
    } else if (r.ok) {
      setToken('')
      setMsg({ kind: 'ok', text: `Verified against the live API — ${r.windowCount} limit window${r.windowCount === 1 ? '' : 's'} readable (${(r.labels || []).join(', ')}).` })
    } else {
      setMsg({ kind: 'err', text: describe(r) })
    }
    await load()
  }

  const auth = st?.auth
  const cli = st?.cli
  const state = connected ? 'ok' : auth?.expired ? 'warn' : 'off'

  return (
    <div className="card cc">
      <div className="cc-head">
        <div>
          <span>Connect Claude</span>
          <h3>Live account-wide limits</h3>
        </div>
        <div className={`cc-pill ${state}`}>
          <i />
          {connected ? 'Connected' : auth?.expired ? 'Token expired' : 'Not connected'}
        </div>
      </div>

      <p className="cc-note">
        The 5-hour and weekly windows come from your Claude account, so once this is connected they
        cover <b>every device and surface</b> you use — Claude.ai, Claude Code (CLI, web, desktop, IDE),
        Cowork, Design, and the Office plugins. Per-session detail is different: it is read from local
        transcripts, so it only ever covers <b>this machine</b>.
      </p>

      {!st && <div className="cc-row muted">Checking…</div>}

      {st && (
        <>
          <div className="cc-step">
            <div className="cc-n">1</div>
            <div className="cc-body">
              <div className="cc-t">Claude Code CLI</div>
              {cli.found ? (
                <div className="cc-sub ok-text">
                  Found at <span className="mono">{cli.path}</span>
                  {cli.version ? ` · ${cli.version}` : ''}
                </div>
              ) : (
                <>
                  <div className="cc-sub">
                    Not installed here. FrankToken reads the credentials this CLI writes — it does not run
                    its own login.
                  </div>
                  <div className="cc-cmd">
                    <span className="mono">{cli.installCommand}</span>
                    <button className="rp-btn" onClick={() => navigator.clipboard?.writeText(cli.installCommand)}>
                      Copy
                    </button>
                  </div>
                  <div className="cc-sub">
                    Run it in a terminal, then come back — this panel re-checks every few seconds.
                    A terminal opened <b>before</b> the install still has the old PATH, so run
                    <span className="mono"> claude </span> in a new one.
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="cc-step">
            <div className="cc-n">2</div>
            <div className="cc-body">
              <div className="cc-t">Sign in once</div>
              <div className="cc-sub">
                {connected ? (
                  <>
                    Reading credentials from <span className="mono">{sourceLabel(auth)}</span>
                    {auth.canRefresh ? ' · refreshes automatically' : ' · cannot auto-refresh'}
                    {auth.expiresAt ? ` · expires ${new Date(auth.expiresAt).toLocaleString()}` : ''}
                  </>
                ) : (
                  <>
                    Opens a terminal running Claude Code. At <b>Claude's own prompt</b> — not the
                    shell prompt — type <span className="mono">/login</span> and finish in the browser.
                    It is an interactive flow, so it cannot be automated away.
                  </>
                )}
              </div>
              <div className="cc-actions">
                <button className="rp-apply" disabled={!cli.found || busy === 'login'} onClick={signIn}>
                  {busy === 'login' ? 'Opening…' : connected ? 'Sign in again' : 'Sign in'}
                </button>
                <button className="rp-btn" disabled={busy === 'status'} onClick={async () => { setBusy('status'); await load(); setBusy(null) }}>
                  Re-check
                </button>
              </div>
            </div>
          </div>

          {!connected && (auth.problems?.length > 0 || auth.checked?.length > 0) && (
            <div className="cc-diag">
              {auth.problems?.length > 0 ? (
                <>
                  <b>Found but unusable:</b>
                  <ul>{auth.problems.map((p) => <li key={p} className="mono">{p}</li>)}</ul>
                </>
              ) : (
                <>
                  <b>Looked in:</b>
                  <ul>{auth.checked.map((p) => <li key={p} className="mono">{p}</li>)}</ul>
                </>
              )}
              {auth.lastFailure && <div>Last live call failed: <span className="mono">{auth.lastFailure}</span></div>}
            </div>
          )}

          {/* Uncontrolled on purpose: binding `open` to state collapses the
              section on every re-render, which hides the field and the verify
              result the moment the user clicks the button. */}
          <details className="cc-adv">
            <summary>Paste a token instead</summary>
            <div className="cc-sub">
              For machines where the CLI's credentials cannot be read. The token is checked against the
              live usage endpoint before it is saved — if it does not work, you will see exactly why.
              It carries no refresh token, so it stops working when it expires.
            </div>
            <div className="cc-cmd">
              <input
                type="password"
                placeholder="Access token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="rp-apply" disabled={!token.trim() || busy === 'token'} onClick={() => saveToken(false)}>
                {busy === 'token' ? 'Verifying…' : 'Verify & save'}
              </button>
              {auth.hasManualToken && (
                <button className="rp-btn" disabled={busy === 'token'} onClick={() => saveToken(true)}>
                  Remove
                </button>
              )}
            </div>
          </details>

          {msg && <div className={`cc-msg ${msg.kind}`}>{msg.text}</div>}
        </>
      )}
    </div>
  )
}
