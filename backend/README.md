# Singhouse Backend API

FastAPI backend for the Singhouse karaoke suite. Handles:

- **Two-pass stem separation** (`instrumental`, `lead_vocals`, `backing_vocals`, `karaoke`, plus per-voice stems) locally on your GPU or via your own Modal deployment.
- **Word-level transcription & CTC acoustic alignment** via the bundled `lyricsync` library.
- **Opt-in plain-text lyrics lookup** from [lrclib.net](https://lrclib.net) (`KARAOKE_LRCLIB=1`, off by default).
- **Song library, lyric sets, manual host queue, play history, and CD+G / MP3+G import/export** backed by async SQLite (WAL mode).

---

## Project Structure

The backend uses a `src/` layout under `src/karaoke_backend/`:

```
backend/
├── pyproject.toml       # Package metadata + pinned dependencies
├── requirements.txt     # Frozen compatibility mirror of dependencies
├── alembic.ini          # Alembic migration config
├── .env.example         # Documented environment variable reference
├── modal_app.py         # Optional user-owned Modal GPU app (separation + Heart)
├── modal_llm.py         # Optional user-owned Modal vLLM app (lyric page grouping)
├── tests/               # Pytest suite
└── src/karaoke_backend/
    ├── main.py          # FastAPI app + lifespan startup/shutdown
    ├── database.py      # SQLAlchemy async engine + session factory
    ├── cli.py           # `kb-db` schema management CLI
    ├── plugins.py       # Entry-point discovery for optional providers
    ├── stem_layout.py   # Filesystem stem resolution (per-voice lanes)
    ├── branding.py      # Isolated brand constants
    ├── ratelimit.py     # Unlock endpoint rate limiting
    ├── api/             # FastAPI routers (songs, separate, lyrics, lyrics_sets, queue, history, …)
    ├── jobs/            # Durable SQLite job queue (worker, ingest, transcribe, resplit, …)
    ├── workers/         # Separation, transcription, CTC alignment, and lyrics workers
    ├── models/          # SQLAlchemy models (song, queue, history, settings)
    ├── db/              # Schema bootstrap + programmatic Alembic helpers
    ├── migrations/      # Alembic revisions (c0001 baseline → head)
    ├── export/          # CD+G rasterizer and MP3+G packaging
    └── ops/             # Operator scripts (`kb-seed-lyrics-reference`)
```

Runtime directories (untracked): `uploads/` (kept for `failed` songs so they can be retried; released once separation completes or the song is deleted), `stems/`, `static/` (frontend build), and `karaoke.db`.

---

## Quick Start

### 1. Install Dependencies

Install the local `lyricsync` package first, then install `karaoke-backend` in editable mode (requires Python 3.12+):

```bash
# From the repository root
python -m venv backend/.venv
source backend/.venv/bin/activate   # Windows: backend\.venv\Scripts\activate
python -m pip install -e './lyricsync[whisper,metaphone,levenshtein]'
python -m pip install -e './backend[dev]'
```

### 2. Configure & Run

```bash
cd backend
cp .env.example .env
python -m uvicorn karaoke_backend.main:app --reload --host 0.0.0.0 --port 8000
```

Interactive OpenAPI docs are available at **http://localhost:8000/docs**.

### 3. Database CLI (`kb-db`)

Schema migrations run automatically at startup by default (`KARAOKE_DB_AUTO_MIGRATE=true`). For manual database inspection or maintenance, use `kb-db` (all mutating commands require `--yes`):

```bash
kb-db status                 # Read-only: print resolved DB path, current revision, and plan
kb-db upgrade --yes          # Upgrade database to head (stamps c0001 baseline first if adopting)
kb-db stamp-baseline --yes   # Stamp c0001 on a verified pre-Alembic database without running DDL
kb-db repair --yes           # Re-add historical missing columns on legacy databases
```

---

## Stem Separation Backends

Stem separation requires a GPU; there is no CPU or mock fallback for `POST /api/separate`. Backends are selected in the following priority order:

| Priority | Backend | Enabled By |
| --- | --- | --- |
| 1 | **Separator Plugin** | `KARAOKE_SEPARATOR` naming an installed entry-point plugin |
| 2 | **Modal (User-Owned)** | `KARAOKE_MODAL=1` with the `modal` SDK installed (see [`docs/modal.md`](../docs/modal.md)) |
| 3 | **Local GPU (Default)** | `.venv-demucs` virtualenv inside `backend/` (or `KARAOKE_DEMUCS_PYTHON`) |

### Setting Up the Local Separation Venv

Create `.venv-demucs` inside `backend/` with CUDA-enabled PyTorch, Demucs, and `audio-separator`:

```bash
cd backend
uv venv .venv-demucs --python 3.13
source .venv-demucs/bin/activate
uv pip install demucs torch torchaudio torchcodec 'audio-separator[cpu]'
```

### Failed Ingest & Retry Behavior

If no separation backend is available (or a job fails mid-pipeline), the job records `status: failed` and retains the source audio in `uploads/`. Once your backend is configured, trigger `POST /api/songs/{song_id}/retry` (or click **Retry** in the Song Details tab) to replay the job with its original options without re-uploading. Deleting the failed song removes its retained upload.

---

## CTC Acoustic Word Timing

After initial transcription and Needleman-Wunsch alignment, a final stage force-aligns every word against the vocal audio (`lead_vocals` + `backing_vocals` when present) using up to four CTC acoustic models (`HuBERT-Large`, `wav2vec2-Large`, `HuBERT-XLarge`, and an optional `facebook/wav2vec2-lv-60-espeak-cv-ft` phoneme voter) running in `.venv-demucs`. Only word `start`/`end` timestamps are refined—lyric text, word count, and line breaks never change.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KARAOKE_ACOUSTIC_ALIGNMENT` | `on` | Set `0`, `false`, or `off` to disable CTC re-timing |
| `KARAOKE_ACOUSTIC_ALIGNMENT_CPU` | `off` | Set `1` to allow CPU execution when CUDA is unavailable (slow) |
| `KARAOKE_ACOUSTIC_ALIGNMENT_TIMEOUT` | `3600` | Worker timeout in seconds (covers first-run model downloads) |

* **Hardware & Performance:** Requires CUDA by default (~25s for a 4-minute song on a 24 GB GPU with warm caches, peaking around 5 GB VRAM as models load sequentially).
* **Pre-downloading Models (~7.5 GB total):** Models download automatically on first run into `.venv-demucs`'s Torch Hub and Hugging Face caches. To pre-fetch them ahead of time:

  ```bash
  .venv-demucs/bin/python -c "import torchaudio as ta; [getattr(ta.pipelines, b).get_model() for b in ('HUBERT_ASR_LARGE', 'WAV2VEC2_ASR_LARGE_LV60K_960H', 'HUBERT_ASR_XLARGE')]"
  .venv-demucs/bin/python -c "from transformers import AutoModelForCTC, AutoProcessor as P; r='facebook/wav2vec2-lv-60-espeak-cv-ft'; P.from_pretrained(r); AutoModelForCTC.from_pretrained(r)"
  ```

* **Optional Phoneme Voter:** Requires `transformers` and `phonemizer` in `.venv-demucs` plus `espeak-ng` installed on the host OS. Without them, the aligner runs with the three character models.
* **Graceful Fallback:** Any error (missing CUDA, timeout, missing `.venv-demucs`) preserves the existing alignment timing and logs the outcome under `metadata.acoustic_alignment` (including `flagged_words` indices where voters disagreed by >200 ms).

---

## API Reference

### Authentication

In the default single-host setup, authentication is controlled by `KARAOKE_GATE_PASSWORD` (plaintext) or `KARAOKE_GATE_PASSWORD_HASH` (bcrypt, takes precedence):

* **Unset (default):** Gate is disabled; all endpoints are open for LAN use.
* **Set:** Unlock once via `POST /api/auth/gate` to receive a signed `httponly` session cookie (`karaoke_session`), and include that cookie on subsequent requests.

---

### `POST /api/separate`

Upload an audio file and enqueue the full ingest pipeline (separation → lyrics → transcription → alignment).

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `file` | binary | Yes | Audio file (MP3/WAV/FLAC/M4A/OGG/AAC), max `500` MB (`MAX_FILE_SIZE_MB`) |
| `artist` | string | No | Artist name (inferred from `Artist - Title.ext` if omitted) |
| `title` | string | No | Song title (inferred from filename if omitted) |
| `plain_lyrics` | string | No | Pasted reference lyrics; anchors alignment and skips third-party lookup |
| `llm_paging` | boolean | No | Enable LLM page structuring (default `false`) |

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

Poll job status every 2–5 seconds until `status` reaches `done` or `failed`:

* **`status`** (queue lifecycle): `queued` → `running` → `done` | `failed`.
* **`phase`** (active pipeline step): `queued` → `separating` → `fetching_lyrics` → `transcribing` → `aligning` → `done` | `failed` (or `importing` for catalog imports).
* **`progress`**: `0–100` integer across the entire job.

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
    "instrumental":   "http://localhost:8000/api/songs/1/stems/instrumental.mp3",
    "lead_vocals":    "http://localhost:8000/api/songs/1/stems/lead_vocals.mp3",
    "backing_vocals": "http://localhost:8000/api/songs/1/stems/backing_vocals.mp3",
    "karaoke":        "http://localhost:8000/api/songs/1/stems/karaoke.mp3",
    "vocals": [
      {"id": "lead",    "name": null, "url": "http://localhost:8000/api/songs/1/stems/lead_vocals.mp3"},
      {"id": "backing", "name": null, "url": "http://localhost:8000/api/songs/1/stems/backing_vocals.mp3"}
    ]
  },
  "error": null
}
```

---

### `GET /api/songs` & `GET /api/songs/{song_id}`

* `GET /api/songs` — Paginated song list (`page`, `page_size` ≤ 500, `status`, `artist`, `search`).
* `GET /api/songs/{song_id}` — Full song details, stem URLs, active `word_sync` payload, and `lyrics_sets` summary list.
* `PATCH /api/songs/{song_id}` — Update `artist`, `title`, `lyrics_synced`, or `custom_lyrics`.
* `DELETE /api/songs/{song_id}` — Delete song record and stem files on disk.
* `POST /api/songs/{song_id}/retry` — Replay the most recent failed ingest job for a `failed` song (`202`; returns `409` unless status is `failed` and source audio or `.separation-complete` stems exist).
* `POST /api/songs/{song_id}/stems/resplit` — Re-run Pass-2 lead/backing vocal separation with a new model (`202`).

---

### `GET /api/songs/{song_id}/stems/{filename}`

Stream a stem audio file. Valid basenames on disk (`STEM_FORMAT` defaults to `.mp3` 256 kbps CBR; `.flac` and `.wav` are also supported):

* `instrumental` — No-vocals backing bed
* `karaoke` — Instrumental + backing vocals mix
* `lead_vocals`, `backing_vocals` — Standard vocal stems
* `lead_vocals_<N>`, `backing_vocals_<N>` (N ≥ 2) — Extra generic vocal lanes
* `vocal_<id>` — Named per-voice stems

Always use the exact URLs returned by `GET /api/songs/{song_id}`.

---

### Lyrics, Queue, History & System Endpoints

| Method + Path | Auth | Description |
| --- | --- | --- |
| `GET /api/lyrics?artist=&title=` | session | Fetch lyrics from opt-in provider (`503` unless `KARAOKE_LRCLIB=1`) |
| `GET /api/songs/{id}/lyrics` | session | List all lyric sets for a song |
| `GET /api/songs/{id}/lyrics/cache` | session | Check cached raw transcription status |
| `POST /api/songs/{id}/lyrics` | session | Create a new lyric set (`201`) |
| `GET`/`PATCH`/`DELETE /api/songs/{id}/lyrics/{lid}` | session | Read, edit, or delete a lyric set |
| `POST /api/songs/{id}/lyrics/{lid}/activate` | session | Set as the active playback lyric set |
| `POST /api/songs/{id}/lyrics/{lid}/verify` | session | Mark lyric set as verified reference |
| `POST /api/songs/{id}/lyrics/{lid}/copy` | session | Duplicate a lyric set (`201`) |
| `POST /api/songs/{id}/lyrics/transcribe` | session | Queue a fresh transcription job (`202`; requires `ready` song) |
| `POST /api/songs/{id}/lyrics/realign` | session | Queue an align-only job using cached transcription (`202`) |
| `POST /api/songs/{id}/lyrics/{lid}/page` | session | Queue LLM page grouping over an existing set (`202`) |
| `GET` / `POST` / `DELETE /api/queue` | session | List, append (`song_id`, `singer_name`), or clear the host queue |
| `PUT /api/queue/order` | session | Reorder the host queue |
| `DELETE /api/queue/{entry_id}` | session | Remove one queue entry (dequeue-on-play) |
| `GET` / `POST` / `DELETE /api/history` | session | List, record (`201`), or clear play history |
| `POST /api/history/{id}/complete` | session | Mark a history row completed when playback finishes |
| `GET` / `PUT /api/history/settings` | session | Read or update `retention_days` (default `30`, `0` = forever) |
| `POST /api/import/cdg` | session | Import a `.cdg` or same-basename MP3+G `.zip` (max 550 MB / 30 min) |
| `GET /api/export/songs/{id}` | session | Export song as MP3+G `.zip` (`?format=mp3g`) or `.cdg` (`?format=cdg`) |
| `GET` / `PUT /api/export/settings` | session | Read or update export settings (attribution card toggle) |
| `GET /api/features` | session | Operator capability flags (`lrclib`, `llm_paging`, CD+G export) |
| `GET /api/catalog/providers` | session/guest | List installed catalog provider plugins |
| `GET /api/auth/config` | open | Active auth mode and `password_required` boolean |
| `POST /api/auth/gate` / `POST /api/auth/lock` | open | Unlock or lock session cookie |
| `GET /api/auth/me` | session | Current session identity (`401` when locked) |
| `GET /health` / `GET /api` | open | Health check and top-level endpoint map |

---

## `curl` Examples

```bash
# 1. Unlock session (only needed if KARAOKE_GATE_PASSWORD is set)
curl -c cookies.txt -X POST http://localhost:8000/api/auth/gate \
  -H "Content-Type: application/json" \
  -d '{"password": "your-gate-password"}'

# 2. Upload a song for separation & sync
curl -b cookies.txt -X POST http://localhost:8000/api/separate \
  -F "file=@/path/to/song.mp3" \
  -F "artist=Radiohead" \
  -F "title=Creep"

# 3. Poll job progress until done
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

```bash
# From the repository root
python -m pip install -e './lyricsync[whisper,metaphone,levenshtein]'
python -m pip install -e './backend[dev]'
cd backend && python -m pytest -q
```

(Note: `tests/test_lifespan_route_mounting.py` tests route mounting when `backend/static/` is absent, so run it on a clean tree or without a deployed frontend in `backend/static/`.)
