// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, rename, symlink, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'
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
  assert.equal(attested.pythonPath, toNamespacedPath(join(installed.directory, manifest.python)))
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

test('expanding a model cache reuses verified installed weights without another upstream request', async t => {
  const { root } = await fixture(t)
  const records = ['old', 'new'].map(name => ({ path: `huggingface/hub/${name}.bin`, size: name.length,
    sha256: sha(name), revision: 'a'.repeat(40), executable: false,
    url: `https://huggingface.co/model/resolve/${'a'.repeat(40)}/${name}.bin` }))
  const policy = { schema: 1, allowedHosts: ['huggingface.co'], models: records.map((record, i) => ({ id: ['old', 'new'][i], files: [record] })) }
  const requests = []
  const cache = new ModelCache(join(root, 'reuse-models'), policy, { fetchImpl: async url => {
    requests.push(String(url))
    return new Response(String(url).endsWith('/old.bin') ? 'old' : 'new')
  } })
  const original = await cache.install({ schema: 1, kind: 'models', models: ['old'], files: [records[0]] })
  const combined = await cache.install({ schema: 1, kind: 'models', models: ['old', 'new'], files: records })
  assert.equal(requests.length, 2)
  assert.equal(requests.filter(url => url.endsWith('/old.bin')).length, 1)
  assert.deepEqual((await cache.active()).manifest.models, ['old', 'new'])
  assert.equal(await readFile(join(original.directory, records[0].path), 'utf8'), 'old')
  assert.notEqual((await stat(join(original.directory, records[0].path))).ino, (await stat(join(combined.directory, records[0].path))).ino)
})


test('verification bounds hashing and drains in-flight checks before rejecting corruption', async t => {
  const { manifest, manager } = await fixture(t)
  for (let i = 0; i < 10; i++) manifest.files.push({ ...manifest.files[1], path: `lib/dependencies/file-${i}` })
  bindProvenance(manifest)
  const installed = await manager.install(manifest)
  // Same-size corruption must reach the hash check, regardless of worker order.
  for (const record of manifest.files) await writeFile(join(installed.directory, record.path), 'x'.repeat(record.size))
  const handle = await open(join(installed.directory, manifest.python), 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const nativeStream = prototype.createReadStream
  let started = 0, finished = 0, settled = false, firstFinished
  const drainedFirst = new Promise(resolve => { firstFinished = resolve })
  let firstWave
  const ready = new Promise(resolve => { firstWave = resolve })
  const releases = []
  t.mock.method(prototype, 'createReadStream', function (options) {
    const stream = nativeStream.call(this, options)
    const index = started++
    const gate = new Promise(resolve => releases.push(resolve))
    if (started === 4) firstWave()
    return (async function* () {
      try { await gate; yield* stream }
      finally { finished++; if (index === 0) firstFinished() }
    })()
  })
  const verification = manager.verify(installed.id)
  const rejection = assert.rejects(verification, /verification failed/)
  verification.then(() => { settled = true }, () => { settled = true })
  // A deadline makes a regression to serial checks fail instead of hanging.
  await Promise.race([ready, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Four hash workers did not start')), 5000)
    timer.unref()
    ready.then(() => clearTimeout(timer))
  })])
  try {
    assert.equal(started, 4)
    releases[0]()
    await drainedFirst
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'A failed worker must wait for the other checks')
    assert.equal(started, 4, 'A failed worker must not queue more files')
  } finally { for (const release of releases) release() }
  await rejection
  assert.equal(finished, started)
  assert.equal(started, 4)
})

test('verification rejects an opened file replaced before its path identity check', async t => {
  const { manifest, manager } = await fixture(t)
  const installed = await manager.install(manifest)
  const path = join(installed.directory, manifest.python)
  const original = await stat(path)
  const handle = await open(path, 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const nativeStat = prototype.stat
  let swapped = false
  t.mock.method(prototype, 'stat', async function (...args) {
    const info = await nativeStat.apply(this, args)
    if (!swapped && info.ino === original.ino && info.dev === original.dev) {
      swapped = true
      await rename(path, path + '.moved')
      await writeFile(path, 'fixture python')
    }
    return info
  })
  await assert.rejects(manager.verify(installed.id), /changed while opening/)
  assert.equal(swapped, true)
})

test('verification preserves long nested paths, detects subsequent corruption and unexpected files', async t => {
  const { manifest, manager } = await fixture(t)
  const deep = Array.from({ length: 10 }, (_, i) => `dependency-layer-${i}`).join('/') + '/NOTICE.long-path'
  manifest.files.push({ ...manifest.files[1], path: deep })
  bindProvenance(manifest)
  const installed = await manager.install(manifest)
  const path = join(installed.directory, deep)
  assert.ok(path.length > 260)
  assert.equal((await manager.verify(installed.id)).id, installed.id)
  await writeFile(path, 'bad notice')
  await assert.rejects(manager.verify(installed.id), /verification failed/)
  await writeFile(path, 'MIT notice')
  await writeFile(join(installed.directory, 'unexpected'), 'extra')
  await assert.rejects(manager.verify(installed.id), /inventory/)
})

// ---- Archive delivery (concat-gzip-v1) ----------------------------------

// An independent writer of the documented format: fixed gzip header, raw
// deflate of every file's bytes in manifest order, CRC32 and length trailer.
function gzipConcat(data, { flags = 0 } = {}) {
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(data) >>> 0, 0)
  trailer.writeUInt32LE(data.length % 2 ** 32, 4)
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 0xff]), deflateRawSync(data), trailer])
}
const splitBytes = (bytes, size) => Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size))

// Deterministic incompressible bytes so a tiny part size yields several parts.
const noise = length => {
  const out = Buffer.alloc(length)
  for (let i = 0, block = Buffer.alloc(0); i < length; i += 32) {
    block = createHash('sha256').update(String(i)).digest()
    block.copy(out, i)
  }
  return out
}
const archiveEntries = () => [
  { path: 'lib/zero-start', data: Buffer.alloc(0), executable: false },
  { path: 'python/bin/python3', data: Buffer.from('fixture python'), executable: true },
  { path: 'NOTICE.fixture', data: Buffer.from('MIT notice'), executable: false },
  { path: 'lib/a/b/c/duplicate-one.txt', data: Buffer.from('same bytes twice'), executable: false },
  { path: 'lib/x/duplicate-two.txt', data: Buffer.from('same bytes twice'), executable: false },
  { path: 'lib/bin/tool', data: Buffer.from('#!/bin/sh\nexit 0\n'), executable: true },
  { path: 'lib/data/noise.bin', data: noise(3000), executable: false },
  { path: 'lib/zero-end', data: Buffer.alloc(0), executable: false },
]

// Builds a lock-bound archive manifest. `compressed` lets a test publish bytes
// that differ from the honest archive while the manifest stays self-consistent.
function archiveManifest(entries = archiveEntries(), { partSize = 400, compressed, inventory } = {}) {
  const bytes = compressed ?? gzipConcat(Buffer.concat(entries.map(entry => entry.data)))
  const parts = splitBytes(bytes, partSize)
  const urls = parts.map((_, i) => `https://example.org/releases/runtime.pack.gz.${String(i + 1).padStart(3, '0')}`)
  const manifest = bindProvenance({ schema: 1, kind: 'processing', ...identity, pythonVersion: '3.12.14', accelerator: 'cpu', python: 'python/bin/python3',
    probe: { schema: 1, type: 'python-imports-v1', modules: ['audio_separator.separator', 'demucs.separate', 'faster_whisper', 'karaoke_backend.workers.heart_transcriptor', 'lyricsync.transcription.heart'] },
    capabilities: ['transcription', 'separation'], models: ['whisper'], modelCapabilities: { whisper: 'transcription' },
    files: (inventory ?? entries).map(({ path, data, executable }) => ({ path, size: data.length, sha256: sha(data), executable })) })
  manifest.archive = { format: 'concat-gzip-v1', parts: parts.map((part, i) => ({ url: urls[i], sha256: sha(part), size: part.length })) }
  return { manifest, parts, urls, entries }
}

// A release-asset style host: honours Range and records every request.
function assetServer(urls, parts, { intercept } = {}) {
  const requests = []
  const fetchImpl = async (url, options) => {
    url = String(url)
    requests.push({ url, options })
    const override = await intercept?.(url, options, requests.length)
    if (override) return override
    const bytes = parts[urls.indexOf(url)]
    if (!bytes) return new Response('missing', { status: 404 })
    const start = Number(/^bytes=(\d+)-$/.exec(options.headers?.Range || '')?.[1] ?? 0)
    if (!options.headers?.Range) return new Response(bytes)
    return new Response(bytes.subarray(start), { status: 206, headers: { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } })
  }
  return { fetchImpl, requests }
}

function archiveManager(root, fetchImpl, options = {}) {
  const manager = new RuntimeManager(join(root, 'processing'), identity, { fetchImpl, ...options })
  manager.probe = async () => {}
  return manager
}

async function assertInstalled(manager, installed, entries) {
  for (const entry of entries) {
    const path = join(installed.directory, entry.path)
    assert.deepEqual(await readFile(path), entry.data)
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, entry.executable ? 0o700 : 0o600)
  }
  assert.equal((await manager.verify(installed.id)).id, installed.id)
  assert.equal((await manager.active()).id, installed.id)
  // Parts are retired once the pack is staged; nothing but the pack remains.
  assert.deepEqual(await readdir(join(manager.root, 'staging')), [])
}

test('archive manifests: exactly one delivery form, strict part records, lock binding intact', async () => {
  const { manifest } = archiveManifest()
  assert.ok(validateProcessingManifest(structuredClone(manifest), identity, testTrustedLocks))
  const invalid = [
    m => { m.files[0].url = 'https://example.org/file' },
    m => { for (const file of m.files) file.url = 'https://example.org/file' },
    m => { m.archive = null },
    m => { m.archive = [] },
    m => { m.archive.format = 'concat-gzip-v2' },
    m => { m.archive.extra = true },
    m => { m.archive.parts = [] },
    m => { m.archive.parts = Array.from({ length: 65 }, (_, i) => ({ ...m.archive.parts[0], url: `https://example.org/p${i}` })) },
    m => { m.archive.parts[0].sha256 = 'A'.repeat(64) },
    m => { m.archive.parts[0].size = 0 },
    m => { m.archive.parts[0].size = 2 ** 31 },
    m => { m.archive.parts[0].size = 1.5 },
    m => { m.archive.parts[0].size = '400' },
    m => { m.archive.parts[0].name = 'part' },
    m => { delete m.archive.parts[0].url },
    m => { m.archive.parts[0].url = 'http://example.org/part' },
    m => { m.archive.parts[0].url = 'https://user:secret@example.org/part' },
    m => { m.archive.parts[0].url = 'https://example.org/part#fragment' },
    m => { m.archive.parts[0].url = 'file://server/share/part' },
    m => { m.archive.parts[0].url = 'not a url' },
    m => { m.archive.parts[1].url = m.archive.parts[0].url },
    m => { m.archive.parts[1].url = m.archive.parts[0].url.replace('https://example.org', 'HTTPS://EXAMPLE.ORG') },
  ]
  for (const mutate of invalid) {
    const changed = structuredClone(manifest); mutate(changed)
    assert.throws(() => validateProcessingManifest(changed, identity, testTrustedLocks), undefined, mutate.toString())
  }
  // The inventory stays lock-bound in archive form; the hosting description does not.
  const detached = structuredClone(manifest); detached.files[1].sha256 = sha('other')
  assert.throws(() => validateProcessingManifest(detached, identity, testTrustedLocks), /input lock/)
  const rehosted = structuredClone(manifest); rehosted.archive.parts[0].url = 'file:///srv/runtime.pack.gz.001'
  assert.ok(validateProcessingManifest(rehosted, identity, testTrustedLocks))
  // Model manifests never take the archive form.
  const revision = 'a'.repeat(40)
  const model = { schema: 1, kind: 'models', models: ['whisper'], files: [{ path: 'huggingface/hub/model.bin',
    url: `https://huggingface.co/upstream/model/resolve/${revision}/model.bin`, revision, sha256: sha('model'), size: 5, executable: false }] }
  const policy = { schema: 1, allowedHosts: ['huggingface.co'], models: [{ id: 'whisper', files: structuredClone(model.files) }] }
  assert.ok(validateModelManifest(model, policy))
  assert.throws(() => validateModelManifest({ ...model, archive: manifest.archive }, policy), /Invalid upstream model manifest/)
})

test('archive install retrieves parts, extracts by manifest layout and reports both phases', async t => {
  const { root } = await fixture(t)
  const { manifest, parts, urls, entries } = archiveManifest()
  assert.ok(parts.length >= 4, 'fixture should span several parts')
  const { fetchImpl, requests } = assetServer(urls, parts)
  const events = []
  const manager = archiveManager(root, fetchImpl, { progress: event => events.push(event) })
  const installed = await manager.install(manifest)
  await assertInstalled(manager, installed, entries)
  assert.deepEqual(requests.map(request => request.url), urls)
  for (const { options } of requests) {
    assert.equal(options.redirect, 'manual')
    assert.equal(options.credentials, 'omit')
  }
  // Existing consumers read { file, received, total }; `phase` tells the stages apart.
  for (const event of events) {
    assert.equal(typeof event.file, 'string')
    assert.ok(Number.isSafeInteger(event.received) && Number.isSafeInteger(event.total) && event.received <= event.total)
    assert.ok(['retrieve', 'extract'].includes(event.phase))
  }
  assert.ok(events.some(event => event.phase === 'retrieve'))
  const last = events.at(-1)
  assert.equal(last.phase, 'extract')
  assert.equal(last.received, entries.reduce((sum, entry) => sum + entry.data.length, 0))
  assert.equal(last.received, last.total)
  // Reinstalling the same selection still converges on the same verified pack.
  assert.equal((await manager.install(manifest)).id, installed.id)
  assert.equal((await manager.active()).id, installed.id)
})

test('archive retrieval resumes an interrupted part with Range from the manifest URL', async t => {
  const { root } = await fixture(t)
  const { manifest, parts, urls, entries } = archiveManifest()
  const controller = new AbortController()
  let interrupted = false
  const { fetchImpl, requests } = assetServer(urls, parts, { intercept: async (url, options) => {
    // The manifest URL redirects to a signed, expiring asset location.
    if (url.startsWith('https://example.org/')) {
      return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/asset/${urls.indexOf(url)}?sig=${requests.length}` } })
    }
    const index = Number(/asset\/(\d+)/.exec(url)[1])
    const bytes = parts[index]
    if (index === 1 && !interrupted) {
      interrupted = true
      return { status: 200, body: (async function* () {
        yield bytes.subarray(0, 100)
        controller.abort()
        throw new Error('connection reset')
      })() }
    }
    const start = Number(/^bytes=(\d+)-$/.exec(options.headers?.Range || '')?.[1] ?? 0)
    return options.headers?.Range
      ? new Response(bytes.subarray(start), { status: 206, headers: { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } })
      : new Response(bytes)
  } })
  const manager = archiveManager(root, fetchImpl)
  await assert.rejects(manager.install(manifest, { signal: controller.signal }))
  assert.equal(await manager.active(), null)
  const before = requests.length
  const installed = await manager.install(manifest)
  await assertInstalled(manager, installed, entries)
  const retried = requests.slice(before)
  // Part 1 was complete and is not requested again; part 2 resumes at byte 100,
  // re-resolving through the original manifest URL rather than a stale signed one.
  assert.equal(retried[0].url, urls[1])
  assert.deepEqual(retried[0].options.headers, { Range: 'bytes=100-' })
  assert.match(retried[1].url, /^https:\/\/release-assets\.githubusercontent\.com\/asset\/1\?sig=/)
  assert.deepEqual(retried[1].options.headers, { Range: 'bytes=100-' })
  assert.ok(!retried.some(request => request.url === urls[0]))
})

test('archive extraction resumes after interruption without re-retrieving or rewriting verified files', async t => {
  const { root } = await fixture(t)
  const { manifest, parts, urls, entries } = archiveManifest()
  const { fetchImpl, requests } = assetServer(urls, parts)
  let extracting = false, syncs = 0
  const manager = archiveManager(root, fetchImpl, { progress: event => {
    if (event.phase === 'retrieve' && event.part === parts.length && event.received === event.total) extracting = true
  } })
  const handle = await open(join(root, 'python'), 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const nativeSync = prototype.sync
  // Calls after the final part completes: that part's own sync, then one per
  // extracted file. Fail while finishing the fourth extracted file.
  const mock = t.mock.method(prototype, 'sync', function (...args) {
    if (extracting && ++syncs === 5) throw new Error('simulated power loss')
    return nativeSync.apply(this, args)
  })
  await assert.rejects(manager.install(manifest), /simulated power loss/)
  mock.mock.restore()
  const id = sha(JSON.stringify(manifest))
  const staged = join(manager.root, 'staging', id)
  assert.deepEqual(await readFile(join(staged, 'python/bin/python3')), entries[1].data)
  const earlier = (await stat(join(staged, 'python/bin/python3'))).ino
  assert.equal((await readdir(join(manager.root, 'staging', `${id}.archive`))).length, parts.length)
  const fetched = requests.length
  const installed = await manager.install(manifest)
  await assertInstalled(manager, installed, entries)
  assert.equal(requests.length, fetched, 'retained, verified parts are not retrieved again')
  assert.equal((await stat(join(installed.directory, 'python/bin/python3'))).ino, earlier, 'verified files are not rewritten')
})

test('a staged archive tree activates offline only after its stream was validated', async t => {
  const { root } = await fixture(t)
  const { manifest, parts, urls, entries } = archiveManifest()
  const id = sha(JSON.stringify(manifest))
  // Files placed in staging without a validated stream (an older or forged
  // tree) are never activated on their own; the parts must be decoded again.
  const offline = archiveManager(root, async () => { throw new Error('offline') })
  const staged = join(offline.root, 'staging', id)
  for (const entry of entries) {
    await mkdir(join(staged, entry.path, '..'), { recursive: true })
    await writeFile(join(staged, entry.path), entry.data)
  }
  await assert.rejects(offline.install(manifest), /offline/)
  assert.equal(await offline.active(), null)
  // Crash after the stream validated and the parts were removed: the retained
  // tree and its marker finish activation without any network access.
  let crashed = false
  const crashing = archiveManager(root, assetServer(urls, parts).fetchImpl, { directorySync: async path => {
    if (!crashed && path === staged) {
      await assert.rejects(stat(join(crashing.root, 'staging', `${id}.archive`)), { code: 'ENOENT' })
      crashed = true
      throw new Error('simulated power loss')
    }
  } })
  await assert.rejects(crashing.install(manifest), /simulated power loss/)
  assert.ok(crashed)
  assert.deepEqual((await readdir(join(crashing.root, 'staging'))).sort(), [id, `${id}.stream`])
  const installed = await offline.install(manifest)
  await assertInstalled(offline, installed, entries)
})

test('corrupt, truncated, padded, multi-member or mislabelled archives fail closed and keep the active runtime', async t => {
  const { root, manifest: legacy } = await fixture(t)
  const previous = await archiveManager(root, undefined).install(legacy)
  const entries = archiveEntries()
  const data = Buffer.concat(entries.map(entry => entry.data))
  const honest = gzipConcat(data)
  const flipped = Buffer.from(honest); flipped[flipped.length - 8] ^= 0xff
  const tampered = entries.map(entry => entry.path === 'NOTICE.fixture' ? { ...entry, data: Buffer.from('MIT n0tice') } : entry)
  const cases = [
    // Served bytes disagree with the manifest's part digest.
    ['corrupt part', archiveManifest(entries), { servedCorrupt: true }, /checksum/],
    ['truncated stream', archiveManifest(entries, { compressed: honest.subarray(0, honest.length - 20) }), {}, /truncated|end of file|ended before/],
    ['missing trailer', archiveManifest(entries, { compressed: honest.subarray(0, honest.length - 3) }), {}, /truncated|corrupt/],
    ['trailing garbage', archiveManifest(entries, { compressed: Buffer.concat([honest, Buffer.from('garbage')]) }), {}, /trailing/],
    ['large trailing data', archiveManifest(entries, { compressed: Buffer.concat([honest, noise(5000)]), partSize: 1000 }), {}, /trailing/],
    ['extra empty gzip member', archiveManifest(entries, { compressed: Buffer.concat([honest, gzipSync(Buffer.alloc(0))]) }), {}, /trailing/],
    ['extra gzip member', archiveManifest(entries, { compressed: Buffer.concat([honest, gzipSync(Buffer.from('extra'))]) }), {}, /trailing/],
    ['extra uncompressed bytes', archiveManifest(entries, { compressed: gzipConcat(Buffer.concat([data, Buffer.from('x')])) }), {}, /trailing/],
    ['short uncompressed stream', archiveManifest(entries, { compressed: gzipConcat(data.subarray(0, data.length - 1)) }), {}, /ended before|checksum/],
    ['optional header fields', archiveManifest(entries, { compressed: gzipConcat(data, { flags: 8 }) }), {}, /format/],
    ['bad trailer checksum', archiveManifest(entries, { compressed: flipped }), {}, /corrupt/],
    // A correctly hashed archive whose content disagrees with one locked file.
    ['wrong file inside archive', archiveManifest(tampered, { inventory: entries }), {}, /checksum/],
  ]
  for (const [name, { manifest, parts, urls }, { servedCorrupt }, expected] of cases) {
    const served = servedCorrupt ? parts.map((part, i) => i === 1 ? Buffer.from(part).fill(0, 0, 4) : part) : parts
    const manager = archiveManager(root, assetServer(urls, served).fetchImpl)
    await assert.rejects(manager.install(manifest), expected, name)
    assert.equal((await manager.active()).id, previous.id, name)
    assert.deepEqual(await readdir(join(manager.root, 'packs')), [previous.id], name)
  }
})

test('runtime source redirects follow only approved HTTPS release-asset endpoints', async t => {
  const { root } = await fixture(t)
  const origin = new URL('https://example.org/releases/runtime.pack.gz.001')
  const manager = archiveManager(root, undefined)
  // A host that answers directly keeps working, with the same request options.
  manager.fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit')
    return new Response('direct')
  }
  assert.equal(await (await manager.fetchSource(origin, {})).text(), 'direct')
  // Signed query strings are accepted on approved redirect targets.
  const seen = []
  manager.fetch = async url => {
    seen.push(String(url))
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: 'https://github.com/owner/repo/releases/asset/1' } })
    if (seen.length === 2) return new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/asset?X-Signature=abc&expires=1' } })
    if (seen.length === 3) return new Response(null, { status: 307, headers: { location: 'https://release-assets.githubusercontent.com/asset?sig=def' } })
    return new Response('asset bytes')
  }
  assert.equal(await (await manager.fetchSource(origin, {})).text(), 'asset bytes')
  assert.equal(seen.at(-1), 'https://release-assets.githubusercontent.com/asset?sig=def')
  for (const location of ['http://objects.githubusercontent.com/asset', 'https://user:secret@objects.githubusercontent.com/asset',
    'https://objects.githubusercontent.com:8443/asset', 'https://objects.githubusercontent.com/asset#fragment',
    'https://evil.example/asset', 'https://objects.githubusercontent.com.evil.example/asset', 'https://raw.githubusercontent.com/asset',
    'https://huggingface.co/asset', 'https://127.0.0.1/asset', 'file:///tmp/asset']) {
    let requests = 0
    manager.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location } }) }
    await assert.rejects(manager.fetchSource(origin, {}), /not approved/, location)
    assert.equal(requests, 1, location)
  }
  let requests = 0
  manager.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://github.com/loop' } }) }
  await assert.rejects(manager.fetchSource(origin, {}), /limit/)
  assert.equal(requests, 6)
  manager.fetch = async () => new Response(null, { status: 302 })
  await assert.rejects(manager.fetchSource(origin, {}), /missing/)
  await assert.rejects(manager.fetchSource(new URL('http://example.org/part'), {}), /HTTPS/)
})

test('a malformed archive stream is rejected on every attempt while its parts are the source', async t => {
  const { root } = await fixture(t)
  const entries = archiveEntries()
  const data = Buffer.concat(entries.map(entry => entry.data))
  const honest = gzipConcat(data)
  const flipped = Buffer.from(honest); flipped[flipped.length - 8] ^= 0xff
  const cases = [
    ['extra gzip member', Buffer.concat([honest, gzipSync(Buffer.from('extra'))]), /trailing/],
    ['trailing garbage', Buffer.concat([honest, Buffer.from('garbage')]), /trailing/],
    ['extra uncompressed byte', gzipConcat(Buffer.concat([data, Buffer.from('x')])), /trailing/],
    ['flipped trailer CRC', flipped, /corrupt/],
  ]
  for (const [name, compressed, expected] of cases) {
    const store = join(root, name.replaceAll(' ', '-'))
    const bad = archiveManifest(entries, { compressed })
    const id = sha(JSON.stringify(bad.manifest))
    for (const attempt of [1, 2]) {
      const { fetchImpl, requests } = assetServer(bad.urls, bad.parts)
      const manager = archiveManager(store, fetchImpl)
      await assert.rejects(manager.install(bad.manifest), expected, `${name}, attempt ${attempt}`)
      assert.equal(await manager.active(), null, `${name}, attempt ${attempt}`)
      // The parts and everything extracted from them are discarded, so the
      // next attempt retrieves and decodes them again and fails again.
      assert.deepEqual(await readdir(join(manager.root, 'staging')), [], `${name}, attempt ${attempt}`)
      assert.deepEqual(requests.map(request => request.url), bad.urls, `${name}, attempt ${attempt}`)
      assert.ok(!(await readdir(join(manager.root, 'packs'))).includes(id))
    }
    // Once a correct archive is published (new part digests, so a new
    // manifest), the third attempt installs it.
    const good = archiveManifest(entries)
    const manager = archiveManager(store, assetServer(good.urls, good.parts).fetchImpl)
    await assertInstalled(manager, await manager.install(good.manifest), entries)
  }
})

// Writes `bytes` split at `cuts` as the retrieved parts and decodes them.
// Writes `bytes` split at `cuts` as the retrieved parts and decodes them.
// With `streamOnly`, files count as already staged, so only the stream is checked.
async function decodeLayout(root, entries, bytes, cuts, { streamOnly = false } = {}) {
  const parts = []
  let previous = 0
  for (const cut of [...cuts, bytes.length]) { if (cut > previous) parts.push(bytes.subarray(previous, cut)); previous = cut }
  const manifest = { files: entries.map(({ path, data, executable }) => ({ path, size: data.length, sha256: sha(data), executable })),
    archive: { format: 'concat-gzip-v1', parts: parts.map((part, i) => ({ url: `https://example.org/p.${i + 1}`, sha256: sha(part), size: part.length })) } }
  // Only the listed parts are read; a stream-only check leaves staging untouched.
  const staging = join(root, 'layout-staging'), archive = join(root, 'layout-archive')
  if (!streamOnly) await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true }); await mkdir(archive, { recursive: true })
  for (const [i, part] of parts.entries()) await writeFile(join(archive, `part-${String(i + 1).padStart(3, '0')}.partial`), part)
  try {
    await layoutManager(root).decodeArchive(manifest, staging, archive, manifest.files.map(() => streamOnly), new AbortController().signal)
    if (!streamOnly) for (const entry of entries) assert.deepEqual(await readFile(join(staging, entry.path)), entry.data)
    return 'ok'
  } catch (error) { return error.message }
}
const layoutManagers = new Map()
const layoutManager = root => {
  if (!layoutManagers.has(root)) layoutManagers.set(root, archiveManager(root, undefined))
  return layoutManagers.get(root)
}

test('trailer detection is independent of how parts and reads split the stream', async t => {
  const { root } = await fixture(t)
  const entries = archiveEntries()
  const honest = gzipConcat(Buffer.concat(entries.map(entry => entry.data)))
  const L = honest.length
  // The layouts the review reproduced, including eight 1-byte trailer parts.
  const layouts = [[L - 8, L - 5], [L - 8, L - 6, L - 3, L - 1], [L - 10, L - 8, L - 4],
    [L - 9, L - 7, L - 6, L - 5, L - 4, L - 3, L - 2, L - 1], [L - 12, L - 4],
    [L - 8, L - 7, L - 6, L - 5, L - 4, L - 3, L - 2, L - 1]]
  for (let n = 1; n <= 8; n++) layouts.push([L - 8, ...Array.from({ length: n - 1 }, (_, i) => L - 8 + i + 1)])
  for (const cuts of layouts) assert.equal(await decodeLayout(root, entries, honest, cuts), 'ok', String(cuts.map(cut => cut - L)))
  const padded = Buffer.concat([honest, Buffer.from('x')])
  for (const cuts of layouts) assert.match(await decodeLayout(root, entries, padded, cuts.map(cut => cut + 1)), /trailing/, String(cuts.map(cut => cut - L)))
})

test('exhaustive small-layout sweep accepts every split of a valid archive and rejects padded ones', async t => {
  const { root } = await fixture(t)
  const entries = [
    { path: 'python/bin/python3', data: Buffer.from('fixture python'), executable: true },
    { path: 'NOTICE.fixture', data: Buffer.from('MIT notice'), executable: false },
    { path: 'lib/zero', data: Buffer.alloc(0), executable: false },
  ]
  const honest = gzipConcat(Buffer.concat(entries.map(entry => entry.data)))
  const L = honest.length
  const variants = [
    ['honest', honest, /^ok$/],
    ['one trailing byte', Buffer.concat([honest, Buffer.from([0])]), /trailing/],
    ['empty second member', Buffer.concat([honest, gzipSync(Buffer.alloc(0))]), /trailing/],
    ['missing last byte', honest.subarray(0, L - 1), /truncated|corrupt|ended before/],
  ]
  for (const [name, bytes, expected] of variants) {
    const N = bytes.length, layouts = [[]]
    // Every single split point, every subset of split points among the last
    // nine boundaries (the trailer and where the deflate data ends), and for
    // the valid archive every pair of split points.
    for (let a = 1; a < N; a++) {
      layouts.push([a])
      if (name === 'honest') for (let b = a + 1; b < N; b++) layouts.push([a, b])
    }
    for (let mask = 1; mask < 2 ** 9; mask++) layouts.push(Array.from({ length: 9 }, (_, i) => N - 9 + i).filter((_, i) => mask & (1 << i)))
    for (const cuts of layouts) assert.match(await decodeLayout(root, entries, bytes, cuts, { streamOnly: true }), expected, `${name}: ${cuts}`)
  }
})
