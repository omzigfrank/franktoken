import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, dialog } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Store from 'electron-store'
import { fetchAll } from './providers/registry.js'
import { fetchHub, mergeSnapshots } from './providers/hub.js'
import {
  claudeRoots,
  setManualToken,
  snapshotLiveCache,
  restoreLiveCache
} from './providers/claude.js'
import { resolvePreset } from './providers/util.js'
import { connectStatus, launchLogin, saveManualToken } from './claudeAuth.js'
import { IMPORT_ROOT } from './providers/chatgpt.js'
import { buildReportHtml } from './report.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
// out/main/index.js -> ../../resources resolves to the project root (dev)
// and to the asar root (prod, since resources/** is bundled via build.files).
const resourcesDir = path.join(__dirname, '../../resources')

const store = new Store({
  defaults: {
    pollSeconds: 5,
    launchAtLogin: true,
    theme: 'dark',
    bounds: { width: 1280, height: 820 },
    hubUrl: '',
    hubReadToken: '',
    // Last-resort Claude token pasted in Settings -> Connect Claude, used only
    // when the CLI's own credentials are unreadable on this machine.
    claudeAccessToken: '',
    // Last good account-wide windows. Persisted so a restart that lands on a
    // rate-limited API shows the numbers from minutes ago rather than N/A.
    claudeLiveCache: null,
    // analytics range: preset id + custom bounds (epoch ms)
    range: { preset: '30d', from: null, to: null, granularity: 'auto' }
  }
})

// Resolve the stored range spec into concrete {from,to,granularity} epoch ms.
// The arithmetic lives in providers/util.js so it can be unit-tested.
function resolveRange() {
  return resolvePreset(store.get('range'))
}

let tray = null
let win = null
let pollTimer = null
let lastSnapshots = []

// Register/unregister auto-launch on login, starting hidden in the background.
function setLogin(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true, // macOS: start in background
      args: ['--hidden'] // Windows/Linux marker that this is an auto-launch
    })
  } catch {
    /* ignore (e.g. unsupported platform) */
  }
}

function trayImage() {
  const img = nativeImage.createFromPath(path.join(resourcesDir, 'tray.png'))
  const resized = img.resize({ width: 18, height: 18 })
  return resized
}

function createWindow() {
  const b = store.get('bounds')
  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    minWidth: 840,
    minHeight: 620,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0b0d12',
    resizable: true,
    skipTaskbar: false,
    title: 'FrankToken',
    icon: path.join(resourcesDir, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.on('close', (e) => {
    // hide instead of quit (tray app)
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('resize', () => {
    const [width, height] = win.getSize()
    store.set('bounds', { width, height })
  })
}

function positionNearTray() {
  if (!tray || !win) return
  try {
    const trayBounds = tray.getBounds()
    const winBounds = win.getBounds()
    const display = screen.getDisplayMatching(trayBounds)
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2)
    let y
    // taskbar at bottom (Windows) -> show above; tray at top (mac) -> below
    if (trayBounds.y > display.workArea.height / 2) {
      y = Math.round(display.workArea.y + display.workArea.height - winBounds.height - 8)
    } else {
      y = Math.round(trayBounds.y + trayBounds.height + 8)
    }
    x = Math.max(display.workArea.x + 8, Math.min(x, display.workArea.x + display.workArea.width - winBounds.width - 8))
    win.setPosition(x, y, false)
  } catch {
    /* ignore positioning errors */
  }
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    positionNearTray()
    win.show()
    win.focus()
  }
}

function fmtReset(ms) {
  if (!ms) return '—'
  const diff = ms - Date.now()
  if (diff <= 0) return 'now'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function updateTray(snaps) {
  if (!tray) return
  const lines = ['FrankToken — AI usage']
  let peak = 0
  for (const s of snaps) {
    if (!s.available) {
      lines.push(`• ${s.name}: not detected`)
      continue
    }
    const w = s.windows[0]
    if (w && w.usedPercent != null) {
      peak = Math.max(peak, w.usedPercent)
      lines.push(
        `• ${s.name}: ${Math.round(w.usedPercent)}% (${w.label}, resets ${fmtReset(w.resetsAt)})`
      )
    } else if (w) {
      lines.push(`• ${s.name}: limits N/A (${(s.tokens.total / 1e6).toFixed(1)}M tok)`)
    } else {
      lines.push(`• ${s.name}: ${(s.tokens.total / 1e6).toFixed(1)}M tok`)
    }
  }
  tray.setToolTip(lines.join('\n'))

  const menu = Menu.buildFromTemplate([
    { label: `Peak window: ${Math.round(peak)}%`, enabled: false },
    { type: 'separator' },
    ...snaps.map((s) => ({
      label: s.available
        ? `${s.name} — ${s.windows[0] && s.windows[0].usedPercent != null ? Math.round(s.windows[0].usedPercent) + '%' : (s.tokens.total / 1e6).toFixed(1) + 'M tok'}`
        : `${s.name} — not detected`,
      enabled: false
    })),
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => toggleWindow() },
    { label: 'Refresh now', click: () => poll() },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: store.get('launchAtLogin'),
      click: (item) => {
        store.set('launchAtLogin', item.checked)
        app.setLoginItemSettings({ openAtLogin: item.checked })
      }
    },
    { type: 'separator' },
    { label: 'Quit FrankToken', click: () => { app.isQuitting = true; app.quit() } }
  ])
  tray.setContextMenu(menu)
}

async function poll() {
  try {
    const range = resolveRange()
    const hub = { hubUrl: store.get('hubUrl'), hubReadToken: store.get('hubReadToken') }
    const [local, remote] = await Promise.all([
      fetchAll(range),
      fetchHub(hub, range).catch((error) => {
        console.error('hub poll failed', error)
        return []
      })
    ])
    lastSnapshots = mergeSnapshots(local, remote, range)
    // Keep the last successful live windows on disk for the next cold start.
    const live = snapshotLiveCache()
    if (live) store.set('claudeLiveCache', live)
    updateTray(lastSnapshots)
    if (win && !win.isDestroyed()) {
      win.webContents.send('snapshot:update', {
        snapshots: lastSnapshots,
        at: Date.now(),
        range: { spec: store.get('range'), resolved: resolveRange() }
      })
    }
  } catch (err) {
    // keep last good snapshots
    console.error('poll failed', err)
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  const sec = Math.max(5, Number(store.get('pollSeconds')) || 5)
  pollTimer = setInterval(poll, sec * 1000)
}

// ---- real-time file watching ---------------------------------------- //
// Session transcripts change the instant a surface streams a response, so a
// recursive watch on each provider's data root keeps the dashboard fresh
// within seconds instead of waiting for the next poll tick.
const watched = new Map() // dir -> FSWatcher
let watchDebounce = null

function onDataChanged() {
  if (watchDebounce) clearTimeout(watchDebounce)
  watchDebounce = setTimeout(() => {
    watchDebounce = null
    poll()
  }, 1200)
}

function watchRoots() {
  const roots = [
    ...claudeRoots().map((r) => path.join(r, 'projects')),
    path.join(os.homedir(), '.codex', 'sessions'),
    IMPORT_ROOT
  ]
  for (const dir of roots) {
    if (watched.has(dir)) continue
    try {
      if (!fs.existsSync(dir)) continue
      // Recursive fs.watch is supported on macOS, Windows, and Linux (Node 20+).
      const w = fs.watch(dir, { recursive: true }, onDataChanged)
      w.on('error', () => {
        try {
          w.close()
        } catch {
          /* already closed */
        }
        watched.delete(dir)
      })
      watched.set(dir, w)
    } catch {
      /* recursive watch unavailable — polling still covers updates */
    }
  }
}

function createTray() {
  tray = new Tray(trayImage())
  tray.setToolTip('FrankToken')
  tray.on('click', () => toggleWindow())
  tray.on('double-click', () => toggleWindow())
  updateTray([])
}

// ---- IPC ----
function payload() {
  return {
    snapshots: lastSnapshots,
    at: Date.now(),
    range: { spec: store.get('range'), resolved: resolveRange() }
  }
}
ipcMain.handle('snapshot:get', async () => {
  if (lastSnapshots.length === 0) await poll()
  return payload()
})
ipcMain.handle('snapshot:refresh', async () => {
  await poll()
  return payload()
})
// Set the analytics range and immediately re-scan.
ipcMain.handle('range:set', async (_e, spec) => {
  store.set('range', { ...store.get('range'), ...(spec || {}) })
  await poll()
  return payload()
})
ipcMain.handle('settings:get', () => store.store)
ipcMain.handle('settings:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch || {})) store.set(k, v)
  if (patch && 'pollSeconds' in patch) startPolling()
  if (patch && 'launchAtLogin' in patch) setLogin(!!patch.launchAtLogin)
  return store.store
})
// Export the shareable interactive HTML report (self-contained single file).
ipcMain.handle('report:export', async () => {
  if (lastSnapshots.length === 0) await poll()
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export FrankToken report',
    defaultPath: path.join(app.getPath('documents'), `franktoken-report-${stamp}.html`),
    filters: [{ name: 'HTML report', extensions: ['html'] }]
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  try {
    const html = buildReportHtml({
      snapshots: lastSnapshots,
      range: { spec: store.get('range'), resolved: resolveRange() },
      generatedAt: Date.now()
    })
    fs.writeFileSync(filePath, html)
    shell.showItemInFolder(filePath)
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
})
// --- Connect Claude ------------------------------------------------------ //
ipcMain.handle('claude:status', () => connectStatus())
ipcMain.handle('claude:launch-login', async () => {
  const result = await launchLogin()
  // The login writes credentials only after the user finishes in the browser,
  // so there is nothing to re-read yet. The file watcher on ~/.claude picks it
  // up, and the panel polls status while it is open.
  return result
})
ipcMain.handle('claude:set-token', async (_e, token) => {
  const result = await saveManualToken(token)
  // Persist only a token that verified, so a bad paste can't wedge startup.
  if (result.ok) {
    store.set('claudeAccessToken', result.cleared ? '' : String(token || '').trim())
    await poll()
  }
  return result
})

ipcMain.on('window:hide', () => win && win.hide())
ipcMain.on('window:minimize', () => win && win.minimize())
ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit() })
ipcMain.on('open:external', (_e, url) => shell.openExternal(url))

// single instance
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => toggleWindow())

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.hide()
    createWindow()
    createTray()
    setLogin(!!store.get('launchAtLogin'))
    // Re-arm a previously verified pasted token before the first poll, so live
    // limits survive a restart on machines with no readable CLI credentials.
    setManualToken(store.get('claudeAccessToken') || null)
    // Seed the live windows from the last run so the first paint after a
    // restart is not N/A while the API cooldown runs.
    restoreLiveCache(store.get('claudeLiveCache'))
    await poll()
    startPolling()
    watchRoots()
    // Data roots can appear after launch (first Claude session, first import
    // drop) — re-check for new roots once a minute.
    setInterval(watchRoots, 60_000)
  })

  app.on('window-all-closed', () => {
    // stay alive in tray
  })
  app.on('activate', () => toggleWindow())
}
