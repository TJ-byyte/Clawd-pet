const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clawd', {
  get: () => ipcRenderer.invoke('clawd:get'),
  set: patch => ipcRenderer.invoke('clawd:set', patch),
  quit: () => ipcRenderer.send('clawd:quit'),
  activity: label => ipcRenderer.send('clawd:activity', label),
  onSettings: fn => ipcRenderer.on('clawd:settings', (_e, s) => fn(s)),
  onGeometry: fn => ipcRenderer.on('clawd:geometry', (_e, g) => fn(g)),
  onActivity: fn => ipcRenderer.on('clawd:activity', (_e, label) => fn(label)),
})
