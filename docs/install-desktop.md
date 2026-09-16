# Install Singhouse Core

Singhouse is a desktop application for a karaoke library you already have. The
installer includes the app, its private local backend, Python, and FFmpeg. You
do not need Docker or a system Python installation. AI model files are separate
downloads that require your consent; prepared media playback does not require
an AI pack.

## Before installing

Download the installer and checksum only from the release page. Compare the
SHA-256 value before opening it:

```sh
# Linux
sha256sum /path/to/download

# macOS
shasum -a 256 /path/to/download
```

On Windows, in PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 C:\path\to\download
```

The first release installers are **unsigned**. Windows and macOS can therefore
warn about or block a downloaded installer. Signed installers are planned
after the applicable Microsoft and Apple verification work is complete. A
checksum confirms the bytes match the published candidate; it does not replace
platform code signing.

Follow only the per-application choices your operating system presents for the
download whose checksum you verified. If your system or organization does not
offer a per-application approval, stop and use a supported installation method
approved by its administrator. Do not turn off SmartScreen, Gatekeeper,
antivirus, the Electron sandbox, or other system-wide protections.

Exact warning text and permitted actions vary by OS version and policy. The
release notes will record the behavior observed with each actual downloaded
candidate. They must not promise an override that was not tested.

## Windows 11 x86-64

1. Verify the installer checksum.
2. Run the per-user installer.
3. Record any SmartScreen or organization-policy message. Proceed only when
   Windows offers an acceptable per-application action.
4. Launch Singhouse from the installed shortcut.

Windows ARM is not supported by this release.

## macOS 14 or newer on Apple silicon

1. Verify the DMG checksum.
2. Open the DMG and copy Singhouse to Applications.
3. Launch it and record any Gatekeeper message. Proceed only when macOS offers
   an acceptable per-application action for the verified copy.

Intel Macs are not supported by this release.

## Linux x86-64 and ARM64

Verify the AppImage or archive checksum before launch. The Ubuntu 24.04
baseline and each announced distribution require a qualification result. An
ARM64 build alone does not establish Asahi support.

For an AppImage:

```sh
chmod u+x Singhouse-*.AppImage
./Singhouse-*.AppImage
```

If the host cannot run AppImages, use the release archive when one is supplied.
Do not disable the Electron sandbox. AppImage update and standalone-recovery
support remains unavailable unless the release notes explicitly report that
outer-image verification passed for that candidate.

## Data and uninstall

The library, uploads, stems, models, settings, and recovery state live in the
per-user application-data directory, separate from installed application
files. Back up the complete directory while Singhouse is closed before an
upgrade or operating-system migration.

The normal uninstaller is intended to retain user data. Confirm the behavior
in the release's platform qualification matrix before depending on it. Removing
the application-data directory is a separate, destructive action; make a
backup first.

After installation, import only media you are entitled to use. See
`support-diagnostics.md` for safe information to collect when startup fails.
