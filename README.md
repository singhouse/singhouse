<p align="center">
  <img src="docs/images/singhouse-logo.png" alt="Singhouse" width="425" height="180">
</p>

A self-hosted karaoke suite for your own music library — Local stem separation (CUDA / Metal / CPU),
word-level synced lyrics, and a web player with real-time vocal/instrumental
mixing, key shift, and a popout projector display.

AI models automatically separate vocals and generate timed lyrics from imported audio.

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

## How it works

Generation runs in three stages:

1. **Separate the audio.** Demucs separates vocals from the instrumental.
   A second model, mel_band_roformer by default, splits the vocals into lead
   and backing tracks, so each can be adjusted independently during playback.
2. **Transcribe the vocals.** Heart transcribes the separated lead vocal,
   producing words and timestamps from the recording.
3. **Align the lyrics.** If you supply reference lyrics, lyricsync aligns them
   to the transcription's timing. Without a reference, it uses the transcribed
   words. Timing comes from your recording in either case.

The player combines the resulting audio stems with word-level lyric
highlighting. You can correct words and timing in the lyric editor afterward.

## Installation

| Platform | Download from the release page |
| --- | --- |
| Windows 11, x64 | [.exe installer](https://github.com/singhouse/singhouse/releases/tag/v0.1.0) |
| macOS 14+, Apple silicon | [.dmg installer](https://github.com/singhouse/singhouse/releases/tag/v0.1.0) |
| Linux, x64 | [AppImage or archive](https://github.com/singhouse/singhouse/releases/tag/v0.1.0) |

The desktop app bundles Python and FFmpeg. See the
[installation guide](docs/install-desktop.md) for platform requirements and setup.

## Processing setup

**Set up song processing** installs the processing runtime and models as
separate downloads, with your permission. Available processing packs depend on
your platform.

Prepared karaoke media can be imported and played without an AI processing pack.

## Documentation

- [Desktop installation](docs/install-desktop.md)
- [Support and diagnostics](docs/support-diagnostics.md)
- [Processing on your own Modal account](docs/modal.md)
- [Importing from your Plex server](docs/plex.md)
- [Backend development](backend/README.md)
- [Frontend development](frontend/README.md)
- [Building the desktop app](desktop/README.md)
- [Transcription and alignment with lyricsync](lyricsync/README.md)

## Privacy

Processing runs locally by default, with no telemetry in the stock configuration.
The project does not host, store, or transmit your audio, stems, or synced lyrics.
Singhouse includes no music catalog, lyrics database, acquisition tools, or
sharing between installations. Use media and lyrics you have the right to use.

Optional integrations require configuration: lrclib.net lookup is **off by
default** and sends artist and title; LLM cleanup sends lyric text to your chosen
endpoint; GPU offload sends audio to [your own Modal deployment](docs/modal.md).
These services use your accounts and may incur charges.

## License

Singhouse is licensed under **[AGPL-3.0-only](LICENSE)**. The
[`lyricsync`](lyricsync/) alignment library is additionally available under the
[MIT License](lyricsync/LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md)
for dependencies and attribution, and [CONTRIBUTING.md](CONTRIBUTING.md) for the
current contribution policy.
