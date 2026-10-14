# How Alignment Works (`lyricsync` Design)

[`README.md`](README.md) covers the Python API. This document explains how each stage of the `lyricsync` pipeline works, why its thresholds are set where they are, and how multi-model CTC acoustic re-timing refines word boundaries.

```
Vocals WAV (+ optional Backing Vocals WAV)
    │
    ▼
1. RMS-VAD Segmentation       Cut silence, bound segment length for VRAM
    │
    ▼
2. Transcription              HeartTranscriber (music-tuned) or faster-whisper
    │
    ▼
3. Phonetic Sequence Align    Needleman-Wunsch (Exact → Levenshtein → Double Metaphone)
    │
    ▼
4. Post-Processing            Quality gate, 120ms min word duration, monotonic enforcement
    │
    ▼
5. CTC Acoustic Re-Timing     Viterbi force-alignment across 4 CTC models + median voter fusion
    │
    ▼
Word-Level SyncResult
```

---

## 1. Segmentation (RMS-VAD)

Before transcription, the vocal stem is segmented on silence using an RMS energy envelope with hysteresis (`onset_threshold=0.03`, `offset_threshold=0.02`, merging gaps shorter than `1.5s`).

Why segmentation is mandatory:

* **Preventing Hallucinations:** Whisper models fed long instrumental breaks frequently hallucinate text or caption boilerplate. Stripping silence before transcription is far cleaner than filtering hallucinations afterward.
* **Bounding Cross-Attention VRAM:** Extracting word-level timestamps requires concatenating cross-attention tensors across every decode step, layer, and head. A dense 30s segment can easily exhaust an 8 GB GPU. In managed pipelines, voiced segments are capped at **15s** (or dynamically re-split by the decoder from a 30s VAD ceiling), cutting peak token memory in half while preserving all audio coverage.

---

## 2. Transcription & Heart Output Normalization

Two transcription backends are supported behind the `Transcriber` interface:

1. **`HeartTranscriber`:** Runs `HeartTranscriptor` (a 764M-parameter Whisper-medium fine-tune trained specifically on sung vocals). Vanilla Whisper was trained overwhelmingly on speech and tends to emit conversational filler on sung vocals; `HeartTranscriptor` is substantially more accurate on music.
2. **`FasterWhisperTranscriber`:** CTranslate2 Whisper (`tiny` through `large-v3`).

### Contraction & Apostrophe Normalization (`HeartTranscriber`)

`HeartTranscriptor` word timestamps come from the Hugging Face ASR pipeline's `return_timestamps="word"` chunks using the checkpoint's own `WhisperProcessor` tokenizer. Because the tokenizer splits contractions into separate timestamp chunks (e.g., `don`, `'`, `t`), the `HeartTranscriber` adapter normalizes output before alignment:

* **Fullwidth Apostrophes:** Normalizes fullwidth apostrophes to standard ASCII `'`.
* **Contraction Joining:** Merges split ASCII-letter bases and known contraction suffixes within the same segment when the inter-chunk pause is ≤ 100 ms and start times are non-decreasing. Merged words take the earliest `start` and latest `end`.
* **Multilingual Preservation:** Curly apostrophes, accented characters, and non-Latin scripts (such as Japanese or Hangul) are preserved without inserting artificial spaces into `full_text`.

---

## 3. Three-Tier Word Matching (`alignment/matching.py`)

To align noisy transcript words against clean reference lyrics, `word_match_score(w1, w2, config)` evaluates pairs across three tiers (first hit wins):

1. **Tier 1 — Exact Match (`+2.0`):** Lowercased with non-word characters stripped.
2. **Tier 2 — Enhanced Levenshtein (`+1.0` or `0.0`):** Normalized indel similarity (`rapidfuzz` when installed, pure-Python fallback otherwise) modified by two vocal heuristics:
   * *First-letter agreement:* Sung words degrade at the tail much more than the onset. Matching first letters boost similarity (`(base + 1) / 2`); differing first letters attenuate it (`base * 0.9`).
   * *Length-ratio blending:* Averaged with `min(len) / max(len)` so short words don't falsely match each other.
   * Pairs scoring ≥ 0.75 return **`+1.0`** (close match, e.g., *"gonna"* vs. *"gotta"*). Pairs scoring 0.50–0.75 return **`0.0`** (weak match—no bonus, but avoids a gap penalty).
3. **Tier 3 — Double Metaphone Phonetic Fallback (`+0.5`):** Evaluated only when Enhanced Levenshtein is < 0.50. Compares primary/secondary phonetic codes (1.0 for exact code match, 0.8 for short-code containment, 0.7+ for shared 2+ char prefix). Scores ≥ 0.70 return **`+0.5`**, rescuing orthographically distant homophones and contractions:

| Reference | Transcript | Enhanced Lev. | Phonetic | Final Score |
|---|---|---:|---:|---|
| `you` | `u` | 0.39 | 1.00 | `+0.5` (Phonetic) |
| `because` | `cuz` | 0.39 | 0.80 | `+0.5` (Phonetic) |
| `eight` | `ate` | 0.41 | 1.00 | `+0.5` (Phonetic) |

*(Note: Because Tier 2 returns `0.0` for scores in the 0.50–0.75 band before reaching Tier 3, orthographically close sound-alikes like `phone`/`fone` [Lev 0.70] score `0.0` rather than `+0.5`. The thresholds are tuned jointly with the `-0.5` gap penalty.)*

Anything below all three tiers scores **`-1.0`** (mismatch).

---

## 4. Sequence Alignment & Post-Processing

* **Needleman-Wunsch (`NeedlemanWunschAligner`):** Global dynamic programming alignment over the full word sequence using `word_match_score` and a `-0.5` gap penalty. Only positive-scoring matches are kept; unmatched reference words have their initial timings interpolated at up to `0.4s` per word.
* **LRC-Anchored (`LrcAnchoredAligner`):** Available when explicit LRC line anchors are passed directly to `lyricsync`. (In Singhouse's upload pipeline, plain-text alignment + CTC acoustic re-timing is preferred over community LRC timestamps, as LRC line clamping reduces sub-100ms accuracy by 1.5–4 percentage points.)
* **Quality Gate & Monotonic Post-Processing:**
  * If fewer than `35%` of reference words match the transcript (`whisper_quality_threshold`), transcript timings are discarded in favor of even distribution.
  * Enforces monotonic non-overlapping timestamps, a **120 ms minimum word duration**, and a **50 ms minimum inter-word gap** so rapid words remain visually distinct on stage.

---

## 5. CTC Acoustic Re-Timing (`CtcFusionAligner`)

Initial ASR word timestamps often lag or lead actual vocal onsets by 100–300 ms. When `acoustic_alignment=True`, the aligned word list is force-aligned directly against the vocal stem (summing `lead_vocals` and `backing_vocals` when available) across up to four CTC models:

1. `torchaudio.pipelines.HUBERT_ASR_LARGE` (character CTC)
2. `torchaudio.pipelines.WAV2VEC2_ASR_LARGE_LV60K_960H` (character CTC)
3. `torchaudio.pipelines.HUBERT_ASR_XLARGE` (character CTC)
4. `facebook/wav2vec2-lv-60-espeak-cv-ft` (optional phoneme CTC voter via `transformers` + `phonemizer` + `espeak-ng`)

### How Voter Fusion Works

* **Viterbi with Filler States:** Each model force-aligns the known reference words across the song using a Viterbi pass that includes an inter-word filler state, preventing non-lexical vocalizations (breaths, ad-libs) from pulling adjacent word boundaries.
* **Median Start & End:** Each word's `start` is taken as the median across the CTC voters and the initial transcript timing (enforced non-decreasing). Each word's `end` is the median of the character CTC models, clipped to the next word's start.
* **Boundary Shaping:** Applies a `-20 ms` start shift (`acoustic_start_shift=-0.02`) and up to `+200 ms` tail extension (`acoustic_tail_extend=0.2`) for natural karaoke lead-in and hold.
* **Low-Confidence Flagging:** Any word where ≥ 2 voters disagree with the fused start by > 200 ms is recorded in `metadata.extra["acoustic_alignment"]["flagged_words"]` so editors can spot-check ambiguous phrasing.

### Benchmark Accuracy (% of words within ±100 ms of ground truth)

| Evaluation Set | Whisper / Heart + NW Only | + CTC Acoustic Fusion | Accuracy Gain |
|---|---:|---:|---|
| **Jamendo** (20 songs, single-voice, plain lyrics) | 52.5% | **86.3%** | **+33.8 pp** |
| **Multi-voice Evaluation Set** (55 songs, LRCLIB plain text) | 47.9% | **69.9%** | **+22.0 pp** (55/55 songs improved) |
| **Multi-voice Evaluation Set** (60 songs, voice-labeled reference) | 52.7% | **74.6%** (80.9% unison) | **+21.9 pp** |
| **Jamendo No-Lyrics** (raw transcription + CTC re-time) | 46.4% | **69.5%** | **+23.1 pp** |
