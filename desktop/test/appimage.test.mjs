// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

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
