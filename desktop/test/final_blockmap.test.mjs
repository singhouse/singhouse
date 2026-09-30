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

const { buildBlockMap } = createRequire(import.meta.url)('app-builder-lib/out/targets/blockmap/blockmap.js')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'final-blockmap-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = join(root, 'signed.dmg')
  await writeFile(artifact, Buffer.alloc(100000, 42))
  await buildBlockMap(artifact, 'gzip', `${artifact}.blockmap`)
  return { root, artifact, original: await readFile(`${artifact}.blockmap`) }
}

test('regenerates the stale pre-signing blockmap over all finalized bytes with upstream checksums', async t => {
  const { artifact, original } = await fixture(t)
  await appendFile(artifact, Buffer.from('signature and notarization staple'))
  const bytes = await readFile(artifact)
  const result = await regenerateFinalBlockmap(artifact)
  const sidecar = await readFile(`${artifact}.blockmap`)
  assert.notDeepEqual(sidecar, original)
  assert.equal(JSON.parse(gunzipSync(sidecar)).files[0].sizes.reduce((a, b) => a + b, 0), bytes.length)
  assert.equal(result.sha512, createHash('sha512').update(bytes).digest('base64'))
  assert.deepEqual(await readFile(artifact), bytes, 'Never append a blockmap to the signed artifact')
  await regenerateFinalBlockmap(artifact)
  assert.deepEqual(await readFile(`${artifact}.blockmap`), sidecar)
})

for (const failure of ['same-size mutation', 'post-generation mutation', 'checksum mismatch', 'coverage mismatch', 'helper failure']) {
  test(`rejects ${failure} and preserves prior sidecar without temporary files`, async t => {
    const { root, artifact, original } = await fixture(t)
    let calls = 0
    const build = async (...args) => {
      const result = await buildBlockMap(...args)
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
