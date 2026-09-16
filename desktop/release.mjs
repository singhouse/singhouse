// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = dirname(fileURLToPath(import.meta.url))
const HEX_64 = /^[0-9a-f]{64}$/
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const APP_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
const P = (1n << 255n) - 19n
const L = (1n << 252n) + 27742317777372353535851937790883648493n
const D = mod(-121665n * invert(121666n))
const I = pow(2n, (P - 1n) / 4n)
const IDENTITY = { x: 0n, y: 1n }
export const PORTABLE_MAGIC = Buffer.from('SINGHOUSEAPP\0\r\n\x1a', 'binary')
const SAFE_PORTABLE_PART = /^[A-Za-z0-9@._+() -]+$/
function safePortablePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 1024 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part =>
    SAFE_PORTABLE_PART.test(part) && part.trim() === part && !['', '.', '..'].includes(part) && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

function mod(n) { const value = n % P; return value < 0n ? value + P : value }
function pow(base, exponent) { let out = 1n; for (base = mod(base); exponent; exponent >>= 1n, base = mod(base * base)) if (exponent & 1n) out = mod(out * base); return out }
function invert(n) { return pow(n, P - 2n) }
function littleInteger(bytes) { let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n }
function add(a, b) {
  const xy = mod(a.x * b.x * a.y * b.y)
  return {
    x: mod((a.x * b.y + a.y * b.x) * invert(1n + D * xy)),
    y: mod((a.y * b.y + a.x * b.x) * invert(1n - D * xy)),
  }
}
function multiply(point, scalar) { let out = IDENTITY; for (; scalar; scalar >>= 1n, point = add(point, point)) if (scalar & 1n) out = add(out, point); return out }
function decodePoint(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error('Ed25519 point must be exactly 32 bytes')
  const copy = Buffer.from(bytes); const sign = copy[31] >>> 7; copy[31] &= 0x7f
  const y = littleInteger(copy)
  if (y >= P) throw new Error('Ed25519 point is not canonically encoded')
  const xx = mod((y * y - 1n) * invert(D * y * y + 1n))
  let x = pow(xx, (P + 3n) / 8n)
  if (mod(x * x - xx) !== 0n) x = mod(x * I)
  if (mod(x * x - xx) !== 0n || (x === 0n && sign)) throw new Error('Invalid Ed25519 point')
  if (Number(x & 1n) !== sign) x = P - x
  return { x, y }
}
function isIdentity(point) { return point.x === 0n && point.y === 1n }
function assertPrimeSubgroup(bytes, label) {
  const point = decodePoint(bytes)
  if (isIdentity(point) || !isIdentity(multiply(point, L))) throw new Error(`${label} is not in the prime-order Ed25519 subgroup`)
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new TypeError('Release documents allow only JSON objects, arrays, strings, booleans, null, and safe integers')
}
export function sha256Hex(value) { return createHash('sha256').update(value).digest('hex') }

export function compareAppVersions(left, right) {
  if (!APP_VERSION.test(left) || !APP_VERSION.test(right)) throw new Error('Application versions must be canonical MAJOR.MINOR.PATCH')
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  return 0
}

function exactKeys(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Expected a plain object')
  const allowed = new Set([...required, ...optional])
  for (const key of required) if (!(key in value)) throw new Error(`Missing ${key}`)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown field ${key}`)
}

export function deriveReleaseIdentity(components) {
  exactKeys(components, ['schema', 'appVersion', 'edition', 'policyId', 'sourceCommit', 'electronVersion', 'electronRuntimeDigest', 'electronAppDigest', 'frontendDigest', 'backendDigest', 'nativeRuntimeId', 'runtimeLocksDigest', 'modelPolicyDigest', 'schemaHistory', 'assemblyDigest', 'applicationInventoryDigest'], ['pairedCoreReleaseId'])
  if (components.schema !== 1 || !Number.isSafeInteger(components.schemaHistory) || components.schemaHistory < 1) throw new Error('Unsupported release identity schema')
  if (!APP_VERSION.test(components.appVersion) || !SEMVER.test(components.electronVersion)) throw new Error('Release versions must be canonical semantic versions')
  if (!/^[0-9a-f]{40}$/.test(components.sourceCommit)) throw new Error('Release identity requires a full source commit')
  for (const key of ['policyId', 'electronRuntimeDigest', 'electronAppDigest', 'frontendDigest', 'backendDigest', 'nativeRuntimeId', 'runtimeLocksDigest', 'modelPolicyDigest', 'assemblyDigest', 'applicationInventoryDigest']) if (!HEX_64.test(components[key])) throw new Error(`Invalid ${key}`)
  if (!['core', 'premium'].includes(components.edition)) throw new Error('Invalid release edition')
  if (components.edition === 'premium' && !HEX_64.test(components.pairedCoreReleaseId || '')) throw new Error('Premium releases require an exact paired core release ID')
  if (components.edition === 'core' && components.pairedCoreReleaseId != null) throw new Error('Core releases cannot declare a paired core release')
  const body = structuredClone(components)
  return { ...body, releaseId: sha256Hex(canonicalJson(body)) }
}

export function assertReleaseIdentity(identity) {
  exactKeys(identity, ['schema', 'appVersion', 'edition', 'policyId', 'sourceCommit', 'electronVersion', 'electronRuntimeDigest', 'electronAppDigest', 'frontendDigest', 'backendDigest', 'nativeRuntimeId', 'runtimeLocksDigest', 'modelPolicyDigest', 'schemaHistory', 'assemblyDigest', 'applicationInventoryDigest', 'releaseId'], ['pairedCoreReleaseId'])
  const { releaseId, ...body } = identity
  const derived = deriveReleaseIdentity(body)
  if (releaseId !== derived.releaseId) throw new Error('Release identity is not content-derived')
  return identity
}

export function derivePolicyId(policy) {
  // A premium policy approves the core authority/train, while the nested
  // schema bounds are moving compatibility state.  Do not turn an ordinary,
  // compatible core migration into a new premium signing authority.
  const approvedCoreAuthority = policy.approvedCorePolicy === undefined ? undefined : {
    schema: policy.approvedCorePolicy.schema,
    channel: policy.approvedCorePolicy.channel,
    edition: policy.approvedCorePolicy.edition,
    policyId: policy.approvedCorePolicy.policyId,
    updatesEnabled: policy.approvedCorePolicy.updatesEnabled,
    signatureThreshold: policy.approvedCorePolicy.signatureThreshold,
    trustedUpdateKeys: policy.approvedCorePolicy.trustedUpdateKeys,
    ...(policy.approvedCorePolicy.platformTrust === undefined ? {} : { platformTrust: policy.approvedCorePolicy.platformTrust }),
  }
  const authority = { schema: policy.schema, channel: policy.channel, edition: policy.edition,
    updatesEnabled: policy.updatesEnabled, signatureThreshold: policy.signatureThreshold, trustedUpdateKeys: policy.trustedUpdateKeys,
    ...(approvedCoreAuthority === undefined ? {} : { approvedCorePolicy: approvedCoreAuthority }),
    ...(policy.platformTrust === undefined ? {} : { platformTrust: policy.platformTrust }) }
  return sha256Hex(canonicalJson(authority))
}

export function assertReleasePolicy(policy) {
  exactKeys(policy, ['schema', 'channel', 'edition', 'policyId', 'schemaHistory', 'minimumReadableSchemaHistory', 'updatesEnabled', 'signatureThreshold', 'trustedUpdateKeys'], ['platformTrust', 'approvedCorePolicy'])
  if (policy.schema !== 1 || !['core', 'premium'].includes(policy.edition) || !Number.isSafeInteger(policy.schemaHistory)
      || policy.schemaHistory < 1 || !Number.isSafeInteger(policy.minimumReadableSchemaHistory)
      || policy.minimumReadableSchemaHistory < 1 || policy.minimumReadableSchemaHistory > policy.schemaHistory
      || typeof policy.updatesEnabled !== 'boolean'
      || !Number.isSafeInteger(policy.signatureThreshold) || policy.signatureThreshold < 1
      || !Array.isArray(policy.trustedUpdateKeys)) throw new Error('Invalid release policy')
  const keyIds = new Set(), keyMaterial = new Set()
  for (const record of policy.trustedUpdateKeys) {
    exactKeys(record, ['id', 'publicKey'])
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.id || '')) throw new Error('Invalid update signing key ID')
    const canonicalKey = validateEd25519PublicKey(record.publicKey).toString('base64')
    if (keyIds.has(record.id)) throw new Error('Release policy update signing key IDs must be distinct')
    if (keyMaterial.has(canonicalKey)) throw new Error('Release policy Ed25519 public keys must be distinct')
    keyIds.add(record.id); keyMaterial.add(canonicalKey)
  }
  if (policy.updatesEnabled) {
    if (keyIds.size === 0 || policy.signatureThreshold > keyIds.size) throw new Error('Enabled release policy signature threshold exceeds its unique trusted keys')
  } else if (keyIds.size !== 0) throw new Error('Disabled release policy cannot trust update signing keys')
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(policy.channel || '') || policy.policyId !== derivePolicyId(policy)) throw new Error('Release policy identity is inconsistent')
  if (policy.edition === 'premium') {
    const core = assertReleasePolicy(policy.approvedCorePolicy)
    if (core.edition !== 'core') throw new Error('Premium policy must approve an exact core policy/train')
  } else if (policy.approvedCorePolicy !== undefined) throw new Error('Core policy cannot approve another core policy')
  if (policy.platformTrust !== undefined) {
    exactKeys(policy.platformTrust, [], ['darwin', 'win32'])
    for (const [platform, expectedMode] of [['darwin', 'codesign'], ['win32', 'authenticode']]) {
      const trust = policy.platformTrust[platform]
      if (trust === undefined) continue
      exactKeys(trust, ['enabled', 'mode'])
      if (typeof trust.enabled !== 'boolean' || trust.mode !== expectedMode) throw new Error(`Invalid ${platform} platform trust policy`)
    }
  }
  return policy
}
export function loadReleasePolicy(path = resolve(DESKTOP, 'release.json')) { return assertReleasePolicy(JSON.parse(readFileSync(path, 'utf8'))) }
export function loadReleaseIdentity(path) { return assertReleaseIdentity(JSON.parse(readFileSync(path, 'utf8'))) }

function rawPublicKey(value) {
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid canonical Ed25519 public key')
  return key
}
export function validateEd25519PublicKey(value) { const key = rawPublicKey(value); assertPrimeSubgroup(key, 'Public key'); return key }

export function verifySignedEnvelope(envelope, trustedKeys, threshold = 1) {
  exactKeys(envelope, ['schema', 'signed', 'signatures'])
  if (envelope.schema !== 1 || !Array.isArray(envelope.signatures) || !Number.isSafeInteger(threshold) || threshold < 1) throw new Error('Invalid signed envelope')
  const trusted = new Map(trustedKeys.map(record => {
    exactKeys(record, ['id', 'publicKey'])
    return [record.id, validateEd25519PublicKey(record.publicKey)]
  }))
  const message = Buffer.from(canonicalJson(envelope.signed))
  const accepted = new Set()
  for (const record of envelope.signatures) {
    exactKeys(record, ['keyId', 'signature'])
    if (accepted.has(record.keyId) || !trusted.has(record.keyId)) continue
    const signature = Buffer.from(record.signature, 'base64')
    if (signature.length !== 64 || signature.toString('base64') !== record.signature) continue
    const R = signature.subarray(0, 32); const S = littleInteger(signature.subarray(32))
    try { assertPrimeSubgroup(R, 'Signature R') } catch { continue }
    if (S >= L) continue
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), trusted.get(record.keyId)])
    if (cryptoVerify(null, message, createPublicKey({ key: der, format: 'der', type: 'spki' }), signature)) accepted.add(record.keyId)
  }
  if (accepted.size < threshold) throw new Error(`Update metadata signature threshold not met (${accepted.size}/${threshold})`)
  return envelope.signed
}

export function parsePortablePayload(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || !bytes.subarray(0, 16).equals(PORTABLE_MAGIC)) throw new Error('Invalid portable application magic')
  const headerLength = bytes.readUInt32BE(16); const dataStart = 20 + headerLength
  if (headerLength < 2 || dataStart > bytes.length) throw new Error('Truncated portable application header')
  const rawHeader = bytes.subarray(20, dataStart).toString('utf8'); const header = JSON.parse(rawHeader)
  if (canonicalJson(header) !== rawHeader || header.schema !== 1 || header.kind !== 'singhouse-portable-application') throw new Error('Non-canonical portable application header')
  exactKeys(header, ['schema', 'kind', 'identity', 'target', 'entrypoint', 'files'])
  exactKeys(header.target, ['platform', 'arch'])
  assertReleaseIdentity(header.identity)
  if (!safePortablePath(header.entrypoint) || !((header.target.platform === 'linux' && ['x64', 'arm64'].includes(header.target.arch)) || (header.target.platform === 'win32' && header.target.arch === 'x64') || (header.target.platform === 'darwin' && header.target.arch === 'arm64')) || !Array.isArray(header.files) || !header.files.length) throw new Error('Invalid portable target or inventory')
  let next = 0; let previous = ''; const folded = new Map()
  for (const file of header.files) {
    const lower = String(file?.path).toLowerCase()
    const prior = folded.get(lower)
    const allowedTerminfoAlias = prior && header.target.platform === 'linux' && prior.startsWith('resources/native/python/share/terminfo/') && file?.path?.startsWith('resources/native/python/share/terminfo/')
    if (!file || !safePortablePath(file.path) || file.path <= previous || (prior && !allowedTerminfoAlias) || !['file', 'directory', 'symlink'].includes(file.type)) throw new Error('Invalid portable inventory')
    if (file.type === 'file') {
      if (Object.keys(file).sort().join(',') !== 'mode,offset,path,sha256,size,type' || file.offset !== next || !Number.isSafeInteger(file.size) || file.size < 0 || ![0o644, 0o755].includes(file.mode) || !HEX_64.test(file.sha256)) throw new Error('Invalid portable file record')
      const payload = bytes.subarray(dataStart + file.offset, dataStart + file.offset + file.size)
      if (payload.length !== file.size || sha256Hex(payload) !== file.sha256) throw new Error(`Portable file checksum mismatch: ${file.path}`)
      next += file.size
    } else if (file.type === 'directory') {
      if (Object.keys(file).sort().join(',') !== 'mode,path,type' || file.mode !== 0o755) throw new Error('Invalid portable directory record')
    } else if (Object.keys(file).sort().join(',') !== 'path,target,type' || !safePortablePath(file.target)) throw new Error('Invalid portable symlink record')
    previous = file.path; folded.set(lower, file.path)
  }
  const names = new Map(header.files.map(record => [record.path, record]))
  for (const record of header.files.filter(record => record.type === 'symlink')) {
    if (!names.has(record.target)) throw new Error('Portable symlink target is absent')
    const seen = new Set([record.path]); let target = names.get(record.target)
    while (target?.type === 'symlink') { if (seen.has(target.path)) throw new Error('Portable symlink cycle'); seen.add(target.path); target = names.get(target.target) }
  }
  if (dataStart + next !== bytes.length || header.files.find(file => file.path === header.entrypoint)?.mode !== 0o755) throw new Error('Portable payload boundary or entrypoint is invalid')
  return { header, dataStart, bytes }
}
export function portableFileBytes(parsed, path) {
  const file = parsed.header.files.find(record => record.path === path)
  if (!file || file.type !== 'file') throw new Error(`Portable file is absent: ${path}`)
  return parsed.bytes.subarray(parsed.dataStart + file.offset, parsed.dataStart + file.offset + file.size)
}
export async function inspectPortablePayload(path) {
  const parsed = parsePortablePayload(await readFile(path)); const info = parsed.bytes
  return { path: resolve(path), size: info.length, sha256: sha256Hex(info), header: parsed.header, dataStart: parsed.dataStart }
}

export function validateInstalledReleaseReceipt(receipt, observedRecords, target) {
  if (!receipt || receipt.schema !== 1 || receipt.kind !== 'singhouse-release-receipt' ||
      !receipt.application || receipt.application.schema !== 1 || !Array.isArray(receipt.application.files) ||
      typeof receipt.application.entrypoint !== 'string') throw new Error('Invalid installed release receipt')
  assertReleaseIdentity(receipt.identity)
  if (canonicalJson(receipt.target) !== canonicalJson(target) ||
      receipt.application.inventoryDigest !== sha256Hex(canonicalJson(receipt.application.files)) ||
      receipt.application.inventoryDigest !== receipt.identity.applicationInventoryDigest) throw new Error('Installed release receipt evidence is inconsistent')
  const expected = new Map()
  let previous = ''; const folded = new Set()
  for (const record of receipt.application.files) {
    const lower = String(record?.path).toLowerCase()
    if (!record || !safePortablePath(record.path) || record.path <= previous || folded.has(lower) || !['file', 'directory', 'symlink'].includes(record.type) ||
        (record.type === 'file' && (Object.keys(record).sort().join(',') !== 'path,sha256,type' || !HEX_64.test(record.sha256))) ||
        (record.type === 'directory' && Object.keys(record).sort().join(',') !== 'path,type') ||
        (record.type === 'symlink' && (Object.keys(record).sort().join(',') !== 'path,target,type' || !safePortablePath(record.target)))) throw new Error('Invalid installed application inventory')
    expected.set(record.path, record.type === 'file' ? record.sha256 : record.type === 'directory' ? 'directory' : `symlink:${record.target}`)
    previous = record.path; folded.add(lower)
  }
  if (!expected.has(receipt.application.entrypoint)) throw new Error('Installed application entrypoint is absent from its receipt')
  for (const [path, value] of expected) if (observedRecords.get(path) !== value) throw new Error(`Installed application changed: ${path}`)
  const receiptPath = target.platform === 'darwin' ? 'Singhouse.app/Contents/Resources/release-receipt.json' : 'resources/release-receipt.json'
  const exclusions = new Set([receiptPath, ...(target.platform === 'win32' ? ['Uninstall Singhouse.exe'] : [])])
  if (!observedRecords.has(receiptPath)) throw new Error('Installed application release receipt is absent')
  for (const path of observedRecords.keys()) {
    if (!expected.has(path) && !exclusions.has(path)) throw new Error(`Installed application contains an unmodeled entry: ${path}`)
  }
  const observedInventory = [...observedRecords.entries()]
    .filter(([path]) => !exclusions.has(path))
    .map(([path, value]) => value === 'directory' ? { path, type: 'directory' }
      : value.startsWith('symlink:') ? { path, type: 'symlink', target: value.slice('symlink:'.length) }
        : { path, type: 'file', sha256: value })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  if (sha256Hex(canonicalJson(observedInventory)) !== receipt.identity.applicationInventoryDigest) {
    throw new Error('Installed application inventory identity changed')
  }
  return receipt.identity
}

export function validateUpdateMetadata(metadata, contract, expected) {
  assertReleasePolicy(contract)
  if (!contract.updatesEnabled) throw new Error('Application updates are explicitly disabled by this release policy')
  const signed = verifySignedEnvelope(metadata, contract.trustedUpdateKeys, contract.signatureThreshold)
  exactKeys(signed, ['schema', 'kind', 'edition', 'channel', 'policyId', 'sequence', 'identity', 'supersedes', 'requires', 'files'], ['pairedCore'])
  if (signed.schema !== 1 || signed.kind !== 'singhouse-update-metadata' || !Number.isSafeInteger(signed.sequence) || signed.sequence <= (expected.lastSequence ?? -1)) throw new Error('Invalid or replayed update sequence')
  assertReleaseIdentity(signed.identity)
  if (signed.edition !== contract.edition || signed.channel !== contract.channel || signed.policyId !== contract.policyId
      || signed.identity.edition !== contract.edition || signed.identity.policyId !== contract.policyId) throw new Error('Update metadata belongs to a different edition, channel, or release policy')
  exactKeys(signed.requires, ['schemaHistory', 'minimumReadableSchemaHistory'])
  if (!Number.isSafeInteger(signed.requires.schemaHistory) || !Number.isSafeInteger(signed.requires.minimumReadableSchemaHistory)
      || signed.requires.minimumReadableSchemaHistory < 1 || signed.identity.schemaHistory !== signed.requires.schemaHistory
      || signed.requires.minimumReadableSchemaHistory > signed.requires.schemaHistory) throw new Error('Incompatible database schema history')
  if (!Array.isArray(signed.supersedes) || signed.supersedes.length !== 1 || !HEX_64.test(signed.supersedes[0])) throw new Error('Update must name exactly one superseded release')
  if (expected.currentIdentity) {
    assertReleaseIdentity(expected.currentIdentity)
    if (signed.supersedes[0] !== expected.currentIdentity.releaseId || expected.currentIdentity.edition !== contract.edition
        || expected.currentIdentity.policyId !== contract.policyId || expected.currentIdentity.schemaHistory < contract.schemaHistory
        || compareAppVersions(signed.identity.appVersion, expected.currentIdentity.appVersion) <= 0) {
      throw new Error('Update does not exactly and monotonically supersede the installed release, edition, and policy')
    }
    if (signed.identity.schemaHistory < expected.currentIdentity.schemaHistory
        || signed.requires.minimumReadableSchemaHistory > expected.currentIdentity.schemaHistory) throw new Error('Update schema history is not monotonically compatible')
  }
  if (!Array.isArray(signed.files) || signed.files.length !== 2) throw new Error('Update requires application and rollback portable artifacts')
  const byRole = new Map(signed.files.map(file => [file.role, file]))
  if (byRole.size !== 2 || !byRole.has('application') || !byRole.has('rollback')) throw new Error('Update artifact roles are invalid')
  for (const [role, file] of byRole) {
    exactKeys(file, ['role', 'name', 'size', 'sha256', 'identity', 'platform', 'arch'], ['url'])
    const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.shapp$/.test(file.name) || file.name.includes('..') || reserved.test(file.name) || (file.url !== undefined && (typeof file.url !== 'string' || !file.url.startsWith('https://'))) || !Number.isSafeInteger(file.size) || file.size < 1 || !HEX_64.test(file.sha256) || file.platform !== expected.platform || file.arch !== expected.arch) throw new Error(`Invalid ${role} artifact`)
    assertReleaseIdentity(file.identity)
    if (file.identity.edition !== contract.edition || file.identity.policyId !== contract.policyId) throw new Error(`Invalid ${role} edition policy`)
  }
  if (byRole.get('application').name.toLowerCase() === byRole.get('rollback').name.toLowerCase()) throw new Error('Application and rollback artifact names must be distinct')
  const rollback = byRole.get('rollback').identity
  if (signed.identity.releaseId === rollback.releaseId || byRole.get('application').identity.releaseId !== signed.identity.releaseId || rollback.releaseId !== signed.supersedes[0] || rollback.edition !== signed.identity.edition || rollback.policyId !== signed.policyId || signed.requires.minimumReadableSchemaHistory > rollback.schemaHistory) throw new Error('Update artifacts do not bind compatible target and rollback identities')
  if (signed.identity.edition === 'premium' && (!HEX_64.test(signed.identity.pairedCoreReleaseId || '')
      || !HEX_64.test(rollback.pairedCoreReleaseId || ''))) throw new Error('Premium update does not bind both signed core pair identities')
  if (signed.identity.edition === 'premium') {
    exactKeys(signed.pairedCore, ['policyId', 'channel', 'previousIdentity', 'nextIdentity'])
    const approved = contract.approvedCorePolicy
    const corePrevious = assertReleaseIdentity(signed.pairedCore.previousIdentity)
    const coreNext = assertReleaseIdentity(signed.pairedCore.nextIdentity)
    if (signed.pairedCore.policyId !== approved.policyId || signed.pairedCore.channel !== approved.channel ||
        corePrevious.edition !== 'core' || coreNext.edition !== 'core' ||
        corePrevious.policyId !== approved.policyId || coreNext.policyId !== approved.policyId ||
        corePrevious.releaseId !== rollback.pairedCoreReleaseId || coreNext.releaseId !== signed.identity.pairedCoreReleaseId ||
        corePrevious.appVersion !== rollback.appVersion || coreNext.appVersion !== signed.identity.appVersion ||
        corePrevious.schemaHistory < approved.schemaHistory ||
        corePrevious.schemaHistory !== rollback.schemaHistory || coreNext.schemaHistory !== signed.identity.schemaHistory ||
        corePrevious.schemaHistory < approved.minimumReadableSchemaHistory ||
        corePrevious.schemaHistory > coreNext.schemaHistory) throw new Error('Premium update core pairing is outside the approved policy/channel/schema train')
  } else if (signed.pairedCore !== undefined) throw new Error('Core update cannot contain a premium core pairing')
  return signed
}
