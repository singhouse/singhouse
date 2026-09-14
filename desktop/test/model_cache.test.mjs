// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ModelCache, RuntimeManager } from '../runtime_manager.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'model-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const revision = 'a'.repeat(40), prefix = `huggingface/heart/${revision}`
  const bytes = Buffer.alloc(150000, 'm')
  const files = ['config.json', 'model.safetensors'].map(name => ({ path: `${prefix}/${name}`,
    url: `https://huggingface.co/upstream/heart/resolve/${revision}/${name}`, revision,
    sha256: sha(bytes), size: bytes.length, executable: false }))
  const manifest = { schema: 1, kind: 'models', models: ['heart'], files }
  const policy = { schema: 1, allowedHosts: ['huggingface.co'], models: [{ id: 'heart', files: structuredClone(files) }] }
  const cacheOptions = { lockPython: process.platform === 'win32' ? 'python.exe' : 'python3',
    durabilityHelper: fileURLToPath(new URL('../backend.py', import.meta.url)),
    fetchImpl: async () => { throw new Error('Network must not be used') }, ...options }
  const cache = new ModelCache(join(root, 'models'), policy, cacheOptions)
  const directory = join(root, 'local')
  await mkdir(directory)
  for (const file of files) await writeFile(join(directory, file.path.slice(prefix.length + 1)), bytes)
  return { root, directory, manifest, policy, cache, prefix, bytes, cacheOptions }
}

test('model redirects preserve resumed range across approved Hub and CDN endpoints', async t => {
  const requests = []
  const { root, manifest, cache, bytes } = await fixture(t, { fetchImpl: async (url, options) => {
    requests.push({ url: url.href, ...options })
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: '/api/resolve-cache/model' } })
    if (requests.length === 2) return new Response(null, { status: 307, headers: { location: 'https://cas-bridge.xethub.hf.co/model?Signature=fixture' } })
    return new Response(bytes.subarray(7), { status: 206, headers: { 'content-range': `bytes 7-${bytes.length - 1}/${bytes.length}` } })
  } })
  const partial = join(root, 'partial')
  await writeFile(partial, bytes.subarray(0, 7))
  await cache.transfer(manifest.files[0], partial)
  assert.deepEqual(await readFile(partial), bytes)
  assert.equal(requests.length, 3)
  for (const request of requests) {
    assert.equal(request.redirect, 'manual')
    assert.equal(request.credentials, 'omit')
    assert.deepEqual(request.headers, { Range: 'bytes=7-' })
  }
})

test('model redirects refuse unsafe destinations before contacting them', async t => {
  const { cache, manifest } = await fixture(t)
  for (const location of ['http://huggingface.co/model', 'https://user:secret@huggingface.co/model',
    'https://huggingface.co:8443/model', 'https://huggingface.co/model#fragment',
    'https://huggingface.co.evil.example/model', 'https://custom.hf.co/model',
    'https://127.0.0.1/model', 'https://[::1]/model', 'file:///tmp/model']) {
    let requests = 0
    cache.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location } }) }
    await assert.rejects(cache.fetchSource(new URL(manifest.files[0].url), {}), /not approved/)
    assert.equal(requests, 1)
  }
  let requests = 0
  cache.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: '/loop' } }) }
  await assert.rejects(cache.fetchSource(new URL(manifest.files[0].url), {}), /limit/)
  assert.equal(requests, 6)
  const runtime = new RuntimeManager('/tmp/fixture', {}, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error'); return new Response('strict')
  } })
  await runtime.fetchSource(new URL(manifest.files[0].url), {})
})

test('redirected range validation rejects a mismatched partial response', async t => {
  const { root, cache, manifest } = await fixture(t)
  let requests = 0
  cache.fetch = async () => ++requests === 1
    ? new Response(null, { status: 302, headers: { location: 'https://cdn-lfs-us-1.hf.co/model' } })
    : new Response('bad', { status: 206, headers: { 'content-range': 'bytes 0-2/3' } })
  const partial = join(root, 'partial')
  await writeFile(partial, 'm')
  await assert.rejects(cache.transfer(manifest.files[0], partial), /Source transfer failed/)
})

test('offline import preserves upstream policy and reopens without its source directory', async t => {
  const { cache, manifest, directory, prefix, policy, cacheOptions } = await fixture(t)
  const active = await cache.installFromDirectory(manifest, directory, { prefix })
  assert.deepEqual(active.manifest, manifest)
  assert.deepEqual(JSON.parse(await readFile(join(active.directory, 'manifest.json'), 'utf8')), manifest)
  await rm(directory, { recursive: true })
  const reopened = new ModelCache(cache.root, policy, cacheOptions)
  assert.equal((await reopened.active()).id, active.id)
})

test('offline full-layout import requires every pinned file and rejects corruption and unsafe paths', async t => {
  const { cache, manifest, directory, prefix, bytes } = await fixture(t)
  await assert.rejects(cache.installFromDirectory(manifest, directory), /prefix/)
  await assert.rejects(cache.installFromDirectory(manifest, directory, { prefix: '..' }), /prefix/)
  await mkdir(join(directory, prefix), { recursive: true })
  await writeFile(join(directory, manifest.files[0].path), bytes)
  await assert.rejects(cache.installFromDirectory(manifest, directory, { prefix: '' }), /ENOENT/)
  await writeFile(join(directory, manifest.files[1].path), Buffer.alloc(bytes.length, 'x'))
  await assert.rejects(cache.installFromDirectory(manifest, directory, { prefix: '' }), /checksum/)
  assert.equal(await cache.active(), null)
  await writeFile(join(directory, manifest.files[1].path), bytes)
  const active = await cache.installFromDirectory(manifest, directory, { prefix: '' })
  assert.equal((await cache.active()).id, active.id)
})

test('offline import rejects symlink files and directories', { skip: process.platform === 'win32' }, async t => {
  const { cache, manifest, root, directory, prefix } = await fixture(t)
  const linked = join(root, 'linked')
  await symlink(directory, linked)
  await assert.rejects(cache.installFromDirectory(manifest, linked, { prefix }), /symbolic links/)
  const alias = join(root, 'parent-alias')
  await symlink(root, alias)
  const active = await cache.installFromDirectory(manifest, join(alias, 'local'), { prefix })
  const file = join(directory, 'model.safetensors')
  await rm(file)
  await symlink(join(directory, 'config.json'), file)
  await assert.rejects(cache.installFromDirectory(manifest, directory, { prefix }), /ELOOP|changed/)
  assert.equal((await cache.active()).id, active.id)
})

test('interrupted offline import resumes safely and ignores later caller manifest mutation', async t => {
  const controller = new AbortController()
  const { cache, manifest, directory, prefix, policy } = await fixture(t, {
    progress: () => controller.abort(new Error('fixture cancelled')),
  })
  await assert.rejects(cache.installFromDirectory(manifest, directory, { prefix, signal: controller.signal }), /cancelled|aborted/)
  assert.equal(await cache.active(), null)
  cache.progress = () => {}
  const promise = cache.installFromDirectory(manifest, directory, { prefix })
  manifest.files[0].url = 'https://evil.example/model'
  const active = await promise
  assert.equal(active.manifest.files[0].url, policy.models[0].files[0].url)
})

test('offline sources mutated after preflight fail final integrity and preserve active selection', async t => {
  const { cache, manifest, directory, prefix, bytes } = await fixture(t)
  cache.diskFree = async () => {
    await writeFile(join(directory, 'model.safetensors'), Buffer.alloc(bytes.length, 'x'))
    return Number.MAX_SAFE_INTEGER
  }
  await assert.rejects(cache.installFromDirectory(manifest, directory, { prefix }), /checksum/)
  assert.equal(await cache.active(), null)
})

test('same-policy model repair retains damaged bytes and restores offline verification', async t => {
  const { cache, manifest, directory, prefix, policy, cacheOptions } = await fixture(t)
  const installed = await cache.installFromDirectory(manifest, directory, { prefix })
  await writeFile(join(installed.directory, manifest.files[1].path), 'damaged checkpoint')
  await assert.rejects(cache.active(), /verification failed/)
  assert.deepEqual(await cache.selectionForRepair(), installed)
  const repaired = await cache.installFromDirectory(manifest, directory, { prefix })
  assert.equal(repaired.id, installed.id)
  assert.equal((await cache.active()).id, installed.id)
  const retained = await readdir(join(cache.root, 'quarantine'))
  assert.equal(retained.length, 1)
  assert.equal(await readFile(join(cache.root, 'quarantine', retained[0], 'pack', manifest.files[1].path), 'utf8'), 'damaged checkpoint')
  await rm(directory, { recursive: true })
  assert.equal((await new ModelCache(cache.root, policy, cacheOptions).active()).id, installed.id)
})

test('interrupted model repair preserves pointer slots, damaged artifact and retryable staging', async t => {
  const { cache, manifest, directory, prefix } = await fixture(t)
  const installed = await cache.installFromDirectory(manifest, directory, { prefix })
  const pointers = await cache.readPointers()
  await writeFile(join(installed.directory, manifest.files[1].path), 'damaged checkpoint')
  cache.activationHook = async stage => { if (stage === 'model-quarantined') throw new Error('repair interrupted') }
  await assert.rejects(cache.installFromDirectory(manifest, directory, { prefix }), /repair interrupted/)
  assert.deepEqual(await cache.readPointers(), pointers)
  const retained = await readdir(join(cache.root, 'quarantine'))
  assert.equal(retained.length, 1)
  assert.equal(await readFile(join(cache.root, 'quarantine', retained[0], 'pack', manifest.files[1].path), 'utf8'), 'damaged checkpoint')
  assert.deepEqual(JSON.parse(await readFile(join(cache.root, 'staging', installed.id, 'manifest.json'), 'utf8')), manifest)
  assert.deepEqual(await cache.selectionForRepair(), {
    id: installed.id, directory: join(cache.root, 'staging', installed.id), manifest,
  })
  cache.activationHook = async () => {}
  assert.equal((await cache.installFromDirectory(manifest, directory, { prefix })).id, installed.id)
  assert.equal((await cache.active()).id, installed.id)
})

test('repair selection refuses modified or policy-untrusted manifests', async t => {
  const { cache, manifest, directory, prefix } = await fixture(t)
  assert.equal(await cache.selectionForRepair(), null)
  const installed = await cache.installFromDirectory(manifest, directory, { prefix })
  const stored = join(installed.directory, 'manifest.json')
  const modified = structuredClone(manifest)
  modified.note = 'changes the content-addressed identity'
  await writeFile(stored, JSON.stringify(modified))
  assert.equal(await cache.selectionForRepair(), null)
  await writeFile(stored, JSON.stringify(manifest))
  const untrusted = new ModelCache(cache.root, { schema: 1, allowedHosts: ['huggingface.co'], models: [] })
  assert.equal(await untrusted.selectionForRepair(), null)
})
