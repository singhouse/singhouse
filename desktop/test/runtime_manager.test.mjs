// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { RuntimeManager as NativeRuntimeManager, ModelCache as NativeModelCache, acquireInstallLock, validateProcessingManifest, validateModelManifest, processingAttestation } from '../runtime_manager.mjs'

// Production passes its absolute bundled interpreter; fixtures use the test OS.
const lockPython = process.platform === 'win32' ? 'python.exe' : 'python3'
const durabilityHelper = fileURLToPath(new URL('../backend.py', import.meta.url))
const testTrustedLocks = new Set()
class RuntimeManager extends NativeRuntimeManager {
  constructor(root, identity, options) { super(root, identity, { lockPython, durabilityHelper, nativeBin: join(root, '..', 'native-fixture'), trustedLocks: testTrustedLocks, ...options }) }
}
class ModelCache extends NativeModelCache {
  constructor(root, policy, options) { super(root, policy, { lockPython, durabilityHelper, ...options }) }
}

const sha = value => createHash('sha256').update(value).digest('hex')
const identity = { appVersion: '0.1.0', backendVersion: '0.1.0', lyricsyncVersion: '0.1.0', platform: 'linux', arch: 'x64' }

function bindProvenance(manifest) {
  const inputLock = { schema: 1, kind: 'processing-input', ...Object.fromEntries(
    ['appVersion', 'backendVersion', 'lyricsyncVersion', 'pythonVersion', 'platform', 'arch', 'accelerator', 'python', 'capabilities', 'models', 'modelCapabilities']
      .map(key => [key, structuredClone(manifest[key])])), sourceCommit: 'a'.repeat(40),
  packages: [{ name: 'fixture', version: '1', license: 'MIT', sourceUrl: 'https://example.org/fixture.whl', sha256: 'c'.repeat(64), notices: ['NOTICE.fixture'] }],
  files: manifest.files.map(({ url, ...record }) => structuredClone(record)) }
  if (manifest.probe.schema === 2) inputLock.probe = structuredClone(manifest.probe)
  manifest.provenance = { sourceCommit: inputLock.sourceCommit, lockSha256: sha(JSON.stringify(inputLock)),
    inputLock: JSON.stringify(inputLock), packages: structuredClone(inputLock.packages), qualification: 'UNTESTED' }
  testTrustedLocks.add(manifest.provenance.lockSha256)
  return manifest
}

test('runtime manager copy stays neutral because installation dialogs surface its error messages', async () => {
  const source = await readFile(new URL('../runtime_manager.mjs', import.meta.url), 'utf8')
  // This literal is an approved technical endpoint, not installation copy.
  assert.doesNotMatch(source.replaceAll("'download.pytorch.org'", "'upstream-host'"), /\bdownload\w*/i)
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'processing-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // These files are inert: fake-interpreter protocol tests never execute them.
  await mkdir(join(root, 'native-fixture'))
  for (const name of ['ffmpeg', 'ffprobe']) {
    await writeFile(join(root, 'native-fixture', name + (process.platform === 'win32' ? '.exe' : '')), 'fixture native tool')
  }
  const source = join(root, 'python')
  await writeFile(source, 'fixture python')
  const notice = join(root, 'NOTICE.fixture')
  await writeFile(notice, 'MIT notice')
  const manifest = bindProvenance({ schema: 1, kind: 'processing', ...identity, pythonVersion: '3.12.14', accelerator: 'cpu', python: 'python/bin/python3',
    probe: { schema: 1, type: 'python-imports-v1', modules: ['audio_separator.separator', 'demucs.separate', 'faster_whisper', 'karaoke_backend.workers.heart_transcriptor', 'lyricsync.transcription.heart'] },
    capabilities: ['transcription', 'separation'], models: ['whisper'], modelCapabilities: { whisper: 'transcription' },
    files: [{ path: 'python/bin/python3', url: pathToFileURL(source).href, size: 14, sha256: sha('fixture python'), executable: true },
      { path: 'NOTICE.fixture', url: pathToFileURL(notice).href, size: 10, sha256: sha('MIT notice'), executable: false }] })
  const manager = new RuntimeManager(join(root, 'processing'), identity)
  // Byte-transfer fixtures use inert executable bytes; process/protocol behavior
  // is tested separately with an actual child below.
  manager.probe = async () => {}
  return { root, source, manifest, manager }
}

test('installs, verifies and persists selection across restart; retains prior runtime', async t => {
  const { root, source, manifest, manager } = await fixture(t)
  const first = await manager.install(manifest)
  assert.equal((await manager.active()).id, first.id)
  await writeFile(source, 'second python!')
  const updated = structuredClone(manifest)
  updated.files[0].sha256 = sha('second python!')
  bindProvenance(updated)
  const second = await manager.install(updated)
  assert.notEqual(first.id, second.id)
  assert.deepEqual((await readdir(join(root, 'processing/packs'))).sort(), [first.id, second.id].sort())
  assert.equal((await new RuntimeManager(join(root, 'processing'), identity).active()).id, second.id)
  await writeFile(join(second.directory, second.manifest.python), 'tampered')
  assert.equal((await manager.active()).id, first.id)
})

test('bad checksum and low disk leave the previous active pack unchanged', async t => {
  const { root, manifest, manager } = await fixture(t)
  const installed = await manager.install(manifest)
  const corrupt = structuredClone(manifest)
  corrupt.files[0].sha256 = '0'.repeat(64)
  bindProvenance(corrupt)
  await assert.rejects(manager.install(corrupt), /checksum/)
  assert.equal((await manager.active()).id, installed.id)
  const full = new RuntimeManager(join(root, 'processing'), identity, { diskFree: async () => 1 })
  await assert.rejects(full.install(manifest), /disk space/)
  assert.equal((await manager.active()).id, installed.id)
})

test('rejects incompatible packs, traversal, remote file shares and duplicate paths', async t => {
  const { manifest } = await fixture(t)
  for (const mutate of [m => m.arch = 'arm64', m => m.files[0].path = '../escape', m => m.files[0].url = 'http://example.org/python',
    m => m.files[0].url = 'file://server/share/python', m => m.files.push(m.files[0]), m => m.files[0].path = 'manifest.json']) {
    const changed = structuredClone(manifest); mutate(changed)
    assert.throws(() => validateProcessingManifest(changed, identity, [...testTrustedLocks]))
  }
})

test('rejects missing, malformed, or detached executable provenance and incomplete probes', async t => {
  const { manifest } = await fixture(t)
  const mutations = [
    m => { delete m.provenance.inputLock },
    m => { m.provenance.inputLock = '{' },
    m => { m.provenance.lockSha256 = '0'.repeat(64) },
    m => { m.provenance.packages[0].notices = [] },
    m => { m.probe.modules = ['faster_whisper'] },
    m => { m.modelCapabilities = {} },
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(manifest)
    mutate(changed)
    assert.throws(() => validateProcessingManifest(changed, identity, [...testTrustedLocks]))
  }
})

test('main-to-backend attestation helper emits one exact fail-closed schema', async t => {
  const { manifest } = await fixture(t)
  const active = { id: 'd'.repeat(64), directory: '/runtime/pack', manifest }
  const components = Object.fromEntries(manifest.probe.modules.map(module => [module, '1.0']))
  const attestation = processingAttestation(active, { schema: 1, accelerator: 'cpu', components,
    verifiedCapabilities: [], capabilitiesReady: false })
  assert.deepEqual(Object.keys(attestation).sort(), ['accelerator', 'capabilitiesReady', 'components', 'probePassed', 'pythonPath', 'pythonSha256', 'runtimeManifestId', 'verifiedCapabilities'].sort())
  assert.equal(attestation.capabilitiesReady, false)
  assert.throws(() => processingAttestation(active, { schema: 1, accelerator: 'cuda', components }))
})

test('exclusive lock blocks concurrent installation and cancellation keeps partial bytes for retry', async t => {
  const { root, manifest } = await fixture(t)
  const remote = structuredClone(manifest)
  remote.files[0].url = 'https://example.org/python'
  const controller = new AbortController()
  let calls = 0
  const fetchImpl = async (_url, options) => {
    calls++
    if (calls === 1) return { status: 200, body: (async function* () {
      yield Buffer.from('fixture ')
      controller.abort()
      throw new Error('interrupted')
    })() }
    assert.deepEqual(options.headers, { Range: 'bytes=8-' })
    return { status: 206, headers: new Headers({ 'content-range': 'bytes 8-13/14' }), body: (async function* () { yield Buffer.from('python') })() }
  }
  const manager = new RuntimeManager(join(root, 'processing'), identity, { fetchImpl })
  manager.probe = async () => {}
  await mkdir(manager.root)
  const liveLock = await acquireInstallLock(join(manager.root, 'install.lock'), lockPython)
  await assert.rejects(manager.install(remote), /lock/)
  await liveLock.release()
  await assert.rejects(manager.install(remote, { signal: controller.signal }))
  assert.equal(await manager.active(), null)
  await manager.install(remote)
  assert.equal(calls, 2)
})

test('kernel locks recover crashed owners without unlinking the inode or discarding partials', async t => {
  const { root, manifest, manager } = await fixture(t)
  await mkdir(manager.root)
  const partial = join(manager.root, 'retained.partial')
  await writeFile(partial, 'resume-me')
  const path = join(manager.root, 'install.lock')
  const previous = await acquireInstallLock(path, lockPython)
  const inode = (await stat(path)).ino
  const metadata = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(metadata.parentPid, process.pid)
  assert.match(metadata.startedAtNs, /^[0-9]+$/)
  if (process.platform === 'linux') {
    assert.match(metadata.startTicks, /^[0-9]+$/)
    assert.ok(metadata.bootId)
  }
  const lost = new Promise(resolveLost => previous.signal.addEventListener('abort', resolveLost, { once: true }))
  process.kill(metadata.pid, 'SIGKILL')
  await lost
  await assert.rejects(previous.release(), /unexpectedly/)
  const racing = await Promise.allSettled([
    acquireInstallLock(path, lockPython), acquireInstallLock(path, lockPython),
  ])
  assert.equal(racing.filter(result => result.status === 'fulfilled').length, 1)
  await racing.find(result => result.status === 'fulfilled').value.release()
  await manager.install(manifest)
  assert.equal((await stat(path)).ino, inode)
  assert.equal(await readFile(partial, 'utf8'), 'resume-me')
  assert.notEqual(JSON.parse(await readFile(path, 'utf8')).nonce, metadata.nonce)
  assert.ok(await manager.active())
})

test('server ignoring Range restarts transfer without duplicating bytes', async t => {
  const { root, manifest } = await fixture(t)
  manifest.files[0].url = 'https://example.org/python'
  const partial = join(root, 'partial')
  await writeFile(partial, 'fixture ')
  const manager = new RuntimeManager(join(root, 'processing'), identity, { fetchImpl: async () => new Response('fixture python') })
  await manager.transfer(manifest.files[0], partial)
  assert.equal(await readFile(partial, 'utf8'), 'fixture python')
})

test('model cache accepts immutable upstream inputs only and verifies offline after restart', async t => {
  const { root } = await fixture(t)
  const revision = 'a'.repeat(40)
  const manifest = { schema: 1, kind: 'models', models: ['whisper'], files: [{ path: 'huggingface/hub/model.bin',
    url: `https://huggingface.co/upstream/model/resolve/${revision}/model.bin`, revision,
    sha256: sha('model'), size: 5, executable: false }] }
  const policy = { schema: 1, allowedHosts: ['huggingface.co'], models: [{ id: 'whisper', files: structuredClone(manifest.files) }] }
  const cache = new ModelCache(join(root, 'models'), policy, { fetchImpl: async () => new Response('model') })
  await cache.install(manifest)
  assert.deepEqual((await new ModelCache(join(root, 'models'), policy).active()).manifest.models, ['whisper'])
  for (const mutate of [m => m.files[0].url = 'https://mirror.example/model', m => m.files[0].revision = 'main',
    m => m.files[0].executable = true, m => m.files[0].path = '../model', m => m.models.push('whisper'),
    m => m.files[0].sha256 = sha('other'), m => m.files[0].size = 1, m => m.models = ['arbitrary']]) {
    const bad = structuredClone(manifest); mutate(bad)
    assert.throws(() => validateModelManifest(bad, policy))
  }
  assert.throws(() => validateModelManifest(manifest, { ...policy, models: [] }), /not defined/)
  const extra = structuredClone(manifest)
  extra.files.push({ ...manifest.files[0], path: 'huggingface/extra' })
  assert.throws(() => validateModelManifest(extra, policy), /inventory/)
})

test('native helper durably commits when Node directory sync is unavailable, retaining the prior slot on interruption', async t => {
  const { root, manifest, source } = await fixture(t)
  let stopAt
  const manager = new RuntimeManager(join(root, 'processing'), identity, {
    directorySync: async () => false,
    activationHook: async stage => { if (stage === stopAt) throw new Error('simulated crash') },
  })
  manager.probe = async () => {}
  const first = await manager.install(manifest)
  await writeFile(source, 'second python!')
  const second = structuredClone(manifest)
  second.files[0].sha256 = sha('second python!')
  bindProvenance(second)
  for (const stage of ['pack-durable', 'pointer-open']) {
    stopAt = stage
    await assert.rejects(manager.install(second), /simulated crash/)
    assert.equal((await new RuntimeManager(manager.root, identity).active()).id, first.id)
  }
  stopAt = undefined
  const installed = await manager.install(second)
  assert.equal((await manager.active()).id, installed.id)
  // A power-loss-like torn newest slot must retain the previous pointer.
  const newest = (await manager.readPointers())[0]
  await writeFile(join(manager.root, `active.${newest.slot}.json`), '{"schema":2')
  assert.equal((await new RuntimeManager(manager.root, identity).active()).id, first.id)
  stopAt = 'pointer-durable'
  await assert.rejects(manager.install(second), /simulated crash/)
  assert.equal((await new RuntimeManager(manager.root, identity).active()).id, installed.id)
})

test('loss of unsynced new pack and pointer entries cannot discard the previous activation', async t => {
  const { root, manifest, source, manager } = await fixture(t)
  const first = await manager.install(manifest)
  await writeFile(source, 'second python!')
  const second = structuredClone(manifest)
  second.files[0].sha256 = sha('second python!')
  bindProvenance(second)
  const nativeReplace = manager.durableReplace.bind(manager)
  for (const failAt of ['pack', 'pointer']) {
    let unsyncedEntry
    manager.durableReplace = async (from, to) => {
      const pointer = to.endsWith('.json')
      if (pointer === (failAt === 'pointer')) {
        await rename(from, to)
        unsyncedEntry = to
        throw new Error('metadata flush failed after rename')
      }
      return nativeReplace(from, to)
    }
    await assert.rejects(manager.install(second), /metadata flush failed/)
    assert.ok(unsyncedEntry)
    // Simulate power loss dropping the entry whose metadata never reached disk.
    await rm(unsyncedEntry, { recursive: failAt === 'pack', force: true })
    assert.equal((await new RuntimeManager(manager.root, identity).active()).id, first.id)
  }
  manager.durableReplace = nativeReplace
  const committed = await manager.install(second)
  assert.equal((await new RuntimeManager(manager.root, identity).active()).id, committed.id)
})

test('no-follow descriptors reject partial symlinks and path swaps without writing the target', { skip: process.platform === 'win32' }, async t => {
  const { root, manifest } = await fixture(t)
  const partial = join(root, 'download.partial'), victim = join(root, 'victim')
  await writeFile(victim, 'private contents')
  await symlink(victim, partial)
  const manager = new RuntimeManager(join(root, 'processing'), identity)
  await assert.rejects(manager.transfer(manifest.files[0], partial))
  assert.equal(await readFile(victim, 'utf8'), 'private contents')
  await rm(partial)
  manifest.files[0].url = 'https://example.org/python'
  manager.fetch = async () => {
    await rename(partial, join(root, 'owned-descriptor'))
    await symlink(victim, partial)
    return new Response('fixture python')
  }
  await assert.rejects(manager.transfer(manifest.files[0], partial), /path changed/)
  assert.equal(await readFile(victim, 'utf8'), 'private contents')
  assert.equal(await readFile(join(root, 'owned-descriptor'), 'utf8'), 'fixture python')
})

test('fixed self-test runs before activation and on offline restart; failure and timeout retain active pointer', { skip: process.platform === 'win32' }, async t => {
  const originalTimeout = globalThis.setTimeout, deadlines = []
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    deadlines.push(milliseconds)
    return originalTimeout(callback, milliseconds, ...args)
  })
  const { root, source, manifest } = await fixture(t)
  const manager = new RuntimeManager(join(root, 'processing'), identity)
  const inheritedUsername = process.env.USERNAME
  process.env.USERNAME = 'host-identity-must-not-reach-probe'
  t.after(() => {
    if (inheritedUsername === undefined) delete process.env.USERNAME
    else process.env.USERNAME = inheritedUsername
  })
  const protocol = { schema: 1, pythonVersion: manifest.pythonVersion, backendVersion: manifest.backendVersion,
    lyricsyncVersion: manifest.lyricsyncVersion, accelerator: manifest.accelerator,
    capabilities: manifest.capabilities, hardwareAvailable: true,
    components: Object.fromEntries(manifest.probe.modules.map(module => [module, '1.0'])) }
  const expectedInductorCache = join(manager.root, 'probe-cache', 'torchinductor')
  const script = `#!/bin/sh\n[ "$TORCHINDUCTOR_CACHE_DIR" = '${expectedInductorCache}' ] || exit 71\n[ -z "\${USERNAME+x}" ] || exit 72\nprintf '%s\\n' '${JSON.stringify(protocol)}'\n`
  await writeFile(source, script)
  manifest.files[0].size = Buffer.byteLength(script)
  manifest.files[0].sha256 = sha(script)
  bindProvenance(manifest)
  const installed = await manager.install(manifest)
  const restarted = new RuntimeManager(join(root, 'processing'), identity, { fetchImpl: () => { throw new Error('offline') } })
  assert.equal((await restarted.probe(await restarted.active())).schema, 1)
  assert.ok(deadlines.includes(30000), 'Import-only probes retain their 30-second default')
  for (const badScript of ['#!/bin/sh\nprintf invalid\n', '#!/bin/sh\nexec sleep 5\n']) {
    await writeFile(source, badScript)
    const bad = structuredClone(manifest)
    bad.files[0].size = Buffer.byteLength(badScript)
    bad.files[0].sha256 = sha(badScript)
    bindProvenance(bad)
    await assert.rejects(manager.install(bad, { probeTimeout: 50 }))
    assert.equal((await manager.active()).id, installed.id)
  }
})


test('functional protocol enables only declared capabilities and rejects missing evidence and detached probe locks', { skip: process.platform === 'win32' }, async t => {
  const originalTimeout = globalThis.setTimeout, deadlines = []
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    deadlines.push(milliseconds)
    return originalTimeout(callback, milliseconds, ...args)
  })
  const { root, source, manifest } = await fixture(t)
  manifest.probe = { ...manifest.probe, schema: 2, type: 'python-functional-v1' }
  const inheritedFallback = process.env.PYTORCH_ENABLE_MPS_FALLBACK
  process.env.PYTORCH_ENABLE_MPS_FALLBACK = '1'
  t.after(() => {
    if (inheritedFallback === undefined) delete process.env.PYTORCH_ENABLE_MPS_FALLBACK
    else process.env.PYTORCH_ENABLE_MPS_FALLBACK = inheritedFallback
  })
  const protocol = { schema: 2, pythonVersion: manifest.pythonVersion, backendVersion: manifest.backendVersion,
    lyricsyncVersion: manifest.lyricsyncVersion, accelerator: manifest.accelerator,
    capabilities: manifest.capabilities, hardwareAvailable: true,
    components: Object.fromEntries(manifest.probe.modules.map(module => [module, '1.0'])),
    checks: { deviceTensor: true, nativeAudio: true, transcription: true, separation: true } }
  const scriptFor = value => `#!/bin/sh\n[ "$PYTORCH_ENABLE_MPS_FALLBACK" = 0 ] || exit 71\nprintf '%s\\n' '${JSON.stringify(value)}'\n`
  const replaceProtocol = async value => {
    const script = scriptFor(value)
    await writeFile(source, script)
    manifest.files[0].size = Buffer.byteLength(script)
    manifest.files[0].sha256 = sha(script)
    bindProvenance(manifest)
  }
  await replaceProtocol(protocol)
  const manager = new RuntimeManager(join(root, 'processing'), identity)
  const installed = await manager.install(manifest)
  const result = await manager.probe(installed)
  assert.ok(deadlines.includes(120000), 'Functional probes allow cold native imports within a two-minute bound')
  assert.equal(result.capabilitiesReady, true)
  assert.deepEqual(result.verifiedCapabilities, manifest.capabilities)
  const attested = processingAttestation(installed, result)
  assert.equal(attested.probeSchema, 2)
  assert.deepEqual(attested.checks, protocol.checks)
  for (const patch of [{ checks: { ...protocol.checks, transcription: false } },
    { checks: { deviceTensor: true, nativeAudio: true } },
    { checks: { ...protocol.checks, extra: true } }, { hardwareAvailable: false }, { schema: 1 }]) {
    assert.throws(() => processingAttestation(installed, { ...result, ...patch }))
    await replaceProtocol({ ...protocol, ...patch })
    await assert.rejects(manager.install(manifest))
    assert.equal((await manager.active()).id, installed.id)
  }
  const detached = structuredClone(installed.manifest)
  // A trusted import-only lock cannot grant functional readiness merely by
  // changing its manifest probe declaration.
  const oldLock = JSON.parse(detached.provenance.inputLock)
  delete oldLock.probe
  detached.provenance.inputLock = JSON.stringify(oldLock)
  detached.provenance.lockSha256 = sha(detached.provenance.inputLock)
  testTrustedLocks.add(detached.provenance.lockSha256)
  assert.throws(() => validateProcessingManifest(detached, identity, testTrustedLocks), /bound/)
  const slowScript = '#!/bin/sh\nexec /bin/sleep 5\n'
  await writeFile(source, slowScript)
  const slow = structuredClone(installed.manifest)
  slow.files[0].size = Buffer.byteLength(slowScript)
  slow.files[0].sha256 = sha(slowScript)
  bindProvenance(slow)
  await assert.rejects(manager.install(slow, { probeTimeout: 50 }), /timed out/)
  assert.ok(deadlines.includes(50), 'Explicit shorter functional deadlines remain honored')
  assert.equal((await manager.active()).id, installed.id)
})


test('real dependency names with internal spaces and parentheses survive install and verification', async t => {
  const { manifest, manager } = await fixture(t)
  const paths = ['setuptools/script (dev).tmpl', 'setuptools/launcher manifest.xml',
    'setuptools/_vendor/jaraco/text/Lorem ipsum.txt', 'scipy/io/tests/data/Transparent Busy.ani']
  for (const path of paths) manifest.files.push({ ...manifest.files[1], path })
  bindProvenance(manifest)
  const installed = await manager.install(manifest)
  for (const path of paths) assert.equal(await readFile(join(installed.directory, path), 'utf8'), 'MIT notice')
  assert.equal((await manager.verify(installed.id)).id, installed.id)
  for (const path of ['../escape', './file', 'dir/../escape', 'dir/ file', 'dir/file ', 'dir/file.',
    'dir/CON', 'dir/nul.txt', 'dir/LPT1.txt', 'dir/file;command', 'dir/file$(command)', 'dir/file\\name']) {
    const invalid = structuredClone(manifest)
    invalid.files.push({ ...manifest.files[1], path })
    bindProvenance(invalid)
    assert.throws(() => validateProcessingManifest(invalid, identity, testTrustedLocks))
  }
})


test('processing path collisions follow the target filesystem', async t => {
  const { manifest, manager } = await fixture(t)
  for (const path of ['terminfo/2621A', 'terminfo/2621a']) manifest.files.push({ ...manifest.files[1], path })
  bindProvenance(manifest)
  const installed = await manager.install(manifest)
  assert.equal((await manager.verify(installed.id)).id, installed.id)
  for (const platform of ['win32', 'darwin']) {
    const changed = structuredClone(manifest)
    changed.platform = platform
    bindProvenance(changed)
    assert.throws(() => validateProcessingManifest(changed, { ...identity, platform }, testTrustedLocks), /file record/)
  }
})
