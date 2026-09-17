// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

export const WINDOWS_SIGNING = Object.freeze({
  account: 'singhouse-signing',
  certificateProfile: 'singhouse',
  endpoint: 'https://cus.codesigning.azure.net',
  publisherName: 'Bones Consulting LLC',
  subject: 'CN=Bones Consulting LLC, O=Bones Consulting LLC, L=Overland Park, S=Kansas, C=US',
})

const REQUIRED_AZURE_ENV = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']
const DEFAULT_AZURE_CREDENTIALS = [
  'EnvironmentCredential', 'WorkloadIdentityCredential', 'ManagedIdentityCredential',
  'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
  'AzureCliCredential', 'AzurePowerShellCredential', 'AzureDeveloperCliCredential',
  'InteractiveBrowserCredential',
]
const exclusionsExcept = credential => DEFAULT_AZURE_CREDENTIALS.filter(name => name !== credential).join(',')

function authenticationMode({ env, manualAzureCli, azureOidc }) {
  const present = REQUIRED_AZURE_ENV.filter(name => typeof env[name] === 'string' && env[name].trim() !== '')
  if (manualAzureCli && azureOidc) throw new Error('Choose exactly one Azure authentication mode')
  if (azureOidc) {
    if (env.AZURE_CLIENT_SECRET) throw new Error('--azure-oidc does not accept AZURE_CLIENT_SECRET')
    for (const name of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_SUBSCRIPTION_ID']) {
      if (typeof env[name] !== 'string' || env[name].trim() === '') throw new Error(`--azure-oidc requires ${name}`)
    }
    return 'azure-oidc'
  }
  if (present.length > 0 && present.length < REQUIRED_AZURE_ENV.length) {
    throw new Error(`Partial Azure environment credentials are not allowed; set all or none of: ${REQUIRED_AZURE_ENV.join(', ')}`)
  }
  if ((manualAzureCli || azureOidc) && present.length) throw new Error('Choose exactly one Azure authentication mode')
  if (manualAzureCli) return 'azure-cli-user'
  if (present.length === REQUIRED_AZURE_ENV.length) return 'environment'
  throw new Error(`Signed Windows release requires complete environment credentials (${REQUIRED_AZURE_ENV.join(', ')}), --azure-cli-user, or --azure-oidc`)
}

export function windowsBuildConfiguration({ signedRelease = false, manualAzureCli = false, azureOidc = false, env = process.env, platform = process.platform } = {}) {
  if (!signedRelease) return { target: ['nsis'], signAndEditExecutable: false, signExecutable: false }
  if (platform !== 'win32') throw new Error('Signed Windows releases must be built on Windows')
  const mode = authenticationMode({ env, manualAzureCli, azureOidc })
  return {
    target: ['nsis'],
    signAndEditExecutable: true,
    signExecutable: true,
    verifyUpdateCodeSignature: true,
    azureSignOptions: {
      publisherName: WINDOWS_SIGNING.publisherName,
      endpoint: WINDOWS_SIGNING.endpoint,
      certificateProfileName: WINDOWS_SIGNING.certificateProfile,
      codeSigningAccountName: WINDOWS_SIGNING.account,
      fileDigest: 'SHA256',
      timestampRfc3161: 'http://timestamp.acs.microsoft.com',
      timestampDigest: 'SHA256',
      ExcludeCredentials: exclusionsExcept(mode === 'environment' ? 'EnvironmentCredential' : 'AzureCliCredential'),
    },
  }
}

export function verifyAzureCliSession({ spawnImpl = spawn, platform = process.platform, expectedType = 'user', expected = {} } = {}) {
  if (platform !== 'win32') return Promise.reject(new Error('Azure CLI signing session can only be checked on Windows'))
  return new Promise((resolve, reject) => {
    const child = spawnImpl('az.cmd', ['account', 'show', '--output', 'json', '--only-show-errors'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = '', settled = false
    child.stdout?.on('data', data => { stdout += data })
    child.once('error', () => { settled = true; reject(new Error('Azure CLI is unavailable; install it and run az login before using --azure-cli-user')) })
    child.once('exit', code => {
      if (settled) return
      if (code !== 0) return reject(new Error('Azure CLI is not logged in; run az login before using --azure-cli-user'))
      try {
        const account = JSON.parse(stdout)
        const userType = typeof account.user?.type === 'string' ? account.user.type.trim().toLowerCase() : ''
        if (typeof account.id !== 'string' || !account.id || typeof account.tenantId !== 'string' || !account.tenantId || userType !== expectedType.toLowerCase()) throw new Error('invalid account')
        if (expected.subscriptionId && account.id !== expected.subscriptionId) throw new Error('wrong subscription')
        if (expected.tenantId && account.tenantId !== expected.tenantId) throw new Error('wrong tenant')
        if (expected.clientId && account.user?.name !== expected.clientId) throw new Error('wrong client')
        resolve({ subscriptionId: account.id, tenantId: account.tenantId, principal: account.user.name })
      } catch { reject(new Error(`Azure CLI returned an invalid ${expectedType} signing session`)) }
    })
  })
}

export function verifyWindowsAuthenticode(path, { spawnImpl = spawn, platform = process.platform, expectedSubject = WINDOWS_SIGNING.subject } = {}) {
  if (platform !== 'win32') return Promise.resolve(false)
  return new Promise(resolve => {
    const script = [
      'param($Path)',
      '$ErrorActionPreference = "Stop"',
      '$signature = Get-AuthenticodeSignature -LiteralPath $Path',
      '[pscustomobject]@{ Status = [string]$signature.Status; StatusMessage = $signature.StatusMessage; Subject = $signature.SignerCertificate.Subject; TimestampSubject = $signature.TimeStamperCertificate.Subject } | ConvertTo-Json -Compress',
    ].join('; ')
    const child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& { ${script} }`, path], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout?.on('data', data => { stdout += data })
    child.once('error', () => resolve(false))
    child.once('exit', code => {
      if (code !== 0) return resolve(false)
      try {
        const result = JSON.parse(stdout)
        resolve(result.Status === 'Valid' && result.Subject === expectedSubject && typeof result.TimestampSubject === 'string' && result.TimestampSubject.length > 0)
      } catch { resolve(false) }
    })
  })
}
