// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { closePackagedApplication, collectOwned, processTable, parseDarwinProcessTable } from './packaged-smoke-shutdown.mjs'

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


test('macOS process observation uses explicit bundled Python with bounded isolated invocation', async () => {
  const python = '/Applications/Test App.app/Contents/Resources/native/python/bin/python3'
  let called = false
  const rows = await processTable({ platform: 'darwin', python, execImpl: async (file, args, options) => {
    called = true; assert.equal(file, python); assert.deepEqual(args.slice(0, 2), ['-I', '-B'])
    assert.ok(args[2].endsWith('/packaged-smoke-processes.py')); assert.equal(options.timeout, 5000)
    return { stdout: JSON.stringify([{ pid: 10, parent: 1, birth: '1790000000123456' }]) }
  } })
  assert.equal(called, true); assert.equal(rows[0].birth, '1790000000123456')
  await assert.rejects(processTable({ platform: 'darwin' }), /explicit bundled Python/)
  await assert.rejects(processTable({ platform: 'darwin', python, execImpl: async () => { throw new Error('inspection denied') } }), /inspection denied/)
})

test('macOS observation fails closed on malformed, empty and reused-PID ambiguity', () => {
  for (const value of [{}, [], [{ pid: 10, parent: 1, birth: 100 }], [{ pid: 10, parent: 1, birth: 'bad' }],
    [{ pid: 10, parent: 10, birth: '100' }], [root, root]]) {
    assert.throws(() => parseDarwinProcessTable(JSON.stringify(value)))
  }
  const sameSecond = [{ pid: 10, parent: 1, birth: '1790000000123457' }]
  assert.deepEqual(collectOwned(sameSecond, [{ pid: 10, parent: 1, birth: '1790000000123456' }]), [])
})

test('macOS ABI observer handles process exit but refuses denied and truncated observations', () => {
  // Only fake libproc calls execute here; the helper never loads Darwin libraries.
  const script = `import importlib.util,sys,ctypes,errno
spec=importlib.util.spec_from_file_location('observer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Fake:
 mode='normal'
 def proc_listallpids(self,buffer,size):
  if buffer is None: return 2
  if self.mode=='truncated': return len(buffer)
  buffer[0]=10;buffer[1]=11;return 2
 def proc_pidinfo(self,pid,flavor,arg,pointer,size):
  assert flavor==3 and size==136
  if pid==11:
   ctypes.set_errno(errno.EPERM if self.mode=='denied' else errno.ESRCH);return 0
  info=pointer._obj;info.pid=pid;info.parent=1;info.seconds=1790000000;info.microseconds=123456
  if self.mode=='malformed':info.microseconds=1000000
  return size
f=Fake();assert m.snapshot(f)==[{'pid':10,'parent':1,'birth':'1790000000123456'}]
for mode in ['denied','truncated','malformed']:
 f.mode=mode
 try:m.snapshot(f)
 except RuntimeError:pass
 else:raise AssertionError('accepted '+mode)
`
  const python = process.env.KARAOKE_DESKTOP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  execFileSync(python, ['-I', '-B', '-c', script, fileURLToPath(new URL('./packaged-smoke-processes.py', import.meta.url))], { timeout: 10000 })
})

test('native macOS observer identifies its real child and preserves a stable birth value',
  { skip: process.platform !== 'darwin' || !process.env.KARAOKE_DESKTOP_PYTHON, timeout: 10000 }, async () => {
    const python = process.env.KARAOKE_DESKTOP_PYTHON
    const child = spawn(process.execPath, ['-e', "console.log('ready'); setTimeout(() => {}, 6000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(2000) })
      const first = (await processTable({ python })).find(row => row.pid === child.pid)
      const second = (await processTable({ python })).find(row => row.pid === child.pid)
      assert.equal(first.parent, process.pid); assert.equal(first.birth, second.birth)
      child.kill('SIGTERM')
      await once(child, 'exit', { signal: AbortSignal.timeout(2000) })
      assert.ok(!(await processTable({ python })).some(row => row.pid === child.pid && row.birth === first.birth))
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      child.stdout.destroy(); child.unref()
    }
  })
