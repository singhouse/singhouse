// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSetupCatalog, SETUP_MODEL_IDS, validateShippedCatalog } from '../setup_catalog.mjs'
import { prepareSetupCatalog } from '../build/setup_catalog.mjs'
import { assertPackagingMode, packagedApplicationArchivePath, verifyPackagedProcessingCatalog } from '../build/package.mjs'
import { assertPackagedProcessingCatalog, assertProcessingCatalog, catalogSourceName, packagedCatalogIdentity, packagedCatalogSha256,
  prepareProcessingGate, processingModeFromArgs, processingModeRecord, readProcessingCatalogInputs } from '../build/processing_catalog_gate.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const nativeManifest = { schema: 1, appVersion: '1', backendVersion: '1', lyricsyncVersion: '1', pythonVersion: '3.12.0', platform: 'linux', arch: 'x64', runtimeId: 'f'.repeat(64) }

// Test-only fixture: qualification here is synthetic and never leaves this file.
function fixture({ platform = 'linux', arch = 'x64', scope = 'full' } = {}) {
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
  const qualification = { passed: true, scope, runtimeLockSha256: runtime.provenance.lockSha256, platform, arch, accelerator: 'cpu', evidenceReference: 'fixture-run-1' }
  const modelPolicy = { schema: 1, allowedHosts: ['example.org'], models: SETUP_MODEL_IDS.map(id => ({ id, files: [{ path: `huggingface/${id}`, url: `https://example.org/${id}`, sha256: sha(id), revision: sha(id), size: 1, executable: false }] })) }
  const locks = { schema: 1, lockSha256: [runtime.provenance.lockSha256] }
  const input = structuredClone({ runtime, qualification, models: SETUP_MODEL_IDS.map(id => ({ id, terms: [{ label: `${id} terms`, url: 'https://example.org/license' }] })) })
  const catalog = createSetupCatalog(structuredClone(input), { identity: target, trustedLocks: locks.lockSha256, modelPolicy, releaseChannel: 'private-test' })
  return { catalog, locks, modelPolicy, input, target, identity: packagedCatalogIdentity(nativeManifest, '1') }
}
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const source = 'desktop/processing-catalogs/linux-x64.json'

test('processing-ready requires the target catalog the packaged application accepts and reports its digests', () => {
  const { catalog, locks, modelPolicy, identity } = fixture()
  assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: null, identity, locks, modelPolicy }),
    /--processing-ready requires desktop\/processing-catalogs\/linux-x64\.json\..*setup_catalog\.mjs.*for linux-x64/)
  const catalogBytes = bytes(catalog)
  const result = assertProcessingCatalog({ mode: 'processing-ready', catalogBytes, identity, locks, modelPolicy })
  assert.deepEqual(result, { mode: 'processing-ready', catalogSha256: sha(catalogBytes), runtimeLockSha256: catalog.runtime.provenance.lockSha256, qualificationScope: 'full' })
  assert.throws(() => assertProcessingCatalog({ mode: null, catalogBytes, identity, locks, modelPolicy }), /Invalid processing packaging mode/)
  assert.throws(() => assertProcessingCatalog({ mode: 'ready', catalogBytes, identity, locks, modelPolicy }), /Invalid processing packaging mode/)
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
    ['qualification scope absent', f => { delete f.catalog.qualification.scope }, /qualification must state its scope/],
    ['qualification scope unknown', f => { f.catalog.qualification.scope = 'partial' }, /qualification must state its scope/],
    ['model policy drift', f => { f.modelPolicy.models[0].files[0].url = 'https://unapproved.example/model' }, /approved upstream/],
  ]
  for (const [label, mutate, pattern] of cases) {
    const f = fixture(); mutate(f)
    assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: bytes(f.catalog), identity: f.identity, locks: f.locks, modelPolicy: f.modelPolicy }),
      error => pattern.test(error.message) && error.message.startsWith(`${source} would be rejected by the packaged linux-x64 application`), label)
    // The application-start helper rejects the same catalogs (lock policy shape is a packaging-only precondition).
    if (label !== 'malformed lock policy') {
      assert.throws(() => validateShippedCatalog(bytes(f.catalog).toString('utf8'), { identity: f.identity, trustedLocks: f.locks.lockSha256, modelPolicy: f.modelPolicy }), undefined, label)
    }
  }
  const { locks, modelPolicy, identity } = fixture()
  assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: Buffer.from('{'), identity, locks, modelPolicy }), /not JSON/)
  assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: bytes({}), identity, locks, modelPolicy }), /catalog is missing/)
})

test('the shared shipped-catalog validation never enables private-test local sources', () => {
  const { catalog, locks, modelPolicy, identity } = fixture()
  const options = { identity, trustedLocks: locks.lockSha256, modelPolicy }
  assert.deepEqual(validateShippedCatalog(bytes(catalog).toString('utf8'), options), catalog)
  catalog.runtime.files[0].url = 'file:///tmp/python'
  assert.throws(() => validateShippedCatalog(JSON.stringify(catalog), { ...options, privateTestLocalSources: true }), /private-test/)
  assert.throws(() => validateShippedCatalog('{', options), /not JSON/)
  assert.throws(() => validateShippedCatalog(bytes(catalog), options), /must be JSON text/)
})

test('playback-only packages no catalog and never validates an excluded one', () => {
  const { catalog, locks, modelPolicy, identity } = fixture()
  assert.deepEqual(assertProcessingCatalog({ mode: 'playback-only', catalogBytes: null, identity, locks, modelPolicy }),
    { mode: 'playback-only', catalogSha256: null, runtimeLockSha256: null, qualificationScope: null, notice: undefined })
  for (const catalogBytes of [bytes(catalog), Buffer.from('{')]) {
    const excluded = assertProcessingCatalog({ mode: 'playback-only', catalogBytes, identity, locks, modelPolicy })
    assert.equal(excluded.catalogSha256, null)
    assert.match(excluded.notice, /desktop\/processing-catalogs\/linux-x64\.json exists but is deliberately excluded/)
  }
})

test('every packaging run names exactly one processing mode with exact flags', () => {
  assert.equal(processingModeFromArgs(['node', 'package.mjs', '--processing-ready']), 'processing-ready')
  assert.equal(processingModeFromArgs(['--first-installers', '--playback-only'], {}), 'playback-only')
  for (const argv of [[], ['--first-installers'], ['--playback-only', '--playback-only']]) {
    assert.throws(() => processingModeFromArgs(argv, {}), /requires exactly one of --processing-ready or --playback-only.*run package -- --playback-only/)
  }
  assert.throws(() => processingModeFromArgs(['--processing-ready', '--playback-only'], {}), /mutually exclusive/)
  for (const arg of ['--processing-ready=true', '--playback-only=1', '--playback-onlyx', '--processing-ready-now']) {
    assert.throws(() => processingModeFromArgs([arg], {}), /Unrecognized packaging option.*use exactly --/, arg)
    assert.throws(() => processingModeFromArgs([arg, '--playback-only'], {}), /Unrecognized packaging option/, arg)
  }
  for (const env of [{ npm_config_processing_ready: 'true' }, { npm_config_playback_only: '' }]) {
    assert.throws(() => processingModeFromArgs(['--playback-only'], env), /npm consumed a processing mode flag.*after `--`/)
    assert.throws(() => processingModeFromArgs([], env), /npm consumed/)
  }
  assert.equal(processingModeFromArgs(['--playback-only'], { npm_config_prefix: 'desktop' }), 'playback-only')
})

test('packaging mode parsing applies to unsigned and signed builds alike', () => {
  for (const argv of [[], ['--first-installers']]) assert.throws(() => assertPackagingMode(argv, 'linux', {}), /requires exactly one/)
  assert.equal(assertPackagingMode(['--processing-ready'], 'linux', {}).processingMode, 'processing-ready')
  assert.equal(assertPackagingMode(['--first-installers', '--playback-only'], 'linux', {}).processingMode, 'playback-only')
  assert.throws(() => assertPackagingMode(['--playback-only', '--processing-ready'], 'linux', {}), /mutually exclusive/)
  assert.throws(() => assertPackagingMode(['--processing-ready=yes'], 'linux', {}), /Unrecognized packaging option/)
  assert.throws(() => assertPackagingMode(['--first-installers'], 'linux', { npm_config_playback_only: 'true' }), /npm consumed/)
  for (const [argv, platform] of [[['--signed-release', '--first-installers', '--azure-oidc'], 'win32'], [['--signed-macos-release', '--first-installers'], 'darwin']]) {
    assert.throws(() => assertPackagingMode(argv, platform, {}), /requires exactly one of --processing-ready or --playback-only/)
    assert.equal(assertPackagingMode([...argv, '--processing-ready'], platform, {}).processingMode, 'processing-ready')
    assert.equal(assertPackagingMode([...argv, '--playback-only'], platform, {}).processingMode, 'playback-only')
  }
})

test('packaged application must carry exactly the validated catalog or none', () => {
  const { catalog, locks, modelPolicy, identity } = fixture()
  const ready = assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: bytes(catalog), identity, locks, modelPolicy })
  const playback = assertProcessingCatalog({ mode: 'playback-only', catalogBytes: null, identity, locks, modelPolicy })
  assert.equal(assertPackagedProcessingCatalog(ready, ready.catalogSha256), ready)
  assert.throws(() => assertPackagedProcessingCatalog(ready, null), /without processing-catalog\.json/)
  assert.throws(() => assertPackagedProcessingCatalog(ready, sha('other')), /differs from the validated source/)
  assert.throws(() => assertPackagedProcessingCatalog({ mode: 'processing-ready', catalogSha256: null }, null), /no validated catalog digest/)
  assert.equal(assertPackagedProcessingCatalog(playback, null), playback)
  assert.throws(() => assertPackagedProcessingCatalog(playback, ready.catalogSha256), /Playback-only packaging produced an application containing/)
  assert.throws(() => assertPackagedProcessingCatalog(playback, undefined), /Playback-only packaging produced an application containing/)
  assert.throws(() => assertPackagedProcessingCatalog(undefined, null), /requires a gate result/)
})

test('catalog source is one file per target, with absence distinct from read failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-gate-')); t.after(() => rm(root, { recursive: true, force: true }))
  const { catalog, locks, modelPolicy } = fixture()
  assert.equal(catalogSourceName({ platform: 'win32', arch: 'x64' }), 'processing-catalogs/win32-x64.json')
  assert.equal(catalogSourceName({ platform: 'darwin', arch: 'arm64' }), 'processing-catalogs/darwin-arm64.json')
  for (const target of [{}, { platform: '../linux', arch: 'x64' }, { platform: 'linux', arch: 'x64/../y' }]) assert.throws(() => catalogSourceName(target), /target is invalid/)
  await writeFile(join(root, 'processing-locks.json'), JSON.stringify(locks)); await writeFile(join(root, 'models.json'), JSON.stringify(modelPolicy))
  const linux = { platform: 'linux', arch: 'x64' }
  assert.deepEqual(await readProcessingCatalogInputs(root, linux), { catalogBytes: null, locks, modelPolicy })
  // A legacy single catalog and another target's catalog are not this target's source.
  await writeFile(join(root, 'processing-catalog.json'), bytes(catalog))
  await mkdir(join(root, 'processing-catalogs')); await writeFile(join(root, 'processing-catalogs', 'linux-arm64.json'), bytes(catalog))
  assert.equal((await readProcessingCatalogInputs(root, linux)).catalogBytes, null)
  await writeFile(join(root, 'processing-catalogs', 'linux-x64.json'), bytes(catalog))
  assert.deepEqual((await readProcessingCatalogInputs(root, linux)).catalogBytes, await readFile(join(root, 'processing-catalogs', 'linux-x64.json')))
  await rm(join(root, 'processing-catalogs', 'linux-x64.json')); await mkdir(join(root, 'processing-catalogs', 'linux-x64.json'))
  await assert.rejects(readProcessingCatalogInputs(root, linux), /Cannot read desktop\/processing-catalogs\/linux-x64\.json/)
})

test('the packaging gate selects the target catalog from the native manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-prepare-')); t.after(() => rm(root, { recursive: true, force: true }))
  const { catalog, locks, modelPolicy } = fixture()
  const other = fixture({ arch: 'arm64' })
  await writeFile(join(root, 'processing-locks.json'), JSON.stringify({ schema: 1, lockSha256: [...locks.lockSha256, ...other.locks.lockSha256] }))
  await writeFile(join(root, 'models.json'), JSON.stringify(modelPolicy))
  await mkdir(join(root, 'processing-catalogs'))
  await writeFile(join(root, 'processing-catalogs', 'linux-arm64.json'), bytes(other.catalog))
  const prepare = (argv, env = {}, manifest = nativeManifest) => prepareProcessingGate({ desktopDir: root, nativeManifest: manifest, appVersion: '1', releaseChannel: 'stable', argv, env })

  await assert.rejects(prepare([]), /requires exactly one/)
  await assert.rejects(prepare(['--playback-only'], { npm_config_playback_only: 'true' }), /npm consumed/)
  // Only another target's catalog exists: processing-ready fails, playback-only ships nothing.
  await assert.rejects(prepare(['--processing-ready']), /requires desktop\/processing-catalogs\/linux-x64\.json/)
  assert.deepEqual(await prepare(['--playback-only']), { result: { mode: 'playback-only', catalogSha256: null, runtimeLockSha256: null,
    qualificationScope: null, target: { platform: 'linux', arch: 'x64' } }, catalogBytes: null, notices: [] })
  await assert.rejects(prepare(['--processing-ready'], {}, { ...nativeManifest, appVersion: '2' }), /does not match this application/)

  const catalogBytes = bytes(catalog)
  await writeFile(join(root, 'processing-catalogs', 'linux-x64.json'), catalogBytes)
  const ready = await prepare(['node', 'package.mjs', '--first-installers', '--processing-ready'])
  assert.deepEqual(ready.result, { mode: 'processing-ready', catalogSha256: sha(catalogBytes), runtimeLockSha256: catalog.runtime.provenance.lockSha256,
    qualificationScope: 'full', target: { platform: 'linux', arch: 'x64' } })
  assert.deepEqual(ready.catalogBytes, catalogBytes)
  assert.deepEqual(ready.notices, [])
  const build = { releaseId: 'd'.repeat(64), releaseChannel: 'stable', electronAppDigest: 'e'.repeat(64) }
  assert.deepEqual(processingModeRecord({ ...ready.result, ...build }), { schema: 1, mode: 'processing-ready', ...build, catalogSha256: sha(catalogBytes),
    runtimeLockSha256: catalog.runtime.provenance.lockSha256, qualificationScope: 'full', target: { platform: 'linux', arch: 'x64' } })
  // The record is bound to the build it describes; it cannot be written without that identity.
  for (const missing of ['releaseId', 'releaseChannel', 'electronAppDigest']) {
    assert.throws(() => processingModeRecord({ ...ready.result, ...build, [missing]: undefined }), /derived release identity and packaged release channel/, missing)
  }
  assert.throws(() => processingModeRecord({ ...ready.result, ...build, electronAppDigest: 'E'.repeat(64) }), /derived release identity/)
  const excluded = await prepare(['--playback-only'])
  assert.equal(excluded.catalogBytes, null)
  assert.equal(excluded.notices.length, 1); assert.match(excluded.notices[0], /linux-x64\.json exists but is deliberately excluded/)
  assert.deepEqual(processingModeRecord({ ...excluded.result, ...build }), { schema: 1, mode: 'playback-only', ...build, catalogSha256: null, runtimeLockSha256: null,
    qualificationScope: null, target: { platform: 'linux', arch: 'x64' } })

  // The arm64 build picks the arm64 file, never the x64 one.
  const arm = await prepare(['--processing-ready'], {}, { ...nativeManifest, arch: 'arm64' })
  assert.equal(arm.result.catalogSha256, sha(bytes(other.catalog)))
  assert.deepEqual(arm.result.target, { platform: 'linux', arch: 'arm64' })

  await writeFile(join(root, 'processing-catalog.json'), catalogBytes)
  const legacy = await prepare(['--processing-ready'])
  assert.match(legacy.notices.at(-1), /desktop\/processing-catalog\.json is not a catalog source and is never packaged/)
  assert.equal(legacy.result.catalogSha256, sha(catalogBytes))
})

test('catalog identity is the launch-time native manifest validation', () => {
  assert.equal(packagedCatalogIdentity(nativeManifest, '1'), nativeManifest)
  assert.throws(() => packagedCatalogIdentity(nativeManifest, '2'), /does not match this application/)
  assert.throws(() => packagedCatalogIdentity({ ...nativeManifest, extra: 'x' }, '1'), /does not match this application/)
})

test('packaging records the qualification scope and refuses private-smoke outside the private-test channel', () => {
  const full = fixture()
  for (const releaseChannel of ['private-test', 'stable', undefined]) {
    assert.equal(assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: bytes(full.catalog), identity: full.identity,
      locks: full.locks, modelPolicy: full.modelPolicy, releaseChannel }).qualificationScope, 'full')
  }
  const smoke = fixture({ scope: 'private-smoke' })
  const catalogBytes = bytes(smoke.catalog)
  const accepted = assertProcessingCatalog({ mode: 'processing-ready', catalogBytes, identity: smoke.identity,
    locks: smoke.locks, modelPolicy: smoke.modelPolicy, releaseChannel: 'private-test' })
  assert.deepEqual(accepted, { mode: 'processing-ready', catalogSha256: sha(catalogBytes),
    runtimeLockSha256: smoke.catalog.runtime.provenance.lockSha256, qualificationScope: 'private-smoke' })
  for (const releaseChannel of ['stable', 'core-private-test', undefined]) {
    assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes, identity: smoke.identity, locks: smoke.locks, modelPolicy: smoke.modelPolicy, releaseChannel }),
      error => /would be rejected by the packaged linux-x64 application: Private-smoke processing qualification is accepted only by "private-test" channel builds/.test(error.message), String(releaseChannel))
  }
  const failed = fixture({ scope: 'private-smoke' }); failed.catalog.qualification.passed = false
  assert.throws(() => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: bytes(failed.catalog), identity: failed.identity,
    locks: failed.locks, modelPolicy: failed.modelPolicy, releaseChannel: 'private-test' }), /passed qualification/)
})

test('post-package verification reads the produced app.asar on every platform layout', async t => {
  try { createRequire(import.meta.url).resolve('@electron/asar') }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    t.skip('Requires locked desktop npm dependencies'); return
  }
  // An installed but broken/incompatible asar module must fail, not skip.
  const { createPackage } = await import('@electron/asar')
  const root = await mkdtemp(join(tmpdir(), 'catalog-asar-')); t.after(() => rm(root, { recursive: true, force: true }))
  const { catalog, locks, modelPolicy, identity } = fixture()
  const catalogBytes = bytes(catalog)
  const ready = assertProcessingCatalog({ mode: 'processing-ready', catalogBytes, identity, locks, modelPolicy })
  const playback = assertProcessingCatalog({ mode: 'playback-only', catalogBytes: null, identity, locks, modelPolicy })
  const pack = async (name, entries) => {
    const source = join(root, `${name}-source`)
    await mkdir(source, { recursive: true }); await writeFile(join(source, 'main.mjs'), '// fixture\n')
    for (const [path, value] of Object.entries(entries)) {
      await mkdir(join(source, path, '..'), { recursive: true })
      if (value === 'directory') await mkdir(join(source, path)); else await writeFile(join(source, path), value)
    }
    const applications = {}
    for (const platform of ['linux', 'win32', 'darwin']) {
      const application = join(root, name, platform)
      const archive = packagedApplicationArchivePath(application, platform)
      await mkdir(join(archive, '..'), { recursive: true })
      await createPackage(source, archive)
      applications[platform] = application
    }
    return applications
  }
  assert.equal(packagedApplicationArchivePath('/app', 'darwin'), '/app/Singhouse.app/Contents/Resources/app.asar')
  assert.equal(packagedApplicationArchivePath('/app', 'win32'), '/app/resources/app.asar')
  assert.equal(packagedApplicationArchivePath('/app', 'linux'), '/app/resources/app.asar')

  const withCatalog = await pack('with', { 'processing-catalog.json': catalogBytes })
  const without = await pack('without', { 'processing-catalogs/linux-x64.json': catalogBytes, 'nested/processing-catalog.json': catalogBytes })
  const altered = await pack('altered', { 'processing-catalog.json': Buffer.concat([catalogBytes, Buffer.from(' ')]) })
  const directory = await pack('directory', { 'processing-catalog.json': 'directory' })
  for (const platform of ['linux', 'win32', 'darwin']) {
    assert.equal(await packagedCatalogSha256(packagedApplicationArchivePath(withCatalog[platform], platform)), ready.catalogSha256)
    assert.equal(await packagedCatalogSha256(packagedApplicationArchivePath(without[platform], platform)), null)
    assert.equal(await verifyPackagedProcessingCatalog({ applicationDirectory: withCatalog[platform], platform, gate: ready }), ready)
    assert.equal(await verifyPackagedProcessingCatalog({ applicationDirectory: without[platform], platform, gate: playback }), playback)
    await assert.rejects(verifyPackagedProcessingCatalog({ applicationDirectory: without[platform], platform, gate: ready }), /without processing-catalog\.json/)
    await assert.rejects(verifyPackagedProcessingCatalog({ applicationDirectory: withCatalog[platform], platform, gate: playback }), /Playback-only packaging produced an application containing/)
    await assert.rejects(verifyPackagedProcessingCatalog({ applicationDirectory: altered[platform], platform, gate: ready }), /differs from the validated source/)
    await assert.rejects(verifyPackagedProcessingCatalog({ applicationDirectory: directory[platform], platform, gate: playback }), /not a regular file/)
    await assert.rejects(verifyPackagedProcessingCatalog({ applicationDirectory: join(root, 'missing', platform), platform, gate: playback }), /ENOENT/)
  }
})

test('package.mjs validates before electron-builder runs and verifies app.asar before identity and receipt', async () => {
  const text = await readFile(new URL('../build/package.mjs', import.meta.url), 'utf8')
  const main = text.slice(text.indexOf('async function main()'), text.indexOf('export function reportPackagingFailure'))
  const at = needle => { const index = main.indexOf(needle); assert.notEqual(index, -1, needle); return index }
  assert.ok(at('prepareProcessingGate(') < at('build('), 'gate before the first electron-builder build call')
  assert.ok(at('prepareProcessingGate(') < at('stageProcessingCatalog('))
  assert.ok(at('stageProcessingCatalog(') < at("platform.createTarget('dir'"))
  assert.match(main, /files: \[\.\.\.config\.files, \.\.\.stagedCatalog\.files\]/)
  assert.ok(at("platform.createTarget('dir'") < at('verifyPackagedProcessingCatalog('))
  assert.ok(at('verifyPackagedProcessingCatalog(') < at('deriveIdentityFromApplication('))
  assert.ok(at('verifyPackagedProcessingCatalog(') < at('createReleaseReceipt('))
  assert.ok(at('createReleaseReceipt(') < at('writeImmutableFile(processingRecord'))
  assert.match(main, /argv: process\.argv, env: process\.env/)
  // The staged directory is always removed through the warning-only cleanup helper.
  assert.match(main, /await withStagedCatalog\(stagedCatalog, \(\) => build\(/)
  assert.doesNotMatch(main, /stagedCatalog\.cleanup\(/)
  // The mode record is bound to the derived identity and the packaged policy's channel.
  assert.match(main, /processingModeRecord\(\{ \.\.\.processing, releaseId: identity\.releaseId,\s+releaseChannel: policy\.channel, electronAppDigest: identity\.electronAppDigest \}\)/)
  assert.ok(at('deriveIdentityFromApplication(') < at('processingModeRecord('))
})

test('processing-ready accepts only the generator\'s exact canonical bytes', async t => {
  const reject = /would be rejected by the packaged linux-x64 application: catalog is not the generator's canonical output; regenerate it/
  const check = (f, text, releaseChannel) => assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: Buffer.from(text), identity: f.identity,
    locks: f.locks, modelPolicy: f.modelPolicy, releaseChannel })
  const channels = ['private-test', 'stable', 'core-private-test', undefined]

  // A duplicated key: JSON.parse keeps the last value, so the parsed catalog is
  // a valid full-scope one, but the shipped text also claims private-smoke.
  const full = fixture()
  const canonical = bytes(full.catalog).toString('utf8')
  assert.match(canonical, /"scope": "full"/)
  const duplicate = canonical.replace('"scope": "full"', '"scope": "private-smoke",\n    "scope": "full"')
  assert.notEqual(duplicate, canonical)
  assert.equal(JSON.parse(duplicate).qualification.scope, 'full')
  for (const releaseChannel of channels) {
    assert.throws(() => check(full, duplicate, releaseChannel), reject, String(releaseChannel))
    assert.equal(check(full, canonical, releaseChannel).qualificationScope, 'full')
  }
  const variants = {
    'unknown top-level field': `${JSON.stringify({ ...full.catalog, notes: 'unreviewed' }, null, 2)}\n`,
    'unknown qualification field': `${JSON.stringify({ ...full.catalog, qualification: { ...full.catalog.qualification, scopeNote: 'x' } }, null, 2)}\n`,
    'unknown model field': `${JSON.stringify({ ...full.catalog, models: full.catalog.models.map(model => ({ ...model, extra: true })) }, null, 2)}\n`,
    'reordered keys': `${JSON.stringify({ qualification: full.catalog.qualification, ...full.catalog }, null, 2)}\n`,
    'reordered qualification keys': `${JSON.stringify({ ...full.catalog, qualification: Object.fromEntries(Object.entries(full.catalog.qualification).reverse()) }, null, 2)}\n`,
    'compact serialization': JSON.stringify(full.catalog),
    'missing trailing newline': canonical.trimEnd(),
  }
  for (const [label, text] of Object.entries(variants)) {
    assert.notEqual(text, canonical, label)
    for (const releaseChannel of channels) assert.throws(() => check(full, text, releaseChannel), reject, `${label} ${releaseChannel}`)
  }
  assert.throws(() => check(full, `\ufeff${canonical}`, 'stable'), /not JSON/)

  // The real generator's output file passes unchanged, byte for byte.
  const root = await mkdtemp(join(tmpdir(), 'catalog-generator-')); t.after(() => rm(root, { recursive: true, force: true }))
  for (const scope of ['full', 'private-smoke']) {
    const f = fixture({ scope })
    const entries = { runtime: f.input.runtime, qualification: f.input.qualification, terms: f.input.models, identity: f.target,
      locks: f.locks, models: f.modelPolicy }
    const args = []
    for (const [key, value] of Object.entries(entries)) { const path = join(root, `${scope}-${key}.json`); await writeFile(path, JSON.stringify(value)); args.push(`--${key}`, path) }
    const output = join(root, `${scope}-linux-x64.json`)
    await prepareSetupCatalog([...args, '--output', output])
    const generated = await readFile(output)
    const result = assertProcessingCatalog({ mode: 'processing-ready', catalogBytes: generated, identity: f.identity, locks: f.locks, modelPolicy: f.modelPolicy, releaseChannel: 'private-test' })
    assert.deepEqual(result, { mode: 'processing-ready', catalogSha256: sha(generated), runtimeLockSha256: f.catalog.runtime.provenance.lockSha256, qualificationScope: scope })
  }
})
