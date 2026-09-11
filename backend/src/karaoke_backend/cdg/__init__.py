# SPDX-License-Identifier: AGPL-3.0-only
"""CD+G encoding and decoding.

CD+G is a published CD specification from the 1980s: 24-byte subcode packets at
300/s painting a 300x216, 16-colour screen in 6x12 tiles. This package is an
independent implementation of that format -- an encoder that turns timed lyrics
into a .cdg stream, and a decoder that reads one back.

Layering, innermost first:

* `spec`     -- the format's constants. No dependencies.
* `packets`  -- subcode packet builders. Pure stdlib.
* `display`  -- the stateful screen: glyph masks in, packets out.
* `timeline` -- scheduling pages and wipes onto the constant-rate grid.
* `lyrics`   -- word-sync documents into pages.
* `card`     -- the baked attribution card and where a card fits in the intro.
* `card_source` -- beside `card`: any card as a validated value (`Card`),
  including the baked one, ready for `timeline` to schedule and paint.
* `decoder`  -- packets back into a framebuffer.

Nothing here rasterises text. Callers supply glyph masks, which keeps the
format logic free of any font or imaging dependency and testable against
synthetic shapes.
"""

from __future__ import annotations

from .card import card_cost, card_palette, card_pixels, check_fingerprint, plan_card
from .card_source import Card, attribution_card
from .decoder import Decoder, decode_at, iter_packets
from .display import Display, LineLayout, WordRect, bitmap_cost, show_cost
from .lyrics import build_pages, normalize_doc
from .spec import (
    LINE_H,
    PACKET_BYTES,
    PACKETS_PER_SEC,
    REGION_W,
    SCREEN_H,
    SCREEN_W,
    TILE_H,
    TILE_W,
)
from .timeline import Event, Page, build_stream, build_timeline, serialize

__all__ = [
    "Card",
    "Decoder",
    "Display",
    "Event",
    "LineLayout",
    "Page",
    "WordRect",
    "attribution_card",
    "bitmap_cost",
    "build_pages",
    "build_stream",
    "build_timeline",
    "card_cost",
    "card_palette",
    "card_pixels",
    "check_fingerprint",
    "decode_at",
    "plan_card",
    "iter_packets",
    "normalize_doc",
    "serialize",
    "show_cost",
    "LINE_H",
    "PACKETS_PER_SEC",
    "PACKET_BYTES",
    "REGION_W",
    "SCREEN_H",
    "SCREEN_W",
    "TILE_H",
    "TILE_W",
]
