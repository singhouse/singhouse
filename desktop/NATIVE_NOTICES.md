# Native desktop artifact inventory

This supplements the repository's source inventory. Native installers
bundle Electron, a CPython runtime, installed Python packages, the compiled
frontend and fonts, and FFmpeg/ffprobe. No model checkpoints are included.

Each `native/provenance.json` records exact installed package versions,
application-wheel hashes, Python archive URL/hash, build tools, native binary
URL/hash, and observed executable version/configuration where executed.
`native/manifest.json` identifies the compatible application/backend/runtime.
Cross-assembled payloads explicitly require native execution tests.

Optional managed processing packs carry a separate exact package and notice
inventory. Their release policy excludes the CC BY-NC diffq and diffq-fixed
quantizers because the selected `mdx_extra` and RoFormer checkpoints are
non-quantized. Both the pack builder and the final assembler reject their
code, distribution metadata, and notices; previously built packs containing
them are not trusted by this release.

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

Before redistributing an artifact, verify the exact binaries' complete
corresponding-source and third-party obligations and prepare the required
source delivery alongside the installer. Upstream links and a GPL text alone
do not establish a complete corresponding-source delivery. Platform code
signing and native qualification are separate release checks. This inventory
makes no license assertion for model weights or later optional processing
environments.

Linux x64 AppImage first installers additionally carry six pinned builder
libraries. Their exact binary/package/source identities and full copyright and
license texts are retained in `third-party/appimage/` and installed as
`resources/third-party/appimage/` before release receipt creation. Packaging
rejects changed, absent, or unclassified libraries under `usr/lib`, and missing
or altered notices. `libappindicator` has mixed LGPL-2.1/3 and GPL-3 source files,
including GPL-3 `generate-id.c` in the library source list; it is not described as
unqualified LGPL-only. Preserve the complete component notices.

First-installer packaging also creates the separate deterministic
`Singhouse-appimage-12.0.1-library-sources.tar` and its SHA256 sidecar. The TAR
contains exact source DSC records, upstream originals, Debian changes, the
original `REBUILD.txt` extraction/source-build recipe, notices, inventory, and
internal checksums. Upstream extraction scripts are identified only by public
URLs and hashes in the inventory; their contents are not redistributed.
DSC signatures have not been verified; source hashes are locked and were checked
against those records. Building this local artifact does not publish it or
establish public source availability. Source delivery and any other applicable
redistribution obligations remain release checks.
