# lyricsync

Standalone word-level lyrics transcription and acoustic alignment library for Python. Given a vocal audio file and optional reference lyrics, `lyricsync` segments voiced regions, runs ASR transcription, aligns words to your reference text using phonetic dynamic programming, and optionally refines every word boundary against the vocal audio using multi-model CTC acoustic fusion.

For a deep dive into the pipeline stages, scoring thresholds, and CTC voter architecture, see **[ALIGNMENT.md](ALIGNMENT.md)**.

## Installation

```bash
pip install -e .                          # Base (numpy only)
pip install -e ".[whisper]"               # + faster-whisper backend
pip install -e ".[whisper,metaphone]"     # + Double Metaphone phonetic matching
pip install -e ".[all]"                   # All optional dependencies
```

PCM WAV files use the built-in reader. Reading MP3, FLAC, AAC/M4A, or Opus/Vorbis audio requires `ffmpeg` on `PATH`.

## Quick Start

```python
from lyricsync import AsyncPipeline, PipelineConfig
from lyricsync.transcription import FasterWhisperTranscriber

pipeline = AsyncPipeline(
    transcriber=FasterWhisperTranscriber(model="large-v3"),
    config=PipelineConfig(),
)

# 1. With plain reference lyrics (recommended)
result = await pipeline.run(
    audio_path="lead_vocals.wav",
    plain_lyrics="When you were here before\nCouldn't look you in the eye",
)

# 2. With LRC line-anchored lyrics
result = await pipeline.run(
    audio_path="lead_vocals.wav",
    synced_lyrics="[00:01.00]When you were here before\n[00:03.50]Couldn't look you in the eye",
)

# 3. Raw transcription only (no reference lyrics)
result = await pipeline.run(audio_path="lead_vocals.wav")
```

### Synchronous Usage & Alignment-Only

```python
from lyricsync import SyncPipeline
from lyricsync.transcription import FasterWhisperTranscriber

transcriber = FasterWhisperTranscriber(model="large-v3")
pipeline = SyncPipeline(transcriber=transcriber)

# Full synchronous run
result = pipeline.run(audio_path="lead_vocals.wav", plain_lyrics="...")

# Alignment-only (reuse a cached TranscriptionResult)
transcription = transcriber.transcribe("lead_vocals.wav")
result = pipeline.align_only(whisper_result=transcription, plain_lyrics="...")
```

## CTC Acoustic Re-Timing (Optional)

When enabled, a final stage force-aligns every word against the vocal audio (plus any `extra_audio_paths` such as backing vocals, summed) using an ensemble of CTC acoustic models (`HuBERT-Large`, `wav2vec2-Large`, `HuBERT-XLarge`, and an optional `wav2vec2` espeak phoneme voter) in a PyTorch environment:

```python
from lyricsync import CtcFusionAligner, PipelineConfig, SyncPipeline

aligner = CtcFusionAligner(python_path="/path/to/torch-env/bin/python")
pipeline = SyncPipeline(
    transcriber=...,
    config=PipelineConfig(acoustic_alignment=True),
    acoustic_aligner=aligner,
)

result = pipeline.run(
    "lead_vocals.wav",
    plain_lyrics=lyrics,
    extra_audio_paths=["backing_vocals.wav"],
)
print(result.metadata.extra["acoustic_alignment"])
```

* **Hardware:** Uses CUDA by default (~9s per 4-minute song on an RTX 3090); pass `allow_cpu=True` for CPU fallback.
* **Text Invariance:** Only word `start` and `end` times are updated; reference words and line breaks never change.
* **Confidence Flags:** Words where two or more voters disagree with the fused start by more than `acoustic_flag_threshold` (`0.2s`) are listed in `metadata.extra["acoustic_alignment"]["flagged_words"]`.
* **Boundary Tuning:** Configurable via `PipelineConfig` (`acoustic_start_shift=-0.02`, `acoustic_join_gap=0.0`, `acoustic_tail_extend=0.2`, `acoustic_flag_threshold=0.2`).

## Configuration

All pipeline thresholds are exposed via frozen dataclasses (`VadConfig`, `MatchConfig`, `PostProcessConfig`) inside `PipelineConfig`:

```python
from lyricsync import PipelineConfig
from lyricsync._config import VadConfig, MatchConfig

config = PipelineConfig(
    vad=VadConfig(onset_threshold=0.05, max_segment_duration=15.0),
    matching=MatchConfig(gap_penalty=-0.5),
)
```

(Note: `VadConfig.max_segment_duration` defaults to `None` in the library API—which splits at a 30s ceiling and lets device-aware decoders re-split longer slices to fit VRAM. Callers using a custom decoder without internal chunking should pass `max_segment_duration=15.0` explicitly.)

## License

Dual-licensed under **MIT** ([`LICENSE`](LICENSE)) and **AGPL-3.0-only**. `lyricsync` has no dependency on the rest of Singhouse and may be used standalone under the MIT License.
