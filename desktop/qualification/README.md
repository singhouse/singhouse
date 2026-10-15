# Desktop Release Qualification Harness

This directory holds the tooling and schemas for recording repeatable release qualification evidence across target machines.

## 1. Evidence Directory & Matrix Validation

Create one evidence directory outside the source checkout per candidate commit and artifact set:

```text
evidence/
  candidate.json
  checksums.txt
  machines/<machine-id>.json
  results/<matrix-row-id>.json
  logs/<matrix-row-id>.log
```

Record machine inventory and validate your qualification matrix (`passed`, `failed`, `untested`, or `blocked`):

```sh
python3 desktop/qualification/qualify.py inventory \
  --candidate-revision "$(git rev-parse HEAD)" \
  --output evidence/machine.json

python3 desktop/qualification/qualify.py validate \
  desktop/qualification/matrix.template.json
```

(Never include model weights, user audio, lyrics, secrets, or session tokens in evidence files.)

---

## 2. Automated Repository & Packaged Smoke Suites

Run the unit and integration suites before native packaging tests:

```sh
npm --prefix desktop test
python3 -m unittest discover -s desktop/test -p 'test_*.py'
python3 -m pytest backend/tests
npm --prefix frontend test -- --run
npm --prefix frontend run build
```

Run the synthetic packaged-media smoke harness against the unpacked or installed candidate executable:

```sh
# Linux (use xvfb-run on headless machines)
xvfb-run -a node desktop/test/packaged-smoke.mjs \
  --executable desktop/artifacts/linux-unpacked/Singhouse

# macOS
node desktop/test/packaged-smoke.mjs \
  --executable /Applications/Singhouse.app/Contents/MacOS/Singhouse

# Windows
node desktop/test/packaged-smoke.mjs \
  --executable "C:\path\to\Singhouse.exe"
```

---

## 3. Real Packaged Processing Smoke (`packaged-processing-smoke.mjs`)

Unlike `packaged-smoke.mjs` (which tests synthetic video playback), `desktop/test/packaged-processing-smoke.mjs` launches a packaged candidate, runs **real local Demucs + RoFormer separation and Heart transcription** on a short licensed vocal excerpt (≤ 120s, ≤ 64 MiB), verifies decoded stem alignment and word timings, and audits process-tree shutdown.

* **Path rules:** Pass physical paths with no symlinks or junctions (on macOS, use `/private/tmp` instead of `/tmp`). `--output` must point to a non-existent directory whose parent exists.
* **Linux display & sandbox:** Requires `DISPLAY` (or `WAYLAND_DISPLAY` + `XDG_SESSION_TYPE`), or `xvfb-run -a`. Electron's sandbox remains strictly enabled.

### Mode A: First-Launch Wizard Mode (`--wizard`)

Drives the real first-launch onboarding UI on a fresh profile (`data-testid="onboarding-dialog"`), verifies the embedded `processing-catalog.json` plan and model terms against `--expected-runtime-lock-sha256`, accepts download consent, waits for runtime/model installation and `python-functional-v1` self-test, triggers the restart control, confirms post-restart verification settles on `ready`, and processes the test audio:

```sh
xvfb-run -a node desktop/test/packaged-processing-smoke.mjs \
  --executable desktop/artifacts/linux-unpacked/Singhouse \
  --wizard \
  --expected-runtime-lock-sha256 <FULL_64_HEX_RUNTIME_LOCK> \
  --audio /path/to/licensed-excerpt.wav \
  --output /path/to/new-wizard-evidence \
  --timeout-seconds 3600
```

#### Optional Retrieval Interruption & Retry Checks (Wizard Mode)

Pair Wizard Mode with `desktop/test/local-pack-server.mjs` (which serves local pack files over `https://127.0.0.1` with HTTP `Range` support and JSON request logging) and `--extra-ca-cert /absolute/ca.pem`:

```sh
node desktop/test/local-pack-server.mjs \
  --directory /verified-pack/files --port 8443 \
  --cert /keys/server.pem --key /keys/server-key.pem \
  --throttle-bytes-per-second 1048576 > /path/to/pack-server.log
```

* **`--interrupt-runtime-retrieval --pack-server-log <log>`:** Pauses download via the wizard UI once ≥ 5% has transferred, verifies partial `.partial` bytes on disk, resumes, and verifies `206 Partial Content` range continuation in the server log.
* **`--expect-retrieval-failure-then-retry --pack-server-log <log>`:** Pairs with `--fail-after-bytes N` on `local-pack-server.mjs` to force a mid-stream transfer failure, verifies the wizard error state, clicks retry, and confirms HTTP range resumption.

### Mode B: Retained-Profile Mode (`--retained-profile`)

Submits a new audio excerpt against an existing isolated qualification profile (up to 500 songs, empty WAL, zero non-terminal jobs) without re-downloading runtimes or models, auditing SQLite row hashes before and after to verify existing songs are untouched:

```powershell
node desktop/test/packaged-processing-smoke.mjs `
  --executable "C:\candidate\Singhouse.exe" `
  --runtime-manifest "C:\verified-pack\manifest.json" `
  --audio "C:\licensed-excerpt.wav" `
  --output "C:\new-attempt-evidence" `
  --retained-profile "C:\prior-qualification\profile" `
  --expected-source-commit <FULL_40_HEX_SOURCE_COMMIT> `
  --timeout-seconds 7200
```

### Mode C: Advanced Menu Install & Reboot Resume (`--download-models` / `--resume`)

Installs an explicit `--runtime-manifest` and upstream models via the Processing menu. If interrupted by a host reboot before inference starts, re-run with `--resume` (and optionally `--upgrade-from-executable-sha256 <hash>` when qualifying an application upgrade over a retained profile):

```powershell
node desktop/test/packaged-processing-smoke.mjs `
  --executable "C:\path\to\Singhouse.exe" `
  --runtime-manifest "C:\path\to\verified-pack\manifest.json" `
  --audio "C:\path\to\licensed-vocal-excerpt.wav" `
  --output "C:\path\to\new-processing-evidence" `
  --download-models --timeout-seconds 3600
```

---

## 4. Private Local Acceptance Supervisor (`local_acceptance.py`)

Supervises an unpacked `private-test` native build against an existing durable profile and opens an authenticated browser session via a one-time loopback cookie handoff:

```sh
python desktop/qualification/local_acceptance.py \
  --native /path/to/candidate/native \
  --profile /path/to/private-test-profile \
  --processing /path/to/selected-processing --processing-id <FULL_PROCESSING_ID> \
  --processing-probe /path/to/actual-attestation.json \
  --models /path/to/selected-models --models-id <FULL_MODEL_ID> \
  --evidence /path/to/private-evidence.json --open-browser
```
