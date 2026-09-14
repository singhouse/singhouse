# Backend API

FastAPI backend for the karaoke suite. Handles:

- **Stem separation** (instrumental, lead vocals, backing vocals, karaoke mix) —
  locally on your own GPU by default, or offloaded to a backend you configure
- **Lyrics fetching** from [lrclib.net](https://lrclib.net) — **opt-in, off by
  default** (`KARAOKE_LRCLIB=1`); with it off nothing contacts lrclib.net
- **Song library** CRUD with SQLite persistence

---

## Project Structure

The backend is a src-layout package; the importable code lives under
`src/karaoke_backend/`, not at the `backend/` root.

Selected files — not an exhaustive listing:

```
backend/
├── pyproject.toml       # package metadata + pinned dependencies
├── requirements.txt     # frozen mirror of the pins (see Quick Start)
├── alembic.ini          # migration config
├── pytest.ini
├── .env.example         # every supported setting, documented
├── LICENSE
├── modal_app.py         # Modal GPU app — deployed to YOUR OWN Modal account
├── scripts/
├── tests/               # pytest suite
└── src/karaoke_backend/
    ├── main.py          # FastAPI app + lifespan/startup
    ├── database.py      # SQLAlchemy async engine + session factory
    ├── cli.py           # the kb-db console script
    ├── plugins.py       # entry-point discovery for optional providers
    ├── stem_layout.py   # stem filename/format resolution
    ├── branding.py      # brand strings, isolated so they are swappable
    ├── ratelimit.py
    ├── api/             # routers — songs, separate, lyrics, lyrics_sets,
    │                    #   auth, identity, catalog, queue, history, …
    ├── jobs/            # durable job queue — worker, ingest, transcribe
    ├── workers/         # separation, transcription, and lyrics backends
    ├── models/          # SQLAlchemy models — song, queue, history, settings
    ├── db/              # bootstrap + migration helpers
    ├── migrations/      # Alembic revisions
    └── ops/             # operator scripts
```

Created at runtime, not tracked: `uploads/` (upload storage — released once a
song's stems exist, but a FAILED song's upload is kept until that song is
deleted, so it can be retried), `stems/` (processed stems), `static/`
(frontend build output), and the SQLite database.

---

## Quick Start

### 1. Install dependencies

The backend is an installable package (`karaoke-backend`); `pyproject.toml` is
the source of truth for its dependencies. Install it editable — this also puts
the `kb-*` operator console scripts on your PATH:

```bash
cd backend                  # from the repository root
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e '.[dev]'     # editable install + dev/test extras
```

`requirements.txt` is retained as a frozen mirror of the pins for the
older installs; new environments should prefer the editable install.

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env as needed
```

### 3. Run the server

```bash
python -m uvicorn karaoke_backend.main:app --reload --host 0.0.0.0 --port 8000
```

Open the interactive API docs: **http://localhost:8000/docs**

### 4. Operator console scripts

Installed with the package (`pip install -e .`):

```bash
kb-db status                                                  # report schema state; never writes
kb-seed-lyrics-reference --song-id 10 --json word_data.json   # seed a verified reference set
```

`kb-db` is the schema-operations CLI. `status` is read-only; every other verb
mutates the database and **refuses to run without `--yes`**:

```bash
kb-db status                 # read-only: report schema state and the planned action
kb-db upgrade --yes          # bring the database to head (stamps the baseline first if needed)
kb-db stamp-baseline --yes   # record the baseline revision without executing it
kb-db repair --yes           # add back the two historical songs columns if missing
```

---

## Stem Separation Backends

**Stem separation needs a GPU.** There is no CPU or placeholder fallback: if no
backend is available the ingest job fails and the song is left in your library
with `status: failed`, for you to retry or delete. Pick one of the following
before uploading anything.

`separate_stems` selects a backend in this order, first match wins:

| Order | Backend | Enabled by |
|---|---|---|
| 1 | Separator plugin | `KARAOKE_SEPARATOR` naming an installed plugin — the core ships none |
| 2 | Modal | `KARAOKE_MODAL=1` **and** the `modal` SDK importable |
| 3 | **Local (the default)** | a `.venv-demucs` virtualenv inside `backend/` |

### Local separation (default)

A two-pass pipeline — Demucs for the instrumental/vocal split, then a karaoke
model for the lead/backing split. It requires a **CUDA** device; the local path
runs Demucs with `--device cuda`.

The interpreter path is resolved relative to the backend's working directory,
so create the virtualenv from inside `backend/`:

```bash
cd backend
uv venv .venv-demucs --python 3.13
source .venv-demucs/bin/activate
uv pip install demucs torch torchaudio torchcodec 'audio-separator[cpu]'
```

Point elsewhere with `KARAOKE_DEMUCS_PYTHON` if you keep the interpreter
somewhere other than `backend/.venv-demucs/bin/python`.

### Modal (your own account)

Modal is **opt-in and off by default**, and it runs in *your* Modal account —
deploy `modal_app.py` there yourself. Installing the SDK is not enough; the
backend does not auto-detect it.

```bash
pip install modal
modal setup                    # authenticate with your own Modal account
modal deploy backend/modal_app.py
export KARAOKE_MODAL=1         # required — see .env.example
```

`KARAOKE_MODAL_APP` (default `karaoke-gpu`) must match the app name in
`modal_app.py`; a mismatch fails the lookup rather than falling back.

### If no backend is configured

The job fails with `Demucs venv not found at …`, recorded on the job as
`status: failed` / `phase: failed`. The uploaded file is KEPT: configure a
backend, then retry the song from its Details tab
(`POST /api/songs/{song_id}/retry`) and the same file is separated with the
same options — no re-upload.

This is the general rule, not a Demucs special case. Any song whose producing
job fails permanently — an upload, a video import, or a media-server import —
stays in the library as `failed` and can be retried from the Details tab. An
upload or a video import keeps its source file in `uploads/` for that retry;
a media-server import re-fetches the track from the server instead and keeps
nothing. Nothing sweeps a failed song's upload automatically: deleting the
song is what releases it, so a library that accumulates failed songs
accumulates their uploads until they are deleted.

---

## API Reference

### Authentication

Every endpoint requires an authenticated session unless noted otherwise. In
the default single-host assembly there is exactly one identity — the Host —
optionally protected by a shared gate password:

- `KARAOKE_GATE_PASSWORD` (plaintext) or `KARAOKE_GATE_PASSWORD_HASH` (bcrypt;
  wins if both are set). With **neither set, the gate is disabled and every
  endpoint is open** — the LAN-party posture.
- With a password configured, unlock once via `POST /api/auth/gate` and reuse
  the session cookie on every subsequent request. Locked requests answer
  `401`.

The session rides a signed, httponly cookie (`SESSION_COOKIE`, default
`karaoke_session`), so curl needs a cookie jar — see
[curl / Postman Examples](#curl--postman-examples).

The main exception worth calling out up front: `GET /api/jobs/{job_id}`
also admits an authenticated *guest* (a deployment-issued credential, in
assemblies that have one) with a reduced response. A few other routes
below note their own guest behaviour where they have one.

---

### `POST /api/separate`

Upload an audio file; the full ingest pipeline (separation → lyrics →
transcription → alignment) is **enqueued as a durable job** and runs in the
background.

**Request:** `multipart/form-data`

| Field            | Type    | Required | Description |
|------------------|---------|----------|-------------|
| `file`           | binary  | ✅       | Audio file (MP3/WAV/FLAC/M4A/OGG/AAC), max 500 MB by default (`MAX_FILE_SIZE_MB`) |
| `artist`         | string  | ❌       | Artist name (metadata) |
| `title`          | string  | ❌       | Song title (metadata) |
| `plain_lyrics`   | string  | ❌       | Pasted reference lyrics; anchors alignment and skips any lyrics lookup |
| `llm_correction` | boolean | ❌       | Enable LLM lyric correction (default `false`) |
| `llm_paging`     | boolean | ❌       | Enable LLM page structuring (default `false`) |

If `artist`/`title` are omitted, they are inferred from an
`Artist - Title.ext` filename when possible.

**Errors:** `415` unsupported media type, `413` file too large, `401` no
session.

**Response `202`:**

```json
{
  "job_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "song_id": 1,
  "status": "queued",
  "status_url": "http://localhost:8000/api/jobs/3fa85f64-...",
  "message": "File uploaded. Stem separation queued."
}
```

---

### `GET /api/jobs/{job_id}`

Poll job status. Poll every 2–5 seconds until `status` is `done` or `failed`.

A job carries **two different fields** and they answer different questions:

- **`status`** — the queue *lifecycle*: `queued` → `running` → `done` |
  `failed`. These four are the only values, and the only ones worth branching
  on.
- **`phase`** — what the job is *doing*, for display: `queued` →
  `separating` → `fetching_lyrics` → `transcribing` → `aligning` → `done` |
  `failed`. A catalog import runs the single phase `importing` instead. For
  rows written before the durable queue existed, `phase` falls back to
  `status`.

`progress` is a 0–100 integer spanning the **entire** pipeline, not the
current phase.

**Response `200` (in progress):**

```json
{
  "job_id": "3fa85f64-...",
  "song_id": 1,
  "status": "running",
  "phase": "separating",
  "progress": 45,
  "message": "Starting stem separation",
  "stems": null,
  "error": null
}
```

**Response `200` (done):**

```json
{
  "job_id": "3fa85f64-...",
  "song_id": 1,
  "status": "done",
  "phase": "done",
  "progress": 100,
  "message": "Ingest complete",
  "stems": {
    "instrumental":   "http://localhost:8000/api/songs/1/stems/instrumental.flac",
    "lead_vocals":    "http://localhost:8000/api/songs/1/stems/lead_vocals.flac",
    "backing_vocals": "http://localhost:8000/api/songs/1/stems/backing_vocals.flac",
    "karaoke":        "http://localhost:8000/api/songs/1/stems/karaoke.flac",
    "vocals": [
      {"id": "lead",    "name": null, "url": "http://localhost:8000/api/songs/1/stems/lead_vocals.flac"},
      {"id": "backing", "name": null, "url": "http://localhost:8000/api/songs/1/stems/backing_vocals.flac"}
    ]
  },
  "error": null
}
```

`error` is populated only when `status` is `failed`. `stems` is populated
only when `status` is `done`; within it, a flat key is `null` when that file
is not on disk, while `vocals` is always a list (see the stem download route
for the filename model). An unknown job id — or another tenant's — is a
`404`. A guest caller gets the same JSON shape with the content withheld:
`job_id`, `song_id`, `status`, `phase`, and `progress` carry values;
`message`, `stems`, and `error` come back `null`.

---

### `GET /api/lyrics`

Fetch plain + synced (LRC) lyrics from the opt-in third-party provider.

| Param      | Type   | Required | Description  |
|------------|--------|----------|--------------|
| `artist`   | string | ✅       | Artist name  |
| `title`    | string | ✅       | Song title   |
| `provider` | string | ❌       | Provider name (default: the built-in lrclib source; another name selects an installed lyrics plugin) |

**Errors:** `503` when the built-in provider is not opted in
(`KARAOKE_LRCLIB` unset — the stock state), `404` no lyrics found, `502`
provider unreachable.

**Response `200`:**

```json
{
  "artist": "Radiohead",
  "title": "Creep",
  "album": "Pablo Honey",
  "duration": 238.0,
  "plain_lyrics": "When you were here before\nCouldn't look you in the eye\n...",
  "synced_lyrics": "[00:16.60] When you were here before\n[00:20.00] Couldn't look you in the eye\n...",
  "lines": ["When you were here before", "Couldn't look you in the eye", "..."],
  "has_sync": true,
  "source": "lrclib.net"
}
```

---

### `GET /api/songs`

List songs (paginated, newest first).

| Param       | Type   | Default | Description              |
|-------------|--------|---------|--------------------------|
| `page`      | int    | 1       | Page number (1-indexed)  |
| `page_size` | int    | 20      | Items per page (max 500) |
| `status`    | string | —       | Filter: processing/ready/failed |
| `artist`    | string | —       | Partial artist match     |
| `search`    | string | —       | Free-text search across title, artist, and filename |

**Response `200`:**

```json
{
  "songs": [
    {
      "id": 1,
      "artist": "Radiohead",
      "title": "Creep",
      "filename": "creep.mp3",
      "duration": 238.0,
      "status": "ready",
      "created_at": "2026-01-15T12:30:00",
      "lyrics_synced": true,
      "phase": "done",
      "progress": 100,
      "message": "Ingest complete",
      "external_provider": null,
      "lyrics_format_version": null,
      "external_id": null
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 20
}
```

`phase`/`progress`/`message` mirror the song's current job while an ingest is
running (`null` when it has none). The `external_*` fields describe the
active lyrics set's origin, for provider-specific UI affordances; they are
`null` for ordinary uploads. In assemblies that admit guests, an
unauthenticated guest gets a reduced projection of each row (no `filename`,
no job fields, no provenance fields).

---

### `GET /api/songs/{song_id}`

Get full song details including stem download URLs (relative paths). On top
of the list fields, the detail adds:

```json
{
  "id": 1,
  "artist": "Radiohead",
  "title": "Creep",
  "filename": "creep.mp3",
  "duration": 238.0,
  "status": "ready",
  "created_at": "2026-01-15T12:30:00",
  "lyrics_synced": true,
  "stems": {
    "instrumental":   "/api/songs/1/stems/instrumental.flac",
    "lead_vocals":    "/api/songs/1/stems/lead_vocals.flac",
    "backing_vocals": "/api/songs/1/stems/backing_vocals.flac",
    "karaoke":        "/api/songs/1/stems/karaoke.flac",
    "vocals": [
      {"id": "lead",    "name": null, "url": "/api/songs/1/stems/lead_vocals.flac"},
      {"id": "backing", "name": null, "url": "/api/songs/1/stems/backing_vocals.flac"}
    ]
  },
  "error_message": null,
  "job_id": "3fa85f64-...",
  "word_sync": {"lines": [[{"text": "When", "start": 16.6, "end": 16.9}]], "metadata": {"...": "..."}},
  "custom_lyrics": null,
  "active_lyrics_id": 4,
  "lyrics_sets": [
    {
      "id": 4,
      "source": "transcription",
      "label": "large-v3-vad",
      "is_verified": false,
      "is_active": true,
      "has_word_sync": true,
      "has_synced_lyrics": true,
      "has_plain_lyrics": true,
      "metadata": {"...": "..."},
      "created_at": "2026-01-15T12:35:00"
    }
  ],
  "has_source_doc": false
}
```

`stems` is present only when the song is `ready` and its stems directory
exists; within it, a flat key is `null` when that file is not on disk. `word_sync` is the active lyrics set's per-word timing payload,
`null` when there is none.

---

### `PATCH /api/songs/{song_id}`

Update song metadata. All fields optional; returns the full song detail.

```json
{
  "artist": "Radiohead",
  "title": "Creep (acoustic)",
  "lyrics_synced": true,
  "custom_lyrics": "When you were here before\n..."
}
```

---

### `DELETE /api/songs/{song_id}`

Delete the song record and all stem files from disk.

**Response `200`:**

```json
{"message": "Song 1 deleted"}
```

---

### `GET /api/songs/{song_id}/stems/{filename}`

Download a stem file. Valid filenames are the recognized stem basenames
actually present on disk for that song, in `.flac` or `.wav`. When both
extensions exist, both filenames are valid here; the URLs the responses
above hand out prefer the `.flac` name:

- `instrumental` — the no-vocals bed
- `karaoke` — the instrumental + backing-vocals mix
- `lead_vocals`, `backing_vocals` — the standard vocal lanes
- `lead_vocals_<N>`, `backing_vocals_<N>` (N ≥ 2) — extra generic lanes for
  multi-lead songs
- `vocal_<id>` — per-voice stems, named from the active lyrics set's voice
  roster

e.g. `GET /api/songs/1/stems/karaoke.flac`. Use the URLs handed back by the
song detail or job status rather than guessing. **Errors:** `400` malformed
filename, `409` song not `ready` yet, `404` no such stem on disk.

---

### Other endpoints

One line each; request/response details are on **http://localhost:8000/docs**.
"Session" means the standard authenticated session described above; "open"
means no authentication.

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /health` | open | Liveness: `{"status": "ok", "version": …}` |
| `GET /api` | open | API name, version, and top-level endpoint map |
| `GET /api/auth/config` | open | Active auth mode, e.g. `{"mode": "single_host", "password_required": false}` |
| `POST /api/auth/gate` | open (rate-limited) | Exchange the shared password for an unlocked session |
| `POST /api/auth/lock` | open | Re-lock the current session |
| `GET /api/auth/me` | session | Current identity (`401` while locked) |
| `GET /api/features` | session | Operator-gated capability flags (lyrics lookup opt-in state, CD+G export availability) |
| `GET /api/export/settings` | session | Read the export settings (attribution-card toggle) |
| `PUT /api/export/settings` | session | Update the export settings |
| `GET /api/export/songs/{id}` | session | Download the song as an MP3+G zip (`?format=mp3g`, default) or bare `.cdg` (`?format=cdg`); `501` when the optional export extra is not installed |
| `GET /api/catalog/providers` | session or guest | Installed catalog providers — `[]` on a stock install (core ships none) |

**Lyrics sets** — every song holds one or more sets of lyrics (transcriptions,
references, manual edits); at most one is *active* (drives playback). All
routes require a session:

| Method + path | Purpose |
|---|---|
| `GET /api/songs/{id}/lyrics` | List the song's lyrics sets |
| `GET /api/songs/{id}/lyrics/cache` | Cached-transcription status (drives "re-align only") |
| `GET /api/songs/{id}/lyrics/{lid}` | Get one set (full payloads) |
| `POST /api/songs/{id}/lyrics` | Create a set (`201`) |
| `PATCH /api/songs/{id}/lyrics/{lid}` | Edit a set |
| `POST /api/songs/{id}/lyrics/{lid}/activate` | Make a set the active one |
| `POST /api/songs/{id}/lyrics/{lid}/verify` | Mark a set as the verified reference |
| `POST /api/songs/{id}/lyrics/{lid}/copy` | Duplicate a set (`201`) |
| `DELETE /api/songs/{id}/lyrics/{lid}` | Delete a set |
| `POST /api/songs/{id}/lyrics/transcribe` | Queue a fresh transcription run (`202`, returns `{job_id, song_id, message}` — poll `/api/jobs/{job_id}`) |
| `POST /api/songs/{id}/lyrics/realign` | Re-align the cached transcription against a new reference (`202`, same response shape) |

**Queue and play history** (mounted in single-host core builds; a multi-user
build brings its own). All routes require a session:

| Method + path | Purpose |
|---|---|
| `GET /api/queue` | List the queue in play order |
| `POST /api/queue` | Append a song (`201`; body: `song_id`, optional `singer_name`) |
| `PUT /api/queue/order` | Reorder the whole queue (`409` if it changed since you fetched it) |
| `DELETE /api/queue/{entry_id}` | Remove one entry (dequeue-on-play) |
| `DELETE /api/queue` | Clear the queue |
| `GET /api/history` | List play history, newest first (`search`, `limit` ≤ 500, `offset`) |
| `POST /api/history` | Record a play (`201`) |
| `POST /api/history/{id}/complete` | Mark a play completed |
| `DELETE /api/history/{id}` | Remove one history entry |
| `DELETE /api/history` | Clear the whole history |
| `GET /api/history/settings` | Read the retention setting (`retention_days`, 0 = keep forever) |
| `PUT /api/history/settings` | Update the retention setting |

Installed provider or extension packages may mount additional routes; the
live list is always **http://localhost:8000/docs**.

---

## curl / Postman Examples

### Log in first (when a gate password is configured)

Sessions ride a cookie, so create a cookie jar once and reuse it. With no
gate password configured this step is unnecessary — everything is open:

```bash
curl -c cookies.txt -X POST http://localhost:8000/api/auth/gate \
  -H "Content-Type: application/json" \
  -d '{"password": "your-gate-password"}'
```

Every example below passes `-b cookies.txt` to reuse that session; a request
without it answers `401` whenever the gate is enabled.

### Submit a song for separation

```bash
curl -b cookies.txt -X POST http://localhost:8000/api/separate \
  -F "file=@/path/to/song.mp3" \
  -F "artist=Radiohead" \
  -F "title=Creep"
```

### Poll job status

```bash
curl -b cookies.txt http://localhost:8000/api/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6
```

### Fetch lyrics

```bash
curl -b cookies.txt "http://localhost:8000/api/lyrics?artist=Radiohead&title=Creep"
```

### List all songs

```bash
curl -b cookies.txt http://localhost:8000/api/songs
```

### Download a stem

```bash
curl -b cookies.txt -OJ http://localhost:8000/api/songs/1/stems/karaoke.flac
```

### Watch a job until done (bash loop)

```bash
JOB_ID="3fa85f64-..."
while true; do
  LINE=$(curl -s -b cookies.txt "http://localhost:8000/api/jobs/$JOB_ID" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'], d['phase'], d['progress'])")
  echo "$LINE"
  [[ "$LINE" == done* || "$LINE" == failed* ]] && break
  sleep 3
done
```

---

## Running Tests

The Quick Start's editable install (`pip install -e '.[dev]'`) already brings
the test dependencies (pytest, pytest-asyncio, Pillow) — there is nothing extra to
install. The one ordering rule: `lyricsync` is a local package in this
repository, not on PyPI, so it must be installed (editable) **before** the
backend or pip will fail trying to resolve it. This mirrors what CI does:

```bash
# from the repository root
python -m pip install -e './lyricsync[whisper,metaphone,levenshtein]'
python -m pip install -e './backend[dev]'

cd backend
python -m pytest -q
```

Known local-tree caveat: one route-mounting test
(`tests/test_lifespan_route_mounting.py`) asserts against an app booted
without a frontend build, so it can fail in a working tree where
`backend/static/` contains one. A clean checkout — which is what CI runs —
passes; the failure is an artifact of the local tree, not a code defect.

---

## Development Notes

### Working without a GPU

You can't, for ingest. There is no mock or placeholder-stem mode, and a missing
separation backend is a hard job failure rather than a degraded path — see
[Stem Separation Backends](#stem-separation-backends). Frontend work against an
already-populated library is fine; adding new songs is not.

### Adding the Frontend

Place your built frontend files in `static/`. The server will serve them at `/`.
The API remains mounted at `/api/...`.

### Database

The schema is Alembic-managed and migrations run automatically at startup
(disable with `KARAOKE_DB_AUTO_MIGRATE=false`, which then refuses to start
unless the database is already at head — use `kb-db upgrade --yes` to bring
it there yourself).

**SQLite is the supported database.** The migrations are written
SQLite-specific (batch table alterations and SQLite type shapes), so pointing
`DATABASE_URL` at a different database backend is untested and not currently
supported.

---

## Architecture Notes

`Job.status` is the queue **lifecycle** (`queued`/`running`/`done`/`failed` —
what the worker claims against); `Job.phase` is the **pipeline step** the UI
shows. They are separate fields on the same row.

```
Client
  │
  ▼
FastAPI (karaoke_backend/main.py)
  ├── /api/separate  → saves upload → creates Song + a queued Job row → 202
  │
  │        jobs/worker.py — the durable-queue worker (in-process)
  │        claims a queued job under a lease, heartbeats to renew it;
  │        an expired lease (dead process) requeues the job automatically
  │                     │
  │                     ├─ ingest pipeline (jobs/ingest.py), phase by phase:
  │                     │    separating → fetching_lyrics → transcribing → aligning
  │                     │    (a catalog import runs the `importing` phase instead)
  │                     │
  │                     ├─ separation dispatch (workers/modal_worker.py):
  │                     │    separator plugin → Modal (opt-in, your own
  │                     │    account, off by default) → local
  │                     │    Demucs venv (the default)
  │                     │
  │                     └─ updates Job (status/phase/progress) + Song in SQLite
  │
  ├── /api/jobs/{id} → reads the Job row → status + phase + progress
  ├── /api/lyrics     → workers/lyrics_worker.py → opt-in third-party lookup
  │                     (session required; 503 unless the operator opted in)
  └── /api/songs      → CRUD on Song table → serves stem files
```
