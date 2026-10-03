// SPDX-License-Identifier: AGPL-3.0-only
// Run on a desktop, or with xvfb-run on Linux. Never disables the sandbox.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function waitForHost(application) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const host = application.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\//.test(window.url()))
    if (host) return host
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('Desktop host did not open after startup')
}

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const application = await electron.launch({ chromiumSandbox: true, args: [desktop, '--demo'], env: process.env })
let runtime
try {
  const sandboxBypassSwitches = await application.evaluate(({ app }) => ['no-sandbox', 'disable-sandbox', 'disable-setuid-sandbox', 'disable-seccomp-filter-sandbox', 'disable-gpu-sandbox', 'disable-namespace-sandbox', 'single-process', 'in-process-gpu'].filter(flag => app.commandLine.hasSwitch(flag)))
  assert.deepEqual(sandboxBypassSwitches, [], 'Electron must run without sandbox bypass switches')
  runtime = await application.evaluate(({ app }) => app.getPath('userData').replace(/[\\/]electron$/, ''))
  const host = await waitForHost(application)
  await host.getByText('Quiet light', { exact: true }).click()
  await host.getByRole('button', { name: 'Play', exact: true }).click()
  await host.getByRole('button', { name: 'Pause', exact: true }).waitFor()
  await host.getByText('Audio output', { exact: true }).click()
  await host.getByText('Output applied.', { exact: true }).waitFor()
  const selection = host.locator('.audio-output select')
  const panel = await host.locator('.audio-output__panel').boundingBox()
  const viewport = await host.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.ok(panel && panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= viewport.width && panel.y + panel.height <= viewport.height, 'output panel must be entirely inside the viewport')
  await selection.click({ trial: true })
  await host.getByRole('button', { name: 'Refresh devices', exact: true }).click()
  const outputIds = await selection.locator('option').evaluateAll(options => options.map(option => option.value))
  if (outputIds.length > 1) {
    await selection.selectOption(outputIds[1])
    await host.getByText('Output applied.', { exact: true }).waitFor()
    await selection.selectOption('')
    await host.getByText('Output applied.', { exact: true }).waitFor()
  }
  await host.getByText('Audio output', { exact: true }).click()
  const popupOpened = application.waitForEvent('window')
  await host.locator('button.popout-btn').click()
  const projector = await popupOpened
  await projector.locator('canvas').waitFor()
  const firstFrame = await projector.locator('canvas').evaluate(canvas => canvas.toDataURL())
  await new Promise(resolveWait => setTimeout(resolveWait, 2500))
  assert.notEqual(await projector.locator('canvas').evaluate(canvas => canvas.toDataURL()), firstFrame, 'synthetic lyrics must render and change in the foreground')
  const settings = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    sandbox: window.webContents.getLastWebPreferences().sandbox,
    isolation: window.webContents.getLastWebPreferences().contextIsolation,
    node: window.webContents.getLastWebPreferences().nodeIntegration,
    throttling: window.webContents.getBackgroundThrottling(),
  })))
  assert.equal(settings.length, 2)
  for (const settingsForWindow of settings) assert.deepEqual(settingsForWindow, { sandbox: true, isolation: true, node: false, throttling: false })
  const time = async () => Number(await host.getByRole('slider', { name: 'Playback position' }).getAttribute('aria-valuenow'))
  const before = await time()
  const canvasBefore = await projector.locator('canvas').evaluate(canvas => canvas.toDataURL())
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http:')).hide())
  await new Promise(resolveWait => setTimeout(resolveWait, 3000))
  const hidden = await host.evaluate(() => document.hidden)
  const after = await time()
  const canvasAfter = await projector.locator('canvas').evaluate(canvas => canvas.toDataURL())
  // Baseline observation only: hidden-host reliability has separate qualification.
  console.log(JSON.stringify({ hiddenHostBaseline: { hidden, before, after, canvasChanged: canvasBefore !== canvasAfter }, outputSwitchExercised: outputIds.length > 1 }))
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http:')).show())
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'about:blank').close())
  await host.locator('button.popout-btn:not(.popout-btn--active)').waitFor()
  const reopened = application.waitForEvent('window')
  await host.locator('button.popout-btn').click()
  await reopened
  const boundary = await host.evaluate(async () => ({ node: typeof require, bridge: Object.keys(window.karaokeDesktop), blocked: await fetch('http://127.0.0.1:9/').then(() => false, () => true) }))
  assert.deepEqual(boundary, { node: 'undefined', bridge: ['isDesktop', 'managedSetup', 'prepareHeart', 'getLyricsLookup', 'setLyricsLookup', 'getOnboardingState', 'setOnboardingState', 'preflightSetup', 'chooseModelSource', 'getModalStatus', 'saveModalConfig', 'checkModalConnection', 'forgetModalConfig', 'getSetupStatus', 'startSetup', 'cancelSetup', 'restartApp', 'openSetupHelp', 'onOpenSetup'], blocked: true })
  console.log('Native foreground playback, output control, projector reopen and sandbox checks passed.')
} finally {
  await application.close()
}
assert.equal(existsSync(runtime), false, 'normal exit must remove the complete owned runtime')
console.log('Owned runtime removed after normal exit. Physical audibility and external displays remain manual checks.')
