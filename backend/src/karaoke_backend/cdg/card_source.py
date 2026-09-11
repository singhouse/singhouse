# SPDX-License-Identifier: AGPL-3.0-only
"""The card an export opens with, as a validated value.

`timeline` schedules and paints whatever `Card` it is handed; this module is
where a card becomes safe to hand over. Validation happens at construction --
the same seam discipline as `check_layouts` and `_bitmap_tiles` -- because a
card arrives from outside the encoder (the baked asset today, an installed
extension's art tomorrow) and a bad one caught here names its mistake instead
of surfacing as a mis-timed stream or a silent mis-paint downstream.

A `Card` is immutable in both senses: the dataclass is frozen, and the pixel
array is a read-only copy taken at construction, so the cached paint cost can
never disagree with what actually gets painted. The palette carries only the
card's OWN ink entries -- what it adds over a lyric palette, not a whole CLUT
-- so `build_stream` can fold it over whichever palette the caller chose.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from types import MappingProxyType
from typing import Mapping

import numpy as np

from . import card_asset
from .card import card_pixels
from .display import bitmap_cost
from .spec import SCREEN_H, SCREEN_W


# eq=False: the generated equality would compare the ndarray field and raise
# on the ambiguous truth value; identity is the only comparison a Card needs.
@dataclass(frozen=True, eq=False)
class Card:
    """A full-screen card: palette-indexed pixels plus the inks they use.

    `pixels` is a (SCREEN_H, SCREEN_W) array of palette indices 0..15;
    `palette` maps each ink index the card draws in to a 4-bit-per-channel
    RGB triple. Construction validates both and refuses anything else, so a
    `Card` that exists can always be encoded.

    Palette indices 0..3 belong to the lyric renderer, and the CLUT is loaded
    once per stream -- an entry written there would recolour every lyric that
    follows the card, so those keys are refused outright. Pixels may still
    *draw* in 0..3 (those colours are always loaded); any other ink they use
    must come with its own palette entry, or it would paint in whatever the
    base CLUT happens to hold.
    """

    pixels: np.ndarray
    palette: Mapping[int, tuple[int, int, int]]

    def __post_init__(self):
        grid = np.asarray(self.pixels)
        if grid.ndim != 2 or grid.shape != (SCREEN_H, SCREEN_W):
            raise ValueError(
                f"card pixels shape {getattr(grid, 'shape', type(self.pixels))!r}, "
                f"expected {(SCREEN_H, SCREEN_W)}"
            )
        if grid.dtype.kind not in "ui":
            raise ValueError(
                f"card pixels dtype {grid.dtype}, expected an integer type"
            )
        if grid.size and (int(grid.min()) < 0 or int(grid.max()) > 15):
            raise ValueError(
                f"card pixels hold indices {int(grid.min())}..{int(grid.max())}, "
                "outside the 16-entry palette"
            )
        entries: dict[int, tuple[int, int, int]] = {}
        for index, color in dict(self.palette).items():
            if not isinstance(index, int) or not 4 <= index <= 15:
                raise ValueError(
                    f"card palette index {index!r} is not an int in 4..15 "
                    "(0..3 are the lyric renderer's)"
                )
            if not (
                isinstance(color, tuple)
                and len(color) == 3
                and all(isinstance(c, int) and 0 <= c <= 15 for c in color)
            ):
                raise ValueError(
                    f"card palette entry {index} is {color!r}, expected a "
                    "3-tuple of ints 0..15 (4 bits per channel)"
                )
            entries[index] = color
        if grid.size:
            undefined = set(np.unique(grid).tolist()) - {0, 1, 2, 3} - set(entries)
            if undefined:
                raise ValueError(
                    f"card pixels draw in ink(s) {sorted(undefined)} with no "
                    "palette entry"
                )
        # A read-only copy, so no caller holds a writable alias: the cost
        # cached below and the pixels painted later cannot diverge. Frozen
        # dataclasses assign via object.__setattr__ or not at all.
        pixels = grid.astype(np.uint8, copy=True)
        pixels.flags.writeable = False
        object.__setattr__(self, "pixels", pixels)
        object.__setattr__(self, "palette", MappingProxyType(entries))

    def cost(self) -> int:
        """Packets this card costs to paint, computed once per instance."""
        cached = self.__dict__.get("_cost")
        if cached is None:
            cached = bitmap_cost(self.pixels)
            object.__setattr__(self, "_cost", cached)
        return cached


@lru_cache(maxsize=1)
def attribution_card() -> Card:
    """The baked attribution card as a `Card`.

    The palette is only the card's own ink entries -- exactly what
    `card_palette` merges over a base -- so folding it over any lyric palette
    reproduces that merge.
    """
    return Card(pixels=card_pixels(), palette=card_asset.PALETTE)
