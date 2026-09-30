// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import test from 'node:test'
import { packagedResources } from './packaged-smoke-paths.mjs'

test('Mac application resources are a sibling of MacOS, including paths with spaces', () => {
  assert.equal(packagedResources('/Applications/Test Singhouse.app/Contents/MacOS/Singhouse', 'darwin'),
    '/Applications/Test Singhouse.app/Contents/Resources')
  for (const path of ['/Applications/Singhouse.app', '/Applications/Singhouse', '/tmp/Contents/MacOS/Singhouse']) {
    assert.throws(() => packagedResources(path, 'darwin'))
  }
})

test('Windows and Linux packaged resources retain their existing location', () => {
  assert.equal(packagedResources('C:\\Program Files\\Singhouse\\Singhouse.exe', 'win32'), 'C:\\Program Files\\Singhouse\\resources')
  assert.equal(packagedResources('/opt/Singhouse/Singhouse', 'linux'), '/opt/Singhouse/resources')
  assert.throws(() => packagedResources('relative/Singhouse', 'linux'), /absolute/)
  assert.throws(() => packagedResources('/app/Singhouse', 'unsupported'), /Unsupported/)
})
