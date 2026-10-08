# lyricsync

Word-level lyrics transcription and alignment library. Takes an audio file and optional reference lyrics, runs ASR transcription, aligns the result to the reference text, and returns per-word timestamps.

This README is the API reference. For the design behind it — what each pipeline
stage does, where the thresholds come from, and why — see
[ALIGNMENT.md](ALIGNMENT.md).

## Install

```bash
pip install -e .                          # base (numpy only)
pip install -e ".[whisper]"               # + faster-whisper backend
pip install -e ".[whisper,metaphone]"     # + phonetic matching
pip install -e ".[all]"                   # everything
```

## Quick start

```python
from lyricsync import AsyncPipeline, PipelineConfig
from lyricsync.transcription import FasterWhisperTranscriber

pipeline = AsyncPipeline(
    transcriber=FasterWhisperTranscriber(model="large-v3"),
    config=PipelineConfig(),
)

# With synced (LRC) lyrics — best results
result = await pipeline.run(
    audio_path="vocals.wav",
    synced_lyrics="[00:01.00]When you were here before\n[00:03.50]Couldn't look you in the eye",
)

# With plain lyrics
result = await pipeline.run(
    audio_path="vocals.wav",
    plain_lyrics="When you were here before\nCouldn't look you in the eye",
)

# No reference lyrics — raw transcription only
result = await pipeline.run(audio_path="vocals.wav")
```

## Synchronous usage

```python
from lyricsync import SyncPipeline
from lyricsync.transcription import FasterWhisperTranscriber

pipeline = SyncPipeline(transcriber=FasterWhisperTranscriber(model="large-v3"))
result = pipeline.run(audio_path="vocals.wav", plain_lyrics="...")
```

## Custom transcriber

Any object with a `transcribe(audio_path, language=None) -> TranscriptionResult` method works:

```python
class MyTranscriber:
    def transcribe(self, audio_path, language=None):
        return TranscriptionResult(segments=[...], language="en")

pipeline = SyncPipeline(transcriber=MyTranscriber())
```

## Alignment-only (skip transcription)

```python
transcription = transcriber.transcribe("vocals.wav")
result = pipeline.align_only(whisper_result=transcription, plain_lyrics="...")
```

## Using individual components

```python
from lyricsync.alignment import NeedlemanWunschAligner, LrcAnchoredAligner, parse_lrc
from lyricsync.alignment.matching import word_match_score, normalize
from lyricsync.audio import rms_vad_segments, read_wav_mono

# Use an aligner directly
aligner = NeedlemanWunschAligner()
result = aligner.align(whisper_words, PlainLyricsReference(lines=["hello world"]))

# Parse LRC
lrc_lines = parse_lrc("[00:01.00]Hello world\n[00:03.50]Test")

# Check word similarity
score = word_match_score("night", "nite")  # 0.5 (phonetic match)

# Segment audio with VAD
samples, sr = read_wav_mono("vocals.wav")
segments = rms_vad_segments(samples, sr)
```

## Configuration

All thresholds are configurable via frozen dataclasses:

```python
from lyricsync import PipelineConfig
from lyricsync._config import VadConfig, MatchConfig

config = PipelineConfig(
    vad=VadConfig(onset_threshold=0.05, max_segment_duration=20.0),
    matching=MatchConfig(gap_penalty=-1.0),
)
pipeline = SyncPipeline(transcriber=..., config=config)
```

## Alignment methods

| Method | When | Description |
|--------|------|-------------|
| LRC-anchored | `synced_lyrics` provided | Uses LRC line timestamps as anchors, aligns per-word within each line |
| LRC-distributed | LRC + poor whisper quality | Falls back to even word distribution within each LRC line's window |
| Needleman-Wunsch | `plain_lyrics` only | DP alignment of whisper words to reference text with 3-tier scoring |
| Whisper-only | No reference lyrics | Returns raw transcription timestamps |

## Transcription backends

| Backend | Class | Install |
|---------|-------|---------|
| faster-whisper | `FasterWhisperTranscriber(model="large-v3")` | `lyricsync[whisper]` |
| HeartTranscriptor | `HeartTranscriber(python_path=..., script_path=...)` | Requires separate torch venv |

## Acoustic re-timing (optional)

An optional final stage re-times every word of the result against the vocal
audio. It runs several CTC acoustic models in a separate Python environment
that has `torch` and `torchaudio` (and, for the optional phoneme voter,
`transformers`, `phonemizer` and the `espeak-ng` program), fuses their word
times with the existing timing, and rewrites only word `start`/`end` — text,
word count and line structure never change.

```python
from lyricsync import CtcFusionAligner, PipelineConfig, SyncPipeline

aligner = CtcFusionAligner(python_path="/path/to/torch-env/bin/python")
pipeline = SyncPipeline(
    transcriber=...,
    config=PipelineConfig(acoustic_alignment=True),
    acoustic_aligner=aligner,
)
# extra_audio_paths (e.g. a backing-vocal stem) are summed with audio_path
result = pipeline.run("vocals.wav", plain_lyrics=lyrics, extra_audio_paths=["backing.wav"])
print(result.metadata.extra["acoustic_alignment"])
```

- Needs CUDA by default; pass `allow_cpu=True` to run on the CPU (slow).
- Model weights (about 1.3 GB per large model, 3.6 GB for the extra-large
  one) download on first use into the processing environment's torch hub and
  Hugging Face caches. Models load one at a time.
- Any failure (worker error, timeout, cancel, missing models, CUDA absent,
  fewer than two character models) keeps the existing timing; the reason is
  recorded in `metadata.extra["acoustic_alignment"]`, alongside the models
  used and skipped, the boundary parameters and the indices of words whose
  voters disagree (`flagged_words`: flat word indices across `result.lines` in
  line order; flagged words are still re-timed, the flag is informational).
- Boundary parameters: `PipelineConfig.acoustic_start_shift` (-0.02 s),
  `acoustic_join_gap` (0.0 s), `acoustic_tail_extend` (0.2 s),
  `acoustic_flag_threshold` (0.2 s).

## Word matching scoring

The 3-tier matching strategy (used by Needleman-Wunsch and LRC-anchored alignment):

1. **Exact** (score: +2.0) — normalized exact match
2. **Enhanced Levenshtein** (score: +1.0 or 0.0) — fuzzy string similarity with first-letter boost and length ratio blending
3. **Double Metaphone** (score: +0.5) — phonetic matching for sound-alikes ("night"/"nite", "through"/"thru")

## Architecture

```
audio_path
    │
    ▼
┌──────────────┐
│  Transcriber  │  (faster-whisper, HeartTranscriptor, or custom)
└──────┬───────┘
       │ TranscriptionResult
       ▼
┌──────────────┐
│  Post-process │  hallucination filter, word extraction
└──────┬───────┘
       │ List[TimedWord]
       ▼
┌──────────────┐
│   Aligner    │  (LrcAnchoredAligner or NeedlemanWunschAligner)
└──────┬───────┘
       │ SyncResult
       ▼
  segments + lines + metadata
```

## License

MIT — see [LICENSE](LICENSE).

`lyricsync` is dual-licensed. The project it ships with is AGPL-3.0-only;
this package is additionally offered under MIT so it can be used
independently, without the AGPL's obligations. Use it under either, at your
option.
