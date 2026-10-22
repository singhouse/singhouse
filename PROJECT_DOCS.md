# Singhouse — Architecture & Project Reference

## 1. Overview

Singhouse is a self-hosted karaoke suite for your own music library. It combines two-pass GPU stem separation, word-level lyric transcription and CTC acoustic re-timing, a real-time Web Audio player with per-voice mixing and key shift, a clean-room canvas stage renderer with a popout projector window, a host-managed queue, and a flat play history.

### Key Capabilities

| Feature | Implementation |
|---|---|
| **Two-Pass Stem Separation** | Pass 1 (`Demucs mdx_extra`) splits vocals vs. instrumental; Pass 2 (`mel_band_roformer`) splits lead vs. backing vocals. Standard stems per song: `instrumental`, `lead_vocals`, `backing_vocals`, and `karaoke` (instrumental + backing). |
| **Per-Voice Stems** | Derived dynamically from filenames on disk (`stem_layout.py`). Beyond the standard four stems, numbered and named files (`vocal_<id>`, `lead_vocals_<N>`, …) automatically become ordered mixer lanes. |
| **Lyric Sets** | Each song supports multiple lyric sets (`reference`, `transcription`, `manual`, `lrclib`), with one active set driving playback. |
| **Word-Level Sync & CTC Acoustic Re-Timing** | Bundled `lyricsync` library: RMS-VAD segmentation + `HeartTranscriptor` (music-tuned Whisper) or `faster-whisper` transcription, aligned to plain reference lyrics via Needleman-Wunsch (Enhanced Levenshtein + Double Metaphone), then refined against vocal audio using multi-model CTC force-alignment (`HuBERT-Large`, `wav2vec2-Large`, `HuBERT-XLarge`, and an optional phoneme voter). |
| **Opt-in Lyrics Lookup** | Optional `lrclib.net` integration (`KARAOKE_LRCLIB=1`, **off by default**). Fetches plain reference text for acoustic alignment; third-party LRC timestamps are ignored during upload so community offset drift never degrades word timing. |
| **Real-Time Web Audio Mixer** | Independent gain and mute/solo lanes per stem plus **±12 semitone pitch shift** at constant tempo via a Signalsmith Stretch WebAssembly AudioWorklet. |
| **Stage Renderer & Popout** | Pure-function 640×360 virtual coordinate canvas renderer (`frontend/src/stage/`) with a `BroadcastChannel` watchdog-protected `window.open` projector window. |
| **Host Queue & History** | `BasicManualQueue` (append, drag-reorder, remove, clear, dequeue-on-play) and `PlayHistory` with snapshotted metadata and configurable retention (default 30 days). |
| **CD+G / MP3+G Import & Export** | Single-song `.cdg` or MP3+G `.zip` import (rendered to bounded H.264 playback media) and on-demand MP3+G / `.cdg` export. |

---

## 2. System Architecture

```
┌──────────────┐    ┌───────────────┐    ┌────────────────────┐
│   Frontend   │    │    Backend    │    │     Job Worker     │
│  (Vue 3 SPA) │◄──►│   (FastAPI)   │◄──►│ (in-process async) │
│              │    │               │    │                    │
│ • HostShell  │    │ • REST API    │    │ • ingest pipeline  │
│ • Stage +    │    │ • Static SPA  │    │ • transcribe /     │
│   popout     │    │ • Plugins     │    │   realign / page   │
└──────────────┘    └───────┬───────┘    │ • resplit / import │
                            │            └────────────────────┘
                     ┌──────▼──────┐
                     │   SQLite    │
                     │ (aiosqlite, │
                     │  WAL mode)  │
                     └─────────────┘
```

### Repository Layout

```
singhouse/
├── backend/
│   ├── pyproject.toml                 # Package `karaoke-backend`; console scripts `kb-db`, …
│   ├── modal_app.py / modal_llm.py    # Optional user-owned Modal GPU & vLLM deploy scripts
│   ├── src/karaoke_backend/
│   │   ├── main.py                    # FastAPI app + lifespan bootstrap
│   │   ├── database.py                # Async SQLAlchemy engine + session factory
│   │   ├── cli.py                     # `kb-db`: status / upgrade / stamp-baseline / repair
│   │   ├── plugins.py                 # Entry-point plugin discovery + registry
│   │   ├── stem_layout.py             # Filesystem-derived stem model (per-voice lanes)
│   │   ├── db/                        # Startup schema bootstrap, Alembic config, SQLite pragmas
│   │   ├── migrations/                # Alembic revision chain (c0001 baseline → head)
│   │   ├── api/                       # REST routers (songs, separate, lyrics_sets, queue, history, …)
│   │   ├── jobs/                      # Durable SQLite job queue (queue, worker, ingest, resplit, …)
│   │   ├── workers/                   # Separation dispatch, word_sync_worker, lyrics_worker, caches
│   │   ├── models/                    # SQLAlchemy models (song, queue, history, settings)
│   │   └── export/                    # CD+G rasterizer and MP3+G zip exporter
│   └── tests/                         # Backend pytest suite
├── frontend/
│   ├── src/
│   │   ├── api/client.js              # Axios client + per-area API namespaces
│   │   ├── router/index.js            # Routes: /, lyrics editor, /unlock
│   │   ├── stores/                    # Pinia: songs, queue, history, player, features, hostSettings, session
│   │   ├── components/                # AudioPlayer, MixerPopover, QueuePanel, LyricsEditor, ScreenStage, …
│   │   ├── stage/                     # Pure-function canvas stage renderer + visualizers
│   │   ├── composables/               # useAudioEngine (Web Audio + worklet), useLyricsWindow (popout)
│   │   ├── editor/                    # Word-timing editor internals
│   │   └── views/                     # HostShell, LyricsEditorView, UnlockView
│   ├── scripts/deploy.sh              # Named-assembly build + rsync publish to backend/static/
│   └── tests/                         # Vitest unit tests + stage golden harness
├── lyricsync/                         # Standalone word-sync & CTC alignment library (MIT / AGPL)
├── desktop/                           # Electron shell, native Python/FFmpeg assembly, qualification
├── docs/                              # User, operator, and release qualification guides
└── tools/                             # Repo verification scripts (SPDX headers, core neutrality)
```

### Data Flow: Import, Separation & Alignment

```
POST /api/separate (audio upload)
    ↓
Creates `Song` row + `queued` ingest `Job` row in SQLite
    ↓
JobWorker claims job (atomic UPDATE + heartbeat lease) and runs phases:
  1. separating:       Demucs Pass 1 → RoFormer Pass 2 → FFmpeg mix (instrumental + karaoke)
                       → atomic `.separation-complete` marker written
  2. fetching_lyrics:  Uses pasted reference lyrics, or opt-in lrclib plain text if enabled
  3. transcribing:     RMS-VAD + HeartTranscriptor / faster-whisper (cached on disk)
  4. aligning:         Needleman-Wunsch alignment → CTC Acoustic Fusion re-timing
                       → saves `word_sync_json` on a `LyricsSet` row
    ↓
Job status: queued → running → done/failed (`phase` tracks current step)
```

* **Phase Resumability:** Interrupted jobs survive server restarts. If a running job's lease expires, `JobWorker` re-claims it and resumes from the last incomplete phase (checking for `.separation-complete` and transcription cache artifacts on disk before redoing work).
* **Failed Upload Retention:** If an ingest job fails (e.g., missing GPU backend), the source file in `uploads/` is retained so `POST /api/songs/:id/retry` can replay the exact job payload without re-uploading. Deleting the failed song deletes the retained upload.

---

## 3. Backend Internals

See [`backend/README.md`](backend/README.md) for the complete REST API payload reference, `curl` examples, and setup instructions.

### 3.1 Database & Schema Bootstrap (`db/bootstrap.py`, `cli.py`)

* **Engine:** Async SQLAlchemy + `aiosqlite` in WAL mode with foreign keys enforced and a 5s busy timeout.
* **Migrations:** Managed strictly by Alembic (`c0001` → head). At startup, `bootstrap.py` inspects the database:
  * **Fresh DB:** Upgrades directly to head.
  * **Legacy Pre-Alembic DB:** Verifies columns match the frozen `c0001` baseline, stamps `c0001`, and upgrades to head.
  * **Managed DB:** Upgrades to head (unless `KARAOKE_DB_AUTO_MIGRATE=false`, which fails fast if the DB is not already at head).
* **Operator CLI (`kb-db`):** `kb-db status` (read-only), `kb-db upgrade --yes`, `kb-db stamp-baseline --yes`, `kb-db repair --yes`.

### 3.2 Durable Job Queue (`jobs/queue.py`, `jobs/worker.py`)

The `jobs` table *is* the queue. Workers claim jobs with an atomic SQLite `UPDATE`, hold a time-boxed lease (`KARAOKE_JOB_LEASE_SECONDS`, default 180s) renewed via heartbeat, and guard every progress update with `claimed_by` so a stale worker raises `LeaseLost` rather than overwriting another worker's state. Concurrency defaults to `1` (`KARAOKE_JOB_CONCURRENCY=1`) to prevent GPU OOMs.

Each job kind declares a lane on its `JobSpec`, and the worker fills each lane up to its own budget, FIFO within the lane. The **processing** lane (separation, transcription, alignment, LLM re-paging) is capped by `KARAOKE_JOB_CONCURRENCY`. The **fast** lane (`catalog_import`, `video_import`, `cdg_import` — work that only adopts media that already exists) is capped by `KARAOKE_FAST_JOB_CONCURRENCY` (default `2`), so a quick catalog import is never queued behind generations. Kinds default to the processing lane, including extension kinds registered with `register_job_kind`; an extension opts a kind in with `lane="fast"`. Kinds held for desktop setup stay unclaimable in both lanes.

Job kinds dispatched via `jobs/registry.py`:

* `ingest` — Full pipeline (`separating` → `fetching_lyrics` → `transcribing` → `aligning`).
* `retranscribe` / `realign` — Re-runs transcription or alignment against a song's stems (`realign` reuses the cached raw transcript).
* `page` — Runs optional OpenAI-compatible LLM page structuring over an existing set and saves a new `LyricsSet`.
* `resplit` — Re-runs Pass-2 lead/backing vocal separation with a different model, staging outputs atomically and clearing the stale transcription cache.
* `catalog_import` — Imports tracks from an installed catalog provider plugin (such as Plex).

### 3.3 Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `sqlite+aiosqlite:///<cwd>/karaoke.db` | SQLite database connection string |
| `KARAOKE_DB_AUTO_MIGRATE` | `true` | Set `false` to refuse startup unless DB is already at Alembic head |
| `STEM_FORMAT` | `mp3` | Output format for new stems (`mp3` = 256 kbps CBR; `flac` = 16-bit FLAC). Existing `.mp3`/`.flac`/`.wav` stems remain readable |
| `UPLOADS_DIR` / `STEMS_DIR` | `uploads/` / `stems/` | Staging and output directories |
| `MAX_FILE_SIZE_MB` | `500` | Upload file size ceiling (MB) |
| `BASE_URL` | `http://localhost:8000` | Base URL for stem links (set to LAN IP for multi-device access) |
| `CORS_ORIGINS` | localhost dev origins | Comma-separated allowed CORS origins |
| `SESSION_SECRET` / `SESSION_SECRET_FILE` | `.session_secret` (0600) | Cookie signing secret (auto-generated beside DB if unset) |
| `KARAOKE_GATE_PASSWORD` / `_HASH` | unset | Optional shared host password (hash takes precedence; unset = open LAN access) |
| `KARAOKE_LRCLIB` | `off` | Opt-in (`1`) lrclib.net lyrics lookup |
| `KARAOKE_PLEX_URL` / `_TOKEN` / `_PATH_MAP` / `_LYRICS` | unset / `off` | Plex integration settings (see [`docs/plex.md`](docs/plex.md)) |
| `KARAOKE_JOB_CONCURRENCY` | `1` | Simultaneous processing-lane jobs (GPU OOM guard) |
| `KARAOKE_FAST_JOB_CONCURRENCY` | `2` | Simultaneous fast-lane jobs (imports that adopt existing media), budgeted separately |
| `KARAOKE_JOB_LEASE_SECONDS` | `180` | Worker lease timeout before a stalled job is re-claimed |
| `KARAOKE_SEPARATOR` | unset | Optional separator plugin name |
| `KARAOKE_MODAL` / `KARAOKE_MODAL_APP` | `off` / `karaoke-gpu` | Offload GPU work to your own Modal account (see [`docs/modal.md`](docs/modal.md)) |
| `KARAOKE_DEMUCS_PYTHON` | `.venv-demucs/bin/python` | Python interpreter for local separation & CTC alignment |
| `DEMUCS_MODEL` / `KARAOKE_MODEL` / `KARAOKE_MODEL_DIR` | `mdx_extra` / RoFormer ckpt / — | Separation model selection |
| `KARAOKE_HEART_CKPT` | `<cwd>/ckpt/HeartTranscriptor-oss` | Local directory for the HeartTranscriptor checkpoint |
| `KARAOKE_ACOUSTIC_ALIGNMENT` / `_CPU` / `_TIMEOUT` | `on` / `off` / `3600` | CTC acoustic word re-timing controls |
| `KARAOKE_LLM_BASE_URL` / `_MODEL` / `_TIMEOUT` / `_API_KEY` / `_API_KEY_FILE` | `off` | Optional OpenAI-compatible endpoint for lyric page grouping |
| `KARAOKE_PROVIDERS` / `KARAOKE_PROVIDERS_DIR` | unset | Plugin allowlist and extra plugin search path |

---

## 4. Frontend Internals

See [`frontend/README.md`](frontend/README.md) for frontend development commands and build details.

* **State (`stores/`):** Pinia stores for `songs`, `queue`, `history`, `player`, `features`, `hostSettings`, and `session`.
* **Audio Engine (`composables/useAudioEngine.js`):** Routes each stem `<audio>` element through a Web Audio gain graph. When key shift is non-zero (±12 semitones), inserts a Signalsmith Stretch WebAssembly `AudioWorklet` node per stem with automatic latency compensation.
* **Stage Renderer (`stage/`):** Pure functional canvas architecture (`frame.mjs` computes a frame descriptor in a fixed 640×360 stage coordinate space; `adapter.mjs` normalizes v1/v2 word-sync JSON; `layout.mjs` handles line breaks/font sizing; `draw.mjs` paints the 2D canvas).
* **Popout Projector (`composables/useLyricsWindow.js`):** Opens a same-origin `window.open` projector window driven by the host page. Uses a `BroadcastChannel` heartbeat and an injected watchdog script to automatically close orphaned popouts if the host tab reloads or closes.

---

## 5. Deployment (Server / Source Mode)

### Systemd User Service

```ini
# ~/.config/systemd/user/karaoke-backend.service
[Unit]
Description=Singhouse Backend
After=default.target

[Service]
Type=simple
ExecStart=/path/to/repo/backend/.venv/bin/python -m uvicorn karaoke_backend.main:app --host 0.0.0.0 --port 8000
WorkingDirectory=/path/to/repo/backend
Environment=BASE_URL=http://192.168.1.42:8000

[Install]
WantedBy=default.target
```

(Note: `WorkingDirectory` must be `backend/` so default `DATABASE_URL` and `static/` paths resolve properly. Back up `karaoke.db` using `sqlite3 karaoke.db ".backup <dest>"` because it runs in WAL mode.)

### Frontend Assembly Deploy (`frontend/scripts/deploy.sh`)

```bash
cd frontend && npm run deploy
```

Builds a named, sourcemap-free assembly under `frontend/deploy/<UTC-stamp>-g<sha>[-dirty]-<mode>/`, validates the target path, mirrors it to `../backend/static/` via `rsync --delete`, and writes provenance metadata to `backend/deploy-manifest.json` (kept beside `static/`, never served to browsers). The three newest assemblies are retained for quick rollback.
