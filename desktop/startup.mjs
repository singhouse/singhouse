// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const startupLogo = readFileSync(new URL('./startup-logo.svg', import.meta.url), 'utf8')

const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])

function documentURL(brand, message) {
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(brand)}</title>
<style>
:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #141821; color: #F7E7C8; --brand-ink: #141821; --brand-cherry: #E23E57; --brand-cream: #F7E7C8; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { width: min(82vw, 360px); }
.mark { width: min(100%, 300px); margin: 0 auto 22px; }
.brand-logo { display: block; width: 100%; height: auto; }
.intro { margin: 0 0 25px; color: #F7E7C8; font-size: 14px; text-align: center; }
.status { border-top: 1px solid #3b4353; padding-top: 19px; min-height: 40px; color: #b8c0ce; font-size: 13px; line-height: 1.6; text-align: center; overflow-wrap: anywhere; }
</style></head><body><main><div class="mark" role="img" aria-label="${escapeHTML(brand)}">${startupLogo}</div>
<p class="intro">Getting your library ready.</p>
<p class="status" role="status" aria-live="polite">${escapeHTML(message)}</p></main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`
}

/** A separate, network-disabled window; no backend or renderer bridge needed. */
export function createStartupSurface({ BrowserWindow, brand = 'singhouse', onClose = () => {} }) {
  const window = new BrowserWindow({
    title: brand, width: 480, height: 380, show: true,
    backgroundColor: '#141821', resizable: false, maximizable: false,
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
