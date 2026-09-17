// SPDX-License-Identifier: AGPL-3.0-only
const { contextBridge, ipcRenderer } = require('electron')
// A fixed host-only setup action; no URLs, paths, credentials or generic IPC.
contextBridge.exposeInMainWorld('karaokeDesktop', Object.freeze({
  isDesktop: true,
  managedSetup: process.argv.includes('--singhouse-managed-setup'),
  prepareHeart: () => ipcRenderer.invoke('heart:prepare'),
  getOnboardingState: () => ipcRenderer.invoke('setup:preferences'),
  setOnboardingState: state => ipcRenderer.invoke('setup:save-preferences', state),
  preflightSetup: () => ipcRenderer.invoke('setup:preflight'),
  getSetupStatus: () => ipcRenderer.invoke('setup:status'),
  startSetup: request => ipcRenderer.invoke('setup:start', request),
  cancelSetup: () => ipcRenderer.invoke('setup:cancel'),
  restartApp: () => ipcRenderer.invoke('setup:restart'),
  openSetupHelp: topic => ipcRenderer.invoke('setup:help', topic),
  onOpenSetup: callback => {
    const listener = () => callback()
    ipcRenderer.on('setup:open', listener)
    return () => ipcRenderer.removeListener('setup:open', listener)
  },
}))
