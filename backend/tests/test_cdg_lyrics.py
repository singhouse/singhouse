# SPDX-License-Identifier: AGPL-3.0-only
"""Normalising word-sync documents into CD+G pages.

Fixtures are synthetic -- placeholder words on invented timings. No real lyrics
appear here.
"""

from __future__ import annotations

import numpy as np
import pytest

from karaoke_backend.cdg import LineLayout, build_pages, normalize_doc
from karaoke_backend.cdg.lyrics import _clean_words
from karaoke_backend.cdg.spec import LINE_H, MAX_PAGE_LINES, REGION_W


def words(*specs):
    return [{"word": t, "start": s, "end": e} for t, s, e in specs]


def line_at(index, start, step=1.0, count=2):
    return words(*[(f"w{index}{i}", start + i * step, start + i * step + 0.5)
                   for i in range(count)])


def stub_render(word_list) -> LineLayout:
    """A rasteriser stand-in: one solid block per word, laid end to end."""
    mask = np.zeros((LINE_H, REGION_W), dtype=np.uint8)
    rects = []
    x = 0
    for w in word_list:
        mask[6:30, x : x + 24] = 1
        from karaoke_backend.cdg import WordRect

        rects.append(WordRect(w, x, x + 24))
        x += 30
    return LineLayout(line_idx=-1, mask=mask, rects=rects)


class TestCleanWords:
    def test_accepts_both_word_and_text_keys(self):
        got = _clean_words([{"word": "a", "start": 0, "end": 1},
                            {"text": "b", "start": 1, "end": 2}])
        assert [w["text"] for w in got] == ["a", "b"]

    def test_drops_empty_and_whitespace_only_text(self):
        got = _clean_words([{"word": "  ", "start": 0, "end": 1},
                            {"word": "", "start": 0, "end": 1},
                            {"word": "ok", "start": 0, "end": 1}])
        assert [w["text"] for w in got] == ["ok"]

    def test_drops_words_with_unusable_timings(self):
        got = _clean_words([
            {"word": "a", "start": None, "end": 1},
            {"word": "b", "end": 1},
            {"word": "c", "start": "x", "end": 1},
            {"word": "d", "start": 0, "end": 1},
        ])
        assert [w["text"] for w in got] == ["d"]

    def test_inverted_span_is_clamped_rather_than_dropped(self):
        got = _clean_words([{"word": "a", "start": 5.0, "end": 2.0}])
        assert got[0]["start"] == 5.0 and got[0]["end"] == 5.0

    def test_ignores_non_dict_entries(self):
        assert _clean_words(["nope", None, {"word": "a", "start": 0, "end": 1}]) != []

    def test_an_explicit_null_word_falls_through_to_the_text_key(self):
        # `dict.get` falls back only on a missing key, so {"word": null} would
        # otherwise stringify to the literal "None" and get rendered.
        got = _clean_words([
            {"word": None, "text": "b", "start": 0, "end": 1},
            {"word": None, "text": None, "start": 0, "end": 1},
        ])
        assert [w["text"] for w in got] == ["b"]

    @pytest.mark.parametrize("bad", [float("inf"), float("-inf"), float("nan")])
    def test_drops_non_finite_timings(self, bad):
        # These survive float() and then detonate in the scheduler instead.
        assert _clean_words([{"word": "a", "start": bad, "end": 1}]) == []
        assert _clean_words([{"word": "a", "start": 0, "end": bad}]) == []

    def test_ignores_a_non_list_word_container(self):
        assert _clean_words({"word": "a"}) == []
        assert _clean_words(None) == []


class TestNormalizeDoc:
    def test_falls_back_to_segments_when_lines_are_absent(self):
        doc = {"segments": [{"words": words(("a", 0, 1))},
                            {"words": words(("b", 2, 3))}]}
        lines, page_defs = normalize_doc(doc)
        assert len(lines) == 2
        assert page_defs[0]["line_idxs"] == [0, 1]

    def test_unusable_lines_keep_their_index_as_none(self):
        doc = {"lines": [words(("a", 0, 1)), [], words(("c", 2, 3))]}
        lines, _ = normalize_doc(doc)
        assert lines[1] is None
        assert len(lines) == 3

    def test_groups_at_the_page_line_limit(self):
        doc = {"lines": [line_at(i, i * 2.0) for i in range(MAX_PAGE_LINES + 2)]}
        _, page_defs = normalize_doc(doc)
        assert len(page_defs[0]["line_idxs"]) == MAX_PAGE_LINES
        assert page_defs[1]["line_idxs"] == [MAX_PAGE_LINES, MAX_PAGE_LINES + 1]

    def test_long_silence_starts_a_new_page(self):
        doc = {"lines": [
            words(("a", 0.0, 1.0)),
            words(("b", 1.2, 2.0)),
            words(("c", 30.0, 31.0)),  # a long instrumental gap
        ]}
        _, page_defs = normalize_doc(doc)
        assert page_defs[0]["line_idxs"] == [0, 1]
        assert page_defs[1]["line_idxs"] == [2]

    def test_explicit_pages_are_honoured_with_their_fades(self):
        doc = {
            "lines": [words(("a", 5.0, 6.0)), words(("b", 6.0, 7.0))],
            "pages": [{"line_idx": [0, 1], "fade_in_start": 3.0, "fade_out_start": 9.0}],
        }
        _, page_defs = normalize_doc(doc)
        assert len(page_defs) == 1
        assert page_defs[0] == {"line_idxs": [0, 1], "fade_in": 3.0, "fade_out": 9.0}

    def test_oversized_authored_page_is_chunked_keeping_outer_fades(self):
        count = MAX_PAGE_LINES + 2
        doc = {
            "lines": [words((f"w{i}", i, i + 0.5)) for i in range(count)],
            "pages": [{
                "line_idx": list(range(count)),
                "fade_in_start": 0.5,
                "fade_out_start": 40.0,
            }],
        }
        _, page_defs = normalize_doc(doc)
        assert len(page_defs) == 2
        assert page_defs[0]["fade_in"] == 0.5 and page_defs[0]["fade_out"] is None
        assert page_defs[1]["fade_in"] is None and page_defs[1]["fade_out"] == 40.0

    def test_lines_not_claimed_by_an_explicit_page_still_get_grouped(self):
        doc = {
            "lines": [words(("a", 0, 1)), words(("b", 1, 2)), words(("c", 2, 3))],
            "pages": [{"line_idx": [0]}],
        }
        _, page_defs = normalize_doc(doc)
        claimed = [p["line_idxs"] for p in page_defs]
        assert [0] in claimed
        assert [1, 2] in claimed

    def test_malformed_page_entries_are_ignored(self):
        doc = {
            "lines": [words(("a", 0, 1))],
            "pages": ["nope", {"line_idx": "not-a-list"}, {"line_idx": [99]}],
        }
        _, page_defs = normalize_doc(doc)
        # None of the malformed pages claimed anything, so line 0 falls through
        # to the grouping heuristic.
        assert page_defs == [{"line_idxs": [0], "fade_in": None, "fade_out": None}]

    def test_empty_document_yields_no_pages(self):
        assert normalize_doc({}) == ([], [])

    def test_a_line_claimed_twice_is_only_rendered_once(self):
        # A repeated index paints the line twice and wipes whichever copy the
        # lookup finds first, leaving the other stuck unhighlighted.
        doc = {
            "lines": [words(("a", 0, 1)), words(("b", 1, 2))],
            "pages": [{"line_idx": [0, 1, 0]}, {"line_idx": [1]}],
        }
        _, page_defs = normalize_doc(doc)
        claimed = [i for p in page_defs for i in p["line_idxs"]]
        assert claimed == sorted(set(claimed))
        assert page_defs[0]["line_idxs"] == [0, 1]

    @pytest.mark.parametrize("bad", [float("inf"), float("nan")])
    def test_non_finite_fades_are_treated_as_absent(self, bad):
        doc = {
            "lines": [words(("a", 5.0, 6.0))],
            "pages": [{"line_idx": [0], "fade_in_start": bad, "fade_out_start": bad}],
        }
        _, page_defs = normalize_doc(doc)
        assert page_defs[0]["fade_in"] is None
        assert page_defs[0]["fade_out"] is None

    def test_a_boolean_is_not_accepted_as_a_line_index(self):
        # bool is an int subclass, so True would otherwise select line 1.
        doc = {"lines": [words(("a", 0, 1)), words(("b", 1, 2))],
               "pages": [{"line_idx": [True]}]}
        _, page_defs = normalize_doc(doc)
        assert all(True is not i for p in page_defs for i in p["line_idxs"])

    @pytest.mark.parametrize(
        "doc",
        [
            "not a document",
            None,
            {"lines": "not a list"},
            {"lines": [None, 5, "text"]},
            {"segments": "not a list"},
            {"segments": [None, {"no_words": 1}, 7]},
            {"pages": "not a list"},
        ],
    )
    def test_a_malformed_document_yields_pages_rather_than_raising(self, doc):
        lines, page_defs = normalize_doc(doc)
        assert isinstance(lines, list) and isinstance(page_defs, list)


class TestBuildPages:
    def test_stamps_the_document_line_index_onto_each_layout(self):
        doc = {"lines": [words(("a", 0, 1)), words(("b", 1, 2))]}
        lines, page_defs = normalize_doc(doc)
        pages = build_pages(lines, page_defs, stub_render)
        assert [layout.line_idx for layout in pages[0].layouts] == [0, 1]

    def test_page_span_covers_its_words(self):
        doc = {"lines": [words(("a", 2.0, 3.0), ("b", 3.0, 4.5))]}
        lines, page_defs = normalize_doc(doc)
        page = build_pages(lines, page_defs, stub_render)[0]
        assert page.first == 2.0 and page.last == 4.5

    def test_pages_come_back_in_time_order(self):
        doc = {
            "lines": [words(("late", 20.0, 21.0)), words(("early", 1.0, 2.0))],
            "pages": [{"line_idx": [0]}, {"line_idx": [1]}],
        }
        lines, page_defs = normalize_doc(doc)
        pages = build_pages(lines, page_defs, stub_render)
        assert [p.first for p in pages] == [1.0, 20.0]

    def test_a_repeated_index_in_a_hand_built_page_def_renders_once(self):
        lines = [words(("a", 0, 1))]
        page_defs = [{"line_idxs": [0, 0], "fade_in": None, "fade_out": None}]
        page = build_pages(lines, page_defs, stub_render)[0]
        assert len(page.layouts) == 1

    def test_pages_with_no_renderable_lines_are_dropped(self):
        lines = [None]
        page_defs = [{"line_idxs": [0], "fade_in": None, "fade_out": None}]
        assert build_pages(lines, page_defs, stub_render) == []
