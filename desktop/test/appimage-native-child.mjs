// SPDX-License-Identifier: AGPL-3.0-only
// Launched only by appimage-native-smoke.mjs through a disposable real AppImage.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = (path, read = readFileSync) => createHash('sha256').update(read(path)).digest('hex')
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'))
assert.equal(realpathSync(request.output), request.output)
assert.equal(lstatSync(request.output).uid, process.getuid())
assert.equal(lstatSync(request.output).mode & 0o077, 0)
const report = { schema: 1, passed: false, checks: [], modules: {}, scope: 'anchor primitives only' }
const check = (name, evidence) => report.checks.push({ name, passed: true, evidence })
function identity(path, filesystem = { realpathSync, lstatSync, readFileSync }) {
  const canonicalPath = filesystem.realpathSync(path), info = filesystem.lstatSync(canonicalPath)
  return { path, canonicalPath, dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid, sha256: sha256(path, filesystem.readFileSync) }
}
try {
  assert.ok(process.versions.electron, 'Must run in packaged Electron, not system Node')
  assert.equal(realpathSync(process.execPath), process.execPath)
  const mount = dirname(process.execPath), asar = join(mount, 'resources', 'app.asar')
  const launcherPath = join(asar, 'recovery_launcher.mjs'), bootstrapPath = join(asar, 'bootstrap.mjs')
  // ASAR imports MUST work directly in this packaged runtime. Never import checkout or extracted substitutes.
  // Electron's patched fs treats app.asar as an archive directory. Read the physical
  // container with original-fs; archive members and imports retain ASAR-aware access.
  const physicalFs = createRequire(import.meta.url)('original-fs')
  assert.ok(physicalFs.lstatSync(asar).isFile(), 'Mounted ASAR container must be a physical file')
  report.modules = { launcher: identity(launcherPath), bootstrap: identity(bootstrapPath), asar: identity(asar, physicalFs) }
  const { verifiedAppImageRuntime, ensureRecoveryAnchor } = await import(pathToFileURL(launcherPath).href)
  const { verifyRecoveryAnchor } = await import(pathToFileURL(bootstrapPath).href)
  const runtime = verifiedAppImageRuntime()
  assert.equal(runtime.verified, true)
  assert.equal(runtime.outerPath, request.copied)
  assert.equal(runtime.outerSha256, request.originalSha256)
  assert.equal(runtime.mountPath, mount)
  report.runtime = runtime
  report.runtimeVersions = process.versions
  check('default native /proc ancestry and read-only FUSE verification', runtime)
  process.env.APPIMAGE = join(request.output, 'forged-image')
  process.env.APPDIR = join(request.output, 'forged-mount')
  assert.deepEqual(verifiedAppImageRuntime(), runtime)
  check('post-launch forged APPIMAGE and APPDIR ignored')
  const stateRoot = join(request.output, 'anchor-state')
  mkdirSync(stateRoot, { mode: 0o700 })
  const anchorPath = join(stateRoot, 'recovery-tool', 'anchor.json')
  const paths = { executablePath: runtime.outerPath, bootstrapPath,
    pythonPath: join(mount, 'resources', 'native', 'python', 'bin', 'python3'), helperPath: join(mount, 'resources', 'native', 'backend.py') }
  report.components = Object.fromEntries(Object.entries({ ...paths, actualExecutablePath: process.execPath }).map(([key, path]) => [key, identity(path)]))
  const expected = { ...paths, platform: process.platform, arch: process.arch }
  assert.throws(() => ensureRecoveryAnchor(anchorPath, expected, { verifiedAppImage: runtime }), /verified first installer/)
  check('anchor creation rejects missing first-installer authorization')
  const anchor = ensureRecoveryAnchor(anchorPath, expected, { verifiedFirstInstaller: true, verifiedAppImage: runtime })
  const before = readFileSync(anchorPath), invocation = join(dirname(anchorPath), 'invoke.sh'), beforeInvocation = readFileSync(invocation)
  check('anchor creation with actual mounted component bytes', anchor)
  const verification = { ...paths, verifiedAppImage: runtime }
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, verification), /platform signature is invalid/)
  check('production Linux default platform trust remains fail-closed')
  // Test-only integrity trust: freshly authenticate actual native ancestry and compare the operator-selected input SHA.
  // This does not establish publisher provenance or enable production updates.
  let trustCalls = 0
  const platformTrust = async candidate => {
    trustCalls += 1
    const fresh = verifiedAppImageRuntime()
    return fresh.outerPath === request.copied && fresh.outerSha256 === request.originalSha256 &&
      candidate.executablePath === fresh.outerPath && candidate.digests.executablePath === fresh.outerSha256
  }
  assert.deepEqual(await verifyRecoveryAnchor(anchorPath, { ...verification, platformTrust }), anchor)
  assert.equal(trustCalls, 1)
  check('anchor verification with fresh native evidence and selected input digest')
  const substitute = join(request.output, 'substituted-bootstrap.mjs')
  copyFileSync(bootstrapPath, substitute, 1)
  report.substitute = identity(substitute)
  assert.equal(report.substitute.sha256, report.components.bootstrapPath.sha256)
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, { ...verification, bootstrapPath: substitute, platformTrust }), /component layout/)
  assert.equal(trustCalls, 1, 'Substitution must fail before platform trust callback')
  assert.throws(() => ensureRecoveryAnchor(anchorPath, { ...expected, bootstrapPath: substitute },
    { verifiedFirstInstaller: true, verifiedAppImage: runtime }), /verified AppImage mount/)
  assert.deepEqual(readFileSync(anchorPath), before)
  assert.deepEqual(readFileSync(invocation), beforeInvocation)
  check('same-byte component substitution rejected; prior anchor and invocation unchanged')
  await assert.rejects(() => verifyRecoveryAnchor(anchorPath, { ...verification, verifiedAppImage: null, platformTrust }), /component layout/)
  assert.equal(trustCalls, 1)
  check('anchor verification rejects missing native runtime evidence')
  report.anchor = { ...identity(anchorPath), invocation: identity(invocation) }
  report.passed = true
} catch (error) {
  report.failure = error.stack
  process.exitCode = 1
} finally {
  writeFileSync(join(request.output, 'child-result.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}
