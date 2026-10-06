// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')
const preload = await readFile(new URL('../preload.cjs', import.meta.url), 'utf8')

// Source assertions: export uses fixed host-only channels, the folder comes
// only from the native picker, and the write goes through the authenticated
// application session rather than a browser save.
test('preload exposes the fixed export channels without path arguments', () => {
  assert.match(preload, /getExportDefaults: \(\) => ipcRenderer\.invoke\('export:defaults'\),/)
  assert.match(preload, /chooseExportFolder: \(\) => ipcRenderer\.invoke\('export:choose-folder'\),/)
  assert.match(preload, /saveExportDefaults: defaults => ipcRenderer\.invoke\('export:save-defaults', defaults\),/)
  assert.match(preload, /exportSong: request => ipcRenderer\.invoke\('export:write', request\),/)
  assert.match(preload, /writeVideoExport: request => ipcRenderer\.invoke\('export:write-video', request\),/)
})

test('main.mjs registers export channels behind the host-window check', () => {
  const start = main.indexOf('const exportHandler = ')
  assert.ok(start > 0, 'export handler present')
  const handler = main.slice(start, main.indexOf('})', start))
  assert.match(handler, /authorizedHeartCaller\(event, host, launch\.origin\) \|\| quitting \|\| handingOff/)
  for (const channel of ['export:defaults', 'export:choose-folder', 'export:save-defaults', 'export:write', 'export:write-video']) {
    assert.equal((main.match(new RegExp(`exportHandler\\('${channel}'`, 'g')) ?? []).length, 1, channel)
    assert.doesNotMatch(main, new RegExp(`ipcMain\\.handle\\('${channel}'`))
  }
  assert.match(main, /dialog\.showOpenDialog\(host, \{ properties: \['openDirectory', 'createDirectory'\] \}\)/)
  assert.match(main, /exportPreferences\.saveDefaults\(value\)/)
})

test('the export write uses the session fetch and the persisted folder', () => {
  const start = main.indexOf("exportHandler('export:write'")
  const block = main.slice(start, main.indexOf('}))', start))
  assert.match(block, /fetch: \(path, init\) => ses\.fetch\(`\$\{launch\.origin\}\$\{path\}`, \{ \.\.\.init, redirect: 'error' \}\)/)
  assert.match(block, /folder: \(await exportPreferences\.get\(\)\)\.folder, request,/)
  assert.match(main, /new OnboardingState\(resolve\(runtime\.root, 'export\.json'\)\)/)
  assert.match(main, /home: app\.getPath\('home'\) \}\)/)
  assert.match(main, /^import \{ ExportPreferences, defaultExportFolder, writeExport, writeVideoExport \} from '\.\/export_files\.mjs'$/m)
})

test('the video write uses the session fetch and the persisted folder', () => {
  const start = main.indexOf("exportHandler('export:write-video'")
  assert.ok(start > 0, 'video write handler present')
  const block = main.slice(start, main.indexOf('}))', start))
  assert.match(block, /writeVideoExport\(\{/)
  assert.match(block, /fetch: \(path, init\) => ses\.fetch\(`\$\{launch\.origin\}\$\{path\}`, \{ \.\.\.init, redirect: 'error' \}\)/)
  assert.match(block, /folder: \(await exportPreferences\.get\(\)\)\.folder, request,/)
})
