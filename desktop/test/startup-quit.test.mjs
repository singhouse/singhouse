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
    const { errors } = await exercise(phase, true)
    assert.deepEqual(errors, [])
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
  const { errors } = await exercise('presented', false)
  assert.deepEqual(errors, [])
})
