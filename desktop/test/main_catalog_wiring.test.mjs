// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')

// Source assertions: the packaged application must validate its shipped
// catalog with the same shared helper and release channel the packaging gate
// uses, and the setup wizard must apply that same channel.
test('main.mjs validates the shipped catalog with the packaged release channel', () => {
  const start = source.indexOf("const catalogPath = resolve(desktopDir, 'processing-catalog.json')")
  assert.ok(start > 0, 'catalog block present')
  const end = source.indexOf('new OnboardingSetup(', start)
  assert.ok(end > start, 'OnboardingSetup constructed after the catalog block')
  const block = source.slice(start, end)

  const calls = block.match(/validateShippedCatalog\(/g) ?? []
  assert.equal(calls.length, 1, 'exactly one shared shipped-catalog validation')
  const call = block.slice(block.indexOf('validateShippedCatalog('), block.indexOf('})', block.indexOf('validateShippedCatalog(')))
  assert.match(call, /validateShippedCatalog\(catalogText, \{/)
  assert.match(call, /releaseChannel: releasePolicy\.channel,/)

  const construct = source.slice(end, source.indexOf('})', end))
  assert.match(construct, /\bcatalog, catalogError, releaseChannel: releasePolicy\.channel,/)

  // releasePolicy is the packaged policy, assigned exactly once at startup.
  assert.equal((source.match(/\breleasePolicy = /g) ?? []).length, 1)
  assert.match(source, /releasePolicy = assertReleasePolicy\(JSON\.parse\(readFileSync\(releasePolicyPath, 'utf8'\)\)\)/)
  assert.match(source, /^import \{ validateShippedCatalog \} from '\.\/setup_catalog\.mjs'$/m)
})

test('main.mjs never uses the unrestricted catalog validator or private-test local sources', () => {
  assert.doesNotMatch(source, /validateSetupCatalog/)
  assert.doesNotMatch(source, /privateTestLocalSources/)
})

// Source assertions for the launch pack checks: a fresh self-test waits for
// the model cache check, the background re-check starts only once the window
// is shown, and the read-only mount evidence is bound to the application root.
test('main.mjs orders the launch self-test after the model check and re-checks packs after the window is shown', () => {
  const launch = source.slice(source.indexOf('const models = modelCache.active({ launch: true })'), source.indexOf(';({ activeProcessing, processingProbe, activeModels, processingError } = selection)'))
  assert.ok(launch.length > 0, 'launch selection block present')
  assert.match(launch, /const modelsSettled = \(\) => models\.then\(\(\) => \{\}, \(\) => \{\}\)/)
  assert.match(launch, /processingManager\.launchProbe\(active, \{ before: modelsSettled \}\)/)
  assert.match(launch, /\n {6}models,\n/)
  assert.equal((source.match(/modelCache\.active\(\{ launch: true \}\)/g) ?? []).length, 1)

  const end = source.slice(source.indexOf('  startupSurface.close()\n  if (packaged) recheckInstalledPacks()\n}'))
  assert.ok(end.length > 0, 'the re-check starts after the startup surface closes')
  assert.equal((source.match(/recheckInstalledPacks\(\)/g) ?? []).length, 2, 'defined once and started once')
  assert.match(source, /recheckPacks\(\[\n\s+\{ store: processingManager, active: activeProcessing,/)
  assert.match(source, /\{ store: modelCache, active: activeModels,/)
  for (const site of ["if (consent.response !== 1 || quitting) return\n", "setupHandler('setup:start'", 'quitting = true\n']) {
    const at = source.indexOf(site)
    assert.ok(at > 0, site)
    assert.match(source.slice(at, at + 300), /packRecheck\?\.abort\(\)/, site)
  }
  assert.match(source, /host\?\.webContents\.send\('setup:open'\)/)
  // Damage notices are filtered by each store's state when shown, never
  // cleared because an operation started.
  assert.doesNotMatch(source, /packRepairStarted/)
  assert.equal((source.match(/damagedPacks\.clear\(\)/g) ?? []).length, 0)
  assert.match(source, /damagedPacks\.set\(label, \{ label, store, id \}\)/)
  assert.match(source, /await pack\.store\.damageOutstanding\(pack\.id\)\.catch\(\(\) => true\)/)
  assert.match(source, /const damageNoticeBlocked = \(\) => Boolean\(processingOperation \|\| updateOperation \|\| installation \|\| heartSetup\?\.operation\n\s+\|\| operationGate\.active \|\| setupChecks > 0\)/)
  assert.match(source, /setupHandler\('setup:preflight', setupCheck\(/)
  assert.match(source, /setupHandler\('setup:model-source', setupCheck\(/)
  assert.match(source, /setupChecks\+\+\n\s+try \{ return await action\(\.\.\.args\) \} finally \{ setupChecks-- \}/)
  assert.match(source, /readOnlyApplicationRoot\(readOnlyAppImageMount\(\{ applicationRoot \}\), applicationRoot\)/)
})
