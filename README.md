<p align="center">
  <img src="docs/images/singhouse-logo.png" alt="Singhouse" width="425" height="180">
</p>

A self-hosted karaoke suite for your own music library — local stem separation (CUDA / Metal / CPU),
word-level synced lyrics, and a web player with real-time vocal/instrumental
mixing, key shift, and a popout projector display.

AI models automatically separate vocals and generate timed lyrics from imported audio.

**[Download v0.1.1](https://github.com/singhouse/singhouse/releases/tag/v0.1.1)**
· [Installation guide](docs/install-desktop.md)
· [Documentation](#documentation)

## What It Does

1. **Import tracks from your library** — FLAC, MP3, WAV, M4A, OGG, AAC,
   CDG, or MP3+G (or import directly from your [Plex server](docs/plex.md)).
2. **Backing vocal stem separation** — Demucs (`mdx_extra`) splits vocals and
   instrumentals, then `mel_band_roformer` splits lead and backing vocals.
   Runs locally on your own hardware, or optionally on your own Modal account
   for faster processing.
3. **Generate synced lyrics** — Paste your own reference lyrics, or enable
   automatic lrclib.net plain-text lookup. With accurate source lyrics,
   transcriptions are generally usable on a single pass.
4. **Sub-100ms word-level highlighting** — Whisper / HeartTranscriptor
   transcription paired with needleman-wunsch phonetic alignment and multi-model
   CTC acoustic re-timing, plus a built-in lyric timing editor.
5. **Real-time mixer** — Built-in ±12 semitone key shift and individual volume
   sliders for instrumental, backing vocals, and lead vocals. Additional
   per-voice lanes are also supported for multi-vocal tracks.
6. **Stage display** — A canvas lyrics renderer with a popout projector/TV
   window for a second screen, plus MP3+G / CD+G export.
7. **Host queue** — A simple, manually ordered "who sings next" list built
   from your library, plus a flat play history.

## Multi-Model Acoustic Word Timing

Standard speech-to-text models drift on sung vocals and struggle with sustained notes or instrumental gaps. Singhouse's bundled [`lyricsync`](lyricsync/) pipeline combines transcription with an ensemble **CTC Acoustic Fusion Aligner**:

1. **Transcription & Phonetic Matching:** Audio is segmented with RMS-VAD, transcribed via `HeartTranscriptor` (a music-tuned Whisper model) or `faster-whisper`, and aligned against plain reference lyrics using Needleman-Wunsch dynamic programming with Enhanced Levenshtein and Double Metaphone phonetic scoring.
2. **CTC Acoustic Re-Timing:** Every word is force-aligned against the isolated vocal stems using up to four license-clean CTC acoustic models (`HuBERT-Large`, `wav2vec2-Large`, `HuBERT-XLarge`, and an optional `wav2vec2` phoneme voter) via a Viterbi pass with inter-word filler states.
3. **Median Voter Fusion:** Word boundaries are fused across the acoustic voters and initial transcript timings, flagging any low-confidence words where voters disagree by >200 ms.

Because acoustic force-alignment against plain text is so precise, Singhouse deliberately ignores third-party LRC line timestamps during upload alignment—avoiding the offset drift common in community LRC files.

| Benchmark Scenario | Baseline (Whisper + NW) | With CTC Acoustic Fusion | Gain (Words within ±100 ms) |
| --- | --- | --- | --- |
| **Single-voice** (Jamendo, 20 songs, plain lyrics) | 52.5% | **86.3%** | **+33.8 pp** |
| **Multi-voice** (55 songs, plain lyrics via LRCLIB) | 47.9% | **69.9%** | **+22.0 pp** (55/55 songs improved) |
| **No reference lyrics** (Jamendo, raw audio only) | 46.4% | **69.5%** | **+23.1 pp** |

*(Note: CTC acoustic re-timing is enabled by default in source/server installs with CUDA and is coming to packaged desktop processing packs in an upcoming release.)*

## Installation

| Platform | Download from the release page |
| --- | --- |
| Windows 11, x64 | [.exe installer](https://github.com/singhouse/singhouse/releases/tag/v0.1.1) |
| macOS 14+, Apple silicon | [.dmg installer](https://github.com/singhouse/singhouse/releases/tag/v0.1.1) |
| Linux, x64 | [AppImage or archive](https://github.com/singhouse/singhouse/releases/tag/v0.1.1) |

The desktop app bundles Python and FFmpeg. See the
[installation guide](docs/install-desktop.md) for system requirements and installation
instructions.

## Track Generation Setup

Existing karaoke files (MP3+G, CDG, or pre-separated tracks) can be imported
and played immediately without an AI processing pack.

At first launch (or via **Settings → Song processing…**), a setup wizard walks
you through configuring track generation. With your permission, **Set up song
processing** downloads and verifies a bundled processing runtime and model weights
from their upstream sources. Source and server installations can also offload GPU
processing to [your own Modal account](docs/modal.md).

## Documentation

- [Desktop installation](docs/install-desktop.md)
- [Architecture & project reference](PROJECT_DOCS.md)
- [Processing on your own Modal account](docs/modal.md)
- [Importing from your Plex server](docs/plex.md)
- [Backend development & API reference](backend/README.md)
- [Frontend development](frontend/README.md)
- [Building the desktop app](desktop/README.md)
- [Transcription and alignment with `lyricsync`](lyricsync/README.md)
- [How alignment works (`lyricsync` design)](lyricsync/ALIGNMENT.md)

## Privacy

Track generation in Singhouse runs entirely locally on your machine by default.
The project does not host, store, or transmit your audio, stems, or synced lyrics.
Singhouse includes no music catalog, lyrics database, acquisition tools, or
sharing between installations. Use media and lyrics you have the right to use.

An optional [lrclib.net](https://lrclib.net) integration is available for automatic
lookup of plain reference lyrics. Lookup is **off by default** and sends only artist
and title when enabled. The optional Modal integration sends audio only to
[your own Modal deployment](docs/modal.md) through your own configured account.

## License

Singhouse is licensed under **[AGPL-3.0-only](LICENSE)**. The
[`lyricsync`](lyricsync/) alignment library is additionally available under the
[MIT License](lyricsync/LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md)
and [native desktop notices](desktop/NATIVE_NOTICES.md) for dependencies and
attribution, and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution policy.
