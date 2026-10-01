// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseArguments, reusableRuntime, validateResume, validateRetainedCandidate, validateRetainedProfile, validateFreshSubmission, retainedDatabaseSnapshot, auditRetainedDatabase,
  applicationEnvironment, shutdownStrategy, validateResumedApplication } from './packaged-processing-smoke.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const args = ['--executable', 'app.exe', '--runtime-manifest', 'manifest.json', '--audio', 'audio.wav', '--output', 'evidence', '--download-models']
test('resume is explicit and retains model retrieval consent requirement', () => {
  assert.equal(parseArguments(args).resume, false)
  assert.equal(parseArguments([...args, '--resume']).resume, true)
  assert.throws(() => parseArguments([...args, '--resume', '--resume']), /Duplicate/)
  assert.throws(() => parseArguments([...args.slice(0, -1), '--resume']), /consent/)
})

function fixture(t) {
  // Physical root: macOS temporary directories are reached through /var links.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'processing-resume-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const output = join(root, 'evidence'); mkdirSync(output); mkdirSync(join(output, 'profile'))
  const expected = { executableSha256: 'a'.repeat(64), runtimeManifestSha256: 'b'.repeat(64), input: { sha256: 'c'.repeat(64), bytes: 123 } }
  const prior = { schema: 1, kind: 'packaged-local-processing-smoke', status: 'running', ...expected,
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

test('executable upgrade requires explicit resume and a full original hash', () => {
  const flag = '--upgrade-from-executable-sha256', digest = 'a'.repeat(64)
  assert.throws(() => parseArguments([...args, flag, digest]), /requires --resume/)
  assert.throws(() => parseArguments([...args, '--resume', flag, 'abc']), /64 hex/)
  assert.equal(parseArguments([...args, '--resume', flag, digest.toUpperCase()]).upgradeFromExecutableSha256, digest)
})

test('explicit upgrade preserves original evidence and binds original and current hashes', t => {
  const f = fixture(t), original = readFileSync(join(f.output, 'evidence.json'))
  const current = { ...f.expected, executableSha256: 'd'.repeat(64) }
  assert.throws(() => validateResume(f.output, current), /executable changed/)
  const result = validateResume(f.output, current, f.expected.executableSha256)
  assert.deepEqual(result.upgrade, { fromExecutableSha256: f.expected.executableSha256,
    toExecutableSha256: current.executableSha256,
    qualification: 'Application upgrade with retained setup; not clean-install proof' })
  assert.deepEqual(readFileSync(join(f.output, 'evidence.json')), original)
  assert.throws(() => validateResume(f.output, f.expected, f.expected.executableSha256), /must change/)
  assert.throws(() => validateResume(f.output, current, 'e'.repeat(64)), /executable changed|does not match/)
})

test('upgrade retries require every prior candidate to have explicit matching lineage', t => {
  const f = fixture(t), current = { ...f.expected, executableSha256: 'd'.repeat(64) }
  const result = validateResume(f.output, current, f.expected.executableSha256)
  const directory = join(f.output, 'resume-first'); mkdirSync(directory)
  const attempt = { ...f.prior, resume: { priorEvidence: '../evidence.json', priorEvidenceSha256: result.sha256 } }
  const save = () => writeFileSync(join(directory, 'evidence.json'), JSON.stringify(attempt))
  save(); assert.equal(validateResume(f.output, current, f.expected.executableSha256).attempts.length, 1)
  attempt.executableSha256 = current.executableSha256; save()
  assert.throws(() => validateResume(f.output, current, f.expected.executableSha256), /matching upgrade lineage/)
  attempt.upgrade = result.upgrade; save()
  assert.equal(validateResume(f.output, current, f.expected.executableSha256).attempts.length, 1)
  attempt.upgrade = { ...result.upgrade, fromExecutableSha256: 'e'.repeat(64) }; save()
  assert.throws(() => validateResume(f.output, current, f.expected.executableSha256), /matching upgrade lineage/)
  attempt.executableSha256 = 'e'.repeat(64); save()
  assert.throws(() => validateResume(f.output, current, f.expected.executableSha256), /executable changed/)
  attempt.executableSha256 = current.executableSha256; attempt.upgrade = result.upgrade; attempt.inferenceStartedAt = 'recorded'; save()
  assert.throws(() => validateResume(f.output, current, f.expected.executableSha256), /installation interruptions only/)
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
  validateResumedApplication(prior, { ...prior, packaged: true })
  assert.throws(() => validateResumedApplication(prior, { ...prior, platform: 'linux' }), /different platform/)
  assert.throws(() => validateResumedApplication(prior, { ...prior, arch: 'x64' }), /different architecture/)
  assert.throws(() => validateResumedApplication(prior, { ...prior, userData: '/Users/op/evidence/Profile' }))
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
  assert.deepEqual(keys('linux'), ['DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR'])
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
