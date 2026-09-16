# Singhouse Core desktop release notes (draft)

This candidate packages Singhouse as a native desktop application with its own
local backend, Python runtime, and FFmpeg. It is designed to play a karaoke
library you already have. Local processing capabilities depend on the platform
and on separately installed, verified runtime and model packs listed in the
final qualification matrix.

The initial installers are unsigned. Windows SmartScreen or macOS Gatekeeper
may warn or block them. Signed installers are planned after the applicable
Microsoft and Apple verification work is complete. Verify the published
SHA-256 before opening a download, and use only per-application actions offered
by your operating system or administrator. Do not disable security globally.

Platform signing is separate from Singhouse's artifact and update integrity.
Release receipts and checksums bind candidate artifacts, and application
updates remain disabled unless authenticated update trust is configured. The
final notes must list the exact downloaded-installer behavior actually observed
on every qualified OS build.

Before publication, replace this paragraph with exact source revision,
version, artifact filenames and checksums, supported platform/model/device
combinations, known failures, untested rows, and data migration bounds. Do not
describe a target as supported merely because it builds.
