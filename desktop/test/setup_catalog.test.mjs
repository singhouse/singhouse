// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSetupCatalog, validateSetupCatalog, SETUP_MODEL_IDS } from '../setup_catalog.mjs'
import { prepareSetupCatalog } from '../build/setup_catalog.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
function fixture() {
  const identity = { appVersion: '1', backendVersion: '1', lyricsyncVersion: '1', platform: 'linux', arch: 'x64' }
  const runtime = { schema: 1, kind: 'processing', ...identity, accelerator: 'cpu', python: 'python', pythonVersion: '3.12',
    capabilities: ['transcription', 'separation'], models: [...SETUP_MODEL_IDS],
    modelCapabilities: Object.fromEntries(SETUP_MODEL_IDS.map(id => [id, id === 'heart-transcriptor' ? 'transcription' : 'separation'])),
    probe: { schema: 2, type: 'python-functional-v1', modules: ['audio_separator.separator', 'demucs.separate', 'faster_whisper', 'karaoke_backend.workers.heart_transcriptor', 'lyricsync.transcription.heart'] },
    files: ['python', 'NOTICE'].map(path => ({ path, url: `https://example.org/${path}`, sha256: sha(path), size: 1, executable: path === 'python' })) }
  const lock = { schema: 1, kind: 'processing-input', ...Object.fromEntries(
    ['appVersion', 'backendVersion', 'lyricsyncVersion', 'platform', 'arch', 'accelerator', 'python', 'pythonVersion', 'capabilities', 'models', 'modelCapabilities', 'probe'].map(key => [key, runtime[key]])),
    sourceCommit: 'a'.repeat(40), packages: [{ name: 'fixture', version: '1', license: 'MIT', sourceUrl: 'https://example.org/package', sha256: sha('package'), notices: ['NOTICE'] }],
    files: runtime.files.map(({ url, ...file }) => file) }
  runtime.provenance = { inputLock: JSON.stringify(lock), lockSha256: sha(JSON.stringify(lock)), sourceCommit: lock.sourceCommit, packages: lock.packages }
  const qualification = { passed: true, runtimeLockSha256: runtime.provenance.lockSha256, platform: 'linux', arch: 'x64', accelerator: 'cpu', evidenceReference: 'run-2026-09-29-1' }
  const modelPolicy = { schema: 1, allowedHosts: ['example.org'], models: SETUP_MODEL_IDS.map(id => ({ id, files: [{ path: `huggingface/${id}`, url: `https://example.org/${id}`, sha256: sha(id), revision: sha(id), size: 1, executable: false }] })) }
  return { input: { runtime, qualification, models: SETUP_MODEL_IDS.map(id => ({ id, terms: [{ label: `${id} terms`, url: 'https://example.org/license' }] })) },
    options: { identity, trustedLocks: [runtime.provenance.lockSha256], modelPolicy } }
}

test('catalog preserves explicit qualification and ships metadata without weights or invented memory requirements', () => {
  const { input, options } = fixture()
  const catalog = createSetupCatalog(input, options)
  assert.deepEqual(catalog.qualification, input.qualification)
  assert.equal(catalog.memory, undefined)
  assert.deepEqual(validateSetupCatalog(catalog, options), catalog)
  assert.notEqual(catalog.runtime, input.runtime)
})
test('missing or malformed qualification, target mismatch and untrusted runtime fail closed', () => {
  for (const mutate of [input => { delete input.qualification }, input => { input.qualification.passed = false },
    input => { input.qualification.platform = 'win32' }, input => { input.qualification.runtimeLockSha256 = 'b'.repeat(64) },
    input => { input.qualification.evidenceReference = '/private/evidence.json' }]) {
    const { input, options } = fixture(); mutate(input)
    assert.throws(() => createSetupCatalog(input, options), /qualification/)
  }
  const { input, options } = fixture()
  assert.throws(() => createSetupCatalog(input, { ...options, trustedLocks: [] }), /not trusted/)
  assert.throws(() => createSetupCatalog(input, { ...options, identity: { ...options.identity, arch: 'arm64' } }), /incompatible/)
  input.runtime.files[0].sha256 = 'b'.repeat(64)
  assert.throws(() => createSetupCatalog(input, options), /input lock/)
})
test('production rejects local, credential-bearing, unsigned and secret-bearing source URLs', () => {
  for (const url of ['file:///tmp/python', 'https://user:secret@example.org/python', 'http://example.org/python', 'https://example.org/python?token=secret']) {
    const { input, options } = fixture(); input.runtime.files[0].url = url
    assert.throws(() => createSetupCatalog(input, options), /HTTPS|local|Inputs/)
  }
  const { input, options } = fixture(); input.runtime.files[0].url = 'file:///tmp/python'
  const local = createSetupCatalog(input, { ...options, privateTestLocalSources: true })
  assert.throws(() => validateSetupCatalog(local, options), /private-test/)
  input.models[0].terms[0].url = 'file:///tmp/terms'
  assert.throws(() => createSetupCatalog(input, { ...options, privateTestLocalSources: true }), /HTTPS/)
})
test('terms and upstream model inventories are mandatory and immutable', () => {
  const { input, options } = fixture()
  input.models[0].terms = []
  assert.throws(() => createSetupCatalog(input, options), /terms/)
  const other = fixture(); other.options.modelPolicy.models[0].files[0].url = 'https://unapproved.example/model'
  assert.throws(() => createSetupCatalog(other.input, other.options), /approved upstream/)
})
test('RAM and VRAM recommendations require separate representative measurements plus 25%', () => {
  const { input, options } = fixture()
  const { passed, evidenceReference, ...target } = input.qualification
  const measured = peak => ({ measuredPeakBytes: peak, representativeHardware: { verified: true, description: 'Fixture hardware' }, evidenceReference })
  input.memory = { ...target, ram: measured(101), vram: measured(80) }
  const memory = createSetupCatalog(input, options).memory
  assert.equal(memory.ram.recommendedBytes, 127)
  assert.equal(memory.vram.recommendedBytes, 100)
  for (const mutate of [m => { m.ram.representativeHardware.verified = false }, m => { m.ram.measuredPeakBytes = 0 },
    m => { m.ram.recommendedBytes = 1 }, m => { m.arch = 'arm64' }, m => { m.vram.evidenceReference = '/private/run' }]) {
    const invalid = structuredClone(input); mutate(invalid.memory)
    assert.throws(() => createSetupCatalog(invalid, options), /memory|evidence|recommendation/)
  }
})
test('CLI requires evidence and writes a concrete exclusively created catalog', async t => {
  await assert.rejects(prepareSetupCatalog([]), /Missing --runtime/)
  const root = await mkdtemp(join(tmpdir(), 'setup-catalog-')); t.after(() => rm(root, { recursive: true, force: true }))
  const { input, options } = fixture()
  const entries = { runtime: input.runtime, qualification: input.qualification, terms: input.models, identity: options.identity,
    locks: { lockSha256: options.trustedLocks }, models: options.modelPolicy }
  const args = []
  for (const [key, value] of Object.entries(entries)) { const path = join(root, `${key}.json`); await writeFile(path, JSON.stringify(value)); args.push(`--${key}`, path) }
  const output = join(root, 'processing-catalog.json'); args.push('--output', output)
  await prepareSetupCatalog(args)
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), createSetupCatalog(input, options))
  await assert.rejects(prepareSetupCatalog(args), /EEXIST/)
})
