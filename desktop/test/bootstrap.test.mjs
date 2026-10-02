// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { acquireActivationLock, bootstrapContractPath, invokePairedRecovery, launchManaged, managedBootstrapArguments, runBootstrap, runRecoveryAnchor, runStableBootstrap, superviseManagedTarget, verifyRecoveryAnchor, waitForReady } from '../bootstrap.mjs'
import { canonicalJson } from '../release.mjs'
import { atomicJSON, recoveryAnchorRecord } from '../recovery_launcher.mjs'
import { presentAndCompleteStartup } from '../update_manager.mjs'

function child() {
  const value = new EventEmitter(); value.stdout = new EventEmitter(); value.unref = () => { value.unrefed = true }; value.pid = 42
  return value
}

const immediateActivation = async () => ({ release: async () => {} })

test('managed bootstrap uses an explicit canonical release policy without environment override', () => {
  const explicit = resolve('/packaged/resources/release.json')
  const previous = process.env.SINGHOUSE_RELEASE_POLICY
  process.env.SINGHOUSE_RELEASE_POLICY = resolve('/caller/controlled/release.json')
  try {
    assert.equal(bootstrapContractPath(explicit), explicit)
    assert.notEqual(bootstrapContractPath(explicit), process.env.SINGHOUSE_RELEASE_POLICY)
    assert.deepEqual(managedBootstrapArguments({ bootstrapPath: '/app/bootstrap.mjs', stateRoot: '/state', parentPid: 42,
      pythonPath: '/native/python', helperPath: '/native/backend.py', releasePolicyPath: explicit, stable: true }),
    ['/app/bootstrap.mjs', '/state', '42', '/native/python', '/native/backend.py', explicit, '--stable'])
    assert.throws(() => bootstrapContractPath('relative/release.json'), /absolute and canonical/)
  } finally {
    if (previous === undefined) delete process.env.SINGHOUSE_RELEASE_POLICY
    else process.env.SINGHOUSE_RELEASE_POLICY = previous
  }
})

async function fixedAnchorFixture(root, stateName = 'state') {
  const stateRoot = join(root, stateName), anchorPath = join(stateRoot, 'recovery-tool', 'anchor.json')
  const application = join(root, 'application')
  const executablePath = join(application, 'Singhouse.exe')
  const bootstrapPath = join(application, 'resources', 'app.asar', 'bootstrap.mjs')
  const pythonPath = join(application, 'resources', 'native', 'python', 'python.exe')
  const helperPath = join(application, 'resources', 'native', 'backend.py')
  for (const [path, bytes] of [[executablePath, 'exe'], [bootstrapPath, 'bootstrap'], [pythonPath, 'python'], [helperPath, 'helper']]) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
  }
  const components = { executablePath, bootstrapPath, pythonPath, helperPath, platform: 'win32', arch: 'x64' }
  const record = recoveryAnchorRecord({ ...components, stateRoot, anchorPath })
  atomicJSON(anchorPath, record)
  return { stateRoot, anchorPath, record, components }
}

function controlledActivation() {
  const controller = new AbortController()
  let rejectLost
  const lost = new Promise((resolveLost, reject) => { rejectLost = reject }); lost.catch(() => {})
  const error = new Error('Native activation-lock lease was lost')
  return { signal: controller.signal, lost, release: async () => {}, lose() { controller.abort(error); rejectLost(error) } }
}

test('READY handshake accepts split framing and releases listeners', async () => {
  const value = child(), waiting = waitForReady(value)
  value.stdout.emit('data', Buffer.from('RE')); value.stdout.emit('data', Buffer.from('ADY\n'))
  await waiting
  assert.equal(value.stdout.listenerCount('data'), 0)
  assert.equal(value.listenerCount('exit'), 0)
  const bad = child(), rejected = waitForReady(bad)
  bad.stdout.emit('data', Buffer.from('READY\nextra'))
  await assert.rejects(() => rejected, /Invalid managed launcher/)
})

test('native activation helper is held until the bootstrap releases its kernel lock lease', async () => {
  let invocation
  const held = await acquireActivationLock({ stateRoot: '/private/state', pythonPath: '/native/python', helperPath: '/native/backend.py',
    spawnImpl: (command, args, options) => {
      const process = child(); process.exitCode = null; process.signalCode = null
      process.stdin = { end() { process.exitCode = 0; queueMicrotask(() => process.emit('exit', 0)) } }
      invocation = { command, args, options, process }
      queueMicrotask(() => process.stdout.emit('data', Buffer.from('READY\n')))
      return process
    } })
  assert.equal(invocation.command, '/native/python')
  assert.deepEqual(invocation.args, ['-I', '-B', '/native/backend.py', '--activation-lock', resolve('/private/state')])
  assert.equal(invocation.process.exitCode, null)
  await held.release()
  assert.equal(invocation.process.exitCode, 0)
})

test('standalone recovery requires the intact recorded stable trust anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singhouse-anchor-'))
  const { stateRoot, anchorPath, components } = await fixedAnchorFixture(root)
  assert.equal((await verifyRecoveryAnchor(anchorPath, { ...components, platformTrust: async () => true })).kind, 'recovery-anchor')
  await assert.rejects(() => verifyRecoveryAnchor(`${stateRoot}/recovery-tool/./anchor.json`,
    { ...components, platformTrust: async () => true }), /reinstall singhouse|canonical/)
  const stateAlias = join(root, 'state-alias'); await symlink(stateRoot, stateAlias)
  await assert.rejects(() => verifyRecoveryAnchor(join(stateAlias, 'recovery-tool', 'anchor.json'),
    { ...components, platformTrust: async () => true }), /reinstall singhouse|canonical/)
  await writeFile(anchorPath, '{}\n')
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, { ...components, platformTrust: async () => true }), /reinstall singhouse/)
  await assert.rejects(() => verifyRecoveryAnchor(join(root, 'missing.json'), { ...components, platformTrust: async () => true }), /reinstall singhouse/)
})

test('stable anchor delegates kit verification to its bundled native helper before runtime execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singhouse-anchor-launch-'))
  const { stateRoot, anchorPath, components } = await fixedAnchorFixture(root)
  const kitRoot = join(stateRoot, 'recovery-tool', 'kits', 'kit-point-1')
  await mkdir(join(stateRoot, 'updates'), { recursive: true }); await mkdir(kitRoot, { recursive: true })
  const manifestHash = '7'.repeat(64)
  await writeFile(join(stateRoot, 'updates', 'handoff.json'), JSON.stringify({ recoveryPoint: 'point-1',
    recoveryKit: { id: 'kit-point-1', manifestSha256: manifestHash } }))
  let invocation
  await runRecoveryAnchor({ anchorPath, kitRoot, recoveryArgs: [stateRoot, 'point-1', join(stateRoot, 'backend')],
    ...components,
    platformTrust: async () => true, spawnImpl: (command, args, options) => {
      invocation = { command, args, options }; const process = child(); queueMicrotask(() => process.emit('exit', 0)); return process
    } })
  assert.equal(invocation.command, components.pythonPath)
  assert.deepEqual(invocation.args.slice(0, 4), ['-I', '-B', components.helperPath, '--launch-recovery-kit'])
  assert.equal(invocation.args[4], kitRoot)
  assert.equal(invocation.args[5], manifestHash)

  let unsafeSpawn = false, unsafeTrust = 0
  const rejectOptions = { anchorPath, kitRoot, recoveryArgs: [stateRoot, 'point-1', join(stateRoot, 'backend')],
    ...components, platformTrust: async () => { unsafeTrust += 1; return true }, spawnImpl: () => { unsafeSpawn = true; return child() } }
  await assert.rejects(() => runRecoveryAnchor({ ...rejectOptions,
    recoveryArgs: [`${stateRoot}/.`, 'point-1', join(stateRoot, 'backend')] }), /trust anchor state root/)
  await assert.rejects(() => runRecoveryAnchor({ ...rejectOptions,
    recoveryArgs: [stateRoot, 'point-1', `${join(stateRoot, 'backend')}/.`] }), /trust anchor state root/)
  await assert.rejects(() => runRecoveryAnchor({ ...rejectOptions, kitRoot: `${kitRoot}/.` }), /authenticated handoff/)
  const kitAlias = join(stateRoot, 'recovery-tool', 'kits', 'kit-alias'); await symlink(kitRoot, kitAlias)
  await assert.rejects(() => runRecoveryAnchor({ ...rejectOptions, kitRoot: kitAlias }), /authenticated handoff/)
  const realKit = join(stateRoot, 'recovery-tool', 'kits', 'real-kit'); renameSync(kitRoot, realKit); await symlink(realKit, kitRoot)
  await assert.rejects(() => runRecoveryAnchor(rejectOptions), /authenticated handoff/)
  const handoffPath = join(stateRoot, 'updates', 'handoff.json'), realHandoff = join(stateRoot, 'updates', 'real-handoff.json')
  await renameSync(handoffPath, realHandoff); await symlink(realHandoff, handoffPath)
  await assert.rejects(() => runRecoveryAnchor(rejectOptions), /Recovery handoff is missing or not canonical/)
  const updatesRoot = join(stateRoot, 'updates'), realUpdates = join(stateRoot, 'real-updates')
  renameSync(updatesRoot, realUpdates); await symlink(realUpdates, updatesRoot)
  await assert.rejects(() => runRecoveryAnchor(rejectOptions), /Recovery update state is missing or not canonical/)
  assert.equal(unsafeSpawn, false)
  assert.equal(unsafeTrust, 0)
})

test('stable anchor rejects coherent copied state and same-basename kit redirects outside its canonical state root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singhouse-anchor-root-binding-'))
  const trustedState = join(root, 'trusted'), copiedState = join(root, 'copied')
  const fixture = await fixedAnchorFixture(root, 'trusted'), { anchorPath, components, record } = fixture
  const copiedAnchor = join(copiedState, 'recovery-tool', 'anchor.json')
  const kitId = 'kit-point-1', copiedKit = join(copiedState, 'recovery-tool', 'kits', kitId)
  atomicJSON(copiedAnchor, record)
  await mkdir(join(copiedState, 'updates'), { recursive: true }); await mkdir(copiedKit, { recursive: true })
  await writeFile(join(copiedState, 'updates', 'handoff.json'), JSON.stringify({ recoveryPoint: 'point-1',
    recoveryKit: { id: kitId, manifestSha256: '7'.repeat(64) } }))
  let spawned = false
  const options = { anchorPath: copiedAnchor, kitRoot: copiedKit,
    recoveryArgs: [copiedState, 'point-1', join(copiedState, 'backend')], platformTrust: async () => true,
    ...components,
    spawnImpl: () => { spawned = true; return child() } }
  await assert.rejects(() => runRecoveryAnchor(options), /trust anchor state root|missing or corrupt/)
  assert.equal(spawned, false)

  await mkdir(join(trustedState, 'updates'), { recursive: true })
  await writeFile(join(trustedState, 'updates', 'handoff.json'), JSON.stringify({ recoveryPoint: 'point-1',
    recoveryKit: { id: kitId, manifestSha256: '7'.repeat(64) } }))
  await assert.rejects(() => runRecoveryAnchor({ ...options, anchorPath,
    recoveryArgs: [trustedState, 'point-1', join(trustedState, 'backend')] }), /authenticated handoff/)
  assert.equal(spawned, false)
})

test('bootstrap acquires its kernel lease before emitting READY and fails closed on initial acquisition failure', async () => {
  const calls = []
  await assert.rejects(() => runBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {},
    activation: async () => { calls.push('acquire'); throw new Error('lock busy') },
    ready: async () => calls.push('ready'), wait: async () => calls.push('wait') }), /lock busy/)
  assert.deepEqual(calls, ['acquire'])
})

test('bootstrap never emits READY when acquisition returns an already-lost lease', async () => {
  const lease = controlledActivation(); lease.lose()
  let ready = false
  await assert.rejects(() => runBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {},
    activation: async () => lease, ready: async () => { ready = true }, wait: async () => {} }), /lease was lost/)
  assert.equal(ready, false)
})

test('lease loss while waiting for the prior launcher prevents selection and managed launch', async () => {
  const lease = controlledActivation(); let selected = false, launched = false
  await assert.rejects(() => runBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {},
    activation: async () => lease, ready: async () => {}, wait: async () => { lease.lose() },
    storeFactory: () => { selected = true; return {} },
    launch: async () => { launched = true } }), /lease was lost/)
  assert.equal(selected, false); assert.equal(launched, false)
})

test('lease loss while authenticating selection prevents managed launch', async () => {
  const lease = controlledActivation(); let launched = false
  await assert.rejects(() => runBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {},
    activation: async () => lease, ready: async () => {}, wait: async () => {},
    storeFactory: () => ({ journal: async () => ({ targetIdentity: { releaseId: 'a'.repeat(64) } }),
      authenticatedActive: async () => { lease.lose(); return { releaseId: 'a'.repeat(64) } } }),
    launch: async () => { launched = true } }), /lease was lost/)
  assert.equal(launched, false)
})

test('lease loss during target supervision stops the target without starting recovery', async () => {
  const lease = controlledActivation(), process = child(); process.exitCode = null; process.signalCode = null
  let stopped = 0, recovered = 0
  const handoff = { state: 'awaiting-target', targetIdentity: { releaseId: 'target' } }
  await assert.rejects(() => superviseManagedTarget({ launched: true, child: process }, {
    store: { journal: async () => handoff }, handoff, recovery: {}, stateRoot: '/private/state', signal: lease.signal,
    delay: async () => { lease.lose() }, stop: async () => { stopped += 1 }, recover: async () => { recovered += 1 },
  }), /lease was lost/)
  assert.equal(stopped, 1); assert.equal(recovered, 0)
})

test('lease loss during paired recovery aborts that recovery and never starts another rollback', async () => {
  const lease = controlledActivation(), process = child(); process.exitCode = 1; process.signalCode = null
  let stopped = 0, recoveries = 0
  const handoff = { state: 'awaiting-target', targetIdentity: { releaseId: 'target' } }
  await assert.rejects(() => superviseManagedTarget({ launched: true, child: process }, {
    store: { journal: async () => handoff }, handoff, recovery: {}, stateRoot: '/private/state', signal: lease.signal,
    stop: async () => { stopped += 1 }, recover: async (value, options) => {
      recoveries += 1; assert.equal(options.signal, lease.signal); lease.lose(); options.signal.throwIfAborted()
    },
  }), /lease was lost/)
  assert.equal(stopped, 1); assert.equal(recoveries, 1)
})

test('bootstrap waits for old launcher and selects only authenticated active application', async () => {
  const calls = [], active = { releaseId: 'a'.repeat(64), path: '/managed/Singhouse' }
  const journal = { targetIdentity: { releaseId: active.releaseId } }
  const result = await runBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {},
    ready: async () => calls.push('ready'), wait: async pid => calls.push(`wait:${pid}`),
    storeFactory: () => ({ journal: async () => journal,
      authenticatedActive: async () => active,
      verifyHandoff: async (found, recovery) => { assert.equal(found, journal); assert.ok(recovery); calls.push('verified') },
      active: async options => { assert.equal(options.handoff, journal); return active } }),
    recoveryFactory: () => ({ verifiedRecovery: true }),
    launch: async selected => { calls.push(selected.releaseId); return { launched: true } },
    supervise: async launched => launched, activation: immediateActivation })
  assert.deepEqual(result, { launched: true })
  assert.deepEqual(calls, ['ready', 'wait:9', 'verified', active.releaseId])
})

test('bootstrap refuses an active release not named by the verified handoff', async () => {
  const journal = { targetIdentity: { releaseId: 'a'.repeat(64) }, previousIdentity: { releaseId: 'c'.repeat(64) } }
  await assert.rejects(() => runBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {},
    wait: async () => {}, storeFactory: () => ({ journal: async () => journal,
      authenticatedActive: async () => ({ releaseId: 'b'.repeat(64) }) }), recoveryFactory: () => ({}),
    activation: immediateActivation }), /authenticated handoff/)
})

test('two pre-backend bootstraps serialize and the waiting loser reconciles a completed recovery without rolling back', async () => {
  const target = 'a'.repeat(64), prior = 'b'.repeat(64)
  const journal = { targetIdentity: { releaseId: target }, previousIdentity: { releaseId: prior } }
  let selected = target, unlock = Promise.resolve(), releaseFirstSupervision
  const firstSupervision = new Promise(done => { releaseFirstSupervision = done })
  const activation = async () => {
    const predecessor = unlock
    let release
    unlock = new Promise(done => { release = done })
    await predecessor
    return { release: async () => release() }
  }
  const store = { journal: async () => journal, authenticatedActive: async () => ({ releaseId: selected }),
    verifyHandoff: async () => {} }
  let supervised = 0, rollbacks = 0
  const options = { stateRoot: '/private/state', parentPid: 9, contract: {}, wait: async () => {},
    ready: async () => {}, activation, storeFactory: () => store, recoveryFactory: () => ({}),
    launch: async active => ({ launched: true, releaseId: active.releaseId, child: { unref() {} } }),
    supervise: async launched => {
      supervised += 1
      await firstSupervision
      rollbacks += 1; selected = prior
      return { ...launched, recovered: true }
    } }
  const winner = runBootstrap(options)
  await new Promise(done => setImmediate(done))
  const loser = runBootstrap(options)
  await new Promise(done => setImmediate(done))
  assert.equal(supervised, 1)
  releaseFirstSupervision()
  const [winnerResult, loserResult] = await Promise.all([winner, loser])
  assert.equal(winnerResult.recovered, true)
  assert.equal(loserResult.releaseId, prior)
  assert.equal(loserResult.reconciled, true)
  assert.equal(supervised, 1)
  assert.equal(rollbacks, 1)
})

test('original v0 stable wrapper launches authenticated v2 after two updates without matching the v1 handoff prior', async () => {
  const v0 = '0'.repeat(64), v1 = '1'.repeat(64), v2 = '2'.repeat(64)
  const latestHandoff = { previousIdentity: { releaseId: v1 }, targetIdentity: { releaseId: v2 } }
  const active = { releaseId: v2, path: '/managed/v2/Singhouse' }
  const calls = []
  const result = await runStableBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {},
    ready: async () => calls.push('ready'), wait: async pid => calls.push(`wait:${pid}`),
    storeFactory: () => ({ journal: async () => ({ ...latestHandoff, state: 'completed' }), authenticatedActive: async () => {
      assert.notEqual(v0, latestHandoff.previousIdentity.releaseId)
      calls.push(`authenticated:${latestHandoff.targetIdentity.releaseId}`)
      return active
    } }),
    launch: async selected => { calls.push(`launch:${selected.releaseId}`); return { launched: true, releaseId: selected.releaseId } },
    activation: immediateActivation })
  assert.deepEqual(result, { launched: true, releaseId: v2 })
  assert.deepEqual(calls, ['ready', 'wait:9', `authenticated:${v2}`, `launch:${v2}`])
})

test('stable wrapper retains the activation lease while an awaiting target is supervised', async () => {
  const target = 'd'.repeat(64), journal = { state: 'awaiting-target', targetIdentity: { releaseId: target } }
  const calls = []
  const result = await runStableBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {}, wait: async () => {},
    activation: async () => ({ release: async () => calls.push('unlock') }),
    storeFactory: () => ({ journal: async () => journal, authenticatedActive: async () => ({ releaseId: target }),
      verifyHandoff: async () => calls.push('verify') }), recoveryFactory: () => ({}),
    launch: async () => ({ launched: true, child: child() }),
    supervise: async launched => { calls.push('supervise'); assert.deepEqual(calls, ['verify', 'supervise']); return launched } })
  assert.equal(result.launched, true)
  assert.deepEqual(calls, ['verify', 'supervise', 'unlock'])
})

for (const [name, run] of [['update', runBootstrap], ['stable', runStableBootstrap]]) {
  test(`${name} bootstrap reaps a partial target and performs exact paired recovery when launch handshake fails`, async () => {
    const target = 'e'.repeat(64), prior = 'f'.repeat(64)
    const journal = { state: 'awaiting-target', targetIdentity: { releaseId: target },
      previousIdentity: { releaseId: prior }, recoveryPoint: 'point-launch' }
    const partial = child(); partial.exitCode = null; partial.signalCode = null
    let killed = false, recoveries = 0
    partial.kill = signal => { killed = signal === 'SIGTERM'; partial.exitCode = 1; queueMicrotask(() => partial.emit('exit', 1)); return true }
    const failure = new Error('spawn handshake failed')
    Object.defineProperty(failure, 'managedChild', { value: partial })
    const result = await run({ stateRoot: '/private/state', parentPid: 9, contract: {}, wait: async () => {},
      activation: immediateActivation,
      storeFactory: () => ({ journal: async () => journal, authenticatedActive: async () => ({ releaseId: target }), verifyHandoff: async () => {} }),
      recoveryFactory: () => ({}), launch: async () => { throw failure },
      recover: async (value, options) => {
        recoveries += 1; assert.equal(value, journal); assert.equal(options.stateRoot, '/private/state')
      } })
    assert.equal(killed, true); assert.equal(recoveries, 1)
    assert.deepEqual(result, { launched: false, releaseId: target, recovered: true, failure: 'spawn handshake failed' })
  })
}

test('lease loss during a partial launch reaps the child without starting paired recovery', async () => {
  const lease = controlledActivation(), target = 'a'.repeat(64)
  const journal = { state: 'awaiting-target', targetIdentity: { releaseId: target }, previousIdentity: { releaseId: 'b'.repeat(64) } }
  const partial = child(); partial.exitCode = null; partial.signalCode = null
  let killed = false, recovered = false
  partial.kill = () => { killed = true; partial.exitCode = 1; queueMicrotask(() => partial.emit('exit', 1)); return true }
  const failure = new Error('spawn handshake failed'); Object.defineProperty(failure, 'managedChild', { value: partial })
  await assert.rejects(() => runBootstrap({ stateRoot: '/private/state', parentPid: 9, contract: {}, wait: async () => {},
    activation: async () => lease,
    storeFactory: () => ({ journal: async () => journal, authenticatedActive: async () => ({ releaseId: target }), verifyHandoff: async () => {} }),
    recoveryFactory: () => ({}), launch: async () => { lease.lose(); throw failure }, recover: async () => { recovered = true },
  }), /lease was lost/)
  assert.equal(killed, true); assert.equal(recovered, false)
})

test('platform launch primitives preserve exact managed target selection', async () => {
  let closed = false
  const opened = { close: async () => { closed = true }, fd: 7 }
  const active = { releaseId: 'b'.repeat(64), root: '/managed/release', path: '/managed/release/Singhouse', entrypoint: 'Singhouse' }
  for (const [platform, expected] of [['linux', '/proc/self/fd/3'], ['win32', active.path]]) {
    let command
    const result = await launchManaged(active, { platform, environment: { KEEP: 'yes', ELECTRON_RUN_AS_NODE: '1', SINGHOUSE_RECOVERY_KIT: '1' }, spawnImpl: (value, args, options) => {
      assert.equal(closed, false)
      assert.deepEqual(options.env, { KEEP: 'yes' })
      command = { value, args, options }; const process = child(); queueMicrotask(() => process.emit('spawn')); return process
    }, openExecutable: async () => opened })
    assert.equal(command.value, expected); assert.equal(result.launched, true)
    assert.equal(closed, true); closed = false
  }
  const mac = { ...active, path: '/managed/release/Singhouse.app/Contents/MacOS/Singhouse',
    entrypoint: 'Singhouse.app/Contents/MacOS/Singhouse' }
  let command
  await launchManaged(mac, { platform: 'darwin', environment: { KEEP: 'yes', ELECTRON_RUN_AS_NODE: '1', SINGHOUSE_RECOVERY_KIT: '1' }, spawnImpl: (value, args, options) => {
    assert.deepEqual(options.env, { KEEP: 'yes' })
    command = { value, args }; const process = child(); queueMicrotask(() => process.emit('spawn')); return process
  }, openExecutable: async () => opened })
  assert.equal(command.value, mac.path)
  assert.deepEqual(command.args, [])
})

test('Linux launch consumes the held verified descriptor after path replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singhouse-launch-race-')), path = join(root, 'Singhouse')
  await writeFile(path, 'verified-original', { mode: 0o700 })
  const active = { releaseId: 'c'.repeat(64), root, path, entrypoint: 'Singhouse' }
  let descriptorBytes
  await launchManaged(active, { platform: 'linux', spawnImpl: (command, args, options) => {
    renameSync(path, `${path}.old`); writeFileSync(path, 'replacement')
    descriptorBytes = readFileSync(options.stdio[3], 'utf8')
    const process = child(); queueMicrotask(() => process.emit('spawn')); return process
  } })
  assert.equal(descriptorBytes, 'verified-original')
})

function supervisedFixture(platform, arch) {
  const prior = `${platform}-${arch}-prior`, target = `${platform}-${arch}-target`
  const handoff = { schema: 1, kind: 'update-handoff', state: 'awaiting-target', sequence: 1,
    previousIdentity: { releaseId: prior }, targetIdentity: { releaseId: target }, recoveryPoint: 'point-1',
    recoveryKit: { id: 'kit-point-1', manifestSha256: 'a'.repeat(64) } }
  const process = child(); process.exitCode = null; process.signalCode = null
  const installed = { application: target, database: 'target-database' }
  let current = handoff
  const store = { journal: async () => current, verifyHandoff: async value => assert.equal(value.state, 'completed'),
    active: async () => ({ releaseId: target }), verifyCompletion: async value => assert.equal(value.state, 'completed') }
  return { prior, target, handoff, process, installed, store,
    complete() { current = { ...handoff, state: 'completed', completedAt: new Date().toISOString() } } }
}

for (const [platform, arch, failure] of [
  ['linux', 'x64', 'pre-backend crash'],
  ['win32', 'x64', 'pre-presentation crash'],
  ['darwin', 'arm64', 'presentation timeout'],
]) {
  test(`automatic rollback restores the paired app and database after ${failure} on ${platform}-${arch}`, async () => {
    const fixture = supervisedFixture(platform, arch)
    let clock = 0, stopped = false
    const recover = async (handoff, options) => {
      assert.equal(handoff, fixture.handoff); assert.equal(options.platform, platform); assert.equal(options.arch, arch)
      assert.equal(stopped, true, 'paired recovery must begin only after forced target-tree shutdown completes')
      fixture.installed.application = fixture.prior; fixture.installed.database = 'prior-database'
    }
    if (failure.includes('crash')) queueMicrotask(() => fixture.process.emit('exit', 1))
    const result = await superviseManagedTarget({ launched: true, child: fixture.process }, {
      store: fixture.store, handoff: fixture.handoff, recovery: {}, stateRoot: '/private/state', platform, arch,
      timeoutMs: 2, pollMs: 1, now: () => clock,
      delay: async milliseconds => { clock += milliseconds },
      stop: async targetProcess => { assert.equal(targetProcess, fixture.process); stopped = true }, recover,
    })
    assert.equal(result.recovered, true)
    assert.equal(stopped, true)
    assert.deepEqual(fixture.installed, { application: fixture.prior, database: 'prior-database' })
  })
}

test('linux-arm64 target exit after authenticated presentation acknowledgement never rolls back', async () => {
  const fixture = supervisedFixture('linux', 'arm64')
  fixture.complete()
  let recovered = false
  const result = await superviseManagedTarget({ launched: true, child: fixture.process }, {
    store: fixture.store, handoff: fixture.handoff, recovery: {}, stateRoot: '/private/state',
    platform: 'linux', arch: 'arm64', recover: async () => { recovered = true },
  })
  fixture.process.emit('exit', 0)
  await new Promise(done => setImmediate(done))
  assert.equal(result.acknowledged, true)
  assert.equal(fixture.process.unrefed, true)
  assert.equal(recovered, false)
  assert.deepEqual(fixture.installed, { application: fixture.target, database: 'target-database' })
})

test('a completed journal with incoherent prerequisite state is not acknowledged and rolls back', async () => {
  const fixture = supervisedFixture('linux', 'x64'); fixture.complete()
  fixture.store.verifyCompletion = async () => { throw new Error('activated sequence mismatch') }
  let stopped = false, recovered = false
  const result = await superviseManagedTarget({ launched: true, child: fixture.process }, {
    store: fixture.store, handoff: fixture.handoff, recovery: {}, stateRoot: '/private/state',
    stop: async () => { stopped = true }, recover: async () => { recovered = true },
  })
  assert.equal(result.acknowledged, false)
  assert.equal(stopped, true); assert.equal(recovered, true)
})

test('a target crash after show but before rendered-frame acknowledgement rolls back the paired state', async () => {
  const fixture = supervisedFixture('linux', 'x64')
  let shown = false, completed = false
  await assert.rejects(() => presentAndCompleteStartup({
    completeStartup: async () => { completed = true; fixture.complete() },
  }, { state: 'awaiting-presentation' }, {
    ready: async () => {}, load: async () => {}, show: async () => { shown = true },
    confirm: async () => { fixture.process.exitCode = 1; throw new Error('renderer crashed before frame evidence') },
  }), /renderer crashed before frame evidence/)
  assert.equal(shown, true)
  assert.equal(completed, false)

  const result = await superviseManagedTarget({ launched: true, child: fixture.process }, {
    store: fixture.store, handoff: fixture.handoff, recovery: {}, stateRoot: '/private/state',
    platform: 'linux', arch: 'x64', stop: async () => {},
    recover: async () => { fixture.installed.application = fixture.prior; fixture.installed.database = 'prior-database' },
  })
  assert.equal(result.recovered, true)
  assert.deepEqual(fixture.installed, { application: fixture.prior, database: 'prior-database' })
})

test('automatic recovery uses the exact handoff-bound native kit on every qualified target', async () => {
  for (const [platform, arch, entrypoint] of [
    ['linux', 'x64', 'runtime/Singhouse'], ['linux', 'arm64', 'runtime/Singhouse'],
    ['win32', 'x64', 'runtime/Singhouse.exe'],
    ['darwin', 'arm64', 'runtime/Singhouse.app/Contents/MacOS/Singhouse'],
  ]) {
    const stateRoot = await mkdtemp(join(tmpdir(), `singhouse-auto-recovery-${platform}-${arch}-`))
    const point = 'point-Abc123', kitId = `kit-${point}`, kitRoot = join(stateRoot, 'recovery-tool', 'kits', kitId)
    await mkdir(kitRoot, { recursive: true })
    const manifest = { schema: 2, kind: 'recovery-kit', target: { platform, arch },
      runtimeEntrypoint: entrypoint, files: [] }
    await writeFile(join(kitRoot, 'manifest.json'), `${canonicalJson(manifest)}\n`)
    const handoff = { recoveryPoint: point, previousIdentity: { releaseId: 'prior' },
      recoveryKit: { id: kitId, manifestSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex') } }
    let invocation
    const result = await invokePairedRecovery(handoff, { stateRoot, platform, arch, environment: { KEEP: 'yes' },
      pythonPath: '/native/python', helperPath: '/native/backend.py',
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options }
        const process = child(); queueMicrotask(() => process.emit('exit', 0)); return process
      } })
    assert.equal(invocation.command, '/native/python')
    assert.deepEqual(invocation.args, ['-I', '-B', '/native/backend.py', '--launch-recovery-kit', kitRoot,
      handoff.recoveryKit.manifestSha256, platform, arch,
      JSON.stringify([stateRoot, point, join(stateRoot, 'backend')])])
    assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(invocation.options.env.SINGHOUSE_RECOVERY_KIT, undefined)
    assert.equal(invocation.options.env.KEEP, 'yes')
    assert.deepEqual(result, { recovered: true, releaseId: 'prior' })
  }
})

test('lease loss terminates the native paired-recovery subprocess before rejecting', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'singhouse-auto-recovery-lease-'))
  const kitId = 'kit-point-Abc123', kitRoot = join(stateRoot, 'recovery-tool', 'kits', kitId)
  await mkdir(kitRoot, { recursive: true })
  const manifest = { schema: 2, kind: 'recovery-kit', target: { platform: 'linux', arch: 'x64' },
    runtimeEntrypoint: 'runtime/Singhouse', files: [] }
  await writeFile(join(kitRoot, 'manifest.json'), `${canonicalJson(manifest)}\n`)
  const lease = controlledActivation(); let killed = false, exitedBeforeReject = false
  const recovery = invokePairedRecovery({ recoveryPoint: 'point-Abc123', previousIdentity: { releaseId: 'prior' },
    recoveryKit: { id: kitId, manifestSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex') } }, {
    stateRoot, platform: 'linux', arch: 'x64', pythonPath: '/native/python', helperPath: '/native/backend.py', signal: lease.signal,
    spawnImpl: () => {
      const process = child(); process.exitCode = null; process.signalCode = null
      process.kill = () => { killed = true; process.exitCode = 143; queueMicrotask(() => { exitedBeforeReject = true; process.emit('exit', 143) }); return true }
      queueMicrotask(() => lease.lose())
      return process
    },
  })
  await assert.rejects(() => recovery, /lease was lost/)
  assert.equal(killed, true); assert.equal(exitedBeforeReject, true)
})
