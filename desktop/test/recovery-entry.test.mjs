// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import vm from 'node:vm'

const mainUrl = new URL('../main.mjs', import.meta.url)

// Execute the complete application entrypoint with inert Electron/dependencies.
// Only the imports are substituted: recovery branching and call arguments are
// the actual production code, without a copied branch or source-text assertion.
async function recoveryEntry(platform, { invalidArguments = false, runtimeError = false } = {}) {
  const source = await readFile(mainUrl, 'utf8')
  const calls = [], errors = [], stableInputs = []
  let runtimeChecks = 0, policyReads = 0, finish
  const finished = new Promise(resolveFinished => { finish = resolveFinished })
  const evidence = { verified: true, outerPath: '/fixture/Singhouse.AppImage', outerSha256: 'a'.repeat(64) }
  const args = ['--recovery-anchor', '/state/recovery-tool/anchor.json', '/state/recovery-tool/kits/kit', '/state', 'point', '/state/backend']
  if (invalidArguments) args.pop()
  const fakeProcess = { platform, arch: 'x64', execPath: '/fixture/Singhouse', resourcesPath: '/fixture/resources',
    argv: ['/fixture/Singhouse', ...args], env: { SINGHOUSE_RECOVERY_ANCHOR: '1' }, on() {} }
  const context = vm.createContext({ process: fakeProcess, console, URL, Buffer, AbortController })
  const overrides = {
    electron: { app: { isPackaged: true, getName: () => 'Singhouse', requestSingleInstanceLock: () => true,
      getPath: () => '/state', on() {}, whenReady: () => Promise.resolve(), quit: () => finish() },
      dialog: { showErrorBox: (_title, message) => errors.push(message) } },
    'node:module': { createRequire: () => () => ({}) },
    'node:fs': { readFileSync() { policyReads++; throw new Error('Recovery must not load application/update policy') } },
    './lifecycle.mjs': { persistentRuntime: () => ({ root: '/state' }), projectorBlocker: () => ({}) },
    './update_manager.mjs': { OperationGate: class {} },
    './startup.mjs': { createStartupSurface: () => ({ ready: Promise.resolve(), update: async () => {}, close() {} }) },
    './bootstrap.mjs': { runRecoveryAnchor: async options => { calls.push(options) } },
    './recovery_launcher.mjs': {
      verifiedAppImageRuntime: () => { runtimeChecks++; if (runtimeError) throw new Error('Runtime verification failed'); return evidence },
      stableFirstInstallerExecutable: options => { stableInputs.push(options); return options.verifiedAppImage?.outerPath ?? fakeProcess.execPath },
    },
  }
  const importedNames = new Map([...source.matchAll(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm)]
    .map(([, names, specifier]) => [specifier, names.split(',').map(name => name.trim().split(/\s+as\s+/)[0])]))
  const entry = new vm.SourceTextModule(source, { context, identifier: mainUrl.href,
    initializeImportMeta: meta => { meta.url = mainUrl.href } })
  await entry.link(async specifier => {
    const names = importedNames.get(specifier)
    assert.ok(names, `Unhandled import: ${specifier}`)
    const namespace = specifier.startsWith('node:') && !overrides[specifier] ? await import(specifier) : overrides[specifier] ?? {}
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, namespace[name] ?? function () { throw new Error(`Unexpected recovery dependency: ${specifier}:${name}`) })
    }, { context })
  })
  let timer
  try {
    await entry.evaluate()
    await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery entry did not finish')), 5000) })])
  } finally { clearTimeout(timer) }
  return { calls, errors, stableInputs, runtimeChecks, policyReads, evidence }
}

if (!vm.SourceTextModule) {
  test('packaged recovery caller regressions', async () => {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--experimental-vm-modules', fileURLToPath(import.meta.url)], { timeout: 30000, env })
    assert.match(stdout, /# tests 5/)
    assert.match(stdout, /# fail 0/)
    assert.doesNotMatch(stderr, /Error:/)
  })
} else {
  for (const platform of ['linux', 'win32', 'darwin']) {
    test(`${platform} stable recovery retains bootstrap platform trust without consulting update policy`, async () => {
      const result = await recoveryEntry(platform)
      assert.deepEqual(result.errors, [])
      assert.equal(result.calls.length, 1)
      const options = result.calls[0]
      assert.equal(Object.hasOwn(options, 'platformTrust'), false)
      assert.equal(options.platformTrust, undefined)
      assert.equal(options.verifiedAppImage, platform === 'linux' ? result.evidence : null)
      assert.equal(result.runtimeChecks, platform === 'linux' ? 1 : 0)
      assert.equal(result.policyReads, 0)
      assert.equal(options.anchorPath, '/state/recovery-tool/anchor.json')
      assert.equal(options.kitRoot, '/state/recovery-tool/kits/kit')
      assert.deepEqual(Array.from(options.recoveryArgs), ['/state', 'point', '/state/backend'])
      assert.equal(options.executablePath, platform === 'linux' ? result.evidence.outerPath : '/fixture/Singhouse')
      assert.equal(options.pythonPath, resolve('/fixture/resources/native', platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'))
      assert.equal(options.helperPath, resolve('/fixture/resources/native/backend.py'))
      assert.equal(options.bootstrapPath, fileURLToPath(new URL('../bootstrap.mjs', import.meta.url)))
      assert.equal(result.stableInputs[0].verifiedAppImage, options.verifiedAppImage)
    })
  }
  test('runtime rejection prevents stable recovery invocation', async () => {
    const result = await recoveryEntry('linux', { runtimeError: true })
    assert.deepEqual(result.calls, [])
    assert.deepEqual(result.errors, ['Runtime verification failed'])
    assert.equal(result.policyReads, 0)
  })
  test('malformed recovery invocation cannot reach runtime or anchor verification', async () => {
    const result = await recoveryEntry('linux', { invalidArguments: true })
    assert.deepEqual(result.calls, [])
    assert.deepEqual(result.errors, ['Invalid stable recovery invocation'])
    assert.equal(result.runtimeChecks, 0)
    assert.equal(result.policyReads, 0)
  })
}
