# How alignment works

`README.md` covers the API. This document covers the design behind it: what
each stage does, what the thresholds are, and why they are set where they are.

The problem: a vocal stem and a set of reference lyrics go in, and word-level
timings come out — accurate enough that a karaoke player can highlight each
word as it is sung. Speech recognition alone will not get you there. It
mishears sung text, hallucinates during instrumental passages, and its word
timings drift. Most of the pipeline exists to correct for that.

```
Vocals WAV
    │
    ▼
RMS-VAD segmentation          cut silence, cap segment length
    │
    ▼
Transcription                 faster-whisper or HeartTranscriber
    │
    ▼
Reference lyrics              plain text and/or LRC synced
    │
    ▼
Alignment                     LRC-anchored, Needleman-Wunsch, or anchor-gap
    │
    ▼
Post-processing               quality gate, monotonic timing, line splitting
    │
    ▼
Word-level SyncResult
```

## 1. Segmentation (RMS-VAD)

Before transcription, the stem is split on silence: an RMS energy envelope with
separate onset and offset thresholds (0.03 / 0.02 — hysteresis, so a wavering
signal does not chatter across a single threshold), merging gaps shorter than
1.5 s.

Two reasons this stage is not optional:

- **Silence is where hallucination lives.** Whisper asked to transcribe an
  instrumental break will invent text. Not sending it the silence is far more
  reliable than filtering the output afterwards.
- **Memory.** Whisper's window is 30 s, but word-level timestamps are extracted
  by concatenating cross-attention across every decode step, layer and head.
  That tensor grows with tokens generated, so a near-30 s segment can cost
  gigabytes — enough to exhaust an 8 GB card on the *first* segment. The
  default cap is **15 s**, which halves the token axis at identical audio
  coverage: segments are only ever split, never dropped, and word timestamps
  are offset back to global time afterwards. Raise it if your card has
  headroom.

## 2. Transcription

Two backends ship, behind one interface — bring your own by implementing
`Transcriber`.

| Backend | Install | Notes |
|---|---|---|
| `FasterWhisperTranscriber` | `lyricsync[whisper]` | CTranslate2 Whisper, `tiny` through `large-v3`. Faster and lighter than the reference implementation |
| `HeartTranscriber` | separate torch venv | Whisper fine-tuned on sung vocals |

The music-tuned model is meaningfully better on real songs. Vanilla Whisper was
trained overwhelmingly on speech, and on singing it tends to produce
conversational filler — including, characteristically, video-caption boilerplate
it absorbed from its training data.

## 3. Word matching

Alignment needs to score how well any two words match. Three tiers, tried in
order, first hit wins. Every number below is a `MatchConfig` default and can be
overridden.

**Tier 1 — exact (`+2.0`).** After normalization: lowercased, non-word
characters stripped.

**Tier 2 — enhanced Levenshtein (`+1.0`, or `0.0`).** Normalized indel
similarity, with substitutions counted as delete-plus-insert. Uses `rapidfuzz`
when installed, falling back to a pure-Python single-row DP computing the same
metric. Two adjustments on top of the raw ratio:

- *First-letter agreement.* Same first letter pulls similarity toward 1.0
  (`(base + 1) / 2`); a different one attenuates it (`base × 0.9`). Sung text
  degrades at the ends of words far more than at the start, so the first letter
  carries more evidence than its share of the character count.
- *Length blending.* Averaged with the ratio of the shorter word's length to
  the longer's. Without this, short words match each other too easily.

Scoring `>= 0.75` is a close match (`+1.0`); `>= 0.5` is weak (`0.0` — no
credit, but no penalty either, which still beats opening a gap).

**Tier 3 — Double Metaphone (`+0.5`).** Reached only when enhanced Levenshtein
falls *below* 0.5. Each word gets up to two phonetic codes; every code pair is
compared and the best score kept — 1.0 for an exact code match, 0.8 for
containment among short codes, and graded credit for a shared prefix of 2+
characters or substantial character overlap. At `>= 0.7` the pair scores `+0.5`.

This tier is what rescues the sung-contraction and homophone cases that are
orthographically distant but phonetically identical:

| A | B | Enhanced Lev. | Phonetic | Result |
|---|---|---:|---:|---|
| you | u | 0.39 | 1.00 | +0.5 phonetic |
| why | y | 0.39 | 1.00 | +0.5 phonetic |
| are | r | 0.39 | 0.80 | +0.5 phonetic |
| because | cuz | 0.39 | 0.80 | +0.5 phonetic |
| eight | ate | 0.41 | 1.00 | +0.5 phonetic |

Note the ordering carefully: because tier 2 returns as soon as similarity
reaches 0.5, a pair in the 0.5–0.75 band scores `0.0` and **never consults the
phonetic tier**, even when it is a perfect phonetic match. `phone`/`fone`
(similarity 0.70, phonetic 1.00) scores `0.0`, not `+0.5`. This is current
behaviour, not a recommendation — the thresholds were tuned as a set, and
moving one moves the others.

Anything below all three thresholds scores `-1.0`.

## 4. Sequence alignment

Global dynamic-programming alignment of the transcript against the reference,
using `word_match_score` as the substitution score and `-0.5` per gap.
Traceback keeps only positive-scoring matches; everything else is recorded as
unmatched and gets its timing interpolated from its neighbours.

Which aligner runs depends on what reference material you have:

| Reference | Aligner | How it works |
|---|---|---|
| LRC synced lyrics | `LrcAnchoredAligner` | Each LRC line timestamp is an anchor. Transcript words inside a line's window are aligned only against that line's reference words — many small alignments instead of one large one, so a mistake cannot propagate past the line |
| LRC, poor transcript | LRC-distributed | Below the quality gate, timing is distributed evenly inside each LRC line window. Coarse, but the line boundaries are still right |
| Plain lyrics only | `NeedlemanWunschAligner` | One alignment over the entire word sequence |
| Plain lyrics, opt-in | `AnchorGapAligner` | Finds high-confidence anchor runs (3+ words) first, then aligns only the gaps between them. Off by default (`use_anchor_gap_alignment`) |
| No reference | — | Transcript timings, passed through |

LRC anchoring is worth seeking out. A single global alignment can lose its place
in a repeated chorus and stay lost; per-line anchoring bounds the damage to one
line.

## 5. Post-processing

- **Quality gate.** The fraction of reference words actually present in the
  transcript is measured first. Below 0.35, alignment is skipped entirely in
  favour of even distribution — a bad transcript aligned confidently is worse
  than an honest approximation, because the errors land in different places
  every line.
- **Hallucination filtering.** Segments matching known caption boilerplate are
  dropped.
- **Singing-duration estimation.** Unmatched words are distributed at up to
  0.4 s per word rather than spread across whatever span is available, so an
  instrumental break does not stretch a single word across it.
- **Monotonic enforcement.** Words are sorted by start time, overlaps clamped,
  and a minimum duration of **0.12 s** applied with forward-pushing of
  subsequent words. Professional authoring tools bottom out around 0.11 s per
  syllable; speech recognition happily emits 0–60 ms words, which render as
  invisible instant highlights without this floor. A 0.05 s minimum inter-word
  gap keeps adjacent words from visually fusing.
- **LRC tag stripping.** Inline `[mm:ss.xx]` timestamps are removed from text.
- **Line splitting (no-reference only).** With no reference lyrics, transcript
  segment boundaries are the only line signal available, and sustained phrasing
  can yield 100-word "lines" that overflow any player layout. Segments are
  re-split on sentence-final punctuation followed by a capital, on an inter-word
  gap over 0.5 s, or on a maximum word count.

## 5a. Acoustic re-timing (optional)

When enabled with an acoustic aligner, the finished result is re-timed
against the vocal audio (plus any extra stems, summed). Three character CTC
models (HuBERT large and extra-large, wav2vec 2.0 large) and an optional
phoneme CTC model are each force-aligned to the word list over the whole song
with a Viterbi pass that has a filler state between words, so unscripted
vocal sounds need not be absorbed into a word. Each word's start is the
median over those models and the existing timing, made non-decreasing; each
end is the median of the character models, clipped to the next word's start.
A constant start shift and an end extension or join against the next start
finish the boundaries. Every word is re-timed; words where two or more
voters disagree with the fused start by more than 0.2 s are additionally
listed in the metadata (flat word indices in line order) as low-confidence. If fewer than two character models produce output, or
anything fails, the existing timing is kept.

## 6. Configuration

Every threshold above lives in a frozen dataclass — `VadConfig`, `MatchConfig`,
`PostProcessConfig`, composed into `PipelineConfig`. Defaults are tuned for
separated vocal stems of popular music. See "Configuration" in `README.md`.

## 7. Optional dependencies

| Package | Enables | Without it |
|---|---|---|
| `faster-whisper` | Whisper transcription | Supply your own `Transcriber` |
| `rapidfuzz` | C-optimized similarity | Pure-Python fallback, same metric |
| `metaphone` | Phonetic matching tier | Tier 3 scores 0.0 and is effectively skipped |
| `numpy` | RMS-VAD segmentation | Required for the audio front end |
