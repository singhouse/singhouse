// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { canonicalJson, deriveReleaseIdentity, sha256Hex, validateInstalledReleaseReceipt } from '../release.mjs'
import { appImageSnapshot, assertAppImageSnapshot, extractAppImage, parseAppImageListing, prepareAppImageApplication, publishAppImageArtifact, verifyAppImageApplication } from '../build/appimage.mjs'

const require = createRequire(import.meta.url)
const desktop = fileURLToPath(new URL('../', import.meta.url))
const wrapper = resolve(desktop, 'build/apprun.sh')

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'appimage-sandbox-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('AppRun preserves arguments, sandbox enforcement, exit status, and runtime ancestry', { skip: process.platform !== 'linux' }, async t => {
  const root = await fixture(t)
  await copyFile(wrapper, resolve(root, 'AppRun'))
  await writeFile(resolve(root, 'Singhouse'), '#!/bin/sh\nprintf "%s\\n" "$PPID" "$@"\nexit 37\n', { mode: 0o755 })
  // A failing/missing unshare must never select an unsafe fallback. The actual
  // Electron process remains responsible for testing usable sandbox facilities.
  await writeFile(resolve(root, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  for (const path of [root, '/nonexistent']) {
    const result = spawnSync(resolve(root, 'AppRun'), ['--recovery-anchor', 'a path with spaces', '"literal"'], {
      encoding: 'utf8', env: { ...process.env, APPDIR: '/incorrect-inherited-location', PATH: `${path}:/usr/bin:/bin` },
    })
    assert.equal(result.status, 37, result.stderr)
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [String(process.pid), '--recovery-anchor', 'a path with spaces', '"literal"'])
  }
  for (const flag of ['--no-sandbox', '--no-sandbox=true', '--disable-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox', '--single-process', '--in-process-gpu']) {
    const result = spawnSync(resolve(root, 'AppRun'), [flag], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /requires Electron sandboxing/)
  }
})

test('pinned builder stages the configured receipt-bound AppRun and safe desktop entry for both AppImage toolsets', async t => {
  // The dependency-free runtime CI does not install packaging dependencies.
  // Packaging qualification must set this variable to forbid a vacuous skip.
  try { require.resolve('app-builder-lib') }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || process.env.SINGHOUSE_REQUIRE_BUILDER_TESTS === '1') throw error
    t.skip('Install desktop build dependencies to exercise actual AppImage staging')
    return
  }
  if (process.platform === 'win32') {
    t.skip('Linux staging fixture requires symlink creation without Windows privileges')
    return
  }
  const builder = require('builder-util')
  const toolsets = require('app-builder-lib/out/toolsets/linux.js')
  const { default: AppImageTarget } = require('app-builder-lib/out/targets/appimage/AppImageTarget.js')
  const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper.js')
  const { buildLegacyFuse2AppImage, buildStaticRuntimeAppImage } = require('app-builder-lib/out/targets/appimage/appImageUtil.js')
  const root = await fixture(t)
  const native = resolve(root, 'native')
  await mkdir(native)
  const pkg = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'))
  await writeFile(resolve(native, 'manifest.json'), JSON.stringify({ appVersion: pkg.version }))
  await writeFile(resolve(native, 'assembly.json'), JSON.stringify({ schema: 1, kind: 'singhouse-assembly', edition: 'core' }))
  await writeFile(resolve(native, 'backend.py'), '# fixture\n')
  for (const name of ['models.json', 'processing-locks.json']) await copyFile(resolve(desktop, name), resolve(native, name))
  const previous = process.env.KARAOKE_NATIVE_PAYLOAD
  process.env.KARAOKE_NATIVE_PAYLOAD = native
  let config
  try { ({ default: config } = await import(`../build/installer.mjs?appimage=${Date.now()}`)) }
  finally {
    if (previous === undefined) delete process.env.KARAOKE_NATIVE_PAYLOAD
    else process.env.KARAOKE_NATIVE_PAYLOAD = previous
  }
  const appDir = resolve(root, 'app')
  await mkdir(appDir)
  // Use the real configuration's extraFiles, not a second test-only launcher.
  for (const file of config.linux.extraFiles) await copyFile(file.from, resolve(appDir, file.to))
  const libraries = resolve(root, 'libraries')
  await mkdir(libraries)
  const runtime = resolve(root, 'runtime')
  await writeFile(runtime, 'fixture-runtime')
  t.mock.method(toolsets, 'getAppImageTools', async () => ({ runtime, runtimeLibraries: libraries, mksquashfs: 'fixture-mksquashfs' }))
  t.mock.method(builder.log, 'error', () => {})
  const stopBeforeNativeBuild = new Error('fixture stops before native compression')
  let staged = 0
  t.mock.method(builder, 'exec', async (command, args) => {
    assert.equal(command, 'fixture-mksquashfs')
    const stage = args[0]
    assert.equal(await readFile(resolve(stage, 'AppRun'), 'utf8'), await readFile(wrapper, 'utf8'))
    assert.ok((await stat(resolve(stage, 'AppRun'))).mode & 0o111)
    assert.match(await readFile(resolve(stage, 'Singhouse.desktop'), 'utf8'), /^Exec=AppRun %U$/m)
    staged++
    throw stopBeforeNativeBuild
  })
  for (const toolset of ['0.0.0', '1.0.0']) {
    const stageDir = resolve(root, `stage-${toolset}`)
    await mkdir(stageDir)
    const packager = {
      config: { ...config, toolsets: { appimage: toolset } }, platformSpecificBuildOptions: config.linux,
      executableName: config.executableName, fileAssociations: [],
      appInfo: { productName: config.productName, productFilename: config.productName, buildVersion: pkg.version, description: pkg.description },
      info: { metadata: pkg },
    }
    const helper = new LinuxTargetHelper(packager)
    const target = new AppImageTarget('AppImage', packager, helper, root)
    const desktopEntry = await target.desktopEntry.value
    assert.match(desktopEntry, /^Exec=AppRun %U$/m)
    const opts = { appDir, stageDir, arch: builder.Arch.x64, output: resolve(root, `${toolset}.AppImage`), options: {
      productName: config.productName, productFilename: config.productName, executableName: config.executableName,
      desktopEntry, desktopBaseName: 'Singhouse', icons: [{ file: resolve(desktop, 'build/icons/linux/256x256.png'), size: 256 }],
    } }
    await assert.rejects(toolset === '0.0.0' ? buildLegacyFuse2AppImage(opts) : buildStaticRuntimeAppImage(toolset, opts), error => error === stopBeforeNativeBuild)
  }
  assert.equal(staged, 2)
})

const listingRoot = 'drwxr-xr-x 0/0 0 2026-01-01 00:00 squashfs-root'
const listingEntry = (path, mode = '-rw-r--r--') => `${mode} 0/0 0 2026-01-01 00:00 squashfs-root/${path}`

test('AppImage extraction preflight rejects traversal, linked parents, dangling/cyclic links, special modes and ambiguous output', () => {
  const valid = [listingRoot, listingEntry('file'), listingEntry('link -> file', 'lrwxrwxrwx')].join('\n')
  assert.equal(parseAppImageListing(valid).length, 2)
  for (const entries of [
    [listingEntry('../escape')], [listingEntry('/absolute')],
    [listingEntry('file'), listingEntry('file')],
    [listingEntry('link -> /etc/passwd', 'lrwxrwxrwx')],
    [listingEntry('link -> ../escape', 'lrwxrwxrwx')],
    [listingEntry('link -> absent', 'lrwxrwxrwx')],
    [listingEntry('a -> b', 'lrwxrwxrwx'), listingEntry('b -> a', 'lrwxrwxrwx')],
    [listingEntry('dir', 'drwxr-xr-x'), listingEntry('link -> dir', 'lrwxrwxrwx'), listingEntry('link/file')],
    [listingEntry('pipe', 'prw-r--r--')], [listingEntry('privileged', '-rwsr-xr-x')],
    [listingEntry('path\\name')], ['unexpected tool diagnostics'],
  ]) assert.throws(() => parseAppImageListing([listingRoot, ...entries].join('\n')))
})

test('AppImage verification rejects additions, removals, byte changes, symlink changes, and executable mode changes', () => {
  const expected = { files: [{ path: 'AppRun', type: 'file', sha256: 'a' }, { path: 'icon', type: 'symlink', target: 'AppRun' }], modes: { AppRun: 0o111 } }
  assertAppImageSnapshot(structuredClone(expected), expected)
  for (const change of [
    x => x.files.push({ path: 'late', type: 'file', sha256: 'a' }),
    x => x.files.pop(), x => { x.files[0].sha256 = 'b' },
    x => { x.files[1].target = 'other' }, x => { x.modes.AppRun = 0 },
  ]) {
    const actual = structuredClone(expected); change(actual)
    assert.throws(() => assertAppImageSnapshot(actual, expected))
  }
})

test('AppImage extraction fails before writes on missing tools, wrong runtime or unsafe listing', async t => {
  const root = await fixture(t), runtime = resolve(root, 'runtime'), image = resolve(root, 'image')
  await writeFile(runtime, 'runtime')
  await writeFile(image, 'runtimehsqsfixture')
  let extraction = false
  const run = async (_command, args) => {
    if (args[0] === '-version') return { stdout: 'unsquashfs version 4.7.5\n' }
    if (args[0] === '-lln') return { stdout: [listingRoot, listingEntry('../escape')].join('\n') }
    extraction = true; throw new Error('must not extract')
  }
  const options = { image, runtime, destination: resolve(root, 'extracted'), run }
  await assert.rejects(extractAppImage({ ...options, run: async () => { throw new Error('ENOENT') } }), /requires build-host unsquashfs/)
  await assert.rejects(extractAppImage(options), /Unsafe/)
  assert.equal(extraction, false)
  await assert.rejects(stat(options.destination), { code: 'ENOENT' })
  await writeFile(runtime, 'changed')
  await assert.rejects(extractAppImage(options), /runtime prefix/)
})

test('exclusive artifact publication preserves previous artifacts and copies verified bytes and permissions', async t => {
  const root = await fixture(t), output = resolve(root, 'output'), source = resolve(root, 'fixture.AppImage')
  await mkdir(output); await writeFile(source, 'verified', { mode: 0o755 })
  let destination
  const previousUmask = process.umask(0o077)
  try { destination = await publishAppImageArtifact(source, output) }
  finally { process.umask(previousUmask) }
  assert.equal(await readFile(destination, 'utf8'), 'verified')
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o755)
  await writeFile(source, 'replacement')
  await assert.rejects(publishAppImageArtifact(source, output), { code: 'EEXIST' })
  assert.equal(await readFile(destination, 'utf8'), 'verified')
  assert.deepEqual(await readdir(output), ['fixture.AppImage'])
})

test('two-stage fixture models actual SquashFS additions before receipt and rejects a later injected entry', { skip: process.platform !== 'linux' }, async t => {
  for (const tool of ['mksquashfs', 'unsquashfs']) {
    const probe = spawnSync(tool, ['-version'], { encoding: 'utf8' })
    if (probe.error?.code === 'ENOENT') {
      if (process.env.SINGHOUSE_REQUIRE_BUILDER_TESTS === '1') throw probe.error
      t.skip(`Install ${tool} to exercise bounded real SquashFS fixtures`); return
    }
    assert.ok([0, 1].includes(probe.status) && probe.stdout.startsWith(`${tool} version `), probe.stderr)
  }
  const root = await fixture(t), application = resolve(root, 'application'), runtime = resolve(root, 'runtime')
  await mkdir(application)
  await writeFile(resolve(application, 'AppRun'), 'fixture launcher', { mode: 0o755 })
  await mkdir(resolve(application, 'resources'))
  await writeFile(resolve(application, 'resources/app.asar'), 'fixture application')
  await writeFile(runtime, 'fixture-runtime-prefix')
  let lateEntry = false, escapingLink = false
  const buildImage = async (lean, output) => {
    const stage = resolve(output, 'stage')
    await cp(lean, stage, { recursive: true, verbatimSymlinks: true })
    await mkdir(resolve(stage, 'usr/lib'), { recursive: true })
    await writeFile(resolve(stage, 'usr/lib/fixture.so'), 'builder runtime library', { mode: 0o755 })
    await writeFile(resolve(stage, 'icon.png'), 'icon')
    await symlink('icon.png', resolve(stage, '.DirIcon'))
    await writeFile(resolve(stage, 'app.desktop'), '[Desktop Entry]\nExec=AppRun %U\n')
    if (lateEntry) await writeFile(resolve(stage, 'unexpected'), 'late injection')
    if (escapingLink) {
      await mkdir(resolve(stage, 'a/b'), { recursive: true })
      await mkdir(resolve(stage, 'target'))
      await writeFile(resolve(stage, 'a/outside'), 'misleading lexical target')
      await symlink('../../target', resolve(stage, 'a/b/alias'))
      await symlink('alias/../../outside', resolve(stage, 'a/b/link'))
    }
    const image = resolve(output, 'fixture.AppImage')
    const prefix = await readFile(runtime)
    const result = spawnSync('mksquashfs', [stage, image, '-offset', String(prefix.length), '-all-root', '-noappend', '-no-xattrs', '-no-progress', '-quiet', '-processors', '1'], { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stderr)
    const handle = await open(image, 'r+')
    try { await handle.write(prefix, 0, prefix.length, 0) } finally { await handle.close() }
    return image
  }
  const preparation = await prepareAppImageApplication({ applicationDirectory: application, runtime, buildImage })
  t.after(preparation.cleanup)
  const modeled = await appImageSnapshot(application)
  assert.ok(modeled.files.some(file => file.path === '.DirIcon' && file.type === 'symlink'))
  assert.ok(modeled.files.some(file => file.path === 'usr/lib/fixture.so'))
  await assert.rejects(stat(resolve(preparation.lean, '.DirIcon')), { code: 'ENOENT' })
  const H = 'a'.repeat(64), inventoryDigest = sha256Hex(canonicalJson(modeled.files))
  const identity = deriveReleaseIdentity({ schema: 1, appVersion: '1.0.0', edition: 'core', policyId: H,
    sourceCommit: 'b'.repeat(40), electronVersion: '44.3.0', electronRuntimeDigest: H, electronAppDigest: H,
    frontendDigest: H, backendDigest: H, nativeRuntimeId: H, runtimeLocksDigest: H, modelPolicyDigest: H,
    schemaHistory: 1, assemblyDigest: H, applicationInventoryDigest: inventoryDigest })
  const receipt = { schema: 1, kind: 'singhouse-release-receipt', identity, target: { platform: 'linux', arch: 'x64' },
    application: { schema: 1, entrypoint: 'AppRun', inventoryDigest, files: modeled.files } }
  for (const directory of [application, preparation.lean]) await writeFile(resolve(directory, 'resources/release-receipt.json'), canonicalJson(receipt))
  const observed = new Map((await appImageSnapshot(application)).files.map(file => [file.path,
    file.type === 'file' ? file.sha256 : file.type === 'directory' ? 'directory' : `symlink:${file.target}`]))
  assert.equal(validateInstalledReleaseReceipt(receipt, observed, receipt.target).releaseId, identity.releaseId)
  observed.set('late-wrapper-file', H)
  assert.throws(() => validateInstalledReleaseReceipt(receipt, observed, receipt.target), /unmodeled entry/)
  const expected = await appImageSnapshot(application)
  const output = resolve(root, 'final'); await mkdir(output)
  const final = await buildImage(preparation.lean, output)
  await verifyAppImageApplication({ image: final, runtime, expected })
  lateEntry = true
  const lateOutput = resolve(root, 'late'); await mkdir(lateOutput)
  const injected = await buildImage(preparation.lean, lateOutput)
  await assert.rejects(verifyAppImageApplication({ image: injected, runtime, expected }), /added or missing/)
  lateEntry = false; escapingLink = true
  const maliciousOutput = resolve(root, 'malicious'); await mkdir(maliciousOutput)
  const malicious = await buildImage(preparation.lean, maliciousOutput)
  await assert.rejects(verifyAppImageApplication({ image: malicious, runtime, expected }), /Noncanonical AppImage symlink: a\/b\/link/)
  await chmod(resolve(application, 'AppRun'), 0o644)
  assert.throws(() => assertAppImageSnapshot({ ...expected, modes: { ...expected.modes, AppRun: 0 } }, expected), /AppRun/)
})


test('raw symlink alias followed by parent traversal fails listing and physical snapshot validation', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), application = resolve(root, 'application')
  await mkdir(resolve(application, 'a/b'), { recursive: true })
  await mkdir(resolve(application, 'target'))
  await writeFile(resolve(application, 'a/outside'), 'lexical target')
  await writeFile(resolve(root, 'outside'), 'external target')
  await symlink('../../target', resolve(application, 'a/b/alias'))
  // Leading parents alone are legitimate and remain supported.
  assert.ok((await appImageSnapshot(application)).files.some(file => file.path === 'a/b/alias'))
  await symlink('alias/../../outside', resolve(application, 'a/b/link'))
  assert.equal(await readFile(resolve(application, 'a/b/link'), 'utf8'), 'external target')
  await assert.rejects(appImageSnapshot(application), /Noncanonical AppImage symlink/)
  const entries = [listingRoot, listingEntry('a', 'drwxr-xr-x'), listingEntry('a/b', 'drwxr-xr-x'),
    listingEntry('a/outside'), listingEntry('target', 'drwxr-xr-x'),
    listingEntry('a/b/alias -> ../../target', 'lrwxrwxrwx'),
    listingEntry('a/b/link -> alias/../../outside', 'lrwxrwxrwx')]
  assert.throws(() => parseAppImageListing(entries.join('\n')), /Noncanonical AppImage symlink/)
})

test('interrupted artifact copy exposes no partial final name', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), output = resolve(root, 'output'), source = resolve(root, 'fixture.AppImage')
  await mkdir(output); await writeFile(source, 'source', { mode: 0o755 })
  const moduleUrl = new URL('../build/appimage.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    fs.createReadStream = async function* () {
      yield Buffer.from('partial fixture bytes')
      process.stdout.write('copy-paused\\n')
      await new Promise(() => setInterval(() => {}, 1000))
    }
    syncBuiltinESMExports()
    const { publishAppImageArtifact } = await import(${JSON.stringify(moduleUrl)})
    await publishAppImageArtifact(process.argv[1], process.argv[2])
  `, source, output], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  const exit = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture copy did not pause')), 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture exited before pausing')) })
    child.stdout.once('data', () => { clearTimeout(timer); resolveReady() })
  })
  await assert.rejects(stat(resolve(output, 'fixture.AppImage')), { code: 'ENOENT' })
  child.kill('SIGKILL')
  assert.equal((await exit).signal, 'SIGKILL')
  await assert.rejects(stat(resolve(output, 'fixture.AppImage')), { code: 'ENOENT' })
  assert.ok((await readdir(output)).every(name => name.startsWith('.appimage-publish-')))
})
