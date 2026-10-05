// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appImageNoticesDirectory } from './appimage_notices.mjs'
import { assertReleasePolicy } from '../release.mjs'
import { nativeExecutableSigningExclusions, windowsBuildConfiguration } from '../windows_signing.mjs'
import { PACKAGED_CATALOG_NAME, PLAYBACK_ONLY, PROCESSING_READY } from './processing_catalog_gate.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const icons = resolve(desktop, 'build/icons')
export const sourceRoot = resolve(desktop, '..')
const native = resolve(process.env.KARAOKE_NATIVE_PAYLOAD || resolve(desktop, 'native'))
export const releasePolicyPath = resolve(process.env.SINGHOUSE_RELEASE_POLICY || resolve(desktop, 'release.json'))
export const releasePolicy = assertReleasePolicy(JSON.parse(readFileSync(releasePolicyPath, 'utf8')))
const manifest = JSON.parse(readFileSync(resolve(native, 'manifest.json'), 'utf8'))
const assembly = JSON.parse(readFileSync(resolve(native, 'assembly.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(resolve(desktop, 'package.json'), 'utf8'))
const { BRAND_INSTALLED_NAME } = await import(pathToFileURL(resolve(desktop, '../frontend/src/brand.js')))
const signedRelease = process.argv.includes('--signed-release')
const manualAzureCli = process.argv.includes('--azure-cli-user')
const azureOidc = process.argv.includes('--azure-oidc')
if (manifest.appVersion !== pkg.version || !existsSync(resolve(native, 'backend.py'))) {
  throw new Error('Assemble a matching native runtime before creating an installer')
}
if (assembly.schema !== 1 || assembly.kind !== 'singhouse-assembly' || !['core', 'premium'].includes(assembly.edition)) throw new Error('Native assembly descriptor is invalid')
if (assembly.edition === 'premium' ? !/^[0-9a-f]{64}$/.test(assembly.pairedCoreReleaseId || '') : assembly.pairedCoreReleaseId !== undefined) throw new Error('Native assembly pairing is invalid')
if (releasePolicy.edition !== assembly.edition) throw new Error('Release policy edition must exactly match the native assembly edition')
for (const policy of ['models.json', 'processing-locks.json']) {
  if (!readFileSync(resolve(native, policy)).equals(readFileSync(resolve(desktop, policy)))) {
    throw new Error(`Reassemble the native runtime after changing ${policy}`)
  }
}
// Optional memory evidence is native-inventory owned, beside backend.py.
const memoryName = 'processing-memory.json'
const memorySource = resolve(desktop, 'processing-memory', `${manifest.platform}-${manifest.arch}.json`)
if (existsSync(resolve(native, memoryName)) !== existsSync(memorySource)
    || existsSync(resolve(native, memoryName))
      && !readFileSync(resolve(native, memoryName)).equals(readFileSync(memorySource))) {
  throw new Error('Reassemble the native runtime after changing processing-memory.json')
}
// The processing catalog is never part of the static file list: a stray
// desktop/processing-catalog.json or the per-target desktop/processing-catalogs/
// sources are not packed. For a processing-ready build only, the gate's exact
// validated bytes are staged under the packaged name in a build-owned temporary
// directory (never the tracked source tree, which packaging requires clean) and
// added as one FileSet to the application build. Packaging then re-reads the
// produced app.asar and compares digests.
export async function stageProcessingCatalog({ mode, catalogBytes, catalogSha256 } = {}) {
  if (mode === PLAYBACK_ONLY) {
    if (catalogBytes !== null && catalogBytes !== undefined) throw new Error('Playback-only packaging cannot stage a processing catalog')
    return { files: [], cleanup: async () => {}, label: null }
  }
  if (mode !== PROCESSING_READY || !Buffer.isBuffer(catalogBytes)) throw new Error('Processing-ready packaging requires the validated catalog bytes')
  const digest = createHash('sha256').update(catalogBytes).digest('hex')
  if (digest !== catalogSha256) throw new Error('Staged processing catalog differs from the validated source catalog')
  const directory = await mkdtemp(join(tmpdir(), 'singhouse-processing-catalog-'))
  const label = basename(directory)
  const cleanup = () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  try { await writeFile(join(directory, PACKAGED_CATALOG_NAME), catalogBytes, { flag: 'wx' }) }
  catch (error) {
    try { await cleanup() } catch (cleanupError) { warnStagingCleanup(label, cleanupError, true) }
    throw error
  }
  return { files: [{ from: directory, to: '.', filter: [PACKAGED_CATALOG_NAME] }], cleanup, label }
}

// The staged copy holds only the already-validated catalog, so a directory
// that cannot be removed (for example, briefly locked on Windows) is reported
// rather than failing a build. Only the temporary directory's name is logged.
function warnStagingCleanup(label, error, afterFailure, warn = console.warn) {
  warn(`Could not remove the temporary processing catalog staging directory ${label}${afterFailure ? ' after a failed build' : ''} (${error?.code || 'error'}); it holds only the packaged catalog and may be deleted manually.`)
}

// Runs the application build with the staged catalog, then always removes the
// staging directory. A build error propagates unchanged; a cleanup failure is
// only a warning, whether or not the build succeeded.
export async function withStagedCatalog(staged, run, { warn = console.warn } = {}) {
  let failed = false
  try { return await run() }
  catch (error) { failed = true; throw error }
  finally {
    try { await staged.cleanup() } catch (cleanupError) { warnStagingCleanup(staged.label ?? 'directory', cleanupError, failed, warn) }
  }
}

export default {
  appId: 'org.karaoke.desktop',
  productName: BRAND_INSTALLED_NAME,
  executableName: BRAND_INSTALLED_NAME,
  directories: { app: desktop, output: resolve(desktop, 'artifacts') },
  files: ['package.json', 'main.mjs', 'preload.cjs', 'policy.mjs', 'lifecycle.mjs', 'runtime_manager.mjs', 'processing_probe.py', 'heart_setup.mjs', 'onboarding_setup.mjs', 'onboarding_state.mjs', 'hardware_inventory.mjs', 'setup_catalog.mjs', 'modal_credentials.mjs', 'modal_connection.mjs', 'startup.mjs', 'startup-logo.svg', 'models.json', 'processing-locks.json', 'release.mjs', 'update_manager.mjs', 'bootstrap.mjs', 'recovery_launcher.mjs', 'recovery_cli.mjs', 'application_inventory.mjs', 'windows_signing.mjs', 'macos_signing.mjs'],
  extraResources: [{ from: native, to: 'native', filter: ['**/*'] }, { from: releasePolicyPath, to: 'release.json' }],
  asar: true,
  npmRebuild: false,
  // Builds are private test artifacts; publication is a separate operation.
  publish: null,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  linux: {
    extraResources: [{ from: appImageNoticesDirectory, to: 'third-party/appimage', filter: ['**/*'] }],
    target: ['AppImage', 'tar.gz'], category: 'AudioVideo', icon: resolve(icons, 'linux'), syncDesktopName: true,
    // Copied into the application before receipt derivation. electron-builder
    // overlays this file on its generated AppRun when staging the AppImage.
    extraFiles: [{ from: resolve(desktop, 'build/apprun.sh'), to: 'AppRun' }],
  },
  // Override electron-builder's legacy AppImage desktop-entry default.
  appImage: { executableArgs: [] },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.music', minimumSystemVersion: '14.0', identity: null, icon: resolve(icons, 'singhouse.icns') },
  dmg: { icon: resolve(icons, 'singhouse.icns') },
  win: {
    icon: resolve(icons, 'singhouse.ico'),
    ...windowsBuildConfiguration({ signedRelease, manualAzureCli, azureOidc }),
    ...(signedRelease ? { signExts: nativeExecutableSigningExclusions(native,
      JSON.parse(readFileSync(resolve(native, 'files.json'), 'utf8'))) } : {}),
  },
  // Nsis7z cannot extract ARM64-filtered blocks produced by the current 7za
  // compressor. The managed Python payload includes ARM launcher templates, so
  // use the ZIP extractor and disable the differential 7z package path.
  nsis: {
    installerIcon: resolve(icons, 'singhouse.ico'),
    uninstallerIcon: resolve(icons, 'singhouse.ico'),
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    useZip: true,
    differentialPackage: false,
    // Updates use the authenticated singhouse payload flow. Do not let the
    // NSIS pass add an updater helper after release receipt derivation.
    packElevateHelper: false,
  },
}
