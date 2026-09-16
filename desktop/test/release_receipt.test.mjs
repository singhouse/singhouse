// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { canonicalJson, deriveReleaseIdentity, sha256Hex, validateInstalledReleaseReceipt } from '../release.mjs'
import { createPortablePayload, inspectApplicationInventory, inspectPortablePayload, createReleaseReceipt, inspectReleaseReceipt, verifyPackagingSource } from '../build/release_receipt.mjs'

const H = 'c'.repeat(64)
async function identityFor(root, overrides = {}) {
  const { inventoryDigest } = await inspectApplicationInventory(root)
  return deriveReleaseIdentity({ schema: 1, appVersion: '1.0.0', edition: 'core', policyId: H, sourceCommit: 'd'.repeat(40), electronVersion: '44.3.0', electronRuntimeDigest: H, electronAppDigest: sha256Hex('asar'), frontendDigest: H, backendDigest: H, nativeRuntimeId: H, runtimeLocksDigest: H, modelPolicyDigest: H, schemaHistory: 1, assemblyDigest: H, applicationInventoryDigest: inventoryDigest, ...overrides })
}
async function fixture(root, platform) {
  const entrypoint = platform === 'linux' ? 'Singhouse' : platform === 'win32' ? 'Singhouse.exe' : 'Singhouse.app/Contents/MacOS/Singhouse'
  const resources = platform === 'darwin' ? 'Singhouse.app/Contents/Resources' : 'resources'
  await mkdir(resolve(root, resources, 'native'), { recursive: true })
  await mkdir(resolve(root, entrypoint, '..'), { recursive: true })
  await writeFile(resolve(root, entrypoint), 'executable', { mode: 0o755 })
  await writeFile(resolve(root, resources, 'app.asar'), 'asar')
  await writeFile(resolve(root, resources, 'native/manifest.json'), JSON.stringify({ runtimeId: H }))
  await writeFile(resolve(root, resources, 'native/files.json'), '{}')
  return entrypoint
}

for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['darwin', 'arm64']]) test(`portable ${platform}-${arch} is deterministic and self-describing`, async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'portable-'))
  try {
    const app = resolve(temporary, 'app'); const entrypoint = await fixture(app, platform)
    const identity = await identityFor(app)
    const first = resolve(temporary, 'first.shapp'), second = resolve(temporary, 'second.shapp')
    await createPortablePayload({ sourceDirectory: app, output: first, identity, platform, arch, entrypoint })
    await createPortablePayload({ sourceDirectory: app, output: second, identity, platform, arch, entrypoint })
    assert.deepEqual(await readFile(first), await readFile(second))
    const inspected = await inspectPortablePayload(first); assert.equal(inspected.header.target.platform, platform); assert.equal(inspected.header.entrypoint, entrypoint)
    const files = inspected.header.files.map(record => record.type === 'file' ? { type: 'file', path: record.path, sha256: record.sha256 }
      : record.type === 'directory' ? { type: 'directory', path: record.path } : { type: 'symlink', path: record.path, target: record.target })
    const receipt = { schema: 1, kind: 'singhouse-release-receipt', identity, target: { platform, arch },
      application: { schema: 1, entrypoint, inventoryDigest: sha256Hex(canonicalJson(files)), files } }
    const observed = new Map(files.map(record => [record.path, record.type === 'file' ? record.sha256 : record.type === 'directory' ? 'directory' : `symlink:${record.target}`]))
    const receiptPath = platform === 'darwin' ? 'Singhouse.app/Contents/Resources/release-receipt.json' : 'resources/release-receipt.json'
    observed.set(receiptPath, sha256Hex('canonical self-describing receipt'))
    if (platform === 'win32') observed.set('Uninstall Singhouse.exe', sha256Hex('wrapper'))
    assert.equal(validateInstalledReleaseReceipt(receipt, observed, { platform, arch }).releaseId, identity.releaseId)
    observed.set('injected-extra', sha256Hex('injected'))
    assert.throws(() => validateInstalledReleaseReceipt(receipt, observed, { platform, arch }), /unmodeled entry/)
    observed.delete('injected-extra')
    observed.set(entrypoint, sha256Hex('changed'))
    assert.throws(() => validateInstalledReleaseReceipt(receipt, observed, { platform, arch }), /changed/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('portable payload permits npm scope names in packaged notice paths', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'portable-scope-'))
  try {
    const app = resolve(temporary, 'app'); const entrypoint = await fixture(app, 'linux')
    const notice = resolve(app, 'resources/native/notices/frontend/@babel_helper-string-parser')
    await mkdir(notice, { recursive: true }); await writeFile(resolve(notice, 'LICENSE'), 'MIT\n')
    const identity = await identityFor(app)
    const output = resolve(temporary, 'scoped.shapp')
    const result = await createPortablePayload({ sourceDirectory: app, output, identity, platform: 'linux', arch: 'x64', entrypoint })
    assert.ok(result.header.files.some(file => file.path === 'resources/native/notices/frontend/@babel_helper-string-parser/LICENSE'))
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('Linux payload permits the pinned Python terminfo case aliases only', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'portable-terminfo-'))
  try {
    const app = resolve(temporary, 'app'); const entrypoint = await fixture(app, 'linux')
    for (const name of ['E/Eterm', 'e/eterm']) {
      const path = resolve(app, 'resources/native/python/share/terminfo', name)
      await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, name)
    }
    const identity = await identityFor(app)
    await createPortablePayload({ sourceDirectory: app, output: resolve(temporary, 'terminfo.shapp'), identity, platform: 'linux', arch: 'x64', entrypoint })
    await writeFile(resolve(app, 'A'), 'one'); await writeFile(resolve(app, 'a'), 'two')
    await assert.rejects(createPortablePayload({ sourceDirectory: app, output: resolve(temporary, 'collision.shapp'), identity, platform: 'linux', arch: 'x64', entrypoint }), /case-colliding/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('receipt inspects payload bytes and rejects substitution or trailing bytes', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'receipt-'))
  try {
    const app = resolve(temporary, 'app'); await fixture(app, 'linux')
    const native = resolve(app, 'resources/native')
    await mkdir(resolve(native, 'static'), { recursive: true })
    await writeFile(resolve(native, 'backend.py'), 'backend')
    await writeFile(resolve(native, 'static/index.html'), 'frontend')
    await writeFile(resolve(native, 'models.json'), 'models')
    const files = { 'backend.py': sha256Hex('backend'), 'models.json': sha256Hex('models'), 'static/index.html': sha256Hex('frontend') }
    const filesBytes = `${JSON.stringify(files, null, 2)}\n`; await writeFile(resolve(native, 'files.json'), filesBytes)
    const provenance = { sourceCommit: 'd'.repeat(40), sourceDirty: false, sourceExport: false, locks: { 'native.json': H } }
    await writeFile(resolve(native, 'provenance.json'), JSON.stringify(provenance))
    const assembly = { schema: 1, kind: 'singhouse-assembly', edition: 'core', payloadDigest: sha256Hex(canonicalJson(files)) }
    const assemblyBytes = JSON.stringify(assembly); await writeFile(resolve(native, 'assembly.json'), assemblyBytes)
    const nativeRuntimeId = sha256Hex(filesBytes); await writeFile(resolve(native, 'manifest.json'), JSON.stringify({ runtimeId: nativeRuntimeId }))
    const { inventoryDigest } = await inspectApplicationInventory(app)
    const actualIdentity = deriveReleaseIdentity({ schema: 1, appVersion: '1.0.0', edition: 'core', policyId: H, sourceCommit: provenance.sourceCommit, electronVersion: '44.3.0', electronRuntimeDigest: sha256Hex(canonicalJson({ Singhouse: sha256Hex('executable'), resources: 'directory', 'resources/native': 'directory' })), electronAppDigest: sha256Hex('asar'), frontendDigest: sha256Hex(canonicalJson({ 'static/index.html': files['static/index.html'] })), backendDigest: sha256Hex(canonicalJson({ 'backend.py': files['backend.py'] })), nativeRuntimeId, runtimeLocksDigest: sha256Hex(canonicalJson(provenance.locks)), modelPolicyDigest: files['models.json'], schemaHistory: 1, assemblyDigest: sha256Hex(assemblyBytes), applicationInventoryDigest: inventoryDigest })
    const payload = resolve(temporary, 'application.shapp'), receipt = resolve(temporary, 'receipt.json')
    await createPortablePayload({ sourceDirectory: app, output: payload, identity: actualIdentity, platform: 'linux', arch: 'x64' })
    await assert.rejects(createReleaseReceipt({ payload, output: resolve(temporary, 'unchecked-receipt.json'), sourceCommit: actualIdentity.sourceCommit,
      sourceDirty: false, electronVersion: actualIdentity.electronVersion, nativeRuntimeId: actualIdentity.nativeRuntimeId }), /immediate packaging source verification/)
    const verifyCleanSource = () => verifyPackagingSource({ repositoryDirectory: '/source', provenance,
      execFileImpl: async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? `${provenance.sourceCommit}\n` : '' }) })
    await createReleaseReceipt({ payload, output: receipt, sourceCommit: actualIdentity.sourceCommit, sourceDirty: false,
      electronVersion: actualIdentity.electronVersion, nativeRuntimeId: actualIdentity.nativeRuntimeId,
      verifySourceBeforePublish: verifyCleanSource })
    assert.equal((await inspectReleaseReceipt(receipt, payload)).identity.releaseId, actualIdentity.releaseId)
    const rejectedReceipt = resolve(temporary, 'dirty-receipt.json')
    await assert.rejects(createReleaseReceipt({ payload, output: rejectedReceipt, sourceCommit: actualIdentity.sourceCommit,
      sourceDirty: false, electronVersion: actualIdentity.electronVersion, nativeRuntimeId: actualIdentity.nativeRuntimeId,
      verifySourceBeforePublish: () => verifyPackagingSource({ repositoryDirectory: '/source', provenance,
        execFileImpl: async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? `${provenance.sourceCommit}\n` : ' M desktop/main.mjs\n' }) }) }), /clean.*untracked/i)
    await assert.rejects(readFile(rejectedReceipt), /ENOENT/)
    await writeFile(payload, Buffer.concat([await readFile(payload), Buffer.from('x')]))
    await assert.rejects(inspectReleaseReceipt(receipt, payload), /boundary|trailing|missing/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('portable inventory preserves internal symlinks and rejects escapes and cycles', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'portable-links-'))
  try {
    const app = resolve(temporary, 'app'); await fixture(app, 'darwin')
    const versions = resolve(app, 'Singhouse.app/Contents/Frameworks/Example.framework/Versions')
    await mkdir(resolve(versions, 'A'), { recursive: true }); await writeFile(resolve(versions, 'A/library'), 'library')
    await symlink('A', resolve(versions, 'Current'))
    const identity = await identityFor(app)
    const payload = resolve(temporary, 'links.shapp')
    const result = await createPortablePayload({ sourceDirectory: app, output: payload, identity, platform: 'darwin', arch: 'arm64' })
    assert.deepEqual(result.header.files.find(record => record.path.endsWith('/Versions/Current')), { type: 'symlink', path: 'Singhouse.app/Contents/Frameworks/Example.framework/Versions/Current', target: 'Singhouse.app/Contents/Frameworks/Example.framework/Versions/A' })
    await symlink('../../../../../../outside', resolve(versions, 'Escape'))
    await assert.rejects(createPortablePayload({ sourceDirectory: app, output: resolve(temporary, 'escape.shapp'), identity, platform: 'darwin', arch: 'arm64' }), /escapes payload/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('packaging rechecks exact Git HEAD and the complete dirty and untracked set', async () => {
  const provenance = { sourceCommit: 'd'.repeat(40), sourceDirty: false, sourceExport: false }
  const calls = []
  const clean = async (command, args, options) => {
    calls.push({ command, args, options })
    return { stdout: args[0] === 'rev-parse' ? `${provenance.sourceCommit}\n` : '' }
  }
  assert.equal(await verifyPackagingSource({ repositoryDirectory: '/source', provenance, execFileImpl: clean }), provenance.sourceCommit)
  assert.deepEqual(calls.map(call => call.args), [
    ['rev-parse', '--verify', 'HEAD'],
    ['status', '--porcelain=v1', '--untracked-files=all'],
  ])
  await assert.rejects(verifyPackagingSource({ repositoryDirectory: '/source', provenance,
    execFileImpl: async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? `${provenance.sourceCommit}\n` : '?? untracked.bin\n' }) }), /clean.*untracked/i)
  await assert.rejects(verifyPackagingSource({ repositoryDirectory: '/source', provenance,
    execFileImpl: async (_command, args) => ({ stdout: args[0] === 'rev-parse' ? `${'e'.repeat(40)}\n` : '' }) }), /exactly match/i)
})

test('export packaging fails closed until a separately authenticated manifest verifier exists', async () => {
  const provenance = { sourceCommit: 'd'.repeat(40), sourceDirty: null, sourceExport: true }
  await assert.rejects(verifyPackagingSource({ repositoryDirectory: '/export', provenance }), /authenticated source manifest.*no verifier/i)
})
