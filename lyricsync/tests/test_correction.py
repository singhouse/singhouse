# SPDX-License-Identifier: MIT
"""Tests for LLM-assisted alignment correction (no network — mocked client)."""

import json

import pytest

from lyricsync._config import CorrectionConfig
from lyricsync._types import PlainLyricsReference, TimedWord
from lyricsync.alignment.needleman_wunsch import NeedlemanWunschAligner
from lyricsync.correction.apply import RegionCorrector
from lyricsync.correction.client import CorrectionUnavailable
from lyricsync.correction.prompt import build_user_prompt, parse_and_validate
from lyricsync.correction.regions import Region, build_regions

CFG = CorrectionConfig(enabled=True, base_url="http://test.invalid/v1")


def tw(text, start, end):
    return TimedWord(text=text, start=start, end=end)


# ---------------------------------------------------------------------------
# The garble-cascade scenario (song 217, "Little said is soonest mended"):
# whisper heard "Little it took it's not ..." — "Little" matched exactly,
# "is" fuzzy-matched a wrong token that steals a held note, "mended"
# squeezed, "said"/"soonest" dropped entirely.
# ---------------------------------------------------------------------------

GARBLE_REF = ["Little", "said", "is", "soonest", "mended", "Without", "a",
              "wing", "and", "a", "word"]
GARBLE_CLASSES = {
    0: "exact",        # Little
    2: "corrected",    # is <- "it's" (wrong match)
    4: "corrected",    # mended <- "not"
    5: "exact", 6: "exact", 7: "exact", 8: "exact", 9: "exact", 10: "exact",
}
GARBLE_TIMING = {
    0: {"start": 66.88, "end": 67.92},
    2: {"start": 68.40, "end": 69.72},
    4: {"start": 69.72, "end": 69.94},
    5: {"start": 70.00, "end": 70.35},
    6: {"start": 70.35, "end": 70.50},
    7: {"start": 70.50, "end": 70.90},
    8: {"start": 70.90, "end": 71.05},
    9: {"start": 71.05, "end": 71.20},
    10: {"start": 71.20, "end": 71.70},
}
GARBLE_WHISPER = [
    tw("Little", 66.88, 67.92),
    tw("it", 67.92, 68.20),
    tw("took", 68.20, 68.40),
    tw("it's", 68.40, 69.72),
    tw("not", 69.72, 69.94),
    tw("Without", 70.00, 70.35),
]
GARBLE_W2R = {0: 0, 3: 2, 4: 4, 5: 5}
GARBLE_LINES = [0, 5]


class TestRegionDetection:
    def test_garble_cluster_found_with_locked_singleton(self):
        # Classes: exact / interp / corrected / interp / corrected / exact*6.
        regions = build_regions(
            GARBLE_REF, GARBLE_CLASSES, GARBLE_TIMING, GARBLE_LINES,
            GARBLE_WHISPER, CFG,
        )
        assert len(regions) == 1
        r = regions[0]
        assert (r.lo, r.hi) == (1, 4)
        assert r.targets == [1, 2, 3, 4]
        assert r.locked == []
        assert "garble" in r.reasons
        assert r.window == (67.92, 70.00)

    def test_exact_singleton_inside_cluster_is_absorbed_locked(self):
        ref = ["a", "b", "c", "d", "e", "f", "g"]
        classes = {0: "exact", 2: "exact", 4: "corrected",
                   5: "exact", 6: "exact"}
        timing = {
            0: {"start": 1.0, "end": 1.4},
            2: {"start": 2.0, "end": 2.4},
            4: {"start": 3.0, "end": 3.4},
            5: {"start": 4.0, "end": 4.4},
            6: {"start": 4.4, "end": 4.8},
        }
        whisper = [tw("a", 1.0, 1.4), tw("c", 2.0, 2.4), tw("x", 3.0, 3.4),
                   tw("f", 4.0, 4.4), tw("g", 4.4, 4.8)]
        regions = build_regions(ref, classes, timing, [0], whisper, CFG)
        assert len(regions) == 1
        r = regions[0]
        assert (r.lo, r.hi) == (1, 4)
        assert r.locked == [2]
        assert r.targets == [1, 3, 4]
        # Bounded by the exact run of 2 at indices 5-6 and the exact at 0.
        assert r.window == (1.4, 4.0)

    def test_tight_gap_single_interpolated_word_skipped(self):
        ref = ["fly", "a", "miles"]
        classes = {0: "exact", 2: "exact"}
        timing = {0: {"start": 1.0, "end": 1.3}, 2: {"start": 1.5, "end": 1.9}}
        whisper = [tw("fly", 1.0, 1.3), tw("miles", 1.5, 1.9)]
        assert build_regions(ref, classes, timing, [0], whisper, CFG) == []

    def test_wide_gap_interpolated_word_qualifies(self):
        ref = ["fly", "said", "miles"]
        classes = {0: "exact", 2: "exact"}
        timing = {0: {"start": 1.0, "end": 1.3}, 2: {"start": 3.2, "end": 3.6}}
        whisper = [tw("fly", 1.0, 1.3), tw("miles", 3.2, 3.6)]
        regions = build_regions(ref, classes, timing, [0], whisper, CFG)
        assert len(regions) == 1
        assert regions[0].reasons == ["wide-gap"]

    def test_phrase_open_unlocks_following_exacts(self):
        # "wind | I know a man" — 'I' interpolated after a 30s solo. The
        # unlock rule hands the LLM 'know' and 'a' too; window is pinned
        # VAD onset -> last unlocked end.
        ref = ["wind", "I", "know", "a", "man"]
        classes = {0: "exact", 2: "exact", 3: "exact", 4: "exact"}
        timing = {
            0: {"start": 79.6, "end": 80.2},
            2: {"start": 110.11, "end": 110.7},
            3: {"start": 110.7, "end": 110.9},
            4: {"start": 110.9, "end": 111.3},
        }
        whisper = [tw("wind", 79.6, 80.2), tw("know", 110.11, 110.7),
                   tw("a", 110.7, 110.9), tw("man", 110.9, 111.3)]
        regions = build_regions(
            ref, classes, timing, [0, 1], whisper, CFG,
            vad_segments=[(78.9, 81.0), (110.11, 118.0)],
        )
        assert len(regions) == 1
        r = regions[0]
        assert "phrase-open" in r.reasons
        assert r.unlocked_exact == [2, 3]
        assert r.targets == [1, 2, 3]
        assert r.vad_onset == pytest.approx(110.11)
        assert r.window == (pytest.approx(110.11), pytest.approx(110.9))

    def test_cluster_spanning_line_break_splits_into_two_regions(self):
        # "…said is soonest mended | Without a wing…" — one non-exact
        # cluster across the line break must become two regions (cross-line
        # authority broke experiment 2, and huge regions stall local models).
        ref = ["end", "of", "is", "soonest", "mended", "Without", "a",
               "wing", "and", "then"]
        classes = {0: "exact", 1: "exact",
                   2: "corrected", 4: "corrected",
                   5: "corrected", 6: "corrected", 7: "corrected",
                   8: "exact", 9: "exact"}
        timing = {
            0: {"start": 66.0, "end": 66.4}, 1: {"start": 66.4, "end": 67.9},
            2: {"start": 68.4, "end": 69.7}, 4: {"start": 69.7, "end": 69.9},
            5: {"start": 70.0, "end": 70.3}, 6: {"start": 70.3, "end": 70.5},
            7: {"start": 70.5, "end": 70.9},
            8: {"start": 70.9, "end": 71.1}, 9: {"start": 71.1, "end": 71.3},
        }
        whisper = [tw("x", t["start"], t["end"]) for t in timing.values()]
        regions = build_regions(
            ref, classes, timing, [0, 5, 8], whisper, CFG,
        )
        assert [(r.lo, r.hi) for r in regions] == [(2, 4), (5, 7)]
        # Same exact-anchor window on both — the apply-side high-water
        # clamp is what keeps their outputs disjoint.
        assert regions[0].window == regions[1].window == (67.9, 70.9)

    def test_singleton_corrected_spelling_variant_skipped(self):
        # "tryin'" fuzzy-matched "trying": 1:1 timing is right; no call.
        ref = ["keep", "tryin'", "hard"]
        classes = {0: "exact", 1: "corrected", 2: "exact"}
        timing = {
            0: {"start": 1.0, "end": 1.4},
            1: {"start": 1.4, "end": 1.8},
            2: {"start": 1.8, "end": 2.2},
        }
        whisper = [tw("keep", 1.0, 1.4), tw("trying", 1.4, 1.8),
                   tw("hard", 1.8, 2.2)]
        assert build_regions(ref, classes, timing, [0], whisper, CFG) == []

    def test_no_regions_when_everything_exact(self):
        ref = ["a", "b"]
        classes = {0: "exact", 1: "exact"}
        timing = {0: {"start": 1.0, "end": 1.4}, 1: {"start": 1.4, "end": 1.8}}
        whisper = [tw("a", 1.0, 1.4), tw("b", 1.4, 1.8)]
        assert build_regions(ref, classes, timing, [0], whisper, CFG) == []


class TestValidation:
    def _region(self):
        return Region(lo=1, hi=4, window=(67.92, 70.00), reasons=["garble"])

    def _validate(self, payload, region=None):
        return parse_and_validate(
            json.dumps(payload) if not isinstance(payload, str) else payload,
            region or self._region(), GARBLE_REF, GARBLE_TIMING, CFG,
        )

    def _words(self, *spans):
        names = ["said", "is", "soonest", "mended"]
        return {
            "words": [
                {"word": n, "start": s, "end": e, "confidence": c}
                for n, (s, e, c) in zip(names, spans)
            ]
        }

    def test_valid_response_accepted(self):
        ok = self._words(
            (67.92, 68.18, "high"), (68.18, 68.40, "high"),
            (68.40, 68.70, "medium"), (68.70, 69.94, "high"),
        )
        accepted, err = self._validate(ok)
        assert err is None
        assert accepted[1] == {"start": 67.92, "end": 68.18}
        assert set(accepted) == {1, 2, 3, 4}

    def test_code_fenced_json_accepted(self):
        ok = self._words(
            (67.92, 68.18, "high"), (68.18, 68.40, "high"),
            (68.40, 68.70, "high"), (68.70, 69.94, "high"),
        )
        accepted, err = self._validate(f"```json\n{json.dumps(ok)}\n```")
        assert err is None and len(accepted) == 4

    def test_not_json_rejected(self):
        accepted, err = self._validate("sorry, I cannot")
        assert accepted is None and "JSON" in err

    def test_missing_word_rejected(self):
        bad = self._words((67.92, 68.18, "high"))
        accepted, err = self._validate(bad)
        assert accepted is None and "expected exactly 4" in err

    def test_wrong_order_rejected(self):
        bad = self._words(
            (67.92, 68.18, "high"), (68.18, 68.40, "high"),
            (68.40, 68.70, "high"), (68.70, 69.94, "high"),
        )
        bad["words"][0], bad["words"][1] = bad["words"][1], bad["words"][0]
        accepted, err = self._validate(bad)
        assert accepted is None and "order mismatch" in err

    def test_out_of_window_rejected(self):
        bad = self._words(
            (60.0, 68.18, "high"), (68.18, 68.40, "high"),
            (68.40, 68.70, "high"), (68.70, 69.94, "high"),
        )
        accepted, err = self._validate(bad)
        assert accepted is None and "window" in err

    def test_non_monotonic_rejected(self):
        bad = self._words(
            (69.0, 69.2, "high"), (68.18, 68.40, "high"),
            (68.40, 68.70, "high"), (68.70, 69.94, "high"),
        )
        accepted, err = self._validate(bad)
        assert accepted is None and "before the preceding" in err

    def test_numeric_confidence_coerced(self):
        # Local models sometimes emit 0.9 instead of "high".
        ok = self._words(
            (67.92, 68.18, 0.9), (68.18, 68.40, 0.6),
            (68.40, 68.70, 0.3), (68.70, 69.94, "high"),
        )
        accepted, err = self._validate(ok)
        assert err is None
        # 0.3 -> low -> gated out; 0.9/0.6 -> high/medium -> kept.
        assert set(accepted) == {1, 2, 4}

    def test_low_confidence_dropped_not_fatal(self):
        ok = self._words(
            (67.92, 68.18, "low"), (68.18, 68.40, "high"),
            (68.40, 68.70, "high"), (68.70, 69.94, "high"),
        )
        accepted, err = self._validate(ok)
        assert err is None
        assert 1 not in accepted and set(accepted) == {2, 3, 4}

    def test_locked_span_reorder_rejected(self):
        region = Region(
            lo=1, hi=4, locked=[3], window=(67.92, 70.00), reasons=["garble"],
        )
        timing = dict(GARBLE_TIMING)
        timing[3] = {"start": 68.60, "end": 68.90}
        payload = {
            "words": [
                {"word": "said", "start": 67.92, "end": 68.18, "confidence": "high"},
                {"word": "is", "start": 68.18, "end": 68.40, "confidence": "high"},
                # "mended" proposed before the locked "soonest" start:
                {"word": "mended", "start": 68.20, "end": 68.50, "confidence": "high"},
            ]
        }
        accepted, err = parse_and_validate(
            json.dumps(payload), region, GARBLE_REF, timing, CFG,
        )
        assert accepted is None and "locked" in err

    def test_prompt_mentions_locked_and_vad(self):
        region = Region(
            lo=1, hi=4, locked=[3], window=(67.92, 70.00),
            vad_onset=67.95, reasons=["garble"],
        )
        timing = dict(GARBLE_TIMING)
        timing[3] = {"start": 68.60, "end": 68.90}
        prompt = build_user_prompt(
            region, GARBLE_REF, timing, GARBLE_WHISPER, GARBLE_W2R, CFG,
        )
        assert "LOCKED" in prompt and "UNLOCKED" in prompt
        assert "67.95" in prompt
        assert '"took" [68.20, 68.40]' in prompt
        retry = build_user_prompt(
            region, GARBLE_REF, timing, GARBLE_WHISPER, GARBLE_W2R, CFG,
            retry_error="not valid JSON",
        )
        assert "rejected: not valid JSON" in retry


class FakeClient:
    """Scripted client: pops canned responses; raises when scripted to."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def complete_json(self, system, user):
        self.calls.append(user)
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


GOOD_RESPONSE = json.dumps({
    "words": [
        {"word": "said", "start": 67.92, "end": 68.18, "confidence": "high"},
        {"word": "is", "start": 68.18, "end": 68.40, "confidence": "high"},
        {"word": "soonest", "start": 68.40, "end": 68.70, "confidence": "medium"},
        {"word": "mended", "start": 68.70, "end": 69.94, "confidence": "high"},
    ]
})


def _correct(client):
    corrector = RegionCorrector(CFG, client=client)
    return corrector.correct(
        ref_words=GARBLE_REF,
        ref_to_timing=GARBLE_TIMING,
        classes=GARBLE_CLASSES,
        line_starts=GARBLE_LINES,
        whisper_words=GARBLE_WHISPER,
        whisper_to_ref=GARBLE_W2R,
    )


class TestRegionCorrector:
    def test_good_response_applied(self):
        client = FakeClient([GOOD_RESPONSE])
        timing, stats = _correct(client)
        assert timing[1] == {"start": 67.92, "end": 68.18}   # said gains timing
        assert timing[4] == {"start": 68.70, "end": 69.94}   # mended's hold back
        assert timing[2] == {"start": 68.18, "end": 68.40}   # is no longer 1.3s
        assert timing[0] == GARBLE_TIMING[0]                  # exact untouched
        assert timing[5] == GARBLE_TIMING[5]
        assert stats["regions_applied"] == 1
        assert stats["words_retimed"] == 4

    def test_input_timing_never_mutated(self):
        snapshot = {k: dict(v) for k, v in GARBLE_TIMING.items()}
        _correct(FakeClient([GOOD_RESPONSE]))
        assert GARBLE_TIMING == snapshot

    def test_endpoint_down_returns_input_unchanged(self):
        client = FakeClient([CorrectionUnavailable("connection refused")])
        timing, stats = _correct(client)
        assert timing == GARBLE_TIMING
        assert stats["regions_applied"] == 0
        assert stats["failures"] == 1
        assert len(client.calls) == 1   # no retry on transport failure

    def test_malformed_json_retried_once_with_error(self):
        client = FakeClient(["garbage{{{", GOOD_RESPONSE])
        timing, stats = _correct(client)
        assert len(client.calls) == 2
        assert "rejected" in client.calls[1]
        assert stats["regions_applied"] == 1
        assert timing[4] == {"start": 68.70, "end": 69.94}

    def test_two_bad_responses_fall_back(self):
        client = FakeClient(["garbage", "still garbage"])
        timing, stats = _correct(client)
        assert len(client.calls) == 2
        assert timing == GARBLE_TIMING
        assert stats["failures"] == 1

    def test_calibration_offset_applied(self):
        cfg = CorrectionConfig(
            enabled=True, base_url="http://test.invalid/v1",
            calibration_offset=0.25,
        )
        corrector = RegionCorrector(cfg, client=FakeClient([GOOD_RESPONSE]))
        timing, _ = corrector.correct(
            ref_words=GARBLE_REF, ref_to_timing=GARBLE_TIMING,
            classes=GARBLE_CLASSES, line_starts=GARBLE_LINES,
            whisper_words=GARBLE_WHISPER, whisper_to_ref=GARBLE_W2R,
        )
        assert timing[1] == {"start": pytest.approx(68.17),
                             "end": pytest.approx(68.43)}


class TestAlignerIntegration:
    WHISPER = [
        tw("Little", 66.88, 67.92),
        tw("it", 67.92, 68.20),
        tw("took", 68.20, 68.40),
        tw("it's", 68.40, 69.72),
        tw("not", 69.72, 69.94),
        tw("Without", 70.00, 70.35),
        tw("a", 70.35, 70.50),
        tw("wing", 70.50, 70.90),
        tw("and", 70.90, 71.05),
        tw("a", 71.05, 71.20),
        tw("word", 71.20, 71.70),
    ]
    REF = PlainLyricsReference(
        lines=["Little said is soonest mended", "Without a wing and a word"],
    )

    def test_no_corrector_baseline_unchanged(self):
        result = NeedlemanWunschAligner().align(self.WHISPER, self.REF)
        assert result.metadata.extra.get("llm_correction") is None

    def test_dead_endpoint_output_identical_to_disabled(self):
        baseline = NeedlemanWunschAligner().align(self.WHISPER, self.REF)
        dead = RegionCorrector(
            CFG, client=FakeClient([CorrectionUnavailable("down")] * 10),
        )
        result = NeedlemanWunschAligner(corrector=dead).align(
            self.WHISPER, self.REF,
        )
        assert [
            (w.text, w.start, w.end) for line in result.lines for w in line
        ] == [
            (w.text, w.start, w.end) for line in baseline.lines for w in line
        ]

    def test_corrected_region_flows_into_output(self):
        corrector = RegionCorrector(CFG, client=FakeClient([GOOD_RESPONSE]))
        result = NeedlemanWunschAligner(corrector=corrector).align(
            self.WHISPER, self.REF,
        )
        words = {w.text: w for w in result.lines[0]}
        assert words["mended"].end == pytest.approx(69.94)
        assert words["is"].end - words["is"].start < 0.5
        assert result.metadata.extra["llm_correction"]["regions_applied"] == 1
        # The LLM-timed words are matched now, not interpolated guesses.
        assert not words["said"].interpolated
