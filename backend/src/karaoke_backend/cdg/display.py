# SPDX-License-Identifier: AGPL-3.0-only
"""The stateful CD+G screen: glyph masks in, subcode packets out.

This layer deliberately knows nothing about fonts or text. Callers hand it
1-bit pixel masks and word rectangles in region-local coordinates, which keeps
the format logic testable against synthetic shapes and keeps any glyph
rasteriser -- and its dependencies -- outside the encoder.

Highlighting uses the standard two-layer trick for getting a smooth wipe out of
two-colour tiles:

* base layer -- the line's glyphs as NORMAL tiles (colour0 = BG, colour1 = TEXT).
* wipe layer -- XOR tiles (colour0 = 0, colour1 = TEXT ^ HILITE) whose mask is
  the *sung* pixels. XORing a TEXT pixel with TEXT ^ HILITE yields HILITE, so
  swept columns recolour without disturbing their neighbours.

Each pixel is XORed at most once per line -- `_wipe_band` subtracts the
already-sung mask before emitting -- so a re-entered band cannot toggle a
highlight back off. A page change overpaints everything with a memory preset.
"""

from __future__ import annotations

from typing import NamedTuple

import numpy as np

from .packets import border_preset, load_clut, memory_preset, pack_tile_rows, tile_block
from .spec import (
    BG,
    BORDER,
    DEFAULT_PALETTE,
    LINE_H,
    LINE_TILE_H,
    MAX_SCREEN_LINES,
    REGION_COL0,
    REGION_COLS,
    REGION_W,
    SCREEN_H,
    SCREEN_W,
    TEXT,
    TEXT_ROW0,
    TEXT_ROWS,
    TILE_COLS,
    TILE_H,
    TILE_ROWS,
    TILE_W,
    XOR_INK,
)


class WordRect(NamedTuple):
    """One word's horizontal extent within a rendered line, in region pixels."""

    word: dict
    x0: int
    x1: int


class LineLayout(NamedTuple):
    """A rendered lyric line: its index in the doc, its glyph mask, its words.

    `mask` is a (LINE_TILE_H * TILE_H, REGION_W) array of 0/1.
    """

    line_idx: int
    mask: np.ndarray
    rects: list[WordRect]


#: The shape every `LineLayout.mask` must have.
LINE_MASK_SHAPE = (LINE_H, REGION_W)


def check_layouts(layouts: list[LineLayout]) -> None:
    """Validate a page of layouts at the rasteriser seam.

    A caller-supplied rasteriser is the one place a wrong shape can enter, and
    an unchecked one surfaces as an `IndexError` from inside the tile packer,
    several frames from the actual mistake.
    """
    if len(layouts) > MAX_SCREEN_LINES:
        raise ValueError(
            f"page has {len(layouts)} lines; the screen fits {MAX_SCREEN_LINES}"
        )
    for layout in layouts:
        shape = tuple(getattr(layout.mask, "shape", ()))
        if shape != LINE_MASK_SHAPE:
            raise ValueError(
                f"line {layout.line_idx}: mask shape {shape or type(layout.mask)!r}, "
                f"expected {LINE_MASK_SHAPE}"
            )


def show_cost(layouts: list[LineLayout]) -> int:
    """Packets a `show_page` of `layouts` will emit.

    Three for the clear-and-border, plus one per tile that carries any glyph
    pixel. The scheduler needs this ahead of time to know how early a page has
    to start painting -- see `PAGE_PAINT_MARGIN`.
    """
    tiles = 0
    for layout in layouts:
        blocks = np.asarray(layout.mask).reshape(
            LINE_TILE_H, TILE_H, REGION_COLS, TILE_W
        )
        tiles += int(blocks.any(axis=(1, 3)).sum())
    return 3 + tiles


def _bitmap_tiles(pixels: np.ndarray):
    """Yield (tile_row, tile_col, [(colour, mask), ...]) for every inked tile.

    A tile carries two colours, so a tile holding N inks costs N packets: one
    NORMAL write against the background, then one XOR overlay per further ink.
    Enumerating that here keeps `show_bitmap` and `bitmap_cost` reading the same
    tiles -- a cost that disagreed with the emission would mis-time the card.
    """
    grid = np.asarray(pixels)
    if grid.ndim != 2 or grid.shape != (SCREEN_H, SCREEN_W):
        raise ValueError(
            f"bitmap shape {getattr(grid, 'shape', type(pixels))!r}, "
            f"expected {(SCREEN_H, SCREEN_W)}"
        )
    # Same seam discipline as `check_layouts`: refuse at the caller boundary
    # rather than downstream. Both failures here are silent ones -- the packet
    # builders mask to four bits, so index 17 would paint as index 1, and a
    # float grid builds its masks against truncated ink values and so paints
    # nothing at all while still costing its packets.
    if grid.dtype.kind not in "ui":
        raise ValueError(f"bitmap dtype {grid.dtype}, expected an integer type")
    if grid.size and (int(grid.min()) < 0 or int(grid.max()) > 15):
        raise ValueError(
            f"bitmap holds indices {int(grid.min())}..{int(grid.max())}, "
            "outside the 16-entry palette"
        )
    for tile_row in range(TILE_ROWS):
        for tile_col in range(TILE_COLS):
            tile = grid[
                tile_row * TILE_H : (tile_row + 1) * TILE_H,
                tile_col * TILE_W : (tile_col + 1) * TILE_W,
            ]
            inks = [int(c) for c in np.unique(tile) if int(c) != BG]
            if inks:
                yield tile_row, tile_col, [(c, tile == c) for c in inks]


def bitmap_cost(pixels: np.ndarray) -> int:
    """Packets a `show_bitmap` of `pixels` will emit."""
    return 3 + sum(len(inks) for _, _, inks in _bitmap_tiles(pixels))


class _OnScreen:
    """A line currently painted on the display, with its wipe progress."""

    __slots__ = ("line_idx", "mask", "rects", "sung", "top_row")

    def __init__(self, layout: LineLayout, top_row: int):
        self.line_idx = layout.line_idx
        self.mask = layout.mask
        self.rects = layout.rects
        self.sung = np.zeros_like(layout.mask)
        self.top_row = top_row


class Display:
    """Holds the visible page and emits the packets that mutate the screen."""

    def __init__(self, palette: dict[int, tuple[int, int, int]] | None = None):
        self.palette = dict(DEFAULT_PALETTE if palette is None else palette)
        self.page: list[_OnScreen] = []

    def init_packets(self) -> list[bytes]:
        """Load both CLUT halves, clear the screen, and paint the border."""
        low = [self.palette.get(i, (0, 0, 0)) for i in range(8)]
        high = [self.palette.get(i, (0, 0, 0)) for i in range(8, 16)]
        return [
            load_clut(low, high=False),
            load_clut(high, high=True),
            memory_preset(BG, 0),
            memory_preset(BG, 1),
            border_preset(BORDER),
        ]

    def blank(self) -> list[bytes]:
        """Clear the screen. Three packets, versus a per-tile clear sweep."""
        self.page = []
        # The preset is sent twice with different repeat counters so a player
        # that drops one still ends up on a clean screen.
        return [memory_preset(BG, 0), memory_preset(BG, 1), border_preset(BORDER)]

    @staticmethod
    def _tile_of(mask: np.ndarray, local_col: int, local_row: int) -> np.ndarray:
        return mask[
            local_row * TILE_H : (local_row + 1) * TILE_H,
            local_col * TILE_W : (local_col + 1) * TILE_W,
        ]

    def show_page(self, layouts: list[LineLayout]) -> list[bytes]:
        """Swap to a new page of lines, top to bottom, vertically centred.

        The outgoing page is dropped with a whole-screen memory preset -- the
        way commercial CD+G discs page-turn -- so the swap costs three packets
        plus the new glyph tiles. Clearing the old page tile by tile would
        double the packet load and stretch the turn past tight inter-page gaps.
        """
        check_layouts(layouts)
        top = TEXT_ROW0 + (TEXT_ROWS - LINE_TILE_H * len(layouts)) // 2
        pkts = self.blank()
        for k, layout in enumerate(layouts):
            entry = _OnScreen(layout, top_row=top + k * LINE_TILE_H)
            self.page.append(entry)
            for local_row in range(LINE_TILE_H):
                tile_row = entry.top_row + local_row
                for local_col in range(REGION_COLS):
                    tile = self._tile_of(entry.mask, local_col, local_row)
                    if tile.any():
                        pkts.append(
                            tile_block(
                                tile_row,
                                REGION_COL0 + local_col,
                                BG,
                                TEXT,
                                pack_tile_rows(tile),
                            )
                        )
        return pkts

    def show_bitmap(self, pixels: np.ndarray) -> list[bytes]:
        """Paint a full-screen palette-indexed bitmap over whatever is showing.

        Tiles are two-colour, so a tile with several inks is built up: the first
        ink goes down as a NORMAL write against the background, and each further
        ink is XORed in over background pixels. That relies on the screen being
        `BG` underneath -- which the preset in `blank()` guarantees -- and on the
        inks being disjoint within a tile, which they are by construction: every
        pixel has exactly one palette index.

        No lyric state is created. The bitmap is scenery; `wipe_word` has
        nothing to find until a page is shown, which clears it again.
        """
        pkts = self.blank()
        for tile_row, tile_col, inks in _bitmap_tiles(pixels):
            for n, (color, mask) in enumerate(inks):
                pkts.append(
                    tile_block(
                        tile_row,
                        tile_col,
                        0 if n else BG,
                        # An XOR against a BG pixel has to yield `color`, and
                        # BG is not assumed to be zero.
                        BG ^ color if n else color,
                        pack_tile_rows(mask),
                        xor=bool(n),
                    )
                )
        return pkts

    def _wipe_band(self, entry: _OnScreen, xa: int, xb: int) -> list[bytes]:
        """Light the highlight for text pixels in region-local x range [xa, xb)."""
        xa = max(0, min(xa, REGION_W))
        xb = max(0, min(xb, REGION_W))
        if xb <= xa:
            return []

        # Only pixels that are glyph AND not yet sung, so no pixel is ever
        # XORed twice (which would flip the highlight back off).
        delta = np.zeros_like(entry.mask)
        delta[:, xa:xb] = entry.mask[:, xa:xb] & ~entry.sung[:, xa:xb]
        entry.sung[:, xa:xb] |= entry.mask[:, xa:xb]
        if not delta.any():
            return []

        pkts = []
        col0, col1 = xa // TILE_W, (xb - 1) // TILE_W
        for local_row in range(LINE_TILE_H):
            tile_row = entry.top_row + local_row
            for local_col in range(col0, col1 + 1):
                tile = self._tile_of(delta, local_col, local_row)
                if tile.any():
                    pkts.append(
                        tile_block(
                            tile_row,
                            REGION_COL0 + local_col,
                            0,
                            XOR_INK,
                            pack_tile_rows(tile),
                            xor=True,
                        )
                    )
        return pkts

    def wipe_word(self, line_idx: int, x0: int, x1: int) -> list[bytes]:
        """Advance the wipe across one word.

        A no-op if the line is not on screen yet; `backfill_sung` catches the
        words that were already due when the page finally showed.
        """
        entry = next((e for e in self.page if e.line_idx == line_idx), None)
        if entry is None:
            return []
        return self._wipe_band(entry, x0, x1)

    def backfill_sung(self, now: float) -> list[bytes]:
        """Mark words already past their end time as fully sung.

        Needed when a page's show is pushed late by the previous page still
        being sung, so the wipe does not appear to start from the beginning.
        """
        pkts: list[bytes] = []
        for entry in self.page:
            for rect in entry.rects:
                if rect.word["end"] <= now:
                    pkts += self._wipe_band(entry, rect.x0, rect.x1)
        return pkts
