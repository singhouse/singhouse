// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function physicalFileHash(path, physicalFs) {
  return hash(physicalFs.readFileSync(path))
}

export function physicalApplicationRecords(rootDirectory, physicalFs, current = rootDirectory) {
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
      records.push(...physicalApplicationRecords(rootDirectory, physicalFs, path))
    } else if (info.isFile()) records.push([relativePath, hash(physicalFs.readFileSync(path))])
    else throw new Error('Installed application contains an unsupported entry')
  }
  return records
}
