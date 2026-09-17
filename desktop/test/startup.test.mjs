// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createStartupSurface } from '../startup.mjs'

function fixture(options = {}) {
  let window
  class BrowserWindow extends EventEmitter {
    constructor(config) {
      super()
      window = this
      this.config = config
      this.urls = []
      this.destroyed = false
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = handler => { this.popup = handler }
      this.webContents.session = {
        setPermissionRequestHandler: handler => { this.permission = handler },
        setPermissionCheckHandler: handler => { this.permissionCheck = handler },
        webRequest: { onBeforeRequest: handler => { this.request = handler } },
      }
    }
    setMenu(menu) { this.menu = menu }
    isDestroyed() { return this.destroyed }
    async loadURL(url) { this.urls.push(url); if (this.fail) throw new Error('load aborted') }
    close() { this.destroyed = true; this.emit('closed') }
  }
  const surface = createStartupSurface({ BrowserWindow, ...options })
  return { surface, window }
}
const document = url => decodeURIComponent(url.slice(url.indexOf(',') + 1))

test('startup is visible immediately, isolated, script-free and denies network and navigation', async () => {
  const { surface, window } = fixture()
  assert.equal(await surface.ready, true)
  assert.equal(window.config.show, true)
  assert.equal(window.config.webPreferences.sandbox, true)
  assert.equal(window.config.webPreferences.contextIsolation, true)
  assert.equal(window.config.webPreferences.nodeIntegration, false)
  assert.equal(window.config.webPreferences.javascript, false)
  assert.equal(window.config.webPreferences.preload, undefined)
  assert.match(window.config.webPreferences.partition, /^startup-/)
  assert.equal(window.menu, null)
  assert.match(document(window.urls[0]), /default-src 'none'/)
  assert.match(document(window.urls[0]), /script-src 'none'/)
  assert.doesNotMatch(document(window.urls[0]), /<script/i)
  for (const url of ['https://example.org/', 'http://127.0.0.1/', 'file:///etc/passwd', 'data:text/html,bad']) {
    window.request({ url }, decision => assert.equal(decision.cancel, true))
  }
  window.request({ url: window.urls[0] }, decision => assert.equal(decision.cancel, false))
  assert.deepEqual(window.popup({ url: 'https://example.org/' }), { action: 'deny' })
  for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
    let prevented = false
    window.webContents.emit(event, { preventDefault() { prevented = true } })
    assert.equal(prevented, true)
  }
  window.permission(null, 'media', granted => assert.equal(granted, false))
  assert.equal(window.permissionCheck(), false)
  surface.close()
})

test('brand and phase remain text, and consecutive phase updates display the latest message', async () => {
  const { surface, window } = fixture({ brand: '<script>alert("x")</script>' })
  await surface.ready
  await Promise.all([surface.update('Checking files'), surface.update('<img src=x onerror="alert(1)"> & done')])
  const html = document(window.urls.at(-1))
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/)
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; done/)
  assert.doesNotMatch(html, /<script|<img|\d+%/)
  assert.equal(window.urls.length, 2)
  surface.close()
})

test('user closure notifies once; programmatic closure and late updates do not notify or load', async () => {
  let calls = 0
  const user = fixture({ onClose: () => calls++ })
  await user.surface.ready
  user.window.close()
  assert.equal(calls, 1)
  assert.equal(await user.surface.update('Too late'), false)
  user.surface.close()
  assert.equal(calls, 1)
  const programmatic = fixture({ onClose: () => calls++ })
  const pending = programmatic.surface.update('Checking files')
  programmatic.surface.close()
  programmatic.surface.close()
  await pending
  assert.equal(calls, 1)
  assert.equal(programmatic.window.urls.length, 1)
})

test('an interrupted document load is contained and separate surfaces never share sessions', async () => {
  const first = fixture(), second = fixture()
  await first.surface.ready
  first.window.fail = true
  assert.equal(await first.surface.update('Checking files'), false)
  assert.notEqual(first.window.config.webPreferences.partition, second.window.config.webPreferences.partition)
  first.surface.close()
  second.surface.close()
})
