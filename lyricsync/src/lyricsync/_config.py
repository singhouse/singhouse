# SPDX-License-Identifier: MIT
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class VadConfig:
    frame_size: int = 1024
    onset_threshold: float = 0.03
    offset_threshold: float = 0.02
    min_silence_duration: float = 1.5
    # Longest audio slice handed to the transcriber in one forward pass.
    # ``None`` (the default) means "auto": the parent splits VAD regions at a
    # 30 s ceiling (Whisper's window) and the Heart decode subprocess, which
    # knows the device, re-splits any longer slice into equal parts sized to
    # the free accelerator memory it measures after loading the model. An
    # explicit number is a fixed cap applied everywhere, exactly as before.
    #
    # Why memory matters: word-level timestamps are extracted by
    # concatenating cross-attention across every decode step, layer and head
    # (_extract_token_timestamps). That tensor scales with tokens generated,
    # so a near-30 s segment can cost GiB, enough to exhaust an 8 GB card that
    # also drives a desktop. A fixed 15 s cap was the earlier default for that
    # reason; it halves the token axis at identical audio coverage (segments
    # are split, and word timestamps are offset back to global time), but it
    # needlessly limits context on cards with more headroom. Auto keeps 15 s
    # on ~8 GB cards and allows up to 30 s on large ones; CPU decode keeps
    # 15 s (host RAM is not probed). Transcribers that cannot measure memory
    # (faster-whisper, the Modal runner) treat ``None`` as a fixed 15 s, and
    # the whole-file window used when VAD finds no usable region is 15 s.
    max_segment_duration: float | None = None
    # Shortest region worth transcribing. Sub-second RMS blips (breaths,
    # cymbal bleed, stem-separation artifacts) carry no lyric but still get
    # padded to Whisper's 30 s window, where the model has nothing to anchor
    # on and hallucinates its training tail ("thx for listening!"). Those
    # words then render on screen, and the runaway decode also spikes
    # word-timestamp cross-attention memory. Dropping them is both a quality
    # and a stability fix.
    min_segment_duration: float = 1.0


@dataclass(frozen=True)
class MatchConfig:
    gap_penalty: float = -0.5
    exact_score: float = 2.0
    close_score: float = 1.0
    weak_score: float = 0.0
    phonetic_score: float = 0.5
    mismatch_score: float = -1.0
    lev_close_threshold: float = 0.75
    lev_weak_threshold: float = 0.5
    phonetic_threshold: float = 0.7


@dataclass(frozen=True)
class PostProcessConfig:
    # Shortest span any word may claim. Professional authoring tools
    # bottom out around 0.11 s per syllable; Whisper emits 0-60 ms words
    # that sweep invisibly ("instant" highlights) without this floor.
    min_word_duration: float = 0.12
    min_inter_word_gap: float = 0.05
    whisper_quality_threshold: float = 0.35
    per_word_singing_duration: float = 0.4
    # No-reference line splitting. When whisper-only (no reference lyrics),
    # transcription segments — gap > 1.5 s — are the only boundary signal we
    # have, so ballads with sustained phrasing produce 100+ word "lines" that
    # blow past the player layout. We re-split each segment using these
    # signals (any one triggers a line break):
    #   - the previous word ends with sentence-final punctuation AND the
    #     next word starts with a capital letter (Whisper preserves both)
    #   - inter-word gap exceeds line_break_gap_sec
    #   - the current line has reached line_break_max_words
    line_break_gap_sec: float = 0.5
    line_break_max_words: int = 10
    # Whisper's DTW word spans tile each transcription window — silence
    # between phrases is never represented, it gets absorbed into the next
    # word's start. When the audio is available, push any word start that
    # sits in silence forward to the next RMS onset. Trims larger than
    # trim_start_max_sec are skipped entirely (a huge scan-ahead usually
    # means the word itself is misplaced, not just its start).
    trim_starts_to_onset: bool = True
    trim_start_max_sec: float = 2.0


@dataclass(frozen=True)
class CorrectionConfig:
    """LLM-assisted alignment correction.

    Off by default; ``enabled`` + ``base_url`` gate the whole pass. The
    endpoint speaks OpenAI chat completions, so a local llama-server/ollama
    and any hosted OpenAI-compatible API are interchangeable. Every failure
    mode (endpoint down, bad JSON after one retry, low confidence) falls
    back to the deterministic heuristic for that region — a dead endpoint
    yields the exact same word timing as ``enabled=False``.
    """
    enabled: bool = False
    base_url: str = ""              # e.g. "http://127.0.0.1:11435/v1"
    model: str = "local"
    api_key: str = ""               # never persisted (redacted by the backend)
    # Per-call seconds. Generous because local thinking models burn 2-3.5k
    # reasoning tokens per region at ~8-13 tok/s (measured: Qwen3.6-35B-A3B
    # UD-IQ3_XXS on an M2 through ollama — up to ~5 min a call, and
    # disabling thinking measurably wrecks its timing judgement).
    timeout: float = 600.0
    # Region triggering. Experiment 1: the heuristic ties the LLM in tight
    # gaps, so only garble clusters (any corrected word), wide gaps, and
    # phrase-opening runs are worth a call.
    tight_gap_sec: float = 0.6
    wide_gap_sec: float = 1.0
    # A silence gap longer than this before a line-opening interpolated run
    # marks a phrase entry: unlock the line's first exact words (Whisper's
    # first matched word tends to absorb the pickup word's onset).
    phrase_gap_sec: float = 2.0
    unlock_words: int = 2
    # Exact runs of at least this length bound suspect regions; shorter
    # exact islands inside a cluster are absorbed but locked.
    min_anchor_run: int = 2
    # Mappings self-rated below this are dropped (experiment 1: the only
    # bad mapping was self-rated "low").
    confidence_gate: str = "medium"
    window_slack_sec: float = 0.1
    # Whisper catches consonant onsets ~0.25s before sung-vowel authoring.
    # Global shift applied to accepted spans; never per-word.
    calibration_offset: float = 0.0


@dataclass(frozen=True)
class PipelineConfig:
    vad: VadConfig = field(default_factory=VadConfig)
    matching: MatchConfig = field(default_factory=MatchConfig)
    postprocess: PostProcessConfig = field(default_factory=PostProcessConfig)
    correction: CorrectionConfig = field(default_factory=CorrectionConfig)
    # When True, the plain-lyrics path uses anchor-and-gap alignment instead of
    # global Needleman-Wunsch. Anchor regions preserve whisper-native timing.
    use_anchor_gap_alignment: bool = False
    anchor_gap_min_length: int = 3
    # When True, gap regions in the anchor-gap aligner run a chain of cheap
    # policies (WordCountMatch, NoSpacePunctMatch) before falling back to local
    # Needleman-Wunsch. The win is timing — gap policies force 1:1 pairing so
    # ref words borrow whisper timing instead of being interpolated when NW's
    # gap penalty would have skipped them.
    gap_handler_chain: bool = False
    # When True, the LRC-anchored path detects a global offset between the LRC
    # reference times and the whisper transcription, and shifts LRC times by
    # that offset before alignment. Public LRCs are commonly off by 0.1–1.5s.
    detect_lrc_offset: bool = True
    hallucination_phrases: tuple[str, ...] = (
        "thanks for watching", "thank you for watching", "subscribe",
        "like and subscribe", "please subscribe", "see you next time",
        "bye bye", "goodbye", "thank you", "thanks for listening",
    )
