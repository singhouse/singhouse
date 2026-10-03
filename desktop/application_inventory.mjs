// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { validateInstalledReleaseReceipt } from './release.mjs'
import { checkedFile, checkedRead, durableReplace } from './runtime_manager.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function physicalFileHash(path, physicalFs) {
  return hash(physicalFs.readFileSync(path))
}

// A regular file the receipt does not declare as a file. It can never equal a
// declared value, so the receipt check rejects it unless the path is excluded.
export const UNDECLARED_FILE = 'file:undeclared'

// Each regular file takes the sha256 its receipt declares instead of hashing
// its bytes. The walk still checks every entry's type, symlink target and the
// exact inventory against the receipt.
export function declaredFileDigests(receipt) {
  const files = Array.isArray(receipt?.application?.files) ? receipt.application.files : []
  const declared = new Map(files.filter(record => record?.type === 'file' && typeof record.sha256 === 'string')
    .map(record => [record.path, record.sha256]))
  return relativePath => declared.get(relativePath) ?? UNDECLARED_FILE
}

// Without `fileDigest` every regular file is content-hashed (the signed macOS
// bundle path); with it, each digest comes from
// `fileDigest(relativePath, path, lstatInfo)` and file bytes are read only if
// that function reads them.
export function physicalApplicationRecords(rootDirectory, physicalFs, current = rootDirectory, fileDigest) {
  const records = []
  for (const name of physicalFs.readdirSync(current).sort()) {
    const path = resolve(current, name), info = physicalFs.lstatSync(path)
    const relativePath = relative(rootDirectory, path).split(sep).join('/')
    if (info.isSymbolicLink()) {
      const raw = physicalFs.readlinkSync(path), target = relative(rootDirectory, resolve(dirname(path), raw)).split(sep).join('/')
      if (isAbsolute(raw) || target === '..' || target.startsWith('../')) throw new Error('Installed application symlink escapes its bundle')
      records.push([relativePath, `symlink:${target}`])
    } else if (info.isDirectory()) {
      records.push([relativePath, 'directory'])
      records.push(...physicalApplicationRecords(rootDirectory, physicalFs, path, fileDigest))
    } else if (info.isFile()) records.push([relativePath, fileDigest ? fileDigest(relativePath, path, info) : hash(physicalFs.readFileSync(path))])
    else throw new Error('Installed application contains an unsupported entry')
  }
  return records
}

// True only when kernel evidence (readOnlyAppImageMount(), never
// APPIMAGE/APPDIR) shows the application root inside a read-only FUSE mount.
export function readOnlyApplicationRoot(mount, applicationRoot) {
  if (mount?.readOnly !== true || typeof mount.mountPath !== 'string' || !isAbsolute(mount.mountPath)) return false
  const inside = relative(mount.mountPath, applicationRoot)
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}

// The launch inventory cache for a writable receipt-described installation:
// each file's size, modification and change times, inode and device, taken
// from the descriptor that was hashed in a full content walk that matched the
// receipt, and bound to that receipt and the canonical application root.
export function validLaunchInventory(value, receipt, applicationRoot) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['applicationRoot', 'files', 'inventoryDigest', 'schema'])
    && value.schema === 1 && value.applicationRoot === applicationRoot
    && typeof value.inventoryDigest === 'string' && value.inventoryDigest === receipt?.application?.inventoryDigest
    && value.files && typeof value.files === 'object' && !Array.isArray(value.files))
}

const staleInventory = Symbol('launch inventory is stale')

// The recorded identity of one file. On POSIX systems utimes cannot set
// ctime, so a content change that restores the modification time still
// differs. A Windows file owner can set it; that stays within the writable
// installation's same-user trust boundary.
const fileFacts = info => [info.size, info.mtimeMs, info.ctimeMs, info.ino, info.dev]

// Hashes a regular file through one descriptor, confirming it is the entry the
// walk observed, and returns its digest with that descriptor's facts. The open
// never follows a link and never blocks on a special file.
function hashedFile(path, info, physicalFs) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = physicalFs.constants
  const descriptor = physicalFs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    const opened = physicalFs.fstatSync(descriptor)
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Installed application file changed while it was checked')
    return { digest: hash(physicalFs.readFileSync(descriptor)), facts: fileFacts(opened) }
  } finally { physicalFs.closeSync(descriptor) }
}

// Observes a receipt-described installation and checks it against the
// receipt. Content is hashed unless the root is in a kernel-reported
// read-only FUSE mount (the package and its receipt are the same immutable
// image), or a launch inventory recorded after an earlier full walk still
// matches every file's recorded facts; then the digests come from the
// receipt. Any cache mismatch falls back to the full walk, which returns a
// fresh cache bound to `inventoryRoot` (the canonical application root).
export function observeReceiptApplication({ rootDirectory, current = rootDirectory, leading = [], physicalFs, receipt, target,
  readOnly = false, launchInventory = null, inventoryRoot = rootDirectory }) {
  const declared = declaredFileDigests(receipt)
  const walk = fileDigest => [...leading, ...physicalApplicationRecords(rootDirectory, physicalFs, current, fileDigest)]
  const check = records => validateInstalledReleaseReceipt(receipt, new Map(records), target)
  if (readOnly) {
    const records = walk(declared)
    return { mode: 'read-only', records, identity: check(records) }
  }
  if (validLaunchInventory(launchInventory, receipt, inventoryRoot)) {
    let records
    try {
      let seen = 0
      records = walk((relativePath, _path, info) => {
        const recorded = Object.hasOwn(launchInventory.files, relativePath) ? launchInventory.files[relativePath] : null
        const observed = fileFacts(info)
        if (!Array.isArray(recorded) || recorded.length !== observed.length || recorded.some((value, index) => value !== observed[index])) throw staleInventory
        seen++
        return declared(relativePath)
      })
      if (seen !== Object.keys(launchInventory.files).length) throw staleInventory
    } catch (error) { if (error !== staleInventory) throw error; records = null }
    if (records) return { mode: 'cached', records, identity: check(records) }
  }
  const files = {}
  const records = walk((relativePath, path, info) => {
    const { digest, facts } = hashedFile(path, info, physicalFs)
    files[relativePath] = facts
    return digest
  })
  const identity = check(records)
  return { mode: 'hashed', records, identity,
    launchInventory: { schema: 1, applicationRoot: inventoryRoot, inventoryDigest: receipt.application.inventoryDigest, files } }
}

// files.json and the receipt describe the same native files; their declared
// digests must agree (checking each against the same bytes implied this).
export function assertNativeInventoryDeclared(files, receipt, nativePrefix) {
  const declared = declaredFileDigests(receipt)
  for (const [name, expected] of Object.entries(files)) {
    if (declared(`${nativePrefix}${name}`) !== expected) throw new Error(`Installed native payload changed: ${name}`)
  }
}

// The receipt's declared digest for a file the receipt check has matched to
// the installed entry: the same value hashing that file would give.
export function declaredApplicationDigest(receipt, path) {
  const digest = declaredFileDigests(receipt)(path)
  if (digest === UNDECLARED_FILE) throw new Error('Installed application archive evidence is incomplete')
  return digest
}

export async function readLaunchInventory(path) {
  try { return JSON.parse(await checkedRead(path)) } catch { return null }
}

// Best-effort: a cache that cannot be recorded only means a full content walk
// at the next launch.
export async function writeLaunchInventory(path, value, { lockPython, durabilityHelper }) {
  try {
    const pending = `${path}.pending`
    const file = await checkedFile(pending, constants.O_CREAT | constants.O_RDWR)
    try {
      await file.truncate(0)
      await file.writeFile(JSON.stringify(value))
      await file.sync()
    } finally { await file.close() }
    await durableReplace(lockPython, durabilityHelper, pending, path)
    return true
  } catch { return false }
}
