// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, derivePolicyId, deriveReleaseIdentity } from '../release.mjs'
import { createPortablePayload } from '../build/release_receipt.mjs'
import { completeActivationHandoff, completeManualRestoreHandoff, confirmRenderedFrame, DatabaseGuard, OperationGate, RecoveryStore, UpdateController, UpdateStore, inspectPortable, installationBoundaryBusy, presentAndCompleteStartup, updateBoundary } from '../update_manager.mjs'
import { superviseManagedTarget } from '../bootstrap.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const durableReplace = (source, destination) => rename(source, destination)
const temp = name => mkdtemp(join(tmpdir(), `singhouse-update-${name}-`))
const idle = () => ({ projectorOpen: false, audible: false, activeJobs: 0, installing: false, backendReady: true })
const DEFAULT_POLICY = sha('test-policy')
const publishRecoveryKit = async (_previous, binding) => ({ id: `kit-${binding.recoveryPoint}`,
  manifest: { schema: 2, kind: 'recovery-kit', binding } })

test('startup completion waits for readiness and explicit rendered-frame evidence', async () => {
  const calls = []
  let releaseReady
  const ready = new Promise(resolve => { releaseReady = resolve })
  const controller = { completeStartup: async value => { calls.push('complete'); return value } }
  const completing = presentAndCompleteStartup(controller, { state: 'awaiting-presentation' }, {
    ready: async () => { calls.push('ready-wait'); await ready; calls.push('ready') },
    load: async () => { calls.push('loaded') },
    show: async () => { calls.push('shown') },
    confirm: async () => { calls.push('frame'); return { rendererFrame: true, captureBytes: 32 } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['ready-wait', 'loaded'])
  releaseReady()
  assert.deepEqual(await completing, { state: 'awaiting-presentation' })
  assert.deepEqual(calls, ['ready-wait', 'loaded', 'ready', 'shown', 'frame', 'complete'])
})

test('a crash after show but before frame acknowledgement leaves startup incomplete for rollback', async () => {
  let completed = false
  const controller = { completeStartup: async () => { completed = true } }
  await assert.rejects(() => presentAndCompleteStartup(controller, { state: 'awaiting-presentation' }, {
    ready: async () => {}, load: async () => {}, show: async () => {},
    confirm: async () => { throw new Error('renderer crashed after show') },
  }), /renderer crashed after show/)
  assert.equal(completed, false)
})

test('completion prerequisite faults leave the handoff awaiting and therefore recoverable', async () => {
  for (const failureAt of ['activateSequence', 'supersedeRecovery']) {
    const target = { releaseId: 'a'.repeat(64) }
    const journal = { state: 'awaiting-target', sequence: 1, targetIdentity: target,
      previousIdentity: { releaseId: 'b'.repeat(64) } }
    let persisted = journal
    const calls = []
    const updates = {
      journal: async () => persisted,
      active: async () => ({ releaseId: target.releaseId }),
      activateSequence: async () => { calls.push('activateSequence'); if (failureAt === 'activateSequence') throw new Error('sequence disk fault') },
      supersedeRecovery: async () => { calls.push('supersedeRecovery'); if (failureAt === 'supersedeRecovery') throw new Error('recovery disk fault') },
      writeJournal: async value => { calls.push('writeJournal'); persisted = value },
      verifyCompletion: async () => calls.push('verifyCompletion'),
    }
    const controller = new UpdateController({ identity: target, updates, recovery: {} })
    await assert.rejects(() => controller.completeStartup({ state: 'awaiting-presentation', journal }), /disk fault/)
    assert.equal(persisted.state, 'awaiting-target')
    assert.deepEqual(calls, failureAt === 'activateSequence' ? ['activateSequence'] : ['activateSequence', 'supersedeRecovery'])
    const process = new EventEmitter()
    process.exitCode = 1; process.signalCode = null
    let rollbacks = 0
    const supervised = await superviseManagedTarget({ launched: true, child: process }, {
      store: { journal: async () => persisted }, handoff: journal, recovery: {}, stateRoot: '/private/state',
      stop: async () => {}, recover: async () => { rollbacks += 1 },
    })
    assert.equal(supervised.recovered, true)
    assert.equal(rollbacks, 1)
  }
})

test('completed presentation is published only after durable completion prerequisites', async () => {
  const target = { releaseId: 'c'.repeat(64) }
  const journal = { state: 'awaiting-target', sequence: 2, targetIdentity: target,
    previousIdentity: { releaseId: 'd'.repeat(64) } }
  let persisted = journal
  const calls = []
  const updates = {
    journal: async () => persisted, active: async () => ({ releaseId: target.releaseId }),
    activateSequence: async value => { calls.push(`activate:${value.state}`) },
    supersedeRecovery: async value => { calls.push(`supersede:${value.state}`) },
    writeJournal: async value => { calls.push(`journal:${value.state}`); persisted = value },
    verifyCompletion: async value => { calls.push(`verify:${value.state}`) },
  }
  const result = await new UpdateController({ identity: target, updates, recovery: {} })
    .completeStartup({ state: 'awaiting-presentation', journal })
  assert.equal(result.state, 'completed')
  assert.deepEqual(calls, ['activate:completed', 'supersede:completed', 'journal:completed', 'verify:completed'])
})

test('rendered-frame confirmation requires renderer and nonempty compositor evidence', async () => {
  let script = ''
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, executeJavaScript: async value => { script = value; return true } },
    capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 3 }), toPNG: () => Buffer.from('png') }),
  }
  assert.deepEqual(await confirmRenderedFrame(window), { rendererFrame: true, captureBytes: 3, width: 2, height: 3 })
  assert.match(script, /requestAnimationFrame\(\(\) => requestAnimationFrame/)
  window.capturePage = async () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) })
  await assert.rejects(() => confirmRenderedFrame(window), /nonempty application frame/)
})

test('shared gate rejects queued menu and IPC operations until their owner completes', async () => {
  const kinds = ['processing installation', 'model installation', 'Heart setup', 'release operation']
  for (const owner of kinds) {
    const gate = new OperationGate()
    let release
    const running = gate.run(owner, () => new Promise(resolve => { release = resolve }))
    for (const queued of kinds) await assert.rejects(() => gate.run(queued, async () => {}), new RegExp(`${owner} is already running`))
    assert.equal(gate.conflicts(owner), false)
    assert.equal(gate.conflicts(kinds.find(kind => kind !== owner)), true)
    release(); await running
    await gate.run('release operation', async () => {})
  }
})

test('update boundary refuses every application or model installation operation', () => {
  const cases = [
    { installation: {} },
    { processingManager: { busy: true } },
    { modelCache: { busy: true } },
    { heartSetup: { operation: Promise.resolve() } },
    { processingOperation: Promise.resolve() },
  ]
  for (const dependencies of cases) {
    const installing = installationBoundaryBusy(dependencies)
    assert.equal(installing, true)
    assert.deepEqual(updateBoundary({ ...idle(), installing }), {
      safe: false, reasons: ['Wait for installation activity'],
    })
  }
  assert.equal(installationBoundaryBusy({ processingManager: { busy: false }, modelCache: { busy: false } }), false)
})
function identity(seed, { policyId = DEFAULT_POLICY, appVersion = '0.1.0', schemaHistory = 1 } = {}) {
  const digest = value => requireHash(`${seed}-${value}`)
  return deriveReleaseIdentity({ schema: 1, appVersion, edition: 'core', policyId, sourceCommit: seed.repeat(40).slice(0, 40),
    electronVersion: '44.3.0', electronRuntimeDigest: digest('electron'), electronAppDigest: digest('asar'), frontendDigest: digest('front'), backendDigest: digest('back'),
    nativeRuntimeId: digest('native'), runtimeLocksDigest: digest('locks'), modelPolicyDigest: digest('models'),
    schemaHistory, assemblyDigest: digest('assembly'), applicationInventoryDigest: digest('application-inventory') })
}
function requireHash(value) { return sha(value) }

function signer() {
  const keys = generateKeyPairSync('ed25519')
  const raw = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  const policy = { schema: 1, channel: 'test', edition: 'core', schemaHistory: 1,
    minimumReadableSchemaHistory: 1, updatesEnabled: true, signatureThreshold: 1, trustedUpdateKeys: [{ id: 'test', publicKey: raw }] }
  policy.policyId = derivePolicyId(policy)
  return { privateKey: keys.privateKey, policy }
}
async function application(root, platform, arch, release) {
  const source = join(root, `${platform}-${release.releaseId.slice(0, 6)}`)
  const entrypoint = platform === 'linux' ? 'Singhouse' : platform === 'win32' ? 'Singhouse.exe' : 'Singhouse.app/Contents/MacOS/Singhouse'
  const resourceRoot = platform === 'darwin' ? 'Singhouse.app/Contents/Resources' : 'resources'
  for (const path of [entrypoint, `${resourceRoot}/app.asar`, `${resourceRoot}/native/manifest.json`,
    `${resourceRoot}/native/files.json`, `${resourceRoot}/native/assembly.json`]) {
    await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), `bytes:${path}:${release.releaseId}`)
  }
  if (platform !== 'win32') await chmod(join(source, entrypoint), 0o755)
  const output = join(root, `${platform}-${release.releaseId.slice(0, 8)}.shapp`)
  await createPortablePayload({ sourceDirectory: source, output, identity: release, platform, arch, entrypoint })
  const bytes = await readFile(output)
  return { output, record: { name: output.split('/').at(-1), size: bytes.length,
    sha256: sha(bytes), identity: release, platform, arch } }
}
function envelope(current, target, rollback, applicationRecord, key, sequence = 1) {
  const signed = { schema: 1, kind: 'singhouse-update-metadata', edition: target.edition, channel: 'test',
    policyId: target.policyId, sequence, identity: target,
    supersedes: [current.releaseId], requires: { schemaHistory: target.schemaHistory, minimumReadableSchemaHistory: 1 },
    files: [{ role: 'application', ...applicationRecord }, { role: 'rollback', ...rollback }] }
  return { schema: 1, signed, signatures: [{ keyId: 'test', signature: sign(null, Buffer.from(canonicalJson(signed)), key).toString('base64') }] }
}

test('first-installer fallback accepts only absent or safely empty update state', async () => {
  const root = await temp('first-installer-state'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const trust = signer(), current = identity('0', { policyId: trust.policy.policyId })
  const store = new UpdateStore(join(state, 'updates'), trust.policy,
    { currentIdentity: current, platform: 'linux', arch: 'x64' }, { stateRoot: state, durableReplace })
  assert.equal(await store.authenticatedActive({ allowAbsentState: true }), null)
  await mkdir(join(state, 'updates'), { mode: 0o700 })
  assert.equal(await store.authenticatedActive({ allowAbsentState: true }), null)
  await mkdir(join(state, 'updates', 'staged'), { mode: 0o700 })
  assert.equal(await store.authenticatedActive({ allowAbsentState: true }), null)
  await writeFile(join(state, 'updates', 'sequence.json'), '{corrupt', { mode: 0o600 })
  await assert.rejects(() => store.authenticatedActive({ allowAbsentState: true }))
})

test('verified first installer reopens the shipped release after staging but before applying an update', async () => {
  const root = await temp('first-installer-staged'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const trust = signer(), current = identity('1', { policyId: trust.policy.policyId }),
    target = identity('2', { policyId: trust.policy.policyId, appVersion: '0.2.0' })
  const previous = await application(root, 'linux', 'x64', current), next = await application(root, 'linux', 'x64', target)
  const expected = { currentIdentity: current, platform: 'linux', arch: 'x64', lastSequence: 0 }
  const store = new UpdateStore(join(state, 'updates'), trust.policy, expected, { stateRoot: state, durableReplace })
  await store.stage(envelope(current, target, previous.record, next.record, trust.privateKey), { artifactDirectory: root })
  const reopened = new UpdateStore(join(state, 'updates'), trust.policy, expected, { stateRoot: state, durableReplace })
  assert.equal(await reopened.active(), null)
  assert.equal(await reopened.journal(), null)
  assert.equal(await reopened.authenticatedActive({ allowAbsentState: true }), null)

  await writeFile(join(state, 'updates', 'unexpected'), 'partial', { mode: 0o600 })
  await assert.rejects(() => reopened.authenticatedActive({ allowAbsentState: true }), /No authenticated update handoff/)
})

test('stable v0 launcher authenticates active v2 after two updates while a managed v0 identity still mismatches', async () => {
  const root = await temp('stable-launcher-chain'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const trust = signer(), v0 = identity('0', { policyId: trust.policy.policyId }),
    v1 = identity('1', { policyId: trust.policy.policyId, appVersion: '0.2.0', schemaHistory: 2 }),
    v2 = identity('2', { policyId: trust.policy.policyId, appVersion: '0.3.0', schemaHistory: 3 })
  const a0 = await application(root, 'linux', 'x64', v0), a1 = await application(root, 'linux', 'x64', v1),
    a2 = await application(root, 'linux', 'x64', v2)
  const database = { plan: async () => ({ schema: 1, exists: true, revision: 'c0008', size: 64, sidecars: [] }),
    backup: async path => { await writeFile(path, 'sqlite'); return { size: 6, sha256: sha('sqlite'), revision: 'c0008' } } }
  const recovery = new RecoveryStore(join(state, 'recovery'), { stateRoot: state, durableReplace })
  const controller = (release, store) => new UpdateController({ identity: release, database, recovery, updates: store,
    activity: async () => idle(), quiesce: async () => ({ schema: 1, quiesced: true, activeMutations: 0,
      activeClaims: 0, jobs: { queued: 0, running: 0, nonterminal: 0 } }), resume: async () => {} })
  const first = new UpdateStore(join(state, 'updates'), trust.policy,
    { currentIdentity: v0, platform: 'linux', arch: 'x64', lastSequence: 0 }, { stateRoot: state, durableReplace })
  await first.stage(envelope(v0, v1, a0.record, a1.record, trust.privateKey), { artifactDirectory: root })
  const prepareRecovery = async (_previous, binding) => ({ id: `kit-${binding.recoveryPoint}`, manifest: { binding } })
  await controller(v0, first).activate({ stopBackend: async () => {}, prepareRecovery })
  const v1Controller = controller(v1, first), v1Startup = await v1Controller.reconcileStartup()
  await presentAndCompleteStartup(v1Controller, v1Startup, {
    load: async () => {}, ready: async () => {}, show: async () => {},
    confirm: async () => ({ rendererFrame: true, captureBytes: 1 }),
  })

  const second = new UpdateStore(join(state, 'updates'), trust.policy,
    { currentIdentity: v1, platform: 'linux', arch: 'x64', lastSequence: 1 }, { stateRoot: state, durableReplace })
  await second.stage(envelope(v1, v2, a1.record, a2.record, trust.privateKey, 2), { artifactDirectory: root })
  await controller(v1, second).activate({ stopBackend: async () => {}, prepareRecovery })
  const latest = await second.journal()
  assert.equal(latest.previousIdentity.releaseId, v1.releaseId)

  const stable = new UpdateStore(join(state, 'updates'), trust.policy,
    { platform: 'linux', arch: 'x64' }, { stateRoot: state, durableReplace })
  assert.equal((await stable.authenticatedActive()).releaseId, v2.releaseId)

  const metadataPath = join(state, 'updates', 'staged', v2.releaseId, 'update.json')
  const retainedEnvelope = JSON.parse(await readFile(metadataPath, 'utf8'))
  await chmod(metadataPath, 0o600)
  await writeFile(metadataPath, canonicalJson({ ...retainedEnvelope,
    signatures: [{ ...retainedEnvelope.signatures[0], signature: Buffer.alloc(64).toString('base64') }] }))
  await assert.rejects(() => stable.authenticatedActive(), /signature|threshold/i)
  await writeFile(metadataPath, canonicalJson(retainedEnvelope)); await chmod(metadataPath, 0o400)
  await rename(metadataPath, `${metadataPath}.missing`)
  await assert.rejects(() => stable.authenticatedActive(), /ENOENT|no such file/i)
  await rename(`${metadataPath}.missing`, metadataPath)

  assert.equal((await new UpdateController({ identity: v0, updates: stable, recovery }).reconcileStartup()).state,
    'release-mismatch')

  const retainedV1 = await stable.verifyInstalled(latest.previousApplication)
  await stable.select(retainedV1)
  const completedAt = new Date().toISOString()
  const completedRecovery = { schema: 1, kind: 'recovery-transaction', state: 'completed', releaseId: v1.releaseId,
    installationSha256: sha(canonicalJson(latest.previousApplication)), recoveryPoint: latest.recoveryPoint,
    recoveryManifestSha256: latest.recoveryManifestSha256, updateMetadataSha256: latest.updateMetadataSha256,
    startedAt: completedAt, completedAt }
  await writeFile(join(state, 'updates', 'recovery-transaction.json'), canonicalJson(completedRecovery), { mode: 0o600 })
  assert.equal((await stable.authenticatedActive()).releaseId, v1.releaseId)
  await writeFile(join(state, 'updates', 'recovery-transaction.json'), canonicalJson({ ...completedRecovery,
    updateMetadataSha256: 'f'.repeat(64) }))
  await assert.rejects(() => stable.authenticatedActive(), /completed recovery/)
})

test('stable wrapper authenticates the exact signed rollback selected before the first handoff', async () => {
  const root = await temp('pre-handoff-rollback'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const trust = signer(), current = identity('3', { policyId: trust.policy.policyId }),
    target = identity('4', { policyId: trust.policy.policyId, appVersion: '0.2.0', schemaHistory: 2 })
  const previous = await application(root, 'linux', 'x64', current), next = await application(root, 'linux', 'x64', target)
  const store = new UpdateStore(join(state, 'updates'), trust.policy,
    { currentIdentity: current, platform: 'linux', arch: 'x64', lastSequence: 0 }, { stateRoot: state, durableReplace })
  await store.stage(envelope(current, target, previous.record, next.record, trust.privateKey), { artifactDirectory: root })
  const controller = new UpdateController({ identity: current,
    database: { plan: async () => ({ schema: 1, exists: true, revision: 'c0008', size: 64, sidecars: [] }) },
    recovery: new RecoveryStore(join(state, 'recovery'), { stateRoot: state, durableReplace }), updates: store,
    activity: async () => idle(), quiesce: async () => { throw new Error('must not quiesce') } })
  const crash = new Error('crash at rollback-selected'); crash.simulatedCrash = true
  await assert.rejects(() => controller.activate({ stopBackend: async () => {}, prepareRecovery: publishRecoveryKit,
    checkpoint: async point => { if (point === 'rollback-selected') throw crash } }), /rollback-selected/)
  assert.equal(await store.journal(), null)

  const stable = new UpdateStore(join(state, 'updates'), trust.policy,
    { platform: 'linux', arch: 'x64' }, { stateRoot: state, durableReplace })
  assert.equal((await stable.authenticatedActive()).releaseId, current.releaseId)
  const metadataPath = join(state, 'updates', 'staged', target.releaseId, 'update.json')
  const retained = JSON.parse(await readFile(metadataPath, 'utf8'))
  await chmod(metadataPath, 0o600)
  await writeFile(metadataPath, canonicalJson({ ...retained,
    signatures: [{ ...retained.signatures[0], signature: Buffer.alloc(64).toString('base64') }] }))
  await assert.rejects(() => stable.authenticatedActive(), /authenticated update handoff|signature|threshold/i)
  await writeFile(metadataPath, canonicalJson(retained)); await chmod(metadataPath, 0o400)
  const selected = await stable.active()
  await chmod(selected.path, 0o700); await writeFile(selected.path, 'corrupt rollback executable')
  await assert.rejects(() => stable.authenticatedActive(), /managed release file changed/i)
})

for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['darwin', 'arm64']]) {
  test(`portable update atomically selects target and retains rollback on ${platform}-${arch}`, async () => {
    const root = await temp(`${platform}-${arch}`), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
    const trust = signer(), current = identity('a', { policyId: trust.policy.policyId }),
      target = identity('b', { policyId: trust.policy.policyId, appVersion: '0.2.0' })
    const previousPayload = await application(root, platform, arch, current), nextPayload = await application(root, platform, arch, target)
    const metadata = envelope(current, target, previousPayload.record, nextPayload.record, trust.privateKey)
    const expected = { currentIdentity: current, platform, arch, lastSequence: 0 }
    const store = new UpdateStore(join(state, 'updates'), trust.policy, expected,
      { stateRoot: state, durableReplace, platformTrust: async () => true })
    await store.stage(metadata, { artifactDirectory: root })
    if (platform === 'linux' && arch === 'x64') {
      const staged = await store.staged()
      const rollback = staged.manifest.files.find(file => file.role === 'rollback')
      const installed = await store.installPortable(staged, rollback, current)
      await store.select(installed)
      const record = Object.fromEntries(Object.entries(installed).filter(([key]) => !['root', 'path', 'manifest'].includes(key)))
      const now = new Date().toISOString()
      await writeFile(join(state, 'updates', 'recovery-transaction.json'), canonicalJson({ schema: 1,
        kind: 'recovery-transaction', state: 'completed', releaseId: current.releaseId,
        installationSha256: sha(canonicalJson(record)), recoveryPoint: 'point-previous',
        recoveryManifestSha256: '9'.repeat(64), updateMetadataSha256: '8'.repeat(64),
        startedAt: now, completedAt: now }), { mode: 0o600 })
    }
    const database = { plan: async () => ({ schema: 1, exists: true, revision: 'c0008', size: 64, sidecars: [] }),
      backup: async path => { await writeFile(path, 'sqlite'); return { size: 6, sha256: sha('sqlite'), revision: 'c0008' } } }
    const recovery = new RecoveryStore(join(state, 'recovery'), { stateRoot: state, durableReplace })
    const controller = new UpdateController({ contract: trust.policy, identity: current, database, recovery, updates: store,
      activity: async () => idle(), quiesce: async () => ({ schema: 1, quiesced: true, activeMutations: 0,
        activeClaims: 0, jobs: { queued: 0, running: 0, nonterminal: 0 } }), resume: async () => {} })
    const result = await controller.activate({ stopBackend: async () => {}, prepareRecovery: publishRecoveryKit })
    assert.equal(result.releaseId, target.releaseId)
    const handoff = await store.journal()
    assert.equal((await store.active({ handoff })).releaseId, target.releaseId)
    assert.deepEqual(await store.sequenceState(), { schema: 1, edition: 'core', channel: 'test',
      policyId: trust.policy.policyId, highestAccepted: 1, highestActivated: 0,
      acceptedReleaseId: target.releaseId })
    assert.equal((await store.verifyInstalled({ schema: 1, releaseId: current.releaseId })).releaseId, current.releaseId)
    if (platform === 'linux' && arch === 'x64') {
      const transaction = JSON.parse(await readFile(join(state, 'updates', 'recovery-transaction.json'), 'utf8'))
      assert.equal(transaction.state, 'completed')
    }
    const old = new UpdateController({ identity: current, updates: store, recovery })
    assert.equal((await old.reconcileStartup()).state, 'redirect-target')
    const targetController = new UpdateController({ identity: target, updates: store, recovery })
    const startup = await targetController.reconcileStartup()
    assert.equal((await presentAndCompleteStartup(targetController, startup, {
      load: async () => {}, ready: async () => {}, show: async () => {},
      confirm: async () => ({ rendererFrame: true, captureBytes: 1 }),
    })).state, 'completed')
    assert.deepEqual(await store.sequenceState(), { schema: 1, edition: 'core', channel: 'test',
      policyId: trust.policy.policyId, highestAccepted: 1, highestActivated: 1,
      acceptedReleaseId: target.releaseId })
    if (platform === 'linux' && arch === 'x64') {
      const transaction = JSON.parse(await readFile(join(state, 'updates', 'recovery-transaction.json'), 'utf8'))
      assert.equal(transaction.state, 'superseded')
      assert.equal(transaction.supersededBy, target.releaseId)
      assert.match(transaction.handoffSha256, /^[a-f0-9]{64}$/)
    }
  })
}

test('interrupted retrieval and extraction never change active selection', async () => {
  const root = await temp('interrupt'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const trust = signer(), current = identity('c', { policyId: trust.policy.policyId }),
    target = identity('d', { policyId: trust.policy.policyId, appVersion: '0.2.0' })
  const previous = await application(root, 'linux', 'x64', current), next = await application(root, 'linux', 'x64', target)
  const metadata = envelope(current, target, previous.record, next.record, trust.privateKey)
  const abort = new AbortController(); abort.abort(new Error('interrupted'))
  const store = new UpdateStore(join(state, 'updates'), trust.policy, { currentIdentity: current, platform: 'linux', arch: 'x64' },
    { stateRoot: state, durableReplace })
  await assert.rejects(() => store.stage(metadata, { artifactDirectory: root, signal: abort.signal }), /interrupted/)
  assert.equal(await store.staged(), null)
  assert.equal(await store.active(), null)
  const canceledRestart = new UpdateStore(join(state, 'updates'), trust.policy,
    { currentIdentity: current, platform: 'linux', arch: 'x64' }, { stateRoot: state, durableReplace })
  assert.equal(await canceledRestart.authenticatedActive({ allowAbsentState: true }), null)

  await writeFile(next.output, 'wrong bytes')
  await assert.rejects(() => store.stage(metadata, { artifactDirectory: root }), /size or checksum mismatch/)
  const failedRestart = new UpdateStore(join(state, 'updates'), trust.policy,
    { currentIdentity: current, platform: 'linux', arch: 'x64' }, { stateRoot: state, durableReplace })
  assert.equal(await failedRestart.authenticatedActive({ allowAbsentState: true }), null)
})

test('staging prefers adjacent artifacts and uses signed HTTPS only when one is absent', async () => {
  const root = await temp('local-first'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const trust = signer(), current = identity('e', { policyId: trust.policy.policyId }),
    target = identity('f', { policyId: trust.policy.policyId, appVersion: '0.2.0' })
  const previous = await application(root, 'linux', 'x64', current), next = await application(root, 'linux', 'x64', target)
  const remoteBytes = await readFile(next.output)
  const applicationRecord = { ...next.record, url: 'https://updates.example.invalid/target.shapp' }
  const metadata = envelope(current, target, previous.record, applicationRecord, trust.privateKey)
  await rm(next.output)
  const requested = [], progress = []
  const store = new UpdateStore(join(state, 'updates'), trust.policy,
    { currentIdentity: current, platform: 'linux', arch: 'x64' }, {
      stateRoot: state, durableReplace, progress: value => progress.push(value),
      fetch: async url => { requested.push(url); return new Response(remoteBytes) },
    })
  await store.stage(metadata, { artifactDirectory: root })
  assert.deepEqual(requested, [applicationRecord.url])
  assert.ok(progress.some(value => value.file === next.record.name))
  assert.ok(progress.every(value => typeof value.file === 'string'))
})

test('crashes at every durable handoff boundary leave an exact launchable release', async () => {
  const boundaries = ['recovery-captured', 'journal-preparing', 'handoff-verified', 'backend-stopped',
    'target-selected', 'journal-awaiting-target']
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index], root = await temp(`crash-${index}`), state = join(root, 'state')
    await mkdir(state, { mode: 0o700 })
    const trust = signer(), current = identity(index.toString(16), { policyId: trust.policy.policyId }),
      target = identity((index + 10).toString(16), { policyId: trust.policy.policyId, appVersion: '0.2.0' })
    const previous = await application(root, 'linux', 'x64', current), next = await application(root, 'linux', 'x64', target)
    const store = new UpdateStore(join(state, 'updates'), trust.policy,
      { currentIdentity: current, platform: 'linux', arch: 'x64', lastSequence: 0 }, { stateRoot: state, durableReplace })
    await store.stage(envelope(current, target, previous.record, next.record, trust.privateKey), { artifactDirectory: root })
    const database = { plan: async () => ({ schema: 1, exists: true, revision: 'c0008', size: 64, sidecars: [] }),
      backup: async path => { await writeFile(path, 'sqlite'); return { size: 6, sha256: sha('sqlite'), revision: 'c0008' } } }
    const recovery = new RecoveryStore(join(state, 'recovery'), { stateRoot: state, durableReplace })
    const controller = new UpdateController({ identity: current, database, recovery, updates: store,
      activity: async () => idle(), quiesce: async () => ({ schema: 1, quiesced: true, activeMutations: 0,
        activeClaims: 0, jobs: { queued: 0, running: 0, nonterminal: 0 } }), resume: async () => {} })
    const crash = new Error(`crash at ${boundary}`); crash.simulatedCrash = true
    let activationError
    await assert.rejects(() => controller.activate({ stopBackend: async () => {}, prepareRecovery: publishRecoveryKit,
      checkpoint: async point => { if (point === boundary) throw crash } }).catch(error => {
      activationError = error
      throw error
    }), new RegExp(boundary))
    assert.equal(Boolean(activationError.backendStopped), index >= boundaries.indexOf('backend-stopped'),
      'any failure after backend shutdown must keep the launcher in shutdown/handoff mode')
    const journal = await store.journal()
    if (!journal) {
      assert.equal(boundary, 'recovery-captured')
      assert.equal((await store.active()).releaseId, current.releaseId)
      continue
    }
    const old = new UpdateController({ identity: current, updates: store, recovery })
    const oldState = await old.reconcileStartup()
    if (['target-selected', 'journal-awaiting-target'].includes(boundary)) {
      assert.equal(oldState.state, 'redirect-target')
      const nextController = new UpdateController({ identity: target, updates: store, recovery })
      assert.equal((await nextController.reconcileStartup()).state, 'awaiting-presentation')
    } else assert.equal(oldState.state, 'retryable-prior')
  }
})

test('accepted sequence survives restart and rejects same-sequence substitution', async () => {
  const root = await temp('sequence'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const trust = signer(), current = identity('7', { policyId: trust.policy.policyId }),
    target = identity('8', { policyId: trust.policy.policyId, appVersion: '0.2.0' }),
    substituted = identity('9', { policyId: trust.policy.policyId, appVersion: '0.2.0' })
  const previous = await application(root, 'linux', 'x64', current), next = await application(root, 'linux', 'x64', target)
  const metadata = envelope(current, target, previous.record, next.record, trust.privateKey)
  const expected = { currentIdentity: current, platform: 'linux', arch: 'x64', lastSequence: 0 }
  const store = new UpdateStore(join(state, 'updates'), trust.policy, expected, { stateRoot: state, durableReplace })
  await store.stage(metadata, { artifactDirectory: root })
  const restarted = new UpdateStore(join(state, 'updates'), trust.policy, expected, { stateRoot: state, durableReplace })
  await restarted.stage(metadata, { artifactDirectory: root })
  const other = await application(root, 'linux', 'x64', substituted)
  await assert.rejects(() => restarted.stage(envelope(current, substituted, previous.record, other.record, trust.privateKey),
    { artifactDirectory: root }), /replayed update sequence/)
  assert.equal((await restarted.sequenceState()).highestAccepted, 1)
})

for (const mode of ['first-installed', 'managed']) {
  test(`${mode} staging publishes its verified pointer before sequence advancement and repairs pointer-new restart state`, async () => {
    const root = await temp(`stage-transaction-${mode}`), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
    const trust = signer(), v0 = identity('3', { policyId: trust.policy.policyId }),
      v1 = identity('4', { policyId: trust.policy.policyId, appVersion: '0.2.0' }),
      v2 = identity('5', { policyId: trust.policy.policyId, appVersion: '0.3.0' })
    const a0 = await application(root, 'linux', 'x64', v0), a1 = await application(root, 'linux', 'x64', v1),
      a2 = await application(root, 'linux', 'x64', v2)
    let current = v0, target = v1, previous = a0, next = a1, sequence = 1
    if (mode === 'managed') {
      const seed = new UpdateStore(join(state, 'updates'), trust.policy,
        { currentIdentity: v0, platform: 'linux', arch: 'x64', lastSequence: 0 }, { stateRoot: state, durableReplace })
      const seedStage = await seed.stage(envelope(v0, v1, a0.record, a1.record, trust.privateKey), { artifactDirectory: root })
      const installed = await seed.installPortable(seedStage, seedStage.manifest.files.find(file => file.role === 'application'), v1)
      await seed.select(installed, { sequence: 1 })
      await seed.activateSequence({ sequence: 1, targetIdentity: v1 })
      current = v1; target = v2; previous = a1; next = a2; sequence = 2
    }
    const metadata = envelope(current, target, previous.record, next.record, trust.privateKey, sequence)
    const expected = { currentIdentity: current, platform: 'linux', arch: 'x64', lastSequence: sequence - 1 }

    let failAt = 'staged.json'
    const faultReplace = async (source, destination) => {
      if (destination.endsWith(failAt)) throw new Error(`fault at ${failAt}`)
      await rename(source, destination)
    }
    const faulty = new UpdateStore(join(state, 'updates'), trust.policy, expected,
      { stateRoot: state, durableReplace: faultReplace })
    await assert.rejects(() => faulty.stage(metadata, { artifactDirectory: root }), /fault at staged.json/)
    assert.equal((await faulty.sequenceState()).highestAccepted, sequence - 1)

    // Retry publishes the already-verified immutable stage. A fault at the
    // following sequence commit leaves pointer-new/sequence-old.
    failAt = 'sequence.json'
    await assert.rejects(() => faulty.stage(metadata, { artifactDirectory: root }), /fault at sequence.json/)
    assert.equal((await faulty.sequenceState()).highestAccepted, sequence - 1)
    const pointer = JSON.parse(await readFile(join(state, 'updates', 'staged.json'), 'utf8'))
    assert.equal(pointer.releaseId, target.releaseId)

    const restarted = new UpdateStore(join(state, 'updates'), trust.policy, expected,
      { stateRoot: state, durableReplace })
    assert.equal((await restarted.staged()).manifest.identity.releaseId, target.releaseId)
    assert.deepEqual(await restarted.sequenceState(), { schema: 1, edition: 'core', channel: 'test',
      policyId: trust.policy.policyId, highestAccepted: sequence, highestActivated: mode === 'managed' ? 1 : 0,
      acceptedReleaseId: target.releaseId })
    assert.equal((await restarted.staged()).manifest.identity.releaseId, target.releaseId)
    if (mode === 'managed') assert.equal((await restarted.authenticatedActive()).releaseId, current.releaseId)
    else assert.equal(await restarted.authenticatedActive({ allowAbsentState: true }), null)
  })
}

test('an exact accepted update repairs corrupt or missing final stages without changing active selection', async () => {
  const root = await temp('stage-repair'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const trust = signer(), current = identity('a', { policyId: trust.policy.policyId }),
    target = identity('b', { policyId: trust.policy.policyId, appVersion: '0.2.0' })
  const previous = await application(root, 'linux', 'x64', current), next = await application(root, 'linux', 'x64', target)
  const metadata = envelope(current, target, previous.record, next.record, trust.privateKey)
  const store = new UpdateStore(join(state, 'updates'), trust.policy,
    { currentIdentity: current, platform: 'linux', arch: 'x64', lastSequence: 0 }, { stateRoot: state, durableReplace })
  const first = await store.stage(metadata, { artifactDirectory: root })
  const rollbackRecord = first.manifest.files.find(file => file.role === 'rollback')
  await store.select(await store.installPortable(first, rollbackRecord, current))
  assert.equal((await store.active()).releaseId, current.releaseId)

  const applicationRecord = first.manifest.files.find(file => file.role === 'application')
  const damaged = join(first.directory, applicationRecord.name)
  await chmod(damaged, 0o600); await writeFile(damaged, 'damaged')
  const repaired = await store.stage(metadata, { artifactDirectory: root })
  assert.equal((await readFile(join(repaired.directory, applicationRecord.name))).length, applicationRecord.size)
  assert.equal((await readdir(join(state, 'updates', 'staged', 'quarantine'))).length, 1)
  assert.equal((await store.active()).releaseId, current.releaseId)

  await rm(repaired.directory, { recursive: true })
  const restored = await store.stage(metadata, { artifactDirectory: root })
  assert.equal(restored.manifest.identity.releaseId, target.releaseId)
  assert.equal((await store.active()).releaseId, current.releaseId)
})

test('portable inspection rejects case collisions and symlink source entries', async () => {
  const root = await temp('unsafe'), release = identity('e'), source = join(root, 'app'); await mkdir(source)
  await writeFile(join(source, 'Singhouse'), 'run'); await chmod(join(source, 'Singhouse'), 0o755)
  await mkdir(join(source, 'resources', 'native'), { recursive: true })
  for (const path of ['resources/app.asar', 'resources/native/manifest.json', 'resources/native/files.json', 'resources/native/assembly.json']) await writeFile(join(source, path), path)
  await writeFile(join(source, 'A'), 'one'); await writeFile(join(source, 'a'), 'two')
  const payload = join(root, 'bad.shapp')
  await assert.rejects(() => createPortablePayload({ sourceDirectory: source, output: payload, identity: release,
    platform: 'linux', arch: 'x64' }), /case-colliding/)
  await symlink('/tmp', join(source, 'linked'))
  await assert.rejects(() => createPortablePayload({ sourceDirectory: source, output: join(root, 'linked.shapp'), identity: release, platform: 'linux', arch: 'x64' }), /symlink/)
})

test('manual recovery rejects update-bound and mismatched-writer points before quiesce', async () => {
  const current = identity('f'); let quiesced = false
  const recovery = { latestManual: async () => ({ manifest: { update: identity('1').releaseId, release: current, databaseWriter: current } }) }
  const controller = new UpdateController({ identity: current, activity: async () => idle(), recovery, updates: {}, database: {}, quiesce: async () => { quiesced = true } })
  await assert.rejects(() => controller.restore({ stopBackend: async () => {} }), /exact application and database/)
  recovery.latestManual = async () => ({ manifest: { update: null, release: current, databaseWriter: identity('2') } })
  await assert.rejects(() => controller.restore({ stopBackend: async () => {} }), /different release writer/)
  assert.equal(quiesced, false)
})

test('manual restore marks a failed stop as post-stop when the backend is no longer live', async () => {
  const current = identity('f')
  const point = { manifest: { update: null, release: current, databaseWriter: current } }
  const controller = new UpdateController({ identity: current, activity: async () => idle(),
    recovery: { latestManual: async () => point }, database: {},
    quiesce: async () => ({ schema: 1, quiesced: true, activeMutations: 0, activeClaims: 0,
      jobs: { queued: 0, running: 0, nonterminal: 0 } }), resume: async () => {} })
  let failure
  await assert.rejects(() => controller.restore({
    stopBackend: async () => { throw new Error('stop acknowledgement failed') }, backendLive: () => false,
  }).catch(error => { failure = error; throw error }), /stop acknowledgement failed/)
  assert.equal(failure.backendStopped, true)
})

test('manual and update recovery pointers remain independently discoverable', async () => {
  const root = await temp('recovery-pointers'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const current = identity('5'), target = identity('6')
  const database = { backup: async path => { await writeFile(path, 'sqlite'); return { size: 6, sha256: sha('sqlite'), revision: 'c0008' } } }
  const recovery = new RecoveryStore(join(state, 'recovery'), { stateRoot: state, durableReplace })
  await recovery.capture({ database, release: current, reason: 'manual' })
  const update = await recovery.capture({ database, release: current, reason: 'pre-update', update: target.releaseId })
  const manual = await recovery.capture({ database, release: current, reason: 'manual' })
  assert.equal((await recovery.latestManual()).id, manual.id)
  assert.equal((await recovery.latestUpdate()).id, update.id)
  const recoveryKit = { id: `kit-${update.id}`, manifestSha256: '7'.repeat(64) }
  const controller = new UpdateController({ identity: current, recovery, updates: { journal: async () => ({
    recoveryPoint: update.id, targetIdentity: target, recoveryKit,
  }) } })
  assert.equal((await controller.recoveryPoint()).id, manual.id)
  assert.deepEqual(await controller.updateRecoveryPoint(), { ...await recovery.verify(update.id), recoveryKit })
})

test('an orphan recovery point from a pre-journal abort cannot replace the selected compatible kit', async () => {
  const target = identity('8')
  const selected = { id: 'point-selected', manifest: { update: target.releaseId } }
  const orphan = { id: 'point-orphan', manifest: { update: identity('9').releaseId } }
  const recoveryKit = { id: 'kit-point-selected', manifestSha256: '7'.repeat(64) }
  const recovery = { latestUpdate: async () => orphan, verify: async id => {
    assert.equal(id, selected.id); return selected
  } }
  const controller = new UpdateController({ recovery, updates: { journal: async () => ({
    recoveryPoint: selected.id, targetIdentity: target, recoveryKit,
  }) } })
  assert.deepEqual(await controller.updateRecoveryPoint(), { ...selected, recoveryKit })
})

test('recovery durability defaults to the injectable bundled native helper contract', async () => {
  const root = await temp('native-helper'), state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  const calls = []
  const nativeHelper = async (python, helper, args, options) => {
    calls.push({ python, helper, args, options })
    await rename(args[1], args[2])
    return { schema: 1, durable: true }
  }
  const recovery = new RecoveryStore(join(state, 'recovery'), {
    stateRoot: state, lockPython: 'C:/app/python.exe', durabilityHelper: 'C:/app/backend.py', nativeHelper
  })
  const database = { backup: async path => { await writeFile(path, 'sqlite'); return { size: 6, sha256: sha('sqlite'), revision: 'c0008' } } }
  await recovery.capture({ database, release: identity('0'), reason: 'manual' })
  assert.ok(calls.length >= 2)
  for (const call of calls) {
    assert.equal(call.python, 'C:/app/python.exe')
    assert.equal(call.helper, 'C:/app/backend.py')
    assert.equal(call.args[0], '--durable-application-replace')
    assert.equal(call.options.failure, 'Application state could not be committed durably')
  }
})

test('a queued durable job rejects activation and releases the worker claim gate', async () => {
  const current = identity('3'), targetIdentity = identity('4')
  const record = value => ({ schema: 1, releaseId: value.releaseId, platform: 'linux', arch: 'x64',
    payloadSha256: '1'.repeat(64), manifestSha256: '2'.repeat(64), entrypoint: 'Singhouse' })
  const previous = record(current), target = record(targetIdentity)
  let resumed = false, stopped = false
  const updates = { active: async () => previous, installPortable: async () => target, journal: async () => null }
  const controller = new UpdateController({ identity: current, updates, recovery: {}, database: {},
    activity: async () => idle(), quiesce: async () => ({ schema: 1, quiesced: true, activeMutations: 0,
      activeClaims: 0, jobs: { queued: 1, running: 0, nonterminal: 1 } }), resume: async () => { resumed = true } })
  controller.review = async () => ({ plan: { ok: true }, boundary: { safe: true }, directory: '/stage',
    manifest: { sequence: 1, identity: targetIdentity, files: [{ role: 'application', ...target }] } })
  await assert.rejects(() => controller.activate({ stopBackend: async () => { stopped = true }, backendLive: () => true,
    prepareRecovery: publishRecoveryKit }), /boundary changed/)
  assert.equal(resumed, true)
  assert.equal(stopped, false)
})

test('activation failure after backend stop remains in shutdown mode', async () => {
  const current = identity('5'), targetIdentity = identity('6')
  const record = value => ({ schema: 1, releaseId: value.releaseId, platform: 'linux', arch: 'x64',
    payloadSha256: '1'.repeat(64), manifestSha256: '2'.repeat(64), entrypoint: 'Singhouse' })
  const previous = record(current), target = record(targetIdentity)
  let journal = null, resumed = false, backendAlive = true
  const updates = { active: async () => previous, installPortable: async () => target,
    writeJournal: async value => { journal = value }, journal: async () => journal,
    verifyHandoff: async () => {}, select: async () => { throw new Error('selection durability failed') } }
  const recovery = { capture: async () => ({ id: 'point-1', manifest: { exact: true } }) }
  const controller = new UpdateController({ identity: current, updates, recovery, database: {},
    activity: async () => idle(), quiesce: async () => ({ schema: 1, quiesced: true, activeMutations: 0,
      activeClaims: 0, jobs: { queued: 0, running: 0, nonterminal: 0 } }), resume: async () => { resumed = true } })
  controller.review = async () => ({ plan: { ok: true }, boundary: { safe: true }, directory: '/stage',
    manifest: { sequence: 1, identity: targetIdentity, files: [{ role: 'application', ...target }] } })
  let failure
  await assert.rejects(() => controller.activate({ stopBackend: async () => { backendAlive = false },
    backendLive: () => backendAlive, prepareRecovery: publishRecoveryKit }).catch(error => { failure = error; throw error }), /selection durability failed/)
  assert.equal(failure.backendStopped, true)
  assert.equal(journal.state, 'retryable')
  assert.equal(resumed, false)
})

test('bootstrap and notice failures after activation stay on the shutdown path', async () => {
  const handoff = { releaseId: requireHash('target'), recoveryPoint: 'point-1' }
  for (const failureAt of ['bootstrap', 'notice']) {
    let failure
    await assert.rejects(() => completeActivationHandoff({
      activate: async () => handoff,
      startBootstrap: async () => { if (failureAt === 'bootstrap') throw new Error('bootstrap failed') },
      present: async () => { if (failureAt === 'notice') throw new Error('notice failed') },
    }).catch(error => { failure = error; throw error }), new RegExp(`${failureAt} failed`))
    assert.equal(failure.backendStopped, true)
  }
})

test('manual restore handoff resets only before backend stop and always quits afterward', async () => {
  let resets = 0, quits = 0
  await assert.rejects(() => completeManualRestoreHandoff({
    restore: async () => { throw new Error('pre-stop failure') },
    reset: async () => { resets++ }, quit: async () => { quits++ },
  }), /pre-stop failure/)
  assert.deepEqual({ resets, quits }, { resets: 1, quits: 0 })

  const stopped = new Error('post-stop failure'); stopped.backendStopped = true
  await assert.rejects(() => completeManualRestoreHandoff({
    restore: async () => { throw stopped },
    reset: async () => { resets++ }, quit: () => { quits++ },
  }), /post-stop failure/)
  assert.deepEqual({ resets, quits }, { resets: 1, quits: 1 })

  const restored = await completeManualRestoreHandoff({ restore: async () => 'restored',
    reset: async () => { resets++ }, quit: () => { quits++ } })
  assert.equal(restored, 'restored')
  assert.deepEqual({ resets, quits }, { resets: 1, quits: 2 })
})

test('database adapter rejects malformed native confirmation', async () => {
  const guard = new DatabaseGuard({ python: '/python', helper: '/helper', dataDirectory: '/data' })
  guard.command = async () => ({ schema: 1, exists: true, revision: null, size: -1, sidecars: [] })
  await assert.rejects(() => guard.plan(), /Invalid database plan/)
})
