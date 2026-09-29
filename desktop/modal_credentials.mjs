// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

const ERROR = 'Secure Modal configuration is unavailable.'
const LIMIT = 64 * 1024
const queues = new Map()
const empty = error => ({ configured: false, app: null, environment: null, version: null,
  consent: { uploads: false, usage: false }, error })
const publicStatus = config => ({ configured: true, app: config.app, environment: config.environment,
  version: config.version, consent: { ...config.consent }, error: null, safeStore: true })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function validate(value) {
  if (!record(value)) throw new Error(ERROR)
  const name = v => typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v)
  const token = v => typeof v === 'string' && v.length >= 1 && v.length <= 512 && /^[A-Za-z0-9_-]+$/.test(v)
  if (!name(value.app) || !name(value.environment) || !Number.isSafeInteger(value.version) || value.version < 1 || value.version > 2147483647
    || !token(value.tokenId) || !token(value.tokenSecret) || !record(value.consent)
    || typeof value.consent.uploads !== 'boolean' || typeof value.consent.usage !== 'boolean') throw new Error(ERROR)
  return { app: value.app, environment: value.environment, version: value.version,
    tokenId: value.tokenId, tokenSecret: value.tokenSecret,
    consent: { uploads: value.consent.uploads, usage: value.consent.usage } }
}

// Reject links in every existing path component, including the final file.
async function inspectPath(path) {
  const root = parse(path).root
  let current = root
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (current !== path && !info.isDirectory())
        || (current === path && (!info.isFile() || info.nlink !== 1))) throw new Error(ERROR)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

/** Main-process-only storage. Configuration is not proof of deployment readiness.
 * readForBackend is the sole secret-bearing API; never expose it through IPC.
 */
export class ModalCredentials {
  #path
  #safeStorage
  #platform
  constructor({ path, safeStorage, platform = process.platform }) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(ERROR)
    this.#path = resolve(path)
    this.#safeStorage = safeStorage
    this.#platform = platform
  }
  #protected() {
    if (this.#safeStorage?.isEncryptionAvailable() !== true) throw new Error(ERROR)
    if (this.#platform === 'linux') {
      const backend = this.#safeStorage.getSelectedStorageBackend?.()
      if (!['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) throw new Error(ERROR)
    }
  }
  async #read() {
    this.#protected()
    await inspectPath(this.#path)
    let handle
    try {
      handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > LIMIT
        || (this.#platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error(ERROR)
      const encrypted = await handle.readFile()
      if (encrypted.length > LIMIT) throw new Error(ERROR)
      return validate(JSON.parse(this.#safeStorage.decryptString(encrypted)))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw new Error(ERROR)
    } finally { await handle?.close() }
  }
  async status() {
    await (queues.get(this.#path) || Promise.resolve())
    try { this.#protected() } catch { return { ...empty(ERROR), safeStore: false } }
    try { const config = await this.#read(); return { ...(config ? publicStatus(config) : empty(null)), safeStore: true } }
    catch { return { ...empty(ERROR), safeStore: true } }
  }
  async readForBackend() {
    await (queues.get(this.#path) || Promise.resolve())
    try { return await this.#read() } catch { throw new Error(ERROR) }
  }
  forget() {
    const action = (queues.get(this.#path) || Promise.resolve()).then(async () => {
      try {
        // Deletion must remain possible if the OS keyring stops working. Do
        // not decrypt or consult safeStorage when removing the private file.
        await inspectPath(this.#path)
        try { await unlink(this.#path) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        return empty(null)
      } catch { throw new Error(ERROR) }
    })
    const settled = action.catch(() => {})
    queues.set(this.#path, settled)
    void settled.then(() => { if (queues.get(this.#path) === settled) queues.delete(this.#path) })
    return action
  }
  save(value) {
    // Snapshot immediately: later caller mutations cannot alter queued writes.
    let config
    try { config = validate(value) } catch { return Promise.reject(new Error(ERROR)) }
    const action = (queues.get(this.#path) || Promise.resolve()).then(async () => {
      let temporary
      try {
        this.#protected()
        await inspectPath(this.#path)
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
        await inspectPath(this.#path)
        const encrypted = this.#safeStorage.encryptString(JSON.stringify(config))
        if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > LIMIT) throw new Error(ERROR)
        temporary = `${this.#path}.${randomUUID()}.tmp`
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
        try { await handle.writeFile(encrypted); await handle.sync() } finally { await handle.close() }
        await inspectPath(this.#path)
        await rename(temporary, this.#path)
        temporary = null
        return publicStatus(config)
      } catch { throw new Error(ERROR) }
      finally { if (temporary) await unlink(temporary).catch(() => {}) }
    })
    const settled = action.catch(() => {})
    queues.set(this.#path, settled)
    void settled.then(() => { if (queues.get(this.#path) === settled) queues.delete(this.#path) })
    return action
  }
}
