// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')
const start = source.indexOf('function installMenu() {')
const end = source.indexOf('\nasync function installProcessing()', start)
assert.ok(start >= 0 && end > start)
const menuSource = source.slice(start, end)

function buildMenu(platform, packaged) {
  let menu
  const calls = []
  const context = vm.createContext({
    process: { platform }, packaged, brand: 'singhouse',
    Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { menu = value } },
    host: { webContents: { send: channel => calls.push(channel) } },
    runUpdateOperation: action => { calls.push('guard'); action() },
    backupLibrary: () => calls.push('backup'), restoreLibrary: () => calls.push('restore'),
  })
  new vm.Script(`${menuSource}\ninstallMenu()`).runInContext(context)
  return { menu, calls }
}

for (const platform of ['linux', 'win32', 'darwin']) {
  test(`${platform} keeps processing settings, guarded backup/restore and native window actions`, () => {
    const { menu, calls } = buildMenu(platform, true)
    assert.deepEqual(Array.from(menu, item => item.label), platform === 'darwin'
      ? ['singhouse', 'Settings', 'Window'] : ['Settings', 'Window'])
    const settings = menu.find(item => item.label === 'Settings').submenu
    assert.deepEqual(Array.from(settings, item => item.label || item.type), [
      'Song processing…', 'separator', 'Back up library database', 'Restore library database…',
    ])
    settings[0].click(); settings[2].click(); settings[3].click()
    assert.deepEqual(calls, ['setup:open', 'guard', 'backup', 'guard', 'restore'])
    assert.deepEqual(Array.from(menu.find(item => item.label === 'Window').submenu, item => item.role), ['minimize', 'close', 'quit'])
    if (platform === 'darwin') assert.equal(menu[0].submenu[0].role, 'quit')
  })
}
test('source development shell does not offer unavailable packaged settings', () => {
  const { menu } = buildMenu('linux', false)
  assert.deepEqual(Array.from(menu, item => item.label), ['Window'])
})
