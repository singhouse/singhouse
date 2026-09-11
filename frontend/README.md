# Frontend

A polished Vue 3 web player for karaoke tracks with vocal/instrumental mixing and synced lyrics.

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

## Requirements

- Node.js ≥ 18
- Backend API running on `localhost:8000` (see `backend/`)

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (hot reload) on port 5173 |
| `npm run build` | Production build → `dist/` |
| `npm run deploy` | Build a named, sourcemap-free assembly and publish it to the backend's `static/` |
| `npm run preview` | Preview the production build |

## Project Structure

```
src/
├── App.vue              # Root layout: sidebar + lyrics area
├── main.js              # App bootstrap (Vue + Pinia)
├── assets/
│   └── styles.css       # Global styles + Tailwind
├── api/
│   └── client.js        # Axios instance + all API calls
├── stores/
│   └── songs.js         # Pinia store (songs, uploads, player state)
└── components/
    ├── UploadZone.vue   # Drag-drop upload with progress
    ├── SongList.vue     # Library with filter tabs
    ├── AudioPlayer.vue  # Player with Web Audio API mixer
    ├── ScreenStage.vue  # Projector/preview stage (canvas lyrics + overlays)
    └── ProgressBar.vue  # Seekable progress bar
```

## Features

### Upload Zone
- Drag and drop or click to browse
- Accepts MP3, FLAC, WAV, M4A, OGG (up to 500MB)
- Live upload progress bar
- Real-time job status polling until stems are ready

### Song Library
- Filter by status: All / Ready / Processing / Failed
- One-click load into player
- Delete with confirmation dialog

### Audio Player
- **Web Audio API** for zero-latency mixing
- Play / Pause / Stop controls
- Seekable progress bar with drag support
- **Mixer sliders** for:
  - 🎤 Lead Vocals (default: 100%)
  - 🎶 Backing Vocals (default: 70%)
  - 🎸 Instrumental (default: 100%)
- Mute toggle per track (click the emoji)
- Smooth 50ms gain ramp on volume changes
- Lyrics timing offset control (±ms)

### Lyrics Display
Three display modes based on what's available:

1. **Word-level sync** (Whisper JSON) — word-by-word karaoke fill animation
2. **LRC sync** (line-level) — highlight + scroll current line
3. **Plain text** — static lyrics display
4. **None** — graceful fallback

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` | Seek back 5s |
| `→` | Seek forward 5s |
| `Shift+←` | Seek back 30s |
| `Shift+→` | Seek forward 30s |
| `Home` | Stop / Reset |

## API Integration

The frontend proxies all `/api` requests to the backend (configured in `vite.config.js`).

### Expected Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/songs` | GET | List all songs |
| `/api/songs/:id` | DELETE | Delete a song |
| `/api/separate` | POST | Upload + start separation |
| `/api/jobs/:id` | GET | Poll job status |
| `/api/lyrics` | GET | Fetch lyrics (`?artist=X&title=Y`) |
| `/api/health` | GET | Health check |

### Song Object Shape

```json
{
  "id": "uuid",
  "title": "Example Song",
  "artist": "Example Artist",
  "duration": 244.5,
  "status": "ready",
  "vocals_url": "/stems/example-song/lead_vocals.wav",
  "backing_url": "/stems/example-song/backing_vocals.wav",
  "instrumental_url": "/stems/example-song/karaoke.wav"
}
```

### Lyrics Object Shape

```json
{
  "synced": "[00:12.34] Line one text\n[00:15.00] Line two text",
  "plain": "Line one text\nLine two text"
}
```

Or a Whisper JSON with `segments[].words[]`:
```json
{
  "segments": [
    {
      "words": [
        { "word": "Hello", "start": 1.2, "end": 1.6 },
        { "word": "world", "start": 1.7, "end": 2.1 }
      ]
    }
  ]
}
```

## Styling

- **Dark theme** inspired by the original test-player
- **Glassmorphism** sidebar with blur
- **Tailwind CSS** utility classes throughout
- Custom range inputs with cobalt glow thumb
- Smooth CSS transitions for all state changes

## Development Notes

### Offline / No Backend

The app works without a backend — it shows the welcome screen and silently swallows API errors. You can test the player by temporarily hardcoding a `currentSong` in `App.vue` pointing to local stem files.

### CORS

The Vite dev server proxies `/api` → `localhost:8000`, so no CORS config needed during development.

### Production Build

```bash
npm run deploy
```

The backend serves the built app itself, so `npm run deploy` is the whole
procedure. It builds into a **named assembly** under
`deploy/<UTC-timestamp>-g<commit>[-dirty]-<mode>/` — a dated, identifiable
artifact, so `dist/` keeps its plain `npm run build` meaning — then publishes
that assembly into `../backend/static/` with `rsync --delete`, which removes
files the new build no longer contains instead of leaving them to pile up.
**Sourcemaps are never published**: they reconstruct the original source, so
they are stripped from the assembly and the publish is refused if any survive.
The three newest assemblies are kept on disk for a quick roll-back.

Two environment variables adjust it: `KARAOKE_DEPLOY_TARGET` for the publish
destination, and `KARAOKE_DEPLOY_MODE` (`core` or `multi`) for the build
variant — unset, the mode is derived from what the checkout contains. Because
the publish mirrors, the target is validated first and the script refuses
anything that does not already look like a published frontend.

If you would rather serve the build yourself, `npm run build` still produces a
plain `dist/` you can hand to any static file server — Vite emits a
single-page app with content-hashed asset names.
