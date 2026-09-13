// SPDX-License-Identifier: AGPL-3.0-only
import { app, BrowserWindow, session, dialog, Menu, screen, powerSaveBlocker, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLaunch, ownURL, allowedRequest, allowSpeaker, childEnvironment, sameIdentity, validateManifest, CSP } from './policy.mjs'
import { projectorBlocker, createRuntime, persistentRuntime, stopRuntime, watchOwnedGroup, forceChild } from './lifecycle.mjs'
import { RuntimeManager, ModelCache, processingAttestation } from './runtime_manager.mjs'
import { HeartSetup, authorizedHeartCaller } from './heart_setup.mjs'

const desktopDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(desktopDir, '..')
const packaged = app.isPackaged
const nativeDir = resolve(process.resourcesPath, 'native')
const { BRAND_NAME: brand } = await import(pathToFileURL(packaged
  ? resolve(nativeDir, 'brand.mjs') : resolve(root, 'frontend/src/brand.js')).href)
app.setName(brand)
const ownsInstance = !packaged || app.requestSingleInstanceLock()
const runtime = ownsInstance ? (packaged ? persistentRuntime(app.getPath('userData')) : createRuntime()) : null
if (!packaged) app.setPath('userData', runtime.electron)
let expectedIdentity
let processingManager, modelCache, activeProcessing, activeModels, processingError, processingStatus
let processingProbe
let installation
let processingOperation
let heartSetup
if (!ownsInstance) app.quit()
app.on('second-instance', () => { if (host) { if (host.isMinimized()) host.restore(); host.show(); host.focus() } })
let backend, host, projector, quitting = false, shutdownComplete = false
let popupReserved = false
const blocker = projectorBlocker(powerSaveBlocker)

function launchBackend() {
  if (packaged) expectedIdentity = validateManifest(JSON.parse(readFileSync(resolve(nativeDir, 'manifest.json'), 'utf8')), app.getVersion(), process.platform, process.arch)
  const python = packaged ? resolve(nativeDir, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3') : process.env.KARAOKE_DESKTOP_PYTHON
  if (!python || !isAbsolute(python)) throw new Error('Set KARAOKE_DESKTOP_PYTHON to an absolute executable path in a dedicated core-only environment.')
  const args = ['-I', '-B', packaged ? resolve(nativeDir, 'backend.py') : resolve(desktopDir, 'backend.py'), ...(packaged ? ['--native', nativeDir] : ['--root', root]), '--runtime', runtime.backend]
  if (activeProcessing) args.push('--processing', activeProcessing.directory)
  if (processingProbe) args.push('--processing-probe', JSON.stringify(processingProbe))
  if (activeModels) args.push('--models', activeModels.directory)
  if (!packaged && process.argv.includes('--demo')) args.push('--demo')
  backend = spawn(python, args, { cwd: packaged ? nativeDir : desktopDir, env: childEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: packaged && process.platform !== 'win32' })
  if (packaged && process.platform !== 'win32') watchOwnedGroup(backend)
  // stdout is a private one-line credential channel. Never forward it to logs.
  backend.stderr.on('data', data => process.stderr.write(data))
  backend.once('exit', (code, signal) => {
    if (!quitting && host) {
      dialog.showErrorBox(`${brand} backend stopped`, `The backend exited (${signal || code}). Your library is preserved. Quit and reopen ${brand} to recover.`)
      app.quit()
    }
  })
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
      try { finish(null, parseLaunch(buffer.slice(0, end), expectedIdentity)) }
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
    ...(packaged ? [{ label: 'Processing', submenu: [
      { label: 'Processing readiness', click: async () => {
        try {
          const status = processingStatus ? await processingStatus() : { playback: { ready: true } }
          const labels = { playback: 'Playback', transcription: 'Transcription', separation: 'Stem separation', modal: 'User-owned Modal' }
          const detail = Object.entries(labels).map(([key, label]) => {
            const value = status[key]
            return `${label}: ${value?.ready ? 'Ready' : 'Not ready'}${value?.reason ? ` — ${value.reason}` : ''}`
          }).join('\n\n')
          await dialog.showMessageBox(host, { type: 'info', title: 'Processing readiness',
            message: processingError || 'Processing capabilities', detail })
        } catch (error) { dialog.showErrorBox('Processing readiness', error.message) }
      } },
      { label: 'Install processing runtime or model cache…', click: () => {
        if (!processingOperation) processingOperation = installProcessing().finally(() => { processingOperation = null })
      } },
      { label: 'Set up Heart transcription…', click: () => { if (!processingOperation) void heartSetup?.prepare() } },
      { label: 'Cancel installation', click: () => { installation?.abort(); heartSetup?.cancel() } },
    ] }] : []),
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }, { role: 'quit' }] },
  ]))
}

async function installProcessing() {
  if (installation || heartSetup?.operation) return
  const choice = await dialog.showOpenDialog(host, { title: 'Select a processing or upstream model manifest', properties: ['openFile'], filters: [{ name: 'Manifest', extensions: ['json'] }] })
  if (choice.canceled || !choice.filePaths.length) return
  try {
    const manifest = JSON.parse(readFileSync(choice.filePaths[0], 'utf8'))
    const manager = manifest.kind === 'models' ? modelCache : processingManager
    manager.validate(manifest)
    const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
    const consent = await dialog.showMessageBox(host, { type: 'warning', buttons: ['Cancel', 'Install'], defaultId: 0, cancelId: 0,
      message: manifest.kind === 'models' ? 'Install model files directly from declared upstream sources?' : 'Install this selected processing runtime?',
      detail: `${Math.ceil(bytes / 1024 / 1024)} MiB. ${manifest.kind === 'models' ? 'Model files are cached on this computer.' : 'Runtime packs contain executable code. Select only a manifest whose source you trust.'} Changes take effect after reopening the app. Existing library files are preserved.` })
    if (consent.response !== 1 || quitting) return
    installation = new AbortController()
    await manager.install(manifest, { signal: installation.signal })
    if (!quitting) await dialog.showMessageBox(host, { message: 'Installation verified. Reopen the app to use it.' })
  } catch (error) {
    if (!quitting) dialog.showErrorBox('Installation did not complete', error.message)
  } finally { installation = null; host?.setProgressBar(-1) }
}

async function start() {
  if (packaged) {
    expectedIdentity = validateManifest(JSON.parse(readFileSync(resolve(nativeDir, 'manifest.json'), 'utf8')), app.getVersion(), process.platform, process.arch)
    const progress = ({ received, total }) => host?.setProgressBar(total ? received / total : 0)
    const lockPython = resolve(nativeDir, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3')
    const durabilityHelper = resolve(nativeDir, 'backend.py')
    const processingPolicy = JSON.parse(readFileSync(resolve(desktopDir, 'processing-locks.json'), 'utf8'))
    if (processingPolicy.schema !== 1 || !Array.isArray(processingPolicy.lockSha256)) throw new Error('Invalid application processing lock policy')
    processingManager = new RuntimeManager(resolve(runtime.root, 'processing'), expectedIdentity, { progress, lockPython, durabilityHelper, nativeBin: resolve(nativeDir, 'ffmpeg/bin'), trustedLocks: processingPolicy.lockSha256 })
    modelCache = new ModelCache(resolve(runtime.root, 'model-cache'), JSON.parse(readFileSync(resolve(desktopDir, 'models.json'), 'utf8')), { progress, lockPython, durabilityHelper })
    try {
      activeProcessing = await processingManager.active()
      if (activeProcessing) {
        const probeResult = await processingManager.probe(activeProcessing)
        processingProbe = processingAttestation(activeProcessing, probeResult)
      }
    } catch (error) { activeProcessing = null; processingProbe = null; processingError = error.message }
    try { activeModels = await modelCache.active() }
    catch (error) { processingError = [processingError, error.message].filter(Boolean).join('\n') }
  }
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
      if (identity.nonce !== launch.nonce || (packaged && !sameIdentity(identity.identity, expectedIdentity))) throw new Error('Backend identity mismatch')
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
  processingStatus = () => fetchJSON('/api/features/processing')
  if (me.id !== 1 || me.gate_enabled !== true) throw new Error('Private backend gate is not enabled')
  host = new BrowserWindow({ title: brand, width: 1440, height: 960, show: false,
    webPreferences: { session: ses, preload: resolve(desktopDir, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, webviewTag: false, spellcheck: false } })
  secureContents(host.webContents, launch.origin, true)
  if (packaged) heartSetup = new HeartSetup({
    cache: modelCache, policy: modelCache.policy, loadedModels: activeModels,
    cancelled: () => quitting,
    progressDone: () => host?.setProgressBar(-1),
    runtimeReady: async () => (await processingStatus()).runtime?.capabilities?.includes('transcription') === true,
    consent: async ({ bytes, sources, revision, runtimeReady, repair }) => {
      const result = await dialog.showMessageBox(host, {
        type: 'question', title: 'Set up Heart transcription',
        message: repair ? 'Repair damaged Heart model files?' : 'Install Heart model files for local transcription?',
        detail: `${bytes.toLocaleString()} bytes (${(bytes / 1024 ** 3).toFixed(2)} GiB), from ${sources.join(', ')}.\nRevision: ${revision}\n\nFiles stay on this computer and can be used offline after setup. Reopening the application is required.\n\n${runtimeReady ? '' : 'A qualified local processing runtime is not currently ready. Installing model files alone does not enable transcription.\n\n'}Choose an existing Heart model folder for offline installation, or retrieve the pinned files from upstream.`,
        buttons: ['Cancel', 'Retrieve from upstream', 'Use existing folder'], defaultId: 0, cancelId: 0,
      })
      return ['cancel', 'upstream', 'directory'][result.response]
    },
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog(host, { title: 'Select the complete Heart model folder', properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    },
    notify: (message, failed = false) => dialog.showMessageBox(host, {
      type: failed ? 'error' : 'info', title: 'Heart transcription setup', message,
    }),
  })
  ipcMain.handle('heart:prepare', async event => {
    if (!authorizedHeartCaller(event, host, launch.origin) || quitting) throw new Error('Heart setup is only available in the host window')
    // Development mode retains its explicitly configured backend environment.
    if (!packaged) return { installed: true, restartRequired: false }
    if ((await processingStatus()).modal?.selected === true) return { installed: true, restartRequired: false }
    if (processingOperation) return { installed: false, restartRequired: false, reason: 'Another installation is running. Retry when it finishes.' }
    return heartSetup.prepare()
  })
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
  if (shutdownComplete || !ownsInstance) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  installation?.abort()
  heartSetup?.cancel()
  blocker.stop()
  projector?.destroy()
  host?.destroy()
  void Promise.all([stopRuntime(backend, runtime), processingOperation, heartSetup?.operation]).catch(() => {
    console.error('Could not complete desktop backend shutdown.')
  }).finally(() => { shutdownComplete = true; app.quit() })
})
app.on('window-all-closed', () => app.quit())
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit())
process.on('exit', () => {
  if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
    try { forceChild(backend) }
    catch (error) { if (error.code !== 'ESRCH') console.error('Could not stop the owned backend process.') }
  }
})
if (ownsInstance) app.whenReady().then(start).catch(error => {
  dialog.showErrorBox(`${brand} could not start`, error.message)
  app.quit()
})
