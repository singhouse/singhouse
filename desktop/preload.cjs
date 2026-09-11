// SPDX-License-Identifier: AGPL-3.0-only
const { contextBridge } = require('electron')
// No IPC, filesystem, process, credential, or generic message capability.
contextBridge.exposeInMainWorld('karaokeDesktop', Object.freeze({ isDesktop: true }))
