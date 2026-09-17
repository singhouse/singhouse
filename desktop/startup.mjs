// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'

const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])

function documentURL(brand, message) {
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(brand)}</title>
<style>
:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101116; color: #f7f5ff; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { width: min(82vw, 360px); }
.mark { display: flex; align-items: center; gap: 5px; height: 44px; margin-bottom: 26px; }
.mark i { display: block; width: 7px; height: 22px; border-radius: 8px; background: #b9a2ff; }
.mark i:nth-child(2), .mark i:nth-child(4) { height: 34px; }
.mark i:nth-child(3) { height: 44px; background: #ddceff; }
h1 { font-size: 31px; font-weight: 650; letter-spacing: -.7px; margin: 0 0 10px; overflow-wrap: anywhere; }
.intro { margin: 0 0 30px; color: #b6b1c5; font-size: 14px; }
.status { border-top: 1px solid #34303f; padding-top: 19px; min-height: 40px; color: #e5dff1; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
</style></head><body><main><div class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
<h1>${escapeHTML(brand)}</h1><p class="intro">Getting your library ready.</p>
<p class="status" role="status" aria-live="polite">${escapeHTML(message)}</p></main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`
}

/** A separate, network-disabled window; no backend or renderer bridge needed. */
export function createStartupSurface({ BrowserWindow, brand = 'Singhouse', onClose = () => {} }) {
  const window = new BrowserWindow({
    title: brand, width: 480, height: 380, show: true,
    backgroundColor: '#101116', resizable: false, maximizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: `startup-${randomUUID()}`, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, javascript: false, webSecurity: true, allowRunningInsecureContent: false,
      devTools: false,
    },
  })
  let closed = false, programmatic = false, permittedURL = '', pending = null
  const contents = window.webContents
  const prevent = event => event.preventDefault()
  for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
    contents.on(event, prevent)
  }
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  contents.session.setPermissionCheckHandler(() => false)
  contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== permittedURL }))
  window.setMenu(null)
  window.on('closed', () => {
    closed = true
    if (!programmatic) onClose()
  })

  async function load(message) {
    if (closed || window.isDestroyed()) return false
    permittedURL = documentURL(brand, message)
    try {
      await window.loadURL(permittedURL)
      return !closed
    } catch {
      // Closing while a document loads is normal. The application startup
      // continues independently if this optional presentation cannot load.
      return false
    }
  }
  const ready = load('Starting the app…')
  let tail = ready
  return {
    ready,
    update(message) {
      if (closed || programmatic) return Promise.resolve(false)
      pending = String(message)
      tail = tail.then(async () => {
        if (pending === null) return !closed
        const latest = pending
        pending = null
        return load(latest)
      })
      return tail
    },
    close() {
      if (closed || programmatic) return
      programmatic = true
      pending = null
      if (!window.isDestroyed()) window.close()
    },
  }
}
