// SPDX-License-Identifier: AGPL-3.0-only
import { build, Platform, Arch } from 'electron-builder'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import config, { releasePolicy, sourceRoot } from './installer.mjs'
import { createPortablePayload, createReleaseReceipt, deriveIdentityFromApplication, verifyPackagingSource } from './release_receipt.mjs'

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
  await build({ config, prepackaged: application, publish: 'never',
    targets: platform.createTarget(undefined, Arch[nativeManifest.arch]) })
}
console.log(JSON.stringify({ payload, receipt, releaseId: identity.releaseId }, null, 2))
