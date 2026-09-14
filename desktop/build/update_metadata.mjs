// SPDX-License-Identifier: AGPL-3.0-only
import { createPrivateKey, sign as cryptoSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertReleasePolicy, canonicalJson, validateUpdateMetadata } from '../release.mjs'
import { inspectReleaseReceipt, writeImmutableFile } from './release_receipt.mjs'

function artifact(role, receipt, baseUrl) {
  return { role, name: receipt.artifact.name, size: receipt.artifact.size, sha256: receipt.artifact.sha256, identity: receipt.identity, platform: receipt.target.platform, arch: receipt.target.arch, ...(baseUrl ? { url: new URL(encodeURIComponent(receipt.artifact.name), `${baseUrl.replace(/\/$/, '')}/`).href } : {}) }
}

export function validatePremiumCorePairs({ next, previous, coreNext, corePrevious, policy }) {
  const approved = policy?.edition === 'premium' ? policy.approvedCorePolicy : null
  if (!approved) throw new Error('Premium metadata requires an explicitly approved core policy/train')
  for (const [label, receipt] of [['target core', coreNext], ['rollback core', corePrevious]]) {
    if (!receipt || receipt.identity?.edition !== 'core' || receipt.identity.pairedCoreReleaseId !== undefined) throw new Error(`Premium metadata requires an inspected ${label} receipt`)
  }
  if (canonicalJson(coreNext.target) !== canonicalJson(next.target) || canonicalJson(corePrevious.target) !== canonicalJson(previous.target)) throw new Error('Premium and core receipts must describe the same machine targets')
  if (next.identity.pairedCoreReleaseId !== coreNext.identity.releaseId || previous.identity.pairedCoreReleaseId !== corePrevious.identity.releaseId) throw new Error('Premium receipts do not bind the inspected old and new core release IDs')
  if (next.identity.appVersion !== coreNext.identity.appVersion || previous.identity.appVersion !== corePrevious.identity.appVersion) throw new Error('Premium and paired core releases must share exact application versions')
  if (coreNext.identity.policyId !== approved.policyId || corePrevious.identity.policyId !== approved.policyId ||
      corePrevious.identity.schemaHistory < approved.schemaHistory ||
      corePrevious.identity.schemaHistory !== previous.identity.schemaHistory ||
      coreNext.identity.schemaHistory !== next.identity.schemaHistory ||
      corePrevious.identity.schemaHistory < approved.minimumReadableSchemaHistory ||
      corePrevious.identity.schemaHistory > coreNext.identity.schemaHistory) {
    throw new Error(`Paired core receipts do not match approved ${approved.channel} policy and schema train`)
  }
  return { coreNext, corePrevious }
}

export async function createUpdateMetadata({ applicationReceipt, applicationPayload, rollbackReceipt, rollbackPayload,
  coreApplicationReceipt, coreApplicationPayload, coreRollbackReceipt, coreRollbackPayload,
  sequence, output, signers, policy, baseUrl }) {
  assertReleasePolicy(policy)
  if (!policy.updatesEnabled) throw new Error('Cannot create update metadata for an explicitly disabled release policy')
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Update sequence must be a positive safe integer')
  if (!Array.isArray(signers) || signers.length < policy.signatureThreshold) throw new Error('Authenticated update metadata requires the configured signing threshold')
  const next = await inspectReleaseReceipt(applicationReceipt, applicationPayload)
  const previous = await inspectReleaseReceipt(rollbackReceipt, rollbackPayload)
  if (next.target.platform !== previous.target.platform || next.target.arch !== previous.target.arch || next.identity.edition !== previous.identity.edition) throw new Error('Target and rollback receipts must describe one edition and machine target')
  if (next.identity.edition !== policy.edition || next.identity.policyId !== policy.policyId || previous.identity.policyId !== policy.policyId) throw new Error('Target and rollback receipts require their edition-owned release policy')
  const coreInputs = [coreApplicationReceipt, coreApplicationPayload, coreRollbackReceipt, coreRollbackPayload]
  let pairedCore
  if (policy.edition === 'premium') {
    if (coreInputs.some(value => !value)) throw new Error('Premium metadata requires inspected target and rollback core receipts and payloads')
    const coreNext = await inspectReleaseReceipt(coreApplicationReceipt, coreApplicationPayload)
    const corePrevious = await inspectReleaseReceipt(coreRollbackReceipt, coreRollbackPayload)
    validatePremiumCorePairs({ next, previous, coreNext, corePrevious, policy })
    pairedCore = { policyId: policy.approvedCorePolicy.policyId, channel: policy.approvedCorePolicy.channel,
      previousIdentity: corePrevious.identity, nextIdentity: coreNext.identity }
  } else if (coreInputs.some(value => value !== undefined)) throw new Error('Core metadata cannot declare premium pairing receipts')
  const signed = {
    schema: 1, kind: 'singhouse-update-metadata', edition: policy.edition, channel: policy.channel, policyId: policy.policyId,
    sequence, identity: next.identity,
    supersedes: [previous.identity.releaseId],
    requires: { schemaHistory: next.identity.schemaHistory, minimumReadableSchemaHistory: policy.minimumReadableSchemaHistory },
    files: [artifact('application', next, baseUrl), artifact('rollback', previous, baseUrl)],
    ...(pairedCore ? { pairedCore } : {}),
  }
  const message = Buffer.from(canonicalJson(signed))
  const signatures = signers.map(({ keyId, privateKey }) => ({ keyId, signature: cryptoSign(null, message, createPrivateKey(privateKey)).toString('base64') })).sort((a, b) => a.keyId.localeCompare(b.keyId, 'en'))
  const envelope = { schema: 1, signed, signatures }
  validateUpdateMetadata(envelope, policy, { currentIdentity: previous.identity, pairedCoreReleaseId: next.identity.pairedCoreReleaseId, platform: next.target.platform, arch: next.target.arch })
  const encoded = `${canonicalJson(envelope)}\n`
  if (output) await writeImmutableFile(output, encoded)
  return envelope
}

async function cli() {
  const values = new Map()
  for (let i = 2; i < process.argv.length; i += 2) values.set(process.argv[i], process.argv[i + 1])
  for (const name of ['--application-receipt', '--application-payload', '--rollback-receipt', '--rollback-payload', '--sequence', '--output', '--policy', '--key-id', '--private-key']) if (!values.has(name)) throw new Error(`Missing ${name}`)
  const policy = assertReleasePolicy(JSON.parse(await readFile(resolve(values.get('--policy')), 'utf8')))
  if (policy.edition === 'premium') for (const name of ['--core-application-receipt', '--core-application-payload', '--core-rollback-receipt', '--core-rollback-payload']) if (!values.has(name)) throw new Error(`Missing ${name}`)
  await createUpdateMetadata({
    applicationReceipt: resolve(values.get('--application-receipt')), applicationPayload: resolve(values.get('--application-payload')),
    rollbackReceipt: resolve(values.get('--rollback-receipt')), rollbackPayload: resolve(values.get('--rollback-payload')),
    ...(policy.edition === 'premium' ? {
      coreApplicationReceipt: resolve(values.get('--core-application-receipt')), coreApplicationPayload: resolve(values.get('--core-application-payload')),
      coreRollbackReceipt: resolve(values.get('--core-rollback-receipt')), coreRollbackPayload: resolve(values.get('--core-rollback-payload')),
    } : {}),
    sequence: Number(values.get('--sequence')), output: resolve(values.get('--output')), policy,
    signers: [{ keyId: values.get('--key-id'), privateKey: await readFile(resolve(values.get('--private-key')), 'utf8') }],
  })
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await cli()
