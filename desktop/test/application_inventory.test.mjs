// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNativeInventoryDeclared, declaredApplicationDigest, declaredFileDigests, observeReceiptApplication, physicalApplicationRecords, physicalFileHash, readLaunchInventory, readOnlyApplicationRoot, UNDECLARED_FILE, writeLaunchInventory } from '../application_inventory.mjs'
import { canonicalJson, deriveReleaseIdentity, sha256Hex, validateInstalledReleaseReceipt } from '../release.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('application inventory hashes an asar as a physical archive file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'physical-application-'))
  try {
    await mkdir(join(root, 'resources'))
    await writeFile(join(root, 'resources', 'app.asar'), 'physical archive bytes')
    assert.deepEqual(physicalApplicationRecords(root, fs), [
      ['resources', 'directory'],
      ['resources/app.asar', digest('physical archive bytes')],
    ])
    assert.equal(physicalFileHash(join(root, 'resources', 'app.asar'), fs), digest('physical archive bytes'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Builds an installed-layout fixture and its receipt from a full content walk,
// as packaging records it.
async function receiptFixture(root) {
  await mkdir(join(root, 'resources', 'native', 'static'), { recursive: true })
  await writeFile(join(root, 'Singhouse'), 'executable')
  await writeFile(join(root, 'resources', 'app.asar'), 'physical archive bytes')
  await writeFile(join(root, 'resources', 'native', 'static', 'index.html'), '<!doctype html>')
  await writeFile(join(root, 'resources', 'native', 'backend.py'), 'print()')
  await writeFile(join(root, 'resources', 'native', 'files.json'), '{}')
  if (process.platform !== 'win32') await symlink('static/index.html', join(root, 'resources', 'native', 'index-link'))
  await writeFile(join(root, 'resources', 'release-receipt.json'), 'receipt placeholder')
  const hashed = physicalApplicationRecords(root, fs)
  const files = hashed.filter(([path]) => path !== 'resources/release-receipt.json')
    .map(([path, value]) => value === 'directory' ? { path, type: 'directory' }
      : value.startsWith('symlink:') ? { path, type: 'symlink', target: value.slice('symlink:'.length) } : { path, type: 'file', sha256: value })
  const inventoryDigest = sha256Hex(canonicalJson(files))
  const H = 'c'.repeat(64)
  const identity = deriveReleaseIdentity({ schema: 1, appVersion: '1.0.0', edition: 'core', policyId: H, sourceCommit: 'd'.repeat(40),
    electronVersion: '44.3.0', electronRuntimeDigest: H, electronAppDigest: physicalFileHash(join(root, 'resources', 'app.asar'), fs),
    frontendDigest: H, backendDigest: H, nativeRuntimeId: H, runtimeLocksDigest: H, modelPolicyDigest: H, schemaHistory: 1,
    assemblyDigest: H, applicationInventoryDigest: inventoryDigest })
  const receipt = { schema: 1, kind: 'singhouse-release-receipt', identity, target: { platform: 'linux', arch: 'x64' },
    application: { schema: 1, entrypoint: 'Singhouse', inventoryDigest, files } }
  return { hashed, receipt }
}

// A filesystem view on which opening or reading any file's bytes fails the test.
const noReads = new Proxy(fs, { get: (target, name) => ['readFileSync', 'openSync'].includes(name)
  ? () => { throw new Error('payload bytes were read') } : target[name] })

test('receipt launch walk takes declared digests, derives the identical identity and reads no payload bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'receipt-application-'))
  try {
    const { hashed, receipt } = await receiptFixture(root)
    const declared = physicalApplicationRecords(root, noReads, root, declaredFileDigests(receipt))
    const receiptPath = 'resources/release-receipt.json'
    // Identical records apart from the excluded receipt itself.
    assert.deepEqual(declared.filter(([path]) => path !== receiptPath), hashed.filter(([path]) => path !== receiptPath))
    assert.equal(new Map(declared).get(receiptPath), UNDECLARED_FILE)
    const target = { platform: 'linux', arch: 'x64' }
    const fromHashes = validateInstalledReleaseReceipt(receipt, new Map(hashed), target)
    const fromDeclarations = validateInstalledReleaseReceipt(receipt, new Map(declared), target)
    assert.deepEqual(fromDeclarations, fromHashes)
    // The archive digest the launcher now takes from the receipt is the
    // value hashing the archive gives, so the derived release ID is unchanged.
    const declaredAsar = receipt.application.files.find(record => record.path === 'resources/app.asar').sha256
    assert.equal(declaredAsar, physicalFileHash(join(root, 'resources', 'app.asar'), fs))
    const { releaseId, ...inputs } = receipt.identity
    assert.equal(deriveReleaseIdentity({ ...inputs, electronAppDigest: declaredAsar }).releaseId, fromHashes.releaseId)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('receipt launch walk still rejects missing, extra, retyped, relinked and escaping entries', async () => {
  const target = { platform: 'linux', arch: 'x64' }
  const damages = [
    [root => rm(join(root, 'resources', 'native', 'backend.py')), /changed: resources\/native\/backend.py/],
    [root => writeFile(join(root, 'resources', 'native', 'extra.py'), 'print()'), /unmodeled entry/],
    [async root => { await rm(join(root, 'resources', 'native', 'backend.py')); await mkdir(join(root, 'resources', 'native', 'backend.py')) }, /changed/],
    [root => rm(join(root, 'resources', 'release-receipt.json')), /receipt is absent/],
  ]
  if (process.platform !== 'win32') {
    damages.push([async root => { await rm(join(root, 'resources', 'native', 'index-link')); await symlink('backend.py', join(root, 'resources', 'native', 'index-link')) }, /changed/])
    damages.push([async root => { await rm(join(root, 'resources', 'native', 'backend.py')); await symlink('static/index.html', join(root, 'resources', 'native', 'backend.py')) }, /changed/])
    damages.push([root => symlink('../../outside', join(root, 'resources', 'escape')), /escapes its bundle/])
  }
  for (const [damage, expected] of damages) {
    const root = await mkdtemp(join(tmpdir(), 'receipt-damage-'))
    try {
      const { receipt } = await receiptFixture(root)
      await damage(root)
      assert.throws(() => validateInstalledReleaseReceipt(receipt,
        new Map(physicalApplicationRecords(root, noReads, root, declaredFileDigests(receipt))), target), expected)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

// Counts payload reads through the filesystem view the walk uses.
function countingFs() {
  const view = { reads: 0 }
  view.fs = new Proxy(fs, { get: (target, name) => name === 'readFileSync'
    ? (...args) => { view.reads++; return target.readFileSync(...args) } : target[name] })
  return view
}

test('only kernel-verified read-only AppImage evidence covering the root skips launch hashing', () => {
  const evidence = { readOnly: true, mountPath: '/tmp/.mount_singhouse' }
  assert.equal(readOnlyApplicationRoot(evidence, '/tmp/.mount_singhouse'), true)
  assert.equal(readOnlyApplicationRoot(evidence, '/tmp/.mount_singhouse/usr'), true)
  assert.equal(readOnlyApplicationRoot(evidence, '/opt/singhouse'), false)
  assert.equal(readOnlyApplicationRoot(evidence, '/tmp/.mount_singhouse-other'), false)
  assert.equal(readOnlyApplicationRoot({ ...evidence, readOnly: false }, '/tmp/.mount_singhouse'), false)
  assert.equal(readOnlyApplicationRoot({ readOnly: true, mountPath: 'relative' }, 'relative'), false)
  assert.equal(readOnlyApplicationRoot({ mountPath: '/tmp/.mount_singhouse' }, '/tmp/.mount_singhouse'), false)
  assert.equal(readOnlyApplicationRoot(null, '/tmp/.mount_singhouse'), false)
})

test('receipt launch modes: read-only and cached launches read no bytes; stale or foreign caches hash in full', async () => {
  const root = await mkdtemp(join(tmpdir(), 'receipt-modes-'))
  try {
    const { receipt } = await receiptFixture(root)
    const target = { platform: 'linux', arch: 'x64' }
    const observe = (physicalFs, options = {}) => observeReceiptApplication({ rootDirectory: root, physicalFs, receipt, target, ...options })

    const readOnly = observe(noReads, { readOnly: true })
    assert.equal(readOnly.mode, 'read-only')
    assert.equal(readOnly.launchInventory, undefined)

    // A writable installation's first launch hashes every file and returns
    // the launch inventory to record.
    const first = countingFs()
    const hashed = observe(first.fs)
    assert.equal(hashed.mode, 'hashed')
    assert.ok(first.reads > 0)
    const inventory = hashed.launchInventory
    assert.equal(inventory.applicationRoot, root)
    assert.equal(inventory.inventoryDigest, receipt.application.inventoryDigest)
    const backendInfo = fs.lstatSync(join(root, 'resources/native/backend.py'))
    assert.deepEqual(inventory.files['resources/native/backend.py'],
      [7, backendInfo.mtimeMs, backendInfo.ctimeMs, backendInfo.ino, backendInfo.dev])
    assert.ok(Object.hasOwn(inventory.files, 'resources/release-receipt.json'))

    // Later launches compare sizes and times only.
    const cached = observe(noReads, { launchInventory: JSON.parse(JSON.stringify(inventory)) })
    assert.equal(cached.mode, 'cached')
    assert.equal(cached.launchInventory, undefined)
    assert.deepEqual(cached.identity, hashed.identity)
    assert.deepEqual(readOnly.identity, hashed.identity)
    assert.deepEqual(cached.records.filter(([path]) => path !== 'resources/release-receipt.json'),
      hashed.records.filter(([path]) => path !== 'resources/release-receipt.json'))

    // Missing, foreign or malformed caches fall back to the full walk, which
    // still accepts an intact installation with the same identity.
    const files = inventory.files
    const firstFile = 'resources/native/backend.py'
    for (const launchInventory of [null, { ...inventory, inventoryDigest: 'e'.repeat(64) }, { ...inventory, applicationRoot: join(root, 'other') },
      { ...inventory, schema: 2 }, { ...inventory, extra: true }, { ...inventory, files: [] },
      { ...inventory, files: Object.fromEntries(Object.entries(files).filter(([path]) => path !== firstFile)) },
      { ...inventory, files: { ...files, 'resources/native/gone.py': [1, 1] } },
      ...[0, 1, 2, 3, 4].map(changed => ({ ...inventory, files: { ...files, [firstFile]: files[firstFile].map((value, index) => index === changed ? value + 1 : value) } })),
      { ...inventory, files: { ...files, [firstFile]: files[firstFile].slice(0, 2) } },
      { ...inventory, files: { ...files, [firstFile]: [...files[firstFile], 0] } }]) {
      const view = countingFs()
      const result = observe(view.fs, { launchInventory })
      assert.equal(result.mode, 'hashed')
      assert.ok(view.reads > 0)
      assert.deepEqual(result.identity, hashed.identity)
      assert.deepEqual(result.launchInventory, inventory)
    }
    // The cache is bound to the canonical root it was recorded for.
    const elsewhere = countingFs()
    const rebound = observe(elsewhere.fs, { launchInventory: inventory, inventoryRoot: join(root, 'other') })
    assert.equal(rebound.mode, 'hashed')
    assert.ok(elsewhere.reads > 0)
    assert.equal(rebound.launchInventory.applicationRoot, join(root, 'other'))
    assert.equal(observe(noReads, { launchInventory: rebound.launchInventory, inventoryRoot: join(root, 'other') }).mode, 'cached')

    // A truncated file no longer matches the cache, and the full walk rejects it.
    const path = join(root, 'resources/native/backend.py')
    await writeFile(path, 'print')
    let view = countingFs()
    assert.throws(() => observe(view.fs, { launchInventory: inventory }), /changed: resources\/native\/backend.py/)
    assert.ok(view.reads > 0)
    // So is a same-size modification, whose modification time changes.
    await writeFile(path, 'PRINT()')
    fs.utimesSync(path, new Date(), new Date(Date.now() + 60000))
    view = countingFs()
    assert.throws(() => observe(view.fs, { launchInventory: inventory }), /changed: resources\/native\/backend.py/)
    assert.ok(view.reads > 0)
    // A same-size modification that restores the modification time still
    // changes the inode change time, which utimes cannot set.
    await writeFile(path, 'print()')
    fs.utimesSync(path, 1000000000, 1000000000)
    const restored = observe(countingFs().fs)
    assert.equal(restored.mode, 'hashed')
    const recorded = restored.launchInventory
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
    await writeFile(path, 'PRINT()')
    fs.utimesSync(path, 1000000000, 1000000000)
    assert.equal(fs.lstatSync(path).mtimeMs, recorded.files['resources/native/backend.py'][1])
    view = countingFs()
    assert.throws(() => observe(view.fs, { launchInventory: recorded }), /changed: resources\/native\/backend.py/)
    assert.ok(view.reads > 0)
    // A read-only mount takes the receipt's digests by design.
    assert.equal(observe(noReads, { readOnly: true }).mode, 'read-only')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('files.json must agree with the receipt and the archive digest comes from the receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'receipt-native-'))
  try {
    const { receipt } = await receiptFixture(root)
    const prefix = 'resources/native/'
    assertNativeInventoryDeclared({ 'backend.py': digest('print()'), 'static/index.html': digest('<!doctype html>') }, receipt, prefix)
    assert.throws(() => assertNativeInventoryDeclared({ 'backend.py': digest('other') }, receipt, prefix), /native payload changed: backend.py/)
    assert.throws(() => assertNativeInventoryDeclared({ 'absent.py': digest('print()') }, receipt, prefix), /native payload changed: absent.py/)
    assert.throws(() => assertNativeInventoryDeclared({ static: digest('print()') }, receipt, prefix), /native payload changed: static/)
    assert.equal(declaredApplicationDigest(receipt, 'resources/app.asar'), physicalFileHash(join(root, 'resources', 'app.asar'), fs))
    assert.throws(() => declaredApplicationDigest(receipt, 'resources/other.asar'), /archive evidence/)
    assert.throws(() => declaredApplicationDigest(receipt, 'resources/native'), /archive evidence/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the launch inventory is recorded durably beside application data and failures never throw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launch-inventory-'))
  try {
    const path = join(root, 'launch-inventory.json'), value = { schema: 1, applicationRoot: '/app', inventoryDigest: 'c'.repeat(64), files: { a: [1, 2.5] } }
    const durability = { lockPython: process.platform === 'win32' ? 'python.exe' : 'python3',
      durabilityHelper: fileURLToPath(new URL('../backend.py', import.meta.url)) }
    assert.equal(await readLaunchInventory(path), null)
    assert.equal(await writeLaunchInventory(path, value, durability), true)
    assert.deepEqual(await readLaunchInventory(path), value)
    assert.equal(await writeLaunchInventory(join(root, 'missing', 'launch-inventory.json'), value, durability), false)
    assert.equal(await writeLaunchInventory(path, { ...value, schema: 2 }, {}), false)
    assert.deepEqual(await readLaunchInventory(path), value)
    await writeFile(path, '{')
    assert.equal(await readLaunchInventory(path), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a FIFO in place of the launch inventory is rejected without waiting for a writer', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'launch-inventory-fifo-'))
  try {
    const path = join(root, 'launch-inventory.json')
    const made = spawnSync('mkfifo', [path])
    assert.equal(made.status, 0)
    const started = Date.now()
    assert.equal(await readLaunchInventory(path), null)
    assert.ok(Date.now() - started < 2000)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the hashed walk reads each file through the descriptor it checked', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'receipt-descriptor-'))
  try {
    const { receipt } = await receiptFixture(root)
    const target = { platform: 'linux', arch: 'x64' }
    // A file replaced between the walk's lstat and its open is rejected.
    const swapped = join(root, 'resources/native/backend.py')
    const racing = new Proxy(fs, { get: (target, name) => name === 'openSync'
      ? (path, ...args) => {
        if (path === swapped) { fs.renameSync(path, `${path}.old`); fs.writeFileSync(path, 'print()') }
        return target.openSync(path, ...args)
      } : target[name] })
    assert.throws(() => observeReceiptApplication({ rootDirectory: root, physicalFs: racing, receipt, target }), /changed while it was checked/)
    // A FIFO in the tree is reported as an unmodeled change, never opened.
    fs.renameSync(`${swapped}.old`, swapped)
    spawnSync('mkfifo', [join(root, 'resources/native/pipe')])
    assert.throws(() => observeReceiptApplication({ rootDirectory: root, physicalFs: fs, receipt, target }), /unsupported entry/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('worker inventory preserves physical archive identity and cache/security checks', async () => {
  const { observeReceiptApplicationOffThread } = await import('../application_inventory_worker.mjs')
  const root = await mkdtemp(join(tmpdir(), 'worker-inventory-'))
  try {
    const { receipt } = await receiptFixture(root)
    const options = { rootDirectory: root, receipt, target: { platform: 'linux', arch: 'x64' } }
    const expected = observeReceiptApplication({ ...options, physicalFs: fs })
    const phases = []
    const actual = await observeReceiptApplicationOffThread(options, { diagnostic: event => phases.push(event) })
    assert.equal(actual.mode, 'hashed')
    assert.deepEqual(actual.identity, expected.identity)
    assert.deepEqual(actual.launchInventory, expected.launchInventory)
    assert.deepEqual(phases.map(event => event.status), ['started', 'complete'])
    assert.ok(phases.every(event => !JSON.stringify(event).includes(root)))
    assert.equal((await observeReceiptApplicationOffThread({ ...options, launchInventory: actual.launchInventory })).mode, 'cached')
    await writeFile(join(root, 'resources', 'app.asar'), 'tampered physical archive')
    await assert.rejects(observeReceiptApplicationOffThread({ ...options, launchInventory: actual.launchInventory }), /Installed application changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('inventory worker leaves main-thread timers responsive and cancellation prevents admission', async () => {
  const { observeReceiptApplicationOffThread } = await import('../application_inventory_worker.mjs')
  const root = await mkdtemp(join(tmpdir(), 'cancel-inventory-'))
  try {
    const { receipt } = await receiptFixture(root)
    // Enough physical files to keep the serial worker busy past its first message.
    for (let index = 0; index < 1000; index++) fs.writeFileSync(join(root, 'resources', `extra-${index}`), 'x')
    const controller = new AbortController()
    let timerRan = false, admitted = false
    const phases = []
    const pending = observeReceiptApplicationOffThread({ rootDirectory: root, receipt, target: { platform: 'linux', arch: 'x64' } }, {
      signal: controller.signal,
      diagnostic: event => {
        phases.push(event)
        if (event.status === 'started') setTimeout(() => { timerRan = true; controller.abort() }, 0)
      },
    }).then(() => { admitted = true })
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(timerRan, true)
    assert.equal(admitted, false)
    assert.equal(phases.at(-1).status, 'cancelled')
    assert.throws(() => observeReceiptApplicationOffThread({}, { signal: controller.signal }), { name: 'AbortError' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
