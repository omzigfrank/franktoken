import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Store from 'electron-store'
import { fetchAll } from './providers/registry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
// out/main/index.js -> ../../resources resolves to the project root (dev)
// and to the asar root (prod, since resources/** is bundled via build.files).
const resourcesDir = path.join(__dirname, '../../resources')

const store = new Store({
  defaults: {
    pollSeconds: 30,
    launchAtLogin: true,
    theme: 'dark',
    bounds: { width: 960, height: 700 },
    // analytics range: preset id + custom bounds (epoch ms)
    range: { preset: '30d', from: null, to: null, granularity: 'auto' }
  }
})

// Resolve the stored range spec into concrete {from,to,granularity} epoch ms.
function resolveRange() {
  const r = store.get('range') || { preset: '30d' }
  const now = Date.now()
  const presets = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }
  if (r.preset && r.preset !== 'custom') {
    const span = (r.preset === '24h' ? 1 : presets[r.preset] || 30) * 86_400_000
    return { from: now - span, to: now, granularity: r.granularity || 'auto' }
  }
  return {
    from: r.from ?? now - 30 * 86_400_000,
    to: r.to ?? now,
    granularity: r.granularity || 'auto'
  }
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
    minWidth: 720,
    minHeight: 520,
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
    lastSnapshots = await fetchAll(resolveRange())
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
  const sec = Math.max(10, Number(store.get('pollSeconds')) || 30)
  pollTimer = setInterval(poll, sec * 1000)
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
    await poll()
    startPolling()
  })

  app.on('window-all-closed', () => {
    // stay alive in tray
  })
  app.on('activate', () => toggleWindow())
}
