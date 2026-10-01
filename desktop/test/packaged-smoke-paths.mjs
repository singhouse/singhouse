// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'

const platformPath = platform => {
  assert.ok(['linux', 'win32', 'darwin'].includes(platform), 'Unsupported packaged smoke platform')
  return platform === 'win32' ? win32 : posix
}

export function packagedResources(executable, platform = process.platform) {
  const path = platformPath(platform)
  assert.ok(path.isAbsolute(executable), 'Packaged executable must be absolute')
  const directory = path.dirname(executable)
  if (platform === 'darwin') {
    const contents = path.dirname(directory)
    assert.equal(path.basename(directory), 'MacOS', 'Pass the executable inside .app/Contents/MacOS')
    assert.equal(path.basename(contents), 'Contents', 'Expected application bundle Contents directory')
    assert.ok(path.basename(path.dirname(contents)).endsWith('.app'), 'Expected an application bundle')
    return path.join(contents, 'Resources')
  }
  return path.join(directory, 'resources')
}

// Mirrors the packaged application's own native selection (main.mjs nativeDir).
export function packagedLayout(executable, platform = process.platform) {
  const path = platformPath(platform), resources = packagedResources(executable, platform)
  const native = path.join(resources, 'native'), bin = path.join(native, 'ffmpeg', 'bin'), suffix = platform === 'win32' ? '.exe' : ''
  return { kind: platform === 'darwin' ? 'application-bundle-contents-resources' : 'resources-beside-executable',
    resources, native, python: platform === 'win32' ? path.join(native, 'python', 'python.exe') : path.join(native, 'python', 'bin', 'python3'),
    ffmpeg: path.join(bin, `ffmpeg${suffix}`), ffprobe: path.join(bin, `ffprobe${suffix}`) }
}

// Path identity for already-resolved local paths. NTFS and default macOS
// volumes fold case; Linux filesystems do not, so folding there could accept
// a different directory. Case-sensitive APFS volumes are not distinguished.
export function samePath(left, right, platform = process.platform) {
  const path = platformPath(platform), a = path.resolve(left), b = path.resolve(right)
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
}

// Strict containment under the same case rule as samePath: `child` is inside
// `parent` and is not `parent` itself. posix.relative is case-sensitive, so a
// macOS path differing only in letter case would otherwise look unrelated.
// Unicode normalization differences are not folded.
export function isInside(parent, child, platform = process.platform) {
  const path = platformPath(platform)
  const fold = value => platform === 'linux' ? path.resolve(value) : path.resolve(value).toLowerCase()
  const rel = path.relative(fold(parent), fold(child))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
