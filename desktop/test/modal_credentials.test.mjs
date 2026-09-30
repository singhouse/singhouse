// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, symlink, stat, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModalCredentials } from '../modal_credentials.mjs'

const config = () => ({ app: 'my-karaoke', environment: 'main', version: 1,
  tokenId: 'test-token-id', tokenSecret: 'test-only-secret', consent: { uploads: true, usage: true } })
function safeStorage() {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decryptString: value => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'singhouse-modal-credentials-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const path = join(directory, 'private', 'modal.enc'), storage = safeStorage()
  return { directory, path, storage, store: new ModalCredentials({ path, safeStorage: storage, platform: 'linux' }) }
}

test('encrypted private storage exposes only redacted configuration status', async t => {
  const { store, path } = await fixture(t)
  assert.equal((await store.status()).configured, false)
  assert.equal(await store.readForBackend(), null)
  const result = await store.save(config())
  const data = await readFile(path)
  for (const secret of [config().tokenId, config().tokenSecret, config().app]) assert.equal(data.includes(secret), false)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await store.readForBackend(), config())
  assert.deepEqual(result, await store.status())
  assert.equal(result.configured, true)
  assert.equal('ready' in result, false)
  assert.equal('tokenId' in result, false)
  assert.equal('tokenSecret' in result, false)
})

test('unprotected or unknown Linux storage backend fails closed', async t => {
  const { path, storage } = await fixture(t)
  for (const overrides of [{ isEncryptionAvailable: () => false },
    { getSelectedStorageBackend: () => 'basic_text' }, { getSelectedStorageBackend: () => 'unknown' },
    { getSelectedStorageBackend: undefined }]) {
    const store = new ModalCredentials({ path, safeStorage: { ...storage, ...overrides }, platform: 'linux' })
    await assert.rejects(store.save(config()), /Secure Modal configuration is unavailable/)
    assert.equal((await store.status()).configured, false)
    await assert.rejects(store.readForBackend())
  }
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

test('macOS and Windows rely on encryption availability without a Linux backend', async t => {
  const { path, storage } = await fixture(t)
  for (const platform of ['darwin', 'win32']) {
    const store = new ModalCredentials({ path, safeStorage: { ...storage, getSelectedStorageBackend: undefined }, platform })
    await store.save(config())
    assert.equal((await store.status()).configured, true)
  }
})

test('strict input validation rejects malformed values and preserves existing config', async t => {
  const { store } = await fixture(t)
  await store.save(config())
  for (const patch of [{ app: '' }, { app: '../name' }, { environment: 'a'.repeat(129) }, { version: '1' },
    { version: 0 }, { version: 1.2 }, { tokenId: null }, { tokenSecret: 'a'.repeat(4097) },
    { tokenSecret: 'line\nbreak' }, { consent: {} }, { consent: { uploads: 'true', usage: true } },
    { consent: { uploads: true, usage: 1 } }]) await assert.rejects(store.save({ ...config(), ...patch }))
  for (const bad of [null, [], false]) await assert.rejects(store.save(bad))
  assert.deepEqual(await store.readForBackend(), config())
})

test('corrupt ciphertext and invalid decrypted records disclose no private errors', async t => {
  const { store, path, storage } = await fixture(t)
  await store.save(config())
  for (const corrupted of [Buffer.from('private-corruption-details'), storage.encryptString('{bad json'),
    storage.encryptString(JSON.stringify({ ...config(), version: -1 })), Buffer.alloc(65537)]) {
    await writeFile(path, corrupted)
    const status = await store.status()
    assert.equal(status.configured, false)
    assert.equal(status.error, 'Secure Modal configuration is unavailable.')
    await assert.rejects(store.readForBackend(), /^Error: Secure Modal configuration is unavailable\.$/)
  }
})

test('rejects final file and ancestor directory symlinks without changing their targets', async t => {
  const { directory, path, storage, store } = await fixture(t)
  await mkdir(join(directory, 'private'))
  const target = join(directory, 'target')
  await writeFile(target, 'untouched', { mode: 0o600 })
  await symlink(target, path)
  await assert.rejects(store.save(config()))
  assert.equal((await store.status()).configured, false)
  assert.equal(await readFile(target, 'utf8'), 'untouched')
  const linkedDirectory = join(directory, 'linked')
  await symlink(join(directory, 'private'), linkedDirectory)
  const linked = new ModalCredentials({ path: join(linkedDirectory, 'other.enc'), safeStorage: storage, platform: 'linux' })
  await assert.rejects(linked.save(config()))
  assert.equal((await linked.status()).configured, false)
})

test('writes serialize across instances, snapshot input, and clean temporary files', async t => {
  const { store, path, storage } = await fixture(t)
  const second = new ModalCredentials({ path, safeStorage: storage, platform: 'linux' })
  const firstConfig = config()
  const first = store.save(firstConfig)
  firstConfig.tokenSecret = 'mutated-after-call'
  await first
  assert.equal((await store.readForBackend()).tokenSecret, config().tokenSecret)
  await Promise.all(Array.from({ length: 12 }, (_, version) => (version % 2 ? store : second).save({ ...config(), version: version + 1 })))
  assert.equal((await store.readForBackend()).version, 12)
  assert.deepEqual(await readdir(join(path, '..')), ['modal.enc'])
  await store.save({ ...config(), consent: { uploads: false, usage: false } })
  assert.deepEqual((await store.status()).consent, { uploads: false, usage: false })
})

test('encryption failures neither overwrite existing configuration nor poison later saves', async t => {
  const { store, storage, path } = await fixture(t)
  await store.save(config())
  const original = await readFile(path), encrypt = storage.encryptString
  storage.encryptString = () => { throw new Error(config().tokenSecret) }
  await assert.rejects(store.save(config()), /^Error: Secure Modal configuration is unavailable\.$/)
  assert.deepEqual(await readFile(path), original)
  storage.encryptString = encrypt
  await store.save({ ...config(), version: 2 })
  assert.equal((await store.status()).version, 2)
})

test('forget deletes without consulting an unavailable keyring and is idempotent', async t => {
  const { store, storage, path } = await fixture(t)
  await store.save(config())
  for (const method of ['isEncryptionAvailable', 'getSelectedStorageBackend', 'encryptString', 'decryptString']) {
    storage[method] = () => { throw new Error('keyring must not be consulted') }
  }
  const expected = { configured: false, app: null, environment: null, version: null,
    consent: { uploads: false, usage: false }, error: null }
  assert.deepEqual(await store.forget(), expected)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.deepEqual(await store.forget(), expected)
})

test('forget shares write serialization across instances and preserves neighboring files', async t => {
  const { store, storage, path } = await fixture(t)
  const second = new ModalCredentials({ path, safeStorage: storage, platform: 'linux' })
  await Promise.all([store.save(config()), second.forget()])
  assert.equal(await store.readForBackend(), null)
  const neighbor = join(path, '..', 'unrelated.enc')
  await writeFile(neighbor, 'neighbor')
  await Promise.all([store.forget(), second.save({ ...config(), version: 2 })])
  assert.equal((await store.status()).version, 2)
  await store.forget()
  assert.equal(await readFile(neighbor, 'utf8'), 'neighbor')
})

test('forget rejects file and directory symlinks without removing their targets', async t => {
  const { store, storage, directory, path } = await fixture(t)
  await mkdir(join(directory, 'private'))
  const target = join(directory, 'target')
  await writeFile(target, 'untouched', { mode: 0o600 })
  await symlink(target, path)
  await assert.rejects(store.forget(), /Secure Modal configuration is unavailable/)
  assert.equal(await readFile(target, 'utf8'), 'untouched')
  const link = join(directory, 'linked')
  await symlink(directory, link)
  const linked = new ModalCredentials({ path: join(link, 'target'), safeStorage: storage, platform: 'linux' })
  await assert.rejects(linked.forget())
  assert.equal(await readFile(target, 'utf8'), 'untouched')
})

test('configuration validation matches the backend helper name, token, and version limits', async t => {
  const { store } = await fixture(t)
  const maximum = { app: 'a'.repeat(64), environment: 'e'.repeat(64), version: 2147483647,
    tokenId: 'A_-9'.repeat(128), tokenSecret: 'a'.repeat(512), consent: { uploads: true, usage: true } }
  await store.save(maximum)
  assert.deepEqual(await store.readForBackend(), maximum)
  for (const patch of [{ app: 'a'.repeat(65) }, { environment: 'a'.repeat(65) },
    { app: 'app.name' }, { environment: 'env.name' }, { app: '_name' },
    { tokenId: 'a'.repeat(513) }, { tokenSecret: 'a'.repeat(513) },
    { tokenId: 'token.id' }, { tokenSecret: 'token/secret' }, { tokenSecret: 'token=secret' },
    { version: 2147483648 }]) {
    await assert.rejects(store.save({ ...config(), ...patch }))
  }
  assert.deepEqual(await store.readForBackend(), maximum)
})
