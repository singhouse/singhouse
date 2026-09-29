// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseArguments, reusableRuntime, validateResume } from './packaged-processing-smoke.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const args = ['--executable', 'app.exe', '--runtime-manifest', 'manifest.json', '--audio', 'audio.wav', '--output', 'evidence', '--download-models']
test('resume is explicit and retains model retrieval consent requirement', () => {
  assert.equal(parseArguments(args).resume, false)
  assert.equal(parseArguments([...args, '--resume']).resume, true)
  assert.throws(() => parseArguments([...args, '--resume', '--resume']), /Duplicate/)
  assert.throws(() => parseArguments([...args.slice(0, -1), '--resume']), /consent/)
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'processing-resume-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const output = join(root, 'evidence'); mkdirSync(output); mkdirSync(join(output, 'profile'))
  const expected = { executableSha256: 'a'.repeat(64), runtimeManifestSha256: 'b'.repeat(64), input: { sha256: 'c'.repeat(64), bytes: 123 } }
  const prior = { schema: 1, kind: 'packaged-local-processing-smoke', status: 'running', ...expected,
    application: { packaged: true, platform: 'win32', userData: join(output, 'profile') } }
  const save = () => writeFileSync(join(output, 'evidence.json'), JSON.stringify(prior))
  save(); return { root, output, expected, prior, save }
}

test('interrupted evidence is hash linked without modifying bytes or inferring a pass', t => {
  const f = fixture(t), before = readFileSync(join(f.output, 'evidence.json'))
  const result = validateResume(f.output, f.expected)
  assert.equal(result.sha256, hash(before)); assert.equal(result.prior.status, 'running')
  assert.deepEqual(readFileSync(join(f.output, 'evidence.json')), before)
})

test('resume rejects changed payloads, wrong profile, completed runs and inference retries', t => {
  const f = fixture(t)
  for (const field of ['executableSha256', 'runtimeManifestSha256']) {
    assert.throws(() => validateResume(f.output, { ...f.expected, [field]: 'd'.repeat(64) }), /changed/)
  }
  assert.throws(() => validateResume(f.output, { ...f.expected, input: { sha256: 'd'.repeat(64), bytes: 123 } }), /audio changed/)
  const originalProfile = f.prior.application.userData
  f.prior.application.userData = f.root; f.save()
  assert.throws(() => validateResume(f.output, f.expected), /profile identity/)
  f.prior.application.userData = originalProfile
  f.prior.status = 'passed'; f.save()
  assert.throws(() => validateResume(f.output, f.expected), /incomplete/)
  f.prior.status = 'running'; f.prior.songId = 'submitted'; f.save()
  assert.throws(() => validateResume(f.output, f.expected), /installation interruptions only/)
})

test('resume rejects a linked profile before touching the target', t => {
  const f = fixture(t), profile = join(f.output, 'profile'), target = join(f.root, 'unrelated')
  mkdirSync(target); rmSync(profile, { recursive: true })
  symlinkSync(target, profile, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => validateResume(f.output, f.expected), /must not be a link/)
})

test('runtime reuse requires current admitted backend runtime matching manifest and accelerator', () => {
  const manifest = { accelerator: 'cpu', kind: 'processing' }, id = hash(JSON.stringify(manifest))
  assert.equal(reusableRuntime({}, manifest), false)
  assert.equal(reusableRuntime({ runtime: { id: 'wrong', accelerator: 'cpu' } }, manifest), false)
  assert.equal(reusableRuntime({ runtime: { id, accelerator: 'cuda' } }, manifest), false)
  assert.equal(reusableRuntime({ runtime: { id, accelerator: 'cpu', capabilities: [] } }, manifest), true)
})

test('all earlier resume attempts are validated and hash linked', t => {
  const f = fixture(t), originalHash = hash(readFileSync(join(f.output, 'evidence.json')))
  const directory = join(f.output, 'resume-first'); mkdirSync(directory)
  const attempt = { ...f.prior, resume: { priorEvidence: '../evidence.json', priorEvidenceSha256: originalHash } }
  const bytes = JSON.stringify(attempt); writeFileSync(join(directory, 'evidence.json'), bytes)
  assert.deepEqual(validateResume(f.output, f.expected).attempts,
    [{ evidence: '../resume-first/evidence.json', sha256: hash(bytes), status: 'running' }])
  attempt.jobId = 'previously-submitted'; writeFileSync(join(directory, 'evidence.json'), JSON.stringify(attempt))
  assert.throws(() => validateResume(f.output, f.expected), /installation interruptions only/)
})

test('malformed or mismatched earlier attempt evidence fails closed', t => {
  const f = fixture(t), directory = join(f.output, 'resume-first'); mkdirSync(directory)
  assert.throws(() => validateResume(f.output, f.expected), /ENOENT/)
  writeFileSync(join(directory, 'evidence.json'), '{')
  assert.throws(() => validateResume(f.output, f.expected), SyntaxError)
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ...f.prior,
    resume: { priorEvidence: '../evidence.json', priorEvidenceSha256: 'wrong' } }))
  assert.throws(() => validateResume(f.output, f.expected), /changed lineage/)
})

test('durable inference intent blocks retries even with no job or song response', t => {
  const f = fixture(t)
  writeFileSync(join(f.output, 'inference-started.json'), '{}', { flag: 'wx', flush: true })
  assert.throws(() => validateResume(f.output, f.expected), /ambiguous inference/)
  rmSync(join(f.output, 'inference-started.json'))
  f.prior.inferenceStartedAt = new Date().toISOString(); f.save()
  assert.throws(() => validateResume(f.output, f.expected), /installation interruptions only/)
  delete f.prior.inferenceStartedAt; f.save()
  const directory = join(f.output, 'resume-first'); mkdirSync(directory)
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ...f.prior,
    resume: { priorEvidence: '../evidence.json', priorEvidenceSha256: hash(readFileSync(join(f.output, 'evidence.json'))) } }))
  writeFileSync(join(directory, 'inference-started.json'), '{}', { flag: 'wx', flush: true })
  assert.throws(() => validateResume(f.output, f.expected), /ambiguous inference/)
})
