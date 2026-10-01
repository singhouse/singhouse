// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseArguments, reusableRuntime, validateResume, validateRetainedCandidate, validateRetainedProfile, validateFreshSubmission, retainedDatabaseSnapshot, auditRetainedDatabase,
  applicationEnvironment, shutdownStrategy, validateResumedApplication, candidateIdentity, executableIdentityLimitation, harnessIdentity, HARNESS_FILES,
  extraCaCertificate, validateHarnessArchitecture, assertPhysicalOutputParent, recordedCandidate, CANDIDATE_KEYS, EVIDENCE_SCHEMA } from './packaged-processing-smoke.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const args = ['--executable', 'app.exe', '--runtime-manifest', 'manifest.json', '--audio', 'audio.wav', '--output', 'evidence', '--download-models']
test('resume is explicit and retains model retrieval consent requirement', () => {
  assert.equal(parseArguments(args).resume, false)
  assert.equal(parseArguments([...args, '--resume']).resume, true)
  assert.throws(() => parseArguments([...args, '--resume', '--resume']), /Duplicate/)
  assert.throws(() => parseArguments([...args.slice(0, -1), '--resume']), /consent/)
})

// Linux upgrades keep the stock executable; only the archive/native payload change.
const candidateTuple = (seed, overrides = {}) => ({ executableSha256: seed.repeat(64), applicationArchiveSha256: 'e'.repeat(64),
  nativeManifestSha256: 'f'.repeat(64), nativeProvenanceSha256: '1'.repeat(64), releaseReceiptSha256: '2'.repeat(64), ...overrides })

function fixture(t) {
  // Physical root: macOS temporary directories are reached through /var links.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'processing-resume-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const output = join(root, 'evidence'); mkdirSync(output); mkdirSync(join(output, 'profile'))
  const expected = { candidate: candidateTuple('a'), runtimeManifestSha256: 'b'.repeat(64), input: { sha256: 'c'.repeat(64), bytes: 123 } }
  const prior = { schema: EVIDENCE_SCHEMA, kind: 'packaged-local-processing-smoke', mode: 'advanced', status: 'running', ...expected,
    executableSha256: expected.candidate.executableSha256,
    application: { packaged: true, platform: process.platform, arch: process.arch, userData: join(output, 'profile') } }
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
  // Every element of the candidate identity is bound, not only the executable.
  for (const key of CANDIDATE_KEYS) {
    assert.throws(() => validateResume(f.output, { ...f.expected, candidate: { ...f.expected.candidate, [key]: 'd'.repeat(64) } }),
      /candidate changed outside the explicit upgrade lineage/)
  }
  assert.throws(() => validateResume(f.output, { ...f.expected, runtimeManifestSha256: 'd'.repeat(64) }), /manifest changed/)
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

test('executable upgrade requires explicit resume and a full original hash', () => {
  const flag = '--upgrade-from-executable-sha256', digest = 'a'.repeat(64)
  assert.throws(() => parseArguments([...args, flag, digest]), /requires --resume/)
  assert.throws(() => parseArguments([...args, '--resume', flag, 'abc']), /64 hex/)
  assert.equal(parseArguments([...args, '--resume', flag, digest.toUpperCase()]).upgradeFromExecutableSha256, digest)
})

test('explicit upgrade preserves original evidence and binds original and current candidate tuples', t => {
  const f = fixture(t), original = readFileSync(join(f.output, 'evidence.json'))
  const from = f.expected.candidate.executableSha256
  for (const current of [{ ...f.expected, candidate: candidateTuple('d') },
    // Linux: the stock executable is unchanged while the application archive changes.
    { ...f.expected, candidate: { ...f.expected.candidate, applicationArchiveSha256: '3'.repeat(64) } }]) {
    assert.throws(() => validateResume(f.output, current), /candidate changed/)
    const result = validateResume(f.output, current, from)
    assert.deepEqual(result.upgrade, { fromExecutableSha256: from, toExecutableSha256: current.candidate.executableSha256,
      fromCandidate: f.expected.candidate, toCandidate: current.candidate,
      qualification: 'Application upgrade with retained setup; not clean-install proof' })
    assert.throws(() => validateResume(f.output, current, 'e'.repeat(64)), /does not match original/)
  }
  assert.deepEqual(readFileSync(join(f.output, 'evidence.json')), original)
  assert.throws(() => validateResume(f.output, f.expected, from), /must change the candidate/)
})

test('upgrade retries require every prior candidate to have explicit matching lineage', t => {
  const f = fixture(t), from = f.expected.candidate.executableSha256
  const current = { ...f.expected, candidate: { ...f.expected.candidate, nativeManifestSha256: '4'.repeat(64) } }
  const result = validateResume(f.output, current, from)
  const directory = join(f.output, 'resume-first'); mkdirSync(directory)
  const attempt = { ...f.prior, resume: { priorEvidence: '../evidence.json', priorEvidenceSha256: result.sha256 } }
  const save = () => writeFileSync(join(directory, 'evidence.json'), JSON.stringify(attempt))
  save(); assert.equal(validateResume(f.output, current, from).attempts.length, 1)
  attempt.candidate = current.candidate; save()
  assert.throws(() => validateResume(f.output, current, from), /matching upgrade lineage/)
  attempt.upgrade = result.upgrade; save()
  assert.equal(validateResume(f.output, current, from).attempts.length, 1)
  attempt.upgrade = { ...result.upgrade, fromCandidate: { ...result.upgrade.fromCandidate, applicationArchiveSha256: '5'.repeat(64) } }; save()
  assert.throws(() => validateResume(f.output, current, from), /matching upgrade lineage/)
  attempt.candidate = { ...current.candidate, applicationArchiveSha256: '6'.repeat(64) }; save()
  assert.throws(() => validateResume(f.output, current, from), /candidate changed outside/)
  attempt.candidate = current.candidate; attempt.upgrade = result.upgrade; attempt.inferenceStartedAt = 'recorded'; save()
  assert.throws(() => validateResume(f.output, current, from), /installation interruptions only/)
})

test('legacy evidence without a candidate tuple resumes only on Windows by executable hash', t => {
  const f = fixture(t)
  delete f.prior.candidate; f.prior.schema = 1; f.prior.application.platform = 'win32'; f.save()
  // Legacy Windows evidence: the executable hash is the recorded identity.
  assert.equal(validateResume(f.output, f.expected, undefined, 'win32').candidate.legacy, true)
  assert.throws(() => validateResume(f.output, { ...f.expected, candidate: candidateTuple('d') }, undefined, 'win32'), /candidate changed/)
  const upgraded = validateResume(f.output, { ...f.expected, candidate: candidateTuple('d') }, f.expected.candidate.executableSha256, 'win32')
  assert.deepEqual(upgraded.upgrade.fromCandidate, { executableSha256: f.expected.candidate.executableSha256 })
  // An old-format upgrade attempt keeps its three recorded fields.
  const directory = join(f.output, 'resume-first'); mkdirSync(directory)
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ...f.prior, executableSha256: 'd'.repeat(64),
    resume: { priorEvidence: '../evidence.json', priorEvidenceSha256: upgraded.sha256 },
    upgrade: { fromExecutableSha256: upgraded.upgrade.fromExecutableSha256, toExecutableSha256: 'd'.repeat(64), qualification: upgraded.upgrade.qualification } }))
  assert.equal(validateResume(f.output, { ...f.expected, candidate: candidateTuple('d') }, f.expected.candidate.executableSha256, 'win32').attempts.length, 1)
  rmSync(directory, { recursive: true })
  for (const platform of ['linux', 'darwin']) {
    f.prior.application.platform = platform; f.save()
    assert.throws(() => validateResume(f.output, f.expected, undefined, platform), /lacks the candidate identity tuple/)
  }
  // A tuple can never appear on schema 1, nor be absent on the current schema.
  f.prior.application.platform = 'win32'; f.prior.schema = EVIDENCE_SCHEMA; f.save()
  assert.throws(() => validateResume(f.output, f.expected, undefined, 'win32'), /lacks a candidate identity/)
  assert.throws(() => recordedCandidate({ schema: 1, candidate: f.expected.candidate, executableSha256: 'a'.repeat(64) }, 'win32'), /schema/)
  assert.throws(() => recordedCandidate({ schema: EVIDENCE_SCHEMA, candidate: { ...f.expected.candidate, executableSha256: 'd'.repeat(64) },
    executableSha256: 'a'.repeat(64) }, 'linux'), /inconsistent/)
  assert.throws(() => recordedCandidate({ schema: EVIDENCE_SCHEMA, candidate: { executableSha256: 'a'.repeat(64) }, executableSha256: 'a'.repeat(64) }, 'linux'), /malformed/)
})

test('resume refuses wizard or retained evidence and a different recorded architecture before launch', t => {
  const f = fixture(t)
  for (const mode of ['wizard', 'retained']) {
    f.prior.mode = mode; f.save()
    assert.throws(() => validateResume(f.output, f.expected), /advanced-route/)
  }
  f.prior.mode = 'advanced'; f.prior.application.arch = process.arch === 'arm64' ? 'x64' : 'arm64'; f.save()
  assert.throws(() => validateResume(f.output, f.expected), /different architecture/)
  delete f.prior.application.arch; f.save()
  assert.throws(() => validateResume(f.output, f.expected), /different architecture/)
  f.prior.application.arch = 'arm64'; f.save()
  assert.equal(validateResume(f.output, f.expected, undefined, process.platform, 'arm64').prior.application.arch, 'arm64')
})

test('resume profile identity folds case on macOS and Windows but not Linux', t => {
  const f = fixture(t)
  f.prior.application.userData = join(f.output, 'PROFILE')
  for (const platform of ['darwin', 'win32']) {
    f.prior.application.platform = platform; f.save()
    assert.equal(validateResume(f.output, f.expected, undefined, platform).prior.application.userData, join(f.output, 'PROFILE'))
  }
  f.prior.application.platform = 'linux'; f.save()
  assert.throws(() => validateResume(f.output, f.expected, undefined, 'linux'), /profile identity/)
})


test('retained setup is explicit, source-bound and excludes installation/resume consent', () => {
  const base = [...args.slice(0, -1), '--retained-profile', 'retained', '--expected-source-commit', 'a'.repeat(40)]
  const parsed = parseArguments(base)
  assert.equal(parsed.expectedSourceCommit, 'a'.repeat(40)); assert.equal(parsed.resume, false)
  assert.ok(parsed.retainedProfile.endsWith('retained'))
  for (const extra of [['--resume'], ['--download-models'], ['--upgrade-from-executable-sha256', 'b'.repeat(64)]]) {
    assert.throws(() => parseArguments([...base, ...extra]), /excludes/)
  }
  assert.throws(() => parseArguments(base.slice(0, -2)), /full expected source/)
  assert.throws(() => parseArguments([...base.slice(0, -1), '150ae52']), /full expected source/)
  assert.throws(() => parseArguments([...args, '--expected-source-commit', 'a'.repeat(40)]), /requires retained/)
})

test('candidate identity binds receipt and native provenance, not only unchanged executable', t => {
  const root = mkdtempSync(join(tmpdir(), 'retained-candidate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'resources', 'native'), { recursive: true })
  const expected = 'a'.repeat(40), runtimeId = 'b'.repeat(64)
  const provenance = { sourceCommit: expected, sourceDirty: false, sourceExport: false }
  const receipt = { identity: { sourceCommit: expected, nativeRuntimeId: runtimeId } }
  const save = () => {
    writeFileSync(join(root, 'resources', 'native', 'provenance.json'), JSON.stringify(provenance))
    writeFileSync(join(root, 'resources', 'release-receipt.json'), JSON.stringify(receipt))
  }
  writeFileSync(join(root, 'resources', 'native', 'manifest.json'), JSON.stringify({ runtimeId }))
  writeFileSync(join(root, 'resources', 'app.asar'), 'application archive')
  save()
  const result = validateRetainedCandidate(join(root, 'app.exe'), expected)
  assert.equal(result.applicationArchiveSha256, hash('application archive'))
  provenance.sourceCommit = 'c'.repeat(40); save()
  assert.throws(() => validateRetainedCandidate(join(root, 'app.exe'), expected), /Native source/)
  provenance.sourceCommit = expected; receipt.identity.sourceCommit = 'c'.repeat(40); save()
  assert.throws(() => validateRetainedCandidate(join(root, 'app.exe'), expected), /Release source/)
  receipt.identity.sourceCommit = expected; receipt.identity.nativeRuntimeId = 'd'.repeat(64); save()
  assert.throws(() => validateRetainedCandidate(join(root, 'app.exe'), expected), /Native release/)
  receipt.identity.nativeRuntimeId = runtimeId; provenance.sourceDirty = true; save()
  assert.throws(() => validateRetainedCandidate(join(root, 'app.exe'), expected), /clean/)
})

test('retained profile excludes linked storage and overlapping evidence', t => {
  const f = fixture(t), profile = join(f.output, 'profile')
  validateRetainedProfile(profile, join(f.root, 'new-evidence'))
  for (const output of [profile, join(profile, 'evidence'), f.output]) {
    assert.throws(() => validateRetainedProfile(profile, output), /separate directories/)
  }
  const link = join(f.root, 'linked-profile')
  symlinkSync(profile, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => validateRetainedProfile(link, join(f.root, 'new-evidence')), /physical/)
})

test('macOS retained profile containment cannot be bypassed by letter case', t => {
  const f = fixture(t), profile = join(f.output, 'profile')
  // On a case-folding volume these name the profile itself and the directory
  // that contains it. Parents must exist physically, so they are built from
  // existing directories.
  for (const output of [join(f.output, 'PROFILE'), join(f.root, 'EVIDENCE'), join(f.root, 'Evidence')]) {
    assert.throws(() => validateRetainedProfile(profile, output, 'darwin'), /separate directories/)
  }
  validateRetainedProfile(profile, join(f.root, 'new-evidence'), 'darwin')
  if (process.platform === 'linux') {
    // Linux keeps case-distinct names distinct.
    validateRetainedProfile(profile, join(f.output, 'PROFILE'), 'linux')
  }
})

test('evidence output is created only beneath a physical parent and never adopted', t => {
  const f = fixture(t)
  assertPhysicalOutputParent(join(f.root, 'new-evidence'))
  assert.throws(() => assertPhysicalOutputParent(f.output), /already exist/)
  assert.throws(() => assertPhysicalOutputParent(join(f.root, 'missing', 'evidence')), /ENOENT/)
  const link = join(f.root, 'linked-parent')
  symlinkSync(f.output, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertPhysicalOutputParent(join(link, 'evidence')), /physical/)
})

test('candidate identity hashes executable, archive, native manifest/provenance and optional receipt', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-identity-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const build = (directory, receipt) => {
    mkdirSync(join(directory, 'resources', 'native'), { recursive: true })
    writeFileSync(join(directory, 'Singhouse'), 'stock electron')
    writeFileSync(join(directory, 'resources', 'app.asar'), `archive ${directory}`)
    writeFileSync(join(directory, 'resources', 'native', 'manifest.json'), '{"runtimeId":"x"}')
    writeFileSync(join(directory, 'resources', 'native', 'provenance.json'), '{"sourceCommit":"y"}')
    if (receipt) writeFileSync(join(directory, 'resources', 'release-receipt.json'), receipt)
    return candidateIdentity(join(directory, 'Singhouse'), 'linux')
  }
  const first = build(join(root, 'one'), '{"r":1}'), second = build(join(root, 'two'))
  assert.deepEqual(Object.keys(first), CANDIDATE_KEYS)
  assert.equal(first.executableSha256, hash('stock electron'))
  // Identical stock executables; the archive distinguishes the builds.
  assert.equal(first.executableSha256, second.executableSha256)
  assert.notEqual(first.applicationArchiveSha256, second.applicationArchiveSha256)
  assert.equal(first.releaseReceiptSha256, hash('{"r":1}')); assert.equal(second.releaseReceiptSha256, null)
  assert.equal(first.nativeManifestSha256, hash('{"runtimeId":"x"}')); assert.equal(first.nativeProvenanceSha256, hash('{"sourceCommit":"y"}'))
  const contents = join(root, 'Singhouse.app', 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true }); mkdirSync(join(contents, 'Resources', 'native'), { recursive: true })
  writeFileSync(join(contents, 'MacOS', 'Singhouse'), 'mac launcher'); writeFileSync(join(contents, 'Resources', 'app.asar'), 'mac archive')
  writeFileSync(join(contents, 'Resources', 'native', 'manifest.json'), '{}'); writeFileSync(join(contents, 'Resources', 'native', 'provenance.json'), '{}')
  const mac = candidateIdentity(join(contents, 'MacOS', 'Singhouse'), 'darwin')
  assert.equal(mac.applicationArchiveSha256, hash('mac archive')); assert.equal(mac.releaseReceiptSha256, null)
  rmSync(join(root, 'two', 'resources', 'app.asar'))
  assert.throws(() => candidateIdentity(join(root, 'two', 'Singhouse'), 'linux'), /ENOENT/)
})

test('executable identity limitation is stated for each platform', () => {
  assert.match(executableIdentityLimitation('linux'), /stock Electron binary on Linux and is identical across builds/)
  assert.match(executableIdentityLimitation('darwin'), /does not identify the application archive/)
  assert.match(executableIdentityLimitation('win32'), /does not by itself identify the application archive/)
  assert.throws(() => executableIdentityLimitation('aix'), /Unsupported/)
})

test('harness identity hashes every local file the harness loads', () => {
  const desktop = fileURLToPath(new URL('../', import.meta.url)), identity = harnessIdentity()
  assert.deepEqual(Object.keys(identity.files), [...HARNESS_FILES])
  for (const [file, digest] of Object.entries(identity.files)) assert.equal(digest, hash(readFileSync(join(desktop, file))))
  // Closure: every relative import or URL reference of a listed module is listed.
  for (const file of HARNESS_FILES.filter(file => file.endsWith('.mjs'))) {
    const source = readFileSync(join(desktop, file), 'utf8')
    const references = [...source.matchAll(/from '(\.{1,2}\/[^']+)'|import\('(\.{1,2}\/[^']+)'\)|new URL\('(\.{1,2}\/[^']+)', import\.meta\.url\)/gu)]
      .map(match => match[1] ?? match[2] ?? match[3]).filter(reference => !reference.endsWith('/'))
    for (const reference of references) {
      const resolved = relative(desktop, join(desktop, dirname(file), reference)).split(sep).join('/')
      assert.ok(HARNESS_FILES.includes(resolved), `${file} loads unlisted ${resolved}`)
    }
  }
})

test('extra CA input is a small PEM certificate bundle with no private key', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'extra-ca-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pem = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0Fy\n-----END CERTIFICATE-----\n'
  writeFileSync(join(root, 'ca.pem'), pem + pem)
  assert.deepEqual(extraCaCertificate(join(root, 'ca.pem')), { path: join(root, 'ca.pem'), sha256: hash(pem + pem), certificates: 2 })
  writeFileSync(join(root, 'key.pem'), `${pem}-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n`)
  assert.throws(() => extraCaCertificate(join(root, 'key.pem')), /private key/)
  writeFileSync(join(root, 'junk.pem'), `${pem}trailing text`)
  assert.throws(() => extraCaCertificate(join(root, 'junk.pem')), /only PEM certificates/)
  writeFileSync(join(root, 'empty.pem'), 'not a certificate')
  assert.throws(() => extraCaCertificate(join(root, 'empty.pem')), /PEM certificates/)
  symlinkSync(join(root, 'ca.pem'), join(root, 'link.pem'))
  assert.throws(() => extraCaCertificate(join(root, 'link.pem')), /regular file/)
  assert.throws(() => extraCaCertificate('ca.pem'), /absolute/)
})

test('wizard mode is exclusive, fresh-profile only, and requires the expected runtime lock', () => {
  const lock = 'A'.repeat(64)
  const base = ['--executable', 'app', '--audio', 'audio.wav', '--output', 'evidence', '--wizard', '--expected-runtime-lock-sha256', lock]
  const parsed = parseArguments(base)
  assert.equal(parsed.mode, 'wizard'); assert.equal(parsed.expectedRuntimeLockSha256, 'a'.repeat(64))
  assert.equal(parsed.interruptRuntimeRetrieval, false); assert.equal(parsed.resume, false); assert.equal(parsed.manifest, undefined)
  assert.equal(parseArguments([...base, '--interrupt-runtime-retrieval']).interruptRuntimeRetrieval, true)
  assert.ok(parseArguments([...base, '--extra-ca-cert', 'ca.pem']).extraCaCert.endsWith('ca.pem'))
  for (const extra of [['--runtime-manifest', 'm.json'], ['--download-models'], ['--retained-profile', 'p'], ['--resume'],
    ['--upgrade-from-executable-sha256', 'b'.repeat(64)], ['--expected-source-commit', 'c'.repeat(40)]]) {
    assert.throws(() => parseArguments([...base, ...extra]), /Wizard mode excludes/)
  }
  assert.throws(() => parseArguments(base.slice(0, -2)), /expected-runtime-lock/)
  assert.throws(() => parseArguments([...base.slice(0, -1), 'abc']), /64 hex/)
  assert.throws(() => parseArguments([...base, '--wizard']), /Duplicate --wizard/)
  assert.throws(() => parseArguments([...args, '--interrupt-runtime-retrieval']), /requires --wizard/)
  assert.throws(() => parseArguments([...args, '--expected-runtime-lock-sha256', 'a'.repeat(64)]), /requires --wizard/)
  assert.throws(() => parseArguments(args.filter((_, i) => i !== 2 && i !== 3)), /Missing --runtime-manifest/)
  assert.equal(parseArguments(args).mode, 'advanced')
  assert.equal(parseArguments([...args.slice(0, -1), '--retained-profile', 'p', '--expected-source-commit', 'a'.repeat(40)]).mode, 'retained')
})

test('fresh inference cannot adopt an existing song or job', () => {
  validateFreshSubmission({ song_id: 2, job_id: 'new' }, [1], ['old'])
  assert.throws(() => validateFreshSubmission({ song_id: 1, job_id: 'new' }, [1], ['old']), /existing song/)
  assert.throws(() => validateFreshSubmission({ song_id: 2, job_id: 'old' }, [1], ['old']), /existing job/)
  assert.throws(() => validateFreshSubmission({ song_id: null, job_id: 'new' }, [], []), /song identity/)
  assert.throws(() => validateFreshSubmission({ song_id: 2, job_id: '' }, [], []), /job identity/)
})


test('read-only prelaunch gate rejects queued and expired-running orphan jobs', t => {
  const root = mkdtempSync(join(tmpdir(), 'retained-db-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const database = join(root, 'desktop.db'), python = process.env.KARAOKE_DESKTOP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const setup = `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE songs(id INTEGER,status TEXT)');c.execute('CREATE TABLE jobs(id TEXT,status TEXT,lease_expires_at TEXT)');c.execute("INSERT INTO songs VALUES(1,'ready')");c.execute("INSERT INTO jobs VALUES('orphan','done','2000-01-01')");c.commit();c.close()`
  execFileSync(python, ['-I', '-B', '-c', setup, database])
  const baseline = retainedDatabaseSnapshot(python, database, true), before = readFileSync(database)
  assert.equal(auditRetainedDatabase(baseline, baseline).status, 'passed')
  assert.deepEqual(readFileSync(database), before)
  for (const status of ['queued', 'running']) {
    execFileSync(python, ['-I', '-B', '-c', "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE jobs SET status=?',(sys.argv[2],));c.commit();c.close()", database, status])
    let launches = 0
    const launchAfterGate = () => { retainedDatabaseSnapshot(python, database, true); launches++ }
    assert.throws(launchAfterGate, /nonterminal jobs/); assert.equal(launches, 0)
  }
  execFileSync(python, ['-I', '-B', '-c', "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE jobs SET status='done'\");c.execute(\"UPDATE songs SET status='processing'\");c.commit();c.close()", database])
  assert.throws(() => retainedDatabaseSnapshot(python, database, true), /nonterminal songs/)
  writeFileSync(database + '-wal', 'uncheckpointed')
  assert.throws(() => retainedDatabaseSnapshot(python, database), /nonempty WAL/)
})

test('preservation audit permits new records but rejects changed or missing original rows', () => {
  const baseline = { songs: [{ id: 1, sha256: 'original' }], jobs: [{ id: 'old', sha256: 'original' }] }
  assert.equal(auditRetainedDatabase(baseline, { songs: [...baseline.songs, { id: 2, sha256: 'new' }], jobs: baseline.jobs }).status, 'passed')
  assert.throws(() => auditRetainedDatabase(baseline, { songs: [], jobs: baseline.jobs }), /disappeared/)
  assert.throws(() => auditRetainedDatabase(baseline, { songs: baseline.songs, jobs: [{ id: 'old', sha256: 'changed' }] }), /changed/)
})

test('resume evidence binds to the platform that recorded it', t => {
  const f = fixture(t)
  for (const recorded of ['win32', 'darwin', 'linux']) {
    f.prior.application.platform = recorded; f.save()
    for (const current of ['win32', 'darwin', 'linux']) {
      if (recorded === current) assert.equal(validateResume(f.output, f.expected, undefined, current).prior.application.platform, recorded)
      else assert.throws(() => validateResume(f.output, f.expected, undefined, current), /different platform/)
    }
  }
  delete f.prior.application.platform; f.save()
  assert.throws(() => validateResume(f.output, f.expected), /different platform/)
  assert.throws(() => validateResume(f.output, f.expected, undefined, 'freebsd'), /Unsupported/)
})

test('relaunch after resume refuses another platform, architecture or profile', () => {
  const prior = { platform: 'darwin', arch: 'arm64', userData: '/Users/op/evidence/profile' }
  validateResumedApplication(prior, { ...prior, packaged: true }, 'darwin')
  assert.throws(() => validateResumedApplication(prior, { ...prior, platform: 'linux' }, 'darwin'), /different platform/)
  assert.throws(() => validateResumedApplication(prior, { ...prior, arch: 'x64' }, 'darwin'), /different architecture/)
  assert.throws(() => validateResumedApplication(prior, { ...prior, userData: '/Users/op/other/profile' }, 'darwin'), /different profile/)
  // The default macOS volume folds case; the same comparison on Linux does not.
  validateResumedApplication(prior, { ...prior, userData: '/Users/op/evidence/Profile' }, 'darwin')
  const linux = { ...prior, platform: 'linux', userData: '/home/op/evidence/profile' }
  assert.throws(() => validateResumedApplication(linux, { ...linux, userData: '/home/op/evidence/Profile' }, 'linux'), /different profile/)
  assert.throws(() => validateResumedApplication(linux, { ...linux, userData: undefined }, 'linux'), /different profile/)
})

test('harness and application architecture must agree; the application identity is authoritative', () => {
  const harness = { platform: 'darwin', arch: 'arm64' }
  validateHarnessArchitecture(harness, { platform: 'darwin', arch: 'arm64' })
  // An x64 Node under translation would observe and record a different target.
  assert.throws(() => validateHarnessArchitecture({ platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' }), /architecture \(arm64\) differs from the harness Node \(x64\)/)
  assert.throws(() => validateHarnessArchitecture(harness, { platform: 'linux', arch: 'arm64' }), /platform differs/)
})

test('Linux resume does not accept a profile that differs only in case', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t)
  f.prior.application.userData = join(f.output, 'Profile'); f.save()
  assert.throws(() => validateResume(f.output, f.expected), /profile identity/)
  mkdirSync(join(f.output, 'Profile'))
  assert.throws(() => validateResume(f.output, f.expected), /profile identity/)
})

test('launch environment is allowlisted per platform and keeps the profile isolated', () => {
  const source = { PATH: '/bin', Path: 'C:\\bin', HOME: '/home/op', USERPROFILE: 'C:\\Users\\op', APPDATA: 'C:\\Users\\op\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', TMPDIR: '/tmp/op', LANG: 'en_US.UTF-8', LC_ALL: 'C',
    DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/run/user/1000/xauth', XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_CONFIG_HOME: '/home/op/.config', XDG_DATA_HOME: '/home/op/.local/share', XDG_CACHE_HOME: '/home/op/.cache',
    ELECTRON_RUN_AS_NODE: '1', ELECTRON_EXTRA_LAUNCH_ARGS: '--no-sandbox', NODE_OPTIONS: '--require x', LD_PRELOAD: '/x.so', LD_LIBRARY_PATH: '/x',
    DYLD_INSERT_LIBRARIES: '/x.dylib', DYLD_LIBRARY_PATH: '/x', KARAOKE_DESKTOP_PYTHON: '/usr/bin/python3', MODAL_TOKEN_ID: 'secret',
    PYTHONPATH: '/x', HF_HOME: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', SINGHOUSE_RECOVERY_ANCHOR: '1' }
  const keys = platform => Object.keys(applicationEnvironment(source, platform, '/evidence')).sort()
  assert.deepEqual(keys('win32'), ['APPDATA', 'DISPLAY', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'PATH', 'Path', 'SystemRoot', 'TEMP', 'TMPDIR',
    'USERPROFILE', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR'])
  assert.deepEqual(keys('darwin'), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME'])
  // Half a Wayland session description is never passed.
  assert.deepEqual(keys('linux'), ['DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XAUTHORITY', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR'])
  assert.deepEqual(Object.keys(applicationEnvironment({ ...source, XDG_SESSION_TYPE: 'wayland' }, 'linux', '/evidence')).sort(),
    ['DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE'])
  assert.deepEqual(Object.keys(applicationEnvironment({ PATH: '/bin', DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, 'linux', '/evidence')).sort(),
    ['DISPLAY', 'PATH', 'XDG_CONFIG_HOME'])
  // Inherited trust overrides never pass; an explicit CA path is the only source.
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(applicationEnvironment({ ...source, NODE_EXTRA_CA_CERTS: '/inherited.pem', SSL_CERT_FILE: '/x', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, platform, '/evidence').NODE_EXTRA_CA_CERTS, undefined)
    const env = applicationEnvironment(source, platform, '/evidence', { extraCaCertificate: '/operator/ca.pem' })
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/operator/ca.pem'); assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined)
  }
  assert.throws(() => applicationEnvironment(source, 'linux', '/evidence', { extraCaCertificate: 'relative.pem' }), /absolute/)
  for (const platform of ['win32', 'darwin', 'linux']) {
    const env = applicationEnvironment(source, platform, '/evidence')
    assert.equal(env.XDG_CONFIG_HOME, '/evidence')
    if (platform !== 'win32') assert.equal(env.HOME, '/home/op')
  }
  assert.deepEqual(applicationEnvironment({ HOME: undefined, PATH: '/bin' }, 'linux', '/evidence'), { PATH: '/bin', XDG_CONFIG_HOME: '/evidence' })
  assert.throws(() => applicationEnvironment(source, 'freebsd', '/evidence'), /Unsupported/)
})

test('shutdown keeps the Windows owned-child close and observes POSIX process trees', () => {
  assert.equal(shutdownStrategy('win32'), 'owned-child')
  assert.equal(shutdownStrategy('darwin'), 'owned-process-tree')
  assert.equal(shutdownStrategy('linux'), 'owned-process-tree')
  assert.throws(() => shutdownStrategy('sunos'), /Unsupported/)
})

test('retained candidate identity reads macOS bundle resources', t => {
  const root = mkdtempSync(join(tmpdir(), 'retained-mac-candidate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contents = join(root, 'Test Singhouse.app', 'Contents'), expected = 'a'.repeat(40), runtimeId = 'b'.repeat(64)
  mkdirSync(join(contents, 'MacOS'), { recursive: true }); mkdirSync(join(contents, 'Resources', 'native'), { recursive: true })
  writeFileSync(join(contents, 'Resources', 'native', 'provenance.json'), JSON.stringify({ sourceCommit: expected, sourceDirty: false, sourceExport: false }))
  writeFileSync(join(contents, 'Resources', 'native', 'manifest.json'), JSON.stringify({ runtimeId }))
  writeFileSync(join(contents, 'Resources', 'app.asar'), 'bundle archive')
  const executable = join(contents, 'MacOS', 'Singhouse')
  // Signed bundles keep the receipt outside the sealed bundle; retained mode refuses them.
  assert.throws(() => validateRetainedCandidate(executable, expected, 'darwin'), /ENOENT/)
  writeFileSync(join(contents, 'Resources', 'release-receipt.json'), JSON.stringify({ identity: { sourceCommit: expected, nativeRuntimeId: runtimeId } }))
  assert.equal(validateRetainedCandidate(executable, expected, 'darwin').applicationArchiveSha256, hash('bundle archive'))
  assert.throws(() => validateRetainedCandidate(join(root, 'Singhouse'), expected, 'darwin'), /MacOS/)
})
