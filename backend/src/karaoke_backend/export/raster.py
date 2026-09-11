# SPDX-License-Identifier: AGPL-3.0-only
"""Text rasterisation for CD+G export: lyric words in, glyph masks out.

This is the ``render_line`` callback the ``cdg`` encoder is built around. Each
line of words is drawn with the vendored DejaVu Sans Bold at the largest size
(27px down to 13px) whose total width fits the 276-pixel text region, centred
horizontally and vertically in the 36-pixel line box, and returned as a 1-bit
mask plus per-word x-extents in region-local pixels.

A line that still overflows at the minimum size is truncated rather than
refused: every word is drawn at its computed position and the fixed-size
canvas clips whatever falls past the right edge, deterministically, with every
word rect clamped into ``[0, REGION_W]`` (a fully clipped word gets an empty
rect at the edge, which wipes as a no-op). A degenerate export beats a failed
one here — the words are still sung either way.

Pillow is optional (the ``export`` extra), so it is imported inside the
functions that draw; importing this module never requires it. Callers gate on
``raster_available()`` before rendering.
"""

from __future__ import annotations

import importlib.resources
from functools import lru_cache
from pathlib import Path

import numpy as np

from karaoke_backend.cdg import LINE_H, REGION_W
from karaoke_backend.cdg.display import LineLayout, WordRect

_FONT_FILENAME = "DejaVuSans-Bold.ttf"

# Font-size fit loop bounds, in pixels. 27px fills the 36px line box with
# comfortable margin; below 13px the glyphs stop being readable on a screen
# this coarse, so the loop stops shrinking and truncation takes over.
BASE_FONT_SIZE = 27
MIN_FONT_SIZE = 13


def font_path() -> Path:
    """Filesystem path of the vendored font.

    Resolved through ``importlib.resources`` rather than ``__file__`` math so
    it holds for both an editable install and an installed wheel. Both unpack
    the package onto the filesystem, so the traversable is always backed by a
    concrete file and the path stays valid after the context exits.
    """
    resource = importlib.resources.files(__package__) / "fonts" / _FONT_FILENAME
    with importlib.resources.as_file(resource) as concrete:
        return Path(concrete)


@lru_cache(maxsize=1)
def raster_available() -> bool:
    """Whether text can be rasterised: Pillow importable and the font loads.

    Cached — availability is a property of the installed environment, not of
    any request.
    """
    try:
        from PIL import ImageFont

        ImageFont.truetype(str(font_path()), BASE_FONT_SIZE)
    except Exception:
        return False
    return True


@lru_cache(maxsize=32)
def _font(size: int):
    """One FreeType face per size — the fit loop touches sizes repeatedly."""
    from PIL import ImageFont

    return ImageFont.truetype(str(font_path()), size)


def render_line(words: list[dict]) -> LineLayout:
    """Render one line of word dicts into a ``LineLayout``.

    The mask is a ``(LINE_H, REGION_W)`` uint8 array of 0/1; each rect carries
    the original word dict and its ``[x0, x1)`` extent in region-local pixels.
    ``line_idx`` is left at 0 — ``cdg.build_pages`` stamps the document index.
    """
    from PIL import Image, ImageDraw

    texts = [word["text"] for word in words]

    size = BASE_FONT_SIZE
    while True:
        font = _font(size)
        widths = [font.getlength(text) for text in texts]
        space = font.getlength(" ")
        total = sum(widths) + space * (len(texts) - 1)
        if total <= REGION_W or size <= MIN_FONT_SIZE:
            break
        size -= 1

    image = Image.new("1", (REGION_W, LINE_H), 0)
    draw = ImageDraw.Draw(image)
    # Vertical centring from a reference string with an ascender and a
    # descender, so every line of a page sits on a consistent baseline.
    bbox = font.getbbox("Ag")
    top = (LINE_H - (bbox[3] - bbox[1])) // 2 - bbox[1]

    # Centre when the line fits; an overflowing line starts at the left edge
    # and truncates against the canvas (see module docstring).
    cursor = max((REGION_W - total) / 2.0, 0.0)
    rects: list[WordRect] = []
    for word, text, width in zip(words, texts, widths):
        x = int(round(cursor))
        draw.text((x, top), text, font=font, fill=1)
        x0 = min(max(x, 0), REGION_W)
        x1 = min(max(int(round(cursor + width)), x0), REGION_W)
        rects.append(WordRect(word=word, x0=x0, x1=x1))
        cursor += width + space

    mask = (np.asarray(image) > 0).astype(np.uint8)
    return LineLayout(line_idx=0, mask=mask, rects=rects)
