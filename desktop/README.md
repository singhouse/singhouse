# singhouse desktop

The desktop application bundles Electron, Python, the core backend, the frontend,
and FFmpeg/FFprobe. It opens an authenticated private loopback service and a
separate projector window. Installed applications keep your library across
restarts; the source-development shell uses a disposable library.

Release operators should use the [qualification
harness](qualification/README.md) and the checked-in [release
checklist](../docs/release-checklist.md). User installation and diagnostic
instructions live in [Install singhouse Core](../docs/install-desktop.md) and
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

Default builds are unsigned; Windows has an explicit signed build mode below.
macOS Gatekeeper and Windows SmartScreen may warn or block installation; verify the artifact's origin and checksum before using the
operating system's per-application approval controls. Default build commands do not sign or notarize artifacts. On Linux, use the archive if the
AppImage cannot run because its host integration requirements are unavailable.
Do not disable Electron's sandbox to launch a build. The AppImage launcher
requires sandboxing and refuses bypass arguments. If Electron reports unavailable
sandbox facilities, launch stops; it does not retry without protection or change
host settings. The archive also requires a working Electron sandbox.

The Linux application includes its own `AppRun` through `linux.extraFiles`, before
release inventory and receipt creation. With the pinned electron-builder version,
the AppImage staging step copies that launcher over the generated launcher; the
AppImage desktop entry uses an explicit empty argument list. Packaging tests check
both staging paths so an upstream change cannot silently restore an unsafe fallback.
With desktop build dependencies installed, run
`SINGHOUSE_REQUIRE_BUILDER_TESTS=1 node --test test/appimage.test.mjs` from `desktop/`
as part of Linux packaging qualification. Without those dependencies the staging
test reports a skip; dependency-free launcher tests still run on Linux.

Linux first-installer builds additionally require `unsquashfs` from squashfs-tools
4.6 or newer within the 4.x series on the build host. This is a build-only tool;
it is not required to launch the installed application. The build checks and logs
its version, validates the listing before extraction, and never runs the AppImage
to inspect it. Symlinks must use canonical relative targets; a path that could
resolve differently after traversing another symlink is rejected. SquashFS offsets come from the selected builder runtime bytes,
whose prefix must match the image. The bounded extraction fixture tests also use
`mksquashfs`; install both tools when running the required packaging tests above.

First-installer packaging requires a fresh Linux unpacked output directory.
Preserve or explicitly remove a previous build before starting another. A temporary
preparatory AppImage supplies the complete generated layout, including icons,
desktop metadata, symlinks, and runtime support libraries. The original application
must remain identical within that layout. Those additions enter the canonical
unpacked application before the portable payload, release identity, and receipt
are derived. A separate temporary input avoids duplicate generated symlinks when
building the final AppImage. The final extracted image must exactly match the
modeled application plus its receipt, including executable permission bits.

This requires two AppImage compression passes and temporary space for the copied
application and extracted images. Temporary trees are owned by the build and
removed on success or failure. Final AppImage/archive outputs are first copied
to exclusive temporary files on the destination filesystem, given the exact
source permissions, synced, and published through exclusive hardlinks. Existing
artifacts are never replaced. Abrupt termination can leave a hidden staging
directory, but never exposes an incomplete final artifact name. Tool-version logging and inventory checks are validation
measures; they do not establish byte-for-byte reproducible container builds.

The application stores its database, uploads, stems, cache, and `settings.json`
under `backend/` in Electron's per-user application-data directory, outside the
installed binaries. The settings file contains a persistent session secret;
keep it private. Normal shutdown preserves this data, and the Windows
uninstaller is configured to preserve application data. Back up the complete
application-data directory while singhouse is closed before replacing a build;
retaining data is not a guarantee that every older build can read a newer schema.

Only one application instance and one backend may own the library. If the
backend stops unexpectedly, quit and reopen singhouse. Its operating-system lock
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
npm --prefix desktop run package -- --playback-only
```

On Windows, use `python` instead of `python3` if that is the installed command.

Every packaging command states whether the application can install local song
processing, by naming exactly one of `--processing-ready` or `--playback-only`.
The packaging script has no default, for signed and unsigned builds alike (the
Windows signing workflow below passes one explicitly, from a dispatch choice
that defaults to `playback-only`). Pass the flag after
`--` (`npm --prefix desktop run package -- --processing-ready`): without `--`,
npm consumes it as its own configuration, and packaging refuses to start when it
sees that. Only the exact flags are accepted; forms such as
`--processing-ready=true` are rejected.

- `--processing-ready` requires the target's catalog,
  `desktop/processing-catalogs/<platform>-<arch>.json` (see below), and refuses
  to package unless it passes the same validation the installed application
  applies at start for the exact target being built. The target is read from
  the native assembly's manifest (`linux-x64`, `linux-arm64`, `darwin-arm64`, or
  `win32-x64`). The catalog is checked against the channel of the release
  policy being packaged, so a `private-smoke` catalog cannot be packaged into a
  build whose channel is not `private-test`. The file must also be byte for
  byte the generator's output for the catalog it validates to (two-space
  indented JSON with a trailing newline, keys in generator order): duplicate
  keys, unknown fields, reordered keys, or hand reformatting are refused with
  "catalog is not the generator's canonical output; regenerate it".
- `--playback-only` packages no catalog, even when one exists for the target
  (the build output says it is deliberately excluded). Such builds offer
  playback and report local song processing unavailable during setup.

Only the selected target's catalog is ever packaged, as `processing-catalog.json`
inside `app.asar`; catalogs for other targets, the `processing-catalogs/`
directory itself, and any stray `desktop/processing-catalog.json` are not. After
Electron packaging and before identity derivation or the receipt, packaging
reads the produced `app.asar` back and fails unless it contains exactly the
validated catalog bytes (processing-ready) or no catalog (playback-only).
Packaging writes `desktop/artifacts/processing-mode.json` next to the receipt
(created exclusively; an output directory that already holds one is refused
before building). It records `schema`, `mode`, `releaseId` and
`electronAppDigest` (from the identity derived from the produced application,
the latter being the digest of the `app.asar` that carries the catalog),
`releaseChannel` (the packaged release policy's channel), `catalogSha256`,
`runtimeLockSha256`, `qualificationScope`, and `target` (`platform`, `arch`);
the catalog digests and scope are `null` for playback-only builds. The file is not part
of the receipt schema, so it sits under any checksum listing of
`desktop/artifacts/` rather than inside the receipt.
The assembler downloads checksum-pinned Python and FFmpeg inputs, builds the two
application wheels with a pinned host toolchain, installs locked dependencies,
and rebuilds the frontend using its npm lockfile. It refuses an existing output
directory: choose a fresh path for each assembly.

Local application wheels use a fixed ZIP-compatible build epoch. Assembly
removes uv installation-cache metadata and temporary local-wheel origin URLs;
the exact wheel hashes and source revision remain in `provenance.json`. Installed
RECORD files are regenerated against the resulting bytes before the complete
native inventory is sealed. Blank references to bytecode already omitted from
the pinned Python archive are captured before dependency installation and
removed only from an unchanged upstream RECORD; the original RECORD hash and
exact omitted paths remain in provenance. The pinned Windows archive also omits
three pip launchers still listed in its RECORD. Only the exact archive hash,
RECORD hash and three hashed rows curated in the native lock permit their
removal; provenance retains each original path, hash and size. These unshipped
pip commands are not restored or qualified by assembly. Other missing files
fail assembly.
On Linux and macOS, installed Python console
commands resolve the bundled interpreter relative to their installed location,
so relocation does not retain a temporary build-interpreter path. On native
Windows x64, every installed console launcher is checked against its owning
RECORD, declared callable, and the hash-pinned uv 0.12.8 console base. Named
resources are regenerated with a relative bundled Python path; code sections
and callable bodies are preserved. Assembly records the upstream revision,
base hash, transformation count, callable-body hashes and resulting launcher
hashes before rebuilding RECORD and inventory. Temporary original launcher
hashes are excluded because they contain disposable build paths; exact input
wheels and source revision remain recorded. GUI launchers are unsupported and
fail assembly. These
normalizations do not establish cross-platform or container reproducibility;
compare two fresh assemblies and report every modeled difference.

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
separately authenticated export-manifest verifier is configured. Without a
signing flag, packaging creates an explicitly unsigned private-test build and
never publishes anything. Create macOS artifacts on macOS.

For a private Developer ID macOS candidate, create the intended team's
Developer ID Application certificate and store notarization credentials in the
local keychain with `xcrun notarytool store-credentials`. The signing command
requires an exact publisher, Team ID, certificate SHA-1, certificate common
name, and keychain profile. The initial publisher, Team ID, and certificate SHA-1 are
pinned in source; certificate renewal or a team change requires a reviewed
source change. Keep the app-specific
password out of the source tree.

```sh
export SINGHOUSE_MAC_PUBLISHER='MICHAEL ALAN JONES'
export SINGHOUSE_MAC_TEAM_ID='25Y7U443K6'
export SINGHOUSE_MAC_IDENTITY='Developer ID Application: MICHAEL ALAN JONES (25Y7U443K6)'
export SINGHOUSE_MAC_CERT_SHA1='55FEEAA93960DD9E278519CA68338BACFC2A3617'
export SINGHOUSE_MAC_NOTARY_PROFILE='singhouse-notary'
npm --prefix desktop run package:first-installers -- --signed-macos-release --playback-only
```

The command verifies the assembled native payload, signs its Mach-O code with
hardened runtime and secure timestamps, refreshes native file hashes and
runtime identity, then signs and notarizes the application. It derives the
portable identity from the complete stapled application and writes the
immutable `.shapp.receipt.json` beside it. A constant marker sealed in the
app replaces the unsigned installer's embedded receipt. The app verifies the
Developer ID requirement, exact Team ID and certificate authority on first
launch before deriving its installed identity from the complete bundle. The
signed first installer rejects adjacent managed-slot metadata; signed macOS
managed-slot admission needs a separate authenticated design. The
command then builds, signs, notarizes, and staples a DMG; it also builds a ZIP
of the same stapled app. It compares both containers' extracted applications,
including executable permissions, with the portable application and writes
final DMG and ZIP checksums.
The bundle check authenticates the installed candidate against its pinned
signer; downloaded-artifact checksums and Gatekeeper remain the boundary for a
coherent replacement of the entire application.
Any failed check aborts the build. This path needs a macOS runner and an active
notary profile; it has not produced a release artifact until those checks pass.

Windows release signing is an explicit, fail-closed build mode. Run it on
Windows after assembling the `win32-x64` native payload. Install PowerShell 7
and the exact signing module first (`Install-Module TrustedSigning
-RequiredVersion 0.5.3 -Repository PSGallery -Scope CurrentUser`). CI provisions
and validates that module automatically:

```powershell
# First manual release: use the Azure user already granted the signer role.
az login
npm --prefix desktop run package:first-installers -- --signed-release --azure-cli-user --playback-only
```

The manual flag first requires a successful `az account show`, then constrains
DefaultAzureCredential to the Azure CLI identity. It does not ask for, accept,
or store the Azure account password.

The recommended CI path is the manually dispatched private Windows signing
workflow. Its job uses the `windows-signing` GitHub environment,
obtains a short-lived service-principal token through GitHub OIDC, and passes
`--azure-oidc`. No client secret is created or stored. Configure
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_SUBSCRIPTION_ID` as
environment secrets on the `windows-signing` environment itself,
not as repository or organization secrets. The build verifies that `az account show` is the expected
service-principal session and constrains DefaultAzureCredential to
AzureCliCredential. It requires exactly one `singhouse-signing` account in the
configured subscription, requires its normalized location to be `centralus`,
then queries its exact `singhouse` profile before building; that profile must
report `PublicTrust`.

Configure the Entra application as single-tenant. Its GitHub federated
credential must use issuer `https://token.actions.githubusercontent.com`,
audience `api://AzureADTokenExchange`, and the exact subject configured by
GitHub for this repository's `windows-signing` environment. Repositories using
immutable owner/repository IDs have a different subject from the default
repository-name format; inspect the repository OIDC subject configuration before
creating the federated credential. Do not substitute a name-only subject.
Restrict deployment branches to `main`. Configure required reviewers and branch
protection when supported by the account plan, and inspect those settings rather
than assuming they exist. Do not add access-token or OIDC-token output to
workflow diagnostics.

The dispatch form's `processing_mode` choice selects `playback-only` (the
default) or `processing-ready`; the latter requires a committed
`desktop/processing-catalogs/win32-x64.json`, and the workflow stops before
native assembly when that file is absent. The uploaded artifact is named
`windows-signed-<mode>-<commit>`. The choice reaches the build
script only as an environment variable mapped through a fixed list of flags.
The workflow only uploads a private Actions artifact. It does not publish a
release or download, deploy, or change update metadata. Its checksum inventory
is generated after signature verification and covers every file under
`desktop/artifacts/`, including `processing-mode.json`. Every action is referenced by an
immutable reviewed commit ID.

A client-secret service principal remains available as an operator-controlled
fallback. Omit both Azure CLI flags and provide the complete environment
credential. This mode constrains DefaultAzureCredential to
EnvironmentCredential:

```powershell
$env:AZURE_TENANT_ID = '<Microsoft Entra tenant ID>'
$env:AZURE_CLIENT_ID = '<signing application client ID>'
$env:AZURE_CLIENT_SECRET = '<signing application client secret>'
npm --prefix desktop run package:first-installers -- --signed-release --playback-only
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
uninstaller. Bundled native dependency executables retain their inventoried
upstream bytes and any existing signatures. CI installs into a disposable directory and verifies the installed
application and uninstaller with Authenticode and SignTool before uninstalling
the candidate. This does not establish browser-download reputation, physical
playback, or signed update/recovery qualification. Keep these values in the CI secret store; never add them to this
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
operator selects locally supplied, signed update metadata; singhouse retrieves
the exact target and rollback `.shapp` files named by it. An adjacent local
artifact is preferred. Only when that exact filename is absent may singhouse
use the artifact's signed HTTPS URL; unsafe local entries and other local read
failures are rejected rather than hidden by a network fallback. singhouse verifies the
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
quiesced. singhouse then creates and verifies a SQLite recovery point, persists
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
KARAOKE_NATIVE_PAYLOAD=/tmp/singhouse-native-arm64 npm --prefix desktop run package -- --playback-only
```

`--target` accepts `linux-x64`, `linux-arm64`, `darwin-arm64`, and `win32-x64`;
it defaults to the host. Cross-assembly does not execute target Python or
FFmpeg. Its provenance marks the result `UNTESTED`, requiring execution on the
target machine. Windows x64 assembly requires a native Windows x64 host and
the Win32 resource APIs; cross-staging Windows fails before fetching or building. `--cache <directory>` selects a build
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

Open Settings → Song processing… in the packaged application to review and
set up local processing or user-owned Modal. The setup flow shows download sizes
and installation notices before consent. Settings also provides library database
backup and restore; these backups do not include audio files. Update staging,
recovery diagnostics, and arbitrary manifest installation are not everyday menu
actions.

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
The build writes its pack to `<output>/pack` through the assembler below and
accepts the same delivery options (`--archive-base-url`, `--archive-part-size`,
`--archive-name`, `--blobs`, `--base-url`), validated the same way before any
build work starts. To package a separately constructed locked payload:

```sh
python3 desktop/build/assemble_processing.py --payload /path/to/locked-payload \
  --lock /path/to/processing-input-lock.json --output /path/to/new-pack
```

By default the output is archive form: `manifest.json`, `input-lock.json`, and
`archive/<name>.001`, `.002`, … The archive format (`concat-gzip-v1`) has no
internal paths or headers. Its uncompressed stream is every locked file's bytes
concatenated in manifest order. That stream is gzip-compressed deterministically
(one member, fixed header, zero timestamp, no file name) and split into
consecutive parts of at most `--archive-part-size` bytes (default 1900 MiB;
release assets are limited to 2 GiB). The manifest lists each part's URL,
SHA-256, and size; files carry no URLs. The default part name is
`singhouse-processing-<platform>-<arch>-<accelerator>-<lock hash prefix>.pack.gz`
(override it with `--archive-name`). Part URLs default to `file://` URLs for the local `archive/`
directory; `--archive-base-url` declares the directory the parts will be
published to. The assembler accepts an `https://` or local `file://` base URL
that ends in `/` and has no credentials, query, or fragment. Identical inputs
and options produce byte-identical output with the same Python and zlib. The
assembler writes into a temporary sibling directory and renames it into place
only when the whole pack is complete; a failed run leaves no output (never
parts without a manifest), and an existing output directory is refused.

`--from-pack` re-packages an existing pack without its original payload, for
example to convert a per-file pack or to re-host an archive pack under a new
base URL or part size:

```sh
python3 desktop/build/assemble_processing.py --from-pack /path/to/pack \
  --archive-base-url https://example.org/releases/download/tag/ --output /path/to/new-pack
```

The input pack's manifest must be bound to its `input-lock.json` and match a
fresh assembly of that lock. For a per-file input, every blob's size and
SHA-256 are re-verified as it streams into the archive. For an archive input,
the parts are read from the pack's own `archive/` directory by the file name
that ends each part URL (URLs are never fetched). Before anything is written,
every part's size and SHA-256 are checked and the whole stream is decoded with
the installer's rules (plain gzip header, one member, matching trailer, nothing
after the last file), checking every file's size and SHA-256 against the lock.
It is decoded and checked again while the new parts are written. Either way the
output is identical to assembling the payload directly with the same archive
options.
The older per-file form (`blobs/` named by content hash, one URL per file) is
still available with `--blobs`, or with `--base-url` to declare an explicit
HTTPS blob directory. Blob and archive options cannot be combined. The
assembler does not upload anything. Each package must name its retained license
or notice files; the manifest embeds and hash-binds the complete input lock and
rejects missing notice files. File hashes establish correspondence
with a selected manifest; they do not establish publisher identity.
Installation additionally requires the input-lock hash to appear in the
application-shipped `processing-locks.json`; a manifest cannot trust its own lock.

For archive-form packs, installation retrieves each part into
`processing/staging/<name>.archive/`, outside the pack tree. It resumes partial
parts with HTTP ranges and checks each part's size and SHA-256. Then it reads
the parts again (checking their SHA-256 again), streams them through one
decompressor, and writes the files in manifest order, checking every file's
size and SHA-256 as it is written. The part sizes fix the stream's length, so
the header, deflate data, and eight-byte trailer are located by offset alone,
however the parts or reads split them. Any of these rejects the archive: a
header with optional fields, a short stream, a bad gzip trailer, a second gzip
member, or any byte beyond the last file. A rejected archive is never
activated, on that attempt or any later one while the same parts are the
source: its parts and everything extracted from them are deleted, so a retry
retrieves and checks them again. Only a stream that passes every check writes
`processing/staging/<name>.stream`, a marker that the staged files came from a
validated stream; staged files are reused without decoding again only when
that marker is present and every file still verifies. Parts are removed only
after the marker is written and every staged file verifies. After an
interruption, a retry does not fetch parts again that are already complete,
and does not rewrite staged files that already verify, but decodes the whole
stream again unless the marker is present. The free-space check requires the
parts not yet retrieved, plus the full uncompressed pack, plus 64 MiB; setup's
preflight reserves all parts (as if none were retrieved) plus the
uncompressed pack plus 64 MiB, and reports the compressed part total as the
runtime's transfer size and the uncompressed total separately.

Part URLs are checked at three layers. The runtime manifest validator accepts
`https://` and local `file://` URLs (no credentials or fragment). The
application's setup catalog accepts only `https://` URLs without credentials,
query, or fragment, plus local `file://` URLs in explicit private-test mode.
The assembler's default is local `file://` URLs, so a pack meant for the setup
catalog is assembled with an `https://` `--archive-base-url`. Every runtime
pack retrieval over HTTPS, per-file and archive alike, follows redirects only
to HTTPS on `github.com`, `objects.githubusercontent.com`, or
`release-assets.githubusercontent.com` (default port, no credentials, at most
five hops); the first request goes to the manifest URL. Each retry starts again
from the manifest URL, because signed redirect targets expire.

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
A runtime pack's identity is the SHA-256 of its manifest. Its pack and staging
directories are named `<name>`, the first 16 hex characters of that identity, to
keep deep runtime trees within Windows path limits; pointers, status, and the
backend's admission check use the full identity, and every manifest is checked
against it. A directory under the shortened name whose manifest does not match
is rejected and left unchanged. Packs installed under the earlier full-length
name still load, verify, and reinstall in place; staging left under that name is
discarded and retrieved again. Model cache directories keep the full identity.
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

Open Settings → Song processing… to install the processing pack. The setup flow
shows download sizes and upstream sources before consent. Installation progress
includes a cancel action, and retry resumes verified partial transfers.
Insufficient disk space, interrupted transfers, and checksum failures preserve
the prior cache. Queued songs wait for the processing pack to become available.
Prepared playback remains available while setting up models.

`models.json` defines the upstream allowlist and offline cache contract.
Only model IDs and complete immutable inventories defined by the shipped policy
are accepted. The policy includes the pinned Heart inventory below;
a user-created manifest cannot declare another model ready. Each non-executable model file
must exactly match its policy's upstream revision or content-digest identity,
HTTPS URL, size and SHA-256. Legacy fixed release assets use the full file digest
as their identity; changed upstream bytes fail verification. singhouse does not
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

The packaged application smoke harness supports Linux, Windows and macOS, using a
temporary user-data directory. Point it at the packaged application's executable:

```sh
xvfb-run -a node desktop/test/packaged-smoke.mjs --executable desktop/artifacts/linux-unpacked/Singhouse
```

On Windows, run `node desktop/test/packaged-smoke.mjs --executable "C:\path\to\Singhouse.exe"`.
The same command can test the installed executable after a test installation.

The installed macOS bundle is `Singhouse.app`, with executable
`Singhouse.app/Contents/MacOS/Singhouse`; Windows installs `Singhouse.exe`.
On macOS, pass that inner executable to `--executable`.

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

Use the host's lyrics-display controls to open and manage the display. Opening the projector requests prevention of
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
# Song processing setup

The installed desktop opens a welcome flow with an option to go straight to
the library. “Set up song processing” reopens it from the library; the menu entry
is Settings → Song processing…. Download consent is separate from choosing local processing. Setup must
verify a compatible processing runtime, both separation models, and Heart
together before reporting local processing ready. A saved wizard step is never
readiness evidence. Verified model files are reused when expanding a cache.
The optional lyrics step keeps LRCLIB off until explicitly enabled. It explains
that lookups send track metadata to LRCLIB, never audio; the choice can be changed
by reopening setup. Installation notices start collapsed with a summary, while
component sources, terms, and exact sizes remain available before the install action.
Back navigation returns to the welcome screen.

Installation, verification, restart prompts, and completion appear as a compact
nonmodal status panel over the library. Queued processing songs remain durable
and unclaimed until the backend verifies the required runtime and models. This
includes waiting across an application restart; saved wizard navigation cannot
release jobs. Cancellation preserves resumable installation files and queued songs.
Restart is refused while processing, installation, playback, or a projector window
is active; queued jobs held by the readiness gate are safe to retain across restart.

Release artifacts must supply a qualified runtime catalog before automatic
local setup becomes available. Playback remains usable without it. The advanced
manifest installer remains a support tool. A complete local model folder may
be selected in setup: its layout and sizes are inspected before consent, then
its contents are verified during cancellable installation. Missing or changed
files never trigger a silent model download. The separate processing runtime
may still require downloading; this is shown in the installation plan.

### Advisory processing speed estimate

The wizard offers a deliberately broad **planning heuristic**, not a benchmark
or qualification result, for one three-minute track after setup and queue wait.
The default workflow runs the four-checkpoint Demucs `mdx_extra` ensemble,
`mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956`, and HeartTranscriptor
(Whisper-derived, batch size one, including word timing). It does not assume
newer upstream inference optimizations are in the pinned processing pack.

Research checked 2026-10-02:

- [Demucs upstream documentation](https://github.com/facebookresearch/demucs#memory-requirements-for-gpu-acceleration)
  gives a generic CPU baseline around 1.5 times track duration. This does not
  measure our four-checkpoint ensemble or the complete workflow.
- [Karaoke-maker's own model comparison](https://github.com/CarlosGabrielMoralesUmasi/karaoke-maker#choosing-a-model)
  reports 10–20 minutes for karaoke Mel-RoFormer on CPU. Its hardware and input
  duration are unspecified, so this is an order-of-magnitude reference only.
- [HeartTranscriptor's model card](https://huggingface.co/HeartMuLa/HeartTranscriptor-oss)
  identifies the Whisper-based implementation but gives no full-workflow speed
  benchmark. Transcription, timing, loading, and retries need additional time.
- [Audio Separator's upstream documentation](https://github.com/nomadkaraoke/python-audio-separator#-apple-silicon-macos-sonoma-with-m1-or-newer-coreml-and-mps-acceleration)
  documents MPS execution, but does not establish a timing multiplier for our
  pinned pack. CUDA reports and newer optimized implementations are not used
  as Metal measurements.

These references motivate a **20–90 minute** total planning band, allowing
substantial room beyond the separation reference for the ensemble, transcription,
loading, and timing. **45–180 minutes** is a conservative lower-resource band
when fewer than eight logical processors or less than 16 GiB total RAM are
observed. Those thresholds and band endpoints are product heuristics, not
measured hardware requirements, confidence intervals, or an upper bound.
More RAM and more logical processors do not guarantee faster inference. Model
retries, dense vocals, thermal throttling, competing applications, memory
pressure, and slow storage can push times outside these ranges.

The three-position bar says Slower / Moderate / Faster. Current unbenchmarked
CPU and Metal targets use only Slower or Moderate; Faster is not awarded merely
because a graphics adapter is present. Metal conservatively shares the CPU
bands until matching end-to-end measurements justify a speedup. The selected,
validated pack supplies the execution device. Windows/Linux CPU packs therefore
remain CPU estimates even on NVIDIA-equipped machines. Unknown accelerators,
missing hardware observations, mismatched targets, incomplete or extended model sets, and
blocked installation plans display no numeric range. The estimate applies only to
the default three-model workflow from the selected validated catalog; an installed
runtime with a different manifest from that catalog receives no estimate. Existing measured memory
checks and runtime attestation remain authoritative and independent of this UI.

Hardware details report observations rather than inferred processing support.
Unknown graphics memory remains unknown, and Apple silicon unified memory is
not labeled dedicated VRAM. Optional release-owned memory evidence supplies
separate RAM/VRAM recommendations, measured peaks plus 25% headroom. Fresh
installation is blocked when required capacity cannot be verified or is too
small. Low currently available RAM produces a warning; prepared-media playback
remains available.

Desktop Modal setup saves credentials with operating-system encryption and
performs a bounded, explicit metadata check using the pinned client. No audio
upload, function invocation, deployment, or resource creation occurs in that
check. Account access and protocol compatibility are separate from inference
qualification. Cloud processing remains disabled pending a qualified deployment
contract. The backend integration passes consented settings over a private
startup pipe and pins the selected account, environment, and function version.
Connection changes require a guarded restart; saving settings does not activate
them. Credentials are never returned to the UI or passed as process arguments
or environment variables. Linux requires a supported system keyring; no
plaintext fallback exists. Forgetting local credentials works even when the
keyring cannot decrypt them; it does not revoke remote tokens or stop cloud jobs.

Release builds may supply one catalog per target,
`desktop/processing-catalogs/<platform>-<arch>.json` (for example
`win32-x64.json` or `darwin-arm64.json`), as part of the application's verified
inventory; package them with `--processing-ready`, which places only that
target's file in the application as `processing-catalog.json`. Commit the
catalog before native assembly: all packaging requires a clean checkout whose
`HEAD` matches the commit recorded in the native provenance, so a catalog added
after assembly cannot be packaged. The setup engine never accepts a catalog
from the renderer or saved preferences. Its schema is:

- `schema: 1`, `runtime`: the complete processing manifest accepted by the
  current application's processing lock policy.
- `qualification`: `passed`, `scope`, `runtimeLockSha256`, `platform`, `arch`,
  `evidenceReference`, and `accelerator`, matching that exact runtime. Populate
  only from actual evidence. `scope` is required and states what `passed`
  covers:
  - `full`: the complete release qualification passed for this runtime and
    target. Accepted by builds on any release channel.
  - `private-smoke`: only a single-song real-processing smoke test passed. This
    is not release qualification. It is accepted only when the build's release
    policy (`release.json`) has `channel` exactly `private-test`; every other or
    missing channel rejects the catalog. The setup wizard tells the user, before
    consent, that this build's local processing passed a smoke test only.
- `models`: entries with `id` and `terms: [{label, url}]` for every model in the
  combined installation. Terms URLs are HTTPS source references, not claims
  about checkpoint licensing.

The catalog must cover Heart, Demucs, and the default second-pass separator.
Runtime artifacts need retrievable distribution URLs; models retain their
fixed direct-upstream URLs and hashes. A catalog alone does not establish
representative memory minima, performance, model quality, or clean-machine
qualification. Those checks remain necessary before release.

Prepare the catalog with `node desktop/build/setup_catalog.mjs --runtime
runtime.json --qualification qualification.json --terms terms.json --identity
identity.json --output desktop/processing-catalogs/<platform>-<arch>.json`
(create the `desktop/processing-catalogs/` directory first; the tool never
replaces an existing file). Commit the file exactly as written: packaging
accepts only the generator's canonical bytes. Inputs are explicit;
the tool never manufactures qualification. `--release release.json` names the
release policy whose channel the catalog is checked against (default
`desktop/release.json`); the tool refuses to write a `private-smoke` catalog
for any channel other than `private-test`. Packaging re-checks the catalog
against the release policy actually packaged. `--memory memory.json` adds measured
memory evidence. Production catalogs reject local runtime URLs. The explicit
`--private-test-local-sources` option is only for validating private test inputs;
the application does not accept those as a production download catalog.

An optional release-owned `desktop/modal-contract.json` is copied into the
verified native payload. Its schema is `1`, with an opaque `protocolReference`,
the full `protocolSha256`, `requiredTags` containing both values, and `functions`
mapping separation to `separate_<protocolSha256>` and transcription to
`transcribe_<protocolSha256>`. The metadata checker resolves these exact names
at the user-selected deployment version. Current app tags alone cannot certify
an older function version. This is a declared protocol check, not evidence of
model quality or successful inference; no passing contract is supplied by
default.

To enable desktop routing, the release-owned Modal contract also requires
`qualification: {passed: true, protocolSha256, evidenceReference}`, backed by
actual inference qualification of that protocol. Consent for both uploads and
resource usage and a successful startup metadata check are also required.
Without these, local playback remains available and cloud processing stays off.

### AppImage library notices and source inputs

Linux x64 first-installer packaging requires `SINGHOUSE_APPIMAGE_SOURCE_INPUTS`
to name a prepared local input directory. For each entry in
`third-party/appimage/inventory.json` under `sources`, retrieve its exact public
`url`, save it under its relative `path` inside that directory, and verify its
`sha256`. Keep all 18 files: six DSC records plus upstream original archives and
Debian changes. Packaging performs these checks again and never downloads or
installs source inputs automatically. DSC signatures are explicitly unverified;
a matching hash is not described as signature verification.

Run `SINGHOUSE_APPIMAGE_SOURCE_INPUTS=/absolute/prepared-inputs npm run
package:first-installers -- --playback-only` (or `-- --processing-ready`)
from `desktop/` with the other required native build inputs prepared. The build
copies exact notices into the application, checks the completed AppImage library
bytes before creating a receipt, and writes a deterministic uncompressed
`artifacts/Singhouse-appimage-12.0.1-library-sources.tar` plus `.sha256`. The archive
has fixed file order, timestamps, ownership and modes and includes an internal
`SHA256SUMS` and the original `third-party/appimage/REBUILD.txt` recipe (stored
as `REBUILD.txt` in the archive). The upstream extraction scripts are not
included; inventory metadata retains only their public URLs and hashes. The
source packages contain their own Debian build rules. The recipe describes
extraction and rebuilding, without asserting a reproducible build or resolving
corresponding-source adequacy. Existing artifact names are never overwritten. Preserve the source
artifact alongside the installer for release review; this command does not
publish either artifact or promise a public source-download location.

The pinned legacy toolset adds these six libraries only for Linux x64. For
ARM64 it adds none: packaging checks an explicit empty library inventory,
rejects unexpected `usr/lib` entries, and does not require the x64 source inputs.
Other AppImage toolsets require a new verified inventory before use. Run
`node --test test/appimage_notices.test.mjs` for notice and source-artifact checks.


### Packaged processing smoke

The test-only `test/packaged-processing-smoke.mjs` launches an exact packaged
candidate, submits one new licensed excerpt, observes separation, verifies Heart
word timings and aligned decoded stems, and shuts the application down while
recording its process tree. It runs on Linux, Windows and macOS. Run it from a
checkout with desktop test dependencies installed (`npm ci` in `desktop/`).

Pass the platform's executable to `--executable`:

- Windows: `C:\candidate\Singhouse.exe`
- macOS: `/path/to/Singhouse.app/Contents/MacOS/Singhouse`
- Linux: the unpacked application's executable, for example
  `desktop/artifacts/linux-unpacked/Singhouse`

Every mode takes `--audio`, a new `--output` directory and an optional
`--timeout-seconds` (default 3600). The output directory must not exist, and
its parent must be a physical directory with no symbolic link or junction in
the path; on macOS, use `/private/tmp` rather than `/tmp`. Pass physical paths
everywhere. The harness never deletes evidence.

Linux needs a display. Pass `DISPLAY` (with `XAUTHORITY` if your server
requires it), or `WAYLAND_DISPLAY` together with `XDG_SESSION_TYPE`, or run
under `xvfb-run -a`. A Wayland variable without its pair is not passed to the
application. Electron's sandbox stays enabled: if `chrome-sandbox` is not
setuid root and the kernel restricts unprivileged user namespaces, the
application cannot start. The harness has no option to disable the sandbox or
certificate verification; fix the host instead.

#### Modes

| Mode | Selected by | Installs | Model retrieval consent |
|---|---|---|---|
| Retained setup | `--runtime-manifest`, `--retained-profile`, `--expected-source-commit` | Nothing | Not applicable |
| Wizard | `--wizard` and `--expected-runtime-lock-sha256` | Through the first-launch setup screens | The application's own consent screen |

Wizard mode uses a new profile inside the evidence directory. Legacy manifest
installation and resume modes are retired; use the catalog shipped in the
candidate and the wizard. For example, on Linux:

```sh
xvfb-run -a node desktop/test/packaged-processing-smoke.mjs \
  --executable desktop/artifacts/linux-unpacked/Singhouse \
  --wizard \
  --expected-runtime-lock-sha256 FULL_64_HEX_RUNTIME_LOCK \
  --audio /licensed-excerpt.wav \
  --output /evidence/new-attempt
```

#### Candidate identity

Evidence records the candidate as a tuple of SHA-256 hashes: the executable,
the application archive (`app.asar`), the native manifest and provenance, and
the release receipt when the candidate carries one (otherwise `null`). On Linux
the executable is the stock Electron binary and is identical across builds, so
the executable hash alone never identifies a candidate. Evidence also records a
SHA-256 for each harness file it loads, the harness platform and architecture,
and the application's own reported platform and architecture. The application's
architecture is authoritative; if it differs from the Node architecture running
the harness (for example an x64 Node under translation on Apple silicon), the
run fails before processing.

The candidate tuple is hashed again after every relaunch and after the final
shutdown; any change fails the run. Existing resume and upgrade evidence remains
preserved, but new attempts must use wizard or retained-setup mode.

#### Retained setup

Retained mode submits a new excerpt using an existing isolated qualification
profile without installing or retrieving runtime or model files:

```powershell
node desktop/test/packaged-processing-smoke.mjs `
  --executable "C:\candidate\Singhouse.exe" `
  --runtime-manifest "C:\verified-pack\manifest.json" `
  --audio "C:\licensed-excerpt.wav" `
  --output "C:\new-attempt-evidence" `
  --retained-profile "C:\prior-qualification\profile" `
  --expected-source-commit FULL_40_HEX_SOURCE_COMMIT `
  --timeout-seconds 7200
```

The same options run on macOS and Linux with the executables listed above. A
signed macOS bundle keeps its release receipt outside the bundle, so this
retained mode refuses it.

Use an unused evidence directory outside the retained profile; the two may not
contain each other, compared case-insensitively on macOS and Windows. This mode
excludes `--resume`, executable-upgrade options and `--download-models`.
Candidate native provenance and release receipt must agree with the full
expected source commit. The application's normal startup verification must
admit the requested runtime and installed models. Missing readiness fails;
there is no installation or repair fallback and no activation-pointer
transplant.

Before Electron launches, bundled Python reads SQLite in immutable read-only mode
and rejects unfinished songs and every nonterminal job, including orphaned queued
or expired running jobs. A nonempty WAL is a blocker: the test never checkpoints
or repairs the database. Close other users of this isolated profile first. The
profile must contain at most 500 songs. The harness submits one new upload with a durable intent marker, requires a
new song/job with no preexisting stem directory, and checks retained song/current-job
records remain unchanged. After shutdown, on successful and failed attempts, a
read-only audit compares hashes of every original song and job row. Missing or
changed rows, or inability to audit, fails qualification. It does not delete the new song or old data. An ambiguous
submission is a failed attempt; retain its evidence and do not treat it as a resume.

This is fresh local pipeline evidence with retained setup, not clean installation,
model installation, corpus accuracy, representative memory or physical-output
qualification.

#### Wizard

Wizard mode drives the real first-launch setup screens on a fresh profile:
welcome, choosing local processing, the installation review, and consent. It
then follows setup status to completion and presses the restart control:

```sh
node desktop/test/packaged-processing-smoke.mjs \
  --executable /path/to/Singhouse.app/Contents/MacOS/Singhouse \
  --audio /private/tmp/licensed-excerpt.wav \
  --output /private/tmp/wizard-evidence \
  --wizard \
  --expected-runtime-lock-sha256 FULL_64_HEX_RUNTIME_LOCK
```

Wizard mode excludes `--runtime-manifest`, `--download-models`,
`--retained-profile`, `--resume`, executable upgrades and
`--expected-source-commit`. The catalog shipped inside the candidate must name
the expected runtime lock, be marked qualified for that lock, and target this
platform and architecture. The installation plan shown in the wizard must offer
exactly that catalog runtime (size and sources) and the three default models
from their upstream sources. The harness also recomputes the plan identity the
application shows the consent screen for, from the catalog runtime and the
shipped `models.json` policy, the same way the application does. The offered
components and memory requirements are taken from the plan itself, because the
application's hardware observation cannot be repeated independently. Evidence
records the plan and its identity, the consent screen text and its hash, every
status transition, observed time per setup phase, the `models.json` hash, the
installed model set identity, every application launch, and the Playwright
version.

The harness identifies the dialog, its current step and its controls through
the dialog's `data-testid` hooks and `data-step` attribute, not through copy.
Wizard mode therefore requires a candidate that carries these hooks: if the
setup dialog that opens at launch has no `data-testid="onboarding-dialog"` or no
`data-step`, the run stops at once with `This candidate predates the wizard test
hooks; wizard mode cannot drive it`. Heading text is read only to tell a
cancelled setup and a failed verification from other error screens; an error
screen whose heading matches none of them is recorded as `error-unclassified`.
Controls are
judged and pressed only after the setup dialog reports `aria-busy="false"`; the
choice, review and retry screens render before their own preflight finishes. Before consent nothing is installed, so the harness may
read the plan then (only while the wizard is idle). After relaunch it never
calls the plan read, which would itself re-verify the installed runtime. Setup
must leave its previous state within 60 seconds of the install click, or the run
fails with `setup did not start`.

Setup reports runtime transfer, hash verification and the runtime self-test as
one phase. The evidence splits them at the last observed progress change, which
is an observation bound, not a measurement. The harness handles both runtime
delivery forms in the catalog. Individually delivered files have no unpack
phase. An archive-delivered runtime is retrieved as its parts and then unpacked:
transfer size, consent size and sources come from the parts, the installed size
from the file records, and setup progress names each part during retrieval and
each file during unpacking. Unpacking is timed from its first to its last
observed progress change (`unpackObservedMs`, `postUnpackObservedMs`), again an
observation bound; the self-test after unpacking reports no progress of its own.

The application exits when its restart control is pressed. The harness records
the application's relaunch request instead of letting it start an instance the
harness does not own, then launches the same executable with the same profile
itself (`restart.initiatedBy` is `application-ui` once the request is recorded).
After relaunch the setup dialog is expected to reopen on its checking step while
the application re-verifies the installed runtime. The checking step is never
treated as settled. The harness waits up to 240 seconds for the dialog to become
idle and settle, recording every distinct step, status, status phase and
heading with timestamps. It passes only if the check is observed (the wizard or
setup status shows `checking` at least once, the only observable sign that the
restored setup checkpoint is exercised), the dialog settles on the ready screen while setup
status is `ready`, the active runtime is the one the plan promised with the
expected lock and target, and the installed model set is the one the policy
selects. The wizard and setup status are polled about every 250 ms; the check
is missed only if it completes entirely before the harness's first poll after
relaunch, and a missed check fails the run. If a cancelled or generic error
screen or status appears at any point, the run fails with `A verified restart
was presented as an interrupted setup (product defect)`; a build that restores
the finished-setup checkpoint as an interrupted setup fails here. If the wizard
reports that local processing could not be verified, the run fails with
`Post-restart verification failed`: when setup status reported a verification
error the evidence says the installed runtime or models did not pass live
verification; when status was still checking, or could not be read, it says
only that the check did not complete; with any other status it says the wizard
showed a failed verification while the setup service reported that status, a
disagreement that is still a failed run. An unclassified error screen counts as
that failure only with a verification error in status. Otherwise, if setup
status is an error outside verification or is cancelled, it fails as
`presented as an interrupted setup`, and with any other status it fails as an
error screen the harness cannot classify. A settled restart or progress screen,
or a dialog still checking at the timeout, also fails. The same processing and
shutdown checks as the other modes follow.

The evidence fields are named for what they prove: wizard evidence carries
`expectedRuntimeLockSha256` from the command line and `runtimeLockSha256` only
after the installed runtime is verified; `consent.modelRetrieval` is set when the
consent screen is accepted; `harnessUsedAdvancedRoute` is always `false`; and
`restart.clickError` is recorded only if no relaunch request was recorded.

Two recovery exercises are available; choose at most one:

- `--interrupt-runtime-retrieval` cancels setup from the wizard's own controls
  once at least 5% of the runtime has transferred, records the partial bytes
  kept on disk, and retries with "Review setup and retry". Start the pack server
  with `--throttle-bytes-per-second` so the 5% point is observable.
- `--expect-retrieval-failure-then-retry` expects the pack server's
  `--fail-after-bytes` failure: setup reaches its error screen during runtime
  retrieval and is retried the same way.

Either retry must offer the same plan. Pass the pack server's standard output,
saved to a file, as `--pack-server-log <file>` to classify the retry from the
server's own request records: `resumed` requires the first request for that file
after the stop to carry `Range: bytes=N-` (N > 0), receive 206 and be logged as
`complete` with exactly the file size minus N bytes served, and no later request
for that file to fetch it from zero; `restarted` means it was requested from the
start, either first or after a resume. Without the log, or without such a
request, the retry is `unproven`; polling alone never proves a resume. For an
archive-delivered runtime the file is the interrupted part: when setup stops,
the harness records the staged size of every part
(`<name>.archive/part-NNN.partial`), and the kept bytes are those of the part the
retry is judged on (with an injected failure and the log, the part the server
failed, which may differ from the last part setup progress named). With the
log, an archive retry passes only when some but not all of that part was kept
(0 < kept bytes < part size) and the retry resumed it from exactly the kept
bytes as above; a refetch from zero or a resume from another byte fails the run.
If the kept bytes are unknown, if nothing was kept (retrieving the part from
zero is then correct), or if the part was already complete when the stop took
effect, the run fails as `Unproven`: the harness could not show a resume, which
says nothing against the product. For individual files the classification is
recorded as evidence only. A catalog whose archive parts share a file name under
different paths is refused by the harness, because setup progress names each
part by its file name alone.

#### Private test sources

The test-only `test/local-pack-server.mjs` serves the files in one operator
directory over HTTPS on `127.0.0.1` for a private test catalog. Loopback HTTPS
URLs already pass production catalog validation; the catalog tool's
`--private-test-local-sources` admits `file:` URLs only and is not needed here.
A candidate whose catalog names a loopback, private-range or non-default-port
runtime source is recorded with `wizard.catalog.privateTestSource: true` and a
limitation. A catalog qualification without `scope: "full"` also adds a
limitation; `qualification.scope` is recorded when present.

The server serves only flat file names from that directory (never dot-files),
never follows symbolic links, accepts only `GET` and `HEAD`, and supports
`Range: bytes=N-` for resume tests. It refuses to start if the certificate or
key resolves inside the served directory. It logs one JSON line per request with
its arrival (`started`) and completion (`time`); `--help` prints the options.

```sh
node desktop/test/local-pack-server.mjs --directory /verified-pack/files \
  --port 8443 --cert /keys/server.pem --key /keys/server-key.pem \
  [--fail-after-bytes N] [--throttle-bytes-per-second N] > /evidence-logs/pack-server.log
```

`--fail-after-bytes` truncates the first GET response longer than N bytes, once;
a short file, a short range or a `HEAD` does not consume it. The application
does not retry internally, so this drives setup to its error screen; use it
with `--expect-retrieval-failure-then-retry`. `--throttle-bytes-per-second`
(1024 to 1073741824) paces each response body; use it with
`--interrupt-runtime-retrieval`. `--redirect-via` is manual-only: it answers
with redirects, the application refuses redirects for runtime files, and no
harness mode uses it.

To let the packaged application trust a private test certificate authority,
pass `--extra-ca-cert /absolute/ca.pem` to the processing smoke harness. The
path must have no symbolic link in any component (on macOS use `/private/tmp`,
not `/tmp`). The file must be a regular file containing only PEM certificates,
each a CA certificate (basic constraints `CA:TRUE`), and no private key. The
harness copies it into the evidence directory as a read-only `extra-ca.pem`,
records its hash and each certificate's subject and SHA-256 fingerprint, and
passes the copy to the application as `NODE_EXTRA_CA_CERTS`, which the
application's setup downloads use. The variable is inherited by the
application's child processes (`trust.inheritedByChildren: true`), and it takes
effect only while Electron's `NodeOptions` fuse is enabled, as it is in current
builds. Inherited trust variables are never passed through. The operating
system trust store is not changed, and certificate verification is never
disabled.

#### Limits

The runner requires Electron's host window; it is not a headless backend test.
Modal, external lyric lookup and external correction remain disabled. None of
these modes is clean-machine, corpus accuracy, representative memory or
physical-output qualification. Process ownership is traced by parent lineage
from the first observation at close time: the application process and every
process whose parent is owned and that started no earlier. A descendant that was
reparented before that first observation is not seen. Process-tree evidence
lists every owned descendant still running after shutdown. Linux zombie
processes (exited, not yet reaped) are not counted as running; they are listed
separately as `zombies`. The harness signals only the application process it
launched, and only after a failed shutdown.
