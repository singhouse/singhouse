# Singhouse desktop

The desktop application bundles Electron, Python, the core backend, the frontend,
and FFmpeg/FFprobe. It opens an authenticated private loopback service and a
separate projector window. Installed applications keep your library across
restarts; the source-development shell uses a disposable library.

Release operators should use the [qualification
harness](qualification/README.md) and the checked-in [release
checklist](../docs/release-checklist.md). User installation and diagnostic
instructions live in [Install Singhouse Core](../docs/install-desktop.md) and
[Support diagnostics](../docs/support-diagnostics.md).

The bundled runtime supports prepared-media playback. It does not bundle model
weights or the heavy separation/transcription dependencies, and it does not
download models automatically. Installing the desktop application does not
establish that local AI processing is available.

## Build targets and installation

| Target | Artifacts | Installation |
| --- | --- | --- |
| Linux x64 | Portable application, optional AppImage/`tar.gz` first installer | Run the installed launcher; native qualification is required. |
| Linux ARM64 | Portable application, optional AppImage/`tar.gz` first installer | Same installation steps on ARM64 Linux; native qualification is required. |
| macOS Apple Silicon | Portable application, optional DMG/ZIP first installer | Open the DMG and copy Singhouse to Applications for first installation. The package requires macOS 14 or newer. |
| Windows x64 | Portable application, optional NSIS first installer | Run the installer and choose a per-user installation directory for first installation. |

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

The default native payload is `desktop/native/`. Packaging creates a deterministic
`Singhouse-<version>-<os>-<arch>.shapp` portable application and a canonical build
receipt in `desktop/artifacts/`. The portable header binds the exact recursive
file inventory and its digest, entry point, target, native assembly, Electron `app.asar`, source
commit, runtime locks, model policy, database schema history, and core/premium
pairing. Both identity derivation and receipt publication verify every native
`files.json` entry against the packaged file bytes, including Python bytecode.
Missing, changed, or malformed entries fail packaging; rebuild the assembly
from clean inputs instead of regenerating its expected hashes. The receipt re-inspects that payload instead of trusting neighboring
build files and records the modeled application subtree. `npm --prefix desktop
run package:first-installers` embeds that receipt in the native first-install
app. On first launch, every modeled file, directory, and internal link is
checked. Any injected entry is rejected; the only non-modeled entries are the
canonical receipt itself and the exact Windows uninstaller wrapper. Packaging
also reads the current Git `HEAD` and `git status --porcelain=v1
--untracked-files=all`: the checkout must be clean and must exactly match the
native provenance both before the build and again immediately before publishing
the immutable receipt. Source exports without `.git` fail closed because no
separately authenticated export-manifest verifier is configured. The default
packaging command creates an explicitly unsigned private-test build and never
publishes anything. Create macOS artifacts on macOS.

Windows release signing is an explicit, fail-closed build mode. Run it on
Windows after assembling the `win32-x64` native payload:

```powershell
# First manual release: use the Azure user already granted the signer role.
az login
npm --prefix desktop run package:first-installers -- --signed-release --azure-cli-user
```

The manual flag first requires a successful `az account show`, then constrains
DefaultAzureCredential to the Azure CLI identity. It does not ask for, accept,
or store the Azure account password.

The recommended CI path is the manually dispatched private Windows signing
workflow. Its job uses the protected `windows-signing` GitHub environment,
obtains a short-lived service-principal token through GitHub OIDC, and passes
`--azure-oidc`. No client secret is created or stored. Configure
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_SUBSCRIPTION_ID` as
environment secrets on the protected `windows-signing` environment itself,
not as repository or organization secrets. The build verifies that `az account show` is the expected
service-principal session and constrains DefaultAzureCredential to
AzureCliCredential. It requires exactly one `singhouse-signing` account in the
configured subscription, requires its normalized location to be `centralus`,
then queries its exact `singhouse` profile before building; that profile must
report `PublicTrust`.

Configure the Entra application as single-tenant. Its GitHub federated
credential must use issuer `https://token.actions.githubusercontent.com`,
audience `api://AzureADTokenExchange`, and subject
`repo:singhouse/singhouse:environment:windows-signing`. In the GitHub
repository settings, create the `windows-signing` environment, add a required
reviewer, and restrict its deployment branches to the protected `main` branch.
These are required setup values, not a claim that the live GitHub or Entra
settings have been inspected. Do not add access-token or OIDC-token output to
workflow diagnostics.

The workflow only uploads a private Actions artifact. It does not publish a
release or download, deploy, or change update metadata. Its checksum inventory
is generated after signature verification. Every action is referenced by an
immutable reviewed commit ID.

A client-secret service principal remains available as an operator-controlled
fallback. Omit both Azure CLI flags and provide the complete environment
credential. This mode constrains DefaultAzureCredential to
EnvironmentCredential:

```powershell
$env:AZURE_TENANT_ID = '<Microsoft Entra tenant ID>'
$env:AZURE_CLIENT_ID = '<signing application client ID>'
$env:AZURE_CLIENT_SECRET = '<signing application client secret>'
npm --prefix desktop run package:first-installers -- --signed-release
```

The signing identity must have the Artifact Signing Certificate Profile Signer
role for account `singhouse-signing`, profile `singhouse`, in Central US. The
build uses `https://cus.codesigning.azure.net`, SHA-256 file digests, and the
Microsoft RFC 3161 timestamp service. Credentials are read only from the build
environment. Signed mode refuses to run off Windows, with partial environment
credentials, with mixed authentication modes, without one complete
authentication mode, or without first-installer packaging. It verifies that
the packaged application executable and final NSIS installer have a valid timestamped
signature from the exact Bones Consulting LLC certificate subject before it
reports success. Electron Builder's NSIS signing path also signs its generated
uninstaller. Keep these values in the CI secret store; never add them to this
repository or an artifact.

Release policy is edition-owned. Core uses the checked-in `release.json`;
premium packaging must set `SINGHOUSE_RELEASE_POLICY` to its premium policy.
That policy explicitly approves one core policy ID and channel/schema train.
The approved core authority, channel, and policy ID are stable; its schema
history and minimum-readable bounds are separate moving state, so a compatible
core schema advance does not silently rotate the premium authority.
The policy's content-derived ID binds its edition, channel, signature threshold,
trust roots, and native signing gates into the application identity and signed
update metadata. The assembly, package, installed application, target, and
rollback must all name that exact edition and policy. A premium old/new pair is
therefore authenticated under premium trust and cannot consume the core feed or
core trust roots. This separation is an update-integrity contract, not license
enforcement.

Authenticated update metadata is generated only from an inspected target receipt
and an inspected rollback receipt. Premium metadata additionally requires the
inspected old and new core receipts and payloads. Both receipts must use the
explicitly approved core policy and compatible schema train; their release IDs
and application versions must exactly match the premium rollback and target
pairings. Both portable applications are signed into the
metadata so a first update from an NSIS or DMG installation can seed a verified
rollback copy. The checked-in trust-root list is deliberately empty: signing and
distribution remain inactive until release keys are provisioned through the
separate publication gate.

## Coordinated application updates and recovery

NSIS, DMG, and AppImage/archive outputs remain first-install surfaces. Later
updates do not overwrite those installations. From **Application release**, an
operator selects locally supplied, signed update metadata; Singhouse retrieves
the exact target and rollback `.shapp` files named by it. An adjacent local
artifact is preferred. Only when that exact filename is absent may Singhouse
use the artifact's signed HTTPS URL; unsafe local entries and other local read
failures are rejected rather than hidden by a network fallback. Singhouse verifies the
signature and complete inventories, and safely extracts them into private,
managed release slots in application data. Archive traversal, devices, unsafe
links, case collisions, omitted files, extra files, and changed bytes are
rejected. Two checksummed selection records retain current and last-good state.
The original OS-installed executable remains a stable launcher outside the
managed release root. On every later invocation it authenticates the currently
selected managed slot and opens it, so it still reaches v2 after v0→v1→v2 even
though the latest handoff names v1 as its prior release. Executables inside a
managed slot remain release-specific and still fail closed on an unrelated
identity mismatch; the launcher does not retain or walk a handoff chain.

Activation is allowed only after playback is silent, the projector is closed,
jobs and installers are idle, the backend is ready, and the database can be
quiesced. Singhouse then creates and verifies a SQLite recovery point, persists
an authenticated handoff, stops the old backend, and atomically selects the new
slot. A small bootstrap waits for the old process to exit and launches only that
verified selection. A stale old process may redirect only for the handoff's
exact prior-to-target pair; every other identity mismatch is shown to the
operator. Handoff completion is durable only after the target UI finishes
loading, reaches Electron's `ready-to-show` boundary, is shown, completes two
renderer animation frames, and yields a nonempty compositor capture. Merely
calling `show()` is not an acknowledgement. A renderer crash after that call
but before the frame evidence leaves the handoff incomplete, so the supervising
launcher restores the paired prior application and database; an exit after the
durable acknowledgement does not. Interrupted retrieval, extraction, backup,
selection, or first startup therefore leaves an explicit retry/recovery state
instead of guessing which application or database belongs together.

The highest signed sequence accepted and the highest sequence successfully
presented are stored durably with the handoff and selected-release record.
Restarting cannot reset that anti-replay floor or substitute a different
release at the same sequence. An interrupted exact staged release may be
retried; recovery to its signed prior application preserves the floor, so any
different later update must carry a higher signed sequence.

Release versions use canonical `MAJOR.MINOR.PATCH` SemVer; this work does not
assign a public release version. Patch releases are compatible corrections,
minor releases add backward-compatible features or migrations, and major
releases may intentionally change product or data contracts. The updater only
accepts a version strictly newer than the installed version. Its signed schema
history may not decrease, and its signed minimum-readable history must include
the installed history; those checks are independent of the version number.
Signed sequences increase strictly within one exact edition, channel, and
policy identity and remain at their accepted floor through rollback or
recovery. Core and premium releases share a coordinated release train and app
version: a premium target binds the exact new core release ID, while its signed
rollback payload retains the exact old core/premium pair. Core has no premium
license enforcement; it checks only the generic signed edition and policy
identity.

Update-bound recovery always restores the exact prior managed application and
its database as one transaction. It cannot be invoked through the ordinary
database-only restore action, and a recovery point written by another release
is likewise rejected. Before quiescing, each update copies the currently
attested application runtime, native Python recovery helper, minimal verifier,
and recovery implementation to a point-specific
`recovery-tool/kits/kit-<recovery-point>/` beside (not inside) both
managed release slots. It therefore needs neither a system Node installation
nor a working target slot. The stable first-install executable is recorded by
exact path and digest outside the kit. Bootstrap, Python, and native-helper
bytes are recorded by digest but resolved anew inside the authenticated
installer application on every launch. Linux must not derive the stable
executable from ambient `APPIMAGE` or `APPDIR`; those variables are untrusted
hints. AppImage anchor creation, rotation, standalone recovery, and therefore
update enablement fail closed unless a native/detached verifier binds the exact
outer-image bytes to the real active mount. Every
immutable kit calls one stable per-user invoker, which a verified reinstall may
atomically retarget after an authorized install-directory relocation without
rewriting old kits. Automatic recovery uses the already-running authenticated
bootstrap; standalone recovery starts the current anchor application and
applies its platform signature hook. The stable native helper verifies the complete kit inventory
before it executes any retained Electron or recovery-code byte. A missing or
damaged anchor fails closed with a reinstall/recovery instruction. On POSIX it
additionally checks current-user ownership and private permission bits. The
native-verified stable installer owns that anchor and atomically repairs a
corrupt anchor or rotates one whose installed executable/helper digests have
changed during a verified reinstall; managed update targets can only read and
verify it. A bundled release receipt authenticates modeled inner files but
cannot authenticate the wrapper that supplied it. Linux and Windows anchor
rotation remain disabled unless their qualified platform trust hooks are
enabled; macOS additionally requires its enabled `codesign` gate. An explicitly
update-disabled build leaves anchor state untouched, so
ordinary first launch does not depend on unavailable signing hooks. Reinstalling
changes no library or recovery-point data. The
standalone entry is the reported kit's `recover.sh` on Linux/macOS and
`recover.cmd` on Windows; pass the application-data directory,
the reported recovery-point identifier, and its `backend/` library directory.
Each immutable kit manifest binds the exact recovery point, signed update,
prior and target release identities, and sequence. The authenticated handoff
atomically selects that already-durable kit; an aborted attempt before the
handoff journal is published leaves every earlier compatible kit intact.
The UI reports the recovery-point identifier if handoff fails; keep the staged
metadata, prior managed slot, recovery point, and recovery kit together for
diagnosis. A completed recovery transaction is retained until a later fully
verified target has loaded and been shown, at which point that handoff durably
supersedes it. It therefore cannot block all future updates or be mistaken for
the new rollback after an interrupted presentation.

The replaceable prior slot is never an executable recovery source. One native
paired-recovery transaction holds `owner.lock` continuously while it verifies
and copies the complete retained-kit application into that slot, restores
SQLite, and durably commits the active pointer and completion record. Competing
launches are blocked throughout those mutation boundaries. After success the
helper releases ownership and immediately starts the exact recovered entrypoint,
so that recovered backend can acquire `owner.lock` normally.

Manual and update-bound recovery use separate durable latest pointers. The UI
offers only the newest verified manual point for database-only restore, while
the read-only **Show update recovery information** action reports the update
point and versioned kit selected by the authenticated handoff journal. The authenticated
handoff and standalone recovery path use that update point; creating either
kind can never hide or reclassify the other.

Linux launches the already-verified executable by descriptor. macOS verifies
the selected app bundle with `codesign` before launch when that release-policy
gate is enabled. Windows verifies a managed application's timestamped
Authenticode signature and exact certificate subject before launch when its
release-policy gate is enabled. First-install recovery admission remains closed
because Windows does not retain the outer NSIS installer as a durable recovery
anchor after installation. The checked-in release policy therefore keeps the
Windows gate disabled; enabling it requires modeling and qualifying that outer
installer evidence as well. The checked-in policy also disables updates and has
an empty update trust root; its macOS and Windows gates are likewise disabled, so
these builds cannot accidentally claim signed
activation. Cross-platform tests exercise injectable launch/trust primitives.
Recovery self-verification detects corruption and replacement by accounts that
cannot also rewrite the current user's private state. Signed metadata, private
permissions or ACLs, and held file handles do **not** defend against malware
already running as that same user. In particular, coherent same-user
replacement while verification is running, and coherent at-rest replacement
of both a recovery kit and its manifest before recovery begins, are outside the
supported boundary. No combination of the checks described here should be read
as claiming otherwise.

Within that boundary, each supported platform uses non-symlink leaf checks,
exact inventory verification immediately before launch, authenticated update
metadata, private managed slots, and fail-closed OS-signing policy hooks.
Current-user ownership and group/world mode enforcement are POSIX guarantees
only. Windows ACL and first-install recovery trust enforcement remain disabled
and fail closed until their platform trust hooks are qualified and enabled. Real Windows x64
signing, crash, clean-machine, and macOS arm64 qualification remain
separate release checks.

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
cache. An export without `.git` can be assembled for inspection with
`--source-commit <40-hex-commit>`, but it cannot be packaged as a release. A
future export path must authenticate the complete source inventory rather than
trust a caller-supplied commit string. Release packaging currently requires a
clean Git checkout whose exact HEAD matches the native provenance, including a
clean full untracked-file status.

Each native payload includes `manifest.json`, `files.json`, `assembly.json`, `provenance.json`, and
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
`MOVEFILE_WRITE_THROUGH` and `FlushFileBuffers` on ordinary-user file and
directory handles inside the application-owned subtree, through their narrow
common ancestor. It never opens a raw volume or climbs into unrelated protected
ancestors. If any required metadata handle cannot be flushed, installation
fails before replacement without claiming activation; the app does not request
elevation. Both staging-to-pack moves and inactive pointer-slot
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
python3 -I -B desktop/test/native-smoke.py --native desktop/native --copy
```

Run the native smoke test on the payload's target OS and architecture. Always
pass `-I -B`, including when using the bundled Python as the smoke driver, so
imports cannot rewrite the assembly's Python caches. The driver rejects a
missing flag before importing its test dependencies. It uses
fresh temporary data and checks relocation, authenticated boot, origin/host
rejection, synthetic prepared-video import and decoding, the library lock, and
persistent restart. It does not test installation or physical playback.

The packaged application smoke harness supports Linux and Windows, using a
temporary user-data directory. Point it at the packaged application's executable:

```sh
xvfb-run -a node desktop/test/packaged-smoke.mjs --executable desktop/artifacts/linux-unpacked/Singhouse
```

On Windows, run `node desktop/test/packaged-smoke.mjs --executable "C:\path\to\Singhouse.exe"`.
The same command can test the installed executable after a test installation.

The installed macOS bundle is `Singhouse.app`, with executable
`Singhouse.app/Contents/MacOS/Singhouse`; Windows installs `Singhouse.exe`.
The packaged smoke harness does not yet support macOS.

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
