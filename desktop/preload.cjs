// SPDX-License-Identifier: AGPL-3.0-only
const { contextBridge, ipcRenderer } = require('electron')
// A fixed host-only setup action; no URLs, paths, credentials or generic IPC.
contextBridge.exposeInMainWorld('karaokeDesktop', Object.freeze({
  isDesktop: true,
  prepareHeart: () => ipcRenderer.invoke('heart:prepare'),
}))
