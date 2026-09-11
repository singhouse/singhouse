# SPDX-License-Identifier: MIT
from __future__ import annotations

import logging
from typing import List, Optional

from lyricsync._config import MatchConfig, PostProcessConfig
from lyricsync._types import (
    AlignmentReference,
    LrcLine,
    LrcReference,
    SyncMetadata,
    SyncResult,
    TimedWord,
)
from lyricsync.alignment.lrc import estimate_line_singing_duration, strip_lrc_tags
from lyricsync.alignment.lrc_offset import OffsetReport, detect_lrc_offset
from lyricsync.alignment.matching import normalize, word_match_score
from lyricsync.alignment.needleman_wunsch import _align_sequences

logger = logging.getLogger(__name__)


def _enforce_monotonic(line_words: List[TimedWord], min_dur: float = 0.08) -> List[TimedWord]:
    """Ensure word timestamps are strictly monotonic, fixing overlaps."""
    if len(line_words) <= 1:
        return line_words

    line_words = sorted(line_words, key=lambda w: w.start)

    for i in range(len(line_words) - 1):
        if line_words[i].end > line_words[i + 1].start:
            line_words[i] = TimedWord(
                text=line_words[i].text,
                start=line_words[i].start,
                end=line_words[i + 1].start,
                interpolated=line_words[i].interpolated,
            )

    for i in range(len(line_words)):
        if line_words[i].end - line_words[i].start < min_dur:
            line_words[i] = TimedWord(
                text=line_words[i].text,
                start=line_words[i].start,
                end=line_words[i].start + min_dur,
                interpolated=line_words[i].interpolated,
            )
            for j in range(i + 1, len(line_words)):
                if line_words[j].start < line_words[j - 1].end:
                    shift = line_words[j - 1].end - line_words[j].start
                    line_words[j] = TimedWord(
                        text=line_words[j].text,
                        start=line_words[j].start + shift,
                        end=line_words[j].end + shift,
                        interpolated=line_words[j].interpolated,
                    )
                else:
                    break

    return line_words


def _whisper_quality_score(lrc_lines: List[LrcLine], whisper_words: List[TimedWord]) -> float:
    """Estimate how well Whisper transcription matches reference lyrics."""
    ref_words: list[str] = []
    for lrc_line in lrc_lines:
        clean = strip_lrc_tags(lrc_line.text)
        ref_words.extend(clean.split())

    if not ref_words or not whisper_words:
        return 0.0

    whisper_texts = [normalize(w.text) for w in whisper_words]
    ref_normalized = [normalize(w) for w in ref_words]

    whisper_set = set(whisper_texts)
    matches = sum(1 for r in ref_normalized if r and r in whisper_set)
    return matches / len(ref_normalized) if ref_normalized else 0.0


class LrcAnchoredAligner:
    """Build word-level sync using LRC line timestamps as anchors."""

    def __init__(
        self,
        match_config: MatchConfig | None = None,
        post_config: PostProcessConfig | None = None,
        detect_offset: bool = False,
    ):
        self.match_config = match_config or MatchConfig()
        self.post_config = post_config or PostProcessConfig()
        self.detect_offset = detect_offset

    def align(
        self,
        whisper_words: List[TimedWord],
        reference: AlignmentReference,
    ) -> SyncResult:
        if not isinstance(reference, LrcReference):
            raise TypeError("LrcAnchoredAligner requires LrcReference")

        lrc_lines = reference.lines

        offset_report: Optional[OffsetReport] = None
        if self.detect_offset:
            offset_report = detect_lrc_offset(whisper_words, lrc_lines)
            if offset_report.applied:
                logger.info(
                    "LRC offset shift: %+.3fs applied (n=%d, iqr=%.3fs, raw_median=%+.3fs)",
                    offset_report.shift, offset_report.n_samples,
                    offset_report.iqr, offset_report.raw_median,
                )
                lrc_lines = [
                    LrcLine(time=l.time + offset_report.shift, text=l.text)
                    for l in lrc_lines
                ]
            else:
                logger.info(
                    "LRC offset not applied: %s (n=%d, raw_median=%+.3fs, iqr=%.3fs)",
                    offset_report.reason, offset_report.n_samples,
                    offset_report.raw_median, offset_report.iqr,
                )
        quality = _whisper_quality_score(lrc_lines, whisper_words)
        use_whisper = quality >= self.post_config.whisper_quality_threshold
        logger.info(
            "Whisper quality score: %.2f (%s)",
            quality,
            "using word alignment" if use_whisper else "falling back to even distribution",
        )

        all_words: list[TimedWord] = []
        grouped_lines: list[list[TimedWord]] = []

        for li, lrc_line in enumerate(lrc_lines):
            line_start = lrc_line.time
            next_line_start = lrc_lines[li + 1].time if li + 1 < len(lrc_lines) else line_start + 10.0

            clean_text = strip_lrc_tags(lrc_line.text)
            ref_words_in_line = clean_text.split()
            if not ref_words_in_line:
                continue

            singing_dur = estimate_line_singing_duration(
                line_start, next_line_start, len(ref_words_in_line),
                self.post_config.per_word_singing_duration,
            )
            line_end = line_start + singing_dur

            search_end = next_line_start
            window_whisper = [
                w for w in whisper_words
                if w.start >= line_start - 0.5 and w.start < search_end + 0.5
            ]

            line_word_list: list[TimedWord] = []

            if use_whisper and window_whisper and len(window_whisper) >= len(ref_words_in_line) * 0.3:
                w_texts = [w.text for w in window_whisper]
                alignment = _align_sequences(w_texts, ref_words_in_line, self.match_config)

                ref_timing: dict[int, dict] = {}
                for w_idx, r_idx in alignment:
                    if r_idx >= 0 and w_idx < len(window_whisper):
                        wt = window_whisper[w_idx]
                        if wt.start >= line_start - 0.3 and wt.start <= line_end + 1.0:
                            ref_timing[r_idx] = {
                                "start": wt.start,
                                "end": wt.end,
                            }

                if ref_timing:
                    sorted_matches = sorted(ref_timing.items())
                    is_monotonic = all(
                        sorted_matches[i][1]["start"] <= sorted_matches[i + 1][1]["start"]
                        for i in range(len(sorted_matches) - 1)
                    )
                    if not is_monotonic:
                        logger.debug("Line %d: non-monotonic alignment, using even distribution", li)
                        ref_timing = {}

                if not ref_timing:
                    line_word_list = self._even_distribute(ref_words_in_line, line_start, singing_dur)
                    all_words.extend(line_word_list)
                    grouped_lines.append(line_word_list)
                    continue

                last_matched_end = max(t["end"] for t in ref_timing.values())
                line_end = max(line_end, last_matched_end)

                for ri, ref_word in enumerate(ref_words_in_line):
                    if ri in ref_timing:
                        t = ref_timing[ri]
                        line_word_list.append(TimedWord(
                            text=ref_word, start=t["start"], end=t["end"],
                        ))
                    else:
                        line_word_list.append(
                            self._interpolate_word(ri, ref_words_in_line, ref_timing, line_start, singing_dur)
                        )
            else:
                line_word_list = self._even_distribute(ref_words_in_line, line_start, singing_dur)

            line_word_list = _enforce_monotonic(line_word_list, self.post_config.min_word_duration)
            all_words.extend(line_word_list)
            grouped_lines.append(line_word_list)

        # Fix overlaps between lines
        for i in range(len(all_words) - 1):
            if all_words[i].end > all_words[i + 1].start:
                new_end = all_words[i + 1].start
                if new_end - all_words[i].start < self.post_config.min_inter_word_gap:
                    new_end = all_words[i].start + self.post_config.min_inter_word_gap
                all_words[i] = TimedWord(
                    text=all_words[i].text,
                    start=all_words[i].start,
                    end=new_end,
                    interpolated=all_words[i].interpolated,
                )

        flat_words = [{"text": w.text, "start": w.start, "end": w.end} for w in all_words]

        extra = {"whisper_quality": round(quality, 3)}
        if offset_report is not None:
            extra["lrc_offset_applied"] = offset_report.applied
            extra["lrc_offset_shift"] = round(offset_report.shift, 3)
            extra["lrc_offset_n_samples"] = offset_report.n_samples
            extra["lrc_offset_iqr"] = round(offset_report.iqr, 3)
            extra["lrc_offset_raw_median"] = round(offset_report.raw_median, 3)
            if not offset_report.applied:
                extra["lrc_offset_skip_reason"] = offset_report.reason

        return SyncResult(
            segments=[{"words": flat_words}],
            lines=grouped_lines,
            metadata=SyncMetadata(
                words_total=len(all_words),
                lines_total=len(grouped_lines),
                method="lrc-anchored" if use_whisper else "lrc-distributed",
                extra=extra,
            ),
        )

    @staticmethod
    def _even_distribute(
        words: list[str], line_start: float, singing_dur: float,
    ) -> list[TimedWord]:
        n = len(words)
        word_dur = singing_dur / n
        return [
            TimedWord(text=w, start=line_start + i * word_dur, end=line_start + (i + 1) * word_dur)
            for i, w in enumerate(words)
        ]

    @staticmethod
    def _interpolate_word(
        ri: int,
        ref_words: list[str],
        ref_timing: dict[int, dict],
        line_start: float,
        singing_dur: float,
    ) -> TimedWord:
        ref_word = ref_words[ri]

        prev_end = None
        next_start = None
        prev_idx = None
        next_idx = None
        for pi in range(ri - 1, -1, -1):
            if pi in ref_timing:
                prev_end = ref_timing[pi]["end"]
                prev_idx = pi
                break
        for ni in range(ri + 1, len(ref_words)):
            if ni in ref_timing:
                next_start = ref_timing[ni]["start"]
                next_idx = ni
                break

        if prev_end is not None and next_start is not None:
            unmatched_count = next_idx - prev_idx - 1
            slot = ri - prev_idx
            span = next_start - prev_end
            word_dur = span / (unmatched_count + 1)
            est_start = prev_end + slot * word_dur
            return TimedWord(text=ref_word, start=est_start, end=est_start + word_dur)
        elif prev_end is not None:
            est_start = prev_end + 0.05
            return TimedWord(text=ref_word, start=est_start, end=est_start + 0.3)
        elif next_start is not None:
            est_end = next_start - 0.05
            return TimedWord(text=ref_word, start=max(line_start, est_end - 0.3), end=est_end)
        else:
            n = len(ref_words)
            word_dur = singing_dur / n
            return TimedWord(
                text=ref_word,
                start=line_start + ri * word_dur,
                end=line_start + (ri + 1) * word_dur,
            )
