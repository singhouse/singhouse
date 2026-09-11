# SPDX-License-Identifier: AGPL-3.0-only
"""Export rasteriser coverage.

Pins the ``render_line`` contract the CD+G encoder depends on: a
``(LINE_H, REGION_W)`` uint8 mask holding only 0/1, per-word rects that are
ordered, non-inverted, and inside ``[0, REGION_W]``, the shrink-then-truncate
behaviour for overlong lines, and glyph coverage beyond Latin. Everything here
needs Pillow, so the whole module skips without it; the no-Pillow surface
(``font_path``, availability, the 501 route) is covered in the service and API
suites.
"""

from __future__ import annotations

import pytest

pytest.importorskip("PIL")

import numpy as np  # noqa: E402

from karaoke_backend.cdg.spec import LINE_H, REGION_W  # noqa: E402
from karaoke_backend.export import raster  # noqa: E402


def _words(*texts: str) -> list[dict]:
    return [
        {"text": text, "start": float(i), "end": float(i) + 0.5}
        for i, text in enumerate(texts)
    ]


def test_mask_shape_dtype_and_values():
    layout = raster.render_line(_words("Hello", "world"))
    assert layout.mask.shape == (LINE_H, REGION_W)
    assert layout.mask.dtype == np.uint8
    assert set(np.unique(layout.mask).tolist()) <= {0, 1}


def test_real_text_leaves_ink():
    layout = raster.render_line(_words("Hello", "world"))
    assert int(layout.mask.sum()) > 0


def test_rects_carry_the_original_word_dicts():
    words = _words("one", "two", "three")
    layout = raster.render_line(words)
    assert [rect.word for rect in layout.rects] == words


def test_rects_are_monotonic_and_in_bounds():
    layout = raster.render_line(_words("some", "words", "across", "the", "line"))
    assert len(layout.rects) == 5
    previous_end = 0
    for rect in layout.rects:
        assert 0 <= rect.x0 <= rect.x1 <= REGION_W
        assert rect.x0 >= previous_end
        previous_end = rect.x1


def test_short_line_is_horizontally_centred():
    layout = raster.render_line(_words("Hi"))
    columns = np.flatnonzero(layout.mask.any(axis=0))
    left, right = columns[0], columns[-1]
    # Left and right margins agree to within layout rounding plus the glyphs'
    # side bearings (ink sits slightly inside the advance width).
    assert abs(left - (REGION_W - 1 - right)) <= 4


def test_long_line_shrinks_the_font_to_fit():
    short = raster.render_line(_words("Hi"))
    long = raster.render_line(_words(*(["word"] * 8)))
    # Ink height is a proxy for font size: the crowded line renders smaller.
    def ink_height(layout):
        rows = np.flatnonzero(layout.mask.any(axis=1))
        return rows[-1] - rows[0] + 1

    assert ink_height(long) < ink_height(short)
    assert all(0 <= r.x0 <= r.x1 <= REGION_W for r in long.rects)


def test_overlong_line_truncates_without_raising():
    # Far past what 13px can fit: truncation, not an exception, and every
    # rect — including fully clipped words — stays inside the region.
    layout = raster.render_line(_words(*(["supercalifragilistic"] * 12)))
    assert layout.mask.shape == (LINE_H, REGION_W)
    assert int(layout.mask.sum()) > 0
    for rect in layout.rects:
        assert 0 <= rect.x0 <= rect.x1 <= REGION_W
    # The tail of the line really is clipped: the last word has no width left.
    assert layout.rects[-1].x1 == REGION_W


def test_non_latin_text_renders_ink():
    # The vendored face was chosen for coverage beyond Latin.
    cyrillic = raster.render_line(_words("Привет", "мир"))
    assert int(cyrillic.mask.sum()) > 0
    greek = raster.render_line(_words("καλημέρα"))
    assert int(greek.mask.sum()) > 0


def test_raster_available_is_true_with_pillow_installed():
    assert raster.raster_available() is True
