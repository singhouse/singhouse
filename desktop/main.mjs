// SPDX-License-Identifier: AGPL-3.0-only
import { app, BrowserWindow, session, dialog, Menu, screen, powerSaveBlocker, ipcMain, shell, safeStorage } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { collectHardware } from './hardware_inventory.mjs'
import { validateShippedCatalog } from './setup_catalog.mjs'
import { ModalCredentials } from './modal_credentials.mjs'
import { checkModalConnection } from './modal_connection.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLaunch, ownURL, allowedRequest, allowSpeaker, childEnvironment, sameIdentity, validateManifest, CSP } from './policy.mjs'
import { projectorBlocker, createRuntime, persistentRuntime, stopRuntime, watchOwnedGroup, forceChild } from './lifecycle.mjs'
import { RuntimeManager, ModelCache, launchSelection, processingAttestation } from './runtime_manager.mjs'
import { authorizedHeartCaller } from './heart_setup.mjs'
import { OnboardingSetup } from './onboarding_setup.mjs'
import { OnboardingState, onboardingPreferences, restartForSetup } from './onboarding_state.mjs'
import { createStartupSurface } from './startup.mjs'
import { assertReleaseIdentity, assertReleasePolicy, canonicalJson, deriveReleaseIdentity } from './release.mjs'
import { completeActivationHandoff, completeManualRestoreHandoff, confirmRenderedFrame, DatabaseGuard, OperationGate, RecoveryStore, UpdateController, UpdateStore, describeStagedUpdate, installationBoundaryBusy, presentAndCompleteStartup } from './update_manager.mjs'
import { managedBootstrapArguments, runRecoveryAnchor, waitForReady } from './bootstrap.mjs'
import { ensureRecoveryAnchor, installRecoveryKit, readOnlyAppImageMount, readRecoveryAnchor, stableFirstInstallerExecutable, verifiedAppImageRuntime } from './recovery_launcher.mjs'
import { assertNativeInventoryDeclared, declaredApplicationDigest, observeReceiptApplication, physicalApplicationRecords, physicalFileHash, readLaunchInventory, readOnlyApplicationRoot, writeLaunchInventory } from './application_inventory.mjs'
import { verifyWindowsAuthenticode } from './windows_signing.mjs'
import { inspectInstalledLaunchBoundary } from './macos_signing.mjs'

const physicalFs = createRequire(import.meta.url)('original-fs')

const desktopDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(desktopDir, '..')
const packaged = app.isPackaged
const nativeDir = resolve(process.resourcesPath, 'native')
const releasePolicyPath = packaged ? resolve(process.resourcesPath, 'release.json') : resolve(desktopDir, 'release.json')
let brand = 'singhouse'
if (!packaged) {
  const names = await import(pathToFileURL(resolve(root, 'frontend/src/brand.js')).href)
  brand = names.BRAND_NAME
  app.setName(names.BRAND_INSTALLED_NAME)
}
const ownsInstance = !packaged || app.requestSingleInstanceLock()
const runtime = ownsInstance ? (packaged ? persistentRuntime(app.getPath('userData')) : createRuntime()) : null
if (!packaged) app.setPath('userData', runtime.electron)
let expectedIdentity
let processingManager, modelCache, activeProcessing, activeModels, processingError, processingStatus
let processingProbe
let installation
let processingOperation
let heartSetup
let onboardingSetup, onboardingState, startupSurface, modalCredentials, modalCheck, modalCheckController
let modalLoadedFingerprint = null
let productRelease, releasePolicy, updates, updateOperation, startupHandoff
let managedReleaseSlot = false
let releaseState = async () => ({ activeMutations: null, jobs: { nonterminal: null } }), quiesceBackend, resumeBackend
let controlToken = ''
if (!ownsInstance) app.quit()
app.on('second-instance', () => { if (host) { if (host.isMinimized()) host.restore(); host.show(); host.focus() } })
let backend, host, projector, quitting = false, shutdownComplete = false, handingOff = false
let recoveryKitDurability = null, recoveryAnchor = null
const operationGate = new OperationGate()
let popupReserved = false
const blocker = projectorBlocker(powerSaveBlocker)

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function digestRecords(entries) { return hash(canonicalJson(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))))) }
async function installedReleaseIdentity() {
  const manifest = expectedIdentity
  const filesBytes = readFileSync(resolve(nativeDir, 'files.json'))
  if (hash(filesBytes) !== manifest.runtimeId) throw new Error('Installed native inventory identity mismatch')
  const files = JSON.parse(filesBytes)
  // The managed-slot and signed macOS paths hash the native payload here. A
  // receipt-described installation instead binds files.json to its receipt's
  // declarations below, without reading the payload at launch.
  const hashNativePayload = () => {
    for (const [name, expected] of Object.entries(files)) {
      const path = resolve(nativeDir, ...name.split('/'))
      if (hash(readFileSync(path)) !== expected) throw new Error(`Installed native payload changed: ${name}`)
    }
  }
  const provenance = JSON.parse(readFileSync(resolve(nativeDir, 'provenance.json'), 'utf8'))
  const assemblyBytes = readFileSync(resolve(nativeDir, 'assembly.json'))
  const assembly = JSON.parse(assemblyBytes)
  if (assembly.edition !== releasePolicy.edition) throw new Error('Installed assembly and release policy editions differ')
  if (provenance.sourceDirty !== false || provenance.sourceExport !== false) throw new Error('Installed release lacks clean source provenance')
  const frontend = Object.entries(files).filter(([name]) => name.startsWith('static/'))
  const backendFiles = Object.entries(files).filter(([name]) => name === 'backend.py' || /site-packages\/(karaoke_backend|lyricsync)\//.test(name))
  if (!frontend.length || !backendFiles.length || !files['models.json']) throw new Error('Installed release evidence is incomplete')
  const applicationRoot = process.platform === 'darwin' ? resolve(process.resourcesPath, '../../..') : resolve(process.resourcesPath, '..')
  const { marker: signedMarker, portableBytes } = await inspectInstalledLaunchBoundary({
    platform: process.platform, resourcesPath: process.resourcesPath, applicationRoot,
  })
  if (portableBytes !== null) {
    hashNativePayload()
    const portable = JSON.parse(portableBytes)
    const identity = assertReleaseIdentity(portable.identity)
    if (identity.edition !== releasePolicy.edition || identity.policyId !== releasePolicy.policyId) throw new Error('Installed managed release belongs to a different edition policy')
    managedReleaseSlot = true
    return identity
  }
  const receiptPath = resolve(process.resourcesPath, 'release-receipt.json')
  const bundle = process.platform === 'darwin' ? resolve(process.resourcesPath, '../..') : applicationRoot
  const leading = process.platform === 'darwin' ? [[relative(applicationRoot, bundle).split(sep).join('/'), 'directory']] : []
  if (signedMarker) {
    hashNativePayload()
    const records = [...leading, ...physicalApplicationRecords(applicationRoot, physicalFs, bundle)]
    if (existsSync(receiptPath)) throw new Error('Signed macOS application must keep its release receipt outside the sealed bundle')
    const observed = records.map(([path, value]) => value === 'directory' ? { path, type: 'directory' }
      : value.startsWith('symlink:') ? { path, type: 'symlink', target: value.slice('symlink:'.length) }
        : { path, type: 'file', sha256: value })
    const inventoryDigest = hash(canonicalJson(observed))
    const asarRelative = relative(applicationRoot, app.getAppPath()).split(sep).join('/')
    const nativePrefix = `${relative(applicationRoot, nativeDir).split(sep).join('/')}/`
    const electronRecords = records.filter(([name]) => name !== asarRelative && !name.startsWith(nativePrefix))
    if (!electronRecords.length) throw new Error('Installed Electron runtime evidence is incomplete')
    return deriveReleaseIdentity({ schema: 1, appVersion: manifest.appVersion, edition: assembly.edition, policyId: releasePolicy.policyId,
      sourceCommit: provenance.sourceCommit, electronVersion: process.versions.electron,
      electronRuntimeDigest: digestRecords(electronRecords), electronAppDigest: physicalFileHash(app.getAppPath(), physicalFs),
      frontendDigest: digestRecords(frontend), backendDigest: digestRecords(backendFiles), nativeRuntimeId: manifest.runtimeId,
      runtimeLocksDigest: hash(canonicalJson(provenance.locks)), modelPolicyDigest: files['models.json'],
      schemaHistory: releasePolicy.schemaHistory, assemblyDigest: hash(assemblyBytes), applicationInventoryDigest: inventoryDigest,
      ...(assembly.pairedCoreReleaseId ? { pairedCoreReleaseId: assembly.pairedCoreReleaseId } : {}) })
  }
  if (!existsSync(receiptPath)) throw new Error('Installed first-launch application lacks its release receipt')
  const receiptBytes = readFileSync(receiptPath, 'utf8'), receipt = JSON.parse(receiptBytes)
  if (receiptBytes !== `${canonicalJson(receipt)}\n`) throw new Error('Installed release receipt is not canonical')
  // Content is hashed at launch only where it can change underneath the
  // receipt. A read-only AppImage mount (kernel evidence) carries its receipt
  // in the same immutable image, so digests come from the receipt. A writable
  // installation is hashed in full on its first launch (or whenever its
  // launch inventory is missing or stale); later launches compare each file's
  // size, modification and change times, inode and device with that
  // inventory. Every path still walks
  // every entry's type and symlink target against the receipt.
  const readOnly = process.platform === 'linux' && readOnlyApplicationRoot(readOnlyAppImageMount(), applicationRoot)
  const launchInventoryPath = resolve(runtime.root, 'launch-inventory.json')
  // The cache is bound to the canonical root, so a different installation
  // reached through the same path never matches it.
  const inventoryRoot = physicalFs.realpathSync.native(applicationRoot)
  const observed = observeReceiptApplication({ rootDirectory: applicationRoot, current: bundle, leading, physicalFs, receipt,
    target: { platform: process.platform, arch: process.arch }, readOnly, inventoryRoot,
    launchInventory: readOnly ? null : await readLaunchInventory(launchInventoryPath) })
  const identity = observed.identity
  if (identity.edition !== releasePolicy.edition || identity.policyId !== releasePolicy.policyId) throw new Error('Installed release receipt belongs to a different edition policy')
  const asarRelative = relative(applicationRoot, app.getAppPath()).split(sep).join('/')
  const nativePrefix = `${relative(applicationRoot, nativeDir).split(sep).join('/')}/`
  const modeled = receipt.application.files.map(record => [record.path, record.type === 'file' ? record.sha256
    : record.type === 'directory' ? 'directory' : `symlink:${record.target}`])
  assertNativeInventoryDeclared(files, receipt, nativePrefix)
  const electronAppDigest = declaredApplicationDigest(receipt, asarRelative)
  const electronRecords = modeled.filter(([name]) => name !== asarRelative && !name.startsWith(nativePrefix))
  if (!electronRecords.length) throw new Error('Installed Electron runtime evidence is incomplete')
  const derived = deriveReleaseIdentity({ schema: 1, appVersion: manifest.appVersion, edition: assembly.edition, policyId: releasePolicy.policyId,
    sourceCommit: provenance.sourceCommit, electronVersion: process.versions.electron,
    electronRuntimeDigest: digestRecords(electronRecords), electronAppDigest, frontendDigest: digestRecords(frontend),
    backendDigest: digestRecords(backendFiles), nativeRuntimeId: manifest.runtimeId,
    runtimeLocksDigest: hash(canonicalJson(provenance.locks)), modelPolicyDigest: files['models.json'],
    schemaHistory: releasePolicy.schemaHistory, assemblyDigest: hash(assemblyBytes),
    applicationInventoryDigest: receipt.application.inventoryDigest,
    ...(assembly.pairedCoreReleaseId ? { pairedCoreReleaseId: assembly.pairedCoreReleaseId } : {}) })
  if (derived.releaseId !== identity.releaseId) throw new Error('Installed release receipt does not match its modeled application evidence')
  if (observed.launchInventory && !await writeLaunchInventory(launchInventoryPath, observed.launchInventory,
    { lockPython: recoveryKitDurability?.pythonPath, durabilityHelper: recoveryKitDurability?.backendHelperPath })) {
    console.warn('Could not record the application launch inventory; the next launch checks every file in full.')
  }
  return identity
}

async function platformTrust({ root: applicationRoot, manifest }) {
  if (process.platform === 'linux') return true
  if (!releasePolicy.platformTrust?.[process.platform]?.enabled) return false
  if (process.platform === 'darwin') {
    const parts = manifest.entrypoint.split('/'), end = parts.findIndex(part => part.endsWith('.app'))
    if (end < 0) return false
    return new Promise(resolveTrust => {
      const check = spawn('/usr/bin/codesign', ['--verify', '--deep', '--strict', resolve(applicationRoot, ...parts.slice(0, end + 1))], { stdio: 'ignore' })
      check.once('error', () => resolveTrust(false)); check.once('exit', code => resolveTrust(code === 0))
    })
  }
  if (process.platform === 'win32') {
    const entrypoint = resolve(applicationRoot, ...manifest.entrypoint.split('/'))
    const relativeEntrypoint = relative(applicationRoot, entrypoint)
    if (!relativeEntrypoint || relativeEntrypoint.startsWith(`..${sep}`) || isAbsolute(relativeEntrypoint)) return false
    return verifyWindowsAuthenticode(entrypoint)
  }
  return false
}

async function verifiedFirstInstallerPlatformTrust() {
  // A bundled receipt cannot authenticate the wrapper that supplied it.
  // Kernel-owned ancestry and the read-only FUSE mount bind Linux to its exact
  // outer AppImage. APPIMAGE/APPDIR remain diagnostic hints, never authority.
  if (process.platform === 'linux') {
    try { return { verified: true, appImage: verifiedAppImageRuntime() } }
    catch { return { verified: false, appImage: null } }
  }
  if (!releasePolicy.platformTrust?.[process.platform]?.enabled) return { verified: false }
  if (process.platform === 'darwin') return new Promise(resolveTrust => {
    const check = spawn('/usr/bin/codesign', ['--verify', '--deep', '--strict', resolve(process.resourcesPath, '../..')], { stdio: 'ignore' })
    check.once('error', () => resolveTrust({ verified: false })); check.once('exit', code => resolveTrust({ verified: code === 0 }))
  })
  // The installed application can be verified above, but Windows does not
  // retain the outer NSIS installer as a durable first-install anchor. Keep
  // first-installer recovery admission closed until that evidence is modeled.
  return { verified: false }
}

async function startManagedBootstrap({ stable = false } = {}) {
  const python = resolve(nativeDir, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3')
  const helper = resolve(nativeDir, 'backend.py')
  const args = managedBootstrapArguments({ bootstrapPath: resolve(desktopDir, 'bootstrap.mjs'), stateRoot: runtime.root,
    parentPid: process.pid, pythonPath: python, helperPath: helper, releasePolicyPath, stable })
  const child = spawn(process.execPath, args, {
    detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  await waitForReady(child); child.stdout.destroy(); child.unref()
}

async function launchBackend() {
  if (packaged) expectedIdentity = validateManifest(JSON.parse(readFileSync(resolve(nativeDir, 'manifest.json'), 'utf8')), app.getVersion(), process.platform, process.arch)
  const python = packaged ? resolve(nativeDir, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3') : process.env.KARAOKE_DESKTOP_PYTHON
  if (!python || !isAbsolute(python)) throw new Error('Set KARAOKE_DESKTOP_PYTHON to an absolute executable path in a dedicated core-only environment.')
  const args = ['-I', '-B', packaged ? resolve(nativeDir, 'backend.py') : resolve(desktopDir, 'backend.py'), ...(packaged ? ['--native', nativeDir] : ['--root', root]), '--runtime', runtime.backend]
  // Directory names may be shortened; the backend checks each manifest against the full identity.
  if (activeProcessing) args.push('--processing', activeProcessing.directory, '--processing-id', activeProcessing.id)
  if (processingProbe) args.push('--processing-probe', JSON.stringify(processingProbe))
  if (activeModels) args.push('--models', activeModels.directory, '--models-id', activeModels.id)
  let privateModal = null
  if (packaged) {
    args.push('--desktop-config-stdin')
    const preferences = onboardingPreferences((await onboardingState.read())?.preferences)
    if (preferences.choice === 'modal') {
      try { privateModal = await modalCredentials.readForBackend() } catch { /* Playback still starts when a keyring is unavailable. */ }
    }
    modalLoadedFingerprint = privateModal ? createHash('sha256').update(JSON.stringify(privateModal)).digest('hex') : null
  }
  if (!packaged && process.argv.includes('--demo')) args.push('--demo')
  backend = spawn(python, args, { cwd: packaged ? nativeDir : desktopDir, env: childEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: packaged && process.platform !== 'win32' })
  if (packaged) {
    backend.stdin.on('error', () => {})
    backend.stdin.write(JSON.stringify({ schema: 1, modal: privateModal }) + '\n')
    privateModal = null
  }
  if (packaged && process.platform !== 'win32') watchOwnedGroup(backend)
  // stdout is a private one-line credential channel. Never forward it to logs.
  backend.stderr.on('data', data => process.stderr.write(data))
  backend.once('exit', (code, signal) => {
    if (!quitting && !handingOff && host) {
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

async function boundaryState() {
  let state
  try { state = await releaseState() } catch { state = null }
  return { projectorOpen: Boolean(projector), audible: host?.webContents.isCurrentlyAudible() === true,
    activeJobs: state?.jobs?.nonterminal ?? null,
    installing: Boolean(onboardingSetup?.operation) || installationBoundaryBusy({ installation, processingManager, modelCache, heartSetup, processingOperation }),
    backendReady: Boolean(host) && backend?.exitCode === null && backend?.signalCode === null }
}

function runUpdateOperation(action) {
  if (updateOperation || quitting) return
  updateOperation = operationGate.run('release operation', action).catch(error => { if (!quitting && !error.backendStopped) dialog.showErrorBox('Release operation did not complete', error.message) })
    .finally(() => { updateOperation = null; host?.setProgressBar(-1) })
}

function runProcessingOperation(kind, action) {
  if (processingOperation || quitting || handingOff) return
  processingOperation = operationGate.run(kind, action)
    .catch(error => { if (!quitting) dialog.showErrorBox('Processing operation did not complete', error.message) })
    .finally(() => { processingOperation = null; host?.setProgressBar(-1) })
}

async function stageUpdate() {
  const choice = await dialog.showOpenDialog(host, { title: 'Select authenticated update metadata', properties: ['openFile'],
    filters: [{ name: `${brand} update metadata`, extensions: ['json'] }] })
  if (choice.canceled || !choice.filePaths.length) return
  const metadataPath = choice.filePaths[0], metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  const signed = await updates.updates.validate(metadata)
  const bytes = signed.files.reduce((sum, file) => sum + file.size, 0)
  const answer = await dialog.showMessageBox(host, { type: 'question', buttons: ['Cancel', 'Stage and verify'], defaultId: 0,
    cancelId: 0, message: `Stage release ${signed.identity.releaseId.slice(0, 12)}?`,
    detail: `${Math.ceil(bytes / 1024 / 1024)} MiB. Both target and exact rollback applications are authenticated. The running application is unchanged.` })
  if (answer.response !== 1) return
  installation = new AbortController()
  try { await updates.stage(metadata, { artifactDirectory: dirname(metadataPath), signal: installation.signal }) }
  finally { installation = null }
  await dialog.showMessageBox(host, { message: 'Update and rollback applications are staged and verified.' })
}

async function applyUpdate() {
  const review = await updates.review()
  if (!review) return dialog.showMessageBox(host, { message: 'No authenticated update is staged.' })
  const ready = review.plan.ok && review.boundary.safe
  const answer = await dialog.showMessageBox(host, { type: ready ? 'question' : 'warning',
    buttons: ready ? ['Cancel', 'Back up and update'] : ['Close'], defaultId: 0, cancelId: 0,
    message: ready ? 'Apply this update now?' : 'The update cannot start yet', detail: describeStagedUpdate(review) })
  if (!ready || answer.response !== 1) return
  const muted = host.webContents.isAudioMuted(); host.webContents.setAudioMuted(true); host.hide()
  try {
    handingOff = true
    await completeActivationHandoff({
      activate: () => updates.activate({ stopBackend: () => stopRuntime(backend, runtime),
        backendLive: () => backend?.exitCode === null && backend?.signalCode === null,
        prepareRecovery: (previous, binding) => {
          const id = `kit-${binding.recoveryPoint}`
          const manifest = installRecoveryKit({ recoveryRoot: resolve(runtime.root, 'recovery-tool', 'kits', id),
            targetRoot: previous.root, target: { platform: previous.platform, arch: previous.arch, entrypoint: previous.entrypoint }, files: {
              'recovery_cli.mjs': resolve(desktopDir, 'recovery_cli.mjs'),
              'recovery_launcher.mjs': resolve(desktopDir, 'recovery_launcher.mjs'),
              'release.mjs': resolve(desktopDir, 'release.mjs'), 'release.json': releasePolicyPath,
            }, binding, anchor: recoveryAnchor, ...recoveryKitDurability })
          return { id, manifest }
        } }),
      startBootstrap: () => startManagedBootstrap(),
      present: handoff => dialog.showMessageBox({ message: 'The library is backed up and the authenticated update is ready.',
        detail: `Release ${handoff.releaseId.slice(0, 12)} will open after this launcher exits. Recovery point ${handoff.recoveryPoint} preserves the exact previous application/database pair.` }),
    })
  } catch (error) {
    if (!error.backendStopped) { handingOff = false; host?.webContents.setAudioMuted(muted); host?.show() }
    throw error
  } finally { if (handingOff) app.quit() }
}

async function backupLibrary() {
  const point = await updates.capture({ reason: 'manual' })
  await dialog.showMessageBox(host, { message: 'Library database backup verified.', detail: `Recovery point ${point.id}.` })
}

async function restoreLibrary() {
  const point = await updates.recoveryPoint()
  if (!point) return dialog.showMessageBox(host, { message: 'No verified manual recovery point is available.' })
  const answer = await dialog.showMessageBox(host, { type: 'warning', buttons: ['Cancel', 'Restore and close'], defaultId: 0,
    cancelId: 0, message: 'Restore this manual database backup?', detail: `Recovery point ${point.id}. Update-bound backups require the standalone paired recovery path.` })
  if (answer.response !== 1) return
  handingOff = true
  await completeManualRestoreHandoff({
    restore: () => updates.restore({ stopBackend: () => stopRuntime(backend, runtime),
      backendLive: () => backend?.exitCode === null && backend?.signalCode === null }),
    reset: () => { handingOff = false },
    quit: () => app.quit(),
  })
}

async function showUpdateRecovery() {
  const point = await updates.updateRecoveryPoint()
  if (!point) return dialog.showMessageBox(host, { message: 'No verified update recovery point is available.' })
  const launcher = resolve(runtime.root, 'recovery-tool', 'kits', point.recoveryKit.id,
    process.platform === 'win32' ? 'recover.cmd' : 'recover.sh')
  await dialog.showMessageBox(host, { type: 'info', message: 'Authenticated update recovery is available.',
    detail: `Recovery point ${point.id}. Use the standalone paired recovery launcher at ${launcher}. This action does not modify the application or database.` })
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
    ...(packaged ? [{ label: 'Release', submenu: [
      { label: 'Stage an update…', click: () => runUpdateOperation(stageUpdate) },
      { label: 'Review and apply staged update…', click: () => runUpdateOperation(applyUpdate) },
      { label: 'Back up library database', click: () => runUpdateOperation(backupLibrary) },
      { label: 'Restore manual database backup…', click: () => runUpdateOperation(restoreLibrary) },
      { label: 'Show update recovery information…', click: () => runUpdateOperation(showUpdateRecovery) },
    ] }] : []),
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
      { label: 'Advanced: install runtime or model manifest…', click: () => {
        runProcessingOperation('processing or model installation', installProcessing)
      } },
      { label: 'Set up song processing…', click: () => host?.webContents.send('setup:open') },
      { label: 'Cancel installation', click: () => { installation?.abort(); heartSetup?.cancel(); onboardingSetup?.cancel() } },
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
  startupSurface = createStartupSurface({ BrowserWindow, brand: 'singhouse', onClose: () => app.quit() })
  await startupSurface.ready
  if (quitting) return
  await startupSurface.update('Verifying application files…')
  if (quitting) return
  if (packaged) {
    const recoveryArguments = process.argv.slice(1)
    if (process.env.SINGHOUSE_RECOVERY_ANCHOR === '1' && recoveryArguments[0] === '--recovery-anchor') {
      if (recoveryArguments.length !== 6) throw new Error('Invalid stable recovery invocation')
      const lockPython = resolve(nativeDir, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3')
      const durabilityHelper = resolve(nativeDir, 'backend.py')
      const appImage = process.platform === 'linux' ? verifiedAppImageRuntime() : null
      await runRecoveryAnchor({ anchorPath: recoveryArguments[1], kitRoot: recoveryArguments[2], recoveryArgs: recoveryArguments.slice(3),
        executablePath: stableFirstInstallerExecutable({ verifiedAppImage: appImage }), bootstrapPath: resolve(desktopDir, 'bootstrap.mjs'),
        // Runtime recognition does not establish first-installer authority.
        // Preserve bootstrap's default platform trust, including Linux denial.
        pythonPath: lockPython, helperPath: durabilityHelper, verifiedAppImage: appImage })
      shutdownComplete = true; app.quit(); return
    }
    expectedIdentity = validateManifest(JSON.parse(readFileSync(resolve(nativeDir, 'manifest.json'), 'utf8')), app.getVersion(), process.platform, process.arch)
    const progress = ({ received, total }) => host?.setProgressBar(total ? received / total : 0)
    const lockPython = resolve(nativeDir, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3')
    const durabilityHelper = resolve(nativeDir, 'backend.py')
    recoveryKitDurability = { pythonPath: lockPython, backendHelperPath: durabilityHelper }
    releasePolicy = assertReleasePolicy(JSON.parse(readFileSync(releasePolicyPath, 'utf8')))
    productRelease = await installedReleaseIdentity()
    if (releasePolicy.updatesEnabled) {
      const anchorPath = resolve(runtime.root, 'recovery-tool', 'anchor.json')
      if (managedReleaseSlot) recoveryAnchor = readRecoveryAnchor(anchorPath)
      else {
        const installerTrust = await verifiedFirstInstallerPlatformTrust()
        recoveryAnchor = ensureRecoveryAnchor(anchorPath, {
          executablePath: stableFirstInstallerExecutable({ verifiedAppImage: installerTrust.appImage }),
          bootstrapPath: resolve(desktopDir, 'bootstrap.mjs'), pythonPath: lockPython,
          helperPath: durabilityHelper, platform: process.platform, arch: process.arch,
        }, { verifiedFirstInstaller: installerTrust.verified, verifiedAppImage: installerTrust.appImage })
      }
    }
    const expectedUpdate = { currentIdentity: productRelease, pairedCoreReleaseId: productRelease.pairedCoreReleaseId,
      platform: expectedIdentity.platform, arch: expectedIdentity.arch, lastSequence: -1 }
    const database = new DatabaseGuard({ python: lockPython, helper: durabilityHelper, dataDirectory: runtime.backend })
    updates = new UpdateController({ contract: releasePolicy, identity: productRelease, database, activity: boundaryState,
      quiesce: () => quiesceBackend(), resume: () => resumeBackend(),
      updates: new UpdateStore(resolve(runtime.root, 'updates'), releasePolicy, expectedUpdate,
        { progress, lockPython, durabilityHelper, stateRoot: runtime.root, platformTrust }),
      recovery: new RecoveryStore(resolve(runtime.root, 'recovery'), { lockPython, durabilityHelper, stateRoot: runtime.root }) })
    if (!managedReleaseSlot) {
      // A verified first installer may fall through to its attested shipped
      // application when update state is absent, safely empty after a failed
      // retrieval, or contains only an authenticated not-yet-applied stage
      // whose rollback is this exact release. Partial/corrupt state fails closed.
      const active = await updates.updates.authenticatedActive({ allowAbsentState: true })
      if (active && active.releaseId !== productRelease.releaseId) {
        await dialog.showMessageBox({ type: 'warning', message: 'Opening the authenticated updated application',
          detail: `The stable installation launcher selected active release ${active.releaseId.slice(0, 12)}.` })
        await startManagedBootstrap({ stable: true }); shutdownComplete = true; app.quit(); return
      }
    }
    // This uses only the attested shipped application and authenticated state;
    // no managed runtime, model adapter, database helper or backend has run.
    startupHandoff = await updates.reconcileStartup()
    if (startupHandoff?.state === 'redirect-target') {
      await dialog.showMessageBox({ type: 'warning', message: 'Opening the authenticated updated application',
        detail: `This exact handoff replaced ${productRelease.releaseId.slice(0, 12)} with ${startupHandoff.active.releaseId.slice(0, 12)}.` })
      await startManagedBootstrap(); shutdownComplete = true; app.quit(); return
    }
    if (startupHandoff?.state === 'release-mismatch') throw new Error('This launcher does not match the authenticated update handoff')
    const selected = await updates.updates.active({ handoff: startupHandoff?.journal })
    if (selected && selected.releaseId !== productRelease.releaseId) throw new Error('Managed application selection is not authenticated for this launcher')
    const names = await import(pathToFileURL(resolve(nativeDir, 'brand.mjs')).href)
    brand = names.BRAND_NAME
    if (typeof brand !== 'string' || !brand || typeof names.BRAND_INSTALLED_NAME !== 'string' || !names.BRAND_INSTALLED_NAME) throw new Error('Installed product name is invalid')
    app.setName(names.BRAND_INSTALLED_NAME)
    const processingPolicy = JSON.parse(readFileSync(resolve(desktopDir, 'processing-locks.json'), 'utf8'))
    if (processingPolicy.schema !== 1 || !Array.isArray(processingPolicy.lockSha256)) throw new Error('Invalid application processing lock policy')
    processingManager = new RuntimeManager(resolve(runtime.root, 'processing'), expectedIdentity, { progress, lockPython, durabilityHelper, nativeBin: resolve(nativeDir, 'ffmpeg/bin'), nativeRuntimeId: expectedIdentity.runtimeId, trustedLocks: processingPolicy.lockSha256 })
    modelCache = new ModelCache(resolve(runtime.root, 'model-cache'), JSON.parse(readFileSync(resolve(desktopDir, 'models.json'), 'utf8')), { progress, lockPython, durabilityHelper })
    // Launch uses the structural pack checks and the self-test result recorded
    // for this exact pack; payload hashes and a fresh self-test belong to
    // installation, repair and activation. The two stores are independent, so
    // their checks overlap; failures are reported in the same order as before.
    const selection = launchSelection(...await Promise.allSettled([
      (async () => {
        const active = await processingManager.active({ launch: true })
        if (!active) return { active }
        return { active, probe: processingAttestation(active, await processingManager.launchProbe(active)) }
      })(),
      modelCache.active({ launch: true }),
    ]))
    ;({ activeProcessing, processingProbe, activeModels, processingError } = selection)
  }
  await startupSurface.update('Starting your library…')
  if (quitting) return
  if (packaged) {
    onboardingState = new OnboardingState(resolve(runtime.root, 'onboarding.json'))
    modalCredentials = new ModalCredentials({ path: resolve(runtime.root, 'modal-config.enc'), safeStorage })
  }
  const launch = await launchBackend()
  controlToken = launch.controlToken
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
  await startupSurface.update(`Opening ${brand}…`)
  await fetchJSON('/api/auth/gate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: launch.origin }, body: JSON.stringify({ password: launch.password }) })
  launch.password = ''
  const me = await fetchJSON('/api/auth/me')
  processingStatus = () => fetchJSON('/api/features/processing')
  if (me.id !== 1 || me.gate_enabled !== true) throw new Error('Private backend gate is not enabled')
  if (packaged) {
    const control = () => ({ 'X-Singhouse-Desktop-Token': controlToken, Origin: launch.origin })
    releaseState = () => fetchJSON('/desktop-update-state', { headers: control() })
    quiesceBackend = () => fetchJSON('/desktop-quiesce', { method: 'POST', headers: control() })
    resumeBackend = () => fetchJSON('/desktop-release', { method: 'POST', headers: control() })
  }
  host = new BrowserWindow({ title: brand, width: 1440, height: 960, show: false,
    webPreferences: { session: ses, preload: resolve(desktopDir, 'preload.cjs'),
      additionalArguments: packaged ? ['--singhouse-managed-setup'] : [],
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, webviewTag: false, spellcheck: false } })
  secureContents(host.webContents, launch.origin, true)
  if (packaged) {
    const catalogPath = resolve(desktopDir, 'processing-catalog.json')
    // This is shipped application policy, never a renderer-selected URL or file.
    let catalog = null, catalogError, catalogText = null
    const rejectCatalog = () => { catalogError = 'The processing installation catalog could not be verified. Playback remains available; install a verified application update to repair setup.' }
    try { if (existsSync(catalogPath)) catalogText = readFileSync(catalogPath, 'utf8') }
    catch { rejectCatalog(); console.error('Could not read the processing installation catalog.') }
    // The same validation the packaging gate applied to this exact catalog.
    if (catalogText !== null) {
      try {
        catalog = validateShippedCatalog(catalogText, {
          identity: expectedIdentity, trustedLocks: processingManager.trustedLocks, modelPolicy: modelCache.policy,
          releaseChannel: releasePolicy.channel,
        })
      } catch (error) { rejectCatalog(); console.error(`Processing installation catalog rejected: ${error.message}`) }
    }
    onboardingSetup = new OnboardingSetup({ runtime: processingManager, cache: modelCache,
      policy: modelCache.policy, catalog, catalogError, releaseChannel: releasePolicy.channel, loaded: { runtimeId: activeProcessing?.id, modelsId: activeModels?.id },
      hardware: () => collectHardware({ getGPUInfo: () => app.getGPUInfo('basic') }),
      diskFree: async () => { const disk = await statfs(runtime.root); return disk.bavail * disk.bsize },
      load: async () => (await onboardingState.read())?.setup,
      save: state => onboardingState.save('setup', state) })
  }
  const authorizeSetup = event => {
    if (!authorizedHeartCaller(event, host, launch.origin) || quitting || handingOff) throw new Error('Setup is only available in the host window')
    if (!onboardingSetup) throw new Error('Managed setup is available in the installed desktop application.')
  }
  const setupHandler = (channel, action) => ipcMain.handle(channel, (event, ...args) => { authorizeSetup(event); return action(...args) })
  setupHandler('setup:preferences', async () => onboardingPreferences((await onboardingState.read())?.preferences))
  setupHandler('setup:save-preferences', value => onboardingState.save('preferences', onboardingPreferences(value)))
  setupHandler('setup:preflight', () => onboardingSetup.preflight())
  setupHandler('setup:model-source', async mode => {
    if (!['offline', 'upstream'].includes(mode)) throw new Error('Unknown model source')
    if (processingOperation || operationGate.active) throw new Error('Wait for the current installation to finish or cancel it.')
    if (mode === 'upstream') onboardingSetup.setOfflineModelsDirectory(null)
    else {
      const selected = await dialog.showOpenDialog(host, {
        title: 'Choose a complete model folder', properties: ['openDirectory'],
      })
      if (!selected.canceled && selected.filePaths.length === 1) onboardingSetup.setOfflineModelsDirectory(selected.filePaths[0])
    }
    return onboardingSetup.preflight()
  })
  setupHandler('setup:status', () => onboardingSetup.getStatus())
  setupHandler('setup:cancel', async () => { onboardingSetup.cancel(); return onboardingSetup.getStatus() })
  setupHandler('setup:modal-status', async () => {
    const status = await modalCredentials.status()
    let matchesLoaded = false
    if (status.configured) {
      try {
        const config = await modalCredentials.readForBackend()
        matchesLoaded = createHash('sha256').update(JSON.stringify(config)).digest('hex') === modalLoadedFingerprint
      } catch { /* Unavailable credentials cannot establish current readiness. */ }
    }
    const modal = (await processingStatus()).modal
    return { ...status, active: matchesLoaded && modal?.ready === true,
      releaseSupported: modal?.releaseSupported === true }
  })
  setupHandler('setup:modal-save', config => {
    if (modalCheck) throw new Error('Wait for the connection check to finish.')
    return modalCredentials.save(config)
  })
  setupHandler('setup:modal-forget', async () => {
    if (modalCheck) throw new Error('Wait for the connection check to finish.')
    return { ...await modalCredentials.forget(), releaseSupported: (await processingStatus()).modal?.releaseSupported === true }
  })
  setupHandler('setup:modal-check', async () => {
    if (modalCheck) return modalCheck
    modalCheckController = new AbortController()
    modalCheck = (async () => {
      const configuration = await modalCredentials.readForBackend()
      const contractPath = resolve(nativeDir, 'modal-contract.json')
      return checkModalConnection({ configuration, signal: modalCheckController.signal,
        python: resolve(nativeDir, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'),
        helper: resolve(nativeDir, 'modal_check.py'),
        contract: existsSync(contractPath) ? contractPath : undefined,
      })
    })().finally(() => { modalCheck = null; modalCheckController = null })
    return modalCheck
  })
  setupHandler('setup:help', topic => {
    const destinations = { pricing: 'https://modal.com/pricing', guide: 'https://modal.com/docs/guide',
      account: 'https://modal.com/signup', deployment: 'https://github.com/singhouse/singhouse/blob/main/docs/modal.md' }
    if (!Object.hasOwn(destinations, topic)) throw new Error('Unknown setup help destination')
    return shell.openExternal(destinations[topic])
  })
  setupHandler('setup:start', async request => {
    if (processingOperation || operationGate.active) throw new Error('Another installation or release operation is running.')
    let accept, reject
    const accepted = new Promise((resolve, fail) => { accept = resolve; reject = fail })
    processingOperation = operationGate.run('song processing setup', async () => {
      try {
        accept(await onboardingSetup.start({ consent: request?.consent === true, planId: request?.planId }))
        await onboardingSetup.operation
      } catch (error) { reject(error) }
    }).finally(() => { processingOperation = null; host?.setProgressBar(-1) })
    return accepted
  })
  setupHandler('setup:restart', () => operationGate.run('setup restart', () => restartForSetup({
    activity: boundaryState, quiesce: quiesceBackend, resume: resumeBackend,
    restart: () => { app.relaunch(); app.quit() },
  })))
  ipcMain.handle('heart:prepare', async event => {
    if (!authorizedHeartCaller(event, host, launch.origin) || quitting || handingOff) throw new Error('Heart setup is only available in the host window')
    // Development mode retains its explicitly configured backend environment.
    if (!packaged) return { installed: true, restartRequired: false }
    const status = await processingStatus()
    if (status.transcription?.ready === true && status.separation?.ready === true) return { installed: true, restartRequired: false }
    host.webContents.send('setup:open')
    return { installed: false, restartRequired: false, reason: 'Complete song processing setup before trying this action again.' }
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
  // A renderer failure during presentation belongs to startup's error path.
  // Quitting here would misclassify that failure as intentional cancellation.
  let presenting = packaged, rejectPresentation
  const presentationFailure = packaged ? new Promise((_, reject) => { rejectPresentation = reject }) : null
  host.webContents.on('render-process-gone', () => {
    projector?.destroy()
    if (presenting) rejectPresentation(new Error('Renderer exited before the application finished presenting'))
    else app.quit()
  })
  installMenu()
  if (packaged) startupHandoff = await presentAndCompleteStartup(updates, startupHandoff,
    { load: () => Promise.race([host.loadURL(launch.origin), presentationFailure]),
      ready: () => Promise.race([new Promise((resolveReady, reject) => {
        const shown = () => finish()
        const gone = () => finish(new Error('Renderer exited before the application was ready to show'))
        const closed = () => finish(new Error('Application window closed before it was ready to show'))
        const finish = error => {
          host?.off('ready-to-show', shown); host?.off('closed', closed)
          host?.webContents.off('render-process-gone', gone)
          if (error) reject(error); else resolveReady()
        }
        host.once('ready-to-show', shown); host.once('closed', closed); host.webContents.once('render-process-gone', gone)
      }), presentationFailure]),
      show: () => host.show(), confirm: async () => {
        // A crashed renderer may never settle its JavaScript/frame request.
        const evidence = await Promise.race([confirmRenderedFrame(host), presentationFailure])
        presenting = false
        return evidence
      } })
  else { await host.loadURL(launch.origin); host.show() }
  startupSurface.close()
}

app.on('before-quit', event => {
  if (shutdownComplete || !ownsInstance) return
  event.preventDefault()
  if (quitting) return
  if (updateOperation) {
    installation?.abort()
    void updateOperation.finally(() => app.quit())
    return
  }
  quitting = true
  installation?.abort()
  heartSetup?.cancel()
  onboardingSetup?.cancel()
  modalCheckController?.abort()
  startupSurface?.close()
  blocker.stop()
  projector?.destroy()
  host?.destroy()
  void Promise.all([stopRuntime(backend, runtime), processingOperation, heartSetup?.operation, onboardingSetup?.operation]).catch(() => {
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
  // Destroying the host during an intentional quit can reject pending startup
  // presentation. Let shutdown finish without opening a blocking error dialog.
  if (quitting) return
  startupSurface?.close()
  dialog.showErrorBox(`${brand} could not start`, error.message)
  app.quit()
})
