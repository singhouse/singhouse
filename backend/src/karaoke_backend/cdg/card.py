# SPDX-License-Identifier: AGPL-3.0-only
"""The attribution card that opens an export.

An exported .cdg travels: it gets burned, copied, handed around, and played on
rigs that know nothing about where it came from. The card is how it says so --
the mark, the sentence naming the tool that made it, and the domain. That is a
factual statement about a tool, and it is deliberately the only claim the card
makes; careful copy is what keeps the exporter clear of implying
anything about the material it encodes.

The pixels are baked at authoring time by `backend/scripts/gen-card-asset.py`
and committed as `card_asset`, so nothing here rasterises: the runtime cost is
a zlib inflate and a numpy reshape. `card_asset` carries no brand string of its
own -- the copy lives in `karaoke_backend.branding`, and `check_fingerprint`
re-derives the asset's fingerprint from it so a rename cannot quietly leave a
stale card in the exporter.

Timing is the part worth reading. The card is painted at the top of the stream
and blanked before the first page shows, so it lives entirely inside the intro
a song already has. It never moves a lyric: the hold is whatever is left after
the paint burst, capped at `CARD_MAX_HOLD`, and if that comes out below
`CARD_MIN_HOLD` there is simply no card.
"""

from __future__ import annotations

import base64
import hashlib
import zlib
from functools import lru_cache

import numpy as np

from karaoke_backend import branding

from . import card_asset
from .display import bitmap_cost
from .spec import (
    CARD_MAX_HOLD,
    CARD_MIN_HOLD,
    DEFAULT_PALETTE,
    PACKETS_PER_SEC,
)

#: Slack reserved for the blank that ends the card, in seconds. Three packets
#: is 0.01s; the rest absorbs the rounding of every event onto the packet grid.
_BLANK_SLACK = 0.05


@lru_cache(maxsize=1)
def card_pixels() -> np.ndarray:
    """The card as a (HEIGHT, WIDTH) array of palette indices.

    Cached and returned read-only: it is a module-level constant in every sense
    but storage, and a caller mutating it would corrupt every later export in
    the process.
    """
    raw = zlib.decompress(base64.b64decode(card_asset.PIXELS_B64))
    expected = card_asset.WIDTH * card_asset.HEIGHT
    if len(raw) != expected:
        raise ValueError(
            f"card asset decodes to {len(raw)} bytes, expected {expected}"
        )
    pixels = np.frombuffer(raw, dtype=np.uint8).reshape(
        card_asset.HEIGHT, card_asset.WIDTH
    )
    pixels.flags.writeable = False
    return pixels


def card_palette(
    base: dict[int, tuple[int, int, int]] | None = None,
) -> dict[int, tuple[int, int, int]]:
    """Overlay the card's ink colours onto a lyric palette.

    The card uses indices the lyric renderer does not, so both fit in one CLUT
    load at the top of the stream and the card needs no palette change of its
    own. A base entry at a card index loses -- the card cannot render in colours
    it was not drawn for.
    """
    merged = dict(DEFAULT_PALETTE if base is None else base)
    merged.update(card_asset.PALETTE)
    return merged


@lru_cache(maxsize=1)
def card_cost() -> int:
    """Packets the card costs to paint."""
    return bitmap_cost(card_pixels())


def plan_hold(cost: int, available: float | None) -> float | None:
    """How long to hold a card costing `cost` packets to paint.

    `available` is the seconds between the start of the stream and the moment
    the first page must begin painting, or None when there is no page at all.
    Returns the hold in seconds, or None if the card should be skipped.

    The paint burst is subtracted first, and twice over for the blank that
    follows it, so the whole card -- draw, hold, clear -- fits inside the
    window. Anything left over stays the intro's.
    """
    paint = cost / PACKETS_PER_SEC
    # `blank()` is three packets; charged as a full paint's worth of slack
    # rather than counted exactly, so rounding onto the packet grid cannot
    # push the clear past the page that follows it.
    if available is None:
        return CARD_MAX_HOLD
    hold = min(CARD_MAX_HOLD, available - paint - _BLANK_SLACK)
    return hold if hold >= CARD_MIN_HOLD else None


def plan_card(available: float | None) -> float | None:
    """`plan_hold` for the baked attribution card."""
    return plan_hold(card_cost(), available)


def fingerprint() -> str:
    """Re-derive the asset's copy fingerprint from the live branding module.

    Mirrors `fingerprint_copy` in the generator. Kept in step by
    `check_fingerprint`, which the test suite calls -- a mismatch means the
    product was renamed, or the card's layout changed, without regenerating.
    """
    parts = [branding.ATTRIBUTION_CARD_TEXT, branding.PRODUCT_URL] + [
        f"{k}={card_asset.LAYOUT[k]!r}" for k in sorted(card_asset.LAYOUT)
    ]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def check_fingerprint() -> None:
    """Raise if the baked card no longer matches the branding it was cut from."""
    if fingerprint() != card_asset.FINGERPRINT:
        raise ValueError(
            "the baked attribution card is stale: the product copy or the card "
            "layout changed since it was generated. Re-run "
            "backend/scripts/gen-card-asset.py."
        )
