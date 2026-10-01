// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import test from 'node:test'
import { isInside, packagedLayout, packagedResources, samePath } from './packaged-smoke-paths.mjs'

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

test('native layout selects each platform bundled Python and media tools', () => {
  assert.deepEqual(packagedLayout('C:\\Program Files\\Singhouse\\Singhouse.exe', 'win32'), { kind: 'resources-beside-executable',
    resources: 'C:\\Program Files\\Singhouse\\resources', native: 'C:\\Program Files\\Singhouse\\resources\\native',
    python: 'C:\\Program Files\\Singhouse\\resources\\native\\python\\python.exe',
    ffmpeg: 'C:\\Program Files\\Singhouse\\resources\\native\\ffmpeg\\bin\\ffmpeg.exe',
    ffprobe: 'C:\\Program Files\\Singhouse\\resources\\native\\ffmpeg\\bin\\ffprobe.exe' })
  assert.deepEqual(packagedLayout('/Applications/Singhouse.app/Contents/MacOS/Singhouse', 'darwin'), { kind: 'application-bundle-contents-resources',
    resources: '/Applications/Singhouse.app/Contents/Resources', native: '/Applications/Singhouse.app/Contents/Resources/native',
    python: '/Applications/Singhouse.app/Contents/Resources/native/python/bin/python3',
    ffmpeg: '/Applications/Singhouse.app/Contents/Resources/native/ffmpeg/bin/ffmpeg',
    ffprobe: '/Applications/Singhouse.app/Contents/Resources/native/ffmpeg/bin/ffprobe' })
  assert.deepEqual(packagedLayout('/opt/linux-unpacked/Singhouse', 'linux'), { kind: 'resources-beside-executable',
    resources: '/opt/linux-unpacked/resources', native: '/opt/linux-unpacked/resources/native',
    python: '/opt/linux-unpacked/resources/native/python/bin/python3',
    ffmpeg: '/opt/linux-unpacked/resources/native/ffmpeg/bin/ffmpeg', ffprobe: '/opt/linux-unpacked/resources/native/ffmpeg/bin/ffprobe' })
  assert.throws(() => packagedLayout('/Applications/Singhouse', 'darwin'), /MacOS/)
  assert.throws(() => packagedLayout('/opt/Singhouse', 'freebsd'), /Unsupported/)
})

test('path identity folds case only where the platform filesystem does', () => {
  assert.equal(samePath('C:\\Evidence\\Profile', 'c:\\evidence\\profile', 'win32'), true)
  assert.equal(samePath('/Users/Op/Evidence/Profile', '/users/op/evidence/profile', 'darwin'), true)
  // A Linux directory differing only in case is a different directory.
  assert.equal(samePath('/srv/Evidence/Profile', '/srv/evidence/profile', 'linux'), false)
  assert.equal(samePath('/srv/evidence/profile', '/srv/evidence/./profile/', 'linux'), true)
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(samePath(platform === 'win32' ? 'C:\\a\\profile' : '/a/profile', platform === 'win32' ? 'C:\\a\\other' : '/a/other', platform), false)
  }
  assert.throws(() => samePath('/a', '/a', 'aix'), /Unsupported/)
})

test('containment folds case on macOS and Windows but not on Linux', () => {
  // A macOS evidence directory differing only in case is the same directory.
  assert.equal(isInside('/Users/Op/Evidence', '/users/op/evidence/profile', 'darwin'), true)
  assert.equal(isInside('/Users/Op/Evidence/Profile', '/users/op/evidence', 'darwin'), false)
  assert.equal(isInside('/Users/Op/Evidence/Profile', '/users/op/evidence/profile/run', 'darwin'), true)
  assert.equal(isInside('/Users/Op/Evidence', '/users/op/EVIDENCE', 'darwin'), false)
  assert.equal(isInside('/Users/Op/Profile', '/Users/Op/Evidence', 'darwin'), false)
  assert.equal(isInside('C:\\Evidence', 'c:\\evidence\\profile', 'win32'), true)
  assert.equal(isInside('c:\\EVIDENCE', 'C:\\Evidence\\Profile', 'win32'), true)
  assert.equal(isInside('/srv/Evidence', '/srv/evidence/profile', 'linux'), false)
  assert.equal(isInside('/srv/evidence', '/srv/evidence/profile', 'linux'), true)
  for (const platform of ['darwin', 'linux']) {
    assert.equal(isInside('/a/evidence', '/a/evidence', platform), false)
    assert.equal(isInside('/a/evidence', '/a/evidence/../other', platform), false)
    // A sibling whose name merely starts with dots is not an escape or a child.
    assert.equal(isInside('/a/evidence', '/a/evidence/..profile', platform), true)
    assert.equal(isInside('/a/evidence', '/a/..evidence', platform), false)
  }
  assert.throws(() => isInside('/a', '/a/b', 'aix'), /Unsupported/)
})
