# Support diagnostics

Start by recording the Singhouse version, artifact filename and SHA-256, exact
operating-system version, CPU architecture, and whether the problem occurred
before or after an upgrade. For display or audio problems, include the desktop
session, connected displays, output device, and the action that triggered the
problem.

Useful platform commands include:

```sh
# Linux
uname -a
cat /etc/os-release
getconf PAGESIZE
printf 'desktop=%s session=%s\n' "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE"

# macOS
sw_vers
uname -m
system_profiler SPHardwareDataType SPDisplaysDataType SPAudioDataType
```

On Windows, run `winver`, then use PowerShell:

```powershell
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsBuildNumber,OsArchitecture,CsTotalPhysicalMemory
Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM
Get-CimInstance Win32_SoundDevice | Select-Object Name,Status
```

For a release candidate, also preserve:

- the release receipt and published checksum file;
- the result of hashing the downloaded installer;
- the exact warning or failure message;
- application logs covering one reproduction;
- whether the network was connected, whether a model/runtime was already
  installed, and whether prepared media still played;
- the recovery-point identifier shown by the application after an interrupted
  update.

Singhouse does not write a separate persistent application log in this
candidate. To capture one reproduction, close Singhouse and start the installed
executable from a terminal with output redirected to a new file:

```sh
# Linux AppImage
./Singhouse-*.AppImage >singhouse-reproduction.log 2>&1

# macOS installed application
/Applications/Singhouse.app/Contents/MacOS/Singhouse >singhouse-reproduction.log 2>&1
```

On Windows, replace the example path if you selected a different installation
directory:

```powershell
& "$env:LOCALAPPDATA\Programs\Singhouse\Singhouse.exe" *> .\singhouse-reproduction.log
```

Reproduce the problem once, close Singhouse, then review the captured file
before sharing it. These commands do not change operating-system security
settings.

Do not share media, stems, lyrics, model weights, the application database,
`settings.json`, session secrets, API keys, update signing keys, access tokens,
or full environment dumps. Review logs for local paths, usernames, song names,
and endpoint credentials before attaching them. Preserve the original private
evidence locally if redaction is needed.

If an update fails, keep the installed application, staged target, prior
managed slot, recovery point, and recovery kit together until the failure is
understood. Reinstalling application files should not require deleting the
library. Never delete lock or recovery files merely to force startup.
