// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { appImageNoticesDirectory, appImageNoticesResource, loadAppImageNotices, verifyAppImageNotices, createAppImageSourceBundle } from '../build/appimage_notices.mjs'
import { inspectApplicationInventory } from '../build/release_receipt.mjs'
const require = createRequire(import.meta.url)
const desktop = fileURLToPath(new URL('../', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function temporary(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'appimage-notices-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function fixture(t) {
  const root = await temporary(t), metadataDirectory = resolve(root, 'metadata'), applicationDirectory = resolve(root, 'application'), inputDirectory = resolve(root, 'inputs')
  await cp(appImageNoticesDirectory, metadataDirectory, { recursive: true })
  const { inventory } = await loadAppImageNotices(metadataDirectory)
  for (const [records, directory] of [[inventory.libraries, applicationDirectory], [inventory.sources, inputDirectory]]) {
    for (const record of records) {
      const bytes = Buffer.from(`test fixture bytes for ${record.path}`)
      record.sha256 = hash(bytes)
      await mkdir(resolve(directory, record.path, '..'), { recursive: true })
      await writeFile(resolve(directory, record.path), bytes)
    }
  }
  await writeFile(resolve(metadataDirectory, 'inventory.json'), JSON.stringify(inventory))
  await cp(metadataDirectory, resolve(applicationDirectory, appImageNoticesResource), { recursive: true })
  return { root, metadataDirectory, applicationDirectory, inputDirectory, inventory, arch: 'x64' }
}
function tarEntries(bytes) {
  const entries = new Map()
  for (let offset = 0; bytes[offset];) {
    const h = bytes.subarray(offset, offset + 512)
    const text = (start, end) => h.subarray(start, end).toString().replace(/\0.*$/s, '')
    const name = text(0, 100), size = parseInt(text(124, 136), 8)
    const storedSum = parseInt(text(148, 154), 8)
    const checksumHeader = Buffer.from(h); checksumHeader.fill(32, 148, 156)
    assert.equal(storedSum, checksumHeader.reduce((a, b) => a + b, 0))
    assert.equal(text(100, 108), '0000644'); assert.equal(text(136, 148), '00000000000')
    assert.equal(text(108, 116), '0000000'); assert.equal(text(116, 124), '0000000')
    assert.equal(text(257, 263), 'ustar'); assert.equal(h[156], 48)
    entries.set(name, bytes.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  assert.deepEqual([...entries.keys()], [...entries.keys()].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))))
  return entries
}

test('checked-in inventory retains exact notices and mixed appindicator license evidence', async () => {
  const { inventory } = await loadAppImageNotices()
  assert.equal(inventory.libraries.length, 6)
  assert.match(inventory.libraries.find(x => x.source === 'libappindicator').licenseEvidence, /generate-id.c/)
  assert.ok(inventory.sources.filter(x => x.path.endsWith('.dsc')).every(x => x.signatureVerified === false))
  assert.ok(inventory.notices.some(record => record.path === 'REBUILD.txt'))
  assert.equal(inventory.builder.extractionScripts.length, 2)
  for (const script of inventory.builder.extractionScripts) {
    assert.deepEqual(Object.keys(script).sort(), ['sha256', 'url'])
    const prefix = `https://github.com/electron-userland/electron-builder-binaries/blob/${inventory.builder.commit}/`
    assert.ok(script.url.startsWith(prefix))
    const name = script.url.slice(prefix.length)
    assert.match(name, /^appImage-packages-(ia32|x64)\.sh$/)
    assert.match(script.sha256, /^[a-f0-9]{64}$/)
    assert.equal(inventory.notices.some(record => record.path.endsWith(name)), false)
    await assert.rejects(readFile(resolve(appImageNoticesDirectory, 'builder', name)), /ENOENT/)
  }
})

test('packaged verification rejects missing, changed, linked, and extra library files', async t => {
  const f = await fixture(t); await verifyAppImageNotices(f)
  const path = resolve(f.applicationDirectory, f.inventory.libraries[0].path), bytes = await readFile(path)
  await rm(path); await assert.rejects(verifyAppImageNotices(f), /library set differs/)
  await writeFile(path, 'substitution'); await assert.rejects(verifyAppImageNotices(f), /hash mismatch/)
  await writeFile(path, bytes)
  const extra = resolve(f.applicationDirectory, 'usr/lib/unclassified.so'); await writeFile(extra, 'extra')
  await assert.rejects(verifyAppImageNotices(f), /library set differs/); await rm(extra)
  if (process.platform !== 'win32') {
    await rm(path); await symlink(resolve(f.applicationDirectory, f.inventory.libraries[1].path), path)
    await assert.rejects(verifyAppImageNotices(f), /regular files/)
  }
  await assert.rejects(verifyAppImageNotices({ ...f, arch: 'armv7l' }), /Unsupported/)
  await assert.rejects(verifyAppImageNotices({ ...f, toolset: '1.0.0' }), /Unsupported/)
})

test('packaged verification rejects missing or altered installed notices and inventory', async t => {
  const f = await fixture(t), notice = resolve(f.applicationDirectory, appImageNoticesResource, f.inventory.notices[0].path)
  const bytes = await readFile(notice)
  await rm(notice); await assert.rejects(verifyAppImageNotices(f), /ENOENT/)
  await writeFile(notice, 'changed'); await assert.rejects(verifyAppImageNotices(f), /hash mismatch/)
  await writeFile(notice, bytes)
  await writeFile(resolve(f.applicationDirectory, appImageNoticesResource, 'inventory.json'), '{}')
  await assert.rejects(verifyAppImageNotices(f), /inventory differs/)
})

test('source bundle is deterministic, complete, checksum-bound and exclusive', async t => {
  const f = await fixture(t), output = resolve(f.root, 'sources.tar')
  const result = await createAppImageSourceBundle({ ...f, output })
  const bytes = await readFile(output), entries = tarEntries(bytes)
  assert.deepEqual([...entries.keys()].sort(),
    ['inventory.json', 'SHA256SUMS', ...f.inventory.sources.map(record => record.path),
      ...f.inventory.notices.map(record => record.path)].sort())
  assert.deepEqual(entries.get('REBUILD.txt'), await readFile(resolve(f.metadataDirectory, 'REBUILD.txt')))
  assert.equal([...entries.keys()].some(path => path.startsWith('builder/') || path.endsWith('.sh')), false)
  assert.equal(result.sha256, hash(bytes))
  assert.equal(await readFile(`${output}.sha256`, 'utf8'), `${result.sha256}  sources.tar\n`)
  for (const record of [...f.inventory.sources, ...f.inventory.notices]) assert.equal(hash(entries.get(record.path)), record.sha256)
  for (const line of entries.get('SHA256SUMS').toString().trimEnd().split('\n')) {
    const [digest, name] = line.split('  '); assert.equal(hash(entries.get(name)), digest)
  }
  const second = resolve(f.root, 'second.tar'); await createAppImageSourceBundle({ ...f, output: second })
  assert.deepEqual(await readFile(second), bytes)
  await assert.rejects(createAppImageSourceBundle({ ...f, output }), /exist|EEXIST/i)
  assert.deepEqual(await readFile(output), bytes)
})

test('source construction rejects absent source input, missing source, and changed source or notice', async t => {
  const f = await fixture(t), output = resolve(f.root, 'sources.tar')
  await assert.rejects(createAppImageSourceBundle({ ...f, inputDirectory: undefined, output }), /SINGHOUSE_APPIMAGE_SOURCE_INPUTS/)
  const source = resolve(f.inputDirectory, f.inventory.sources[0].path), bytes = await readFile(source)
  await rm(source); await assert.rejects(createAppImageSourceBundle({ ...f, output }), /ENOENT/)
  await writeFile(source, 'wrong'); await assert.rejects(createAppImageSourceBundle({ ...f, output }), /hash mismatch/)
  await writeFile(source, bytes)
  await rm(resolve(f.metadataDirectory, f.inventory.notices[0].path))
  await assert.rejects(createAppImageSourceBundle({ ...f, output }), /ENOENT/)
  await assert.rejects(readFile(output), /ENOENT/)
})

test('actual builder Linux resource copying places notice bytes in receipt inventory', async t => {
  let getFileMatchers, copyFiles
  try { ({ getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher.js')) }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || process.env.SINGHOUSE_REQUIRE_BUILDER_TESTS === '1') throw error
    t.skip('Install desktop build dependencies to exercise actual resource copying'); return
  }
  const root = await temporary(t), native = resolve(root, 'native'), application = resolve(root, 'application')
  await mkdir(native)
  const pkg = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'))
  await writeFile(resolve(native, 'manifest.json'), JSON.stringify({ appVersion: pkg.version }))
  await writeFile(resolve(native, 'assembly.json'), JSON.stringify({ schema: 1, kind: 'singhouse-assembly', edition: 'core' }))
  await writeFile(resolve(native, 'backend.py'), '# fixture\n')
  for (const name of ['models.json', 'processing-locks.json']) await copyFile(resolve(desktop, name), resolve(native, name))
  const previous = process.env.KARAOKE_NATIVE_PAYLOAD
  process.env.KARAOKE_NATIVE_PAYLOAD = native
  let config
  try { ({ default: config } = await import(`../build/installer.mjs?notices=${Date.now()}`)) }
  finally { if (previous === undefined) delete process.env.KARAOKE_NATIVE_PAYLOAD; else process.env.KARAOKE_NATIVE_PAYLOAD = previous }
  const resource = config.linux.extraResources.find(r => r.to === 'third-party/appimage')
  assert.equal(resolve(resource.from), resolve(appImageNoticesDirectory))
  assert.deepEqual(resource.filter, ['**/*'])
  const matchers = getFileMatchers(config, 'extraResources', resolve(application, 'resources'), {
    defaultSrc: desktop, macroExpander: value => value, customBuildOptions: config.linux, globalOutDir: root,
  })
  await copyFiles(matchers, undefined, false)
  const { files } = await inspectApplicationInventory(application), { inventory, bytes } = await loadAppImageNotices()
  assert.equal(files.some(file => file.path.startsWith(`${appImageNoticesResource}/builder/`)), false)
  assert.equal(files.some(file => file.path.startsWith(`${appImageNoticesResource}/`) && file.path.endsWith('.sh')), false)
  for (const notice of [...inventory.notices, { path: 'inventory.json', sha256: hash(bytes) }]) {
    assert.equal(files.find(f => f.path === `${appImageNoticesResource}/${notice.path}`)?.sha256, notice.sha256)
  }
})

test('legacy ARM64 requires an explicitly empty bundled-library set', async t => {
  const f = await fixture(t)
  await assert.rejects(verifyAppImageNotices({ ...f, arch: 'arm64' }), /library set differs/)
  await rm(resolve(f.applicationDirectory, 'usr'), { recursive: true })
  await verifyAppImageNotices({ ...f, arch: 'arm64' })
  await mkdir(resolve(f.applicationDirectory, 'usr/lib'), { recursive: true })
  await verifyAppImageNotices({ ...f, arch: 'arm64' })
  await writeFile(resolve(f.applicationDirectory, 'usr/lib/unproven.so'), 'unknown')
  await assert.rejects(verifyAppImageNotices({ ...f, arch: 'arm64' }), /library set differs/)
})
