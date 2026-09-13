// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const installer = new URL('../build/installer.mjs', import.meta.url).href

test('installer rejects stale native admission policy instead of overlaying it', async () => {
  const native = await mkdtemp(resolve(tmpdir(), 'installer-policy-'))
  const previous = process.env.KARAOKE_NATIVE_PAYLOAD
  process.env.KARAOKE_NATIVE_PAYLOAD = native
  try {
    const pkg = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'))
    await writeFile(resolve(native, 'manifest.json'), JSON.stringify({ appVersion: pkg.version }))
    await writeFile(resolve(native, 'backend.py'), '# fixture backend\n')
    for (const policy of ['models.json', 'processing-locks.json']) {
      await writeFile(resolve(native, policy), await readFile(resolve(desktop, policy)))
    }
    const { default: valid } = await import(`${installer}?valid=${Date.now()}`)
    assert.deepEqual(valid.extraResources, [{ from: native, to: 'native', filter: ['**/*'] }])
    await writeFile(resolve(native, 'processing-locks.json'), '{}\n')
    await assert.rejects(import(`${installer}?stale=${Date.now()}`), /Reassemble the native runtime after changing processing-locks.json/)
  } finally {
    if (previous === undefined) delete process.env.KARAOKE_NATIVE_PAYLOAD
    else process.env.KARAOKE_NATIVE_PAYLOAD = previous
    await rm(native, { recursive: true, force: true })
  }
})
