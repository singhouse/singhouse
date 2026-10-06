// SPDX-License-Identifier: AGPL-3.0-only
// Linux: xvfb-run -a node desktop/test/packaged-smoke.mjs --executable /path/to/karaoke-desktop
// Outer AppImage: add --fixture-ffmpeg /absolute/path/to/ffmpeg for synthetic media only.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, appendFileSync, statSync, accessSync, constants, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'

import { closePackagedApplication, processTable } from './packaged-smoke-shutdown.mjs'
import { packagedResources } from './packaged-smoke-paths.mjs'

async function waitForHost(application) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const host = application.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\//.test(window.url()))
    if (host) return host
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('Desktop host did not open after startup')
}

assert.ok(['linux', 'win32', 'darwin'].includes(process.platform), 'This harness supports Linux, Windows and macOS packaged applications')
const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1]
  assert.ok(['--executable', '--fixture-ffmpeg'].includes(name), `Unknown argument: ${name}`)
  assert.ok(!options.has(name), `Duplicate argument: ${name}`)
  assert.ok(value && !value.startsWith('--'), `Missing value for ${name}`)
  options.set(name, value)
}
assert.ok(options.has('--executable'), 'Pass --executable pointing to the packaged application')
const executablePath = resolve(options.get('--executable'))
const resources = packagedResources(executablePath)
const observationPython = join(resources, 'native', 'python', 'bin', 'python3')
const fixtureFfmpeg = options.get('--fixture-ffmpeg')
if (fixtureFfmpeg !== undefined) {
  assert.ok(isAbsolute(fixtureFfmpeg), '--fixture-ffmpeg must be an absolute path')
  assert.ok(statSync(fixtureFfmpeg).isFile(), '--fixture-ffmpeg must name an existing regular executable file')
  accessSync(fixtureFfmpeg, constants.X_OK)
}
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'singhouse-packaged-smoke-')))
const env = { ...process.env, XDG_CONFIG_HOME: temporary }
delete env.KARAOKE_DESKTOP_PYTHON
delete env.ELECTRON_RUN_AS_NODE
let application, userData, settings, songId, failed
let collectingLogs = true
const diagnostic = (entry) => appendFileSync(join(temporary, 'smoke-diagnostics.jsonl'), `${JSON.stringify(entry)}\n`)
async function shutdown() {
  const owned = application
  diagnostic({ event: 'shutdown-windows', urls: owned.windows().map(window => window.url()) })
  // Consume this handle once; cleanup on failure must not retry an unbounded close.
  application = null
  await closePackagedApplication(owned, { report: diagnostic,
    table: () => processTable({ python: observationPython }) })
}
const title = 'Original packaged smoke'
const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds))

async function launch() {
  // Launch the built executable itself. No source application or demo args.
  application = await electron.launch({ chromiumSandbox: true, executablePath, args: [`--user-data-dir=${join(temporary, 'profile')}`], env, timeout: 60000 })
  let logBytes = 0
  for (const [name, stream] of [['stdout', application.process().stdout], ['stderr', application.process().stderr]]) {
    stream?.on('data', data => {
      if (!collectingLogs || logBytes >= 1024 * 1024) return
      const text = data.toString().slice(0, 1024 * 1024 - logBytes)
      logBytes += text.length
      diagnostic({ event: name, text })
    })
  }
  const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData'),
    sandboxBypassSwitches: ['no-sandbox', 'disable-sandbox', 'disable-setuid-sandbox', 'disable-seccomp-filter-sandbox', 'disable-gpu-sandbox', 'disable-namespace-sandbox', 'single-process', 'in-process-gpu'].filter(flag => app.commandLine.hasSwitch(flag)) }))
  assert.equal(identity.packaged, true)
  assert.deepEqual(identity.sandboxBypassSwitches, [], 'Electron must run without sandbox bypass switches')
  const child = relative(temporary, identity.userData)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Packaged app must use isolated test userData')
  if (userData) assert.equal(identity.userData, userData)
  userData = identity.userData
  const host = await waitForHost(application)
  await host.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//)
  await host.waitForLoadState('domcontentloaded')
  const healthy = await host.evaluate(async () => {
    const [health, songs] = await Promise.all([fetch('/health'), fetch('/api/songs')])
    return [health.status, songs.status]
  })
  assert.deepEqual(healthy, [200, 200], 'Packaged session must authenticate itself')
  const welcome = host.getByRole('button', { name: 'I already have karaoke files →' })
  if (await welcome.isVisible()) {
    await host.getByRole('button', { name: 'Get started →' }).click()
    await host.getByRole('heading', { name: /Where should we/ }).waitFor()
    const facts = await host.evaluate(() => window.karaokeDesktop.preflightSetup())
    assert.equal(facts.hardware.platform, process.platform)
    assert.ok(facts.hardware.totalMemoryBytes > 0)
    assert.equal(facts.ready, false, 'Clean profile cannot already have local processing')
    await host.getByRole('button', { name: /My Modal account/ }).click()
    await host.getByRole('button', { name: 'Continue →', exact: true }).click()
    await host.getByRole('heading', { name: 'Look up lyrics with LRCLIB?' }).waitFor()
    assert.equal(await host.getByTestId('onboarding-lrclib').isChecked(), false, 'Lyrics lookup is opt-in and defaults off')
    await host.getByTestId('onboarding-lyrics-continue').click()
    await host.getByRole('heading', { name: 'Save and check your connection' }).waitFor()
    assert.equal(await host.getByRole('button', { name: 'Check saved connection' }).isEnabled(), false)
    assert.equal(await host.locator('input[name="tokenSecret"]').inputValue(), '')
    // Never enter credentials or call Modal during a packaged smoke test.
    await host.locator('button.library').click()
  }
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
  assert.deepEqual(boundary, { node: 'undefined', bridge: ['isDesktop', 'managedSetup', 'prepareHeart', 'getLyricsLookup', 'setLyricsLookup', 'getOnboardingState', 'setOnboardingState', 'preflightSetup', 'chooseModelSource', 'getModalStatus', 'saveModalConfig', 'checkModalConnection', 'forgetModalConfig', 'getSetupStatus', 'startSetup', 'pauseSetup', 'cancelSetup', 'restartApp', 'openSetupHelp', 'onOpenSetup'], blocked: true })
}

try {
  const fixture = join(temporary, 'synthetic.mp4')
  // An external encoder generates only the synthetic input. It is not evidence
  // that the image includes or authenticates that encoder; import still uses
  // the packaged backend and its own admitted runtime.
  const ffmpeg = fixtureFfmpeg ?? join(resources, 'native', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  diagnostic({ event: 'fixture-encoder', path: ffmpeg, external: fixtureFfmpeg !== undefined })
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
  await host.getByRole('button', { name: 'Pop out lyrics', exact: true }).click()
  const projector = await opened
  await projector.locator('video').waitFor()
  await projector.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.readyState >= 2 && video.currentTime > 0), null, { timeout: 15000 })
  const before = await projector.locator('video').evaluate(video => video.currentTime)
  await wait(1500)
  const after = await projector.locator('video').evaluate(video => video.currentTime)
  assert.ok(after > before, 'Packaged projector video must advance during playback')
  await sandboxChecks(host)
  assert.equal((await application.windows()).length, 2)
  await shutdown()
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
  await shutdown()
} catch (error) {
  failed = error
  diagnostic({ event: 'failure', error: error.stack ?? String(error) })
  console.error(error)
} finally {
  if (application) {
    try { await shutdown() }
    catch (error) { failed ??= error; console.error(error) }
  }
  if (failed) console.error(`FAIL: packaged smoke; diagnostics and isolated profile retained at ${temporary}`)
  else {
    collectingLogs = false
    rmSync(temporary, { recursive: true, force: true })
    console.log('PASS: packaged executable, isolated storage, synthetic video import/playback/projector, sandbox, persistent relaunch, both clean shutdowns. Physical audio and external displays remain unverified.')
  }
}
// A failed Playwright close can retain transport handles. Owned process cleanup
// has already run; do not let those handles hide the failure indefinitely.
if (failed) process.exit(1)
