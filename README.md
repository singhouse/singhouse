<p align="center">
  <img src="docs/images/singhouse-logo.png" alt="Singhouse" width="425" height="180">
</p>

**Turn your music into karaoke with AI.**

Singhouse automatically generates karaoke tracks from your own audio files:
AI separates the vocals, transcribes the lyrics, and synchronizes the words
for sing-along highlighting. Generate and play on your own machine in one
desktop app.

**[Download v0.1.0](https://github.com/singhouse/singhouse/releases/tag/v0.1.0)**
· [Installation guide](docs/install-desktop.md)
· [Documentation](#documentation)

## From music to karaoke

1. **Import your music.** Choose an audio file from your library.
2. **Let AI prepare it.** Separate instrumental, lead, and backing vocals,
   then generate lyrics with word-level timing. Reference lyrics are optional.
3. **Sing.** Turn down the lead vocal, keep as much backing vocal as you like,
   adjust the key, and put the lyrics on the projector window.

AI results can need corrections; use the lyric editor to fix words and timing.

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

## What you can do

- **Bring your library.** Import your own FLAC, MP3, WAV, M4A, or OGG files,
  plus CD+G files and MP3+G ZIPs.
- **Shape the sound.** Adjust vocal and instrumental volumes independently.
  Change key without changing the tempo.
- **Run the queue.** Manually arrange who sings next and revisit play history.
- **Give singers a screen.** Open the popout projector window on a second
  display while keeping the host controls on your main screen.

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
