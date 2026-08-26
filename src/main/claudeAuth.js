// Connect Claude — take the guesswork out of enabling live account-wide limits.
//
// Deliberate scope: FrankToken does NOT run its own OAuth flow. The usage
// endpoint and Claude Code's PKCE client id are Anthropic-internal, and minting
// fresh tokens under another application's client identity is not something
// this app should do on a user's behalf. So the Claude Code CLI stays the
// credential authority. This module's job is narrower and honest: find the
// CLI, say precisely what is missing, launch the official login, and verify a
// pasted token by actually calling the API rather than assuming it works.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { authStatus, probeUsage, setManualToken } from './providers/claude.js'

const run = promisify(execFile)

/** Universal install command — works on every platform Node is on. */
export const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code'

/**
 * Well-known install locations for the `claude` binary, in preference order.
 * Pure and platform-parameterized so it can be tested off the host OS.
 */
export function cliCandidates(platform = process.platform, home = os.homedir(), env = process.env) {
  const out = []
  if (platform === 'win32') {
    // Native installer, then npm -g, then the Programs dir.
    out.push(path.join(home, '.local', 'bin', 'claude.exe'))
    out.push(path.join(home, '.local', 'bin', 'claude.cmd'))
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'claude.cmd'))
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'))
  } else {
    out.push(path.join(home, '.local', 'bin', 'claude'))
    out.push('/usr/local/bin/claude')
    if (platform === 'darwin') out.push('/opt/homebrew/bin/claude')
    out.push(path.join(home, '.npm-global', 'bin', 'claude'))
    out.push(path.join(home, '.bun', 'bin', 'claude'))
  }
  return [...new Set(out)]
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// Ask the shell where `claude` is before guessing at paths — it honors the
// user's own PATH, which no candidate list can cover.
async function fromPath(platform) {
  const finder = platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await run(finder, ['claude'], { timeout: 4000, windowsHide: true })
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return first && isFile(first) ? first : null
  } catch {
    return null
  }
}

async function cliVersion(cliPath) {
  try {
    const { stdout } = await run(cliPath, ['--version'], { timeout: 6000, windowsHide: true })
    return stdout.trim().split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

/** Locate the Claude Code CLI. Returns { found, path, version }. */
export async function detectCli(platform = process.platform) {
  const found = (await fromPath(platform)) || cliCandidates(platform).find(isFile) || null
  if (!found) return { found: false, path: null, version: null, installCommand: INSTALL_COMMAND }
  return { found: true, path: found, version: await cliVersion(found), installCommand: INSTALL_COMMAND }
}

// Terminal emulators to try on Linux, in rough order of desktop prevalence.
const LINUX_TERMINALS = [
  { file: 'x-terminal-emulator', flag: '-e' },
  { file: 'gnome-terminal', flag: '--' },
  { file: 'konsole', flag: '-e' },
  { file: 'xfce4-terminal', flag: '-e' },
  { file: 'xterm', flag: '-e' }
]

export function linuxTerminal(dirs = (process.env.PATH || '').split(path.delimiter)) {
  for (const t of LINUX_TERMINALS) {
    if (dirs.some((d) => d && isFile(path.join(d, t.file)))) return t
  }
  return null
}

// AppleScript string literal: backslashes and double quotes must be escaped or
// the `do script` line terminates early.
function osaQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the spawn descriptor that opens a terminal running the CLI. Pure, so
 * the per-platform shape is unit-testable without spawning anything.
 * Returns { file, args } or null when no terminal is available.
 */
export function loginCommand(cliPath, platform = process.platform, terminal = null) {
  if (!cliPath) return null
  if (platform === 'win32') {
    // `start` is a cmd builtin. The empty string is the window title, which
    // `start` otherwise steals from the quoted command path.
    return { file: 'cmd.exe', args: ['/c', 'start', '', 'cmd', '/k', cliPath] }
  }
  if (platform === 'darwin') {
    const script = `tell application "Terminal"\nactivate\ndo script "${osaQuote(`'${cliPath}'`)}"\nend tell`
    return { file: 'osascript', args: ['-e', script] }
  }
  if (!terminal) return null
  return { file: terminal.file, args: [terminal.flag, cliPath] }
}

/**
 * Open a terminal running `claude` so the user can type /login. We cannot type
 * it for them — it is an interactive browser-backed flow by design.
 */
export async function launchLogin() {
  const cli = await detectCli()
  if (!cli.found) return { ok: false, reason: 'cli-not-found', installCommand: INSTALL_COMMAND }
  const terminal = process.platform === 'linux' ? linuxTerminal() : null
  const cmd = loginCommand(cli.path, process.platform, terminal)
  if (!cmd) return { ok: false, reason: 'no-terminal', cliPath: cli.path }
  try {
    const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { ok: true, cliPath: cli.path }
  } catch (err) {
    return { ok: false, reason: err?.code || 'spawn-failed', cliPath: cli.path }
  }
}

/**
 * Save a pasted token only if it actually authenticates. A stored token that
 * silently does nothing is worse than no token at all, so verification is not
 * optional here.
 */
export async function saveManualToken(token) {
  const trimmed = token == null ? '' : String(token).trim()
  if (!trimmed) {
    setManualToken(null)
    return { ok: true, cleared: true }
  }
  const probe = await probeUsage(trimmed)
  if (!probe.ok) return { ok: false, ...probe }
  setManualToken(trimmed)
  return { ok: true, ...probe }
}

/** Combined state for the Connect Claude panel. */
export async function connectStatus() {
  const cli = await detectCli()
  return { cli, auth: authStatus() }
}
