# Singhouse desktop

The desktop application bundles Electron, Python, the core backend, the frontend,
and FFmpeg/FFprobe. It opens an authenticated private loopback service and a
separate projector window. Installed applications keep your library across
restarts; the source-development shell uses a disposable library.

The bundled runtime supports prepared-media playback. It does not bundle model
weights or the heavy separation/transcription dependencies, and it does not
download models automatically. Installing the desktop application does not
establish that local AI processing is available.

## Build targets and installation

| Target | Artifacts | Installation |
| --- | --- | --- |
| Linux x64 | AppImage, `tar.gz` | Make the AppImage executable and open it, or extract the archive and run `Singhouse`. |
| Linux ARM64 | AppImage, `tar.gz` | Same installation steps on ARM64 Linux; native qualification is required. |
| macOS Apple Silicon | DMG, ZIP | Open the DMG and copy Singhouse to Applications, or extract the ZIP. The package requires macOS 14 or newer. |
| Windows x64 | NSIS `.exe` installer | Run the installer and choose a per-user installation directory. |

These are build targets, not certification of every operating-system, audio,
or display configuration. Asahi Linux compatibility is a separate qualification
track; an ARM64 artifact alone does not establish Asahi support.

Builds are unsigned. macOS Gatekeeper and Windows SmartScreen may warn or block
installation; verify the artifact's origin and checksum before using the
operating system's per-application approval controls. Signing and notarization
are not provided by these build commands. On Linux, use the archive if the
AppImage cannot run because its host integration requirements are unavailable.
Do not disable Electron's sandbox to launch a build.

The application stores its database, uploads, stems, cache, and `settings.json`
under `backend/` in Electron's per-user application-data directory, outside the
installed binaries. The settings file contains a persistent session secret;
keep it private. Normal shutdown preserves this data, and the Windows
uninstaller is configured to preserve application data. Back up the complete
application-data directory while Singhouse is closed before replacing a build;
retaining data is not a guarantee that every older build can read a newer schema.

Only one application instance and one backend may own the library. If the
backend stops unexpectedly, quit and reopen Singhouse. Its operating-system lock
is released when the process exits; do not delete the lock file to bypass a
running owner. Desktop configuration uses `settings.json`, not a `.env` file in
the backend data directory.

## Build an installer

Run commands from the repository root. Build tools require Node.js 22, Python
3.12 or newer, and the exact uv version recorded in `desktop/locks/native.json`
(currently `0.12.8`). Network access is needed to obtain locked build inputs.
Application users do not need these tools.

```sh
npm --prefix desktop ci
python3 desktop/build/assemble.py --output desktop/native
npm --prefix desktop run package
```

On Windows, use `python` instead of `python3` if that is the installed command.
The assembler downloads checksum-pinned Python and FFmpeg inputs, builds the two
application wheels with a pinned host toolchain, installs locked dependencies,
and rebuilds the frontend using its npm lockfile. It refuses an existing output
directory: choose a fresh path for each assembly.

The default payload is `desktop/native/`; installers are written to
`desktop/artifacts/` as `Singhouse-<version>-<os>-<arch>.<extension>`. The packaging
step also creates an unpacked application directory there. Packaging never
publishes artifacts. Create macOS installers on macOS.

To use a different payload path, set `KARAOKE_NATIVE_PAYLOAD` for packaging:

```sh
python3 desktop/build/assemble.py --target linux-arm64 --output /tmp/singhouse-native-arm64
KARAOKE_NATIVE_PAYLOAD=/tmp/singhouse-native-arm64 npm --prefix desktop run package
```

`--target` accepts `linux-x64`, `linux-arm64`, `darwin-arm64`, and `win32-x64`;
it defaults to the host. Cross-assembly does not execute target Python or
FFmpeg. Its provenance marks the result `UNTESTED`, requiring execution on the
target machine. Windows payload staging is possible on another supported host;
build and test its installer on Windows. `--cache <directory>` selects a build
cache. For a source export without `.git`, also pass
`--source-commit <40-hex-commit>`; provenance records that export cleanliness
cannot be independently established.

Each payload includes `manifest.json`, `files.json`, `provenance.json`, and
`notices/` to identify its runtime, file hashes, upstream inputs, installed
packages, and licenses. Preserve these with the artifact.

## Optional processing packs and offline models

The packaged application's Processing menu reports playback, transcription,
separation, and user-owned Modal readiness separately. Choose “Install processing
runtime or model cache…” to select an explicit local JSON manifest. Runtime
manifests authorize executable code: obtain them from a source you trust and
review the displayed size before installation. No production download catalog,
publication service, or signing trust root is configured by this prototype.

Processing uses a separate relocatable Python environment. CPU, CUDA, and Metal
are separate pack variants; platform, architecture, and application package
versions must match. `locks/processing-targets.json` lists build inputs, not
qualified hardware. A declared CUDA or Metal variant alone does not demonstrate
that its drivers or hardware work. Installing a pack never changes the small
playback environment or installs packages into it.

After hash verification, the application runs its fixed `python-functional-v1`
self-test through the selected interpreter before activation and on startup.
It checks exact Python/application versions, native audio operations, selected
device execution, and small synthetic architecture operations. The process has
a 120-second default bound to accommodate cold native imports and cannot retrieve
models. Explicit caller timeouts remain honored. Failure, invalid output, or timeout
prevents activation; a failed startup check leaves playback available. Legacy
`python-imports-v1` packs retain their 30-second default, remain import evidence
only, and never grant a runnable capability. Functional runtime readiness is separate from installed model sets,
model quality, and physical platform qualification.

The pack assembler consumes an already-built target environment and a complete
input lock. The lock identifies application/Python versions, target, accelerator,
managed Python path, capabilities, each model's capability, required model IDs,
source commit, upstream package artifact hashes, licenses, retained notice paths,
and every payload file's path, size,
SHA-256, and executable flag. Unlisted files, modified inputs, and symlinks fail
assembly. Linux preserves case-distinct names; Windows and macOS reject names
that collide without case sensitivity. Model weights are never part of a runtime.

`build_processing.py` constructs this input from the exact artifact recipes in
`desktop/locks/processing-*.json`, the pinned standalone Python archive, and
application wheels built from a clean source commit. Source distributions use
the locked build dependencies. Native extensions additionally require a verified
compiler identity; source/debug paths are normalized. This supports reconstruction
with the recorded toolchain; the native compiler lock is not a hermetic container
or a claim that every host toolchain produces identical bytes.

```sh
python3 desktop/build/build_processing.py \
  --requirements desktop/locks/processing-linux-x64-cpu.json \
  --build-requirements desktop/locks/processing-build.txt \
  --native-toolchain desktop/locks/toolchain-linux-x64.json \
  --target linux-x64 --accelerator cpu \
  --cache /path/to/build-cache --output /path/to/new-processing-build
```

Build native source extensions on their target runner. Dependency locks for
other targets describe build inputs, not successful hardware qualification.
To package a separately constructed locked payload:

```sh
python3 desktop/build/assemble_processing.py --payload /path/to/locked-payload \
  --lock /path/to/processing-input-lock.json --output /path/to/new-pack
```

The output includes `manifest.json`, `input-lock.json`, and content-addressed
`blobs/`. By default its URLs refer to those local blobs; `--base-url` may declare
an explicit HTTPS blob directory for a separately managed distribution. The
assembler does not upload anything. Each package must name its retained license
or notice files; the manifest embeds and hash-binds the complete input lock and
rejects missing notice files. File hashes establish correspondence
with a selected manifest; they do not establish publisher identity.
Installation additionally requires the input-lock hash to appear in the
application-shipped `processing-locks.json`; a manifest cannot trust its own lock.

Installation checks free disk space, takes an exclusive lock, resumes partial
files where supported, checks every size and hash, and synchronizes payload files
and directory metadata through a fixed helper in the bundled playback Python.
POSIX requires directory `fsync`; Windows uses `MoveFileExW` with
`MOVEFILE_WRITE_THROUGH`, `FlushFileBuffers`, and a volume-flush fallback when
directory handles cannot flush metadata. If the OS or account denies both
metadata-flush routes, installation fails without claiming activation; the app
does not request elevation. Both staging-to-pack moves and inactive pointer-slot
replacement use this native durability path. Two checksummed pointer slots keep
the previous verified selection recoverable if an interrupted commit loses new
directory entries. This engineering contract does not establish physical Windows
or filesystem qualification. Cancellation, checksum failures, and interrupted
transfers preserve the previous selection. Changes take effect on restart, so
running jobs keep the environment they started with. Old verified packs remain
in application data under `processing/packs/`; they are not removed automatically.
To select a retained version, install its original manifest again. Installation
locks are held by the operating system through the bundled playback interpreter;
process death releases them automatically, and retry preserves partial transfers.
The persistent lock file records the owner PID, parent PID, start timestamp, and
Linux process-start/boot evidence where available. Its existence alone does not
mean an installation is running. Never delete or replace a lock file to bypass a
running owner: the next attempt acquires the same inode only after its prior
kernel lock has been released.

Runtime file access uses no-follow descriptors where the platform supports them,
with descriptor-based type, size, hash, write, and mode checks. This rejects
symbolic-link files and avoids redirecting writes when a leaf path is replaced.
The installation store remains inside the user's local trust boundary: Node does
not provide a portable directory-descriptor-relative `openat` traversal, so the
app does not claim protection from a malicious process running as the same user
that concurrently replaces ancestor directories or installed binaries.

The first explicit Heart transcription or audio-upload action opens Heart setup.
You can also open Processing → Set up Heart transcription. The dialog shows the
exact size and upstream source before you choose to retrieve files or select an
existing complete Heart model folder. Cancel keeps the operation unsubmitted.
Progress appears in the application taskbar/dock; Processing → Cancel installation
interrupts setup, and retry resumes verified partial transfers. Insufficient disk
space, interrupted transfers and checksum failures preserve the prior cache.
After installation, reopen the application and retry the original action.
Prepared playback remains available while setting up models.

`models.json` defines the upstream allowlist and offline cache contract.
Only model IDs and complete immutable inventories defined by the shipped policy
are accepted. The policy includes the pinned Heart inventory below;
a user-created manifest cannot declare another model ready. Each non-executable model file
must exactly match its policy's upstream revision or content-digest identity,
HTTPS URL, size and SHA-256. Legacy fixed release assets use the full file digest
as their identity; changed upstream bytes fail verification. Singhouse does not
host model copies.
The manifest's `models` array identifies the unique policy-defined model sets it contains.
Paths begin with `huggingface/`, `torch/`, or `audio-separator/` and must reproduce
the consuming library's complete offline cache layout, including configuration
and tokenizer files. A weights file alone is not a complete model cache.
Cache installation uses the same verification and activation procedure as packs.

The desktop sets offline flags, directs workers to the verified cache, and never
falls back to a paid service. A new machine has playback available while local
processing reports missing runtime or models. Provision and test the desired
model set before going offline. Model readiness and runtime readiness are separate:
installing Heart alone does not enable transcription without a compatible,
trusted runtime that passes its functional checks. A complete cache
survives application replacement in persistent application data. To move an
installation offline, select a folder containing all pinned Heart files; files
are checked against the same inventory with no network fallback. If the active
cache contains additional model sets, provide their full manifest-relative folder
layout as well so those selections are preserved.

Heart remains the default. The explicitly selected faster-whisper alternative
requires its own compatible runtime and model cache; it is never selected as a
silent fallback. User-owned Modal requires separate explicit operator configuration;
the stock desktop does not inherit credentials or enable it automatically.

## Automated checks

```sh
npm --prefix desktop test
python3 -m unittest discover -s desktop -p 'test_backend.py'
python3 -m unittest discover -s desktop/test -p 'test_*.py'
python3 desktop/test/native-smoke.py --native desktop/native --copy
```

Run the native smoke test on the payload's target OS and architecture. It uses
fresh temporary data and checks relocation, authenticated boot, origin/host
rejection, synthetic prepared-video import and decoding, the library lock, and
persistent restart. It does not test installation or physical playback.

The packaged application smoke harness currently isolates application storage
on Linux only. Point it at the unpacked or extracted application's executable:

```sh
xvfb-run -a node desktop/test/packaged-smoke.mjs --executable desktop/artifacts/linux-unpacked/Singhouse
```

The installed macOS bundle is `Singhouse.app`, with executable
`Singhouse.app/Contents/MacOS/Singhouse`; Windows installs `Singhouse.exe`.
The packaged smoke harness above remains Linux-only.

Use the actual unpacked directory for your target; omit `xvfb-run -a` when running
on a graphical Linux desktop. This launches the packaged application, exercises
synthetic prepared-video playback and the projector, and checks restart
persistence using temporary test storage. It does not establish physical audio
routing or monitor behavior.

## Disposable source development

Use a dedicated core-only Python environment; backend plugins are rejected.

```sh
python3 -m venv .venv-desktop
.venv-desktop/bin/python -m pip install ./lyricsync ./backend
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix desktop ci
KARAOKE_DESKTOP_PYTHON="$PWD/.venv-desktop/bin/python" npm --prefix desktop start -- --demo
KARAOKE_DESKTOP_PYTHON="$PWD/.venv-desktop/bin/python" npm --prefix desktop run test:smoke
```

The development shell imports source from this checkout and deletes its library
on normal exit, including imported media. `--demo` adds quiet synthetic tones and
original timed test words. Use copies of your media. On Windows, use the venv's
`Scripts/python.exe` and set `KARAOKE_DESKTOP_PYTHON` to its absolute path in your
shell. Linux graphical smoke tests can run under `xvfb-run -a`.

## Playback qualification

Use the host's projector button to open the display; the Projector menu controls
fullscreen and display placement. Opening the projector requests prevention of
display sleep. Closing the host closes its projector and backend.

The output selector routes the show player's audio and reapplies the selection
for each item. Editor-preview audio has a separate context. Only devices exposed
by the OS/browser are available; microphone permission, ASIO, and exclusive audio
access are not supplied by this control.

Before relying on a build for a show, physically check speaker routing and
volume, output switching and removal, projector close/reopen, fullscreen,
external-display removal, host minimize/restore, workspace switching, and
shutdown. Virtual-display tests cannot establish audibility, hardware routing,
monitor behavior, or OS workspace behavior. Those checks remain separate from
automated smoke results.

## Heart model source and inventory

The `heart-transcriptor` policy entry pins the upstream
[HeartMuLa/HeartTranscriptor-oss repository](https://huggingface.co/HeartMuLa/HeartTranscriptor-oss/tree/918f88917c17489c1f8dbae0165cd1019c4d5cd3)
at revision `918f88917c17489c1f8dbae0165cd1019c4d5cd3`. Its eleven runtime
files total 3,059,916,381 bytes (about 3.06 GB): one safetensors checkpoint,
model and generation configuration, audio preprocessing configuration, and
the complete tokenizer vocabulary, merges, normalization and token metadata.
The application downloads these files directly from upstream; the installer
contains the inventory, not model weights.

Within a verified model pack, the directory
`huggingface/heart/918f88917c17489c1f8dbae0165cd1019c4d5cd3` is a local
`from_pretrained` directory. It is not a Hugging Face Hub cache snapshot and
must be passed explicitly to both the processor and model when loading offline.

To reproduce the policy entry, run `python3 desktop/build/inventory_heart.py`.
This reads the pinned upstream API metadata and small configuration/tokenizer
files, verifies those files against their Git blob identities, and computes
their SHA-256 hashes. The weight hash and byte count come from upstream LFS
metadata; the inventory command never downloads the checkpoint. Review its
output against `desktop/models.json` before updating the policy. The exact
file hashes and sizes are checked again during installation.

## Default separation model inventory

The default two-pass local workflow requires `demucs-mdx-extra` and
`karaoke-roformer`. Its seven external files total 1,582,708,534 bytes: four
Demucs checkpoints, the RoFormer checkpoint and YAML configuration, and its
upstream model metadata. The remaining model catalog and Demucs bag definition
are retained in their pinned runtime wheels. Installing the runtime alone does
not mark this workflow ready; both verified model sets are required. Alternate
separation or transcription models require their own explicit policy and cache.

`desktop/build/inventory_separation.py` checks a supplied local model copy against
the exact shipped inventory. Its optional upstream check verifies release asset
identities and sizes plus pinned small metadata; it does not retrieve checkpoint
bytes or establish remote weight equality by metadata alone.
