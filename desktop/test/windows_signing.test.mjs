// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WINDOWS_SIGNING, signWindowsFile, nativeExecutableSigningExclusions, verifyAzureCliSession, verifyWindowsAuthenticode, windowsBuildConfiguration } from '../windows_signing.mjs'

test('unsigned private builds explicitly disable Windows signing', () => {
  assert.deepEqual(windowsBuildConfiguration({ platform: 'linux' }), {
    target: ['nsis'], signAndEditExecutable: false, signExecutable: false,
  })
})

test('signed release config uses the custom SHA256 signer with environment credential isolation', async () => {
  const env = { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' }
  let selected
  const config = windowsBuildConfiguration({ signedRelease: true, env, platform: 'win32',
    signImpl: async (_options, credentials) => { selected = credentials.credential } })
  assert.equal(config.azureSignOptions, undefined)
  assert.equal(config.signAndEditExecutable, true)
  assert.equal(config.signExecutable, true)
  assert.equal(config.verifyUpdateCodeSignature, true)
  assert.equal(config.signtoolOptions.publisherName, WINDOWS_SIGNING.publisherName)
  assert.deepEqual(config.signtoolOptions.signingHashAlgorithms, ['sha256'])
  await config.signtoolOptions.sign({})
  assert.equal(selected, 'EnvironmentCredential')
})

test('signed release config fails closed off Windows or without environment credentials', () => {
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, env: {}, platform: 'win32' }), /environment credentials.*--azure-cli-user/)
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, env: { AZURE_TENANT_ID: 'partial' }, platform: 'win32' }), /Partial Azure environment credentials/)
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, manualAzureCli: true,
    env: { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' }, platform: 'win32' }), /exactly one/i)
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, env: {}, platform: 'linux' }), /must be built on Windows/)
})

test('manual and OIDC signing modes select only AzureCliCredential', async () => {
  for (const selection of [{ manualAzureCli: true, env: {} }, { azureOidc: true,
    env: { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_SUBSCRIPTION_ID: 'subscription' } }]) {
    let selected
    const config = windowsBuildConfiguration({ signedRelease: true, platform: 'win32', ...selection,
      signImpl: async (_options, credentials) => { selected = credentials.credential } })
    await config.signtoolOptions.sign({})
    assert.equal(selected, 'AzureCliCredential')
  }
})

function signer(result, { code = 0, error = null } = {}) {
  return (command, args, options) => {
    assert.equal(command, 'powershell.exe'); assert.equal(options.windowsHide, true)
    assert.equal(options.env.KARAOKE_SIGNATURE_TARGET, 'C:\\Program Files\\Singhouse\\Singhouse.exe')
    assert.equal(args.at(-2), '-EncodedCommand')
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
    queueMicrotask(() => {
      if (result !== null) child.stdout.emit('data', JSON.stringify(result))
      if (error) child.emit('error', error)
      else child.emit('close', code)
    })
    return child
  }
}

function azureCli(result, { code = 0, error = null } = {}) {
  return (command, args, options) => {
    assert.equal(command, 'cmd.exe')
    assert.deepEqual(args, ['/d', '/s', '/c', 'az.cmd account show --output json --only-show-errors'])
    assert.equal(options.windowsHide, true)
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
    queueMicrotask(() => {
      if (result !== null) child.stdout.emit('data', JSON.stringify(result))
      if (error) child.emit('error', error)
      else child.emit('exit', code)
    })
    return child
  }
}

test('manual signing requires an installed and logged-in Azure CLI session', async () => {
  const account = { id: 'subscription', tenantId: 'tenant', user: { name: 'michael@example.test', type: ' User ' } }
  assert.deepEqual(await verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli(account) }),
    { subscriptionId: 'subscription', tenantId: 'tenant', principal: 'michael@example.test' })
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli(null, { code: 1 }) }), /not logged in/)
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli(null, { error: new Error('ENOENT') }) }), /unavailable/)
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli({}) }), /invalid user signing session/)
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli({ ...account, user: { type: 'servicePrincipal' } }) }), /invalid user signing session/)
})

test('OIDC signing accepts only the azure/login service-principal session and selects AzureCliCredential', async () => {
  const env = { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_SUBSCRIPTION_ID: 'subscription' }
  const config = windowsBuildConfiguration({ signedRelease: true, azureOidc: true, env, platform: 'win32' })
  assert.equal(typeof config.signtoolOptions.sign, 'function')
  const account = { id: 'subscription', tenantId: 'tenant', user: { name: 'client', type: 'servicePrincipal' } }
  assert.deepEqual(await verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli(account), expectedType: 'servicePrincipal', expected: {
    subscriptionId: 'subscription', tenantId: 'tenant', clientId: 'client',
  } }), { subscriptionId: 'subscription', tenantId: 'tenant', principal: 'client' })
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli({ ...account, user: { name: 'client', type: 'user' } }), expectedType: 'servicePrincipal' }), /invalid servicePrincipal/)
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli(account), expectedType: 'servicePrincipal', expected: { clientId: 'other' } }), /invalid servicePrincipal/)
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, azureOidc: true, env: {}, platform: 'win32' }), /requires AZURE_TENANT_ID/)
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, azureOidc: true, manualAzureCli: true, env, platform: 'win32' }), /exactly one/)
})

test('Authenticode verifier requires valid publisher and timestamp evidence', async () => {
  const path = 'C:\\Program Files\\Singhouse\\Singhouse.exe'
  const valid = { Status: 'Valid', Subject: WINDOWS_SIGNING.subject, TimestampSubject: 'CN=Microsoft Public RSA Time Stamping Authority' }
  assert.equal(await verifyWindowsAuthenticode(path, { platform: 'win32', spawnImpl: signer(valid) }), true)
  assert.equal(await verifyWindowsAuthenticode(path, { platform: 'win32', spawnImpl: signer({ ...valid, Subject: 'CN=Someone Else' }) }), false)
  assert.equal(await verifyWindowsAuthenticode(path, { platform: 'win32', spawnImpl: signer({ ...valid, TimestampSubject: null }) }), false)
  assert.equal(await verifyWindowsAuthenticode(path, { platform: 'win32', spawnImpl: signer({ ...valid, Status: 'UnknownError' }) }), false)
  assert.equal(await verifyWindowsAuthenticode(path, { platform: 'win32', spawnImpl: signer(null, { code: 1 }) }), false)
  assert.equal(await verifyWindowsAuthenticode(path, { platform: 'linux', spawnImpl: () => { throw new Error('must not spawn') } }), false)
})

// Exercise the actual batch-file boundary on Windows without Azure credentials.
test('Windows Azure CLI preflight launches a batch wrapper through cmd.exe', { skip: process.platform !== 'win32' }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const directory = await mkdtemp(join(tmpdir(), 'azure-cli-fixture-'))
  try {
    await writeFile(join(directory, 'az.cmd'), '@echo off\r\necho {"id":"subscription","tenantId":"tenant","user":{"name":"client","type":"servicePrincipal"}}\r\n')
    const account = await verifyAzureCliSession({ expectedType: 'servicePrincipal',
      expected: { subscriptionId: 'subscription', tenantId: 'tenant', clientId: 'client' },
      spawnImpl: (command, args, options) => spawn(command, args, { ...options, cwd: directory }),
    })
    assert.equal(account.principal, 'client')
  } finally { await rm(directory, { recursive: true, force: true }) }
})


test('native executable exclusions reject malformed inventories and remain scoped to full paths', () => {
  const digest = 'a'.repeat(64)
  assert.throws(() => nativeExecutableSigningExclusions('relative', { 'python/python.exe': digest }), /absolute/)
  for (const inventory of [null, [], {}, { '../app.exe': digest }, { 'python/python.exe': 'bad' }]) {
    assert.throws(() => nativeExecutableSigningExclusions('/native', inventory), /Invalid native/)
  }
  const exclusions = nativeExecutableSigningExclusions('C:\\build\\native', {
    'python/python.exe': digest, 'ffmpeg/bin/ffmpeg.exe': digest, 'python/python.dll': digest,
  })
  assert.ok(exclusions.includes('!C:\\build\\native\\python\\python.exe'))
  assert.ok(exclusions.includes('!/resources/native/python/python.exe'))
  assert.equal(exclusions.length, 8)
  assert.ok(!exclusions.includes('!.exe'))
})

test('pinned builder preserves native binaries while signing application and NSIS wrappers', async t => {
  let WinPackager
  try {
    // Initialize the package entry point first; direct submodule loading causes
    // the builder's CommonJS packager modules to encounter a circular import.
    await import('app-builder-lib')
    ;({ WinPackager } = await import('app-builder-lib/out/winPackager.js'))
  }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return t.skip('Requires locked desktop npm dependencies')
    throw error
  }
  const { WindowsSignToolManager } = await import('app-builder-lib/out/codeSign/windowsSignToolManager.js')
  const calls = []
  const signingConfig = windowsBuildConfiguration({ signedRelease: true, azureOidc: true, platform: 'win32',
    env: { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_SUBSCRIPTION_ID: 'subscription' },
    signImpl: async (options, credentials) => { calls.push({ hash: options.hash, isNest: options.isNest, ...credentials }) } })
  const manager = { packager: { appInfo: { type: 'module', productName: 'Fixture', computePackageUrl: async () => null },
    info: { getWorkspaceRoot: async () => '.' } }, cscInfo: { value: Promise.resolve(null) } }
  await WindowsSignToolManager.prototype.signFile.call(manager, { path: 'C:\\build\\Fixture.exe', options: signingConfig })
  assert.deepEqual(calls, [{ hash: 'sha256', isNest: false, credential: 'AzureCliCredential' }])
  signingConfig.signtoolOptions.sign = async () => { throw new Error('fixture signer failure') }
  await assert.rejects(WindowsSignToolManager.prototype.signFile.call(manager,
    { path: 'C:\\build\\Fixture.exe', options: signingConfig }), /fixture signer failure/)
  const digest = 'a'.repeat(64)
  const configuration = windowsBuildConfiguration({ signedRelease: true, azureOidc: true, platform: 'win32',
    env: { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_SUBSCRIPTION_ID: 'subscription' } })
  configuration.signExts = nativeExecutableSigningExclusions('C:\\build\\native', {
    'python/python.exe': digest, 'ffmpeg/bin/ffmpeg.exe': digest,
  })
  const packager = { platformSpecificBuildOptions: configuration, shouldSignFile: WinPackager.prototype.shouldSignFile }
  const transformer = WinPackager.prototype.createTransformerForExtraFiles.call(packager, { appOutDir: 'C:\\artifacts\\win-unpacked' })
  for (const root of ['C:/build/native', 'C:/artifacts/win-unpacked/resources/native']) {
    for (const executable of ['python/python.exe', 'ffmpeg/bin/ffmpeg.exe']) {
      for (const path of [`${root}/${executable}`, `${root}/${executable}`.replaceAll('/', '\\')]) {
        assert.equal(packager.shouldSignFile(path, true), false, path)
        assert.equal(transformer(path), null, path)
      }
    }
  }
  for (const path of ['C:/artifacts/win-unpacked/Player.exe', 'C:/artifacts/Player-0.1.0-win-x64.exe',
    'C:/artifacts/uninstaller.exe', 'C:/other/python/python.exe', 'C:/artifacts/win-unpacked/resources/helper.exe']) {
    assert.equal(packager.shouldSignFile(path, true), true, path)
    assert.equal(packager.shouldSignFile(path.replaceAll('/', '\\'), true), true, path)
  }
})


test('custom signer passes literal file arguments and propagates process failures', async () => {
  const options = { path: "C:\\test files\\Player's & candidate.exe", hash: 'sha256', isNest: false }
  for (const credential of ['AzureCliCredential', 'EnvironmentCredential']) {
    let captured
    await signWindowsFile(options, { platform: 'win32', credential, spawnImpl: (command, args, spawnOptions) => {
      captured = { command, args, spawnOptions }
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0))
      return child
    } })
    assert.equal(captured.command, 'pwsh.exe')
    assert.ok(captured.args.includes('-File'))
    assert.ok(!captured.args.includes('-Command'))
    assert.equal(captured.args[captured.args.indexOf('-FilePath') + 1], options.path)
    assert.equal(captured.args[captured.args.indexOf('-Credential') + 1], credential)
    assert.equal(captured.args[captured.args.indexOf('-ExpectedSubject') + 1], WINDOWS_SIGNING.subject)
  }
  await assert.rejects(signWindowsFile(options, { platform: 'win32', credential: 'AzureCliCredential', spawnImpl: () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 1)); return child
  } }), /exit code 1/)
  for (const changes of [{ hash: 'sha1' }, { isNest: true }]) {
    await assert.rejects(signWindowsFile({ ...options, ...changes }, { platform: 'win32', credential: 'AzureCliCredential' }), /one SHA256/)
  }
})

test('packaging failures remain nonzero despite build-tool exit cleanup', async t => {
  const { spawnSync } = await import('node:child_process')
  const module = new URL('../build/package.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { reportPackagingFailure } from ${JSON.stringify(module)}; process.on('exit', () => { process.exitCode = 0 }); reportPackagingFailure(new Error('fixture build failure'));`], { encoding: 'utf8' })
  if (result.error?.code === 'EPERM') return t.skip('Sandbox denies child-process execution')
  if (result.error) throw result.error
  assert.equal(result.status, 1)
  assert.match(result.stderr, /fixture build failure/)
})


test('Authenticode verifier keeps path literal and waits for stdout after process exit', async () => {
  const path = "C:\\test files\\Player's & [Łódź]; $(ignored).exe"
  const subject = 'CN=Łódź fixture'
  let child
  const verification = verifyWindowsAuthenticode(path, { platform: 'win32', expectedSubject: subject,
    spawnImpl: (command, args, options) => {
      assert.equal(command, 'powershell.exe')
      assert.equal(args.at(-2), '-EncodedCommand')
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
      assert.match(script, /-LiteralPath \$env:KARAOKE_SIGNATURE_TARGET/)
      assert.match(script, /OutputEncoding = \[System.Text.UTF8Encoding\]/)
      assert.match(script, /\$env:PSModulePath = "\$PSHOME\/Modules"/)
      assert.ok(!script.includes(path))
      assert.ok(!args.includes(path))
      assert.equal(options.env.KARAOKE_SIGNATURE_TARGET, path)
      child = new EventEmitter(); child.stdout = new EventEmitter()
      child.stdout.setEncoding = encoding => assert.equal(encoding, 'utf8')
      return child
    } })
  // Node's exit event can arrive before all pipe bytes have been delivered.
  child.emit('exit', 0)
  child.stdout.emit('data', JSON.stringify({ Status: 'Valid', Subject: subject, TimestampSubject: 'CN=Timestamp' }))
  child.emit('close', 0)
  assert.equal(await verification, true)
})

test('Authenticode rejection diagnostics expose signature evidence without relaxing trust', async () => {
  const diagnostics = []
  const result = await verifyWindowsAuthenticode('C:\\Program Files\\Singhouse\\Singhouse.exe', {
    platform: 'win32', spawnImpl: signer({ Status: 'Valid', Subject: 'CN=Unexpected', TimestampSubject: 'CN=Timestamp' }),
    onDiagnostic: detail => diagnostics.push(detail),
  })
  assert.equal(result, false)
  assert.deepEqual(diagnostics, [{ reason: 'signature-rejected', status: 'Valid', statusMessage: undefined,
    subject: 'CN=Unexpected', timestampSubject: 'CN=Timestamp' }])
})


test('Windows verifier ignores incompatible inherited PowerShell modules', { skip: process.platform !== 'win32' }, async () => {
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'signature-module-isolation-'))
  try {
    const modules = join(root, 'incompatible-modules')
    for (const [module, command] of [['Microsoft.PowerShell.Security', 'Get-AuthenticodeSignature'],
      ['Microsoft.PowerShell.Utility', 'ConvertTo-Json']]) {
      const directory = join(modules, module)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${module}.psd1`),
        `@{ RootModule = '${module}.psm1'; ModuleVersion = '99.0'; FunctionsToExport = @('${command}') }`)
      await writeFile(join(directory, `${module}.psm1`),
        `throw 'Incompatible inherited module must not load'; function ${command} { throw 'Wrong module' }`)
    }
    const path = join(root, 'unsigned fixture.ps1')
    await writeFile(path, '# This unsigned fixture is inspected, never executed.\n')
    const diagnostics = []
    assert.equal(await verifyWindowsAuthenticode(path, {
      onDiagnostic: detail => diagnostics.push(detail),
      spawnImpl: (command, args, options) => spawn(command, args, {
        ...options, env: { ...options.env, PSModulePath: modules },
      }),
    }), false)
    // Reaching signature-rejected/NotSigned proves both built-in Security and
    // Utility loaded and returned JSON. A poisoned import produces process-exit.
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].reason, 'signature-rejected')
    assert.equal(diagnostics[0].status, 'NotSigned')
  } finally { await rm(root, { recursive: true, force: true }) }
})
