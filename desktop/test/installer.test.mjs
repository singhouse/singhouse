// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePolicyId } from '../release.mjs'
import { inspectApplicationInventory } from '../build/release_receipt.mjs'
import { packagedReleasePolicyPath, prepackagedInstallerPath, verifyInstallerPreservedApplication, verifyPackagedReleasePolicy } from '../build/package.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const installer = new URL('../build/installer.mjs', import.meta.url).href
const icons = resolve(desktop, 'build/icons')

test('desktop icon assets contain the platform-required image sizes', async () => {
  const pngSize = data => {
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const width = data.readUInt32BE(16)
    assert.equal(data.readUInt32BE(20), width)
    return width
  }

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    assert.equal(pngSize(await readFile(resolve(icons, 'linux', `${size}x${size}.png`))), size)
  }

  const ico = await readFile(resolve(icons, 'singhouse.ico'))
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  const icoSizes = []
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + 16 * i
    const size = ico[entry] || 256
    assert.equal(ico[entry + 1] || 256, size)
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    assert.equal(pngSize(ico.subarray(offset, offset + length)), size)
    icoSizes.push(size)
  }
  assert.deepEqual(icoSizes, [16, 24, 32, 48, 64, 128, 256])

  const icns = await readFile(resolve(icons, 'singhouse.icns'))
  assert.equal(icns.toString('ascii', 0, 4), 'icns')
  assert.equal(icns.readUInt32BE(4), icns.length)
  const icnsSizes = new Map([['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
    ['ic08', 256], ['ic09', 512], ['ic10', 1024]])
  for (let offset = 8; offset < icns.length;) {
    const type = icns.toString('ascii', offset, offset + 4)
    const length = icns.readUInt32BE(offset + 4)
    assert.ok(icnsSizes.has(type))
    assert.equal(pngSize(icns.subarray(offset + 8, offset + length)), icnsSizes.get(type))
    icnsSizes.delete(type)
    offset += length
    assert.ok(offset <= icns.length)
  }
  assert.equal(icnsSizes.size, 0)
})

function corePolicy(channel = 'core-private-test') {
  const policy = { schema: 1, channel, edition: 'core', schemaHistory: 1,
    minimumReadableSchemaHistory: 1, updatesEnabled: false, signatureThreshold: 1, trustedUpdateKeys: [] }
  policy.policyId = derivePolicyId(policy)
  return policy
}

test('macOS installer receives the app bundle; Windows and Linux receive unpacked directories', () => {
  const root = '/tmp/singhouse-artifacts/mac-arm64'
  assert.equal(prepackagedInstallerPath(root, 'darwin'), resolve(root, 'Singhouse.app'))
  assert.equal(prepackagedInstallerPath(root, 'win32'), resolve(root))
  assert.equal(prepackagedInstallerPath(root, 'linux'), resolve(root))
})

test('packaging verifies the exact selected core and premium runtime policy', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'packaged-policy-'))
  try {
    const core = corePolicy()
    const windowsPath = packagedReleasePolicyPath(root, 'win32')
    await mkdir(resolve(windowsPath, '..'), { recursive: true })
    await assert.rejects(verifyPackagedReleasePolicy({ applicationDirectory: root, platform: 'win32', selectedPolicy: core }), /policy is missing/)
    await writeFile(windowsPath, '{broken')
    await assert.rejects(verifyPackagedReleasePolicy({ applicationDirectory: root, platform: 'win32', selectedPolicy: core }), /policy is invalid/)
    await writeFile(windowsPath, JSON.stringify(core))
    assert.deepEqual((await verifyPackagedReleasePolicy({ applicationDirectory: root, platform: 'win32', selectedPolicy: core })).policy, core)
    await writeFile(windowsPath, JSON.stringify(corePolicy('substituted-channel')))
    await assert.rejects(verifyPackagedReleasePolicy({ applicationDirectory: root, platform: 'win32', selectedPolicy: core }), /does not match/)

    const approvedCorePolicy = corePolicy()
    const premium = { schema: 1, channel: 'premium-private-test', edition: 'premium', schemaHistory: 1,
      minimumReadableSchemaHistory: 1, updatesEnabled: false, signatureThreshold: 1, trustedUpdateKeys: [], approvedCorePolicy }
    premium.policyId = derivePolicyId(premium)
    const macPath = packagedReleasePolicyPath(root, 'darwin')
    await mkdir(resolve(macPath, '..'), { recursive: true }); await writeFile(macPath, JSON.stringify(premium))
    assert.deepEqual((await verifyPackagedReleasePolicy({ applicationDirectory: root, platform: 'darwin', selectedPolicy: premium })).policy, premium)
    assert.equal(packagedReleasePolicyPath(root, 'linux'), resolve(root, 'resources', 'release.json'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('installer packaging may not mutate the receipt-bound application', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'installer-inventory-'))
  try {
    await mkdir(resolve(root, 'resources'), { recursive: true })
    await writeFile(resolve(root, 'Singhouse.exe'), 'application')
    await writeFile(resolve(root, 'resources/release-receipt.json'), 'receipt')
    const expectedInventory = await inspectApplicationInventory(root)
    assert.equal((await verifyInstallerPreservedApplication({ applicationDirectory: root, expectedInventory })).files.length, 3)
    await writeFile(resolve(root, 'resources/elevate.exe'), 'late helper')
    await assert.rejects(
      verifyInstallerPreservedApplication({ applicationDirectory: root, expectedInventory }),
      /changed the receipt-bound application/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('installer rejects stale native admission policy instead of overlaying it', async () => {
  const native = await mkdtemp(resolve(tmpdir(), 'installer-policy-'))
  const previous = process.env.KARAOKE_NATIVE_PAYLOAD
  const previousReleasePolicy = process.env.SINGHOUSE_RELEASE_POLICY
  process.env.KARAOKE_NATIVE_PAYLOAD = native
  try {
    const pkg = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'))
    assert.equal(pkg.author, 'Bones Consulting LLC')
    assert.equal(pkg.description, 'Singhouse is a self-hosted karaoke suite for your own music library.')
    assert.equal(pkg.desktopName, 'org.karaoke.desktop.desktop')
    await writeFile(resolve(native, 'manifest.json'), JSON.stringify({ appVersion: pkg.version }))
    await writeFile(resolve(native, 'files.json'), '{}\n')
    await writeFile(resolve(native, 'assembly.json'), JSON.stringify({ schema: 1, kind: 'singhouse-assembly', edition: 'core', payloadDigest: 'a'.repeat(64) }))
    await writeFile(resolve(native, 'backend.py'), '# fixture backend\n')
    for (const policy of ['models.json', 'processing-locks.json']) {
      await writeFile(resolve(native, policy), await readFile(resolve(desktop, policy)))
    }
    const { default: valid, releasePolicyPath } = await import(`${installer}?valid=${Date.now()}`)
    assert.deepEqual(valid.extraResources, [
      { from: native, to: 'native', filter: ['**/*'] },
      { from: releasePolicyPath, to: 'release.json' },
    ])
    // electron-builder 26 only creates the ZIP selected by `useZip` when
    // differential packaging is disabled. Keeping this pair prevents Nsis7z
    // from dropping payload members stored with an ARM64 executable filter.
    assert.equal(valid.nsis.useZip, true)
    assert.equal(valid.nsis.differentialPackage, false)
    assert.equal(valid.nsis.packElevateHelper, false)
    assert.equal(valid.linux.icon, resolve(icons, 'linux'))
    assert.equal(valid.appId, pkg.desktopName.slice(0, -'.desktop'.length))
    assert.equal(valid.linux.syncDesktopName, true)
    assert.deepEqual(valid.appImage.executableArgs, [])
    assert.deepEqual(valid.linux.extraFiles, [{ from: resolve(desktop, 'build/apprun.sh'), to: 'AppRun' }])
    assert.equal(valid.mac.icon, resolve(icons, 'singhouse.icns'))
    assert.equal(valid.dmg.icon, valid.mac.icon)
    assert.equal(valid.win.icon, resolve(icons, 'singhouse.ico'))
    assert.equal(valid.nsis.installerIcon, valid.win.icon)
    assert.equal(valid.nsis.uninstallerIcon, valid.win.icon)
    assert.ok(!valid.files.some(file => typeof file === 'object' && file.to === 'release.json'))
    await writeFile(resolve(native, 'processing-locks.json'), '{}\n')
    await assert.rejects(import(`${installer}?stale=${Date.now()}`), /Reassemble the native runtime after changing processing-locks.json/)
    await writeFile(resolve(native, 'processing-locks.json'), await readFile(resolve(desktop, 'processing-locks.json')))
    await writeFile(resolve(native, 'assembly.json'), JSON.stringify({ schema: 1, kind: 'singhouse-assembly', edition: 'premium', pairedCoreReleaseId: 'b'.repeat(64), payloadDigest: 'a'.repeat(64) }))
    await assert.rejects(import(`${installer}?wrong-edition=${Date.now()}`), /policy edition.*assembly edition/i)

    const premiumPath = resolve(native, 'premium-release.json')
    const approvedCorePolicy = { schema: 1, channel: 'core-private-test', edition: 'core', schemaHistory: 1,
      minimumReadableSchemaHistory: 1, updatesEnabled: false, signatureThreshold: 1, trustedUpdateKeys: [] }
    approvedCorePolicy.policyId = derivePolicyId(approvedCorePolicy)
    const premium = { schema: 1, channel: 'premium-private-test', edition: 'premium', schemaHistory: 1,
      minimumReadableSchemaHistory: 1, updatesEnabled: false, signatureThreshold: 1, trustedUpdateKeys: [],
      approvedCorePolicy }
    premium.policyId = derivePolicyId(premium)
    await writeFile(premiumPath, JSON.stringify(premium))
    process.env.SINGHOUSE_RELEASE_POLICY = premiumPath
    const { default: premiumConfig, releasePolicy } = await import(`${installer}?premium=${Date.now()}`)
    assert.equal(releasePolicy.edition, 'premium')
    assert.deepEqual(premiumConfig.extraResources.at(-1), { from: premiumPath, to: 'release.json' })
  } finally {
    if (previous === undefined) delete process.env.KARAOKE_NATIVE_PAYLOAD
    else process.env.KARAOKE_NATIVE_PAYLOAD = previous
    if (previousReleasePolicy === undefined) delete process.env.SINGHOUSE_RELEASE_POLICY
    else process.env.SINGHOUSE_RELEASE_POLICY = previousReleasePolicy
    await rm(native, { recursive: true, force: true })
  }
})
