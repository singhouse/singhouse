// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelCache, validateModelManifest } from '../runtime_manager.mjs'

const policy = JSON.parse(await readFile(new URL('../models.json', import.meta.url), 'utf8'))
const selected = policy.models.filter(model => ['demucs-mdx-extra', 'karaoke-roformer'].includes(model.id))
const manifest = { schema: 1, kind: 'models', models: selected.map(model => model.id), files: selected.flatMap(model => model.files) }

test('separation policy admits only the complete shipped digest-pinned inventory', () => {
  assert.equal(manifest.files.length, 7)
  assert.equal(validateModelManifest(manifest, policy), manifest)
  for (const mutate of [
    copy => { copy.files[0].sha256 = '0'.repeat(64) },
    copy => { copy.files[0].url = 'https://github.com/other/model.th' },
    copy => { copy.files[0].revision = 'a'.repeat(64) },
    copy => { copy.files.pop() },
    copy => { copy.models.push('user-model') },
  ]) {
    const copy = structuredClone(manifest); mutate(copy)
    assert.throws(() => validateModelManifest(copy, policy), /policy|inventory/)
  }
  const copy = structuredClone(manifest)
  copy.files[0].revision = 'b'.repeat(40)
  const modifiedPolicy = structuredClone(policy)
  modifiedPolicy.models.find(model => model.id === 'demucs-mdx-extra').files[0].revision = copy.files[0].revision
  assert.throws(() => validateModelManifest(copy, modifiedPolicy), /immutable revision/)
})

test('GitHub release redirects preserve range and reject unapproved destinations', async () => {
  const seen = []
  const cache = new ModelCache('/unused', policy, { fetchImpl: async (url, options) => {
    seen.push([url.hostname, options])
    return seen.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/model?sig=example' } })
      : new Response('bytes')
  } })
  await cache.fetchSource(new URL('https://github.com/owner/repo/releases/download/model/file'), { headers: { Range: 'bytes=7-' } })
  assert.deepEqual(seen.map(item => item[0]), ['github.com', 'release-assets.githubusercontent.com'])
  assert.deepEqual(seen[1][1].headers, { Range: 'bytes=7-' })
  assert.equal(seen[1][1].credentials, 'omit')
  for (const location of ['https://evil.release-assets.githubusercontent.com/model', 'https://github.com.evil.example/model', 'http://dl.fbaipublicfiles.com/model']) {
    let requests = 0
    cache.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location } }) }
    await assert.rejects(cache.fetchSource(new URL('https://github.com/source'), {}), /not approved/)
    assert.equal(requests, 1)
  }
  let requests = 0
  cache.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: '/loop' } }) }
  await assert.rejects(cache.fetchSource(new URL('https://github.com/source'), {}), /limit/)
  assert.equal(requests, 6)
})

test('corrupt legacy-source bytes cannot pass transfer verification', async t => {
  const root = await mkdtemp(join(tmpdir(), 'separation-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = new ModelCache(root, policy, { fetchImpl: async () => new Response('bad') })
  const record = { path: 'torch/hub/checkpoints/model.th', url: 'https://dl.fbaipublicfiles.com/demucs/model.th',
    size: 3, sha256: createHash('sha256').update('yes').digest('hex'), executable: false }
  await assert.rejects(cache.transfer(record, join(root, 'partial')), /checksum/)
})
