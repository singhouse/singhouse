// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'

const source = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')
const preload = await readFile(new URL('../preload.cjs', import.meta.url), 'utf8')

// The guard and the host-close gate run verbatim from main.mjs.
const guardStart = source.indexOf('function createCloseGuard() {')
const guardEnd = source.indexOf('\nfunction installMenu() {', guardStart)
assert.ok(guardStart >= 0 && guardEnd > guardStart)
const guardSource = source.slice(guardStart, guardEnd)

const quitStart = source.indexOf("app.on('before-quit',")
const quitEnd = source.indexOf("\napp.on('window-all-closed'", quitStart)
assert.ok(quitStart >= 0 && quitEnd > quitStart)
const quitSource = source.slice(quitStart, quitEnd)

function load() {
  const context = vm.createContext({})
  new vm.Script(`${guardSource}\nthis.createCloseGuard = createCloseGuard; this.gateHostClose = gateHostClose; this.watchCloseGuardRenderer = watchCloseGuardRenderer`).runInContext(context)
  return context
}

function fakeHost() {
  const sent = []
  const host = new EventEmitter()
  host.destroyed = false
  host.closed = 0
  host.isDestroyed = () => host.destroyed
  host.webContents = Object.assign(new EventEmitter(), { send: channel => sent.push(channel), isDestroyed: () => host.destroyed })
  // Mirrors BrowserWindow.close(): emits 'close' and closes unless prevented.
  host.close = () => {
    let prevented = false
    host.emit('close', { preventDefault() { prevented = true } })
    if (!prevented) host.closed++
  }
  return { host, sent }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('closing the host with an armed guard asks the renderer and waits for its decision', async () => {
  const { createCloseGuard, gateHostClose } = load()
  const guard = createCloseGuard()
  const { host, sent } = fakeHost()
  gateHostClose(host, guard)
  guard.arm(true)

  host.close()
  await tick()
  assert.deepEqual(sent, ['window:close-requested'])
  assert.equal(host.closed, 0, 'the window stays open while the renderer decides')

  assert.equal(guard.decide('cancel'), true)
  await tick()
  assert.equal(host.closed, 0, 'cancel keeps the window')
  assert.equal(guard.armed, true, 'the edits are still unsaved')

  host.close()
  await tick()
  assert.deepEqual(sent, ['window:close-requested', 'window:close-requested'])
  assert.equal(guard.decide('proceed'), true)
  await tick()
  assert.equal(host.closed, 1, 'proceed closes the window')
  assert.equal(guard.armed, false)
})

test('closing the host without a guard proceeds at once', async () => {
  const { createCloseGuard, gateHostClose } = load()
  const guard = createCloseGuard()
  const { host, sent } = fakeHost()
  gateHostClose(host, guard)

  host.close()
  assert.equal(host.closed, 1)
  assert.deepEqual(sent, [])
  assert.equal(guard.decide('proceed'), false, 'no request is pending')
})

test('repeated close requests share one prompt; disarming answers it', async () => {
  const { createCloseGuard } = load()
  const guard = createCloseGuard()
  const { host, sent } = fakeHost()
  guard.arm(true)
  const first = guard.request(host.webContents)
  const second = guard.request(host.webContents)
  assert.deepEqual(sent, ['window:close-requested'])
  guard.arm(false)
  assert.deepEqual(await Promise.all([first, second]), [true, true])
})

test('a released guard (renderer gone) never blocks closing', async () => {
  const { createCloseGuard } = load()
  const guard = createCloseGuard()
  const { host } = fakeHost()
  guard.arm(true)
  const pending = guard.request(host.webContents)
  guard.release()
  assert.equal(await pending, true)
  assert.equal(guard.armed, false)
  host.destroyed = true
  guard.arm(true)
  assert.equal(await guard.request(host.webContents), true, 'a destroyed renderer cannot be asked')
})

test('an unresponsive renderer releases a pending close and the window closes', async () => {
  const { createCloseGuard, gateHostClose, watchCloseGuardRenderer } = load()
  const guard = createCloseGuard()
  const { host, sent } = fakeHost()
  watchCloseGuardRenderer(host, guard)
  gateHostClose(host, guard)
  guard.arm(true)

  host.close()
  await tick()
  assert.deepEqual(sent, ['window:close-requested'])
  assert.equal(host.closed, 0)

  host.emit('unresponsive')
  await tick()
  assert.equal(host.closed, 1, 'the close completes without an answer from the renderer')
  assert.equal(guard.armed, false)
})

test('an unresponsive renderer before a close request lets the close proceed at once', async () => {
  const { createCloseGuard, gateHostClose, watchCloseGuardRenderer } = load()
  const guard = createCloseGuard()
  const { host, sent } = fakeHost()
  watchCloseGuardRenderer(host, guard)
  gateHostClose(host, guard)
  guard.arm(true)

  host.emit('unresponsive')
  host.close()
  assert.equal(host.closed, 1)
  assert.deepEqual(sent, [])
})

test('a renderer reload cancels a pending close and disarms the guard', async () => {
  const { createCloseGuard, gateHostClose, watchCloseGuardRenderer } = load()
  const guard = createCloseGuard()
  const { host, sent } = fakeHost()
  watchCloseGuardRenderer(host, guard)
  gateHostClose(host, guard)
  guard.arm(true)

  host.close()
  await tick()
  assert.deepEqual(sent, ['window:close-requested'])

  host.webContents.emit('did-navigate')
  await tick(); await tick()
  assert.equal(host.closed, 0, 'the reloaded window stays open')
  assert.equal(guard.armed, false)
  assert.equal(guard.decide('proceed'), false, 'no request is left pending')

  host.close()
  assert.equal(host.closed, 1, 'a later close is no longer gated')
  assert.deepEqual(sent, ['window:close-requested'])
})

function quitHarness(armed) {
  const { createCloseGuard } = load()
  const closeGuard = createCloseGuard()
  const { host, sent } = fakeHost()
  host.destroy = () => { host.destroyed = true }
  const calls = []
  const app = new EventEmitter()
  app.quit = () => {
    calls.push('quit')
    let prevented = false
    app.emit('before-quit', { preventDefault() { prevented = true } })
    if (!prevented) calls.push('exit')
  }
  const context = vm.createContext({
    app, host, closeGuard, ownsInstance: true, shutdownComplete: false, quitting: false,
    updateOperation: null, handingOff: false, installation: null, heartSetup: null, onboardingSetup: null,
    modalCheckController: null, startupSurface: null, projector: null, processingOperation: null,
    startupVerification: new AbortController(), blocker: { stop() {} }, backend: null, runtime: null,
    stopRuntime: async () => { calls.push('backend-stop') }, console,
  })
  new vm.Script(quitSource).runInContext(context)
  if (armed) closeGuard.arm(true)
  return { app, host, sent, calls, closeGuard, context }
}

test('quit with an armed guard asks the renderer before destroying the host', async () => {
  const { app, host, sent, calls, closeGuard, context } = quitHarness(true)
  app.quit()
  await tick()
  assert.deepEqual(sent, ['window:close-requested'])
  assert.equal(host.destroyed, false)
  assert.equal(context.quitting, false)

  closeGuard.decide('cancel')
  await tick()
  assert.equal(host.destroyed, false, 'cancel keeps the application running')
  assert.deepEqual(calls, ['quit'])

  app.quit()
  await tick()
  closeGuard.decide('proceed')
  await tick(); await tick()
  assert.equal(host.destroyed, true)
  assert.equal(context.quitting, true)
  assert.ok(calls.includes('backend-stop'), 'the shutdown sequence runs unchanged')
  assert.equal(calls.at(-1), 'exit')
})

test('quit with an armed guard completes when the renderer stops responding', async () => {
  const { watchCloseGuardRenderer } = load()
  const { app, host, sent, calls, closeGuard, context } = quitHarness(true)
  watchCloseGuardRenderer(host, closeGuard)
  app.quit()
  await tick()
  assert.deepEqual(sent, ['window:close-requested'])
  assert.equal(host.destroyed, false)

  host.emit('unresponsive')
  await tick(); await tick()
  assert.equal(host.destroyed, true)
  assert.equal(context.quitting, true)
  assert.ok(calls.includes('backend-stop'))
  assert.equal(calls.at(-1), 'exit')
})

test('quit with an armed guard is cancelled when the renderer reloads', async () => {
  const { watchCloseGuardRenderer } = load()
  const { app, host, calls, closeGuard, context } = quitHarness(true)
  watchCloseGuardRenderer(host, closeGuard)
  app.quit()
  await tick()
  host.webContents.emit('did-navigate')
  await tick(); await tick()
  assert.equal(host.destroyed, false, 'the reloaded application keeps running')
  assert.equal(context.quitting, false)
  assert.deepEqual(calls, ['quit'])
  assert.equal(closeGuard.armed, false)
})

test('quit without a guard keeps the existing shutdown sequence', async () => {
  const { app, host, sent, calls } = quitHarness(false)
  app.quit()
  assert.equal(host.destroyed, true)
  assert.deepEqual(sent, [])
  await tick(); await tick()
  assert.deepEqual(calls, ['quit', 'backend-stop', 'quit', 'exit'])
})

test('the preload exposes only the fixed close-guard channels', () => {
  assert.match(preload, /setCloseGuard: armed => ipcRenderer\.invoke\('editor:close-guard', armed === true\)/)
  assert.match(preload, /answerCloseRequest: decision => ipcRenderer\.invoke\('editor:close-decision', decision\)/)
  assert.match(preload, /ipcRenderer\.on\('window:close-requested', listener\)/)
  assert.match(source, /hostHandler\('editor:close-guard',/)
  assert.match(source, /watchCloseGuardRenderer\(host, closeGuard\)\n  gateHostClose\(host, closeGuard\)/)
  assert.doesNotMatch(source, /'did-navigate', \(\) => closeGuard\.release\(\)/)
  assert.match(source, /hostHandler\('editor:close-decision',/)
  assert.match(source, /if \(decision !== 'proceed' && decision !== 'cancel'\) throw/)
})
