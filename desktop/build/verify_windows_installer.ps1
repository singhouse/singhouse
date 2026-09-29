# SPDX-License-Identifier: AGPL-3.0-only
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$ExpectedSubject,
    [Parameter(Mandatory)][string]$ReportPath
)
$ErrorActionPreference = 'Stop'
if (-not $env:RUNNER_TEMP) { throw 'Installer verification requires RUNNER_TEMP.' }
if ($ProductName -match '[<>:"/\\|?*\[\]\r\n]' -or $ProductName -match '[. ]$') {
    throw 'Product name is not a safe Windows basename.'
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$Application = (Resolve-Path -LiteralPath $Application).Path
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$signTools = @(Get-ChildItem -LiteralPath $sdkRoot -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
if ($signTools.Count -eq 0) { throw 'Windows SDK SignTool is required.' }
$signTool = $signTools[0]
$results = [Collections.Generic.List[object]]::new()
function Confirm-Signature([string]$path, [string]$role) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -cne $ExpectedSubject -or
        -not $signature.TimeStamperCertificate) { throw "Invalid Authenticode signature: $role" }
    & $signTool verify /pa /all /v $path
    if ($LASTEXITCODE -ne 0) { throw "SignTool verification failed: $role ($LASTEXITCODE)" }
    $results.Add([pscustomobject]@{
        role = $role; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        subject = $signature.SignerCertificate.Subject
        timestampSubject = $signature.TimeStamperCertificate.Subject
        authenticode = [string]$signature.Status; signToolExitCode = 0
    })
}
Confirm-Signature $Application 'packaged-application'
Confirm-Signature $Installer 'installer'
$installParent = Join-Path $env:RUNNER_TEMP ('desktop-signature-check-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $installParent $ProductName
# NSIS requires /D last and without embedded quotes, even for paths with spaces.
$installation = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru
if ($installation.ExitCode -ne 0) { throw "Disposable installation failed: $($installation.ExitCode)" }
$installedApplication = Join-Path $installRoot "$ProductName.exe"
$uninstaller = Join-Path $installRoot "Uninstall $ProductName.exe"
Confirm-Signature $installedApplication 'installed-application'
Confirm-Signature $uninstaller 'installed-uninstaller'
if ((Get-FileHash -LiteralPath $installedApplication -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $Application -Algorithm SHA256).Hash) {
    throw 'Installed application differs from the signed packaged executable.'
}
# _?= runs the uninstaller in-place, allowing -Wait to observe its completion.
$uninstallation = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installRoot") -Wait -PassThru
if ($uninstallation.ExitCode -ne 0) { throw "Disposable uninstallation failed: $($uninstallation.ExitCode)" }
if (Test-Path -LiteralPath $installedApplication) { throw 'Uninstaller left the application executable installed.' }
[pscustomobject]@{ schema = 1; artifacts = $results.ToArray(); installExitCode = 0; uninstallExitCode = 0 } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding utf8
# Only the unique disposable directory is removed. No user-data directory is used.
if (Test-Path -LiteralPath $installParent) { Remove-Item -LiteralPath $installParent -Recurse -Force }
