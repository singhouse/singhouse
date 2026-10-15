# Singhouse Desktop

The Singhouse desktop application bundles Electron, a standalone CPython runtime, the core FastAPI backend, the compiled Vue 3 frontend, and FFmpeg/ffprobe. At launch, it starts an authenticated private loopback backend and manages a separate projector window.

* **Prepared-media playback works out of the box:** The base installer does not bundle AI model weights or heavy separation/transcription dependencies, and never downloads models without user consent.
* **Persistent user data:** Installed builds store the SQLite database, uploads, stems, model cache, and `settings.json` (which holds the persistent session secret) under `backend/` inside Electron's per-user application-data directory. Normal shutdown and Windows uninstallation preserve this directory.
* **Single-instance lock:** Only one application instance and backend may own the library (`owner.lock`). If the backend exits unexpectedly, quit and reopen Singhouse—never delete `owner.lock` manually to bypass a running process. Desktop configuration uses `settings.json` rather than a `.env` file.

**Related Documentation:**

* End-user install & troubleshooting: [`docs/install-desktop.md`](../docs/install-desktop.md) · [`docs/support-diagnostics.md`](../docs/support-diagnostics.md)
* Release qualification & smoke harnesses: [`desktop/qualification/README.md`](qualification/README.md) · [`docs/release-qualification.md`](../docs/release-qualification.md)
* Bundled binary licensing: [`desktop/NATIVE_NOTICES.md`](NATIVE_NOTICES.md)

---

## 1. Build Targets & Platform Requirements

| Target | Artifacts | Notes |
| --- | --- | --- |
| **Linux x64** | Portable `.shapp`, AppImage, `.tar.gz` | Requires working Electron sandbox (`AppRun` enforces sandboxing). Builds require `unsquashfs` (squashfs-tools 4.6+ in 4.x). |
| **Linux ARM64** | Portable `.shapp`, AppImage, `.tar.gz` | Same packaging contract as x64; Asahi Linux is qualified separately. |
| **macOS Apple Silicon** | Portable `.shapp`, `.dmg`, `.zip` | Requires macOS 14+ (`darwin-arm64`). |
| **Windows x64** | Portable `.shapp`, NSIS `.exe` | Per-user installation (`win32-x64`). |

---

## 2. Assembling & Packaging an Installer

Run all build commands from the **repository root**.

* **Prerequisites:** Node.js 22, Python 3.12+, a clean Git checkout (`git status --porcelain=v1 --untracked-files=all` must be empty), and the exact `uv` version pinned in `desktop/locks/native.json` (currently `0.12.8`).

### Basic Unsigned Build

```sh
npm --prefix desktop ci
python3 desktop/build/assemble.py --output desktop/native
npm --prefix desktop run package -- --playback-only
```

(On Windows, use `python` instead of `python3`. To build native first-installers—NSIS, DMG, AppImage/tar.gz—run `npm --prefix desktop run package:first-installers -- --playback-only`.)

### Cross-Target Assembly

`--target` accepts `linux-x64`, `linux-arm64`, `darwin-arm64`, and `win32-x64` (defaults to host). Windows x64 assembly requires a native Windows x64 host for Win32 PE resource APIs.

```sh
python3 desktop/build/assemble.py --target linux-arm64 --output /tmp/singhouse-native-arm64
KARAOKE_NATIVE_PAYLOAD=/tmp/singhouse-native-arm64 npm --prefix desktop run package -- --playback-only
```

### Packaging Modes: `--playback-only` vs. `--processing-ready`

Every packaging invocation must explicitly pass either `--playback-only` or `--processing-ready` after npm's `--` separator (there is no default):

* **`--playback-only`**: Excludes all processing catalogs and artifacts. The built app plays existing karaoke media and reports local AI song processing as unavailable.
* **`--processing-ready`**: Packages the target's validated catalog (`desktop/processing-catalogs/<platform>-<arch>.json`) as `processing-catalog.json` inside `app.asar`.
* **Windows & Linux CUDA builds** also require the matching `-cpu.json` fallback catalog (`desktop/processing-catalogs/<platform>-<arch>-cpu.json`), packaged as `processing-catalog-cpu.json`, so the setup wizard can select CPU or CUDA based on detected hardware. macOS uses a single Metal catalog.
* **Internal single-accelerator builds:** Pass `--processing-accelerator cpu|cuda|metal` alongside `--processing-ready` to package only `desktop/processing-catalogs/<platform>-<arch>-<accelerator>.json`.
* **Bundling flat release artifacts:** When a catalog references flat release assets (`https://github.com/singhouse/processing-packs/releases/download/<tag>/<sha256>-<filename>`), set `KARAOKE_PROCESSING_ARTIFACTS` to the directory containing the exported wheels and notices. Packaging verifies every file's size and SHA-256 and stages them into `resources/processing-artifacts/` outside `app.asar`.

### What Assembly & Packaging Verify

1. **`assemble.py`**: Downloads checksum-pinned `python-build-standalone` and FFmpeg/ffprobe binaries, builds the `karaoke-backend` and `lyricsync` wheels with a fixed ZIP epoch, installs locked dependencies, normalizes console script launchers (relative interpreter paths on POSIX; hash-pinned `uv 0.12.8` PE trampolines on Windows), regenerates `.dist-info/RECORD` files, rebuilds the frontend from its lockfile, and writes `manifest.json`, `files.json`, `assembly.json`, `provenance.json`, and `notices/`.
2. **Portable `.shapp` & Receipt (`desktop/artifacts/`)**: Packaging verifies every `files.json` entry against disk bytes, inspects `app.asar` to confirm catalog inclusion, and writes `Singhouse-<version>-<os>-<arch>.shapp`, `.shapp.receipt.json`, and `processing-mode.json`.
3. **Linux AppImage Verification**:
   * Requires `unsquashfs` (squashfs-tools 4.6+). Two AppImage passes ensure generated desktop icons, symlinks, and runtime libraries are captured inside the canonical unpacked tree before deriving the release identity and receipt.
   * For Linux x64 first-installers, set `SINGHOUSE_APPIMAGE_SOURCE_INPUTS=/absolute/prepared-inputs` containing the 18 hash-verified files (6 `.dsc` records + upstream orig archives + Debian diffs) listed in `third-party/appimage/inventory.json`. Packaging verifies all six bundled builder libraries under `usr/lib`, installs their notices, and outputs `artifacts/Singhouse-appimage-12.0.1-library-sources.tar` + `.sha256`. (ARM64 AppImages bundle no extra `usr/lib` libraries and do not require `SINGHOUSE_APPIMAGE_SOURCE_INPUTS`.)
   * Run `SINGHOUSE_REQUIRE_BUILDER_TESTS=1 node --test test/appimage.test.mjs` and `node --test test/appimage_notices.test.mjs` from `desktop/` to verify staging and notice packaging.

---

## 3. Code Signing (macOS & Windows)

Default builds are unsigned private-test builds. Release signing modes are explicit and fail-closed.

### macOS Developer ID & Notarization

Requires a macOS host, the pinned Developer ID Application certificate in Keychain, and notarization credentials stored via `xcrun notarytool store-credentials`:

```sh
export SINGHOUSE_MAC_PUBLISHER='MICHAEL ALAN JONES'
export SINGHOUSE_MAC_TEAM_ID='25Y7U443K6'
export SINGHOUSE_MAC_IDENTITY='Developer ID Application: MICHAEL ALAN JONES (25Y7U443K6)'
export SINGHOUSE_MAC_CERT_SHA1='55FEEAA93960DD9E278519CA68338BACFC2A3617'
export SINGHOUSE_MAC_NOTARY_PROFILE='singhouse-notary'
npm --prefix desktop run package:first-installers -- --signed-macos-release --playback-only
```

Signs all Mach-O binaries with hardened runtime and secure timestamps, notarizes and staples `.app` and `.dmg`, builds a `.zip` of the stapled app, verifies extracted parity against `.shapp`, and writes `.shapp.receipt.json` alongside the artifacts.

### Windows Azure Trusted Signing

Requires a native Windows x64 host, PowerShell 7, and the `TrustedSigning` module (`Install-Module TrustedSigning -RequiredVersion 0.5.3 -Repository PSGallery -Scope CurrentUser`). Signs with Azure account `singhouse-signing`, profile `singhouse` (`PublicTrust`) in `centralus` (`https://cus.codesigning.azure.net`), verifying the certificate subject (`Bones Consulting LLC`) and RFC 3161 timestamps on both `Singhouse.exe`, the NSIS installer, and the generated uninstaller.

* **Option A — GitHub Actions OIDC (Recommended CI Path):** Dispatched manually using the `windows-signing` GitHub environment (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID` environment secrets) and `--azure-oidc`.
* **Option B — Interactive Azure CLI:**

  ```powershell
  az login
  npm --prefix desktop run package:first-installers -- --signed-release --azure-cli-user --playback-only
  ```

* **Option C — Environment Service Principal Fallback:**

  ```powershell
  $env:AZURE_TENANT_ID = '<tenant-id>'
  $env:AZURE_CLIENT_ID = '<client-id>'
  $env:AZURE_CLIENT_SECRET = '<client-secret>'
  npm --prefix desktop run package:first-installers -- --signed-release --playback-only
  ```

---

## 4. Coordinated Updates & Atomic Recovery Architecture

First-install surfaces (NSIS, DMG, AppImage/archive) act as stable outer launchers and are not overwritten during in-app updates.

1. **Managed Release Slots:** When an operator supplies signed update metadata, Singhouse verifies the signature, anti-replay sequence floor, edition/policy ID (`release.json`), and schema compatibility. It extracts the target and rollback `.shapp` payloads into private managed slots inside application data.
2. **Quiesced Handoff & Recovery Kits:** Before switching slots, Singhouse ensures playback is stopped, the projector is closed, jobs are idle, and SQLite is quiesced. It creates a verified SQLite backup and copies the currently attested runtime, native Python helper, and verifier into an immutable recovery kit (`recovery-tool/kits/kit-<recovery-point>/`) beside the managed slots.
3. **Render-Verified Activation:** A handoff is marked durable only after the new slot's UI loads, reaches Electron's `ready-to-show`, completes two renderer animation frames, and produces a non-empty compositor capture. If the new slot crashes before frame confirmation, the supervising launcher automatically rolls back both the application slot and the SQLite database in a single `owner.lock`-guarded transaction.
4. **Standalone Recovery CLI:** If manual recovery is ever required outside the UI, run the kit's `recover.sh` (Linux/macOS) or `recover.cmd` (Windows) with the application-data directory, recovery-point ID, and `backend/` library path.

(Note: In the checked-in `release.json`, automatic updates and OS signing trust gates are disabled with an empty trust-root list until release signing keys are provisioned.)

---

## 5. Processing Packs, Model Inventories & Hardware Policy

Local AI song processing runs in a relocatable Python environment separate from the bundled playback Python.

### Building a Processing Recipe (`build_processing.py`)

Constructs a schema-2 `uv` installation recipe and builds local wheels/notices from locked dependencies:

```sh
python3 desktop/build/build_processing.py \
  --requirements desktop/locks/processing-linux-x64-cpu.json \
  --build-requirements desktop/locks/processing-build.txt \
  --native-toolchain desktop/locks/toolchain-linux-x64.json \
  --target linux-x64 --accelerator cpu \
  --cache /path/to/build-cache --output /path/to/new-processing-build
```

(Add `--artifact-layout flat --artifact-base-url https://...` when exporting `<sha256>-<filename>` assets for GitHub Releases.)

### Generating a Setup Catalog (`setup_catalog.mjs`)

Binds a processing runtime manifest, qualification evidence (`full`, `private-smoke`, or `hardware-test`), model terms, and optional memory policy into canonical JSON:

```sh
node desktop/build/setup_catalog.mjs \
  --runtime runtime.json \
  --qualification qualification.json \
  --terms terms.json \
  --identity identity.json \
  --output desktop/processing-catalogs/<platform>-<arch>.json
```

### Runtime Verification & Background Rechecks

* **Activation Self-Test (`python-functional-v1`):** Before activating a processing pack, Singhouse verifies every file hash and runs a 120s functional probe checking exact package versions, native audio ops, and synthetic model execution on the target device. Results are cached in `processing/probe-results/<identity>.json`.
* **7-Day Background Integrity Check:** At startup, admitted packs undergo a fast structural check (file count, regular-file types, exact sizes). If a pack's last full SHA-256 verification (`verified-at/<identity>.json`) is older than 7 days (`RECHECK_INTERVAL_MS`), Singhouse re-hashes every file in the background after launch and prompts to repair via **Settings → Song processing…** if corruption is found.

### Pinned Model Inventories (`desktop/models.json`)

Singhouse never hosts or redistributes model weights; the setup wizard downloads them directly from upstream and verifies every file's size and SHA-256 against `desktop/models.json`:

* **HeartTranscriptor (`heart-transcriptor`):** Pins [`HeartMuLa/HeartTranscriptor-oss`](https://huggingface.co/HeartMuLa/HeartTranscriptor-oss/tree/918f88917c17489c1f8dbae0165cd1019c4d5cd3) at revision `918f88917c17489c1f8dbae0165cd1019c4d5cd3` (11 files, `3,059,916,381` bytes / ~3.06 GB). Reproduce inventory metadata via `python3 desktop/build/inventory_heart.py`.
* **Default Separation Models (`demucs-mdx-extra` + `karaoke-roformer`):** 7 external files totaling `1,582,708,534` bytes (~1.58 GB: four Demucs checkpoints, `mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt`, YAML config, and metadata). Check local copies via `python3 desktop/build/inventory_separation.py`.

### CUDA Memory Admission (`bounded-v1`) & GPU Support

CUDA processing requires a target memory policy (`desktop/processing-memory/<platform>-<arch>.json`, packaged as `processing-memory.json`):

* **Guarded Envelope:** Decodes uploads via bundled FFmpeg to a temporary 44.1 kHz stereo float WAV before Pass 1 and checks track duration against `maxDurationSeconds`, free system RAM (`ramBytes`), and free GPU VRAM (`vramBytes`) before loading each stage.
* **Bounded Profile Settings:** Uses 6s Demucs segments, RoFormer segment size 256 (batch size 1, CUDA autocast), and 15s managed VAD segments for Heart (30s chunks, batch size 1).
* **Supported NVIDIA Architectures:** PyTorch 2.10 + CUDA 12.8 compiles kernels for `sm_70` through `sm_120` (Volta / Turing GTX 16-series & RTX 20-series through Blackwell RTX 50-series; requires driver R525+, or R570+ for Blackwell). Pascal (`sm_6x`, GTX 10-series) and older GPUs are unsupported for CUDA and fall back to CPU when sufficient RAM is available.

### Advisory Processing Speed Estimates (3-Minute Song)

Shown in the setup wizard as broad planning guidance for the default 3-model workflow (Demucs `mdx_extra` → RoFormer → HeartTranscriptor):

| Pack | Observed Hardware | Estimated Range (min) | UI Tier | Basis |
| --- | --- | --- | --- | --- |
| **CPU** | ≥ 16 logical processors | 9–16 min | Moderate | Measured (16C/32T Zen 3: 11.2 min) |
| **CPU** | 12–15 logical processors | 12–20 min | Moderate | Extrapolated |
| **CPU** | 8–11 logical processors | 15–28 min | Moderate | Extrapolated |
| **CPU** | < 8 logical processors | 25–45 min | Slower | Extrapolated |
| **Apple Metal** | M-series Pro/Max/Ultra, or M4+ | 5–12 min | Faster | Extrapolated |
| **Apple Metal** | Base M1/M2/M3 (≥ 15 GiB RAM) | 8–20 min | Moderate | Extrapolated |
| **Apple Metal** | Any Apple Silicon with < 15 GiB RAM | 15–35 min | Slower | Extrapolated |
| **CUDA** | RTX 3080/3090+, RTX 4070+, RTX 5070+ | 1–3 min | Faster | Extrapolated |
| **CUDA** | RTX 2060–2080 Ti, 3060–3070 Ti, 4060/Ti, 5060/Ti, T4 | 2–5 min | Faster | Extrapolated |
| **CUDA** | GTX 16xx, RTX 2050/3050/4050/5050 (≥ 7.5 GiB VRAM) | 5–12 min | Faster | Extrapolated |

(Note: CPU machines with < 15 GiB RAM shift one tier slower. CUDA cards with 7.5–9.5 GiB VRAM [8 GB cards] and laptop/Max-Q GPUs shift one tier slower each. Cards with ≤ 6 GB VRAM or GTX 10-series receive no CUDA estimate.)

---

## 6. Local Development & Automated Checks

### Disposable Source Development Mode

Runs the Electron shell directly against your source checkout using a temporary disposable library that is deleted on normal exit (`--demo` seeds synthetic audio tones and timed test words):

```sh
python3 -m venv .venv-desktop
.venv-desktop/bin/python -m pip install ./lyricsync ./backend
npm --prefix frontend ci && npm --prefix frontend run build
npm --prefix desktop ci

KARAOKE_DESKTOP_PYTHON="$PWD/.venv-desktop/bin/python" npm --prefix desktop start -- --demo
KARAOKE_DESKTOP_PYTHON="$PWD/.venv-desktop/bin/python" npm --prefix desktop run test:smoke
```

### Automated Unit & Native Smoke Tests

```sh
# 1. Unit tests
npm --prefix desktop test
python3 -m unittest discover -s desktop -p 'test_backend.py'
python3 -m unittest discover -s desktop/test -p 'test_*.py'

# 2. Native assembly smoke test (always pass -I -B so bytecode caches aren't mutated)
python3 -I -B desktop/test/native-smoke.py --native desktop/native --copy

# 3. Packaged executable smoke test (synthetic video playback, projector, restart persistence)
xvfb-run -a node desktop/test/packaged-smoke.mjs --executable desktop/artifacts/linux-unpacked/Singhouse
```

### Full UV Runtime Validation & Resource Profiling

* **Validate `uv` recipe installation locally:**

  ```sh
  python desktop/test/test_uv_installation.py --prefetch /path/to/native-inputs
  python desktop/test/test_uv_installation.py --full-runtime \
    --assets /path/to/native-inputs --work-root /path/to/fresh-validation \
    --evidence /path/to/runtime-evidence.json --accelerator cpu
  ```

* **Measure peak RAM/VRAM on Linux:** See `python3 desktop/qualification/profile_processing.py --help` or launch a `private-test` build with `--private-test-resource-measurement --user-data-dir=/absolute/isolated-test-profile`.
* **End-to-end packaged processing smoke tests (`packaged-processing-smoke.mjs`):** See [`desktop/qualification/README.md`](qualification/README.md).
