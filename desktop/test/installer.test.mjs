// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePolicyId } from '../release.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const installer = new URL('../build/installer.mjs', import.meta.url).href

test('installer rejects stale native admission policy instead of overlaying it', async () => {
  const native = await mkdtemp(resolve(tmpdir(), 'installer-policy-'))
  const previous = process.env.KARAOKE_NATIVE_PAYLOAD
  const previousReleasePolicy = process.env.SINGHOUSE_RELEASE_POLICY
  process.env.KARAOKE_NATIVE_PAYLOAD = native
  try {
    const pkg = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'))
    await writeFile(resolve(native, 'manifest.json'), JSON.stringify({ appVersion: pkg.version }))
    await writeFile(resolve(native, 'files.json'), '{}\n')
    await writeFile(resolve(native, 'assembly.json'), JSON.stringify({ schema: 1, kind: 'singhouse-assembly', edition: 'core', payloadDigest: 'a'.repeat(64) }))
    await writeFile(resolve(native, 'backend.py'), '# fixture backend\n')
    for (const policy of ['models.json', 'processing-locks.json']) {
      await writeFile(resolve(native, policy), await readFile(resolve(desktop, policy)))
    }
    const { default: valid } = await import(`${installer}?valid=${Date.now()}`)
    assert.deepEqual(valid.extraResources, [{ from: native, to: 'native', filter: ['**/*'] }])
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
    assert.equal(premiumConfig.files.at(-1).from, premiumPath)
  } finally {
    if (previous === undefined) delete process.env.KARAOKE_NATIVE_PAYLOAD
    else process.env.KARAOKE_NATIVE_PAYLOAD = previous
    if (previousReleasePolicy === undefined) delete process.env.SINGHOUSE_RELEASE_POLICY
    else process.env.SINGHOUSE_RELEASE_POLICY = previousReleasePolicy
    await rm(native, { recursive: true, force: true })
  }
})
