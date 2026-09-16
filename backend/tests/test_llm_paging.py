# SPDX-License-Identifier: AGPL-3.0-only
"""Instrumental breaks never sit inside a page.

The pager works from lyric TEXT, so it can group a line before a long
instrumental onto the same page as the line after it — and it can put the
break between two words of one line, which is the same defect one level down.
Nothing downstream noticed: ``apply_pages_to_word_sync`` mapped words onto
pages by token count without ever reading the times it was attaching, and the
stage only draws a countdown bar for a gap BETWEEN pages. Songs played with
their lyrics frozen on screen for the whole break.

Two mechanisms, tested apart: the prompt SHOWS the model the breaks, and the
split ENFORCES them regardless of what the model does with that.

Lyrics here are invented. Real lyric text does not belong in a fixture in an
AGPL repo, and the signal in these tests is entirely in the timings anyway.
"""

import pathlib
import re

from karaoke_backend.workers.llm_paging import (
    ANNOTATION_FENCE,
    INSTRUMENTAL_GAP_SEC,
    _SYSTEM_PROMPT,
    _TIMED_SYSTEM_PROMPT,
    _build_user_prompt,
    _line_spans,
    _mmss,
    _split_pages_at_breaks,
    _split_words_at_breaks,
    apply_pages_to_word_sync,
    structure_pages,
)


def _line(words, start, step=0.4):
    """An aligned line: one word per ``step`` seconds from ``start``."""
    return [
        {"text": w, "start": round(start + i * step, 3),
         "end": round(start + (i + 1) * step, 3)}
        for i, w in enumerate(words)
    ]


def _worst_gap_inside_a_page(doc):
    worst = 0.0
    for page in doc["pages"]:
        idx = page["line_idx"]
        for a, b in zip(idx, idx[1:]):
            worst = max(worst, doc["lines"][b][0]["start"] - doc["lines"][a][-1]["end"])
    return worst


# ── the split between lines ───────────────────────────────────────────────

def test_page_spanning_a_break_is_split():
    # The shape that motivated this: a line, ~50s of instrumental, the line that
    # comes back in — all on one page.
    lines = [_line(["alpha", "bravo"], 146.77),
             _line(["charlie", "delta"], 199.06),
             _line(["echo"], 200.62)]
    out = _split_pages_at_breaks(lines, [{"line_idx": [0, 1, 2], "new_section": True}])

    assert [p["line_idx"] for p in out] == [[0], [1, 2]]


def test_ordinary_gaps_do_not_split():
    lines = [_line(["one", "two"], 10.0), _line(["three", "four"], 13.0)]
    out = _split_pages_at_breaks(lines, [{"line_idx": [0, 1], "new_section": False}])

    assert [p["line_idx"] for p in out] == [[0, 1]]


def test_split_is_exactly_at_the_threshold():
    """The boundary is where `>=` lives, so pin the boundary itself."""
    cases = ((INSTRUMENTAL_GAP_SEC + 0.1, 2),
             (INSTRUMENTAL_GAP_SEC, 2),
             (INSTRUMENTAL_GAP_SEC - 0.1, 1))
    for gap, expected in cases:
        first = _line(["a", "b"], 10.0)
        second = _line(["c", "d"], first[-1]["end"] + gap)
        out = _split_pages_at_breaks([first, second],
                                     [{"line_idx": [0, 1], "new_section": False}])
        assert len(out) == expected, f"gap {gap}"


def test_untimed_line_does_not_split():
    """No times is no evidence of a break — leave the page as the pager built it."""
    lines = [_line(["a", "b"], 10.0), [{"text": "c"}], _line(["d"], 90.0)]
    out = _split_pages_at_breaks(lines, [{"line_idx": [0, 1, 2], "new_section": False}])

    assert [p["line_idx"] for p in out] == [[0, 1, 2]]


def test_every_line_is_kept_in_order():
    lines = [_line([f"w{i}"], 10.0 + i * 20) for i in range(5)]  # every gap is a break
    out = _split_pages_at_breaks(lines, [{"line_idx": [0, 1, 2, 3, 4], "new_section": True}])

    assert [i for p in out for i in p["line_idx"]] == [0, 1, 2, 3, 4]


# ── the split INSIDE a line ───────────────────────────────────────────────

def test_a_break_between_two_words_of_one_line_splits_the_line():
    """The pager sees one line; the break is between its words, not its lines.

    Found in review: splitting only between lines left 9 of the library's
    paged sets still frozen, the worst by 78.8s — longer than the freeze that
    opened the ticket.
    """
    words = _line(["before", "the", "break"], 60.0) + _line(["after", "it"], 130.0)
    pieces = _split_words_at_breaks(words)

    assert [[w["text"] for w in p] for p in pieces] == [
        ["before", "the", "break"], ["after", "it"]]


def test_a_line_without_a_break_is_one_piece():
    words = _line(["still", "one", "line"], 10.0)

    assert _split_words_at_breaks(words) == [words]


def test_intra_line_break_survives_the_whole_mapping():
    """End to end: one model line, one page, a break in the middle of both."""
    word_data = {"lines": [_line(["before", "the", "break"], 60.0)
                           + _line(["after", "it"], 130.0)]}
    pages = [{"lines": ["before the break after it"], "new_section": True}]

    out = apply_pages_to_word_sync(word_data, pages)

    assert len(out["pages"]) == 2, "the line spanning the break was not split"
    assert _worst_gap_inside_a_page(out) < INSTRUMENTAL_GAP_SEC
    assert [w["text"] for l in out["lines"] for w in l] == [
        "before", "the", "break", "after", "it"], "words lost or reordered"


def test_untimed_words_do_not_split_a_line():
    words = [{"text": "a"}, {"text": "b"}]

    assert _split_words_at_breaks(words) == [words]


# ── the split, through the function that owns the payload ─────────────────

def test_apply_pages_splits_and_repairs_the_recipe():
    word_data = {"lines": [_line(["alpha", "bravo"], 146.77)
                           + _line(["charlie", "delta"], 199.06)]}
    pages = [{"lines": ["alpha bravo", "charlie delta"], "new_section": True}]

    out = apply_pages_to_word_sync(word_data, pages)

    assert len(out["pages"]) == 2, "the page spanning the break was not split"
    assert _worst_gap_inside_a_page(out) < INSTRUMENTAL_GAP_SEC
    # The page that re-enters after the silence earns a lead-in. (So does the
    # first page of any song — an existing rule, `gap_in` is inf at i == 0.)
    assert [l["line_idx"] for l in out["lead_ins"]] == [0, 1]
    # Fades are recomputed per page, not inherited from the un-split one.
    assert out["pages"][0]["fade_out_start"] < out["pages"][1]["fade_in_start"]
    assert out["metadata"]["pages_source"] == "llm"


def test_pages_without_breaks_are_untouched():
    word_data = {"lines": [_line(["one", "two"], 10.0) + _line(["three", "four"], 12.0)]}
    pages = [{"lines": ["one two", "three four"], "new_section": True}]

    out = apply_pages_to_word_sync(word_data, pages)

    assert len(out["pages"]) == 1
    assert out["pages"][0]["line_idx"] == [0, 1]


def test_a_partially_timed_line_leading_a_page_does_not_raise():
    """The split can promote such a line to page-leading, where blind indexing
    of `[0]["start"]` would raise. Degrade to the input instead."""
    word_data = {"lines": [_line(["a"], 10.0)
                           + [{"text": "b"}, {"text": "c", "start": 90.0, "end": 90.4}]]}
    pages = [{"lines": ["a b c"], "new_section": True}]

    out = apply_pages_to_word_sync(word_data, pages)

    assert isinstance(out, dict)  # no exception; pages present or not, it survives


# ── the prompt ────────────────────────────────────────────────────────────

def test_spans_walk_the_two_streams_in_parallel():
    flat = _line(["a", "b"], 1.0) + _line(["c"], 30.0)

    assert _line_spans(["a b", "c"], flat) == [(1.0, 1.8), (30.0, 30.4)]


def test_spans_refuse_a_mismatched_stream():
    """Wrong times are worse than none: the caller falls back to a bare list."""
    assert _line_spans(["a b c"], _line(["a", "b"], 1.0)) is None


def test_prompt_without_spans_is_the_bare_numbered_list():
    prompt = _build_user_prompt("first line\nsecond line")

    assert "1. first line" in prompt and "2. second line" in prompt
    assert ANNOTATION_FENCE not in prompt and "INSTRUMENTAL" not in prompt


def test_prompt_marks_the_line_before_a_break():
    flat = _line(["before", "the", "break"], 60.0) + _line(["after", "it"], 130.0)
    spans = _line_spans(["before the break", "after it"], flat)

    prompt = _build_user_prompt("before the break\nafter it", spans)
    rows = [r for r in prompt.splitlines() if re.match(r"^\d+\.", r)]

    assert rows[0] == f"1. [1:00.0] 69s-INSTRUMENTAL-BREAK-AFTER-THIS-LINE {ANNOTATION_FENCE} before the break"
    assert "INSTRUMENTAL" not in rows[1]
    # Every row stays a numbered lyric row: a marker on a row of its own made
    # the model drop the preceding line's words, which fails validation.
    assert len(rows) == 2


def test_lyric_text_after_the_fence_is_never_rewritten():
    """`_validate_pages` compares against the RAW text, so any substitution we
    made to dodge a collision would fail the check it was meant to protect."""
    lyric = "[Chorus] << not annotation >>"
    spans = _line_spans([lyric], _line(lyric.split(), 10.0))

    row = _build_user_prompt(lyric, spans).splitlines()[-1]

    assert row.endswith(f"{ANNOTATION_FENCE} {lyric}")


def test_prompt_leaves_ordinary_gaps_unmarked():
    flat = _line(["one"], 10.0) + _line(["two"], 12.0)
    prompt = _build_user_prompt("one\ntwo", _line_spans(["one", "two"], flat))

    assert "INSTRUMENTAL" not in prompt
    assert "[0:10.0]" in prompt


def test_timestamps_never_carry_a_sixtieth_second():
    """Rounding after the split would print the nonexistent "0:60.0"."""
    for t in (59.97, 119.99, 599.99, 0.0, 146.77):
        assert float(_mmss(t).split(":")[1]) < 60.0, t


def test_the_two_system_prompts_differ_only_in_the_break_rule():
    assert _SYSTEM_PROMPT != _TIMED_SYSTEM_PROMPT
    assert "never copy" in _TIMED_SYSTEM_PROMPT.lower()
    assert ANNOTATION_FENCE in _TIMED_SYSTEM_PROMPT
    for prompt in (_SYSTEM_PROMPT, _TIMED_SYSTEM_PROMPT):
        assert '"pages"' in prompt
        assert "karaoke display pager" in prompt


def test_clause_split_example_is_invented_and_keeps_the_measured_shape():
    """The prompt still teaches one comma-joined row becoming two lines."""
    joined = "Lanterns glow beyond the hill, quiet footsteps cross the sill"
    first = "Lanterns glow beyond the hill"
    second = "quiet footsteps cross the sill"

    for prompt in (_SYSTEM_PROMPT, _TIMED_SYSTEM_PROMPT):
        assert joined in prompt
        assert first in prompt and second in prompt
        joined_at = prompt.index(joined)
        first_at = prompt.index(first, joined_at + len(joined))
        second_at = prompt.index(second, first_at + len(first))
        assert joined_at < first_at < second_at
        assert len(first.split()) == 5 == len(second.split())


class _CapturingClient:
    def __init__(self):
        self.system = self.user = None

    def complete_json(self, system, user):
        self.system, self.user = system, user
        return '{"pages": [{"lines": ["a b"], "new_section": true}]}'


def test_a_mismatched_stream_falls_back_to_the_un_annotated_prompt():
    """The safety property the annotation leans on: wrong times are never sent."""
    client = _CapturingClient()
    structure_pages(client, "a b", flat=_line(["a", "b", "c"], 1.0))

    assert client.system == _SYSTEM_PROMPT
    assert ANNOTATION_FENCE not in client.user


def test_no_aligned_words_falls_back_too():
    client = _CapturingClient()
    structure_pages(client, "a b", flat=None)

    assert client.system == _SYSTEM_PROMPT
    assert ANNOTATION_FENCE not in client.user


def test_aligned_words_produce_the_annotated_prompt():
    client = _CapturingClient()
    structure_pages(client, "a b", flat=_line(["a", "b"], 1.0))

    assert client.system == _TIMED_SYSTEM_PROMPT
    assert ANNOTATION_FENCE in client.user


def test_threshold_agrees_with_the_stage():
    """The split makes page boundaries the stage must agree are breaks; if the
    two constants drift, it produces boundaries the stage draws no bar for."""
    adapter = (pathlib.Path(__file__).resolve().parents[2]
               / "frontend" / "src" / "stage" / "adapter.mjs")
    match = re.search(r"^const INSTRUMENTAL_GAP_SEC = ([\d.]+)$",
                      adapter.read_text(), re.MULTILINE)

    assert match, "the stage's INSTRUMENTAL_GAP_SEC moved or was renamed"
    assert float(match.group(1)) == INSTRUMENTAL_GAP_SEC
