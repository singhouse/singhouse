// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { projectorBlocker, processingLaunchArguments, stopChild, createRuntime, stopRuntime } from '../lifecycle.mjs'
import { resolveInstallRoot } from '../onboarding_state.mjs'
import { managedStoreDirectories } from '../runtime_manager.mjs'

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

test('pipe-owned shutdown requests EOF before resorting to signals', async () => {
  const backend = child(false)
  backend.stdin = { destroyed: false, end() { setImmediate(() => { backend.exitCode = 0; backend.emit('exit') }) } }
  await stopChild(backend, 20)
  assert.deepEqual(backend.signals, [])
})

test('persistent runtime shutdown preserves library and settings', async () => {
  const { persistentRuntime } = await import('../lifecycle.mjs')
  const temporary = createRuntime()
  try {
    const runtime = persistentRuntime(temporary.electron)
    const song = join(runtime.backend, 'desktop.db')
    writeFileSync(song, 'library')
    await stopRuntime(child(false), runtime, 20)
    assert.equal(existsSync(song), true)
    assert.equal(persistentRuntime(temporary.electron).backend, runtime.backend)
  } finally { temporary.remove() }
})

test('failed forced shutdown rejects and preserves runtime without throwing from a timer', async () => {
  const runtime = createRuntime()
  const backend = child(true)
  backend.kill = signal => { if (signal === 'SIGKILL') throw new Error('permission denied') }
  try {
    await assert.rejects(stopRuntime(backend, runtime, 5), /permission denied/)
    assert.equal(existsSync(runtime.root), true)
    assert.equal(backend.listenerCount('exit'), 0)
  } finally { runtime.remove() }
})

test('missing exit after forced shutdown is bounded', async () => {
  const backend = child(true)
  backend.kill = () => true
  await assert.rejects(stopChild(backend, 5), /did not exit/)
  assert.equal(backend.listenerCount('exit'), 0)
})

test('unexpected leader death immediately kills its surviving descendants', { skip: process.platform === 'win32' }, async () => {
  const { watchOwnedGroup, forceChild } = await import('../lifecycle.mjs')
  const script = `
import subprocess, sys, time
subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
print('ready', flush=True)
time.sleep(30)
  `
  const backend = spawn('python3', ['-I', '-B', '-c', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  watchOwnedGroup(backend)
  try {
    await new Promise((resolve, reject) => {
      let stderr = ''
      backend.stderr.on('data', data => { stderr += data })
      const timer = setTimeout(() => reject(new Error(`Child did not announce startup: ${stderr}`)), 3000)
      backend.stdout.once('data', () => { clearTimeout(timer); resolve() })
      backend.once('error', error => { clearTimeout(timer); reject(error) })
      backend.once('exit', () => { clearTimeout(timer); reject(new Error(`Child exited before startup: ${stderr}`)) })
    })
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Grandchild survived leader death and retained stdout')), 3000)
      backend.once('close', () => { clearTimeout(timer); resolve() })
    })
    backend.kill('SIGKILL') // Kill only the leader; exit handler owns descendants.
    await closed
    assert.equal(backend.treeCleanupError, undefined)
    await stopChild(backend, 5)
    // The old group ID was consumed; later cleanup cannot signal reused IDs.
    forceChild(backend)
  } finally { forceChild(backend) }
})


test('fresh desktop runtimes provision the admission cache for real inherited worker environments', async () => {
  const { persistentRuntime } = await import('../lifecycle.mjs')
  const temporary = createRuntime()
  const backendLauncher = fileURLToPath(new URL('../backend.py', import.meta.url))
  const admissionModule = fileURLToPath(new URL('../../backend/src/karaoke_backend/workers/memory_admission.py', import.meta.url))
  const script = `
import importlib.util, json, os, subprocess, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("desktop_launcher", sys.argv[1])
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
runtime = Path(sys.argv[2])
worker = """
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('admission', sys.argv[1])
admission = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admission)
with admission.serialized():
    assert (Path(os.environ['XDG_CACHE_HOME']) / 'processing-memory.lock').is_file()
print(os.environ['XDG_CACHE_HOME'])
"""
directory = launcher.runtime_directory if sys.argv[4] == "disposable" else launcher.persistent_directory
with directory(runtime) as admitted:
    environment = launcher.isolated_environment(admitted, "http://127.0.0.1:1234", "fixture", disposable=sys.argv[4] == "disposable")
    if sys.argv[4] == "disposable":
        try:
            with launcher.runtime_directory(admitted):
                raise AssertionError("Nonempty runtime was accepted")
        except RuntimeError as error:
            assert str(error) == "Runtime must be empty"
    result = subprocess.run([sys.executable, '-I', '-B', '-c', worker, sys.argv[3]], env=environment, capture_output=True, text=True)
assert result.returncode == 0, result.stderr
assert result.stdout.strip() == str(runtime / 'cache')
`
  try {
    const persistent = persistentRuntime(join(temporary.root, 'persistent profile'))
    for (const runtime of [temporary, persistent]) {
      for (const ambient of [{ HOME: '/untrusted/home', XDG_CACHE_HOME: '/untrusted/cache' },
        { USERPROFILE: '/untrusted/profile', LOCALAPPDATA: '/untrusted/appdata', XDG_CACHE_HOME: '/untrusted/cache' }]) {
        mkdirSync(runtime.backend, { recursive: true, mode: 0o700 })
        const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
          ['-I', '-B', '-c', script, backendLauncher, runtime.backend, admissionModule, runtime === temporary ? 'disposable' : 'persistent'],
          { env: { ...process.env, ...ambient }, encoding: 'utf8', timeout: 15000 })
        assert.equal(result.status, 0, result.stderr || result.error?.message)
      }
    }
    assert.equal(persistentRuntime(join(temporary.root, 'persistent profile')).backend, persistent.backend)
  } finally { temporary.remove() }
})

test('a custom install root flows into the backend launch arguments with its own store paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singhouse-launch-root-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fallback = join(directory, 'application-data')
  const custom = join(directory, 'chosen')
  await mkdir(custom)
  const installRoot = await resolveInstallRoot(fallback, custom)
  const stores = managedStoreDirectories(installRoot)
  const processing = { directory: join(stores.processing, 'packs', 'a'.repeat(16)), id: 'a'.repeat(64) }
  const models = { directory: join(stores.models, 'packs', 'b'.repeat(16)), id: 'b'.repeat(64) }
  const args = processingLaunchArguments({ installRoot, processing, probe: { probePassed: true }, models })
  assert.deepEqual(args, ['--processing-root', custom, '--processing', processing.directory, '--processing-id', processing.id,
    '--processing-probe', '{"probePassed":true}', '--models', models.directory, '--models-id', models.id])
  assert.deepEqual(processingLaunchArguments({ installRoot: null }), [])
  // The packaged launch passes the resolved root it opened the stores from.
  const main = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')
  assert.match(main, /processingLaunchArguments\(\{ installRoot: packaged \? installRoot : null/)
  assert.match(main, /installRoot = await resolveInstallRoot\(runtime\.root, savedInstallLocation\)/)
})
