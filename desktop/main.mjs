// SPDX-License-Identifier: AGPL-3.0-only
import { app, BrowserWindow, session, dialog, Menu, screen, powerSaveBlocker } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLaunch, ownURL, allowedRequest, allowSpeaker, childEnvironment, CSP } from './policy.mjs'
import { projectorBlocker, createRuntime, stopRuntime } from './lifecycle.mjs'

const desktopDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(desktopDir, '..')
const runtime = createRuntime()
app.setPath('userData', runtime.electron)
let backend, host, projector, quitting = false, shutdownComplete = false
let popupReserved = false
const blocker = projectorBlocker(powerSaveBlocker)
let brand = 'Karaoke'

function launchBackend() {
  const python = process.env.KARAOKE_DESKTOP_PYTHON
  if (!python || !isAbsolute(python)) throw new Error('Set KARAOKE_DESKTOP_PYTHON to an absolute executable path in a dedicated core-only environment.')
  const args = ['-I', '-B', resolve(desktopDir, 'backend.py'), '--root', root, '--runtime', runtime.backend]
  if (process.argv.includes('--demo')) args.push('--demo')
  backend = spawn(python, args, { cwd: desktopDir, env: childEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // stdout is a private one-line credential channel. Never forward it to logs.
  backend.stderr.on('data', data => process.stderr.write(data))
  backend.once('exit', () => { if (!quitting) app.quit() })
  return new Promise((resolveHandshake, reject) => {
    let buffer = ''
    const timer = setTimeout(() => finish(new Error('Backend launch timed out')), 60000)
    const onError = () => finish(new Error('Could not launch the backend executable'))
    const onExit = () => finish(new Error('Backend exited before becoming ready'))
    function finish(error, value) {
      clearTimeout(timer)
      backend.stdout.off('data', onData)
      backend.off('error', onError)
      backend.off('exit', onExit)
      if (error) reject(error)
      else resolveHandshake(value)
    }
    function onData(data) {
      buffer += data.toString('utf8')
      if (buffer.length > 4096) return finish(new Error('Invalid backend launch handshake'))
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try { finish(null, parseLaunch(buffer.slice(0, end))) }
      catch { finish(new Error('Invalid backend launch handshake')) }
      buffer = ''
    }
    backend.stdout.on('data', onData)
    backend.once('error', onError)
    backend.once('exit', onExit)
  })
}

function secureContents(contents, origin, isHost) {
  const preventNavigation = event => {
    if (!isHost || !ownURL(event.url, origin)) event.preventDefault()
  }
  contents.on('will-navigate', preventNavigation)
  contents.on('will-redirect', preventNavigation)
  contents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !isHost || !ownURL(event.url, origin)) event.preventDefault()
  })
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (!isHost || !host || contents !== host.webContents || !ownURL(contents.getURL(), origin)
        || url !== 'about:blank' || popupReserved || projector) return { action: 'deny' }
    popupReserved = true
    // about:blank inherits host WebPreferences. The existing DOM transport
    // relies on that native same-origin Window; do not replace its contents.
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
  })
}

function installSessionPolicy(ses, origin) {
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(details.url, origin) }))
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-security-policy') delete headers[key]
    headers['Content-Security-Policy'] = [CSP]
    callback({ responseHeaders: headers })
  })
  const granted = (contents, permission, details, url) => allowSpeaker({
    permission, hostId: host?.webContents.id, contentsId: contents?.id,
    isMainFrame: details.isMainFrame, url, origin,
  })
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    granted(contents, permission, details, details.requestingUrl || requestingOrigin))
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(granted(contents, permission, details, details.requestingUrl)))
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', event => event.preventDefault())
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: brand, submenu: [{ role: 'quit' }] }] : []),
    { label: 'Projector', submenu: [
      { label: 'Toggle fullscreen', accelerator: 'F11', click: () => { if (projector) projector.setFullScreen(!projector.isFullScreen()) } },
      { label: 'Move to next display', click: () => {
        if (!projector) return
        const displays = screen.getAllDisplays()
        const current = screen.getDisplayMatching(projector.getBounds())
        const target = displays[(displays.findIndex(display => display.id === current.id) + 1) % displays.length]
        projector.setFullScreen(false)
        projector.setBounds(target.workArea)
      } },
      { label: 'Close projector', click: () => projector?.close() },
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }, { role: 'quit' }] },
  ]))
}

async function start() {
  const branding = await import(pathToFileURL(resolve(root, 'frontend/src/brand.js')).href)
  brand = branding.BRAND_NAME
  app.setName(brand)
  const launch = await launchBackend()
  const ses = session.fromPartition(`desktop-${randomUUID()}`, { cache: false })
  await ses.setProxy({ mode: 'direct' })
  installSessionPolicy(ses, launch.origin)
  const fetchJSON = async (path, init = {}) => {
    const response = await ses.fetch(`${launch.origin}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('The private backend could not be authenticated')
    return response.json()
  }
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const identity = await fetchJSON('/desktop-ready')
      if (identity.nonce !== launch.nonce) throw new Error('Backend identity mismatch')
      ready = true
      break
    } catch (error) {
      if (error.message === 'Backend identity mismatch') throw error
      if (backend.exitCode !== null || backend.signalCode !== null) throw new Error('Backend stopped during launch')
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
  if (!ready) throw new Error('Private backend did not become ready')
  await fetchJSON('/api/auth/gate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: launch.origin }, body: JSON.stringify({ password: launch.password }) })
  launch.password = ''
  const me = await fetchJSON('/api/auth/me')
  if (me.id !== 1 || me.gate_enabled !== true) throw new Error('Private backend gate is not enabled')
  host = new BrowserWindow({ title: brand, width: 1440, height: 960, show: false,
    webPreferences: { session: ses, preload: resolve(desktopDir, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, webviewTag: false, spellcheck: false } })
  secureContents(host.webContents, launch.origin, true)
  host.webContents.on('did-create-window', child => {
    projector = child
    popupReserved = false
    child.webContents.setBackgroundThrottling(false)
    secureContents(child.webContents, launch.origin, false)
    child.setMenu(null)
    blocker.start()
    child.once('closed', () => { projector = null; blocker.stop() })
  })
  host.once('closed', () => { host = null; projector?.destroy(); app.quit() })
  host.webContents.on('render-process-gone', () => { projector?.destroy(); app.quit() })
  installMenu()
  await host.loadURL(launch.origin)
  host.show()
}

app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  blocker.stop()
  projector?.destroy()
  host?.destroy()
  void stopRuntime(backend, runtime).catch(() => {
    console.error('Could not remove the private desktop runtime directory.')
  }).finally(() => { shutdownComplete = true; app.quit() })
})
app.on('window-all-closed', () => app.quit())
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit())
process.on('exit', () => {
  if (backend && backend.exitCode === null && backend.signalCode === null) backend.kill('SIGKILL')
})
app.whenReady().then(start).catch(error => {
  dialog.showErrorBox(`${brand} could not start`, error.message)
  app.quit()
})
