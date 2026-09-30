// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)

// Regenerate only after the artifact's last signing/stapling mutation. Always
// supply a separate output: the upstream helper otherwise appends to its input.
export async function regenerateFinalBlockmap(artifact, {
  buildBlockMap = require('app-builder-lib/out/targets/blockmap/blockmap.js').buildBlockMap,
} = {}) {
  const work = await mkdtemp(join(dirname(artifact), '.final-blockmap-'))
  try {
    const candidate = join(work, 'candidate')
    const reference = join(work, 'reference')
    const generated = await buildBlockMap(artifact, 'gzip', candidate)
    const checked = await buildBlockMap(artifact, 'gzip', reference)
    assert.deepEqual(generated, checked, 'Final artifact changed during blockmap generation')
    const map = JSON.parse(gunzipSync(await readFile(candidate)))
    // Use the pinned upstream Rabin/BLAKE2 implementation again to verify every
    // chunk boundary and checksum, without maintaining a second algorithm here.
    assert.deepEqual(map, JSON.parse(gunzipSync(await readFile(reference))), 'Final blockmap checksum or boundary mismatch')
    assert.equal(map.version, '2', 'Unexpected final blockmap version')
    assert.equal(map.files?.length, 1, 'Expected one final blockmap file')
    const file = map.files[0]
    assert.equal(file.name, 'file')
    assert.equal(file.offset, 0)
    assert.ok(Array.isArray(file.sizes) && Array.isArray(file.checksums), 'Invalid blockmap chunks')
    assert.equal(file.sizes.length, file.checksums.length)
    assert.ok(file.sizes.every(size => Number.isSafeInteger(size) && size > 0), 'Invalid blockmap chunk size')
    const finalSize = (await stat(artifact)).size
    assert.equal(file.sizes.reduce((sum, size) => sum + size, 0), finalSize, 'Final blockmap coverage mismatch')
    assert.equal(generated.size, finalSize, 'Final blockmap input size mismatch')
    const digest = createHash('sha512')
    for await (const bytes of createReadStream(artifact)) digest.update(bytes)
    assert.equal(generated.sha512, digest.digest('base64'), 'Final artifact changed after blockmap generation')
    // Keep the old sidecar intact on validation failure; packaging must fail.
    await rename(candidate, `${artifact}.blockmap`)
    return generated
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
