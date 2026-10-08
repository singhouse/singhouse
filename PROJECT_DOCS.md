# singhouse — Project Documentation

## 1. Overview

singhouse is a self-hosted karaoke suite for your own music library. It
combines GPU-accelerated stem separation, word-level lyric transcription and
sync, a real-time web player with vocal/instrumental mixing and key shift, a
canvas stage renderer with a popout projector window, a simple host-managed
queue, and a flat play history.

### Key Features

| Feature | Description |
|---------|-------------|
| **Stem Separation** | Two-pass pipeline: Demucs (mdx_extra) splits vocals vs instrumental; mel_band_roformer splits lead vs backing vocals. Standard output per song: `instrumental`, `lead_vocals`, `backing_vocals`, `karaoke` (instrumental + backing) stem files |
| **Per-Voice Stems** | The stem model is derived from filenames on disk (`stem_layout.py`); beyond the standard four, numbered and named per-voice files (`vocal_<id>`, `lead_vocals_<N>`, …) become ordered mixer lanes |
| **Lyric Sets** | Each song holds multiple lyric sets (reference / transcription / manual / lookup), one active; full CRUD plus transcribe and realign endpoints |
| **Word-Level Sync** | The bundled `lyricsync` library: Whisper transcription (faster-whisper, or an optional fine-tuned lyrics model you supply) + Needleman-Wunsch alignment with Double Metaphone phonetic matching. Produces per-word timestamps for karaoke highlighting |
| **LRC-Anchored Hybrid Sync** | LRC line timestamps as anchors, Whisper word timestamps within each window, reference lyrics text always displayed, interpolation for unmatched words |
| **Lyrics Lookup** | Optional lrclib.net provider, **opt-in and off by default** (`KARAOKE_LRCLIB=1`). With it off, nothing contacts lrclib.net and pasted lyrics are the reference path |
| **Real-Time Mixer** | Web Audio mixer with a gain lane per stem (including every per-voice lane), mute/solo-style control, and key shift: ±12 semitone pitch transposition without tempo change via a time-stretch worklet |
| **Stage Renderer + Popout** | A clean-room canvas renderer (`frontend/src/stage/`) draws the lyric display; the projector surface is a popout window (`window.open`) driven from the host page — same JS context, fullscreen-capable |
| **Host Queue** | BasicManualQueue: a manually ordered "who sings next" list referencing songs in your library. Append, reorder, remove, clear; dequeue-on-play |
| **Play History** | Flat, newest-first record of each ▶ Sing with title/artist/singer snapshots; retention is a plain setting (default 30 days, 0 = keep forever) |
| **Plugin Seams** | Entry-point discovered provider/extension plugins (catalog providers, lyrics providers, separator backends) loaded at startup |

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | FastAPI, SQLAlchemy (async), aiosqlite (SQLite), Alembic |
| **Frontend** | Vue 3, Pinia, Vue Router, Vite, TailwindCSS, Web Audio API |
| **Stem Separation** | Demucs (mdx_extra) + mel_band_roformer via python-audio-separator |
| **Word Sync** | `lyricsync` (bundled library): faster-whisper (CTranslate2) or a fine-tuned Whisper transcriber |
| **Lyrics Source** | Pasted text; optional lrclib.net (opt-in, off by default) |

---

## 2. Architecture

```
┌──────────────┐    ┌───────────────┐    ┌────────────────────┐
│   Frontend   │    │    Backend    │    │     Job worker     │
│  (Vue 3 SPA) │◄──►│   (FastAPI)   │◄──►│ (in-process async) │
│              │    │               │    │                    │
│ • HostShell  │    │ • REST API    │    │ • ingest pipeline  │
│ • Stage +    │    │ • Static SPA  │    │ • transcribe /     │
│   popout     │    │ • Plugins     │    │   realign          │
└──────────────┘    └───────────────┘    │ • catalog import   │
                           │             └────────────────────┘
                    ┌──────▼──────┐
                    │   SQLite    │
                    │ (aiosqlite, │
                    │  WAL mode)  │
                    └─────────────┘
```

### Project Structure

```
singhouse/
├── backend/
│   ├── pyproject.toml                 # Package `karaoke-backend`; console scripts kb-db, …
│   ├── alembic.ini                    # Dev-only convenience for `alembic revision`
│   ├── src/karaoke_backend/
│   │   ├── main.py                    # App entry point (karaoke_backend.main:app)
│   │   ├── database.py                # Async engine + session factory
│   │   ├── branding.py                # Product-name constants (identifiers stay neutral)
│   │   ├── cli.py                     # kb-db: status / upgrade / stamp-baseline / repair
│   │   ├── plugins.py                 # Entry-point plugin discovery + registry
│   │   ├── ratelimit.py               # Gate/unlock rate limiting
│   │   ├── stem_layout.py             # Filesystem-derived stem model (per-voice lanes)
│   │   ├── db/
│   │   │   ├── bootstrap.py           # Startup schema bootstrap (fresh/adopt/managed)
│   │   │   ├── migrate.py             # Programmatic Alembic config
│   │   │   └── sqlite.py              # WAL / foreign-key pragmas
│   │   ├── migrations/                # Alembic chain (c0001 baseline → head)
│   │   ├── api/
│   │   │   ├── songs.py               # Song CRUD + stem streaming
│   │   │   ├── separate.py            # Upload → queued ingest job; job polling
│   │   │   ├── lyrics.py              # Opt-in lyrics lookup
│   │   │   ├── lyrics_sets.py         # Per-song lyric-set CRUD + transcribe/realign
│   │   │   ├── queue.py               # BasicManualQueue
│   │   │   ├── history.py             # Flat play history + retention setting
│   │   │   ├── catalog.py             # Provider listing (plugin catalog surface)
│   │   │   ├── features.py            # Operator-gated capability flags
│   │   │   ├── gate.py                # Single-host gate (optional shared password)
│   │   │   ├── identity.py            # Identity seam + /api/auth/config
│   │   │   └── providers/             # Provider/extension router collection
│   │   ├── jobs/
│   │   │   ├── queue.py               # Durable SQLite job queue (claims, leases)
│   │   │   ├── worker.py              # JobWorker: claim → run → heartbeat
│   │   │   ├── ingest.py              # separation → lyrics → transcribe → align
│   │   │   ├── transcribe.py          # re-transcribe / realign handlers
│   │   │   ├── catalog_import.py      # provider-driven import handler
│   │   │   └── registry.py            # kind → handler dispatch
│   │   ├── workers/                   # modal_worker (separation dispatch),
│   │   │   │                          #   lyrics_worker, word_sync_worker,
│   │   │   └── …                      #   transcription cache, LLM paging
│   │   ├── models/                    # song.py, queue.py, history.py, settings.py
│   │   └── ops/                       # Operator scripts (kb-seed-lyrics-reference)
│   └── tests/                         # pytest suite
├── frontend/
│   ├── src/
│   │   ├── api/client.js              # Axios client + per-area API namespaces
│   │   ├── router/index.js            # Routes: /, lyrics editor, /unlock
│   │   ├── stores/                    # songs, queue, history, player, features,
│   │   │                              #   hostSettings, session
│   │   ├── components/                # AudioPlayer, MixerPopover, QueuePanel,
│   │   │                              #   HistoryModal, LyricsEditor, SongList,
│   │   │                              #   SongPicker, UploadZone, ScreenStage, …
│   │   ├── stage/                     # Canvas stage renderer (see 4.5)
│   │   ├── composables/               # useAudioEngine, useLyricsWindow (popout), …
│   │   ├── editor/                    # Word-timing editor internals
│   │   └── views/                     # HostShell, LyricsEditorView, UnlockView
│   ├── scripts/deploy.sh              # Named-assembly build + publish (see 6)
│   └── tests/                         # vitest units + stage tests + golden harness
├── lyricsync/                         # Bundled word-sync library (own package + tests)
├── docs/                              # Design notes and specs
└── tools/                             # Repo maintenance scripts
```

### Data Flow: Import + Stem Separation

```
User imports an audio file → POST /api/separate
    ↓
Song row + a `queued` ingest Job row are created (the jobs table IS the queue)
    ↓
JobWorker claims the job (guarded UPDATE + lease) and runs the ingest pipeline:
  Phase separating:       Demucs pass 1 (vocals/drums/bass/other),
                          mel_band_roformer pass 2 (lead vs backing),
                          ffmpeg mixes → instrumental + karaoke stems,
                          `.separation-complete` marker written atomically
  Phase fetching_lyrics:  pasted lyrics, or opt-in lookup when enabled
  Phase transcribing:     lyricsync transcription of the vocals stem (cached)
  Phase aligning:         alignment → word-sync JSON on a lyric set
    ↓
Job status: queued → running → done/failed; `phase` carries the UI progress
    ↓
Frontend polls GET /api/jobs/{id} → updates progress UI
```

Interrupted jobs are not lost: `queued` rows survive a restart, and a
`running` job whose lease lapses is re-claimed and **resumes by phase** —
each phase checks for its artifact on disk before redoing work.

### Data Flow: Word-Level Sync

```
Ingest runs it automatically; POST /api/songs/{id}/lyrics/transcribe or
/realign re-runs it on demand (202 + job)
    ↓
lyricsync SyncPipeline:
  1. RMS-VAD segments the vocals stem into ~30s chunks
  2. Whisper transcribes each segment with word timestamps
  3. Reference lyrics: the song's reference/manual set, or lookup if enabled
  4. Needleman-Wunsch aligns Whisper words → reference words
  5. LRC-anchored hybrid: LRC line timestamps anchor, Whisper fills per-word timing
  6. Word-sync JSON saved on a LyricsSet row (source: transcription)
    ↓
Frontend loads the active lyric set → stage renderer displays word-level sync
```

---

## 3. Backend Details

### 3.1 Entry Point (`backend/src/karaoke_backend/main.py`)

- **Framework**: FastAPI with an async lifespan.
- **Startup (lifespan)**: ensures upload/stem/static directories exist; runs
  the schema bootstrap in a worker thread (fail-fast — see 3.2); sweeps
  legacy pre-queue job rows to `failed`; discovers and registers plugins
  (`plugins.load_all()`); mounts provider-owned routers at a recorded anchor
  so their literal paths take precedence over convertor routes; starts the
  `JobWorker`; awaits registered lifespan startup hooks. Shutdown stops the
  worker, then unwinds shutdown hooks in reverse order.
- **Middleware** (outermost last): Starlette `SessionMiddleware` (signed
  httponly cookie; the secret auto-persists to a `.session_secret` file next
  to the database when `SESSION_SECRET` is unset), CORS
  (`CORS_ORIGINS`), and a pure-ASGI security-headers wrapper that stamps
  `Referrer-Policy: no-referrer` on every response.
- **Routers mounted** (in order): extension routers from installed plugins;
  `separate` (`POST /api/separate`, `GET /api/jobs/{id}`); `features`
  (`GET /api/features`); `lyrics` (`GET /api/lyrics`); `lyrics_sets`
  (`/api/songs/{id}/lyrics/*`); `songs` (`/api/songs`); `queue`
  (`/api/queue`); `history` (`/api/history`); `catalog`
  (`/api/catalog/providers`); `identity` config (`GET /api/auth/config`).
  The gate install adds `/api/auth/gate`, `/api/auth/lock`, `/api/auth/me`.
- **Health**: `GET /health` returns `{"status": "ok", "version": …}`;
  `GET /api` returns endpoint metadata.
- **Static SPA**: the frontend build in `backend/static/` is mounted at `/`
  **last**, with history-mode fallback to `index.html` for non-`/api/` paths.
  Cache policy by name shape: `assets/*` (content-hashed) is immutable;
  stable names (`index.html`, worklet, favicon) are `no-cache` + ETag.
- **Access gate**: single-host identity with an **optional** shared password
  (`KARAOKE_GATE_PASSWORD` / `KARAOKE_GATE_PASSWORD_HASH`). With no password
  configured, every caller is the host — the documented LAN posture.

### 3.2 Database & Migrations

**Engine** (`database.py`): async SQLAlchemy + aiosqlite. `DATABASE_URL`
defaults to `sqlite+aiosqlite:///<cwd>/karaoke.db` — the working directory is
expected to be `backend/`. `hide_parameters=True` keeps bound values (e.g.
credentials on the unlock route) out of exception text; `SQL_ECHO=true` is
the deliberate way to get them back while debugging. SQLite runs with WAL
mode, foreign-key enforcement on, and a 5s busy timeout
(`db/sqlite.py`).

**Schema is Alembic-managed** (`migrations/`, chain `c0001` … head; currently
through `c0006_play_history`). There is **no** create-tables-at-startup and
no boot-time `ALTER`s. The startup bootstrap (`db/bootstrap.py`) decides by
inspecting the database:

- **fresh** (no tables) → upgrade to head;
- **adopt** (pre-migration schema, no `alembic_version`) → verify the schema
  matches the frozen baseline column sets, stamp `c0001`, upgrade to head;
- **managed** → upgrade to head.

It **never repairs and never stamps blind**: a database that fails
verification raises `SchemaAdoptionError` and stops the boot, pointing at
`kb-db repair` or a restore. Auto-migrate at startup is ON by default
(first-run and upgrade UX); `KARAOKE_DB_AUTO_MIGRATE=false` makes startup
refuse to run unless the DB is already at head, mutating nothing.

**Operator CLI** — `kb-db` (console script, `cli.py`):

```
kb-db status                 # read-only: resolved DB path, tables, revision, plan
kb-db upgrade --yes          # bring the database to head
kb-db stamp-baseline --yes   # record c0001 without running it (guarded)
kb-db repair --yes           # re-add known-repairable historical columns
```

Every invocation prints the resolved absolute database path first; every
mutating verb requires `--yes`.

### 3.3 Models (`models/`)

#### Song (`models/song.py`)

Core library record: `artist`, `title`, `filename`, `duration`, `status`
(`uploading` → `processing` → `ready` / `failed`), `stems_path`,
`active_lyrics_id` (FK → `lyrics_sets`, `ON DELETE SET NULL`), timestamps,
`error_message`. Stem *files* have no DB column — the stem model is derived
from the filesystem per request (`stem_layout.py`), which is what makes
per-voice lanes purely additive.

#### Job (`models/song.py`)

One row per background job — and the row **is** the queue entry (see 3.5).
`status` is lifecycle only (`queued` / `running` / `done` / `failed`);
`phase` carries the UI-facing pipeline step (`separating`,
`fetching_lyrics`, `transcribing`, `aligning`, `importing`, …); `kind`
selects the handler (`ingest`, `retranscribe`, `realign`, `page`,
`resplit`, `catalog_import`); plus `progress` (0–100), `message`,
lease/claim columns.

#### LyricsSet (`models/song.py`)

Per-song lyric versions: `source` (`reference` / `transcription` / `lrclib`
/ `manual`), `label`, `is_verified`, `plain_lyrics`, `synced_lyrics` (LRC),
`word_sync_json`, `metadata_json`. A song's `active_lyrics_id` picks the set
the player uses.

#### QueueEntry (`models/queue.py`)

The BasicManualQueue row: `song_id` (FK → `songs`, `ON DELETE CASCADE` —
the queue points at your library, never at free-text titles),
`singer_name` (nullable free text — the whole "who's up" affordance),
`position` (dense 0..n-1 manual order), `created_at`. Dequeue-on-play
deletes the row.

#### PlayHistory (`models/history.py`)

One row per ▶ Sing: `song_id` (FK, `ON DELETE SET NULL`), snapshotted
`title` / `artist` / `singer_name` (the row reads correctly even after the
song is deleted), `played_at` (indexed sort key), `completed` (flipped by
the player's `ended` event via `/complete`).

#### AppSetting (`models/settings.py`)

Generic key/value operator settings; currently holds
`history_retention_days`.

### 3.4 API Endpoints

#### Songs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/songs` | Paginated list (`status`, `artist` filters) |
| `GET` | `/api/songs/:id` | Full details + stem URLs + per-voice stem model |
| `PATCH` | `/api/songs/:id` | Update metadata |
| `DELETE` | `/api/songs/:id` | Delete song record + stem files |
| `GET` | `/api/songs/:id/stems/:file` | Stream a stem file (filename validated) |
| `POST` | `/api/songs/:id/stems/resplit` | Queue a fresh Pass-2 lead/backing split with a different model (202; 409 unless the song is ready with exactly a lead/backing pair and no re-split already running) |
| `POST` | `/api/songs/:id/retry` | Re-queue the ingest pipeline for a song whose ingest failed (202) |

`POST /api/songs/:id/retry` is the rescue for a failed upload, which used to
be a dead row: the pipeline options are chosen in the upload form and the
audio ingest was handed is released when the job fails, so "try that again"
otherwise meant re-uploading a file the operator may no longer have. The
options are not on the song row — the Pass-2 model, the pasted reference
lyrics and the two LLM flags live only in the job payload — so the retry
replays the payload of this song's most recent INGEST job verbatim, which in
the normal case is the failed job itself. When no ingest job survives for the
song it falls back to server defaults and answers `options_recovered: false`
so the caller is not told a default run is a faithful re-run; otherwise
`true`. Response is 202 `{job_id, song_id, options_recovered, message}`; the
song is flipped back to `processing` with its `error_message` cleared and its
`job_id` pointed at the new job. Every refusal is synchronous: 404 for an
unknown or unowned song, 409 unless the song's status is `failed` (the detail
names the current status), 409 when a job for the song is still in flight, and
409 when the source audio is gone — checked only when the stems directory has
no `.separation-complete` marker, since past that point the stems are the
input and ingest resumes off them.

#### Import + Separation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/separate` | Import an audio file, create Song + queued ingest Job. Returns 202 + job id |
| `POST` | `/api/import/cdg` | Import one bare CDG or same-basename MP3+G ZIP; renders bounded H.264 playback media |
| `GET` | `/api/jobs/:job_id` | Poll job status / phase / progress |

Upload limits: 500 MB max (`MAX_FILE_SIZE_MB`), MP3/WAV/FLAC/M4A/OGG/AAC.
CDG import is single-song only: one `.cdg` or one exporter-compatible ZIP,
with a 30-minute graphics packet ceiling and a 550 MB request cap.

#### Lyric Sets

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/songs/:id/lyrics` | List the song's lyric sets |
| `GET` | `/api/songs/:id/lyrics/cache` | Transcription-cache status |
| `POST` | `/api/songs/:id/lyrics` | Create a set |
| `GET`/`PATCH`/`DELETE` | `/api/songs/:id/lyrics/:setId` | Read / edit / delete a set |
| `POST` | `/api/songs/:id/lyrics/:setId/activate` | Make a set the active one |
| `POST` | `/api/songs/:id/lyrics/:setId/verify` | Mark verified |
| `POST` | `/api/songs/:id/lyrics/:setId/copy` | Duplicate a set |
| `POST` | `/api/songs/:id/lyrics/transcribe` | Queue a re-transcription (202) |
| `POST` | `/api/songs/:id/lyrics/realign` | Queue an align-only pass (202) |
| `POST` | `/api/songs/:id/lyrics/:setId/page` | Queue LLM page structuring for an existing set; saves a new set (202) |

All three job routes (`/transcribe`, `/realign`, `/lyrics/:setId/page`) answer
409 unless the song is `ready`, with the current status named in the detail:
they re-run part of the pipeline over what a finished ingest left behind, so on
a `processing` song they would race the ingest for the same cache and the same
`songs.job_id`, and on a `failed` one the remedy is `/api/songs/:id/retry`.

`/transcribe` and `/realign` both accept `llm_correction` and `llm_paging`
(default false), the same two stages the upload form offers, and both forward
`language` into the job payload — the realign handler's aligner never decodes
audio and so ignores it, but the two routes take the same request body to the
same payload keys rather than one of them silently dropping a field. Correction runs
inside the aligner, and only the plain-text aligners hold a corrector — with a
synced (LRC) reference, or none at all, the flag is accepted and nothing
corrects.

#### Lyrics Lookup

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/lyrics?artist=&title=` | Plain + LRC lyrics. Requires auth; answers **503 unless** the opt-in lrclib lookup is enabled. A non-default `provider` selects an installed lyrics plugin |

#### Queue (BasicManualQueue)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/queue` | List the queue in play order |
| `POST` | `/api/queue` | Append a song (by `song_id`, optional `singer_name`) |
| `PUT` | `/api/queue/order` | Reorder the whole queue |
| `DELETE` | `/api/queue/:entryId` | Remove one entry (dequeue-on-play) |
| `DELETE` | `/api/queue` | Clear the queue |

#### Play History

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/history` | Record a play (the ▶ Sing action) |
| `POST` | `/api/history/:id/complete` | Mark completed (player `ended`) |
| `GET` | `/api/history` | List newest-first (search/pagination); prunes expired rows first |
| `DELETE` | `/api/history/:id` | Remove one entry |
| `DELETE` | `/api/history` | Clear history |
| `GET`/`PUT` | `/api/history/settings` | Read / set `retention_days` (default 30, 0 = forever) |

#### Meta / Session

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api` | API info |
| `GET` | `/api/features` | Operator-gated capability flags |
| `GET` | `/api/catalog/providers` | Installed catalog providers + capabilities |
| `GET` | `/api/auth/config` | Active auth assembly for the frontend |
| `POST` | `/api/auth/gate` / `/api/auth/lock`, `GET /api/auth/me` | Unlock / re-lock / identity for the optional shared password |

### 3.5 Jobs & Workers

**Durable job queue** (`jobs/queue.py`): the `jobs` table is the queue. A
route only ever writes a `queued` row; the worker claims it with a single
guarded `UPDATE` (two claimers race in SQLite's write lock, not in Python),
holds it under a time-based **lease** renewed by heartbeat, and either
finishes it or lets the lease lapse so another claimer can pick it up. Every
job-row write carries the `claimed_by` predicate, so a stale worker can never
touch a job another worker now holds; a refused write surfaces as
`LeaseLost` and the handler unwinds without writing a terminal state.
Concurrency is an env knob (`KARAOKE_JOB_CONCURRENCY`, default 1 — also the
GPU-OOM guard); lease length is `KARAOKE_JOB_LEASE_SECONDS` (default 180).
At boot, pre-queue legacy rows are swept to `failed` ("Interrupted by server
restart"); new-world `queued` rows deliberately survive.

**JobWorker** (`jobs/worker.py`) runs inside the server process and claims up
to the concurrency limit; handlers are dispatched by `Job.kind` through
`jobs/registry.py`:

- **ingest** (`jobs/ingest.py`) — the full pipeline: separation → reference
  lyrics → transcribe → align. Phase-resumable: each phase checks for its
  artifact before redoing work; separation completion is an atomic
  `.separation-complete` marker (the stem files alone can't distinguish a
  clean run from a truncated one).
- **retranscribe / realign** (`jobs/transcribe.py`) — re-run transcription
  or alignment for a song's lyrics; a transcription cache under the stems
  directory makes realign align-only.
- **page** (`jobs/transcribe.py`) — re-run LLM page structuring over an
  existing set's word timings and save the result as a new set. No GPU and
  no aligner; a run that produces no pages saves nothing.
- **resplit** (`jobs/resplit.py`) — re-run the Pass-2 lead/backing split on
  a song already in the library. Only for a plain lead/backing pair, and only
  one at a time per song. Outputs are staged and renamed into place, so a
  failure leaves the existing stems untouched; the song's transcription cache
  is dropped just before the renames, because the lead stem it described is
  about to be gone.
- **catalog_import** (`jobs/catalog_import.py`) — import driven by an
  installed catalog provider plugin.

**Separation dispatch** (`workers/modal_worker.py`): in order —
a separator **plugin** if `KARAOKE_SEPARATOR` names an installed, enabled
one; your own **Modal deployment** if `KARAOKE_MODAL=1` (both passes on a
GPU container you run, mixed locally); otherwise the **local** two-pass pipeline via
the dedicated `.venv-demucs` interpreter (`KARAOKE_DEMUCS_PYTHON`). Mixing
(`instrumental` = drums+bass+other; `karaoke` = instrumental+backing) is
ffmpeg `amix` in every path.

**Transcription** (`workers/word_sync_worker.py`) wraps the `lyricsync`
library (`SyncPipeline`): faster-whisper on CUDA/CPU, or an optional
fine-tuned lyrics transcriber run via subprocess in the separation venv
(`workers/heart_transcriptor.py`; checkpoint dir override
`KARAOKE_HEART_CKPT`). An **optional** LLM-assisted alignment correction
pass exists: off by default, points at
an OpenAI-compatible endpoint **you** configure (`KARAOKE_LLM_*`), and every
failure mode falls back to the deterministic heuristic.

**Lyrics lookup** (`workers/lyrics_worker.py`): lrclib.net fetcher — exact
match, then search fallback, best result by score. Gated at call time by
`KARAOKE_LRCLIB`; only explicit truthy values enable it.
When enabled, uploads use fetched plain lyrics for alignment unless lyrics
were pasted, and the generation UI defaults to plain-text lookup. Timing is
generated from the audio; fetched LRC timestamps are not used. Uploads fall
back to audio-only generation if no plain text is available. Explicit lookup
in the generation UI instead asks the host to paste lyrics or choose audio only.

**Plugins** (`plugins.py`): providers/extensions are discovered once at
startup from entry points, plus an optional local directory
(`KARAOKE_PROVIDERS_DIR`); `KARAOKE_PROVIDERS` is an allowlist. A broken
plugin is logged and skipped, never fatal.

### 3.6 Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `sqlite+aiosqlite:///<cwd>/karaoke.db` | Database connection string |
| `KARAOKE_DB_AUTO_MIGRATE` | `true` | `false` = startup refuses unless DB is at head (use `kb-db`) |
| `STEM_FORMAT` | `mp3` | New playback stems: MP3 256 kbps CBR; `flac` selects 16-bit FLAC. Existing MP3/FLAC/WAV stems remain readable and are not converted. MP3+G imports preserve the supplied MP3 audio without another lossy encode. |
| `UPLOADS_DIR` / `STEMS_DIR` | `uploads/` / `stems/` | Import staging / stem output directories |
| `MAX_FILE_SIZE_MB` | `500` | Max import file size |
| `BASE_URL` | `http://localhost:8000` | Absolute base for stem URLs — set to the host's LAN address |
| `CORS_ORIGINS` | localhost dev origins | Comma-separated allowed CORS origins |
| `LOG_LEVEL` | `INFO` | Logging level (driver logging stays clamped) |
| `SQL_ECHO` | `false` | Echo SQL incl. bound parameters (debug only) |
| `SESSION_SECRET` / `SESSION_SECRET_FILE` | auto-persisted file | Cookie-signing secret; default auto-generates `.session_secret` (0600) next to the DB |
| `SESSION_COOKIE` / `SESSION_HTTPS_ONLY` / `SESSION_MAX_AGE` | `karaoke_session` / `false` / 14 days | Session cookie tuning |
| `KARAOKE_GATE_PASSWORD` / `KARAOKE_GATE_PASSWORD_HASH` | unset | Optional shared unlock password (hash wins) |
| `KARAOKE_LRCLIB` | off | Opt-in lrclib.net lyrics lookup |
| `KARAOKE_PLEX_URL` / `KARAOKE_PLEX_TOKEN` | unset | Pin the Plex connection from the environment; either one makes the in-app settings read-only |
| `PLEX_TOKEN_FILE` | `.plex_token` next to the DB | Where the 0600 Plex token file lives (never in the DB) |
| `KARAOKE_PLEX_PATH_MAP` | unset | `plex-prefix=>local-prefix` rewrites so a container can read the library off disk |
| `KARAOKE_PLEX_LYRICS` | off | Opt-in: use lyrics from the Plex server as an alignment reference |
| `KARAOKE_JOB_CONCURRENCY` | `1` | Jobs run at once (GPU-OOM guard) |
| `KARAOKE_JOB_LEASE_SECONDS` | `180` | Job lease length |
| `KARAOKE_SEPARATOR` | unset | Name of an installed separator plugin |
| `KARAOKE_MODAL` / `KARAOKE_MODAL_APP` | off / `karaoke-gpu` | Offload separation to your own Modal deployment |
| `KARAOKE_DEMUCS_PYTHON` | `.venv-demucs/bin/python` | Interpreter of the local separation venv |
| `DEMUCS_MODEL` / `KARAOKE_MODEL` / `KARAOKE_MODEL_DIR` | `mdx_extra` / roformer ckpt / — | Separation model selection |
| `KARAOKE_HEART_CKPT` | `<cwd>/ckpt/HeartTranscriptor-oss` (not provided) | Fine-tuned transcriber checkpoint dir — supply your own to use this backend |
| `KARAOKE_LLM_BASE_URL` / `_MODEL` / `_TIMEOUT` / `_API_KEY` / `_API_KEY_FILE` | off | Optional OpenAI-compatible endpoint for alignment correction |
| `KARAOKE_PROVIDERS` / `KARAOKE_PROVIDERS_DIR` | unset | Plugin allowlist / extra plugin directory |

---

## 4. Frontend Details

### 4.1 Architecture

- **Framework**: Vue 3, Composition API (`<script setup>`)
- **State**: Pinia stores
- **Routing**: Vue Router, `createWebHistory` (SPA mode); a pluggable auth
  guard (`auth/gate.js`) protects routes
- **HTTP**: Axios client with per-area namespaces (`api/client.js`:
  `songApi`, `lyricsSetsApi`, `queueApi`, `historyApi`, `featuresApi`,
  `sessionApi`)
- **Styling**: TailwindCSS + scoped CSS
- **Audio**: Web Audio API via `composables/useAudioEngine.js`

### 4.2 Routes (`router/index.js`)

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | `HostShell` | Main host interface — library, player, queue, stage |
| `/songs/:songId/lyrics-editor/:setId?` | `LyricsEditorView` | Word-timing lyrics editor (without `:setId`, opens the song's active/first editable set) |
| `/unlock` | `UnlockView` | Shared-password unlock page (only relevant when a gate password is configured) |
| `/lab/editor` (dev builds only) | `EditorLab` | Editor design playground; excluded from production |

The projector is **not a route**: it is a popout window (see 4.5).

### 4.3 Pinia Stores (`stores/`)

- **songs.js** — library state, import/upload progress, job polling
- **queue.js** — the host queue: fetch, append, reorder, remove, clear
- **history.js** — play history list + retention setting
- **player.js** — playback/mixer state, key shift offset, per-voice lanes
- **features.js** — `/api/features` capability flags
- **hostSettings.js** — host display/behavior preferences
- **session.js** — auth/session state (`/api/auth/config`, gate status)

### 4.4 Components (`components/`)

- **AudioPlayer.vue** — transport + progress + lyrics loading; each stem is
  an `<audio>` element routed through the audio engine's gain graph
- **MixerPopover.vue** — per-stem volume/mute lanes (including every
  per-voice lane from the stem model) and the key-shift control
- **QueuePanel.vue** — host queue management: add from library, drag
  reorder, remove; ▶ Sing dequeues and records history
- **HistoryModal.vue** — play history browser (search, complete flags,
  retention setting)
- **SongList.vue / SongPicker.vue** — library browser / song chooser
- **UploadZone.vue** — drag-and-drop import with metadata entry and
  progress
- **LyricsEditor.vue** + `editor/` — lyric text and word-timing editing
- **ScreenStage.vue** — full-viewport stage wrapper hosting the canvas
  renderer (in-page and in the popout)
- **ProgressBar.vue** — seekable progress bar

**Key shift** (`composables/useAudioEngine.js`): ±12 semitone pitch
transposition at constant tempo via a time-stretch AudioWorklet node per
stem, inserted into the gain graph only when the offset is non-zero;
reported worklet latency is compensated.

### 4.5 Stage Renderer (`stage/`) and Popout

The lyric display is a clean-room canvas renderer with a pure functional
core:

- `frame.mjs` — `describeFrame(model, timeSeconds, viewport)` returns a
  frame descriptor in a fixed 640×360 stage coordinate system
  (`computeStageTransform` scales to the real viewport); reveal/lead-in/
  page-opacity/countdown computations are exported pure functions
- `adapter.mjs` — `normalizeWordSync(json)` converts backend word-sync JSON
  into the renderer's stage model
- `layout.mjs` — line layout and font sizing
- `draw.mjs` — `drawFrame` paints a descriptor onto a canvas 2D context
- `visualizers/` — ambient background visualizers (offscreen-capable)
- `KaraokeStage.vue` — the Vue wrapper binding player time to the renderer

**Popout projector** (`composables/useLyricsWindow.js`): a regular
`window.open` popup — same-origin JS context, `requestFullscreen` works,
window-management APIs can place it on a specific display. A
BroadcastChannel heartbeat plus an injected watchdog script closes orphaned
popouts when the host page reloads or dies.

### 4.6 Views (`views/`)

- **HostShell.vue** — the main app shell: sidebar (library/import/queue),
  player panel, stage area, popout control, toasts
- **LyricsEditorView.vue** — full-page word-timing editor
- **UnlockView.vue** — shared-password unlock form
- **EditorLab.vue** — dev-only playground

---

## 5. Word-Level Sync Pipeline — Deep Dive

The pipeline lives in the bundled `lyricsync` library
(`lyricsync/src/lyricsync/`); the backend drives it through `SyncPipeline` +
`PipelineConfig`.

### 5.1 The Problem

Whisper transcribes audio with word-level timestamps, but the text often
doesn't match the real lyrics (wrong words, missing words, hallucinations).
Karaoke needs **correct lyrics text** synced to **accurate per-word timing**.

### 5.2 Solution: LRC-Anchored Hybrid

1. **Reference lyrics text** comes from your pasted/verified set (or the
   opt-in lookup) — always displayed verbatim
2. **LRC line timestamps** provide proven line-level anchors
3. **Whisper word timestamps** fill in per-word timing within each line
   window
4. **Interpolation** covers words with no Whisper match

### 5.3 Matching Algorithm (`alignment/matching.py`)

`word_match_score` is a 3-tier strategy (scores from `MatchConfig`,
`_config.py`):

```python
def word_match_score(w1, w2, config):
    # Tier 1: exact match after normalization → 2.0
    if normalize(w1) == normalize(w2): return config.exact_score

    # Tier 2: enhanced Levenshtein
    lev = _enhanced_levenshtein(w1, w2)
    if lev >= 0.75: return 1.0   # close ("gonna" vs "gotta")
    if lev >= 0.5:  return 0.0   # weak

    # Tier 3: Double Metaphone phonetic fallback
    if _metaphone_match(w1, w2) >= 0.7: return 0.5  # sound-alikes

    return -1.0  # mismatch
```

**Enhanced Levenshtein** adds a first-letter boost and length-ratio blending
for short words ("u" vs "you"). **Double Metaphone** catches phonetic
matches Levenshtein misses (exact code → 1.0; short-code substring → 0.8;
shared prefix ≥ 2 → 0.7+; character overlap → 0.6+).

Alignment itself is standard **Needleman-Wunsch** dynamic programming
(`alignment/needleman_wunsch.py`) with gap penalty −0.5, returning
`(whisper_idx, reference_idx)` pairs with −1 for no match.

### 5.4 Quality Check (`alignment/lrc_anchored.py`)

Before trusting Whisper timing, `_whisper_quality_score` measures how many
reference words appear in the transcription:

```python
quality = matches / total_ref_words
if quality < 0.35:      # whisper_quality_threshold (PostProcessConfig)
    use_whisper = False # fall back to even distribution per line
```

This prevents hallucinated transcriptions from corrupting the display. LRC
timestamps in the wild also lead the audio slightly; `lrc_offset.py` detects
and compensates the global offset.

Post-processing (`_postprocess.py` / `PostProcessConfig`) enforces a minimum
word duration (120 ms), minimum inter-word gaps, monotonic non-overlapping
timestamps, and — when whisper-only — re-splits over-long lines using
punctuation, gaps, and word-count signals.

### 5.5 Output Format

```json
{
  "segments": [{"words": [
    {"text": "Hello", "start": 0.5, "end": 1.2},
    {"text": "world", "start": 1.3, "end": 1.8}
  ]}],
  "lines": [
    [{"word": "Hello", "start": 0.5, "end": 1.2},
     {"word": "world", "start": 1.3, "end": 1.8}]
  ],
  "metadata": {
    "words_total": 2,
    "words_matched": 2,
    "words_corrected": 0,
    "words_interpolated": 0,
    "method": "lrc-anchored",
    "whisper_quality": 1.0
  }
}
```

The result is stored as `word_sync_json` on a `LyricsSet` row
(`source: transcription`); `normalizeWordSync` on the frontend adapts it for
the stage renderer.

---

## 6. Deployment

### Systemd User Service

The backend can run as a systemd user service:

```ini
# ~/.config/systemd/user/karaoke-backend.service
[Unit]
Description=singhouse Backend
After=default.target

[Service]
Type=simple
ExecStart=/path/to/repo/backend/.venv/bin/python -m uvicorn karaoke_backend.main:app --host 0.0.0.0 --port 8000
WorkingDirectory=/path/to/repo/backend
Environment=BASE_URL=http://192.168.1.42:8000

[Install]
WantedBy=default.target
```

`WorkingDirectory` must be `backend/` — the default `DATABASE_URL` and the
`static/` mount resolve relative to it.

### Frontend Deploy (`frontend/scripts/deploy.sh`)

```bash
cd frontend && npm run deploy
```

The deploy builds a **named assembly** under
`frontend/deploy/<UTC-stamp>-g<sha>[-dirty]-<mode>/` (dirty is detected from
git and fails closed), deletes sourcemaps (never published), and publishes
with `rsync --delete` so the served tree in `backend/static/` mirrors the
assembly exactly instead of accumulating stale hashed assets. The three
newest assemblies are kept; `dist/` keeps its plain `npm run build` meaning
and is not a deploy artifact.

Because the publish is a mirror, the target (`KARAOKE_DEPLOY_TARGET`,
default `../backend/static`) is resolved and validated **before** anything
is built — refusing `/`, `$HOME`, the repo root or its ancestors, anything
inside `deploy/`, and any non-empty directory that doesn't already look like
a published frontend.

`backend/deploy-manifest.json` (assembly name, build time, sha, dirty flag,
mode, file count) records what is live. It is written **beside** the served
tree, deliberately not inside it — build provenance is for operators, not
browsers — and the post-publish check fails if a copy shows up in `static/`.

No backend restart is needed for a frontend deploy (the static mount reads
from disk per request), **except** when publishing into an empty/absent
`static/` under a running service — the mount is created once at startup,
and the script says so when that case applies. Backend *code* changes need a
service restart; note a restart interrupts `running` jobs mid-phase — the
durable queue re-claims them after lease expiry and resumes by phase.

### Production Considerations

- **CORS**: set `CORS_ORIGINS` for any non-localhost origin serving the UI
- **BASE_URL**: set to the host's LAN address so stem URLs resolve for other
  devices
- **Sessions**: the auto-persisted `.session_secret` (or an explicit
  `SESSION_SECRET`) keeps sessions valid across restarts
- **Disk**: stems are several audio files per song — budget accordingly;
  keep an eye on `uploads/` and `stems/`
- **GPU**: local separation wants a CUDA GPU; an alternative is your own
  Modal deployment
  (`KARAOKE_MODAL=1`, requires the `modal` extra + your credentials)
- **Backups**: the SQLite database runs in WAL mode — snapshot it with
  `sqlite3 karaoke.db ".backup <dest>"`, not a bare file copy

---

## 7. Testing

### Backend (`backend/tests/`, pytest)

In-memory SQLite (`:memory:` + `StaticPool`) and `httpx.AsyncClient` over
ASGI (`conftest.py`). Coverage areas:

| Area | Files (selection) |
|------|-------------------|
| API surface | `test_songs.py`, `test_separate.py`, `test_lyrics.py`, `test_lyrics_optin.py`, `test_queue_api.py`, `test_history_api.py`, `test_health.py` |
| Schema / migrations | `test_migrations.py`, `test_bootstrap.py`, `test_require_schema.py` |
| Job queue | `test_job_queue.py` (claims, leases, requeue, resume) |
| Plugins / providers | `test_plugins.py`, `test_provider_registry.py`, `test_catalog.py`, `test_lifespan_route_mounting.py` |
| Models / layout | `test_queue_model.py`, `test_stem_layout.py` |
| Hardening | `test_security_headers.py`, `test_gate.py`, `test_static_cache.py`, `test_ops_hardening.py`, `test_packaging_guards.py` |

```bash
cd backend && pip install -e '.[dev]' && pytest
```

### Frontend (`frontend/tests/`)

- `vitest run` — component/store/api unit tests (happy-dom), e.g.
  `QueuePanel.test.js`, `stores/history.test.js`
- `node --test tests/stage/*.test.mjs` — pure-function stage renderer tests
- a golden-frame harness (`tests/stage-harness/`) renders the stage against
  fixture models and compares descriptors

### lyricsync (`lyricsync/tests/`)

The alignment library carries its own pytest suite.

---

## 8. Glossary

| Term | Definition |
|------|-----------|
| **Stem** | An isolated audio track (instrumental, lead vocals, backing vocals, karaoke mix, or a per-voice track) |
| **LRC** | A lyrics file format with timestamps: `[mm:ss.xx] Lyric text` |
| **RMS-VAD** | Root Mean Square Voice Activity Detection — segments audio by energy level |
| **Needleman-Wunsch** | A classic dynamic programming algorithm for sequence alignment |
| **Double Metaphone** | A phonetic algorithm that generates sound-based codes for words |
| **Pre-roll** | Showing the next lyrics page before singing starts (configurable seconds) |
| **Word sync** | Per-word timestamps mapping reference lyrics to audio playback time |
| **Lyric set** | One version of a song's lyrics (reference, transcription, manual, …); one set is active per song |
| **Lease** | The time-boxed claim a worker holds on a job; renewed by heartbeat, re-claimable on expiry |
| **Assembly** | A named, manifest-carrying frontend build that is published as a mirror to the served static tree |
