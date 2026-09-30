# Singhouse Core desktop release notes (draft)

This candidate packages Singhouse as a native desktop application with its own
local backend, Python runtime, and FFmpeg. It is designed to play a karaoke
library you already have. Local processing capabilities depend on the platform
and on separately installed, verified runtime and model packs listed in the
final qualification matrix.

Signing status applies to each exact artifact. The macOS application and DMG
built from revision `09d796fdb6b35cef3b62fecefa86284246d080cb` passed signing,
notarization and stapling checks. The DMG SHA-256 is
`64b1e542ad3cac4f28f1d9ff39957be7eccc0d662850215c130a45b3c0d4aafc`.
The Windows build from revision
`07b44604f73dc3f5d8911a9beeb690c1092050b9` passed Authenticode signature and
timestamp verification for its application, installer and installed uninstaller,
and a disposable install/uninstall test. These checks do not establish
browser-download reputation or physical playback qualification. Label any
unsigned test artifact individually in its download description.

Windows SmartScreen or macOS Gatekeeper may warn or block a download. Verify the
published SHA-256 before opening it, and use only per-application actions offered
by your operating system or administrator. Do not disable security globally.

Platform signing is separate from Singhouse's artifact and update integrity.
Release receipts and checksums bind candidate artifacts. Application updates
are disabled in this candidate; platform signing does not enable them. The
final notes must list the exact downloaded-installer behavior actually observed
on every qualified OS build.

Before publication, replace this paragraph with exact source revision,
version, artifact filenames and checksums, supported platform/model/device
combinations, known failures, untested rows, and data migration bounds. Do not
describe a target as supported merely because it builds.
