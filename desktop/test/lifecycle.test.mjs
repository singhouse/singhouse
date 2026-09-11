// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { projectorBlocker, stopChild, createRuntime, stopRuntime } from '../lifecycle.mjs'

test('projector sleep blocker is acquired once and released once across duplicate events', () => {
  const actions = []
  const blocker = projectorBlocker({ start: type => { actions.push(type); return 7 }, stop: id => actions.push(id) })
  blocker.stop(); blocker.start(); blocker.start(); blocker.stop(); blocker.stop()
  assert.deepEqual(actions, ['prevent-display-sleep', 7])
  blocker.start(); blocker.stop()
  assert.equal(actions.length, 4)
})
function child(stubborn) {
  const child = new EventEmitter()
  child.pid = 12345
  child.exitCode = child.signalCode = null
  child.signals = []
  child.kill = signal => {
    child.signals.push(signal)
    if (!stubborn || signal === 'SIGKILL') setImmediate(() => { child.signalCode = signal; child.emit('exit') })
  }
  return child
}
test('shutdown waits for graceful child exit and avoids later kill', async () => {
  const backend = child(false)
  await stopChild(backend, 20)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(backend.signals, ['SIGTERM'])
  await stopChild(backend)
  assert.equal(backend.signals.length, 1)
})
test('shutdown escalates only its stubborn child', async () => {
  const backend = child(true)
  await stopChild(backend, 5)
  assert.deepEqual(backend.signals, ['SIGTERM', 'SIGKILL'])
})

for (const stubborn of [false, true]) {
  test(`runtime cleanup follows ${stubborn ? 'forced' : 'graceful'} child exit`, async () => {
    const runtime = createRuntime()
    const backend = child(stubborn)
    writeFileSync(join(runtime.backend, 'transient.db'), 'temporary')
    writeFileSync(join(runtime.electron, 'state'), 'temporary')
    backend.once('exit', () => assert.equal(existsSync(runtime.root), true))
    try {
      await stopRuntime(backend, runtime, 5)
      assert.equal(existsSync(runtime.root), false)
      assert.deepEqual(backend.signals, stubborn ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'])
    } finally { runtime.remove() }
  })
}

test('failed executable spawn still cleans runtime without waiting for exit', async () => {
  const runtime = createRuntime()
  try {
    const backend = spawn(join(runtime.root, 'missing-executable'))
    await new Promise(resolve => backend.once('error', resolve))
    assert.equal(backend.pid, undefined)
    await stopRuntime(backend, runtime, 5)
    assert.equal(existsSync(runtime.root), false)
  } finally { runtime.remove() }
})
