// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureRecoveryAnchor, installRecoveryKit, readRecoveryAnchor, recover, recoveryAnchorInvocationPath, recoveryAnchorRecord, recoveryInvocation, recoveryTransaction, stableFirstInstallerExecutable, trustedSourceFileMetadata, verifiedAppImageRuntime } from '../recovery_launcher.mjs'
import { verifyRecoveryAnchor } from '../bootstrap.mjs'
import { canonicalJson } from '../release.mjs'
import { recoveryDataDirectory, recoveryHandoff, recoveryStateRoot } from '../recovery_cli.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const durableKitReplace = (source, destination) => renameSync(source, destination)
const kitBinding = (recoveryPoint = 'point-1') => ({ schema: 1, recoveryPoint,
  recoveryManifestSha256: '1'.repeat(64), updateMetadataSha256: '2'.repeat(64),
  previousReleaseId: '3'.repeat(64), targetReleaseId: '4'.repeat(64), sequence: 1 })
process.umask(0o077)

test('read-only AppImage mount contents may be root-owned but never writable', () => {
  assert.equal(trustedSourceFileMetadata({ uid: 0, mode: 0o100555 }, { requireOwner: false, currentUid: 1000 }), true)
  assert.equal(trustedSourceFileMetadata({ uid: 0, mode: 0o100575 }, { requireOwner: false, currentUid: 1000 }), false)
  assert.equal(trustedSourceFileMetadata({ uid: 0, mode: 0o100555 }, { requireOwner: true, currentUid: 1000 }), false)
})
const anchorFor = (platform = 'linux', arch = 'x64', recoveryRoot) => {
  const stateRoot = dirname(dirname(dirname(recoveryRoot))), anchorPath = resolve(dirname(dirname(recoveryRoot)), 'anchor.json')
  return { schema: 3, kind: 'recovery-anchor', platform, arch, executablePath: process.execPath, stateRoot, anchorPath,
    digests: { anchorPath: digest(Buffer.from(anchorPath)) } }
}

test('only a verified first installer repairs or rotates the recovery anchor without touching user data', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-anchor-reinstall-'))
  const recovery = resolve(root, 'recovery-tool'), anchorPath = resolve(recovery, 'anchor.json')
  const executablePath = resolve(root, 'Singhouse.exe'), bootstrapPath = resolve(root, 'resources', 'app.asar', 'bootstrap.mjs')
  const pythonPath = resolve(root, 'resources', 'native', 'python', 'python.exe'), helperPath = resolve(root, 'resources', 'native', 'backend.py')
  mkdirSync(recovery); for (const path of [executablePath, bootstrapPath, pythonPath, helperPath]) {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'first installer')
  }
  const expected = { executablePath, bootstrapPath, pythonPath, helperPath, platform: 'win32', arch: 'x64' }
  assert.throws(() => ensureRecoveryAnchor(anchorPath, expected), /verified first installer/)
  const original = ensureRecoveryAnchor(anchorPath, expected, { verifiedFirstInstaller: true })
  assert.throws(() => ensureRecoveryAnchor(`${recovery}/./anchor.json`, expected, { verifiedFirstInstaller: true }), /exact canonical/)
  const stateAlias = resolve(root, 'state-alias'); symlinkSync(root, stateAlias)
  assert.throws(() => ensureRecoveryAnchor(resolve(stateAlias, 'recovery-tool', 'anchor.json'), expected,
    { verifiedFirstInstaller: true }), /canonical state root/)
  assert.deepEqual(readRecoveryAnchor(anchorPath), original)
  const library = resolve(root, 'backend', 'desktop.db'); mkdirSync(dirname(library), { recursive: true }); writeFileSync(library, 'user library')

  writeFileSync(anchorPath, '{corrupt\n')
  assert.throws(() => readRecoveryAnchor(anchorPath), /reinstall singhouse/)
  assert.throws(() => ensureRecoveryAnchor(anchorPath, expected), /verified first installer/)
  assert.deepEqual(ensureRecoveryAnchor(anchorPath, expected, { verifiedFirstInstaller: true }), original)

  writeFileSync(executablePath, 'changed verified first installer')
  const rotated = ensureRecoveryAnchor(anchorPath, expected, { verifiedFirstInstaller: true })
  assert.notEqual(rotated.digests.executablePath, original.digests.executablePath)
  assert.deepEqual(readRecoveryAnchor(anchorPath), rotated)
  assert.equal(readFileSync(library, 'utf8'), 'user library')
})

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-recovery-'))
  const points = resolve(root, 'points', 'point-1')
  const applications = resolve(root, 'applications', 'prior')
  const kitApplication = resolve(root, 'kit-runtime')
  const active = resolve(root, 'active', 'application.json')
  mkdirSync(points, { recursive: true }); mkdirSync(applications, { recursive: true }); mkdirSync(kitApplication); mkdirSync(resolve(root, 'active'))
  const databaseBytes = Buffer.from('standalone verified sqlite fixture')
  const recoveryDatabase = resolve(points, 'database.sqlite3')
  writeFileSync(recoveryDatabase, databaseBytes)
  const application = { schema: 1, releaseId: 'release-prior', platform: process.platform,
    arch: process.arch, payloadSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
    entrypoint: 'Singhouse' }
  const targetApplication = { ...application, releaseId: 'release-target', payloadSha256: 'c'.repeat(64) }
  const previousIdentity = { releaseId: 'release-prior', appVersion: '1.0.0' }
  const targetIdentity = { releaseId: 'release-target', appVersion: '1.1.0' }
  const point = { schema: 1, kind: 'recovery-point', reason: 'update',
    createdAt: '2026-09-14T00:00:00.000Z',
    release: { releaseId: 'release-prior', appVersion: '1.0.0' },
    databaseWriter: { releaseId: 'release-prior', appVersion: '1.0.0' },
    schemaRevision: '1', update: 'release-target', application,
    files: [{ path: 'database.sqlite3', url: pathToFileURL(recoveryDatabase).href, size: databaseBytes.length,
      sha256: digest(databaseBytes), executable: false }] }
  const pointPath = resolve(points, 'point.json')
  writeFileSync(pointPath, `${JSON.stringify(point)}\n`)
  const metadata = Buffer.from(`${JSON.stringify({ schema: 1, signed: {}, signatures: [] })}\n`)
  const metadataPath = resolve(root, 'metadata.json'); writeFileSync(metadataPath, metadata)
  const authenticated = { releaseId: 'release-target', sequence: 1, identity: targetIdentity,
    supersedes: ['release-prior'], requires: {}, files: [] }
  const handoff = { schema: 1, kind: 'update-handoff', state: 'awaiting-target', sequence: 1,
    createdAt: '2026-09-14T00:00:01.000Z', previousIdentity, targetIdentity,
    previousApplication: application, targetApplication, stagedRelease: 'release-target',
    recoveryPoint: 'point-1', recoveryManifestSha256: digest(Buffer.from(canonicalJson(point))),
    updateMetadataSha256: digest(Buffer.from(canonicalJson(authenticated))) }
  const recoveryKitManifest = { schema: 2, kind: 'recovery-kit', binding: { schema: 1,
    recoveryPoint: handoff.recoveryPoint, recoveryManifestSha256: handoff.recoveryManifestSha256,
    updateMetadataSha256: handoff.updateMetadataSha256, previousReleaseId: previousIdentity.releaseId,
    targetReleaseId: targetIdentity.releaseId, sequence: handoff.sequence } }
  handoff.recoveryKit = { id: 'kit-point-1', manifestSha256: digest(Buffer.from(canonicalJson(recoveryKitManifest))) }
  const handoffPath = resolve(root, 'handoff.json'); writeFileSync(handoffPath, JSON.stringify(handoff))
  const installedApplicationPath = resolve(applications, 'manifest.json')
  writeFileSync(installedApplicationPath, 'damaged external manifest')
  const retainedManifest = resolve(kitApplication, 'installed.json')
  writeFileSync(retainedManifest, JSON.stringify(application)); writeFileSync(resolve(kitApplication, 'Singhouse'), 'executable')
  mkdirSync(resolve(kitApplication, 'resources')); writeFileSync(resolve(kitApplication, 'resources/app.asar'), 'asar')
  const applicationInventory = [
    { path: 'Singhouse', type: 'file', size: 10, sha256: digest(Buffer.from('executable')), mode: 0o700 },
    { path: 'installed.json', type: 'file', size: Buffer.byteLength(JSON.stringify(application)), sha256: digest(Buffer.from(JSON.stringify(application))), mode: 0o600 },
    { path: 'resources', type: 'directory', mode: 0o700 },
    { path: 'resources/app.asar', type: 'file', size: 4, sha256: digest(Buffer.from('asar')), mode: 0o600 },
  ]
  writeFileSync(active, JSON.stringify({ ...targetApplication, sequence: 1 }))
  const pythonPath = resolve(root, 'python'); const backendHelperPath = resolve(root, 'backend.py')
  writeFileSync(pythonPath, 'python'); writeFileSync(backendHelperPath, 'helper')
  const dataDirectory = resolve(root, 'data'); const databasePath = resolve(dataDirectory, 'desktop.db'); mkdirSync(dataDirectory); writeFileSync(databasePath, 'new database')
  const run = (_python, args) => {
    if (args[3] !== '--paired-recovery') return { status: 1 }
    const plan = JSON.parse(readFileSync(args[4], 'utf8'))
    for (const record of plan.applicationInventory) {
      const path = resolve(plan.applicationSource, record.path)
      if (!existsSync(path) || (record.type === 'file' && digest(readFileSync(path)) !== record.sha256)) return { status: 1 }
    }
    rmSync(plan.applicationDestination, { recursive: true, force: true }); cpSync(plan.applicationSource, plan.applicationDestination, { recursive: true })
    writeFileSync(resolve(plan.dataDirectory, 'desktop.db'), readFileSync(plan.databaseSource))
    writeFileSync(plan.activePath, JSON.stringify(plan.application)); writeFileSync(plan.transactionPath, JSON.stringify({ ...plan.transaction, state: 'completed' }))
    return { status: 0, stdout: JSON.stringify({ schema: 1, recovered: true, releaseId: plan.application.releaseId, launched: resolve(plan.applicationDestination, plan.application.entrypoint) }) }
  }
  return { root, pointPath, handoffPath, metadataPath, installedApplicationPath, retainedManifest, activeApplicationPath: active,
    applicationSourcePath: kitApplication, applicationDestinationPath: applications, applicationInventory,
    dataDirectory, databasePath, pythonPath, backendHelperPath, verifyMetadata: () => authenticated, run, application,
    recoveryKitManifest }
}

test('standalone recovery validates the signed handoff and durably completes both selections', () => {
  const options = fixture()
  const nativeRun = options.run
  options.run = (python, args, spawnOptions) => {
    assert.equal(spawnOptions.env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(spawnOptions.env.SINGHOUSE_RECOVERY_KIT, undefined)
    return nativeRun(python, args, spawnOptions)
  }
  const oldElectron = process.env.ELECTRON_RUN_AS_NODE, oldRecovery = process.env.SINGHOUSE_RECOVERY_KIT
  process.env.ELECTRON_RUN_AS_NODE = '1'; process.env.SINGHOUSE_RECOVERY_KIT = '1'
  try { assert.deepEqual(recover(options), { releaseId: 'release-prior', completed: true, launched: true }) }
  finally {
    if (oldElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = oldElectron
    if (oldRecovery === undefined) delete process.env.SINGHOUSE_RECOVERY_KIT; else process.env.SINGHOUSE_RECOVERY_KIT = oldRecovery
  }
  assert.deepEqual(JSON.parse(readFileSync(options.activeApplicationPath)), options.application)
  assert.equal(readFileSync(options.databasePath, 'utf8'), 'standalone verified sqlite fixture')
  assert.equal(recoveryTransaction(resolve(options.root, 'recovery-transaction.json')).state, 'completed')
})

test('standalone recovery rejects a live owner through the single native transaction', () => {
  const options = fixture()
  assert.throws(() => recover({ ...options, run: () => ({ status: 1 }) }), /Paired recovery failed/)
  assert.equal(existsSync(resolve(options.root, 'recovery-transaction.json')), false)
  assert.equal(readFileSync(options.databasePath, 'utf8'), 'new database')
})

test('recovery rejects substituted application, metadata and symlinked point paths', () => {
  const changed = fixture()
  writeFileSync(changed.retainedManifest, JSON.stringify({ ...changed.application, entrypoint: 'other' }))
  assert.throws(() => recover(changed), /not bound/)

  const unsigned = fixture()
  assert.throws(() => recover({ ...unsigned, verifyMetadata: () => ({ schema: 1, files: [] }) }), /does not authorize/)

  const swappedKit = fixture()
  swappedKit.recoveryKitManifest = { ...swappedKit.recoveryKitManifest,
    binding: { ...swappedKit.recoveryKitManifest.binding, recoveryPoint: 'point-other' } }
  const swappedHandoff = JSON.parse(readFileSync(swappedKit.handoffPath, 'utf8'))
  swappedHandoff.recoveryKit.manifestSha256 = digest(Buffer.from(canonicalJson(swappedKit.recoveryKitManifest)))
  writeFileSync(swappedKit.handoffPath, JSON.stringify(swappedHandoff))
  assert.throws(() => recover(swappedKit), /not bound to this authenticated handoff/)

  if (process.platform !== 'win32') {
    const linked = fixture(); const link = resolve(linked.root, 'point-link.json')
    symlinkSync(linked.pointPath, link)
    assert.throws(() => recover({ ...linked, pointPath: link }), /non-symlink/)
  }
})

test('recovery never consumes a damaged external prior slot and rejects damaged retained executable or asar', () => {
  const external = fixture()
  writeFileSync(resolve(external.applicationDestinationPath, 'Singhouse'), 'corrupt target executable')
  mkdirSync(resolve(external.applicationDestinationPath, 'resources')); writeFileSync(resolve(external.applicationDestinationPath, 'resources/app.asar'), 'corrupt target asar')
  assert.deepEqual(recover(external), { releaseId: 'release-prior', completed: true, launched: true })
  assert.equal(readFileSync(resolve(external.applicationDestinationPath, 'resources/app.asar'), 'utf8'), 'asar')
  const missingExternal = fixture()
  rmSync(missingExternal.applicationDestinationPath, { recursive: true })
  assert.deepEqual(recover(missingExternal), { releaseId: 'release-prior', completed: true, launched: true })
  assert.equal(readFileSync(resolve(missingExternal.applicationDestinationPath, 'Singhouse'), 'utf8'), 'executable')
  for (const relative of ['Singhouse', 'resources/app.asar']) {
    for (const mutation of ['corrupt', 'missing']) {
      const damaged = fixture(); const path = resolve(damaged.applicationSourcePath, relative)
      if (mutation === 'corrupt') writeFileSync(path, 'corrupt')
      else rmSync(path)
      assert.throws(() => recover(damaged), /Paired recovery failed/)
    }
  }
})

test('recovery kit must live outside the replaceable target', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-kit-'))
  const target = resolve(root, 'target'); mkdirSync(target); writeFileSync(resolve(target, 'runtime'), 'runtime', { mode: 0o755 })
  const source = resolve(root, 'launcher.mjs'); writeFileSync(source, 'launcher')
  const pythonPath = resolve(root, 'python'), backendHelperPath = resolve(root, 'backend.py')
  writeFileSync(pythonPath, 'python'); writeFileSync(backendHelperPath, 'helper')
  const durabilityCalls = []
  const run = (python, args) => {
    durabilityCalls.push({ python, args })
    renameSync(args[4], args[5])
    return { status: 0, stdout: JSON.stringify({ schema: 1, durable: true }) }
  }
  assert.throws(() => installRecoveryKit({ recoveryRoot: resolve(target, 'recovery'), targetRoot: target,
    target: { platform: 'linux', arch: 'x64', entrypoint: 'runtime' },
    anchor: anchorFor('linux', 'x64', resolve(root, 'recovery-tool', 'kits', 'current')),
    binding: kitBinding(), files: { 'launcher.mjs': source }, durableReplace: durableKitReplace }), /outside/)
  const recoveryRoot = resolve(root, 'recovery-tool', 'kits', 'current')
  assert.throws(() => installRecoveryKit({ recoveryRoot, targetRoot: target,
    target: { platform: 'linux', arch: 'x64', entrypoint: 'runtime' }, files: { 'launcher.mjs': source },
    binding: kitBinding(), anchor: { schema: 3, kind: 'recovery-anchor', platform: 'linux', arch: 'x64',
      executablePath: process.execPath }, durableReplace: durableKitReplace }), /exact bound/)
  assert.equal(existsSync(`${recoveryRoot}.new-${process.pid}`), false)
  const manifest = installRecoveryKit({ recoveryRoot, targetRoot: target,
    target: { platform: 'linux', arch: 'x64', entrypoint: 'runtime' }, files: { 'launcher.mjs': source },
    binding: kitBinding(), anchor: anchorFor('linux', 'x64', recoveryRoot), pythonPath, backendHelperPath, run })
  assert.equal(manifest.files.find(file => file.path === 'tools/launcher.mjs').sha256, digest(Buffer.from('launcher')))
  writeFileSync(source, 'launcher two')
  installRecoveryKit({ recoveryRoot, targetRoot: target,
    target: { platform: 'linux', arch: 'x64', entrypoint: 'runtime' }, files: { 'launcher.mjs': source },
    binding: kitBinding(), anchor: anchorFor('linux', 'x64', recoveryRoot), pythonPath, backendHelperPath, run })
  assert.equal(readFileSync(resolve(recoveryRoot, 'tools/launcher.mjs'), 'utf8'), 'launcher two')
  assert.equal(readFileSync(resolve(`${recoveryRoot}.last-good`, 'tools/launcher.mjs'), 'utf8'), 'launcher')
  assert.equal(existsSync(`${recoveryRoot}.new-${process.pid}`), false)
  assert.equal(durabilityCalls.length, 3)
  for (const call of durabilityCalls) {
    assert.equal(call.python, pythonPath)
    assert.deepEqual(call.args.slice(0, 4), ['-I', '-B', backendHelperPath, '--durable-application-replace'])
  }
})

test('recovery kit publication is durable and survives either rotation rename failing', () => {
  for (const failureAt of [1, 2]) {
    const root = mkdtempSync(resolve(tmpdir(), `singhouse-kit-failure-${failureAt}-`))
    const target = resolve(root, 'target'), recoveryRoot = resolve(root, 'recovery-tool', 'kits', 'current')
    mkdirSync(target); writeFileSync(resolve(target, 'runtime'), 'runtime', { mode: 0o755 })
    const source = resolve(root, 'launcher.mjs'); writeFileSync(source, 'old')
    const options = { recoveryRoot, targetRoot: target,
      target: { platform: 'linux', arch: 'x64', entrypoint: 'runtime' }, anchor: anchorFor('linux', 'x64', recoveryRoot), binding: kitBinding(), files: { 'launcher.mjs': source } }
    installRecoveryKit({ ...options, durableReplace: durableKitReplace })
    writeFileSync(source, 'new')
    let calls = 0
    const failingReplace = (from, to) => {
      calls += 1
      if (calls === failureAt) throw new Error(`rename ${failureAt} failed`)
      renameSync(from, to)
    }
    assert.throws(() => installRecoveryKit({ ...options, durableReplace: failingReplace }), new RegExp(`rename ${failureAt} failed`))
    assert.equal(readFileSync(resolve(recoveryRoot, 'tools/launcher.mjs'), 'utf8'), 'old')
    assert.ok(calls >= failureAt)
    const candidates = [recoveryRoot, `${recoveryRoot}.last-good`, `${recoveryRoot}.new-${process.pid}`]
      .filter(path => existsSync(path))
    assert.ok(candidates.length <= 2, 'rotation leaves a bounded current/pending set')
  }
})

test('point-versioned recovery kits preserve the compatible active kit across an aborted later attempt', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-versioned-kits-'))
  const target = resolve(root, 'target'); mkdirSync(target); writeFileSync(resolve(target, 'runtime'), 'runtime', { mode: 0o755 })
  const source = resolve(root, 'launcher.mjs'); writeFileSync(source, 'first')
  const firstRoot = resolve(root, 'recovery-tool', 'kits', 'kit-point-first')
  const first = installRecoveryKit({ recoveryRoot: firstRoot, targetRoot: target,
    target: { platform: 'linux', arch: 'x64', entrypoint: 'runtime' }, files: { 'launcher.mjs': source },
    binding: kitBinding('point-first'), anchor: anchorFor('linux', 'x64', firstRoot), durableReplace: durableKitReplace })
  writeFileSync(source, 'second')
  const secondRoot = resolve(root, 'recovery-tool', 'kits', 'kit-point-second')
  assert.throws(() => installRecoveryKit({ recoveryRoot: secondRoot, targetRoot: target,
    target: { platform: 'linux', arch: 'x64', entrypoint: 'runtime' }, files: { 'launcher.mjs': source },
    binding: kitBinding('point-second'), anchor: anchorFor('linux', 'x64', secondRoot), durableReplace: () => { throw new Error('abort before journal') } }), /abort before journal/)
  assert.equal(readFileSync(resolve(firstRoot, 'tools/launcher.mjs'), 'utf8'), 'first')
  assert.deepEqual(JSON.parse(readFileSync(resolve(firstRoot, 'manifest.json'), 'utf8')).binding, first.binding)
})

test('recovery launch descriptors cover every qualified target family', () => {
  for (const [platform, arch, entrypoint] of [['linux', 'x64', 'runtime/Singhouse'], ['linux', 'arm64', 'runtime/Singhouse'],
    ['win32', 'x64', 'runtime/Singhouse.exe'], ['darwin', 'arm64', 'runtime/Singhouse.app/Contents/MacOS/Singhouse']]) {
    const invocation = recoveryInvocation({ schema: 2, kind: 'recovery-kit', target: { platform, arch }, runtimeEntrypoint: entrypoint }, '/private/recovery', ['state', 'point-1', 'data'])
    assert.equal(invocation.command, resolve('/private/recovery', ...entrypoint.split('/')))
    assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, '1')
    assert.deepEqual(invocation.args.slice(-3), ['state', 'point-1', 'data'])
  }
})

test('standalone launcher resolves the current stable trust anchor instead of freezing its executable path', () => {
  if (process.platform !== 'linux') return
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-kit-invoke-'))
  const target = resolve(root, 'attested-running-app'), recoveryRoot = resolve(root, 'recovery-tool', 'kits', 'kit-point-1')
  mkdirSync(target); const runtime = resolve(target, 'node'); copyFileSync(process.execPath, runtime)
  const tools = resolve(root, 'sources'); mkdirSync(tools)
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../recovery_cli.mjs')
  const fakeRecovery = resolve(tools, 'recovery_launcher.mjs')
  writeFileSync(fakeRecovery, `import { existsSync, readFileSync } from 'node:fs'; import { join } from 'node:path';\nexport function recover(options) { const h=JSON.parse(readFileSync(options.handoffPath)); return { invoked: true, failedTargetAbsent: !existsSync(join(${JSON.stringify(root)}, 'updates','installed','releases',h.targetIdentity.releaseId)) } }\n`)
  const fakeRelease = resolve(tools, 'release.mjs'); writeFileSync(fakeRelease, 'export const validateUpdateMetadata = value => value\n')
  const contract = resolve(tools, 'release.json'); writeFileSync(contract, '{}\n')
  const manifest = installRecoveryKit({ recoveryRoot, targetRoot: target,
    target: { platform: 'linux', arch: process.arch, entrypoint: 'node' },
    binding: kitBinding(), anchor: anchorFor('linux', process.arch, recoveryRoot),
    files: { 'recovery_cli.mjs': cli, 'recovery_launcher.mjs': fakeRecovery, 'release.mjs': fakeRelease, 'release.json': contract },
    durableReplace: durableKitReplace })
  const launcher = readFileSync(resolve(recoveryRoot, 'recover.sh'), 'utf8')
  assert.match(launcher, /recovery-tool\/invoke\.sh/)
  assert.doesNotMatch(launcher, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(launcher, /exec "\$KIT\/runtime/)
  assert.equal(manifest.runtimeEntrypoint, 'runtime/node')

})

test('AppImage anchor selection rejects ambient paths and requires explicit outer-byte and mount evidence', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-appimage-anchor-'))
  const outer = resolve(root, 'Singhouse.AppImage'), anchorPath = resolve(root, 'state', 'recovery-tool', 'anchor.json')
  mkdirSync(resolve(root, 'state'))
  writeFileSync(outer, 'candidate outer AppImage')
  const processMount = resolve(root, '.mount_process')
  const actualExecutable = resolve(processMount, 'Singhouse')
  mkdirSync(processMount); writeFileSync(actualExecutable, 'mounted executable')
  assert.throws(() => stableFirstInstallerExecutable({ platform: 'linux',
    environment: { APPIMAGE: '/attacker', APPDIR: '/' }, executablePath: '/attacker' }), /explicit verified/)
  const evidence = { verified: true, outerPath: outer, outerSha256: digest(readFileSync(outer)), mountPath: processMount,
    actualExecutablePath: actualExecutable }
  assert.equal(stableFirstInstallerExecutable({ platform: 'linux', environment: {},
    executablePath: actualExecutable, verifiedAppImage: evidence }), outer)
  assert.equal(stableFirstInstallerExecutable({ platform: 'linux', environment: { APPIMAGE: '/attacker', APPDIR: '/' },
    executablePath: actualExecutable, verifiedAppImage: evidence }), outer)
  const outsideExecutable = resolve(root, 'outside-Singhouse'); writeFileSync(outsideExecutable, 'outside executable')
  assert.throws(() => stableFirstInstallerExecutable({ platform: 'linux', environment: { APPIMAGE: outer, APPDIR: processMount },
    executablePath: outsideExecutable, verifiedAppImage: { ...evidence, actualExecutablePath: outsideExecutable } }), /explicit verified/)
  writeFileSync(outer, 'repacked unsigned outer AppImage')
  assert.throws(() => stableFirstInstallerExecutable({ platform: 'linux', environment: { APPIMAGE: outer, APPDIR: processMount },
    executablePath: resolve(processMount, 'Singhouse'), verifiedAppImage: evidence }), /bytes changed/)
  writeFileSync(outer, 'candidate outer AppImage')
  const outerAlias = resolve(root, 'outer-alias'); symlinkSync(outer, outerAlias)
  assert.throws(() => stableFirstInstallerExecutable({ platform: 'linux', environment: {}, executablePath: actualExecutable,
    verifiedAppImage: { ...evidence, outerPath: outerAlias } }), /canonical verified/)
  assert.throws(() => stableFirstInstallerExecutable({ platform: 'linux', environment: {}, executablePath: actualExecutable,
    verifiedAppImage: { ...evidence, outerPath: `${root}/./Singhouse.AppImage` } }), /canonical verified/)
  const executableAlias = resolve(processMount, 'Singhouse-alias'); symlinkSync(actualExecutable, executableAlias)
  assert.throws(() => stableFirstInstallerExecutable({ platform: 'linux', environment: {}, executablePath: actualExecutable,
    verifiedAppImage: { ...evidence, actualExecutablePath: executableAlias } }), /canonical verified/)
  const mountAlias = resolve(root, 'mount-alias'); symlinkSync(processMount, mountAlias)
  assert.throws(() => stableFirstInstallerExecutable({ platform: 'linux', environment: {}, executablePath: actualExecutable,
    verifiedAppImage: { ...evidence, mountPath: mountAlias } }), /canonical verified/)
  const firstMount = resolve(root, '.mount_first'), secondMount = resolve(root, '.mount_second')
  const paths = mount => {
    mkdirSync(mount, { recursive: true })
    const actualExecutablePath = resolve(mount, 'Singhouse')
    const bootstrapPath = resolve(mount, 'resources', 'app.asar', 'bootstrap.mjs')
    const pythonPath = resolve(mount, 'resources', 'native', 'python', 'bin', 'python3')
    const helperPath = resolve(mount, 'resources', 'native', 'backend.py')
    for (const [path, bytes] of [[actualExecutablePath, 'mounted executable'], [bootstrapPath, 'bootstrap'], [`${pythonPath}.12`, 'python'], [helperPath, 'helper']]) {
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
    }
    symlinkSync('python3.12', pythonPath)
    return { actualExecutablePath, bootstrapPath, pythonPath, helperPath }
  }
  const first = paths(firstMount), second = paths(secondMount)
  const firstEvidence = { verified: true, outerPath: outer, outerSha256: digest(readFileSync(outer)), mountPath: firstMount,
    actualExecutablePath: first.actualExecutablePath }
  ensureRecoveryAnchor(anchorPath, { executablePath: outer, bootstrapPath: first.bootstrapPath, pythonPath: first.pythonPath,
    helperPath: first.helperPath, platform: 'linux', arch: process.arch }, { verifiedFirstInstaller: true, verifiedAppImage: firstEvidence })
  const record = readRecoveryAnchor(anchorPath)
  assert.equal(record.executablePath, outer)
  assert.equal(JSON.stringify(record).includes('.mount_'), false)
  const secondEvidence = { ...firstEvidence, mountPath: secondMount, actualExecutablePath: second.actualExecutablePath }
  let trusted = false
  const copiedBootstrap = resolve(secondMount, 'resources', 'wrong', 'bootstrap.mjs')
  mkdirSync(dirname(copiedBootstrap), { recursive: true }); writeFileSync(copiedBootstrap, 'bootstrap')
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, { executablePath: outer, bootstrapPath: copiedBootstrap,
    pythonPath: second.pythonPath, helperPath: second.helperPath, verifiedAppImage: secondEvidence,
    platform: 'linux', arch: process.arch, platformTrust: async () => { trusted = true; return true } }), /component layout/)
  assert.equal(trusted, false)
  const bootstrapAlias = resolve(secondMount, 'resources', 'app.asar', 'bootstrap-alias.mjs')
  symlinkSync(second.bootstrapPath, bootstrapAlias)
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, { executablePath: outer, bootstrapPath: bootstrapAlias,
    pythonPath: second.pythonPath, helperPath: second.helperPath, verifiedAppImage: secondEvidence,
    platform: 'linux', arch: process.arch, platformTrust: async () => true }), /component layout/)
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, { executablePath: outer,
    bootstrapPath: `${secondMount}/resources/app.asar/./bootstrap.mjs`, pythonPath: second.pythonPath,
    helperPath: second.helperPath, verifiedAppImage: secondEvidence, platform: 'linux', arch: process.arch,
    platformTrust: async () => true }), /component layout/)
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, { executablePath: outer, bootstrapPath: second.bootstrapPath,
    pythonPath: second.pythonPath, helperPath: second.helperPath, verifiedAppImage: secondEvidence,
    platform: 'linux', arch: process.arch }), /platform signature is invalid/)
  await verifyRecoveryAnchor(anchorPath, { executablePath: outer, bootstrapPath: second.bootstrapPath,
    pythonPath: second.pythonPath, helperPath: second.helperPath, verifiedAppImage: secondEvidence, platform: 'linux', arch: process.arch,
    platformTrust: async () => true })
  writeFileSync(second.helperPath, 'substituted helper')
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, { executablePath: outer, bootstrapPath: second.bootstrapPath,
    pythonPath: second.pythonPath, helperPath: second.helperPath, verifiedAppImage: secondEvidence,
    platform: 'linux', arch: process.arch, platformTrust: async () => true }), /missing or corrupt/)

  const untouchedState = resolve(root, 'untouched-state'), untouchedAnchor = resolve(untouchedState, 'recovery-tool', 'anchor.json')
  mkdirSync(untouchedState)
  assert.throws(() => ensureRecoveryAnchor(untouchedAnchor, { executablePath: outer,
    bootstrapPath: `${firstMount}/resources/app.asar/./bootstrap.mjs`, pythonPath: first.pythonPath,
    helperPath: first.helperPath, platform: 'linux', arch: process.arch },
  { verifiedFirstInstaller: true, verifiedAppImage: firstEvidence }), /exact canonical path/)
  assert.equal(existsSync(resolve(untouchedState, 'recovery-tool')), false)

  const linkedMount = resolve(root, '.mount_linked'), linked = paths(linkedMount)
  const realBootstrap = resolve(root, 'real-bootstrap.mjs')
  writeFileSync(realBootstrap, 'bootstrap'); rmSync(linked.bootstrapPath); symlinkSync(realBootstrap, linked.bootstrapPath)
  const linkedEvidence = { ...firstEvidence, mountPath: linkedMount, actualExecutablePath: linked.actualExecutablePath }
  assert.throws(() => ensureRecoveryAnchor(untouchedAnchor, { executablePath: outer, bootstrapPath: linked.bootstrapPath,
    pythonPath: linked.pythonPath, helperPath: linked.helperPath, platform: 'linux', arch: process.arch },
  { verifiedFirstInstaller: true, verifiedAppImage: linkedEvidence }), /verified AppImage mount/)
  assert.equal(existsSync(resolve(untouchedState, 'recovery-tool')), false)

  const parentMount = resolve(root, '.mount_parent-link'), parent = paths(parentMount)
  const realAsar = resolve(root, 'real-asar'); mkdirSync(realAsar); writeFileSync(resolve(realAsar, 'bootstrap.mjs'), 'bootstrap')
  rmSync(resolve(parentMount, 'resources', 'app.asar'), { recursive: true }); symlinkSync(realAsar, resolve(parentMount, 'resources', 'app.asar'))
  const parentEvidence = { ...firstEvidence, mountPath: parentMount, actualExecutablePath: parent.actualExecutablePath }
  assert.throws(() => ensureRecoveryAnchor(untouchedAnchor, { executablePath: outer, bootstrapPath: parent.bootstrapPath,
    pythonPath: parent.pythonPath, helperPath: parent.helperPath, platform: 'linux', arch: process.arch },
  { verifiedFirstInstaller: true, verifiedAppImage: parentEvidence }), /verified AppImage mount/)
  assert.equal(existsSync(resolve(untouchedState, 'recovery-tool')), false)
})

test('AppImage runtime evidence comes from Linux ancestry and a read-only FUSE mount', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-appimage-proc-'))
  const mount = resolve(root, '.mount_Singho'), executable = resolve(mount, 'Singhouse')
  const outer = resolve(root, 'Downloaded Singhouse.AppImage'), intermediate = resolve(root, 'AppRun')
  const proc = resolve(root, 'proc')
  mkdirSync(mount); writeFileSync(executable, 'mounted electron')
  const header = Buffer.alloc(32); header.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 0)
  header.set(Buffer.from([0x41, 0x49, 0x02]), 8); writeFileSync(outer, Buffer.concat([header, Buffer.from('outer payload')]))
  writeFileSync(intermediate, 'intermediate')
  for (const directory of ['self', '41', '17']) mkdirSync(resolve(proc, directory), { recursive: true })
  symlinkSync(executable, resolve(proc, 'self', 'exe'))
  symlinkSync(intermediate, resolve(proc, '41', 'exe'))
  symlinkSync(outer, resolve(proc, '17', 'exe'))
  writeFileSync(resolve(proc, 'self', 'stat'), '99 (Singhouse Helper) S 41 0 0 0\n')
  writeFileSync(resolve(proc, '41', 'stat'), '41 (AppRun shell) S 17 0 0 0\n')
  writeFileSync(resolve(proc, '17', 'stat'), '17 (Downloaded Singhouse.AppImage) S 1 0 0 0\n')
  const encodedMount = mount.replaceAll(' ', '\\040')
  writeFileSync(resolve(proc, 'self', 'mountinfo'), `25 20 0:42 / ${encodedMount} ro,nosuid,nodev - fuse.Singhouse Singhouse.AppImage ro,user_id=1000\n`)

  const evidence = verifiedAppImageRuntime({ platform: 'linux', executablePath: executable, procRoot: proc })
  assert.deepEqual(evidence, { verified: true, outerPath: outer, outerSha256: digest(readFileSync(outer)),
    mountPath: mount, actualExecutablePath: executable })
  assert.equal(verifiedAppImageRuntime({ platform: 'darwin', executablePath: executable, procRoot: proc }), null)

  writeFileSync(resolve(proc, 'self', 'mountinfo'), `25 20 0:42 / ${encodedMount} rw,nosuid,nodev - fuse.Singhouse Singhouse.AppImage rw,user_id=1000\n`)
  assert.throws(() => verifiedAppImageRuntime({ platform: 'linux', executablePath: executable, procRoot: proc }), /read-only FUSE root/)
  writeFileSync(resolve(proc, 'self', 'mountinfo'), `25 20 0:42 / ${encodedMount} ro,nosuid,nodev - ext4 /dev/test ro\n`)
  assert.throws(() => verifiedAppImageRuntime({ platform: 'linux', executablePath: executable, procRoot: proc }), /read-only FUSE root/)
})

test('AppImage runtime evidence rejects ambient candidates and non-AppImage ancestors', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-appimage-negative-'))
  const mount = resolve(root, '.mount_Singho'), executable = resolve(mount, 'Singhouse')
  const candidate = resolve(root, 'Singhouse.AppImage'), proc = resolve(root, 'proc')
  mkdirSync(mount); writeFileSync(executable, 'mounted electron'); writeFileSync(candidate, 'ordinary executable')
  for (const directory of ['self', '7']) mkdirSync(resolve(proc, directory), { recursive: true })
  symlinkSync(executable, resolve(proc, 'self', 'exe')); symlinkSync(candidate, resolve(proc, '7', 'exe'))
  writeFileSync(resolve(proc, 'self', 'stat'), '8 (Singhouse) S 7 0 0 0\n')
  writeFileSync(resolve(proc, '7', 'stat'), '7 (attacker) S 0 0 0 0\n')
  writeFileSync(resolve(proc, 'self', 'mountinfo'), `25 20 0:42 / ${mount} ro - fuse.Singhouse Singhouse.AppImage ro\n`)
  assert.throws(() => verifiedAppImageRuntime({ platform: 'linux', executablePath: executable, procRoot: proc }), /no authenticated outer-image ancestor/)
})

test('verified installer relocation rotates one invoker without invalidating existing recovery kits', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'singhouse-anchor-relocation-'))
  const root = resolve(temporary, 'percent% amp& parens() bang! caret^')
  mkdirSync(root)
  const recoveryTool = resolve(root, 'state', 'recovery-tool'), anchorPath = resolve(recoveryTool, 'anchor.json')
  mkdirSync(resolve(root, 'state'))
  const first = resolve(root, 'Program One'), second = resolve(root, 'Program Two')
  const components = application => {
    const executablePath = resolve(application, 'Singhouse.exe'), bootstrapPath = resolve(application, 'resources', 'app.asar', 'bootstrap.mjs')
    const pythonPath = resolve(application, 'resources', 'native', 'python', 'python.exe'), helperPath = resolve(application, 'resources', 'native', 'backend.py')
    for (const [path, bytes] of [[executablePath, `exe ${application}`], [bootstrapPath, 'bootstrap'], [pythonPath, 'python'], [helperPath, 'helper']]) {
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
    }
    return { executablePath, bootstrapPath, pythonPath, helperPath, platform: 'win32', arch: 'x64' }
  }
  const firstAnchor = ensureRecoveryAnchor(anchorPath, components(first), { verifiedFirstInstaller: true })
  const target = resolve(root, 'prior'); mkdirSync(target); writeFileSync(resolve(target, 'Singhouse.exe'), 'prior runtime')
  const kit = resolve(recoveryTool, 'kits', 'kit-point-1')
  installRecoveryKit({ recoveryRoot: kit, targetRoot: target, files: {}, target: { platform: 'win32', arch: 'x64', entrypoint: 'Singhouse.exe' },
    binding: kitBinding(), anchor: firstAnchor, durableReplace: durableKitReplace })
  const oldLauncher = readFileSync(resolve(kit, 'recover.cmd'), 'utf8')
  assert.doesNotMatch(oldLauncher, /Program One/)
  assert.match(oldLauncher, /for %%I in \("%~dp0\."\) do set "KIT=%%~fI"/)
  assert.match(oldLauncher, /setlocal DisableDelayedExpansion/)
  assert.match(oldLauncher, /"%KIT%" %\*/)
  assert.doesNotMatch(oldLauncher, /"%~dp0"/)
  const escapedInvocation = recoveryAnchorInvocationPath(anchorPath, 'win32').replaceAll('%', '%%')
  assert.match(oldLauncher, new RegExp(`if not exist ${JSON.stringify(escapedInvocation).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.doesNotMatch(oldLauncher, /percent% amp/)
  if (process.platform === 'win32') {
    const captured = resolve(root, 'captured-kit.txt'), invocationPath = recoveryAnchorInvocationPath(anchorPath, 'win32')
    writeFileSync(invocationPath, `@echo off\r\n<nul set /p "=%~1" > "${captured}"\r\n`)
    const result = spawnSync('cmd.exe', ['/d', '/v:on', '/s', '/c', resolve(kit, 'recover.cmd')], { windowsHide: true })
    assert.equal(result.status, 0, result.stderr?.toString())
    assert.equal(readFileSync(captured, 'utf8'), resolve(kit))
  }
  const rotated = ensureRecoveryAnchor(anchorPath, components(second), { verifiedFirstInstaller: true })
  assert.equal(rotated.executablePath, resolve(second, 'Singhouse.exe'))
  assert.equal(readFileSync(resolve(kit, 'recover.cmd'), 'utf8'), oldLauncher)
  const invocation = readFileSync(recoveryAnchorInvocationPath(anchorPath, 'win32'), 'utf8')
  assert.match(invocation, /Program Two/)
  assert.match(invocation, /setlocal DisableDelayedExpansion/)
  assert.doesNotMatch(invocation, /Program One/)
  assert.match(invocation, /percent%% amp& parens\(\) bang! caret\^/)
  assert.doesNotMatch(invocation, /percent% amp/)
})

test('recovery CLI derives the database directory from the exact selected state root', () => {
  const state = mkdtempSync(resolve(tmpdir(), 'singhouse-cli-data-'))
  mkdirSync(resolve(state, 'backend'))
  assert.equal(recoveryDataDirectory(state, resolve(state, 'backend')), resolve(state, 'backend'))
  assert.throws(() => recoveryDataDirectory(`${state}/.`, resolve(state, 'backend')), /exactly match/)
  assert.throws(() => recoveryDataDirectory(state, `${resolve(state, 'backend')}/.`), /exactly match/)
  assert.throws(() => recoveryDataDirectory(state, resolve('/private', 'other-backend')),
    /Recovery database path must exactly match the selected state root/)
})

test('recovery CLI binds a same-basename kit to its canonical containing state root', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'singhouse-cli-root-binding-'))
  const trustedState = resolve(root, 'trusted'), copiedState = resolve(root, 'copied')
  const trustedKit = resolve(trustedState, 'recovery-tool', 'kits', 'kit-point-1')
  const copiedKit = resolve(copiedState, 'recovery-tool', 'kits', 'kit-point-1')
  mkdirSync(trustedKit, { recursive: true }); mkdirSync(copiedKit, { recursive: true })
  assert.equal(recoveryStateRoot(trustedKit, trustedState), trustedState)
  assert.throws(() => recoveryStateRoot(`${trustedKit}/.`, trustedState), /selected state root/)
  assert.throws(() => recoveryStateRoot(copiedKit, trustedState), /selected state root/)
  assert.throws(() => recoveryStateRoot(resolve(trustedState, 'elsewhere', 'kit-point-1'), trustedState), /ENOENT|selected state root/)
  const kitAlias = resolve(trustedState, 'recovery-tool', 'kits', 'kit-alias')
  symlinkSync(trustedKit, kitAlias)
  assert.throws(() => recoveryStateRoot(kitAlias, trustedState), /selected state root/)
  const realKit = resolve(trustedState, 'recovery-tool', 'kits', 'real-kit')
  renameSync(trustedKit, realKit); symlinkSync(realKit, trustedKit)
  assert.throws(() => recoveryStateRoot(trustedKit, trustedState), /selected state root/)
})

test('recovery CLI rejects a symlinked handoff before loading it', () => {
  const stateRoot = mkdtempSync(resolve(tmpdir(), 'singhouse-cli-handoff-'))
  const updatesRoot = resolve(stateRoot, 'updates'), handoffPath = resolve(updatesRoot, 'handoff.json')
  mkdirSync(updatesRoot); writeFileSync(resolve(updatesRoot, 'real-handoff.json'), '{}\n')
  symlinkSync(resolve(updatesRoot, 'real-handoff.json'), handoffPath)
  assert.throws(() => recoveryHandoff(stateRoot), /exact regular file/)
  const realUpdates = resolve(stateRoot, 'real-updates'); renameSync(updatesRoot, realUpdates); symlinkSync(realUpdates, updatesRoot)
  assert.throws(() => recoveryHandoff(stateRoot), /exact regular file/)
})
