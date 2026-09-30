// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { regenerateFinalBlockmap } from '../build/final_blockmap.mjs'

// This deliberately simple test double exercises finalization and validation;
// it does not implement or claim compatibility with upstream Rabin/BLAKE2.
async function fixtureBlockMap(input, compression, output) {
  assert.equal(compression, 'gzip')
  assert.ok(output && output !== input, 'The builder must receive a separate sidecar path')
  const bytes = await readFile(input)
  const chunks = [bytes.subarray(0, 50000), bytes.subarray(50000)]
  const map = { version: '2', files: [{ name: 'file', offset: 0,
    sizes: chunks.map(chunk => chunk.length),
    checksums: chunks.map(chunk => createHash('sha256').update(chunk).digest('base64')) }] }
  await writeFile(output, gzipSync(JSON.stringify(map)))
  return { size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
}

async function fixture(t, buildBlockMap = fixtureBlockMap) {
  const root = await mkdtemp(join(tmpdir(), 'final-blockmap-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = join(root, 'signed.dmg')
  await writeFile(artifact, Buffer.alloc(100000, 42))
  await buildBlockMap(artifact, 'gzip', `${artifact}.blockmap`)
  return { root, artifact, original: await readFile(`${artifact}.blockmap`) }
}

async function assertFinalization(t, buildBlockMap, options) {
  const { artifact, original } = await fixture(t, buildBlockMap)
  await appendFile(artifact, Buffer.from('signature and notarization staple'))
  const bytes = await readFile(artifact)
  const result = await regenerateFinalBlockmap(artifact, options)
  const sidecar = await readFile(`${artifact}.blockmap`)
  assert.notDeepEqual(sidecar, original)
  assert.equal(JSON.parse(gunzipSync(sidecar)).files[0].sizes.reduce((a, b) => a + b, 0), bytes.length)
  assert.equal(result.sha512, createHash('sha512').update(bytes).digest('base64'))
  assert.deepEqual(await readFile(artifact), bytes, 'Never append a blockmap to the signed artifact')
  await regenerateFinalBlockmap(artifact, options)
  assert.deepEqual(await readFile(`${artifact}.blockmap`), sidecar)
}

test('finalization replaces a stale sidecar, covers all final bytes and preserves the artifact', async t => {
  await assertFinalization(t, fixtureBlockMap, { buildBlockMap: fixtureBlockMap })
})

test('pinned builder integration regenerates final bytes with upstream boundaries and checksums', async t => {
  const require = createRequire(import.meta.url)
  try { require.resolve('app-builder-lib/package.json') }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    t.skip('Requires locked desktop npm dependencies')
    return
  }
  // An installed but broken/incompatible builder must fail, not skip.
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js')
  await assertFinalization(t, buildBlockMap)
})

for (const failure of ['same-size mutation', 'post-generation mutation', 'checksum mismatch', 'coverage mismatch', 'helper failure']) {
  test(`rejects ${failure} and preserves prior sidecar without temporary files`, async t => {
    const { root, artifact, original } = await fixture(t)
    let calls = 0
    const build = async (...args) => {
      const result = await fixtureBlockMap(...args)
      calls++
      if (failure === 'helper failure') throw new Error('helper failed')
      if ((failure === 'same-size mutation' && calls === 1) || (failure === 'post-generation mutation' && calls === 2)) await writeFile(artifact, Buffer.alloc(100000, 43))
      if ((failure === 'checksum mismatch' && calls === 1) || failure === 'coverage mismatch') {
        const map = JSON.parse(gunzipSync(await readFile(args[2])))
        if (failure === 'checksum mismatch') map.files[0].checksums[0] = 'invalid'
        else map.files[0].sizes[0]++
        await writeFile(args[2], gzipSync(JSON.stringify(map)))
      }
      return result
    }
    await assert.rejects(regenerateFinalBlockmap(artifact, { buildBlockMap: build }), /changed|mismatch|helper failed/)
    assert.deepEqual(await readFile(`${artifact}.blockmap`), original)
    assert.deepEqual((await readdir(root)).sort(), ['signed.dmg', 'signed.dmg.blockmap'])
  })
}
