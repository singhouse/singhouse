# SPDX-License-Identifier: AGPL-3.0-only
param([ValidateSet('cpu','cuda')][string]$Accelerator, [switch]$Repair, [switch]$DependenciesOnly)
$ErrorActionPreference = 'Stop'
$TranscriptStarted = $false
# A Windows PowerShell child can inherit PowerShell 7's module search path.
# Load only this host's built-in modules; never change the user's stored path.
$PreviousModulePath = $env:PSModulePath
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
try {
    Import-Module ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
    $Bundle = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    $App = Join-Path $Bundle 'app\Singhouse.exe'
    $Native = Get-Content -LiteralPath (Join-Path $Bundle 'app\resources\native\manifest.json') -Raw | ConvertFrom-Json
    $ProfileParent = Join-Path $env:LOCALAPPDATA 'sh-test'
    $Profile = Join-Path $ProfileParent ($Accelerator + '-' + $Native.runtimeId.Substring(0, 12))
    if ($Profile.StartsWith('\\')) { throw 'The test profile requires a local NTFS drive, not a network path' }
    $Drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($Profile))
    if ($Drive.DriveFormat -ne 'NTFS' -or $Drive.DriveType -eq 'Network') { throw 'The test profile requires a local NTFS drive' }
    for ($Ancestor = $Profile; $Ancestor; $Ancestor = Split-Path -Parent $Ancestor) {
        if ((Test-Path -LiteralPath $Ancestor) -and ((Get-Item -LiteralPath $Ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The test profile and its ancestors must not be junctions or symbolic links'
        }
        if ($Ancestor -eq [IO.Path]::GetPathRoot($Ancestor)) { break }
    }
    # Restrict only this dedicated profile, never its parent or an existing app profile.
    $ExistingProfile = Test-Path -LiteralPath $Profile
    if (-not $ExistingProfile) { New-Item -ItemType Directory -Path $Profile | Out-Null }
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $SystemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    # Set-Acl can request privileges unavailable to an unelevated user. Apply
    # only the new directory's owner and DACL using icacls; existing profiles
    # must already be private and are never rewritten by the launcher.
    if (-not $ExistingProfile) {
        & icacls.exe $Profile /setowner "*$($Identity.Value)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not set the test profile owner (icacls exit $LASTEXITCODE)" }
        & icacls.exe $Profile /inheritance:r /grant:r "*$($Identity.Value):(OI)(CI)F" "*$($SystemSid.Value):(OI)(CI)F" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not restrict the test profile permissions (icacls exit $LASTEXITCODE)" }
    }
    $Observed = Get-Acl -LiteralPath $Profile
    $Rules = @($Observed.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $ExpectedSids = @($Identity.Value, $SystemSid.Value)
    $ActualSids = @($Rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    $Private = $Observed.AreAccessRulesProtected -and
        $Observed.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $Identity.Value -and
        $Rules.Count -eq 2 -and $ActualSids.Count -eq 2 -and
        -not (@($ActualSids | Where-Object { $_ -notin $ExpectedSids }))
    foreach ($Rule in $Rules) {
        if ($Rule.AccessControlType -ne 'Allow' -or $Rule.FileSystemRights -ne 'FullControl' -or
            $Rule.IsInherited -or $Rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or
            $Rule.PropagationFlags -ne 'None') { $Private = $false }
    }
    if (-not $Private) {
        throw "Unsafe test profile permissions: $Profile. The profile must be owned by the current user with inheritance disabled and inheritable FullControl for only that user and SYSTEM. Move the existing test profile aside and run again to create a fresh private profile."
    }
    $Log = Join-Path $Profile 'setup.log'
    Start-Transcript -LiteralPath $Log -Append | Out-Null
    $TranscriptStarted = $true
    Write-Host "singhouse Windows $Accelerator acceptance build (private test, unsigned)"
    Write-Host "Test library and models: $Profile"
    Write-Host "Setup log: $Log"
    $Ready = $false
    $Marker = Join-Path $Profile 'windows-acceptance.json'
    if (Test-Path -LiteralPath $Marker) {
        try {
            $Previous = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
            $Ready = $Previous.schema -eq 1 -and $Previous.nativeRuntimeId -eq $Native.runtimeId -and $Previous.accelerator -eq $Accelerator
        } catch { $Ready = $false }
    }
    if (-not $Ready -or $Repair -or $DependenciesOnly) {
        if ($DependenciesOnly) {
            Write-Host 'Dependency-only verification: no model downloads, readiness marker or application launch.'
        } else {
            $Models = Get-Content -LiteralPath (Join-Path $Bundle 'app\resources\native\models.json') -Raw | ConvertFrom-Json
            $ModelBytes = ($Models.models | Where-Object { $_.id -in @('heart-transcriptor','demucs-mdx-extra','karaoke-roformer') } | ForEach-Object { $_.files } | Measure-Object -Property size -Sum).Sum
            Write-Host ('First setup downloads {0:N0} MiB of models directly from upstream sources, plus processing dependencies.' -f ($ModelBytes / 1MB))
            Write-Host ('Drive has {0:N1} GiB free. Leave extra room for downloaded packages, installed tools, songs and stems.' -f ($Drive.AvailableFreeSpace / 1GB))
            Write-Host 'Models: HeartMuLa/HeartTranscriptor-oss, Demucs mdx_extra, and karaoke Roformer.'
            Write-Host 'Model terms: https://huggingface.co/HeartMuLa/HeartTranscriptor-oss'
            Write-Host 'https://github.com/facebookresearch/demucs | https://github.com/nomadkaraoke/python-audio-separator'
            Write-Host 'CPU and CUDA keep separate test libraries. No existing library is changed.'
            if ((Read-Host 'Install these tools and download these models? Type YES to continue') -cne 'YES') {
                Write-Host 'Cancelled. Nothing was installed or downloaded. Run this launcher again and type YES to continue.'
                if (-not $DependenciesOnly) { Read-Host 'Press Enter to close' | Out-Null }
                exit 0
            }
        }
        $env:ELECTRON_RUN_AS_NODE = '1'
        $SetupArguments = @((Join-Path $PSScriptRoot 'windows-bootstrap.mjs'), '--bundle', $Bundle, '--profile', $Profile, '--accelerator', $Accelerator)
        if ($DependenciesOnly) { $SetupArguments += '--dependencies-only' } else { $SetupArguments += '--accept-model-downloads' }
        if ($Repair) { $SetupArguments += '--repair' }
        # Piping output makes Windows PowerShell wait for the GUI-subsystem
        # Electron executable and populate LASTEXITCODE before we inspect it.
        & $App @SetupArguments | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Setup failed (exit $LASTEXITCODE). Details are in $Log. Retry after resolving the error." }
        Remove-Item Env:ELECTRON_RUN_AS_NODE
    }
    if ($DependenciesOnly) { exit 0 }
    # The marker skips repeated setup only. The app still validates all active
    # runtime/model identities and their bound probe using its normal fast path.
    Start-Process -FilePath $App -ArgumentList @('--private-test-resource-measurement', ('--user-data-dir="' + $Profile + '"'))
} catch {
    Write-Host ($_.Exception.ToString()) -ForegroundColor Red
    if (-not $DependenciesOnly) { Read-Host 'Press Enter to close' }
    exit 1
} finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    if ($TranscriptStarted) { Stop-Transcript | Out-Null }
    $env:PSModulePath = $PreviousModulePath
}
