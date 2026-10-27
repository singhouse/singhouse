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
split ENFORCES them regardless of what the model does with that. Page size
works the same way — the prompt asks for short pages, a guard enforces a
ceiling — and the fade recipe keeps short, fast pages readable in time.

Lyrics here are invented. Real lyric text does not belong in a fixture in an
AGPL repo, and the signal in these tests is entirely in the timings anyway.
"""

import pathlib
import re

from karaoke_backend.workers.llm_paging import (
    ANNOTATION_FENCE,
    CROWDED_FADE,
    FADE_DUR,
    HOLD,
    INSTRUMENTAL_GAP_SEC,
    MAX_PAGE_LINES,
    MAX_PAGE_SECS,
    MAX_PAGE_WORDS,
    MIN_HOLD,
    MIN_LEAD,
    PRE_ROLL,
    _SYSTEM_PROMPT,
    _TIMED_SYSTEM_PROMPT,
    _build_user_prompt,
    _line_spans,
    _mmss,
    _split_oversized_pages,
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

    assert rows[0] == (f"1. [1:00.0-1:01.2, 1.2s] 69s-INSTRUMENTAL-BREAK-AFTER-THIS-LINE"
                       f" {ANNOTATION_FENCE} before the break")
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
    assert "[0:10.0-0:10.4, 0.4s]" in prompt


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


def test_timed_rows_show_start_end_and_duration():
    """The model sees how long a line is sung, not just when it starts — a slow
    line and a quick one looked the same to it before."""
    flat = _line(["slow", "words", "here"], 5.0, step=2.0) + _line(["quick"], 12.0)
    spans = _line_spans(["slow words here", "quick"], flat)

    rows = _build_user_prompt("slow words here\nquick", spans).splitlines()[-2:]

    assert rows[0] == f"1. [0:05.0-0:11.0, 6.0s] {ANNOTATION_FENCE} slow words here"
    assert rows[1] == f"2. [0:12.0-0:12.4, 0.4s] {ANNOTATION_FENCE} quick"


def test_the_duration_rule_is_only_in_the_timed_prompt():
    """The plain prompt has no durations to point at; asking for them there
    would invite the model to invent some."""
    for phrase in ("5 seconds or more", "[start-end, duration]"):
        assert phrase in _TIMED_SYSTEM_PROMPT
        assert phrase not in _SYSTEM_PROMPT


def test_both_prompts_ask_for_short_pages():
    for prompt in (_SYSTEM_PROMPT, _TIMED_SYSTEM_PROMPT):
        assert "1 or 2 display lines" in prompt
        assert "at most about 10 words" in prompt
        assert "dangling" in prompt


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


# ── the page-size guard ───────────────────────────────────────────────────

def _one_page(n_lines, new_section=True):
    return [{"line_idx": list(range(n_lines)), "new_section": new_section}]


def test_a_three_line_page_is_split():
    lines = [_line(["a", "b"], 10.0), _line(["c", "d"], 11.0), _line(["e", "f"], 12.0)]
    out = _split_oversized_pages(lines, _one_page(3))

    assert [p["line_idx"] for p in out] == [[0, 1], [2]]


def test_a_page_over_the_word_limit_is_split():
    lines = [_line([f"a{i}" for i in range(7)], 10.0, step=0.2),
             _line([f"b{i}" for i in range(7)], 11.5, step=0.2)]
    out = _split_oversized_pages(lines, _one_page(2))

    assert [p["line_idx"] for p in out] == [[0], [1]]


def test_a_page_sung_too_long_is_split():
    """Two slow lines with an ordinary gap: no break to split on, but nobody
    should read one page for nearly ten seconds."""
    lines = [_line(["slow", "slow", "slow"], 0.0, step=1.5),   # ends 4.5
             _line(["more", "more", "more"], 6.0, step=1.2)]   # ends 9.6
    out = _split_oversized_pages(lines, _one_page(2))

    assert [p["line_idx"] for p in out] == [[0], [1]]


def test_a_single_over_long_line_is_left_whole():
    """Cutting a line would be guessing at a phrase boundary; it gets a page
    of its own instead."""
    lines = [_line([f"w{i}" for i in range(15)], 0.0, step=1.0)]   # 15 words, 15s
    out = _split_oversized_pages(lines, _one_page(1))

    assert [p["line_idx"] for p in out] == [[0]]
    assert len(lines[0]) == 15


def test_an_over_long_line_inside_a_page_gets_its_own_page():
    lines = [_line(["one", "two"], 0.0),
             _line([f"w{i}" for i in range(14)], 1.0, step=0.2),
             _line(["three", "four"], 4.0)]
    out = _split_oversized_pages(lines, _one_page(3))

    assert [p["line_idx"] for p in out] == [[0], [1], [2]]


def test_only_the_first_size_piece_keeps_new_section():
    lines = [_line(["a"], 10.0), _line(["b"], 11.0), _line(["c"], 12.0),
             _line(["d"], 13.0), _line(["e"], 14.0)]
    out = _split_oversized_pages(lines, _one_page(5, new_section=True))

    assert [p["new_section"] for p in out] == [True, False, False]
    assert [i for p in out for i in p["line_idx"]] == [0, 1, 2, 3, 4]


def test_a_page_exactly_at_every_limit_is_untouched():
    lines = [_line([f"a{i}" for i in range(6)], 0.0, step=0.5),    # 0.0-3.0
             _line([f"b{i}" for i in range(6)], 6.0, step=0.5)]    # 6.0-9.0
    assert len(lines) == MAX_PAGE_LINES
    assert sum(len(line) for line in lines) == MAX_PAGE_WORDS
    assert lines[1][-1]["end"] - lines[0][0]["start"] == MAX_PAGE_SECS

    out = _split_oversized_pages(lines, _one_page(2, new_section=False))

    assert out == _one_page(2, new_section=False)


def _untimed(*words):
    return [{"text": w} for w in words]


def _every_page_has_a_timed_word(doc):
    return all(
        any("start" in w for i in p["line_idx"] for w in doc["lines"][i])
        for p in doc["pages"]
    )


def test_an_untimed_line_over_the_line_limit_does_not_lose_the_pages():
    """An untimed line split off on its own is a page with no timed word, which
    aborts the apply and costs the song every page. It rides along instead."""
    word_data = {"lines": [_line(["a", "b"], 10.0) + _line(["c", "d"], 11.0)
                           + _untimed("e", "f")]}
    pages = [{"lines": ["a b", "c d", "e f"], "new_section": True}]

    out = apply_pages_to_word_sync(word_data, pages)

    assert "pages" in out
    assert [p["line_idx"] for p in out["pages"]] == [[0, 1, 2]]
    assert _every_page_has_a_timed_word(out)


def test_an_untimed_line_over_the_word_limit_does_not_lose_the_pages():
    timed = [f"t{i}" for i in range(8)]
    untimed = [f"u{i}" for i in range(6)]
    word_data = {"lines": [_line(timed, 10.0, step=0.2) + _untimed(*untimed)]}
    pages = [{"lines": [" ".join(timed), " ".join(untimed)], "new_section": True}]

    out = apply_pages_to_word_sync(word_data, pages)

    assert "pages" in out
    assert [p["line_idx"] for p in out["pages"]] == [[0, 1]]
    assert _every_page_has_a_timed_word(out)


def test_a_leading_untimed_line_rides_with_the_next_timed_line():
    """The leader alone fills the word limit, so a plain greedy split would
    close it as an untimed-only first page."""
    leader = [f"u{i}" for i in range(MAX_PAGE_WORDS)]
    word_data = {"lines": [_untimed(*leader) + _line(["a", "b"], 10.0)
                           + _line(["c", "d"], 11.0) + _line(["e", "f"], 12.0)]}
    pages = [{"lines": [" ".join(leader), "a b", "c d", "e f"], "new_section": True}]

    out = apply_pages_to_word_sync(word_data, pages)

    assert "pages" in out
    assert out["pages"][0]["line_idx"] == [0, 1]
    assert [i for p in out["pages"] for i in p["line_idx"]] == [0, 1, 2, 3]
    assert _every_page_has_a_timed_word(out)


def test_an_oversized_model_page_is_split_through_apply():
    """End to end: the model ignores the prompt and returns one four-line page."""
    texts = ["red kites", "over the barn", "slow rain", "on the tin"]
    word_data = {"lines": [_line(t.split(), 10.0 + 2.0 * i) for i, t in enumerate(texts)]}
    pages = [{"lines": texts, "new_section": True}]

    out = apply_pages_to_word_sync(word_data, pages)

    assert [p["line_idx"] for p in out["pages"]] == [[0, 1], [2, 3]]
    assert [" ".join(w["text"] for w in line) for line in out["lines"]] == texts


# ── fades for crowded pages ───────────────────────────────────────────────

def _one_page_per_line(starts, words=("la", "la", "la"), step=0.3):
    """One model page per line; each line ``len(words) * step`` seconds long."""
    lines = [_line(list(words), s, step=step) for s in starts]
    pages = [{"lines": [" ".join(words)], "new_section": i == 0}
             for i in range(len(starts))]
    return apply_pages_to_word_sync({"lines": lines}, pages)


def _sung(doc, page):
    words = [w for i in page["line_idx"] for w in doc["lines"][i]]
    return words[0]["start"], words[-1]["end"]


def _old_fade_in_starts(spans):
    """The recipe before crowding was handled: fixed hold and fade on i-2."""
    out = []
    for i, (s, _) in enumerate(spans):
        fin = max(0.0, s - PRE_ROLL)
        if i >= 2:
            fin = max(fin, spans[i - 2][1] + HOLD + FADE_DUR)
        out.append(fin)
    return out


def test_uncrowded_pages_keep_the_original_recipe_exactly():
    # Page 2 starts 3.9s in: page 0 is gone at 2.8, inside PRE_ROLL of it, so
    # the old two-on-screen clamp applies — and still leaves a full MIN_LEAD.
    out = _one_page_per_line([0.0, 2.0, 3.9, 12.0, 20.0])
    spans = [_sung(out, p) for p in out["pages"]]

    for page, (_, e), fin in zip(out["pages"], spans, _old_fade_in_starts(spans),
                               strict=True):
        assert page["fade_in_start"] == round(fin, 3)
        assert page["fade_in_dur"] == FADE_DUR
        assert page["fade_out_start"] == round(e + HOLD, 3)
        assert page["fade_out_dur"] == FADE_DUR
    assert out["pages"][2]["fade_in_start"] == 2.8  # the clamp, not s - PRE_ROLL


def test_fast_short_pages_are_fully_shown_before_they_are_sung():
    # A 0.9s line every 1.2s, starting late enough that the first page has
    # room for its own pre-roll.
    starts = [5.0 + i * 1.2 for i in range(8)]
    out = _one_page_per_line(starts)
    spans = [_sung(out, p) for p in out["pages"]]

    # Under the old recipe these pages were still fading in, or not even
    # started, when their first word was sung.
    old = _old_fade_in_starts(spans)
    assert any(fin + FADE_DUR > s for fin, (s, _) in zip(old, spans, strict=True))

    for page, (s, _) in zip(out["pages"], spans, strict=True):
        shown = page["fade_in_start"] + page["fade_in_dur"]
        assert shown <= s - MIN_LEAD + 1e-9, (page, s)


def test_a_crowded_page_and_the_one_it_waits_for_both_fade_quickly():
    out = _one_page_per_line([0.0, 1.2, 2.4])
    first, _, third = out["pages"]

    assert first["fade_out_dur"] == CROWDED_FADE
    assert third["fade_in_dur"] == CROWDED_FADE
    # Page 0's last word ends at 0.9; it leaves at 2.4 - MIN_LEAD - 2 * fade.
    assert first["fade_out_start"] == 1.5
    assert third["fade_in_start"] == 1.75


def test_the_minimum_hold_holds_on_unrounded_word_times():
    """Rounding the floor to nearest could land half a millisecond under it."""
    lines = [[{"text": "a", "start": 0.6, "end": 1.0004}],
             _line(["b"], 1.5), _line(["c"], 2.0)]
    pages = [{"lines": [w], "new_section": False} for w in ("a", "b", "c")]

    out = apply_pages_to_word_sync({"lines": lines}, pages)
    first = out["pages"][0]

    assert first["fade_out_dur"] == CROWDED_FADE, "the case must be crowded"
    assert first["fade_out_start"] >= 1.0004 + MIN_HOLD
    assert first["fade_out_start"] == 1.301


def _assert_recipe_invariants(doc):
    pages = doc["pages"]
    for i, page in enumerate(pages):
        s, e = _sung(doc, page)
        assert page["fade_out_start"] >= e + MIN_HOLD - 1e-9, (i, page)
        if i >= 2:
            q = pages[i - 2]
            assert page["fade_in_start"] >= (
                q["fade_out_start"] + q["fade_out_dur"] - 1e-9), (i, page)


def test_crowding_keeps_the_hold_and_the_two_page_limit():
    # Mixed tempo, including pages so tight that even MIN_HOLD leaves no room:
    # the hold and the two-on-screen rule must survive, the lead gives way.
    starts = [0.0, 1.0, 1.6, 2.2, 5.0, 6.1, 7.2, 15.0, 15.5, 16.0, 30.0]
    out = _one_page_per_line(starts, words=("la", "la"), step=0.2)

    _assert_recipe_invariants(out)


def test_crowding_never_moves_a_lead_in():
    """A lead-in starts with its page's own fade-in, which is final by the
    time the lead-in is recorded; crowding later moves only fade-outs."""
    starts = [0.0, 1.2, 2.4, 6.0, 7.2, 8.4]
    out = _one_page_per_line(starts)

    by_line = {p["line_idx"][0]: p["fade_in_start"] for p in out["pages"]}
    assert out["lead_ins"]
    for lead in out["lead_ins"]:
        assert lead["start"] == by_line[lead["line_idx"]]


def test_page_recipe_records_the_crowding_constants():
    out = _one_page_per_line([0.0, 1.2, 2.4])
    recipe = out["metadata"]["page_recipe"]

    assert recipe["pre_roll"] == PRE_ROLL
    assert recipe["hold"] == HOLD
    assert recipe["fade"] == FADE_DUR
    assert recipe["crowded_fade"] == CROWDED_FADE
    assert recipe["min_hold"] == MIN_HOLD
    assert recipe["min_lead"] == MIN_LEAD
    assert recipe["max_page_lines"] == MAX_PAGE_LINES
    assert recipe["max_page_words"] == MAX_PAGE_WORDS
    assert recipe["max_page_secs"] == MAX_PAGE_SECS
