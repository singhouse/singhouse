// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closePackagedApplication, collectOwned, processTable } from './packaged-smoke-shutdown.mjs'

const root = { pid: 10, parent: 1, birth: '100' }
const backend = { pid: 11, parent: 10, birth: '101' }
function fixture(close) {
  const child = { pid: 10, exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; this.signalCode = 'SIGKILL' } }
  return { child, app: { process: () => child, close: () => close(child) } }
}

test('ownership follows descendants and rejects reused PIDs', () => {
  assert.deepEqual(collectOwned([root, backend, { pid: 12, parent: 11, birth: '102' }], [root]).map(row => row.pid), [10, 11, 12])
  assert.deepEqual(collectOwned([{ ...root, birth: '200' }, backend], [root]), [])
  assert.deepEqual(collectOwned([{ ...root, birth: '200' }, backend], [{ ...root, birth: '200' }]), [{ ...root, birth: '200' }])
  assert.deepEqual(collectOwned([{ ...backend, parent: 1 }], [root, backend]), [{ ...backend, parent: 1 }])
})

test('clean close requires close resolution, process exit, and no observed descendants', async () => {
  let rows = [root, backend]
  const { app } = fixture(child => { rows = []; child.exitCode = 0 })
  const reports = []
  await closePackagedApplication(app, { table: async () => rows, report: row => reports.push(row) })
  assert.equal(reports.at(-1).event, 'closed')
})

for (const outcome of [{ exitCode: 1, signalCode: null }, { exitCode: null, signalCode: 'SIGKILL' }]) {
  test(`resolved close rejects abnormal exit ${JSON.stringify(outcome)}`, async () => {
    let rows = [root]
    const { app } = fixture(child => { rows = []; Object.assign(child, outcome) })
    const reports = []
    await assert.rejects(closePackagedApplication(app, {
      table: async () => rows, report: row => reports.push(row),
    }), /exited abnormally/)
    assert.ok(!reports.some(row => row.event === 'closed'))
  })
}

test('hung close forces only its retained child and reports descendants; late rejection is consumed', async () => {
  let rejectClose
  const { app, child } = fixture(() => new Promise((_, reject) => { rejectClose = reject }))
  const reports = []
  await assert.rejects(closePackagedApplication(app, {
    timeout: 20, table: async () => [root, backend], report: row => reports.push(row),
  }), /did not shut down cleanly/)
  assert.equal(child.kills, 1)
  assert.deepEqual(reports.at(-1).processes, [root, backend])
  assert.equal(reports.at(-1).event, 'after-forced-cleanup')
  rejectClose(new Error('late close error'))
  await new Promise(resolve => setImmediate(resolve))
})

test('resolved close with a surviving descendant is a failure', async () => {
  let rows = [root, backend]
  const { app, child } = fixture(child => { rows = [{ ...backend, parent: 1 }]; child.exitCode = 0 })
  const reports = []
  await assert.rejects(closePackagedApplication(app, { timeout: 20, table: async () => rows, report: row => reports.push(row) }), /did not shut down cleanly/)
  assert.equal(child.kills, 0)
  assert.deepEqual(reports.at(-1).processes, [{ ...backend, parent: 1 }])
})

test('Linux forced cleanup stops its real retained child without reporting success', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  // Finite lifetime is a second safety net if a test assertion interrupts cleanup.
  const child = spawn(process.execPath, ['-e', `console.log('ready'); setTimeout(() => {}, 4000)`], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(2000) })
    assert.equal(output.toString().trim(), 'ready')
    const app = { process: () => child, close: () => new Promise(() => {}) }
    await assert.rejects(closePackagedApplication(app, { timeout: 30 }), /did not shut down cleanly/)
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit', { signal: AbortSignal.timeout(2000) })
    const survivors = (await processTable()).filter(row => row.pid === child.pid)
    assert.deepEqual(survivors, [])
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    child.stdout.destroy()
    child.unref()
  }
})
