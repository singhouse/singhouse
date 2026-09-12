# Native desktop test-artifact inventory

This supplements the repository's source inventory. Native test installers
bundle Electron, a CPython runtime, installed Python packages, the compiled
frontend and fonts, and FFmpeg/ffprobe. No model checkpoints are included.

Each `native/provenance.json` records exact installed package versions,
application-wheel hashes, Python archive URL/hash, build tools, native binary
URL/hash, and observed executable version/configuration where executed.
`native/manifest.json` identifies the compatible application/backend/runtime.
Cross-assembled payloads explicitly require native execution tests.

- CPython comes from python-build-standalone. Its license and bundled library
  notices are retained from the archive; upstream source/build information is
  at <https://github.com/astral-sh/python-build-standalone> and
  <https://github.com/python/cpython>.
- Installed Python distributions retain their package and `.dist-info` license
  files. Application wheels carry the backend AGPL-3.0-only and lyricsync MIT
  license texts. The bundled backend font retains its separate font license.
- Electron includes its license and Chromium third-party notices in the
  application directory. Exact Electron and build dependency versions are in
  `desktop/package-lock.json`; Electron source is at
  <https://github.com/electron/electron>.
- Bundled frontend dependency license files are collected under
  `native/notices/frontend/` with an exact package inventory. Space Grotesk's
  OFL text is also copied beside the emitted fonts. Signalsmith's vendored
  license remains beside its module in the built frontend.
- Linux and Windows FFmpeg and ffprobe are pinned by individual artifact hashes from
  <https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1>.
  The release tag is an artifact collection identifier, **not a uniform
  FFmpeg version across platforms**. The supplied per-target license and
  build README are included as `ffmpegLicense` and `ffmpegReadme`.
  Native execution records each executable's full `-version` output;
  cross-assembly records that it has not executed them. Source/build pointers
  are maintained at <https://github.com/eugeneware/ffmpeg-static> and
  <https://ffmpeg.org/download.html>.
- macOS arm64 uses Martin Riedl's **9.0.1**, build
  `1787073674_9.0.1`, with separate single-executable ZIP archives and published
  SHA256 checksums. Exact URLs, hashes and ZIP member names are in
  `desktop/locks/native.json`; the top-level `ffmpegRelease` field describes
  the Linux/Windows artifact collection only. Release files and the dependency
  version/configuration inventory are at
  <https://ffmpeg.martin-riedl.de/info/detail/macos/arm64/1787073674_9.0.1>.
  Its published `versions.txt` is retained as `ffmpegReadme`; FFmpeg's unmodified
  `n9.0.1/COPYING.GPLv3` is retained as `ffmpegLicense`. Source is at
  <https://github.com/FFmpeg/FFmpeg/tree/n9.0.1>; the distributor's release build
  scripts and dependency version pins are at
  <https://git.martin-riedl.de/ffmpeg/build-script/src/commit/f63b8aab8f5ce1a067da86ba69e34a36a7e217e5>.
  Both executables report `--enable-gpl --enable-version3`, and `-L` identifies
  GPL version 3 or later. They do not enable nonfree components. The published
  inventory identifies OpenSSL 3.6.1. The assembler still rejects
  `--enable-nonfree` in native execution or cross-binary inspection; changing
  distributors does not relax that guard.

These are private engineering artifacts. Public redistribution remains blocked
until the exact binaries' complete corresponding source and third-party
obligations have been verified and source delivery is prepared alongside the
installers. Upstream links and a GPL text alone do not establish a complete
corresponding-source delivery. Signing/notarization and platform qualification
are separate release checks. This inventory makes no license assertion for
model weights or later optional processing environments.
