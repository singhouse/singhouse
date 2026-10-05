// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { presentAndCompleteStartup, confirmRenderedFrame } from '../update_manager.mjs'
import { stopRuntime } from '../lifecycle.mjs'

const source = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')
// Execute the production presentation tail, event registrations, and terminal
// startup catch verbatim. Earlier inventory/backend admission is outside this
// regression: fixtures provide an admitted backend and a newly created host.
const start = source.indexOf("  host.once('closed',")
assert.ok(start > 0)
const productionTail = `async function start() {\n${source.slice(start)}`

async function exercise(phase, intentionalQuit, failure = 'renderer') {
  const errors = [], calls = []
  let finish, reachPhase, rejectFrame, rejectLoad
  const finished = new Promise(resolve => { finish = resolve })
  const reached = new Promise(resolve => { reachPhase = resolve })
  const app = new EventEmitter()
  app.whenReady = () => Promise.resolve()
  app.quit = () => {
    let prevented = false
    app.emit('before-quit', { preventDefault() { prevented = true } })
    if (!prevented) { calls.push('exit'); finish() }
  }
  const host = new EventEmitter()
  host.destroyed = false
  host.isDestroyed = () => host.destroyed
  host.webContents = new EventEmitter()
  host.webContents.isDestroyed = host.isDestroyed
  host.capturePage = async () => ({ isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.from('frame') })
  host.webContents.executeJavaScript = () => phase === 'presented' ? Promise.resolve(true) : new Promise((_, reject) => {
    rejectFrame = reject
    reachPhase()
  })
  host.show = () => calls.push('show')
  host.loadURL = async () => {
    if (phase === 'load') return new Promise((_, reject) => {
      rejectLoad = reject
      host.emit('ready-to-show')
      reachPhase()
    })
    if (phase === 'ready') reachPhase()
    else host.emit('ready-to-show')
  }
  host.destroy = () => {
    if (host.destroyed) return
    host.destroyed = true
    calls.push('destroy')
    host.emit('closed')
    rejectLoad?.(new Error('Navigation interrupted by host destruction'))
    rejectFrame?.(new Error('Frame execution interrupted by host destruction'))
  }
  const backend = new EventEmitter()
  Object.assign(backend, { pid: 123, exitCode: null, signalCode: null,
    stdin: Object.assign(new EventEmitter(), { destroyed: false, end() {
      calls.push('backend-stop')
      setImmediate(() => { backend.exitCode = 0; calls.push('backend-exit'); backend.emit('exit', 0, null) })
    } }),
  })
  const context = vm.createContext({
    app, host, backend, packaged: true, ownsInstance: true, brand: 'Singhouse',
    quitting: false, shutdownComplete: false, updateOperation: null,
    installation: null, heartSetup: null, onboardingSetup: null,
    modalCheckController: null, processingOperation: null, projector: null,
    packRecheck: null, processingManager: null, modelCache: null, activeProcessing: null, activeModels: null,
    AbortController, recheckPacks: async () => { calls.push('pack-recheck') },
    startupHandoff: { state: 'awaiting-presentation' },
    updates: { completeStartup(value) {
      calls.push('complete-startup')
      if (phase !== 'presented') throw new Error('Interrupted startup must not complete')
      reachPhase()
      return value
    } },
    runtime: { remove() { calls.push('runtime-cleanup') } },
    startupSurface: { close() { calls.push('splash-close') } },
    blocker: { stop() {} }, installMenu() {}, launch: { origin: 'http://127.0.0.1:1234/' },
    presentAndCompleteStartup, confirmRenderedFrame, stopRuntime,
    forceChild() { throw new Error('Unexpected forced cleanup') },
    process: new EventEmitter(), console,
    dialog: { showErrorBox(_title, message) { calls.push('error-ui'); errors.push(message) } },
  })
  new vm.Script(productionTail, { filename: 'main.mjs (production startup/shutdown tail)' }).runInContext(context)
  let timer
  try {
    await Promise.race([(async () => {
      await reached
      if (intentionalQuit) app.quit()
      else if (failure === 'compositor') rejectFrame(new Error('Compositor failed during startup'))
      else host.webContents.emit('render-process-gone')
      await finished
      // Allow the startup catch to settle as well as the shutdown promise.
      await new Promise(resolve => setImmediate(resolve))
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Startup shutdown did not finish')), 2000) })])
  } finally { clearTimeout(timer) }
  assert.equal(host.destroyed, true)
  assert.equal(backend.exitCode, 0)
  assert.equal(calls.includes('complete-startup'), phase === 'presented')
  assert.equal(calls.filter(call => call === 'backend-stop').length, 1)
  assert.ok(calls.indexOf('runtime-cleanup') > calls.indexOf('backend-exit'))
  assert.ok(calls.indexOf('exit') > calls.indexOf('runtime-cleanup'))
  if (errors.length) assert.ok(calls.indexOf('error-ui') < calls.indexOf('backend-stop'),
    'Genuine startup errors are presented before cleanup begins')
  return { errors, calls }
}

for (const phase of ['ready', 'load', 'frame']) {
  test(`intentional quit during pending ${phase} completes cleanup without startup error UI`, async () => {
    const { errors, calls } = await exercise(phase, true)
    assert.deepEqual(errors, [])
    assert.equal(calls.includes('pack-recheck'), false, 'No background pack check before presentation')
  })
}
test('a genuine presentation failure still shows the startup error and cleans up', async () => {
  const { errors } = await exercise('frame', false, 'compositor')
  assert.deepEqual(errors, ['Compositor failed during startup'])
})

for (const phase of ['ready', 'load', 'frame']) {
  test(`renderer crash during pending ${phase} reports startup failure before cleanup`, async () => {
    const { errors } = await exercise(phase, false)
    assert.deepEqual(errors, ['Renderer exited before the application finished presenting'])
  })
}
test('renderer crash after presentation retains normal shutdown', async () => {
  const { errors, calls } = await exercise('presented', false)
  assert.deepEqual(errors, [])
  // The background pack check starts only once the window is presented.
  assert.ok(calls.indexOf('pack-recheck') > calls.indexOf('splash-close'))
})

test('a damage notice is recorded at once, waits for every operation and covers only packs still damaged', async () => {
  const begin = source.indexOf('// Packs the background check found damaged')
  const end = source.indexOf("app.on('before-quit'", begin)
  assert.ok(begin > 0 && end > begin)
  const dialogs = [], sent = [], logged = []
  const context = vm.createContext({
    quitting: false, processingError: null, processingOperation: null, updateOperation: null, installation: null, heartSetup: null,
    operationGate: { active: null }, setupChecks: 0, DAMAGE_NOTICE_POLL_MS: 1, setTimeout, String, Boolean,
    console: { error: message => logged.push(message) },
    host: { webContents: { send: channel => sent.push(channel) } },
    dialog: { showMessageBox: async (_, options) => { dialogs.push(options.message); return { response: 1 } } },
  })
  vm.runInContext(source.slice(begin, end), context)
  const settled = () => vm.runInContext('damageNotice', context) ?? Promise.resolve()
  const tick = () => new Promise(resolve => setTimeout(resolve, 20))
  // A store whose packs are damaged until marked repaired (or replaced).
  const store = () => { const repaired = new Set(); return { repaired, damageOutstanding: async id => !repaired.has(id) } }
  const runtime = store(), models = store()
  const report = (label, packStore, id) => context.reportDamagedPack({ label, store: packStore, id, error: new Error('hash mismatch') })
  const busy = kind => { context.processingOperation = Promise.resolve(); context.operationGate.active = { kind } }
  const idle = () => { context.processingOperation = null; context.updateOperation = null; context.operationGate.active = null }
  const RUNTIME = 'The installed song processing runtime failed verification'

  // A backup: the failures are recorded and logged at once; one dialog
  // covering both packs follows when it finishes.
  context.updateOperation = Promise.resolve(); context.operationGate.active = { kind: 'release operation' }
  report('song processing runtime', runtime, 'r1')
  report('separation and Heart model files', models, 'm1')
  report('song processing runtime', runtime, 'r1')
  assert.equal(context.processingError.split('\n').length, 2)
  assert.match(context.processingError, /song processing runtime failed verification/)
  assert.match(context.processingError, /separation and Heart model files failed verification/)
  assert.equal(logged.length, 3)
  await tick()
  assert.deepEqual(dialogs, [])
  idle()
  await settled()
  assert.deepEqual(dialogs, ['The installed song processing runtime and separation and Heart model files failed verification'])
  assert.deepEqual(sent, ['setup:open'])

  // A model installation cannot repair the runtime: its notice is shown once
  // the installation ends.
  dialogs.length = 0
  busy('processing or model installation')
  report('song processing runtime', runtime, 'r1')
  await tick()
  models.repaired.add('m1')
  idle()
  await settled()
  assert.deepEqual(dialogs, [RUNTIME])

  // Setup consent whose preflight is cancelled or rejected repairs nothing:
  // the notice is shown afterwards.
  dialogs.length = 0
  busy('song processing setup')
  report('song processing runtime', runtime, 'r1')
  await tick()
  assert.deepEqual(dialogs, [])
  idle()
  await settled()
  assert.deepEqual(dialogs, [RUNTIME])

  // A pack repaired (or replaced by another) meanwhile is dropped; its failure
  // stays recorded.
  dialogs.length = 0
  context.processingError = null
  busy('song processing setup')
  report('song processing runtime', runtime, 'r1')
  runtime.repaired.add('r1')
  idle()
  await settled(); await tick()
  assert.deepEqual(dialogs, [])
  assert.match(context.processingError, /song processing runtime failed verification/)

  // A mixed queue shows only the packs still damaged.
  busy('processing or model installation')
  report('song processing runtime', runtime, 'r2')
  report('separation and Heart model files', models, 'm2')
  models.repaired.add('m2')
  idle()
  await settled()
  assert.deepEqual(dialogs, [RUNTIME])

  // A standalone setup check (preflight verification, the model folder
  // choice) delays the dialog until it ends.
  dialogs.length = 0
  context.setupChecks = 1
  report('song processing runtime', runtime, 'r2')
  await tick()
  assert.deepEqual(dialogs, [])
  context.setupChecks = 0
  await settled()
  assert.deepEqual(dialogs, [RUNTIME])

  // A failure queued while the queue is being checked joins the same dialog.
  dialogs.length = 0
  const slow = { damageOutstanding: async () => {
    await tick()
    report('separation and Heart model files', models, 'm3')
    return true
  } }
  report('song processing runtime', slow, 'r3')
  await settled(); await tick()
  assert.deepEqual(dialogs, ['The installed song processing runtime and separation and Heart model files failed verification'])
})
