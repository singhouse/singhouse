// SPDX-License-Identifier: AGPL-3.0-only
import { copyFile, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertReleasePolicy, canonicalJson } from '../release.mjs'
import { createPortablePayload, createReleaseReceipt, deriveIdentityFromApplication, inspectApplicationInventory, verifyPackagingSource } from './release_receipt.mjs'
import { verifyAzureCliSession, verifyWindowsAuthenticode } from '../windows_signing.mjs'

export function packagedReleasePolicyPath(applicationDirectory, platform) {
  const application = resolve(applicationDirectory)
  if (platform === 'darwin') return resolve(application, 'Singhouse.app', 'Contents', 'Resources', 'release.json')
  if (platform === 'linux' || platform === 'win32') return resolve(application, 'resources', 'release.json')
  throw new Error('Unsupported packaged release policy platform')
}

export async function verifyPackagedReleasePolicy({ applicationDirectory, platform, selectedPolicy }) {
  const expected = assertReleasePolicy(selectedPolicy)
  const path = packagedReleasePolicyPath(applicationDirectory, platform)
  let bytes
  try { bytes = await readFile(path, 'utf8') }
  catch (error) { throw new Error(`Packaged release policy is missing: ${error.message}`) }
  let installed
  try { installed = assertReleasePolicy(JSON.parse(bytes)) }
  catch (error) { throw new Error(`Packaged release policy is invalid: ${error.message}`) }
  if (canonicalJson(installed) !== canonicalJson(expected)) throw new Error('Packaged release policy does not match the selected release policy')
  return { path, policy: installed }
}

export async function verifyInstallerPreservedApplication({ applicationDirectory, expectedInventory }) {
  const installed = await inspectApplicationInventory(applicationDirectory)
  if (canonicalJson(installed.files) !== canonicalJson(expectedInventory?.files)) {
    throw new Error('Installer packaging changed the receipt-bound application')
  }
  return installed
}

async function main() {
  const signedRelease = process.argv.includes('--signed-release')
  const manualAzureCli = process.argv.includes('--azure-cli-user')
  const azureOidc = process.argv.includes('--azure-oidc')
  if (manualAzureCli && !signedRelease) throw new Error('--azure-cli-user requires --signed-release')
  if (azureOidc && !signedRelease) throw new Error('--azure-oidc requires --signed-release')
  if (signedRelease && !process.argv.includes('--first-installers')) throw new Error('--signed-release requires --first-installers')
  if (manualAzureCli) await verifyAzureCliSession()
  if (azureOidc) await verifyAzureCliSession({ expectedType: 'servicePrincipal', expected: {
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
    tenantId: process.env.AZURE_TENANT_ID,
    clientId: process.env.AZURE_CLIENT_ID,
  } })
  const [{ build, Platform, Arch }, { default: config, releasePolicy, sourceRoot }] = await Promise.all([
    import('electron-builder'),
    import('./installer.mjs'),
  ])
  const native = resolve(config.extraResources[0].from)
  const nativeManifest = JSON.parse(await readFile(resolve(native, 'manifest.json'), 'utf8'))
  const provenance = JSON.parse(await readFile(resolve(native, 'provenance.json'), 'utf8'))
  const policy = releasePolicy
  const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  await verifyPackagingSource({ repositoryDirectory: sourceRoot, provenance })
  const platform = { linux: Platform.LINUX, darwin: Platform.MAC, win32: Platform.WINDOWS }[nativeManifest.platform]
  if (!platform || !['x64', 'arm64'].includes(nativeManifest.arch) || (nativeManifest.platform === 'win32' && nativeManifest.arch !== 'x64') || (nativeManifest.platform === 'darwin' && nativeManifest.arch !== 'arm64')) throw new Error('Unsupported portable target')
  if (nativeManifest.platform === 'darwin' && process.platform !== 'darwin') throw new Error('Create macOS application payloads on macOS')

  const output = resolve(config.directories.output)
  await build({ config: { ...config, publish: null }, publish: 'never', targets: platform.createTarget('dir', Arch[nativeManifest.arch]) })
  async function applicationRoot() {
    const name = nativeManifest.platform === 'darwin' ? 'mac-arm64'
      : nativeManifest.platform === 'win32' ? 'win-unpacked'
        : nativeManifest.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked'
    const path = resolve(output, name)
    if (!(await stat(path)).isDirectory()) throw new Error('Electron did not produce the expected unpacked application directory')
    return path
  }
  const application = await applicationRoot()
  if (signedRelease && nativeManifest.platform !== 'win32') throw new Error('--signed-release is supported only for Windows')
  if (signedRelease && !await verifyWindowsAuthenticode(resolve(application, 'Singhouse.exe'), { onDiagnostic: detail => console.error('Application signature verification:', JSON.stringify(detail)) })) {
    throw new Error('Signed release application failed Authenticode publisher or timestamp verification')
  }
  await verifyPackagedReleasePolicy({ applicationDirectory: application, platform: nativeManifest.platform, selectedPolicy: policy })
  const identity = await deriveIdentityFromApplication({ applicationDirectory: application, policy, packageLock })
  const target = `${nativeManifest.platform}-${nativeManifest.arch}`
  const payload = resolve(output, `Singhouse-${identity.appVersion}-${target}.shapp`)
  const receipt = `${payload}.receipt.json`
  await createPortablePayload({ sourceDirectory: application, output: payload, identity, platform: nativeManifest.platform, arch: nativeManifest.arch })
  await createReleaseReceipt({
    payload, output: receipt, sourceCommit: provenance.sourceCommit, sourceDirty: provenance.sourceDirty,
    electronVersion: identity.electronVersion, nativeRuntimeId: nativeManifest.runtimeId,
    // Re-read exact HEAD plus the complete tracked/untracked status after the
    // Electron build and payload construction, immediately before publishing
    // the immutable receipt.
    verifySourceBeforePublish: () => verifyPackagingSource({ repositoryDirectory: sourceRoot, provenance }),
  })

  // Native installers remain first-install surfaces. Signing and publication are
  // explicit release gates and are intentionally absent from this build command.
  if (process.argv.includes('--first-installers')) {
    const resources = nativeManifest.platform === 'darwin'
      ? resolve(application, 'Singhouse.app', 'Contents', 'Resources') : resolve(application, 'resources')
    await copyFile(receipt, resolve(resources, 'release-receipt.json'))
    const installerApplicationInventory = await inspectApplicationInventory(application)
    // A prepackaged application already contains the selected files and native
    // resources. Passing those source-copy rules to electron-builder again both
    // reopens the clean payload and triggers invalid config merging in current
    // electron-builder releases.
    const { files: _files, extraResources: _extraResources, directories, ...installerConfig } = config
    installerConfig.directories = { output: directories.output }
    await build({ config: installerConfig, prepackaged: application, publish: 'never',
      targets: platform.createTarget(undefined, Arch[nativeManifest.arch]) })
    if (signedRelease) {
      const installer = resolve(output, `Singhouse-${nativeManifest.appVersion}-win-x64.exe`)
      if (!await verifyWindowsAuthenticode(installer, { onDiagnostic: detail => console.error('Installer signature verification:', JSON.stringify(detail)) })) throw new Error('Signed release installer failed Authenticode publisher or timestamp verification')
    }
    await verifyPackagedReleasePolicy({ applicationDirectory: application, platform: nativeManifest.platform, selectedPolicy: policy })
    await verifyInstallerPreservedApplication({ applicationDirectory: application, expectedInventory: installerApplicationInventory })
  }
  console.log(JSON.stringify({ payload, receipt, releaseId: identity.releaseId }, null, 2))
}

export function reportPackagingFailure(error) {
  console.error(error.message)
  process.exitCode = 1
  // Some build-tool cleanup handlers overwrite exitCode. Keep a rejected build
  // unsuccessful after those handlers run, as electron-builder's own CLI does.
  process.on('exit', () => { process.exitCode = 1 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(reportPackagingFailure)
}
