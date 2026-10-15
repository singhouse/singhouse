# Singhouse Frontend

Vue 3 single-page application for the Singhouse host interface, Web Audio stem mixer, word-timing lyrics editor, and canvas projector stage.

## Requirements & Quick Start

Requires **Node.js 22+** (matching package metadata) and a running backend API on `http://localhost:8000` (see [`backend/README.md`](../backend/README.md)).

```bash
cd frontend
npm ci
npm run dev
```

Open **http://localhost:5173** in your browser. The Vite dev server proxies `/api` requests to `localhost:8000` automatically.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite dev server with hot reload on port 5173 |
| `npm test` | Run Vitest unit tests (`happy-dom`) and pure-function stage renderer tests |
| `npm run lint` | Run linter checks |
| `npm run build` | Standard Vite production build → `dist/` |
| `npm run deploy` | Build a named, sourcemap-free assembly and mirror it to `../backend/static/` |
| `npm run preview` | Preview the production build locally |

## Project Structure

```
frontend/src/
├── main.js                  # App bootstrap (Vue 3, Pinia, Vue Router)
├── api/
│   └── client.js            # Axios client + namespaced API modules (songApi, lyricsSetsApi,
│                            #   queueApi, historyApi, featuresApi, sessionApi)
├── auth/
│   └── gate.js              # Route guard for the optional shared host password
├── router/
│   └── index.js             # Routes: / (HostShell), /songs/:songId/lyrics-editor/:setId?,
│                            #   /unlock, and dev-only /lab/editor
├── stores/                  # Pinia stores
│   ├── songs.js             # Library state, upload/import submission, job polling
│   ├── player.js            # Playback transport, per-stem mixer levels, key-shift offset
│   ├── queue.js             # Host queue (append, drag-reorder, remove, clear, dequeue-on-play)
│   ├── history.js           # Play history list + retention settings
│   ├── features.js          # Operator capability flags from GET /api/features
│   ├── hostSettings.js      # Host UI and stage display preferences
│   └── session.js           # Auth/gate session status
├── composables/
│   ├── useAudioEngine.js    # Web Audio API gain graph + Signalsmith Stretch pitch-shift worklet
│   └── useLyricsWindow.js   # Popout projector window manager + BroadcastChannel heartbeat
├── stage/                   # Clean-room 2D canvas stage renderer
│   ├── adapter.mjs          # Normalizes v1/v2 backend word_sync JSON into stage models
│   ├── frame.mjs            # Pure function `describeFrame(model, time, viewport)` (640x360 space)
│   ├── layout.mjs           # Line layout, syllable geometry, and font sizing
│   ├── draw.mjs             # Paints frame descriptors onto a 2D canvas context
│   ├── visualizers/         # Ambient background canvas visualizers
│   └── KaraokeStage.vue     # Vue wrapper binding player time to the canvas renderer
├── editor/                  # Word-timing editor state and timeline internals
├── components/              # UI components (AudioPlayer, MixerPopover, QueuePanel,
│                            #   HistoryModal, LyricsEditor, SongList, UploadZone, ScreenStage, …)
└── views/
    ├── HostShell.vue        # Primary host workspace (library, queue, player, inline stage)
    ├── LyricsEditorView.vue # Full-page word-timing and lyric set editor
    ├── UnlockView.vue       # Shared-password unlock screen
    └── EditorLab.vue        # Dev-only editor playground (excluded from production builds)
```

## Key Subsystems

### Web Audio Mixer & Pitch Shift (`useAudioEngine.js`)

Each stem (`instrumental`, `lead_vocals`, `backing_vocals`, plus any dynamic `vocal_<id>` per-voice lanes) is loaded as a synchronized `<audio>` element routed through a Web Audio gain graph.

* When key shift is `0`, audio routes directly through the gain nodes.
* When key shift is non-zero (**±12 semitones**), a **Signalsmith Stretch** WebAssembly `AudioWorkletNode` is dynamically inserted per stem to transpose pitch at constant tempo, with reported worklet latency compensated automatically.

### Canvas Stage & Popout Projector (`stage/`, `useLyricsWindow.js`)

The stage display uses a pure functional core tested against golden frame fixtures (`tests/stage-harness/`).

* The projector is **not** a separate SPA route—it is a same-origin `window.open` popup driven directly from the host context.
* A `BroadcastChannel` heartbeat and an injected watchdog script ensure that if the host window reloads or closes, any orphaned popout window closes automatically.

## Production Deployment (`npm run deploy`)

When serving the frontend directly from the FastAPI backend, run:

```bash
npm run deploy
```

`scripts/deploy.sh` builds a named assembly under `frontend/deploy/<UTC-timestamp>-g<sha>[-dirty]-<mode>/`, strips all sourcemaps, verifies the destination path (`KARAOKE_DEPLOY_TARGET`, default `../backend/static`), and syncs the build with `rsync --delete`. Build provenance is recorded in `backend/deploy-manifest.json` alongside (never inside) the public `static/` directory, and the three most recent assemblies are kept for rollback.
