// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WINDOWS_SIGNING, nativeExecutableSigningExclusions, verifyAzureCliSession, verifyWindowsAuthenticode, windowsBuildConfiguration } from '../windows_signing.mjs'

test('unsigned private builds explicitly disable Windows signing', () => {
  assert.deepEqual(windowsBuildConfiguration({ platform: 'linux' }), {
    target: ['nsis'], signAndEditExecutable: false, signExecutable: false,
  })
})

test('signed release config is pinned to the approved Azure profile and SHA256 RFC3161 signing', () => {
  const env = { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' }
  assert.deepEqual(windowsBuildConfiguration({ signedRelease: true, env, platform: 'win32' }), {
    target: ['nsis'], signAndEditExecutable: true, signExecutable: true, verifyUpdateCodeSignature: true,
    azureSignOptions: {
      publisherName: 'Bones Consulting LLC', endpoint: 'https://cus.codesigning.azure.net',
      certificateProfileName: 'singhouse', codeSigningAccountName: 'singhouse-signing',
      fileDigest: 'SHA256', timestampRfc3161: 'http://timestamp.acs.microsoft.com', timestampDigest: 'SHA256',
      ExcludeCredentials: 'WorkloadIdentityCredential,ManagedIdentityCredential,SharedTokenCacheCredential,VisualStudioCredential,VisualStudioCodeCredential,AzureCliCredential,AzurePowerShellCredential,AzureDeveloperCliCredential,InteractiveBrowserCredential',
    },
  })
})

test('signed release config fails closed off Windows or without environment credentials', () => {
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, env: {}, platform: 'win32' }), /environment credentials.*--azure-cli-user/)
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, env: { AZURE_TENANT_ID: 'partial' }, platform: 'win32' }), /Partial Azure environment credentials/)
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, manualAzureCli: true,
    env: { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' }, platform: 'win32' }), /exactly one/i)
  assert.throws(() => windowsBuildConfiguration({ signedRelease: true, env: {}, platform: 'linux' }), /must be built on Windows/)
})

test('manual signing mode selects only AzureCliCredential', () => {
  const config = windowsBuildConfiguration({ signedRelease: true, manualAzureCli: true, env: {}, platform: 'win32' })
  assert.equal(config.azureSignOptions.ExcludeCredentials,
    'EnvironmentCredential,WorkloadIdentityCredential,ManagedIdentityCredential,SharedTokenCacheCredential,VisualStudioCredential,VisualStudioCodeCredential,AzurePowerShellCredential,AzureDeveloperCliCredential,InteractiveBrowserCredential')
})

function signer(result, { code = 0, error = null } = {}) {
  return (command, args, options) => {
    assert.equal(command, 'powershell.exe'); assert.equal(options.windowsHide, true)
    assert.equal(args.at(-1), 'C:\\Program Files\\Singhouse\\Singhouse.exe')
    const child = new EventEmitter(); child.stdout = new EventEmitter()
    queueMicrotask(() => {
      if (result !== null) child.stdout.emit('data', JSON.stringify(result))
      if (error) child.emit('error', error)
      else child.emit('exit', code)
    })
    return child
  }
}

function azureCli(result, { code = 0, error = null } = {}) {
  return (command, args, options) => {
    assert.equal(command, 'cmd.exe')
    assert.deepEqual(args, ['/d', '/s', '/c', 'az.cmd account show --output json --only-show-errors'])
    assert.equal(options.windowsHide, true)
    const child = new EventEmitter(); child.stdout = new EventEmitter()
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
  assert.equal(config.azureSignOptions.ExcludeCredentials,
    'EnvironmentCredential,WorkloadIdentityCredential,ManagedIdentityCredential,SharedTokenCacheCredential,VisualStudioCredential,VisualStudioCodeCredential,AzurePowerShellCredential,AzureDeveloperCliCredential,InteractiveBrowserCredential')
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
