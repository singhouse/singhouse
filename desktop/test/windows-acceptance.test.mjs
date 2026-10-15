// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { bundledFetch, modelManifest, prepare } from '../acceptance/windows-bootstrap.mjs'
import { RuntimeManager } from '../runtime_manager.mjs'

test('bundled transport resets ranges and runtime transfer rejects altered bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-acceptance-'))
  try {
    const bytes = Buffer.from('trusted'), sha256 = createHash('sha256').update(bytes).digest('hex')
    const record = { url: 'https://github.com/singhouse/singhouse/releases/download/test/file', sha256, size: bytes.length, filename: 'file' }
    const artifacts = join(root, 'artifacts'), directory = join(artifacts, sha256)
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'file'), bytes)
    const transport = bundledFetch({ recipe: { python: record, wheels: [] } }, artifacts, () => { throw new Error('unexpected network') })
    const manager = new RuntimeManager(root, {}, { fetchImpl: transport })
    const target = join(root, 'partial'); await writeFile(target, 'tr')
    await manager.transfer(record, target)
    await writeFile(join(directory, 'file'), 'changed')
    await assert.rejects(manager.transfer(record, join(root, 'bad')), /checksum or size mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('model selection refuses incomplete upstream policy', () => {
  assert.throws(() => modelManifest({ models: [], schema: 1, allowedHosts: [] }), /manifest|policy/)
})


test('bootstrap rejects recipes absent from the packaged trust list before installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-acceptance-trust-'))
  try {
    const native = join(root, 'app', 'resources', 'native')
    await mkdir(native, { recursive: true }); await mkdir(join(root, 'recipe'))
    const put = (path, value) => writeFile(path, JSON.stringify(value))
    await put(join(root, 'app', 'resources', 'release.json'), { channel: 'private-test' })
    await put(join(native, 'manifest.json'), { platform: 'win32', arch: 'x64' })
    await put(join(native, 'provenance.json'), { locks: {} })
    await put(join(native, 'processing-locks.json'), { schema: 1, lockSha256: [], privateTestLockSha256: [] })
    await put(join(root, 'recipe', 'manifest.json'), { accelerator: 'cpu', provenance: { lockSha256: 'a'.repeat(64) } })
    await assert.rejects(prepare({ bundle: root, profile: join(root, 'profile'), accelerator: 'cpu', checkOnly: true }), /independently pinned/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
