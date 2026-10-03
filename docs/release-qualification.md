# Desktop release qualification

Every result applies to one exact source revision and artifact checksum. A
passing source test does not qualify a rebuilt installer. A remote session can
establish installation and workflow facts, but only an operator at the machine
can establish audible output, physical display behavior, or device removal.

Use `desktop/qualification/matrix.template.json` as the machine-readable
record. Attach the inventory produced by `desktop/qualification/qualify.py` and
the immutable release receipt for each artifact.

## Platform matrix

The initial targets are Windows 11 25H2 x86-64, macOS 14 or newer on Apple
silicon, Ubuntu 24.04 x86-64, Ubuntu 24.04 ARM64, and the announced Asahi show
system. Record the exact OS build, CPU, RAM, GPU and driver, display topology,
audio device, filesystem, desktop/session type, kernel, and available disk.

For each target, begin from a machine or user profile with no developer cache,
system Python dependency, existing singhouse data, runtime packs, or models.
Retain the original downloaded installer so its operating-system warning and
checksum can be tested. Cover install, first launch, second-instance refusal,
normal restart, offline restart, upgrade, interrupted upgrade, recovery,
uninstall with data retained, reinstall, and explicit data removal as distinct
steps.

## End-to-end workflow

Use the fixed private 20-song evaluation set. It must cover repetition, duets,
quiet vocals, dense mixes, and long songs. Do not copy the corpus, lyrics, or
derived stems into source control or public evidence.

For every advertised model/device route:

1. Import user-owned media and complete both separation passes.
2. Confirm every expected stem is readable, aligned, non-silent, and not
   truncated. Compare audibly with the reference output.
3. Transcribe with Heart using the same model and settings as the reference.
4. Compare corpus WER and p95 word-start timing. Candidate WER may regress by
   no more than 2 percentage points and p95 timing by no more than 100 ms.
   Review every new whole-section omission individually.
5. Edit lyrics and timing, save, restart, queue, play, seek, pause/resume, and
   finish playback.
6. Record preparation duration and measured peak RAM/VRAM. Derive the minimum
   as the measured peak plus 25%, then verify on representative hardware.
7. Restart with networking disabled and repeat local inference with already
   installed runtimes/models. Cloud processing requires connectivity and must
   never start silently.

Runtime import/probe success is supporting evidence. It is not real inference,
quality comparison, audible comparison, or memory qualification.

## Failure and recovery

At controlled points interrupt runtime and model retrieval, runtime activation,
each processing pass, application retrieval, extraction, database backup,
selection, first target startup, and presentation acknowledgement. Also induce
a bounded insufficient-memory failure. After every case verify:

- prepared media and the last working application remain usable;
- the job is retryable or has an explicit recoverable state;
- incomplete files are never published as complete stems or transcription;
- the prior runtime/model remains selected after failed replacement;
- the database and application rollback belong to the same signed update pair;
- an offline restart preserves the selected local runtime/model;
- replayed or same-sequence update metadata is rejected.

Linux AppImage qualification additionally needs native proof that the exact
outer AppImage is bound to the active mount. Substitute the file and mount
inputs during anchor creation, rotation, launch, and standalone recovery. Each
case must fail closed. Inner receipt verification alone is insufficient.

## Physical show

Run four continuous hours at 1080p on every launch target, including the actual
ARM64 show machine. Use prepared media without AI packs. Exercise host minimize,
workspace switching, projector close/reopen and physical reconnect, fullscreen,
audio output selection and physical disconnect/reconnect, pause/resume, seek,
track transitions, and offline restart. Record application logs and wall-clock
times for every dropout or freeze. A virtual display, Xvfb, RDP, VNC, or an
automated canvas assertion does not satisfy this row.

## Release decision

A release candidate is reviewable only when all artifacts, receipts,
checksums, source and license inventories, unsigned-installer observations,
matrix results, failures, and explicit untested rows are attached. Unsigned
installer approval changes only platform-signing policy; it does not waive
artifact integrity, authenticated updates, quality, recovery, physical-show,
license, source, or publication gates.
