// SPDX-License-Identifier: AGPL-3.0-only
// Linux: xvfb-run -a node desktop/test/packaged-smoke.mjs --executable /path/to/karaoke-desktop
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'

assert.ok(['linux', 'win32'].includes(process.platform), 'This harness supports Linux and Windows packaged applications')
const option = process.argv.indexOf('--executable')
assert.ok(option >= 0 && process.argv[option + 1], 'Pass --executable pointing to the packaged application')
const executablePath = resolve(process.argv[option + 1])
const temporary = mkdtempSync(join(tmpdir(), 'singhouse-packaged-smoke-'))
const env = { ...process.env, XDG_CONFIG_HOME: temporary }
delete env.KARAOKE_DESKTOP_PYTHON
delete env.ELECTRON_RUN_AS_NODE
let application, userData, settings, songId
const title = 'Original packaged smoke'
const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds))

async function launch() {
  // Launch the built executable itself. No source application or demo args.
  application = await electron.launch({ executablePath, args: [`--user-data-dir=${join(temporary, 'profile')}`], env, timeout: 60000 })
  const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData') }))
  assert.equal(identity.packaged, true)
  const child = relative(temporary, identity.userData)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Packaged app must use isolated test userData')
  if (userData) assert.equal(identity.userData, userData)
  userData = identity.userData
  const host = await application.firstWindow({ timeout: 60000 })
  await host.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//)
  await host.waitForLoadState('domcontentloaded')
  const healthy = await host.evaluate(async () => {
    const [health, songs] = await Promise.all([fetch('/health'), fetch('/api/songs')])
    return [health.status, songs.status]
  })
  assert.deepEqual(healthy, [200, 200], 'Packaged session must authenticate itself')
  return host
}

async function sandboxChecks(host) {
  const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    sandbox: window.webContents.getLastWebPreferences().sandbox,
    isolation: window.webContents.getLastWebPreferences().contextIsolation,
    node: window.webContents.getLastWebPreferences().nodeIntegration,
  })))
  for (const preference of preferences) assert.deepEqual(preference, { sandbox: true, isolation: true, node: false })
  const boundary = await host.evaluate(async () => ({
    node: typeof require,
    bridge: Object.keys(window.karaokeDesktop),
    blocked: await fetch('http://127.0.0.1:9/').then(() => false, () => true),
  }))
  assert.deepEqual(boundary, { node: 'undefined', bridge: ['isDesktop', 'prepareHeart'], blocked: true })
}

try {
  const fixture = join(temporary, 'synthetic.mp4')
  const ffmpeg = join(dirname(executablePath), 'resources/native/ffmpeg/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i',
    'sine=frequency=220:sample_rate=48000', '-t', '30', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', fixture], { timeout: 30000 })
  const host = await launch()
  settings = readFileSync(join(userData, 'backend/settings.json'))
  const uploaded = await host.evaluate(async ({ encoded, title }) => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'Synthetic.mp4')
    form.append('artist', 'Synthetic test media')
    form.append('title', title)
    const response = await fetch('/api/import/video', { method: 'POST', body: form })
    return { status: response.status, body: await response.json() }
  }, { encoded: readFileSync(fixture).toString('base64'), title })
  assert.equal(uploaded.status, 202)
  songId = uploaded.body.song_id
  const deadline = Date.now() + 60000
  while (true) {
    const status = await host.evaluate(async id => (await (await fetch(`/api/songs/${id}`)).json()).status, songId)
    if (status === 'ready') break
    assert.notEqual(status, 'failed', 'Prepared synthetic video import failed')
    assert.ok(Date.now() < deadline, 'Prepared synthetic video import timed out')
    await wait(250)
  }
  await host.reload()
  await host.locator('.song-item').filter({ hasText: title }).click()
  await host.getByRole('button', { name: 'Play', exact: true }).click()
  await host.getByRole('button', { name: 'Pause', exact: true }).waitFor()
  const opened = application.waitForEvent('window')
  await host.locator('button.popout-btn').click()
  const projector = await opened
  await projector.locator('video').waitFor()
  await projector.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.readyState >= 2 && video.currentTime > 0), null, { timeout: 15000 })
  const before = await projector.locator('video').evaluate(video => video.currentTime)
  await wait(1500)
  const after = await projector.locator('video').evaluate(video => video.currentTime)
  assert.ok(after > before, 'Packaged projector video must advance during playback')
  await sandboxChecks(host)
  assert.equal((await application.windows()).length, 2)
  await application.close()
  application = null
  assert.ok(existsSync(join(userData, 'backend/desktop.db')), 'Normal shutdown must preserve the library')
  const restoredHost = await launch()
  assert.deepEqual(readFileSync(join(userData, 'backend/settings.json')), settings)
  await restoredHost.locator('.song-item').filter({ hasText: title }).waitFor()
  const restored = await restoredHost.evaluate(async id => {
    const song = await (await fetch(`/api/songs/${id}`)).json()
    return { id: song.id, status: song.status, videoStatus: (await fetch(song.video_url)).status }
  }, songId)
  assert.deepEqual(restored, { id: songId, status: 'ready', videoStatus: 200 })
  await sandboxChecks(restoredHost)
  console.log('PASS: packaged executable, isolated storage, synthetic video import/playback/projector, sandbox, persistent relaunch. Physical audio and external displays remain unverified.')
} catch (error) {
  if (application) {
    for (const window of application.windows()) {
      console.error('Window diagnostic:', window.url(), await window.locator('body').innerText().catch(() => 'unavailable'))
    }
  }
  throw error
} finally {
  if (application) await application.close()
  rmSync(temporary, { recursive: true, force: true })
}
