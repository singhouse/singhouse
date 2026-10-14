# Installing Singhouse Desktop

Singhouse Desktop is a self-contained application for managing and hosting your karaoke library. The installer bundles the app, its local backend server, Python, and FFmpeg—you do not need Docker or a system Python installation.

* **Playing existing karaoke files** (MP3+G, CD+G, or already-separated tracks) works immediately after install.
* **Generating karaoke tracks from standard audio** requires downloading the AI processing runtime and model weights. The in-app setup wizard will prompt for your consent and show download sizes before fetching anything.

## 1. Verify Your Download (Recommended)

Download the installer and its `.sha256` checksum file from the [Releases page](https://github.com/singhouse/singhouse/releases). Before opening the installer, you can verify that the download matches the published checksum:

**Windows (PowerShell):**

```powershell
Get-FileHash -Algorithm SHA256 C:\path\to\download
```

**macOS:**

```sh
shasum -a 256 /path/to/download
```

**Linux:**

```sh
sha256sum /path/to/download
```

> **Note on OS Security Warnings:** Release notes specify whether each platform artifact is signed. If you are installing an unsigned build or a newly signed release that hasn't built download reputation yet, Windows SmartScreen or macOS Gatekeeper may display a warning prompt. Verify the SHA-256 checksum above, then use your operating system's standard per-application approval prompt to launch it. Never disable SmartScreen, Gatekeeper, antivirus, or the Electron sandbox globally.

## 2. Platform Installation

### Windows 11 (x64)

1. Run the downloaded `.exe` installer and select a per-user installation directory.
2. Launch **Singhouse** from the Start Menu or Desktop shortcut.

*(Note: Windows on ARM is not currently supported.)*

### macOS 14+ (Apple Silicon)

1. Open the downloaded `.dmg` image and drag **Singhouse** into your `Applications` folder.
2. Launch **Singhouse** from `Applications`.

*(Note: Intel Macs are not supported.)*

### Linux (x64 and ARM64)

Make the AppImage executable and run it directly:

```sh
chmod u+x Singhouse-*.AppImage
./Singhouse-*.AppImage
```

* If your system lacks FUSE/AppImage host integration, extract and run the `.tar.gz` release archive instead.
* Do not pass `--no-sandbox`—Singhouse requires a working Electron sandbox and will refuse to start if sandboxing is disabled.
* Note: ARM64 builds are tested against Ubuntu 24.04 ARM64; Asahi Linux support is tracked separately.

## 3. Where Your Data Lives & Uninstalling

Singhouse stores your SQLite database, imported audio, separated stems, downloaded AI models, and `settings.json` inside your OS per-user application data directory (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux)—completely separate from the installed application binaries.

* **Upgrading or Migrating:** Close Singhouse completely and back up your application-data directory before migrating machines or downgrading versions.
* **Uninstalling:** Uninstalling the application removes the program binaries while leaving your library and model cache intact. If you want to permanently remove your library and downloaded models, delete the application-data folder manually after backing up anything you want to keep.
* **Troubleshooting:** If Singhouse fails to start or a processing job errors out, see [Support Diagnostics](support-diagnostics.md) for how to capture a clean log.
