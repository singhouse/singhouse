# SPDX-License-Identifier: AGPL-3.0-only
param(
    [string]$FilePath,
    [ValidateSet('AzureCliCredential', 'EnvironmentCredential')][string]$Credential = 'AzureCliCredential',
    [string]$Endpoint,
    [string]$Account,
    [string]$Profile,
    [string]$ExpectedSubject,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Import-Module TrustedSigning -RequiredVersion 0.5.3 -ErrorAction Stop
$command = Get-Command 'TrustedSigning\Invoke-TrustedSigning' -ErrorAction Stop
if ($command.Module.Version -ne [version]'0.5.3') { throw 'Unexpected TrustedSigning module version.' }
$credentials = @('EnvironmentCredential', 'WorkloadIdentityCredential', 'ManagedIdentityCredential',
    'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
    'AzureCliCredential', 'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential')
# Validate the pinned module's actual parameter contract before any signing call.
foreach ($name in $credentials) {
    $parameter = $command.Parameters["Exclude$name"]
    if (-not $parameter -or $parameter.ParameterType -ne [System.Management.Automation.SwitchParameter]) {
        throw "TrustedSigning lacks expected credential switch: Exclude$name"
    }
}
foreach ($name in @('Endpoint', 'CodeSigningAccountName', 'CertificateProfileName', 'Files', 'FileDigest', 'TimestampRfc3161', 'TimestampDigest')) {
    if ($command.Parameters[$name].ParameterType -ne [string]) { throw "Unexpected TrustedSigning parameter: $name" }
}
if ($ValidateOnly) { Write-Host 'TrustedSigning 0.5.3 parameter contract verified.'; return }
foreach ($value in @($FilePath, $Endpoint, $Account, $Profile, $ExpectedSubject)) {
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'Complete signing configuration is required.' }
}
if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw 'Signing target is missing.' }
$parameters = @{
    Endpoint = $Endpoint; CodeSigningAccountName = $Account; CertificateProfileName = $Profile
    Files = $FilePath; FileDigest = 'SHA256'
    TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'; TimestampDigest = 'SHA256'
}
# Hashtable splatting supplies actual booleans to [switch] parameters. Every
# provider except the selected one is excluded; no credential fallback is allowed.
foreach ($name in $credentials) { $parameters["Exclude$name"] = ($name -cne $Credential) }
TrustedSigning\Invoke-TrustedSigning @parameters
$signature = Get-AuthenticodeSignature -LiteralPath $FilePath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -cne $ExpectedSubject -or
    -not $signature.TimeStamperCertificate) { throw 'Signed file failed publisher or timestamp verification.' }
