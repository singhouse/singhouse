// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { physicalApplicationRecords, physicalFileHash } from '../application_inventory.mjs'

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
