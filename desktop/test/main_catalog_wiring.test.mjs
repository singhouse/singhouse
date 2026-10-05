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
  assert.match(source, /^import \{ channelTrustedLocks, validateShippedCatalog \} from '\.\/setup_catalog\.mjs'$/m)
})

test('main.mjs scopes runtime lock trust to the packaged release channel before any runtime activates', () => {
  const trust = source.indexOf("const trustedLocks = channelTrustedLocks(JSON.parse(readFileSync(resolve(desktopDir, 'processing-locks.json'), 'utf8')), releasePolicy.channel)")
  assert.ok(trust > source.indexOf('releasePolicy = assertReleasePolicy('), 'trust derives from the already validated release policy')
  const construct = source.indexOf('processingManager = new RuntimeManager(', trust)
  assert.ok(construct > trust)
  assert.match(source.slice(construct, source.indexOf('\n', construct)), /, trustedLocks \}\)$/)
  assert.ok(source.indexOf('activeProcessing = await processingManager.active()') > construct)
  // No other runtime manager or unscoped lock list exists.
  assert.equal((source.match(/new RuntimeManager\(/g) ?? []).length, 1)
  assert.doesNotMatch(source, /processingPolicy\.lockSha256|trustedLocks: [a-zA-Z.]*lockSha256/)
})

test('main.mjs never uses the unrestricted catalog validator or private-test local sources', () => {
  assert.doesNotMatch(source, /validateSetupCatalog/)
  assert.doesNotMatch(source, /privateTestLocalSources/)
})
