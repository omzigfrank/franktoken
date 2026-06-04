import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  refresh: () => ipcRenderer.invoke('snapshot:refresh'),
  setRange: (spec) => ipcRenderer.invoke('range:set', spec),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('snapshot:update', handler)
    return () => ipcRenderer.removeListener('snapshot:update', handler)
  },
  hide: () => ipcRenderer.send('window:hide'),
  minimize: () => ipcRenderer.send('window:minimize'),
  quit: () => ipcRenderer.send('app:quit'),
  openExternal: (url) => ipcRenderer.send('open:external', url)
})
