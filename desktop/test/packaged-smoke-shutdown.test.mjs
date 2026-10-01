// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { closePackagedApplication, collectOwned, processTable, parseDarwinProcessTable, shutdownEvidence, isZombie, liveProcesses } from './packaged-smoke-shutdown.mjs'

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

test('shutdown evidence keeps remaining process identity, exit facts and cleanup errors', () => {
  assert.deepEqual(shutdownEvidence({ event: 'before-close', processes: [root, backend] }), { forced: false,
    entry: { event: 'before-close', processCount: 2, processes: [{ pid: 10, parent: 1 }, { pid: 11, parent: 10 }] } })
  assert.deepEqual(shutdownEvidence({ event: 'closed', processes: [] }), { forced: false, entry: { event: 'closed', processCount: 0, processes: [] } })
  const hung = shutdownEvidence({ event: 'shutdown-failed', error: new Error('did not shut down cleanly'), closeSettled: false,
    exitCode: null, signalCode: null, processes: [root, backend] })
  assert.equal(hung.forced, true)
  assert.deepEqual(hung.entry, { event: 'shutdown-failed', processCount: 2, processes: [{ pid: 10, parent: 1 }, { pid: 11, parent: 10 }],
    error: 'Error: did not shut down cleanly', closeSettled: false, exitCode: null, signalCode: null })
  // Clean root exit with a surviving descendant: nothing was forced.
  const orphan = shutdownEvidence({ event: 'shutdown-failed', error: 'x', closeSettled: true, exitCode: 0, signalCode: null, processes: [{ ...backend, parent: 1 }] })
  assert.equal(orphan.forced, false); assert.deepEqual(orphan.entry.processes, [{ pid: 11, parent: 1 }])
  assert.equal(shutdownEvidence({ event: 'shutdown-failed', exitCode: null, signalCode: 'SIGKILL' }).forced, false)
  const cleanup = shutdownEvidence({ event: 'after-forced-cleanup', processes: [backend], cleanupErrors: [new Error('EPERM')] })
  assert.deepEqual(cleanup.entry, { event: 'after-forced-cleanup', processCount: 1, processes: [{ pid: 11, parent: 10 }], cleanupErrors: ['Error: EPERM'] })
  assert.deepEqual(shutdownEvidence({ event: 'cleanup-inspection-failed', error: 'denied', cleanupErrors: [] }).entry,
    { event: 'cleanup-inspection-failed', error: 'denied', cleanupErrors: [] })
  assert.throws(() => shutdownEvidence({}), /event/)
})

test('Linux zombies are not still running: excluded from the clean-close check and recorded separately', async () => {
  const zombie = { ...backend, state: 'Z' }, sleeping = { pid: 12, parent: 11, birth: '102', state: 'S' }
  assert.equal(isZombie(zombie), true); assert.equal(isZombie(sleeping), false); assert.equal(isZombie(backend), false)
  assert.deepEqual(liveProcesses([root, zombie, sleeping]), [root, sleeping])
  // The root exits; its unreaped child is a zombie still in the table.
  let rows = [{ ...root, state: 'S' }, { ...backend, state: 'S' }]
  const { app } = fixture(child => { rows = [zombie]; child.exitCode = 0 })
  const reports = []
  await closePackagedApplication(app, { table: async () => rows, report: row => reports.push(row) })
  assert.deepEqual(reports.map(row => row.event), ['before-close', 'closed'])
  assert.deepEqual(reports[0].zombies, []); assert.deepEqual(reports.at(-1).zombies, [zombie])
  assert.deepEqual(shutdownEvidence(reports.at(-1)).entry, { event: 'closed', processCount: 0, processes: [], zombieCount: 1, zombies: [{ pid: 11, parent: 10 }] })
  assert.deepEqual(shutdownEvidence(reports[0]).entry.zombies, undefined)
  // A live descendant beside a zombie still fails, and only the live one is "still running".
  let hung = [{ ...root, state: 'S' }, { ...backend, state: 'S' }, sleeping]
  // The live grandchild's parent is the zombie, so lineage still owns it.
  const failing = fixture(child => { hung = [zombie, sleeping]; child.exitCode = 0 })
  const failed = []
  await assert.rejects(closePackagedApplication(failing.app, { timeout: 20, table: async () => hung, report: row => failed.push(row) }), /did not shut down cleanly/)
  const report = failed.find(row => row.event === 'shutdown-failed')
  assert.deepEqual(report.processes.map(row => row.pid), [12]); assert.deepEqual(report.zombies.map(row => row.pid), [11])
})

test('an application quitting on its own is observed to a clean exit without being closed', async () => {
  let rows = [root, backend], closes = 0
  const { app, child } = fixture(() => { closes++ })
  const reports = []
  await closePackagedApplication(app, { table: async () => rows, report: row => reports.push(row),
    initiate: async () => { rows = []; child.exitCode = 0 } })
  assert.equal(closes, 0); assert.equal(child.kills, 0)
  assert.deepEqual(reports.map(row => row.event), ['before-close', 'closed'])
})

test('a self-quitting application that never exits is forced and fails', async () => {
  const { app, child } = fixture(() => {})
  const reports = []
  await assert.rejects(closePackagedApplication(app, { timeout: 20, table: async () => [root], report: row => reports.push(row),
    initiate: () => new Promise(() => {}) }), /did not shut down cleanly/)
  assert.equal(child.kills, 1)
  assert.equal(shutdownEvidence(reports.find(row => row.event === 'shutdown-failed')).forced, true)
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
m.os.geteuid=lambda:501
class Fake:
 mode='normal'
 def proc_listpids(self,kind,uid,buffer,size):
  assert kind==4 and uid==m.os.geteuid()
  if self.mode=='unaligned':return 7
  if buffer is None: return 8
  if self.mode=='truncated': return size
  buffer[0]=10;buffer[1]=11;return 8
 def proc_pidinfo(self,pid,flavor,arg,pointer,size):
  assert flavor==3 and size==136
  if pid==11:
   ctypes.set_errno(errno.EPERM if self.mode=='denied' else errno.ESRCH);return 0
  info=pointer._obj;info.uid=m.os.geteuid();info.pid=pid;info.parent=1;info.seconds=1790000000;info.microseconds=123456
  if self.mode=='malformed':info.microseconds=1000000
  if self.mode=='wrong_uid':info.uid+=1
  return size
f=Fake();assert m.snapshot(f)==[{'pid':10,'parent':1,'birth':'1790000000123456'}]
for mode in ['denied','truncated','malformed','unaligned','wrong_uid']:
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


test('macOS own-UID observer validates UID and never treats permission denial as exit', () => {
  const script = `import importlib.util,sys,ctypes,errno
spec=importlib.util.spec_from_file_location('observer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Fake:
 def proc_listpids(self,kind,uid,buffer,size):
  assert kind==4 and uid==501
  if buffer is None:return 4
  buffer[0]=10;return 4
 def proc_pidinfo(self,pid,flavor,arg,pointer,size):
  ctypes.set_errno(errno.EPERM);return 0
m.os.geteuid=lambda:501
try:m.snapshot(Fake())
except RuntimeError as e:assert 'Cannot inspect' in str(e)
else:raise AssertionError('accepted same-UID permission denial')
for uid in [-1,4294967296,True,'501',1.5]:
 try:m.list_pids(Fake(),uid)
 except RuntimeError:pass
 else:raise AssertionError('accepted invalid UID')
class Drift(Fake):
 def proc_pidinfo(self,pid,flavor,arg,pointer,size):
  info=pointer._obj;info.uid=501;info.pid=pid;info.parent=1;info.seconds=1790000000
  m.os.geteuid=lambda:502
  return size
try:m.snapshot(Drift())
except RuntimeError as e:assert 'UID changed' in str(e)
else:raise AssertionError('accepted observer UID drift')
`
  const python = process.env.KARAOKE_DESKTOP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  execFileSync(python, ['-I', '-B', '-c', script, fileURLToPath(new URL('./packaged-smoke-processes.py', import.meta.url))], { timeout: 10000 })
})
