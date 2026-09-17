// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WINDOWS_SIGNING, verifyAzureCliSession, verifyWindowsAuthenticode, windowsBuildConfiguration } from '../windows_signing.mjs'

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
    env: { AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'secret' }, platform: 'win32' }), /either.*or/i)
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
    assert.equal(command, 'az.cmd')
    assert.deepEqual(args, ['account', 'show', '--output', 'json', '--only-show-errors'])
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
    { subscriptionId: 'subscription', tenantId: 'tenant' })
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli(null, { code: 1 }) }), /not logged in/)
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli(null, { error: new Error('ENOENT') }) }), /unavailable/)
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli({}) }), /invalid account/)
  await assert.rejects(verifyAzureCliSession({ platform: 'win32', spawnImpl: azureCli({ ...account, user: { type: 'servicePrincipal' } }) }), /invalid account/)
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
