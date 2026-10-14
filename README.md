<p align="center">
  <img src="docs/images/singhouse-logo.png" alt="Singhouse" width="425" height="180">
</p>

<h3 align="center">Self-hosted karaoke for the music library you already own: two-pass stem separation, sub-100ms acoustic lyric sync, and live show hosting.</h3>

<p align="center">
  <a href="https://github.com/singhouse/singhouse/releases/tag/v0.1.1"><strong>Download v0.1.1</strong></a> ·
  <a href="docs/install-desktop.md">Installation Guide</a> ·
  <a href="PROJECT_DOCS.md">Architecture</a> ·
  <a href="lyricsync/ALIGNMENT.md">How Alignment Works</a>
</p>

---

<p align="center">
  <img src="docs/images/host-live.webp" width="850" alt="Singhouse host view: library, live lyrics, and the Up Next singer queue">
  <br>
  <sub>Shown with synthetic demo songs and singers. <a href="https://sing.house#watch">Watch the tour on sing.house</a>.</sub>
</p>

**Singhouse** is a self-hosted karaoke suite—available as a native desktop app or a FastAPI + Vue 3 web server—that turns the music files you already own into **live, multi-stem karaoke tracks** with **word-level synchronized lyrics**, a **real-time Web Audio mixer**, **±12 semitone key shift**, and a **second-screen projector stage**.

Unlike offline video generators that bake stems into a flat `.mp4`, Singhouse keeps every vocal and instrumental stem live during playback—so you can bring lead vocals back in at 25% when a singer loses the melody, mute backing harmonies, or transpose the key on the fly.

## What It Does

1. **Bring your own library** — Import `FLAC`, `MP3`, `WAV`, `M4A`, `OGG`, `AAC`, `CD+G` (`.cdg`), or `MP3+G` archives directly from disk or from your **[Plex media server](docs/plex.md)**.
2. **Two-pass vocal stem separation** — **Demucs (`mdx_extra`)** isolates vocals from the instrumental bed, then **Mel-Band RoFormer** splits **lead vocals** from **backing harmonies**. Runs locally on your hardware (CUDA / Metal / CPU) or on **[your own Modal GPU account](docs/modal.md)**.
3. **Sub-100ms word-level lyric sync** — Powered by the bundled [`lyricsync`](lyricsync/) library. Combines **HeartTranscriptor** (a Whisper-medium model fine-tuned on sung vocals), 3-tier phonetic Needleman-Wunsch alignment, and a **4-model CTC acoustic Viterbi aligner**.
4. **Built-in word-timing editor & CD+G export** — Fine-tune word timings on an interactive timeline, manage multiple lyric sets per song, or export tracks as standard `MP3+G` / `.cdg` files.
5. **Real-time Web Audio mixer** — Independent volume and mute controls for instrumental, backing vocals, lead vocals, and custom per-voice lanes (`vocal_<id>`), plus **±12 semitone pitch shifting** at constant tempo via Signalsmith Stretch.
6. **Second-screen projector display** — A clean-room 2D canvas lyrics renderer with a watchdog-protected popout window for TVs and projectors.
7. **Live show hosting** — A drag-and-drop "who sings next" host queue and flat play history with configurable retention.

---

## Installation

| Platform | Download | Acceleration Support |
| --- | --- | --- |
| **Windows 11** (x64) | **[`.exe` Installer](https://github.com/singhouse/singhouse/releases/tag/v0.1.1)** | NVIDIA CUDA & CPU |
| **macOS 14+** (Apple Silicon) | **[`.dmg` Installer](https://github.com/singhouse/singhouse/releases/tag/v0.1.1)** | Apple Metal & CPU |
| **Linux** (x64) | **[`AppImage` or Archive](https://github.com/singhouse/singhouse/releases/tag/v0.1.1)** | NVIDIA CUDA & CPU |

The desktop app bundles Electron, Python, and FFmpeg—no Docker or system Python required. See the **[Desktop Installation Guide](docs/install-desktop.md)** for SHA-256 verification and platform notes.

### Track Generation Setup

* **Existing karaoke media (`MP3+G`, `CD+G`, or pre-separated stems):** Import and play immediately without downloading AI models.
* **Generating tracks from standard audio:** At first launch (or via **Settings → Song processing…**), the setup wizard walks you through installing local processing. With your consent, Singhouse downloads and verifies an isolated processing runtime and model weights directly from their upstream sources. Source and server installations can also offload GPU processing to **[your own Modal account](docs/modal.md)**.

---

## Multi-Model Acoustic Word Timing (`lyricsync`)

Standard speech-to-text models drift on sung vocals, hallucinate during instrumental solos, and struggle with sustained vowels. Single-model CTC forced aligners improve onset precision, but when run over an entire song without an inter-word filler state, unscripted breaths, ad-libs, and instrumental breaks pull nearby words across the gap.

Singhouse's bundled **[`lyricsync`](lyricsync/)** library (dual-licensed under **MIT** and **AGPL-3.0-only**) solves this with a 3-stage pipeline:

```text
Vocal Stems ──► 1. RMS-VAD Silence Gating + HeartTranscriptor ASR (29.2% singing WER)
                     │
                     ▼
Plain Lyrics ─► 2. 3-Tier Phonetic Needleman-Wunsch (Exact → Levenshtein → Double Metaphone)
                     │
                     ▼
                3. 4-Model CTC Viterbi Fusion + Filler States (HuBERT-L/XL, wav2vec2-L, Phoneme CTC)
                     │
                     ▼
                Sub-100ms Word-Synced Karaoke Track
```

1. **Silence Gating & Music-Tuned ASR:** RMS Voice Activity Detection strips instrumental breaks before transcription so the model never hallucinates over guitar solos. Singing transcription via `HeartTranscriptor` cuts Word Error Rate (WER) to **29.2%** on the Jamendo benchmark (compared to **40.2%–51.2%** for stock Whisper-medium).
2. **Phonetic Sequence Alignment:** Transcribed words are aligned to your plain reference lyrics (pasted or fetched via opt-in `lrclib.net`) using Needleman-Wunsch dynamic programming with first-letter vocal weighting and Double Metaphone sound-alike scoring. *(Third-party LRC line timestamps are intentionally ignored on upload, as community LRC offset drift degrades sub-100ms precision by 1.5–4 pp.)*
3. **4-Model CTC Viterbi Fusion with Filler States:** Every word is force-aligned against the combined vocal stems (`lead_vocals` + `backing_vocals`) across up to four license-clean CTC acoustic models (`HuBERT-Large`, `wav2vec2-Large`, `HuBERT-XLarge`, and a `wav2vec2` espeak phoneme voter). A dedicated inter-word Viterbi filler state absorbs breaths and instrumental gaps, while per-word median fusion cancels individual model jitter and flags any low-confidence words (>200ms voter disagreement) for review.

### Benchmark: Jamendo Single-Voice Evaluation (20 English Songs, Plain Lyrics)

We evaluated `lyricsync` on the public 20-song Jamendo lyric alignment benchmark alongside other open-source karaoke tools ([Nightingale](https://github.com/rzru/nightingale) and [karaoke-gen](https://github.com/nomadkaraoke/karaoke-gen) in its local Whisper fallback mode), including controlled runs feeding the exact same separated vocal stem to each aligner:

| Alignment Architecture / Pipeline | Audio Input | Median Error | Start <0.1s | Start <0.2s | Start <0.3s | End <0.2s | Gross Error (>1s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Singhouse (`lyricsync` 4-Model CTC Fusion)** | Combined vocal stem | **41 ms** | **86.3%** | **95.5%** | **96.8%** | **91.3%** | **1.4%** |
| Single-model `wav2vec2` CTC *(Nightingale, controlled stem)* | Singhouse combined stem (WAV) | 52 ms | 73.5% | 86.4% | 89.5% | 86.0% | 6.2% |
| Single-model `wav2vec2` CTC *(Nightingale CTC default)* | Default lead stem (MP3) | 59 ms | 66.1% | 77.7% | 80.8% | 73.2% | 15.3% |
| Single-model `wav2vec2` *(Nightingale default)* | Default lead stem (MP3) | 61 ms | 64.9% | 76.6% | 79.6% | 76.6% | 15.6% |
| Singhouse Legacy *(HeartTranscriptor + NW only)* | Lead vocal stem | 93 ms | 52.5% | 73.0% | 80.2% | 72.2% | 11.1% |
| Whisper-medium ASR + word mapping *(`karaoke-gen` local, EN)* | Singhouse combined stem | 103 ms | 48.8% | 70.3% | 77.9% | 67.7% | 15.2% |
| Whisper-medium ASR + word mapping *(`karaoke-gen` local, EN)* | Full mix | 121 ms | 43.6% | 64.6% | 72.2% | 61.0% | 21.6% |
| Whisper-medium ASR + word mapping *(`karaoke-gen` local, auto)* | Full mix | 163 ms | 36.8% | 54.1% | 59.8% | 51.2% | 35.8% |

* **Ahead on 20/20 songs:** Even when evaluating on the exact same lossless vocal stem, combining four CTC models with an inter-word Viterbi filler state improves sub-100ms onset accuracy by **+12.8 pp** (`86.3%` vs. `73.5%`) and cuts gross errors (`>1s` off) more than 4× from **6.2% to 1.4%** (+21.4 pp and 11× fewer gross errors vs. default settings).
* **Multi-voice resilience:** On a separate 55-song multi-voice benchmark using plain lyrics fetched from LRCLIB, CTC Acoustic Fusion jumped sub-100ms accuracy from **47.9% to 69.9% (+22.0 pp)**, improving **55 out of 55 songs** (and reaching **80.9%** on voice-labeled unison sheets).
* **Commercial cloud parity:** In directional spot-checks against the commercial AudioShake cloud API (~$0.18/min per output) with reference lyrics supplied, local CTC Acoustic Fusion performed in the same sub-100ms timing tier (`98.6%` vs. `95.4%` on clean rapid vocals; `80.2%` vs. `80.2%` on lexical words of the hardest track)—and running `lyricsync`'s CTC fusion on top of AudioShake's unreferenced transcripts improved sub-100ms timing from `66.5%` to `79.6%`. *(Note: `karaoke-gen`'s primary production path uses AudioShake + human review rather than its local Whisper fallback; Singhouse also uses Nomad Karaoke's `python-audio-separator` for Pass-2 RoFormer separation.)*
* *(CTC acoustic re-timing runs by default on CUDA source/server installs (~9s per 4-min song on an RTX 3090) and is coming to packaged desktop processing packs in an upcoming release. See **[`lyricsync/ALIGNMENT.md`](lyricsync/ALIGNMENT.md)** for full methodology and caveats.)*

---

## Documentation

* **[Desktop Installation Guide](docs/install-desktop.md)** — Checksum verification, OS prompts, and data paths
* **[Architecture & Project Reference](PROJECT_DOCS.md)** — System design, database schema, durable job queue, and systemd deployment
* **[Processing on Your Own Modal Account](docs/modal.md)** — Offloading GPU separation and transcription to your own Modal workspace
* **[Importing from Your Plex Server](docs/plex.md)** — Connecting a local Plex Media Server to import tracks
* **[Backend Development & API Reference](backend/README.md)** — FastAPI setup, `.venv-demucs` GPU environment, `kb-db` CLI, and REST endpoints
* **[Frontend Development](frontend/README.md)** — Vue 3 SPA, Web Audio mixer, Signalsmith pitch-shift worklet, and canvas stage renderer
* **[Building the Desktop App](desktop/README.md)** — Assembling native runtimes, processing recipes, and installers
* **[`lyricsync` Python API](lyricsync/README.md)** & **[How Alignment Works](lyricsync/ALIGNMENT.md)** — Standalone word-sync and CTC fusion library documentation

---

## Privacy

Track generation in Singhouse runs entirely locally on your machine by default:

* **No telemetry or cloud hosting:** Singhouse never hosts, stores, or transmits your audio, stems, or synced lyrics.
* **No central catalog or acquisition:** Singhouse includes no music catalog, bundled lyrics database, acquisition tools, or cross-instance sharing. Use media and lyrics you have the right to use.
* **Opt-in external integrations:**
  * **LRCLIB (`KARAOKE_LRCLIB=1`):** Off by default. When enabled, sends only artist and title to [lrclib.net](https://lrclib.net) to fetch plain reference lyrics.
  * **Modal GPU (`KARAOKE_MODAL=1`):** Off by default. Sends audio only to **[your own Modal deployment](docs/modal.md)** inside your own configured account.

---

## License

Singhouse is licensed under **[AGPL-3.0-only](LICENSE)**. The standalone [`lyricsync`](lyricsync/) alignment library is dual-licensed and additionally available under the **[MIT License](lyricsync/LICENSE)** so it can be used independently without AGPL obligations.

See **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)** and **[desktop/NATIVE_NOTICES.md](desktop/NATIVE_NOTICES.md)** for dependencies and attribution, and **[CONTRIBUTING.md](CONTRIBUTING.md)** for the contribution policy.
