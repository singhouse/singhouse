// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertReleasePolicy } from '../release.mjs'
import { windowsBuildConfiguration } from '../windows_signing.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const sourceRoot = resolve(desktop, '..')
const native = resolve(process.env.KARAOKE_NATIVE_PAYLOAD || resolve(desktop, 'native'))
export const releasePolicyPath = resolve(process.env.SINGHOUSE_RELEASE_POLICY || resolve(desktop, 'release.json'))
export const releasePolicy = assertReleasePolicy(JSON.parse(readFileSync(releasePolicyPath, 'utf8')))
const manifest = JSON.parse(readFileSync(resolve(native, 'manifest.json'), 'utf8'))
const assembly = JSON.parse(readFileSync(resolve(native, 'assembly.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(resolve(desktop, 'package.json'), 'utf8'))
const { BRAND_NAME } = await import(pathToFileURL(resolve(desktop, '../frontend/src/brand.js')))
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
export default {
  appId: 'org.karaoke.desktop',
  productName: BRAND_NAME,
  executableName: BRAND_NAME,
  directories: { app: desktop, output: resolve(desktop, 'artifacts') },
  files: ['package.json', 'main.mjs', 'preload.cjs', 'policy.mjs', 'lifecycle.mjs', 'runtime_manager.mjs', 'processing_probe.py', 'heart_setup.mjs', 'onboarding_setup.mjs', 'onboarding_state.mjs', 'hardware_inventory.mjs', 'setup_catalog.mjs', 'modal_credentials.mjs', 'modal_connection.mjs', 'startup.mjs', 'models.json', 'processing-locks.json', 'processing-catalog.json', 'release.mjs', 'update_manager.mjs', 'bootstrap.mjs', 'recovery_launcher.mjs', 'recovery_cli.mjs', 'application_inventory.mjs', 'windows_signing.mjs'],
  extraResources: [{ from: native, to: 'native', filter: ['**/*'] }, { from: releasePolicyPath, to: 'release.json' }],
  asar: true,
  npmRebuild: false,
  // Builds are private test artifacts; publication is a separate operation.
  publish: null,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  linux: { target: ['AppImage', 'tar.gz'], category: 'AudioVideo' },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.music', minimumSystemVersion: '14.0', identity: null },
  win: windowsBuildConfiguration({ signedRelease, manualAzureCli, azureOidc }),
  // Nsis7z cannot extract ARM64-filtered blocks produced by the current 7za
  // compressor. The managed Python payload includes ARM launcher templates, so
  // use the ZIP extractor and disable the differential 7z package path.
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    useZip: true,
    differentialPackage: false,
    // Updates use the authenticated Singhouse payload flow. Do not let the
    // NSIS pass add an updater helper after release receipt derivation.
    packElevateHelper: false,
  },
}
