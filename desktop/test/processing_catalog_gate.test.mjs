// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSetupCatalog, SETUP_MODEL_IDS } from '../setup_catalog.mjs'
import { assertPackagingMode } from '../build/package.mjs'
import { assertPackagedProcessingCatalog, assertProcessingCatalog, packagedCatalogIdentity, processingModeFromArgs, readProcessingCatalogInputs } from '../build/processing_catalog_gate.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const nativeManifest = { schema: 1, appVersion: '1', backendVersion: '1', lyricsyncVersion: '1', pythonVersion: '3.12.0', platform: 'linux', arch: 'x64', runtimeId: 'f'.repeat(64) }

// Test-only fixture: qualification here is synthetic and never leaves this file.
function fixture({ platform = 'linux', arch = 'x64' } = {}) {
  const target = { appVersion: '1', backendVersion: '1', lyricsyncVersion: '1', platform, arch }
  const runtime = { schema: 1, kind: 'processing', ...target, accelerator: 'cpu', python: 'python', pythonVersion: '3.12',
    capabilities: ['transcription', 'separation'], models: [...SETUP_MODEL_IDS],
    modelCapabilities: Object.fromEntries(SETUP_MODEL_IDS.map(id => [id, id === 'heart-transcriptor' ? 'transcription' : 'separation'])),
    probe: { schema: 2, type: 'python-functional-v1', modules: ['audio_separator.separator', 'demucs.separate', 'faster_whisper', 'karaoke_backend.workers.heart_transcriptor', 'lyricsync.transcription.heart'] },
    files: ['python', 'NOTICE'].map(path => ({ path, url: `https://example.org/${path}`, sha256: sha(path), size: 1, executable: path === 'python' })) }
  const lock = { schema: 1, kind: 'processing-input', ...Object.fromEntries(
    ['appVersion', 'backendVersion', 'lyricsyncVersion', 'platform', 'arch', 'accelerator', 'python', 'pythonVersion', 'capabilities', 'models', 'modelCapabilities', 'probe'].map(key => [key, runtime[key]])),
    sourceCommit: 'a'.repeat(40), packages: [{ name: 'fixture', version: '1', license: 'MIT', sourceUrl: 'https://example.org/package', sha256: sha('package'), notices: ['NOTICE'] }],
    files: runtime.files.map(({ url, ...file }) => file) }
  runtime.provenance = { inputLock: JSON.stringify(lock), lockSha256: sha(JSON.stringify(lock)), sourceCommit: lock.sourceCommit, packages: lock.packages }
  const qualification = { passed: true, runtimeLockSha256: runtime.provenance.lockSha256, platform, arch, accelerator: 'cpu', evidenceReference: 'fixture-run-1' }
  const modelPolicy = { schema: 1, allowedHosts: ['example.org'], models: SETUP_MODEL_IDS.map(id => ({ id, files: [{ path: `huggingface/${id}`, url: `https://example.org/${id}`, sha256: sha(id), revision: sha(id), size: 1, executable: false }] })) }
  const locks = { schema: 1, lockSha256: [runtime.provenance.lockSha256] }
  const catalog = createSetupCatalog({ runtime, qualification, models: SETUP_MODEL_IDS.map(id => ({ id, terms: [{ label: `${id} terms`, url: 'https://example.org/license' }] })) },
    { identity: target, trustedLocks: locks.lockSha256, modelPolicy })
  return { catalog, locks, modelPolicy, identity: packagedCatalogIdentity(nativeManifest, '1') }
}
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

test('processing-ready requires a catalog the packaged application accepts and reports its digests', () => {
  const { catalog, locks, modelPolicy, identity } = fixture()
  assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: null, identity, locks, modelPolicy }), /requires desktop\/processing-catalog\.json.*setup_catalog\.mjs/)
  const catalogBytes = bytes(catalog)
  const result = assertProcessingCatalog({ mode: 'processing-ready', catalogBytes, identity, locks, modelPolicy })
  assert.deepEqual(result, { mode: 'processing-ready', explicit: true, catalogSha256: sha(catalogBytes), runtimeLockSha256: catalog.runtime.provenance.lockSha256 })
})

test('processing-ready rejects every catalog the packaged application would reject', () => {
  const cases = [
    ['untrusted lock', f => { f.locks = { schema: 1, lockSha256: ['b'.repeat(64)] } }, /not trusted/],
    ['malformed lock policy', f => { f.locks = { lockSha256: f.locks.lockSha256 } }, /lock policy/],
    ['target mismatch', f => { const other = fixture({ arch: 'arm64' }); f.catalog = other.catalog; f.locks = other.locks }, /targets linux-arm64, not the packaged linux-x64/],
    ['app version mismatch', f => { f.identity = packagedCatalogIdentity({ ...nativeManifest, appVersion: '2' }, '2') }, /incompatible/],
    ['non-HTTPS runtime source', f => { f.catalog.runtime.files[0].url = 'http://example.org/python' }, /HTTPS/],
    ['private-test local source', f => { f.catalog.runtime.files[0].url = 'file:///tmp/python' }, /private-test/],
    ['qualification not passed', f => { f.catalog.qualification.passed = false }, /qualification/],
    ['qualification absent', f => { delete f.catalog.qualification }, /qualification/],
    ['model policy drift', f => { f.modelPolicy.models[0].files[0].url = 'https://unapproved.example/model' }, /approved upstream/],
  ]
  for (const [label, mutate, pattern] of cases) {
    const f = fixture(); mutate(f)
    for (const mode of ['processing-ready', null]) {
      assert.throws(() => assertProcessingCatalog({ mode, catalogBytes: bytes(f.catalog), identity: f.identity, locks: f.locks, modelPolicy: f.modelPolicy }),
        error => pattern.test(error.message) && /would be rejected by the packaged linux-x64 application/.test(error.message), label)
    }
  }
  const { locks, modelPolicy, identity } = fixture()
  assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: Buffer.from('{'), identity, locks, modelPolicy }), /not JSON/)
  assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: bytes({}), identity, locks, modelPolicy }), /catalog is missing/)
})

test('playback-only forbids a catalog; an unnamed mode follows the file but still validates it', () => {
  const { catalog, locks, modelPolicy, identity } = fixture()
  const catalogBytes = bytes(catalog)
  assert.throws(() => assertProcessingCatalog({ mode: 'playback-only', catalogBytes, identity, locks, modelPolicy }), /requires desktop\/processing-catalog\.json to be absent/)
  assert.deepEqual(assertProcessingCatalog({ mode: 'playback-only', catalogBytes: null, identity, locks, modelPolicy }),
    { mode: 'playback-only', explicit: true, catalogSha256: null, runtimeLockSha256: null, notice: undefined })
  const development = assertProcessingCatalog({ mode: null, catalogBytes: null, identity, locks, modelPolicy })
  assert.equal(development.mode, 'playback-only'); assert.equal(development.explicit, false)
  assert.match(development.notice, /playback-only.*processing unavailable/)
  const present = assertProcessingCatalog({ mode: null, catalogBytes, identity, locks, modelPolicy })
  assert.equal(present.mode, 'processing-ready'); assert.equal(present.explicit, false)
  assert.throws(() => assertProcessingCatalog({ mode: 'ready', catalogBytes, identity, locks, modelPolicy }), /Invalid processing packaging mode/)
})

test('packaging flags name at most one mode and signed releases must name one', () => {
  assert.equal(processingModeFromArgs([]), null)
  assert.equal(processingModeFromArgs(['--processing-ready']), 'processing-ready')
  assert.equal(processingModeFromArgs(['--playback-only'], { signed: true }), 'playback-only')
  assert.throws(() => processingModeFromArgs(['--processing-ready', '--playback-only']), /mutually exclusive/)
  assert.throws(() => processingModeFromArgs([], { signed: true }), /must name/)
  assert.equal(assertPackagingMode(['--first-installers'], 'linux').processingMode, null)
  assert.equal(assertPackagingMode(['--processing-ready'], 'linux').processingMode, 'processing-ready')
  assert.throws(() => assertPackagingMode(['--playback-only', '--processing-ready'], 'linux'), /mutually exclusive/)
  for (const [argv, platform] of [[['--signed-release', '--first-installers', '--azure-oidc'], 'win32'], [['--signed-macos-release', '--first-installers'], 'darwin']]) {
    assert.throws(() => assertPackagingMode(argv, platform), /must name --processing-ready or --playback-only/)
    assert.equal(assertPackagingMode([...argv, '--processing-ready'], platform).processingMode, 'processing-ready')
    assert.equal(assertPackagingMode([...argv, '--playback-only'], platform).processingMode, 'playback-only')
  }
})

test('packaged application must carry exactly the validated catalog or none', () => {
  const { catalog, locks, modelPolicy, identity } = fixture()
  const ready = assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: bytes(catalog), identity, locks, modelPolicy })
  const playback = assertProcessingCatalog({ mode: 'playback-only', catalogBytes: null, identity, locks, modelPolicy })
  assert.equal(assertPackagedProcessingCatalog(ready, ready.catalogSha256), ready)
  assert.throws(() => assertPackagedProcessingCatalog(ready, null), /without processing-catalog\.json/)
  assert.throws(() => assertPackagedProcessingCatalog(ready, sha('other')), /differs from the validated source/)
  assert.equal(assertPackagedProcessingCatalog(playback, null), playback)
  assert.throws(() => assertPackagedProcessingCatalog(playback, ready.catalogSha256), /Playback-only packaging produced an application containing/)
  assert.throws(() => assertPackagedProcessingCatalog(undefined, null), /requires a gate result/)
})

test('catalog inputs are the application directory files, with absence distinct from read failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-gate-')); t.after(() => rm(root, { recursive: true, force: true }))
  const { catalog, locks, modelPolicy } = fixture()
  await writeFile(join(root, 'processing-locks.json'), JSON.stringify(locks)); await writeFile(join(root, 'models.json'), JSON.stringify(modelPolicy))
  assert.deepEqual(await readProcessingCatalogInputs(root), { catalogBytes: null, locks, modelPolicy })
  await writeFile(join(root, 'processing-catalog.json'), bytes(catalog))
  assert.deepEqual((await readProcessingCatalogInputs(root)).catalogBytes, await readFile(join(root, 'processing-catalog.json')))
  await rm(join(root, 'processing-catalog.json')); await (await import('node:fs/promises')).mkdir(join(root, 'processing-catalog.json'))
  await assert.rejects(readProcessingCatalogInputs(root), /Cannot read desktop\/processing-catalog\.json/)
})

test('catalog identity is the launch-time native manifest validation', () => {
  assert.equal(packagedCatalogIdentity(nativeManifest, '1'), nativeManifest)
  assert.throws(() => packagedCatalogIdentity(nativeManifest, '2'), /does not match this application/)
  assert.throws(() => packagedCatalogIdentity({ ...nativeManifest, extra: 'x' }, '1'), /does not match this application/)
})
