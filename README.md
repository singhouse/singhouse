# Singhouse

A self-hosted karaoke suite for your own music library — GPU stem separation,
word-level synced lyrics, and a web player with real-time vocal/instrumental
mixing, key shift, and a popout projector display.

## What It Does

1. **Import a track from your library** — FLAC, MP3, WAV, M4A, OGG
2. **Two-pass stem separation** — Demucs (`mdx_extra`) splits vocals vs.
   instrumental, then mel_band_roformer splits lead vs. backing vocals.
   Runs locally on your GPU (CPU fallback), or on your own Modal deployment
3. **Synced lyrics** — paste your own reference lyrics, or enable the
   optional lrclib.net lookup (opt-in, off by default)
4. **Word-level highlighting** — ML transcription aligned to your
   reference lyrics, with a built-in lyric timing editor
5. **Real-time mixer** — per-stem volume and mute, per-voice vocal lanes,
   and key shift (pitch transposition without tempo change)
6. **Stage display** — a canvas lyrics renderer with a popout projector
   window for the second screen
7. **Host queue** — a simple, manually ordered "who sings next" list built
   from your library, plus a flat play history

## Scope — what this is, and what it isn't

"Karaoke software" covers a lot of ground. This project deliberately occupies
a narrow part of it, and the boundaries below are design constraints, not a
roadmap gap.

**What it does.** Singhouse takes audio files that are already on the machine
you run it on, separates them into stems, transcribes the vocal, and aligns
that transcription to reference lyrics you supply — so the words highlight in
time while you sing. Then it plays the result: per-stem mixing, key shift, a
queue, and a projector window for the second screen.

**What it does not do:**

- **It does not find, download, or rip music, and ships no integration that
  does.** No search-the-internet feature, no ripper, no downloader. This is a
  line the project does not cross, not a feature it hasn't gotten to yet.
- **It ships no catalog and no index.** There is a documented plugin seam a
  self-hoster can extend to import from a source they already hold an account
  with — and this project ships **zero** such plugins, so out of the box the
  only songs in your install are the files you put there.
- **Nothing you import is sent to us.** Your audio, your stems, your lyrics
  and your timings are written to your own disk. This project operates no
  servers and receives none of it — there is nothing to opt out of, because
  there is nothing to send. Separation and transcription run locally by
  default; if you point them at your own Modal
  account, that is **your** deployment, under your account, and we are not in
  the path.
- **It is one machine running one show.** There is no guest-phone surface and
  no second-screen page to serve — the projector is a popout window on the
  host machine itself. So there is nothing here that wants to be on the public
  internet, and no helper is shipped for putting it there. You can reach the
  host UI from another device on your own LAN; be aware that the host UI is
  full control, and it is ungated until you set a gate password
  (`KARAOKE_GATE_PASSWORD`).
- **It does not ship a lyrics database.** You paste your own reference lyrics.
  A lookup against [lrclib.net](https://lrclib.net) is available as an
  **opt-in** setting that is **off by default** (`KARAOKE_LRCLIB`); with it
  unset — the shipped state — this install never contacts lrclib, and the
  lookup endpoint answers 503. Turning it on is a deliberate act.
- **Optional network features stay off until you configure them.** The lrclib
  lookup above sends an artist and title. Optional LLM cleanup sends lyric text
  to the endpoint in `KARAOKE_LLM_BASE_URL`. Optional GPU offload sends audio
  to an app in your own Modal account. Plex import reads only the media server
  address you enter. The stock configuration enables none of these and sends
  no telemetry.
- **It does not share anything between users.** No stem sharing, no lyric
  sharing, no accounts on our infrastructure. Two installs have no way to
  reach each other.

**What you supply.** Everything. This is a tool for working with a library you
already have, on hardware you already control. It assumes you have the music
and the right to use it; sorting that out is yours, and the software makes no
attempt to help you get music you don't have.

## Architecture

```
Audio import → Demucs + mel_band_roformer (stem separation) → Whisper (word timestamps)
                                                                       ↓
                                                     reference lyrics (pasted, or opt-in lookup)
                                                                       ↓
                                                        Needleman-Wunsch alignment
                                                                       ↓
                                                    Word-level synced karaoke display
```

### Tech Stack

| Component | Tech |
|-----------|------|
| **Backend** | FastAPI, SQLAlchemy (async), aiosqlite, Alembic migrations |
| **Frontend** | Vue 3, Pinia, Vue Router, Web Audio API, Vite, TailwindCSS |
| **Stem Separation** | Demucs (`mdx_extra`) + mel_band_roformer via python-audio-separator |
| **Word Sync** | `lyricsync` library: faster-whisper (or an optional fine-tuned transcriber you supply) + Needleman-Wunsch alignment |
| **Lyrics** | Your own pasted text; optional lrclib.net lookup (opt-in, off by default) |

## Requirements

- **Python 3.12+** for the backend
- **Node.js 18+** to build or develop the frontend
- **ffmpeg** on `PATH` (stem mixing)
- A CUDA-capable **GPU is recommended** for local separation — CPU works but
  is roughly 10× slower

## Quick Start

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate

# The bundled word-sync library, then the backend itself.
# Installing the backend also puts the kb-* console scripts on your PATH.
pip install -e '../lyricsync[whisper,metaphone,levenshtein]'
pip install -e .

# Stem separation runs in its own venv (Demucs needs torch/torchaudio)
python -m venv .venv-demucs
.venv-demucs/bin/pip install demucs torch torchaudio 'audio-separator[cpu]'
```

Set up the database (SQLite, managed by Alembic migrations):

```bash
kb-db status         # read-only: shows the resolved DB path and what would happen
kb-db upgrade --yes  # bring the schema to head
```

(On a fresh database the server also migrates automatically at startup;
`kb-db` is the explicit, operator-controlled path.)

Start the server:

```bash
python -m uvicorn karaoke_backend.main:app --host 0.0.0.0 --port 8000
```

Interactive API docs: `http://localhost:8000/docs`

### 2. Frontend

```bash
cd frontend
npm install
npm run dev     # dev server on http://localhost:5173
```

For production, `npm run build` and serve the build output from
`backend/static/` (the backend serves it as an SPA at `/`).

### 3. Open

Navigate to `http://localhost:5173` (dev) or `http://localhost:8000` (served
build). For other devices on your LAN, set `BASE_URL` to the host's address
(e.g. `BASE_URL=http://192.168.1.42:8000`) so stem URLs resolve correctly,
and open that address.

## Import from your Plex library

If you already run a Plex media server, you can add songs to Singhouse from
the music library on it instead of uploading files one at a time. Open the
host sidebar's 🎞 button, point it at your server, and pick tracks from your
own collection.

**Setting it up.** Enter your server's base URL (e.g.
`http://plex.lan:32400`) and a Plex token, then press *Test connection*. The
token is a credential for your whole library, so it is never stored in the
database and never sent back to the browser: it is written to a `0600` file
(`.plex_token`) next to `karaoke.db`. Leaving the token box blank on a later
save keeps the one you already stored; clearing it deletes the stored token.

An operator who prefers to configure this outside the UI can set
`KARAOKE_PLEX_URL` and `KARAOKE_PLEX_TOKEN` in the environment instead. When
either is set, the environment wins and the in-app fields become read-only.

**What an import does.** Each selected track becomes a normal song: the audio
is COPIED — never moved, never linked — into this install's uploads folder and
then goes through the same separation and sync pipeline an uploaded file does.
Your library file is only ever read. When this install can see the library's
storage directly (the same box, or the same mount), the copy is taken straight
off disk; otherwise the track is streamed from the server. If the two
disagree about paths — a container's `/media` is the host's `/srv/music` —
`KARAOKE_PLEX_PATH_MAP="/media=>/srv/music"` states the correspondence.

**Lyrics are a separate, opt-in question.** Tracks with lyrics on the server
are marked ♪ in the list, but that text is NOT used as an alignment reference
unless you set `KARAOKE_PLEX_LYRICS=1`. The audio is your own file; lyrics on
a media server may have come from a licensed metadata supplier, and whether
they may be reused here is a call for you to make rather than a default.

## How Word-Level Sync Works

The word-level lyrics pipeline combines two sources:

1. **Reference lyrics** — your own pasted text (or the opt-in lrclib.net
   lookup), used verbatim for display
2. **Whisper transcription** — word-level timestamps from the separated
   vocals stem (often wrong text, but good timing)

The **LRC-anchored hybrid approach**:
- LRC line timestamps are used as anchors when available
- Whisper word timestamps are matched within each line window
- Words with Whisper matches get precise per-word timing
- Words without matches get interpolated timing
- Reference lyrics text is always what gets displayed

Every song can hold multiple lyric sets (reference, transcription, manual
edits); the word-timing editor lets you fix alignment by hand.

## Project Structure

```
singhouse/
├── backend/
│   ├── src/karaoke_backend/
│   │   ├── main.py           # FastAPI entry point (karaoke_backend.main:app)
│   │   ├── api/              # Routers: songs, separate, lyrics, lyrics_sets,
│   │   │                     #   queue, history, catalog, features, gate
│   │   ├── models/           # SQLAlchemy models (Song, Job, LyricsSet,
│   │   │                     #   QueueEntry, PlayHistory, AppSetting)
│   │   ├── jobs/             # Durable SQLite job queue + handlers
│   │   ├── workers/          # Separation / transcription / lyrics workers
│   │   ├── migrations/       # Alembic migration chain
│   │   ├── db/               # Schema bootstrap + migration config
│   │   └── cli.py            # kb-db schema CLI
│   ├── pyproject.toml        # Package metadata + console scripts
│   └── tests/                # pytest suite
├── frontend/
│   ├── src/
│   │   ├── components/       # AudioPlayer, MixerPopover, QueuePanel,
│   │   │                     #   HistoryModal, SongList, UploadZone, …
│   │   ├── stage/            # Canvas stage renderer (lyrics + visualizers)
│   │   ├── stores/           # Pinia stores (songs, queue, history, player, …)
│   │   ├── views/            # HostShell, LyricsEditorView, UnlockView
│   │   └── composables/      # Audio engine, popout window, …
│   └── tests/                # vitest + stage renderer tests
├── lyricsync/                # Word-level transcription + alignment library
├── docs/                     # Design notes and specs
└── tools/                    # Repo maintenance scripts
```

## API Overview

| Area | Endpoints |
|------|-----------|
| Health | `GET /health` |
| Songs | `GET/PATCH/DELETE /api/songs[/:id]`, `GET /api/songs/:id/stems/:file` |
| Import + separation | `POST /api/separate`, `GET /api/jobs/:id` |
| Lyric sets | `GET/POST/PATCH/DELETE /api/songs/:id/lyrics[/:setId]`, `POST …/transcribe`, `POST …/realign` |
| Lyrics lookup | `GET /api/lyrics?artist=&title=` (503 unless the opt-in lookup is enabled) |
| Queue | `GET/POST/DELETE /api/queue`, `PUT /api/queue/order` |
| Play history | `GET/POST/DELETE /api/history`, `GET/PUT /api/history/settings` |
| Catalog plugins | `GET /api/catalog/providers` |
| Plex library source | `GET/PUT /api/plex/settings`, `POST /api/plex/test`, `GET /api/plex/libraries`, `GET /api/plex/libraries/{key}/tracks`, `POST /api/plex/import` |
| Capabilities | `GET /api/features` |
| Session | `GET /api/auth/config`, `POST /api/auth/gate`, `POST /api/auth/lock`, `GET /api/auth/me` |

## Cost

Everything runs locally by default — no API keys, no cloud bills. Nothing
contacts a third-party lyrics service unless you switch on the optional
lrclib.net lookup (`KARAOKE_LRCLIB=1`); it is off by default.

The optional extras that *can* cost money are yours to enable and yours to
pay for, on your own accounts: offloading GPU work to Modal (`KARAOKE_MODAL`),
and the LLM transcription cleanup (`KARAOKE_LLM_BASE_URL`), which may want an
API key depending on the endpoint you choose. Neither is on in a fresh
install.

See [Deploy processing to your own Modal account](docs/modal.md) for the exact
deploy-time and backend configuration, data flow, and cost controls.

| Processing | Speed (consumer GPU) |
|------------|----------------------|
| Demucs + mel_band_roformer | ~2-4 min/track |
| Whisper word timestamps | ~30-90 sec/track |
| Lyrics lookup (if enabled) | Instant |

## License

**AGPL-3.0-only** — the [GNU Affero General Public License, version 3](LICENSE),
without the "or (at your option) any later version" term. Version 3 is the only
version under which this project is offered.

The [`lyricsync/`](lyricsync/) alignment library is additionally available under
the [MIT License](lyricsync/LICENSE), at your option, so it can be used without
the AGPL's obligations.

Third-party components, and how each one reaches you, are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
