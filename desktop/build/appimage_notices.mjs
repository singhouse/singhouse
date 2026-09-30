// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeImmutableFile } from './release_receipt.mjs'

export const appImageNoticesDirectory = fileURLToPath(new URL('../third-party/appimage/', import.meta.url))
export const appImageNoticesResource = 'resources/third-party/appimage'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const order = (a, b) => Buffer.from(a.path).compare(Buffer.from(b.path))

async function regularBytes(root, path) {
  if (!/^[A-Za-z0-9_+./-]+$/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe AppImage provenance path: ${path}`)
  let current = resolve(root)
  if (!(await lstat(current)).isDirectory()) throw new Error('AppImage input root must be an unlinked directory')
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part)
    const info = await lstat(current)
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw new Error(`AppImage provenance requires regular files and directories: ${path}`)
  }
  return readFile(current)
}

async function checked(root, record) {
  const bytes = await regularBytes(root, record.path)
  if (hash(bytes) !== record.sha256) throw new Error(`AppImage provenance hash mismatch: ${record.path}`)
  return bytes
}

export async function loadAppImageNotices(directory = appImageNoticesDirectory) {
  const bytes = await regularBytes(directory, 'inventory.json')
  const inventory = JSON.parse(bytes)
  if (inventory.schema !== 1 || inventory.arch !== 'x64' || inventory.libraries.length !== 6 || inventory.sources.length !== 18 || !inventory.notices.length) throw new Error('Unsupported AppImage library inventory')
  for (const records of [inventory.libraries, inventory.sources, inventory.notices]) {
    const seen = new Set()
    for (const record of records) {
      if (seen.has(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Invalid AppImage provenance record')
      seen.add(record.path)
    }
  }
  for (const record of inventory.notices) await checked(directory, record)
  return { inventory, bytes }
}

export async function verifyAppImageNotices({ applicationDirectory, arch, toolset = '0.0.0', builderVersion = '26.15.3', metadataDirectory = appImageNoticesDirectory }) {
  const { inventory, bytes } = await loadAppImageNotices(metadataDirectory)
  const target = inventory.targets[arch]
  if (!target || toolset !== inventory.builder.toolset || builderVersion !== inventory.builder.electronBuilderVersion) throw new Error('Unsupported AppImage library architecture or toolset')
  const installed = resolve(applicationDirectory, appImageNoticesResource)
  if (!(await regularBytes(installed, 'inventory.json')).equals(bytes)) throw new Error('Packaged AppImage inventory differs from the checked-in inventory')
  for (const record of inventory.notices) await checked(installed, record)
  const expected = target.libraries.map(path => path.replace(/^usr\/lib\//, '')).sort()
  let observed = []
  try {
    const usr = resolve(applicationDirectory, 'usr')
    if (!(await lstat(usr)).isDirectory() || !(await lstat(resolve(usr, 'lib'))).isDirectory()) throw new Error('AppImage library directories must not be linked')
    observed = await readdir(resolve(usr, 'lib'))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (JSON.stringify(observed.sort()) !== JSON.stringify(expected)) throw new Error('AppImage bundled-library set differs from the exact inventory')
  for (const path of target.libraries) {
    const record = inventory.libraries.find(record => record.path === path)
    if (!record) throw new Error('AppImage target has an unknown library')
    await checked(applicationDirectory, record)
  }
  return inventory
}

// Fixed USTAR regular files only: byte-sorted names, 0644, uid/gid/mtime zero,
// no platform-dependent directory records, compression headers, or paths.
function sourceTar(records) {
  const chunks = []
  for (const { path, bytes } of [...records].sort(order)) {
    if (Buffer.byteLength(path) > 100) throw new Error('AppImage source artifact path exceeds USTAR limit')
    const header = Buffer.alloc(512)
    header.write(path, 0, 100, 'utf8')
    const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii')
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8)
    octal(bytes.length, 124, 12); octal(0, 136, 12)
    header.fill(32, 148, 156); header[156] = 48
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii')
    const sum = header.reduce((a, b) => a + b, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)])
}

export async function createAppImageSourceBundle({ inputDirectory, output, metadataDirectory = appImageNoticesDirectory }) {
  if (!inputDirectory) throw new Error('Set SINGHOUSE_APPIMAGE_SOURCE_INPUTS to the prepared, hash-locked AppImage source input directory')
  const { inventory, bytes } = await loadAppImageNotices(metadataDirectory)
  const records = [{ path: 'inventory.json', bytes }]
  for (const record of inventory.notices) records.push({ path: record.path, bytes: await checked(metadataDirectory, record) })
  for (const record of inventory.sources) records.push({ path: record.path, bytes: await checked(inputDirectory, record) })
  const checksums = records.sort(order).map(record => `${hash(record.bytes)}  ${record.path}\n`).join('')
  records.push({ path: 'SHA256SUMS', bytes: Buffer.from(checksums) })
  const archive = sourceTar(records), sha256 = hash(archive)
  await writeImmutableFile(output, archive)
  await writeImmutableFile(`${output}.sha256`, `${sha256}  ${basename(output)}\n`)
  return { output, sha256 }
}
