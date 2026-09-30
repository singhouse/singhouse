// SPDX-License-Identifier: AGPL-3.0-only
const { contextBridge, ipcRenderer } = require('electron')
// Fixed host-only setup actions; no renderer-selected paths or generic IPC.
// Modal credentials flow inward only; status never returns stored secrets.
contextBridge.exposeInMainWorld('karaokeDesktop', Object.freeze({
  isDesktop: true,
  managedSetup: process.argv.includes('--singhouse-managed-setup'),
  prepareHeart: () => ipcRenderer.invoke('heart:prepare'),
  getOnboardingState: () => ipcRenderer.invoke('setup:preferences'),
  setOnboardingState: state => ipcRenderer.invoke('setup:save-preferences', state),
  preflightSetup: () => ipcRenderer.invoke('setup:preflight'),
  chooseModelSource: mode => ipcRenderer.invoke('setup:model-source', mode),
  getModalStatus: () => ipcRenderer.invoke('setup:modal-status'),
  saveModalConfig: config => ipcRenderer.invoke('setup:modal-save', config),
  checkModalConnection: () => ipcRenderer.invoke('setup:modal-check'),
  forgetModalConfig: () => ipcRenderer.invoke('setup:modal-forget'),
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
