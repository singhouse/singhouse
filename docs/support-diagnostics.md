# Support Diagnostics

When reporting a bug or startup failure, include your Singhouse version, installer filename (and SHA-256 hash), OS version, CPU/GPU architecture, and the action that triggered the issue.

## 1. Gather System Information

Run the commands for your platform to record your OS, display session, GPU, and audio devices:

**Windows (run `winver`, then PowerShell):**

```powershell
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsBuildNumber,OsArchitecture,CsTotalPhysicalMemory
Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM
Get-CimInstance Win32_SoundDevice | Select-Object Name,Status
```

**macOS:**

```sh
sw_vers
uname -m
system_profiler SPHardwareDataType SPDisplaysDataType SPAudioDataType
```

**Linux:**

```sh
uname -a
cat /etc/os-release
getconf PAGESIZE
printf 'desktop=%s session=%s\n' "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE"
```

## 2. Capture a Reproduction Log

Singhouse Desktop does not write a persistent background log file by default. To capture a log of a crash or bug, close Singhouse completely, then launch it from a terminal with output redirected to a file:

**Windows (PowerShell):**

```powershell
# Adjust the path if you chose a custom installation folder
& "$env:LOCALAPPDATA\Programs\Singhouse\Singhouse.exe" *> .\singhouse-reproduction.log
```

**macOS:**

```sh
/Applications/Singhouse.app/Contents/MacOS/Singhouse >singhouse-reproduction.log 2>&1
```

**Linux (AppImage):**

```sh
./Singhouse-*.AppImage >singhouse-reproduction.log 2>&1
```

Reproduce the issue once, close Singhouse, and inspect `singhouse-reproduction.log` before sharing it.

## 3. What to Redact Before Sharing

Before attaching logs to a public GitHub issue, strip out any personal or sensitive information:

* **Never attach:** audio files, separated stems, lyric texts, model weights, `karaoke.db`, `settings.json`, `.session_secret`, `.plex_token`, API keys, or full environment variable dumps.
* **Scrub from logs:** local usernames, personal folder paths, song titles/artists, and remote endpoint URLs.
* **Update failures:** If an application update fails, note the recovery-point identifier displayed in the UI and keep your application-data directory intact until the issue is diagnosed. Do not delete `.lock` files or recovery directories to force a startup.
