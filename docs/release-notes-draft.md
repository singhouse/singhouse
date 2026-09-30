# Singhouse Core desktop release notes (draft)

This candidate packages Singhouse as a native desktop application with its own
local backend, Python runtime, and FFmpeg. It is designed to play a karaoke
library you already have. Local processing capabilities depend on the platform
and on separately installed, verified runtime and model packs listed in the
final qualification matrix.

Signing status applies to each exact artifact. The Windows installer built from
revision `150ae52666fc0a531bb657316c5dde208dfd560a` has a verified Authenticode
signature and timestamp. A signed and notarized macOS build path is available,
but signing and notarization of this candidate remain incomplete; earlier
notarization does not qualify a rebuilt artifact. Label any unsigned test
artifact individually in its download description.

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
