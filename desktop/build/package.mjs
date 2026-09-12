// SPDX-License-Identifier: AGPL-3.0-only
import { build, Platform, Arch } from 'electron-builder'
import config from './installer.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const identity = JSON.parse(readFileSync(resolve(config.extraResources[0].from, 'manifest.json'), 'utf8'))
if (identity.platform === 'darwin' && process.platform !== 'darwin') {
  throw new Error('Create macOS installers on macOS')
}
const platform = { linux: Platform.LINUX, darwin: Platform.MAC, win32: Platform.WINDOWS }[identity.platform]
if (!platform || !['x64', 'arm64'].includes(identity.arch)) throw new Error('Unsupported native payload target')
await build({ config, publish: 'never', targets: platform.createTarget(undefined, Arch[identity.arch]) })
