<p align="center">
  <img src="docs/images/singhouse-logo.png" alt="Singhouse" width="425" height="180">
</p>

**Turn your music into karaoke with AI.**

A self-hosted karaoke suite for your own music library — Local stem separation (CUDA / Metal / CPU),
word-level synced lyrics, and a web player with real-time vocal/instrumental
mixing, key shift, and a popout projector display.

**[Download v0.1.0](https://github.com/singhouse/singhouse/releases/tag/v0.1.0)**
· [Installation guide](docs/install-desktop.md)
· [Documentation](#documentation)

## What It Does

1. **Import a track from your library** — FLAC, MP3, WAV, M4A, OGG,
   CDG, or MP3+G
2. **Backing vocal stem seperation** — Demucs splits vocals and
   instrumentals, then mel_band_roformer splits lead and backing vocals.
   Runs locally on your own hardware, or optionally on your own Modal account
   for faster processing.
4. **Generate synced lyrics** — paste your own reference lyrics, or enable 
   automatic lrclib.net lookup. With accurate source lyrics, transcriptions are
   generally quite usable on a single pass.
6. **Word-level highlighting** — Whisper + heart-transcriptor lyrics transcription 
   aligned to your reference lyrics, with a built-in lyric timing editor
7. **Real-time mixer** — Built-in key shift, and individual volume sliders
   for instrumental, backing vocals, and lead vocals. Additional voices are
   also supported for imported tracks
9. **Stage display** — a canvas lyrics renderer with a pop-out projector/TV
   window for the second screen
10. **Host queue** — a simple, manually ordered "who sings next" list built
   from your library, plus a flat play history

## Download

**v0.1.0 is a prerelease.** It has been tested on one machine per platform,
but not at a live show with a physical projector. CUDA processing is untested.
Read the
[release notes and known limitations](https://github.com/singhouse/singhouse/releases/tag/v0.1.0)
before relying on it for a show.

| Platform | Download from the release page |
| --- | --- |
| Windows 11, x64 | [.exe installer](https://github.com/singhouse/singhouse/releases/tag/v0.1.0) |
| macOS 14+, Apple silicon | [.dmg installer](https://github.com/singhouse/singhouse/releases/tag/v0.1.0) |
| Linux, x64 | [AppImage or archive](https://github.com/singhouse/singhouse/releases/tag/v0.1.0) |

The desktop app includes Python and FFmpeg. You don't need Docker, Node.js,
or a system Python installation. Check the release's platform notes and
checksums, then follow the [installation guide](docs/install-desktop.md).

## Your first song

1. Install and launch the desktop app.
2. Install the processing runtime and models through **Set up song processing**.
   These separate downloads require your consent; availability depends on
   your platform.
3. Select your audio file, optionally paste reference lyrics to guide
   generation, and submit it for processing. Once it finishes, check the
   generated lyrics and timing in the lyric editor.
4. Add the song to the queue, set the mix and key, and open the projector
   window if you have a second display.

Already have prepared karaoke media? Import it and go straight to playback;
you don't need an AI processing pack.

Singhouse runs on one host machine. The projector is a window on that
machine; this release does not include a guest-phone interface.

## Your library, your machine

Bring media and lyrics you have the right to use. Singhouse includes no songs,
centralized catalog, lyrics database, or music acquisition tools. It provides
no stem or lyric sharing between installs, and the project does not host,
store, or transmit your audio, stems, or synced lyrics on its infrastructure.

Separation and transcription run locally by default. Optional network features
require configuration: lrclib.net lookup is **off by default** and sends artist
and title; LLM cleanup sends lyric text to your chosen endpoint; GPU offload
sends audio to [your own Modal deployment](docs/modal.md). Optional services
use your accounts and may incur charges. The stock configuration sends no
telemetry.

## Documentation

| Looking for… | Start here |
| --- | --- |
| Desktop installation and platform requirements | [Installation guide](docs/install-desktop.md) |
| Startup problems and diagnostic information | [Support diagnostics](docs/support-diagnostics.md) |
| Processing through your own cloud account | [Modal setup](docs/modal.md) |
| Importing from your own Plex media server | [Plex setup](docs/plex.md) |
| Running or developing the backend | [Backend guide](backend/README.md) |
| Developing the player and host interface | [Frontend guide](frontend/README.md) |
| Building the desktop app | [Desktop developer guide](desktop/README.md) |
| Transcription and lyric alignment | [lyricsync guide](lyricsync/README.md) |

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for project scope and the current
contributor-intake status.

Singhouse is licensed under **[AGPL-3.0-only](LICENSE)**, without the
“or any later version” option. The [`lyricsync`](lyricsync/) alignment library
is additionally available under the [MIT License](lyricsync/LICENSE).
Third-party licenses and attribution are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
