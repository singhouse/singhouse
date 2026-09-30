// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'

export function packagedResources(executable, platform = process.platform) {
  assert.ok(['linux', 'win32', 'darwin'].includes(platform), 'Unsupported packaged smoke platform')
  const path = platform === 'win32' ? win32 : posix
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
