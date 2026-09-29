# Native release qualification

This directory records repeatable evidence for a Singhouse desktop release.
It does not turn an automated smoke test, virtual machine, or remote desktop
session into physical audio, display, GPU, or clean-machine evidence.

Start a candidate by copying `matrix.template.json` to an evidence directory
outside the source checkout. Keep evidence with the immutable candidate
artifacts and receipts:

```sh
python3 desktop/qualification/qualify.py inventory \
  --candidate-revision "$(git rev-parse HEAD)" \
  --output evidence/machine.json
python3 desktop/qualification/qualify.py validate \
  desktop/qualification/matrix.template.json
```

The matrix uses four result values:

- `passed`: the named check ran on the named candidate and its evidence is
  attached.
- `failed`: the check ran and did not meet its acceptance condition.
- `untested`: no qualifying run exists.
- `blocked`: a run was attempted but a concrete external prerequisite was
  unavailable. The blocker must be recorded.

Never mark a row passed from source inspection alone when the row requires an
installer, inference, audible comparison, physical output, or interruption.
Synthetic media is useful for deterministic plumbing tests and must be labeled
as synthetic evidence.

## Candidate evidence layout

Use one directory per exact source revision and artifact set:

```text
evidence/
  candidate.json
  checksums.txt
  machines/<machine-id>.json
  results/<matrix-row-id>.json
  logs/<matrix-row-id>.log
```

Each result should identify the source revision, artifact SHA-256, machine
inventory, command or manual procedure, start/end time, result, and evidence
files. Do not include model weights, user media, lyrics, secrets, tokens, or
private application data.

## Automated commands

Run the repository suites before native tests:

```sh
npm --prefix desktop test
python3 -m unittest discover -s desktop/test -p 'test_*.py'
python3 -m pytest backend/tests
npm --prefix frontend test -- --run
npm --prefix frontend run build
```

On Linux, exercise the source shell with an available display or Xvfb:

```sh
xvfb-run -a node desktop/test/smoke.mjs
```

For a real packaged Linux executable, use an empty isolated application-data
root through the existing packaged smoke runner:

```sh
xvfb-run -a node desktop/test/packaged-smoke.mjs \
  --executable /absolute/path/to/the/candidate/executable
```

That packaged smoke uses generated media. It proves neither audible output nor
external-display behavior. Real processing qualification additionally needs
the fixed private evaluation corpus, locally available model files, and the
exact candidate runtime pack. Do not fetch new weights merely to run this
harness.

The release matrix and operator procedures are described in
`docs/release-qualification.md`.

## Real packaged local processing smoke

`desktop/test/packaged-processing-smoke.mjs` runs the actual packaged Windows
executable in a new isolated profile. Unlike the synthetic prepared
video smoke, this **runs real local separation and Heart transcription** on an
operator-supplied licensed vocal excerpt (at most 120 seconds and 64 MiB).
It uses the existing advanced Processing menu to install an explicitly supplied
trusted runtime manifest and all three model sets from the packaged model
policy, then restarts and submits the audio through the normal ingest API.
The application performs its normal lock, hash, probe and activation checks.
No processing catalog qualification is created or bypassed.

Run only when the runtime installation, upstream model retrieval and local
inference are authorized. The existing advanced route retrieves models from
upstream; `--download-models` is mandatory and explicitly consents to this
multi-gigabyte transfer. It does not enable Modal or external correction.
A combined offline folder picker is not exposed by that application route;
`--model-folder` is rejected rather than copying cache activation pointers.

From the checkout with desktop test dependencies installed, on Windows:

```powershell
node desktop/test/packaged-processing-smoke.mjs `
  --executable "C:\path\to\Singhouse.exe" `
  --runtime-manifest "C:\path\to\verified-pack\manifest.json" `
  --audio "C:\path\to\licensed-vocal-excerpt.wav" `
  --output "C:\path\to\new-processing-evidence" `
  --download-models --timeout-seconds 3600
```

For an installation interrupted by a host or VM reboot, rerun the same command
with `--resume` and the original output directory. Resume verifies the exact
executable, input and runtime-manifest hashes and the original physical isolated
profile path. It supports interrupted installation only, before any inference
submission; the profile must still have an empty library. Close the previous
application first; the packaged application's single-instance ownership is
required. The original `evidence.json` is preserved unchanged; a unique
`resume-<UUID>` subdirectory contains the new evidence, model manifest and
outputs, and links the original evidence and all earlier resume attempts by SHA-256.
Every prior attempt is checked; malformed evidence or any attempted inference
blocks resume, even if the library was later emptied. An inference-start marker
is flushed to disk before submission so an interrupted response cannot be
silently retried. A prior `running` status
means no outcome was recorded, never a pass. Runtime reuse requires the current
backend to admit the exact runtime; otherwise the advanced install route runs
again. Model installation always runs through the real route, which verifies
and reuses already downloaded cache files. Restart, readiness, real inference
and all output assertions still run in full. Retain all attempt directories.

Without `--resume`, the output directory must not exist; its parent must exist. It retains the
isolated application profile, four playback WAVs, the model manifest and
`evidence.json`. Keep this directory private: the profile contains normal
application session state and machine-generated lyrics. The evidence JSON
records exact input/executable/runtime/model-manifest and packaged model-policy
file hashes, installation and processing wall
times, job phase transitions, readiness, output hashes/format/decode checks,
and transcription count/timing checks without copying transcript text. The
harness strips inherited service configuration, requires external lyric lookup
to be off, verifies Modal is unselected, and requests both external correction
and paging off. The ingest API selects Heart internally; output metadata must
confirm Heart. No cloud deployment or cloud inference is performed.

The default overall deadline is one hour, configurable from 60 to 14,400
seconds. Individual startup, API, media checks and shutdown also have bounds.
On failure, the harness requests installation cancellation and closes its own
application; Windows forced shutdown targets only that application process
tree. Retained failure evidence does not constitute a pass.

A pass demonstrates the selected packaged application's real local pipeline on
that excerpt and machine. It does **not** establish the 20-song accuracy
criteria, listening quality, representative RAM/VRAM minimums, clean-machine
compatibility, physical audio/display behavior or complete release
qualification. Record those separately; never turn this smoke result into an
unsupported catalog attestation.
