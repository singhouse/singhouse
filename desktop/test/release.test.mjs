// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { assertReleasePolicy, canonicalJson, derivePolicyId, deriveReleaseIdentity, validateEd25519PublicKey, verifySignedEnvelope, validateUpdateMetadata } from '../release.mjs'
import { validatePremiumCorePairs } from '../build/update_metadata.mjs'

const H = 'a'.repeat(64)
function identity(overrides = {}) {
  return deriveReleaseIdentity({ schema: 1, appVersion: '1.2.3', edition: 'core', policyId: H, sourceCommit: 'b'.repeat(40), electronVersion: '44.3.0', electronRuntimeDigest: H, electronAppDigest: H, frontendDigest: H, backendDigest: H, nativeRuntimeId: H, runtimeLocksDigest: H, modelPolicyDigest: H, schemaHistory: 1, assemblyDigest: H, applicationInventoryDigest: H, ...overrides })
}
function key(id) {
  const pair = generateKeyPairSync('ed25519'); const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  return { id, pair, publicKey: der.subarray(-32).toString('base64') }
}
function envelope(signed, keys) { const message = Buffer.from(canonicalJson(signed)); return { schema: 1, signed, signatures: keys.map(record => ({ keyId: record.id, signature: sign(null, message, record.pair.privateKey).toString('base64') })) } }
function policy(record, edition = 'core', channel = `${edition}-private-test`) {
  const approvedCorePolicy = { schema: 1, channel: 'core-private-test', edition: 'core', schemaHistory: 1,
    minimumReadableSchemaHistory: 1, updatesEnabled: false, signatureThreshold: 1, trustedUpdateKeys: [] }
  approvedCorePolicy.policyId = derivePolicyId(approvedCorePolicy)
  const value = { schema: 1, channel, edition, schemaHistory: 1, minimumReadableSchemaHistory: 1,
    updatesEnabled: Boolean(record), signatureThreshold: 1, trustedUpdateKeys: record ? [{ id: record.id, publicKey: record.publicKey }] : [],
    ...(edition === 'premium' ? { approvedCorePolicy } : {}) }
  value.policyId = derivePolicyId(value)
  return value
}

test('release identities are content-derived and premium pairing is exact', () => {
  const core = identity(); assert.match(core.releaseId, /^[0-9a-f]{64}$/)
  assert.notEqual(identity({ appVersion: '1.2.4' }).releaseId, core.releaseId)
  assert.throws(() => identity({ appVersion: '1.2.3-rc.1' }), /canonical semantic versions/)
  assert.throws(() => identity({ edition: 'premium' }), /paired core/)
  const premium = identity({ edition: 'premium', pairedCoreReleaseId: core.releaseId })
  assert.equal(premium.pairedCoreReleaseId, core.releaseId)
})

test('canonical JSON rejects floats and sorts keys', () => {
  assert.equal(canonicalJson({ z: [true, null], a: 1 }), '{"a":1,"z":[true,null]}')
  assert.throws(() => canonicalJson({ value: 1.5 }), /safe integers/)
})

test('platform signing hooks are explicit and fail-closed policy values', () => {
  const base = { schema: 1, channel: 'private-test', edition: 'core', schemaHistory: 1,
    minimumReadableSchemaHistory: 1, updatesEnabled: false, signatureThreshold: 1, trustedUpdateKeys: [] }
  const valid = { ...base, platformTrust: {
    darwin: { enabled: false, mode: 'codesign' }, win32: { enabled: false, mode: 'authenticode' } } }
  valid.policyId = derivePolicyId(valid)
  assert.doesNotThrow(() => assertReleasePolicy(valid))
  const invalid = { ...base, platformTrust: { win32: { enabled: true, mode: 'codesign' } } }; invalid.policyId = derivePolicyId(invalid)
  assert.throws(() => assertReleasePolicy(invalid), /win32/)
  const premiumWithoutCoreApproval = { ...base, edition: 'premium' }
  premiumWithoutCoreApproval.policyId = derivePolicyId(premiumWithoutCoreApproval)
  assert.throws(() => assertReleasePolicy(premiumWithoutCoreApproval), /plain object|approved core/i)
})

test('release policy requires unique signing identities and explicit update disablement', () => {
  const a = key('a'), b = key('b')
  const valid = { schema: 1, channel: 'private-test', edition: 'core', schemaHistory: 1,
    minimumReadableSchemaHistory: 1, updatesEnabled: true, signatureThreshold: 2,
    trustedUpdateKeys: [{ id: a.id, publicKey: a.publicKey }, { id: b.id, publicKey: b.publicKey }] }
  valid.policyId = derivePolicyId(valid)
  assert.doesNotThrow(() => assertReleasePolicy(valid))

  const duplicateId = structuredClone(valid); duplicateId.trustedUpdateKeys[1].id = a.id; duplicateId.policyId = derivePolicyId(duplicateId)
  assert.throws(() => assertReleasePolicy(duplicateId), /IDs must be distinct/)
  const duplicateMaterial = structuredClone(valid); duplicateMaterial.trustedUpdateKeys[1].publicKey = a.publicKey; duplicateMaterial.policyId = derivePolicyId(duplicateMaterial)
  assert.throws(() => assertReleasePolicy(duplicateMaterial), /public keys must be distinct/)
  const excessiveThreshold = { ...valid, signatureThreshold: 3 }; excessiveThreshold.policyId = derivePolicyId(excessiveThreshold)
  assert.throws(() => assertReleasePolicy(excessiveThreshold), /threshold exceeds/)

  const implicitEmpty = { ...valid, signatureThreshold: 1, trustedUpdateKeys: [] }; delete implicitEmpty.updatesEnabled
  implicitEmpty.policyId = valid.policyId
  assert.throws(() => assertReleasePolicy(implicitEmpty), /updatesEnabled/)
  const enabledEmpty = { ...valid, signatureThreshold: 1, trustedUpdateKeys: [] }; enabledEmpty.policyId = derivePolicyId(enabledEmpty)
  assert.throws(() => assertReleasePolicy(enabledEmpty), /threshold exceeds/)
  const disabled = { ...enabledEmpty, updatesEnabled: false }; disabled.policyId = derivePolicyId(disabled)
  assert.doesNotThrow(() => assertReleasePolicy(disabled))
})

test('Ed25519 threshold verification rejects duplicate, noncanonical, and small-order inputs', () => {
  const a = key('a'), b = key('b'); const signed = { purpose: 'test' }
  assert.deepEqual(verifySignedEnvelope(envelope(signed, [a, b]), [{ id: 'a', publicKey: a.publicKey }, { id: 'b', publicKey: b.publicKey }], 2), signed)
  assert.throws(() => verifySignedEnvelope(envelope(signed, [a, a]), [{ id: 'a', publicKey: a.publicKey }], 2), /threshold/)
  assert.throws(() => validateEd25519PublicKey(Buffer.alloc(32).toString('base64')), /prime-order|Invalid/)
  const malformed = envelope(signed, [a]); malformed.signatures[0].signature = `${malformed.signatures[0].signature}=`
  assert.throws(() => verifySignedEnvelope(malformed, [{ id: 'a', publicKey: a.publicKey }]), /threshold/)
})

test('update metadata requires exact target, rollback, schema and machine', () => {
  const signer = key('release'), contract = policy(signer)
  const previous = identity({ appVersion: '1.2.2', policyId: contract.policyId }), next = identity({ policyId: contract.policyId })
  const file = (role, value) => ({ role, name: `${role}.shapp`, size: 10, sha256: H, identity: value, platform: 'linux', arch: 'x64' })
  const signed = { schema: 1, kind: 'singhouse-update-metadata', edition: contract.edition, channel: contract.channel, policyId: contract.policyId, sequence: 7, identity: next, supersedes: [previous.releaseId], requires: { schemaHistory: 1, minimumReadableSchemaHistory: 1 }, files: [file('application', next), file('rollback', previous)] }
  const metadata = envelope(signed, [signer])
  assert.equal(validateUpdateMetadata(metadata, contract, { currentIdentity: previous, platform: 'linux', arch: 'x64', lastSequence: 6 }).identity.releaseId, next.releaseId)
  assert.throws(() => validateUpdateMetadata(metadata, contract, { currentIdentity: previous, platform: 'win32', arch: 'x64' }), /artifact/)
  const substituted = structuredClone(metadata); substituted.signed.files[1].identity = next
  assert.throws(() => validateUpdateMetadata(substituted, contract, { currentIdentity: previous, platform: 'linux', arch: 'x64' }), /threshold/)
  const unsafe = envelope({ ...signed, files: [file('application', next), { ...file('rollback', previous), name: '../rollback.shapp' }] }, [signer])
  assert.throws(() => validateUpdateMetadata(unsafe, contract, { currentIdentity: previous, platform: 'linux', arch: 'x64' }), /artifact/)

  const sameVersion = identity({ appVersion: previous.appVersion, policyId: contract.policyId })
  const sameSigned = { ...signed, identity: sameVersion, files: [file('application', sameVersion), file('rollback', previous)] }
  assert.throws(() => validateUpdateMetadata(envelope(sameSigned, [signer]), contract,
    { currentIdentity: previous, platform: 'linux', arch: 'x64' }), /monotonically supersede/)

  const older = identity({ appVersion: '1.2.1', policyId: contract.policyId })
  const olderSigned = { ...signed, identity: older, files: [file('application', older), file('rollback', previous)] }
  assert.throws(() => validateUpdateMetadata(envelope(olderSigned, [signer]), contract,
    { currentIdentity: previous, platform: 'linux', arch: 'x64' }), /monotonically supersede/)

  const nextSchema = identity({ appVersion: '1.3.0', policyId: contract.policyId, schemaHistory: 2 })
  assert.equal(derivePolicyId({ ...contract, schemaHistory: 2 }), contract.policyId,
    'schema cursor advancement does not change immutable core policy authority')
  const compatibleSchema = { ...signed, identity: nextSchema,
    requires: { schemaHistory: 2, minimumReadableSchemaHistory: 1 },
    files: [file('application', nextSchema), file('rollback', previous)] }
  assert.equal(validateUpdateMetadata(envelope(compatibleSchema, [signer]), contract,
    { currentIdentity: previous, platform: 'linux', arch: 'x64' }).identity.schemaHistory, 2)
  const incompatibleSchema = { ...compatibleSchema, requires: { schemaHistory: 2, minimumReadableSchemaHistory: 2 } }
  assert.throws(() => validateUpdateMetadata(envelope(incompatibleSchema, [signer]), contract,
    { currentIdentity: previous, platform: 'linux', arch: 'x64' }), /not monotonically compatible/)

  const regressedSchema = identity({ appVersion: '1.3.0', policyId: contract.policyId, schemaHistory: 1 })
  const newerCurrent = identity({ appVersion: '1.2.2', policyId: contract.policyId, schemaHistory: 2 })
  const schema2Contract = { ...contract, schemaHistory: 2 }
  const regressedSigned = { ...signed, identity: regressedSchema, supersedes: [newerCurrent.releaseId],
    files: [file('application', regressedSchema), file('rollback', newerCurrent)] }
  assert.throws(() => validateUpdateMetadata(envelope(regressedSigned, [signer]), schema2Contract,
    { currentIdentity: newerCurrent, platform: 'linux', arch: 'x64' }), /not monotonically compatible/)
})

test('premium update signs the old rollback pair and a distinct new target pair', () => {
  const signer = key('premium-release')
  const contract = policy(signer, 'premium')
  const stablePremiumPolicyId = contract.policyId
  const corePolicyId = contract.approvedCorePolicy.policyId
  const advancedPolicy = structuredClone(contract)
  advancedPolicy.schemaHistory = 2
  advancedPolicy.approvedCorePolicy.schemaHistory = 2
  assert.equal(derivePolicyId(advancedPolicy), stablePremiumPolicyId)
  assert.doesNotThrow(() => assertReleasePolicy(contract))
  assert.doesNotThrow(() => assertReleasePolicy(advancedPolicy))
  const corePrevious = { target: { platform: 'linux', arch: 'x64' }, identity: identity({ appVersion: '1.2.2', policyId: corePolicyId }) }
  const coreNext = { target: { platform: 'linux', arch: 'x64' }, identity: identity({ policyId: corePolicyId, schemaHistory: 2 }) }
  const oldCore = corePrevious.identity.releaseId, newCore = coreNext.identity.releaseId
  const previous = identity({ appVersion: '1.2.2', edition: 'premium', policyId: contract.policyId, pairedCoreReleaseId: oldCore })
  const next = identity({ edition: 'premium', policyId: contract.policyId, pairedCoreReleaseId: newCore, schemaHistory: 2 })
  const file = (role, value) => ({ role, name: `${role}.shapp`, size: 10, sha256: H,
    identity: value, platform: 'linux', arch: 'x64' })
  const signed = { schema: 1, kind: 'singhouse-update-metadata', edition: contract.edition, channel: contract.channel, policyId: contract.policyId, sequence: 8, identity: next,
    supersedes: [previous.releaseId], requires: { schemaHistory: 2, minimumReadableSchemaHistory: 1 },
    files: [file('application', next), file('rollback', previous)],
    pairedCore: { policyId: corePolicyId, channel: 'core-private-test', previousIdentity: corePrevious.identity, nextIdentity: coreNext.identity } }
  const metadata = envelope(signed, [signer])
  const accepted = validateUpdateMetadata(metadata, contract,
    { currentIdentity: previous, pairedCoreReleaseId: oldCore, platform: 'linux', arch: 'x64', lastSequence: 7 })
  assert.equal(accepted.identity.pairedCoreReleaseId, newCore)
  assert.equal(accepted.files.find(file => file.role === 'rollback').identity.pairedCoreReleaseId, oldCore)
  const coreThird = { target: coreNext.target, identity: identity({ appVersion: '1.3.0', policyId: corePolicyId, schemaHistory: 3 }) }
  const third = identity({ appVersion: '1.3.0', edition: 'premium', policyId: contract.policyId,
    pairedCoreReleaseId: coreThird.identity.releaseId, schemaHistory: 3 })
  const thirdSigned = { ...signed, sequence: 9, identity: third, supersedes: [next.releaseId],
    requires: { schemaHistory: 3, minimumReadableSchemaHistory: 1 },
    files: [file('application', third), file('rollback', next)],
    pairedCore: { policyId: corePolicyId, channel: 'core-private-test',
      previousIdentity: coreNext.identity, nextIdentity: coreThird.identity } }
  assert.equal(validateUpdateMetadata(envelope(thirdSigned, [signer]), contract,
    { currentIdentity: next, pairedCoreReleaseId: newCore, platform: 'linux', arch: 'x64', lastSequence: 8 })
    .identity.schemaHistory, 3, 'the immutable v0 premium authority accepts its signed v1-to-v2 schema advance')
  const wrongCoreChannel = structuredClone(signed); wrongCoreChannel.pairedCore.channel = 'other-core-train'
  assert.throws(() => validateUpdateMetadata(envelope(wrongCoreChannel, [signer]), contract,
    { currentIdentity: previous, platform: 'linux', arch: 'x64', lastSequence: 7 }), /approved policy.*schema train/)
  const absentCoreEvidence = structuredClone(signed); delete absentCoreEvidence.pairedCore
  assert.throws(() => validateUpdateMetadata(envelope(absentCoreEvidence, [signer]), contract,
    { currentIdentity: previous, platform: 'linux', arch: 'x64', lastSequence: 7 }), /plain object|pairedCore/)
  const pairedPrevious = identity({ appVersion: previous.appVersion, edition: 'premium', policyId: contract.policyId, pairedCoreReleaseId: corePrevious.identity.releaseId })
  const pairedNext = identity({ edition: 'premium', policyId: contract.policyId, pairedCoreReleaseId: coreNext.identity.releaseId, schemaHistory: 2 })
  assert.doesNotThrow(() => validatePremiumCorePairs({
    previous: { target: corePrevious.target, identity: pairedPrevious }, next: { target: coreNext.target, identity: pairedNext },
    corePrevious, coreNext, policy: contract,
  }))
  assert.throws(() => validatePremiumCorePairs({
    previous: { target: corePrevious.target, identity: pairedPrevious }, next: { target: coreNext.target, identity: pairedNext },
    corePrevious, coreNext: { ...coreNext, identity: identity({ appVersion: '1.2.4' }) }, policy: contract,
  }), /new core release IDs|exact application versions/)
  assert.throws(() => validatePremiumCorePairs({
    previous: { target: corePrevious.target, identity: pairedPrevious }, next: { target: coreNext.target, identity: pairedNext },
    corePrevious, coreNext: { ...coreNext, target: { platform: 'win32', arch: 'x64' } }, policy: contract,
  }), /same machine targets/)
  const foreignCoreNext = { ...coreNext, identity: identity({ policyId: 'f'.repeat(64) }) }
  const foreignPairedNext = identity({ edition: 'premium', policyId: contract.policyId,
    pairedCoreReleaseId: foreignCoreNext.identity.releaseId, schemaHistory: 2 })
  assert.throws(() => validatePremiumCorePairs({
    previous: { target: corePrevious.target, identity: pairedPrevious }, next: { target: coreNext.target, identity: foreignPairedNext },
    corePrevious, coreNext: foreignCoreNext, policy: contract,
  }), /approved .*policy.*schema train/)
  const foreignSchemaCore = { ...coreNext, identity: identity({ policyId: corePolicyId, schemaHistory: 3 }) }
  const foreignSchemaPremium = identity({ edition: 'premium', policyId: contract.policyId,
    pairedCoreReleaseId: foreignSchemaCore.identity.releaseId, schemaHistory: 2 })
  assert.throws(() => validatePremiumCorePairs({
    previous: { target: corePrevious.target, identity: pairedPrevious },
    next: { target: coreNext.target, identity: foreignSchemaPremium },
    corePrevious, coreNext: foreignSchemaCore, policy: contract,
  }), /approved .*policy.*schema train/)
  const regressedCorePrevious = { ...corePrevious, identity: identity({ appVersion: '1.2.2', policyId: corePolicyId, schemaHistory: 2 }) }
  const regressedCoreNext = { ...coreNext, identity: identity({ policyId: corePolicyId, schemaHistory: 1 }) }
  const regressionPrevious = identity({ appVersion: '1.2.2', edition: 'premium', policyId: contract.policyId,
    pairedCoreReleaseId: regressedCorePrevious.identity.releaseId, schemaHistory: 2 })
  const regressionNext = identity({ edition: 'premium', policyId: contract.policyId,
    pairedCoreReleaseId: regressedCoreNext.identity.releaseId })
  assert.throws(() => validatePremiumCorePairs({
    previous: { target: corePrevious.target, identity: regressionPrevious },
    next: { target: coreNext.target, identity: regressionNext },
    corePrevious: regressedCorePrevious, coreNext: regressedCoreNext, policy: advancedPolicy,
  }), /approved .*policy.*schema train/)
  const corePolicy = policy(signer, 'core')
  assert.throws(() => validateUpdateMetadata(metadata, corePolicy,
    { currentIdentity: previous, platform: 'linux', arch: 'x64', lastSequence: 7 }), /different edition.*policy/i)
  const otherPremiumPolicy = policy(signer, 'premium', 'premium-other')
  assert.throws(() => validateUpdateMetadata(metadata, otherPremiumPolicy,
    { currentIdentity: previous, platform: 'linux', arch: 'x64', lastSequence: 7 }), /different edition.*policy/i)
})
