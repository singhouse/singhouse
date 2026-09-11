# SPDX-License-Identifier: AGPL-3.0-only
"""`Card`: the validated value the timeline schedules and paints.

Three promises under test. Construction refuses anything `show_bitmap` could
not paint faithfully, and what it accepts is frozen -- read-only pixels, an
immutable palette, a cached cost that cannot go stale. `attribution_card()`
is the baked card exactly: `card=True` and `card=attribution_card()` must
produce byte-identical streams, which is the regression pin for the whole
refactor. And a replacement card obeys the same scheduling rules as the baked
one -- same palette folding, same skip-when-it-does-not-fit hold policy.
"""

from __future__ import annotations

import numpy as np
import pytest

from karaoke_backend.cdg import (
    Card,
    attribution_card,
    bitmap_cost,
    build_stream,
    build_timeline,
    card_cost,
    card_pixels,
    decode_at,
)
from karaoke_backend.cdg import card_asset, card_source
from karaoke_backend.cdg.card import plan_hold
from karaoke_backend.cdg.spec import (
    BG,
    BORDER,
    DEFAULT_PALETTE,
    HILITE,
    PACKETS_PER_SEC,
    SCREEN_H,
    SCREEN_W,
    TEXT,
    TILE_H,
    TILE_W,
)

from .test_cdg_card import INTERIOR, page_at


def small_card(ink: int = 7) -> Card:
    """A cheap synthetic card: one block of a single ink, inside the border."""
    pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
    pixels[TILE_H : TILE_H + 6, TILE_W : TILE_W + 30] = ink
    return Card(pixels=pixels, palette={ink: (15, 0, 15)})


class TestValidation:
    @pytest.mark.parametrize(
        "bad",
        [
            np.zeros((SCREEN_H, SCREEN_W - 1), dtype=np.uint8),
            np.zeros((SCREEN_H, SCREEN_W, 3), dtype=np.uint8),
            np.zeros(SCREEN_W, dtype=np.uint8),
        ],
    )
    def test_a_wrong_shape_is_refused(self, bad):
        with pytest.raises(ValueError, match="shape"):
            Card(pixels=bad, palette={})

    def test_a_float_grid_is_refused(self):
        # `show_bitmap` builds masks against int-truncated inks, so a float
        # grid would paint nothing while still costing its packets.
        with pytest.raises(ValueError, match="dtype"):
            Card(pixels=np.zeros((SCREEN_H, SCREEN_W)), palette={})

    @pytest.mark.parametrize("index", [16, 255])
    def test_an_index_outside_the_palette_is_refused(self, index):
        bad = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        bad[TILE_H, TILE_W] = index
        with pytest.raises(ValueError, match="outside the 16-entry palette"):
            Card(pixels=bad, palette={})

    def test_a_negative_index_is_refused(self):
        bad = np.zeros((SCREEN_H, SCREEN_W), dtype=np.int8)
        bad[TILE_H, TILE_W] = -1
        with pytest.raises(ValueError, match="outside the 16-entry palette"):
            Card(pixels=bad, palette={})

    @pytest.mark.parametrize("key", [16, -1, "4"])
    def test_a_bad_palette_index_is_refused(self, key):
        pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        with pytest.raises(ValueError, match="palette index"):
            Card(pixels=pixels, palette={key: (1, 2, 3)})

    @pytest.mark.parametrize("key", [0, 1, 2, 3])
    def test_a_lyric_palette_index_is_refused(self, key):
        # The CLUT is loaded once per stream; a card entry at a lyric index
        # would recolour every lyric that follows the card.
        pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        with pytest.raises(ValueError, match="lyric renderer"):
            Card(pixels=pixels, palette={key: (1, 2, 3)})

    def test_an_ink_without_a_palette_entry_is_refused(self):
        # Ink 9 with no entry would paint in whatever the base CLUT happens
        # to hold at 9 -- a silent mis-paint, so construction refuses it.
        pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        pixels[TILE_H, TILE_W] = 9
        with pytest.raises(ValueError, match="no palette entry"):
            Card(pixels=pixels, palette={})

    def test_drawing_in_the_lyric_colours_needs_no_entry(self):
        # The baked card writes its URL in TEXT ink; those colours are always
        # loaded, so pixels may use 0..3 without a palette entry.
        pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        pixels[TILE_H, TILE_W] = 2
        Card(pixels=pixels, palette={})

    @pytest.mark.parametrize(
        "color", [(1, 2), (1, 2, 3, 4), (1, 2, 16), (1, 2, -1), [1, 2, 3], (1, 2.0, 3)]
    )
    def test_a_bad_palette_entry_is_refused(self, color):
        pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        with pytest.raises(ValueError, match="palette entry"):
            Card(pixels=pixels, palette={7: color})

    def test_pixels_are_read_only_after_construction(self):
        card = small_card()
        with pytest.raises(ValueError):
            card.pixels[0, 0] = 9

    def test_pixels_are_copied_not_aliased(self):
        # A caller mutating its own array after construction must not reach
        # into the card -- the cached cost would silently disagree with what
        # gets painted.
        source = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        card = Card(pixels=source, palette={})
        source[TILE_H, TILE_W] = 7
        assert card.pixels[TILE_H, TILE_W] == 0

    def test_a_wide_dtype_is_narrowed_after_validation(self):
        pixels = np.full((SCREEN_H, SCREEN_W), 7, dtype=np.int64)
        card = Card(pixels=pixels, palette={7: (1, 2, 3)})
        assert card.pixels.dtype == np.uint8

    def test_the_palette_is_immutable(self):
        card = small_card()
        with pytest.raises(TypeError):
            card.palette[8] = (1, 2, 3)

    def test_cost_is_what_painting_costs(self):
        card = small_card()
        assert card.cost() == bitmap_cost(card.pixels)

    def test_cost_is_computed_once(self, monkeypatch):
        calls = 0
        real = card_source.bitmap_cost

        def counting(pixels):
            nonlocal calls
            calls += 1
            return real(pixels)

        monkeypatch.setattr(card_source, "bitmap_cost", counting)
        card = small_card()
        assert card.cost() == card.cost()
        assert calls == 1


class TestAttributionCard:
    def test_is_the_baked_asset_exactly(self):
        card = attribution_card()
        assert np.array_equal(card.pixels, card_pixels())
        assert dict(card.palette) == card_asset.PALETTE
        assert card.cost() == card_cost()

    @pytest.mark.parametrize("pages", [[], [page_at(8.0)], [page_at(30.0)]])
    def test_card_true_and_the_card_object_encode_byte_identically(self, pages):
        # The regression pin for the injectable-card seam: `True` resolves to
        # `attribution_card()`, so the two spellings must not differ by a bit.
        assert build_stream(pages, 40.0, card=True) == build_stream(
            pages, 40.0, card=attribution_card()
        )

    def test_byte_identical_under_a_custom_palette_too(self):
        palette = dict(DEFAULT_PALETTE) | {2: (15, 0, 15)}
        assert build_stream([page_at(30.0)], 40.0, palette, card=True) == (
            build_stream([page_at(30.0)], 40.0, palette, card=attribution_card())
        )

    def test_the_default_palette_survives_the_card_fold(self):
        # The card's entries overlay the base palette; they must not replace
        # it. With no caller palette, the defaults' lyric entries still have
        # to reach the CLUT alongside the card's inks.
        stream = build_stream([page_at(30.0)], 40.0, card=True)
        clut = decode_at(stream, 2.0).clut
        for idx in (BG, TEXT, HILITE):
            assert clut[idx] == DEFAULT_PALETTE[idx]


class TestCustomCard:
    def test_a_custom_card_paints_its_own_ink_not_the_baked_cards(self):
        card = small_card(ink=7)
        stream = build_stream([page_at(30.0)], 40.0, card=card)
        when = card.cost() / PACKETS_PER_SEC + 0.5
        screen = decode_at(stream, when)
        inks = set(screen.framebuffer[INTERIOR].flatten().tolist())
        assert 7 in inks
        assert inks.isdisjoint(card_asset.PALETTE)
        # The card's palette entry made it into the CLUT load.
        assert screen.clut[7] == (15, 0, 15)

    def test_a_custom_cards_ink_wins_a_palette_collision(self):
        # The card cannot render in colours it was not drawn for, so at a
        # colliding index the card's entry replaces the caller's.
        card = small_card(ink=7)
        palette = dict(DEFAULT_PALETTE) | {7: (0, 15, 0)}
        stream = build_stream([page_at(30.0)], 40.0, palette, card=card)
        screen = decode_at(stream, card.cost() / PACKETS_PER_SEC + 0.5)
        assert screen.clut[7] == (15, 0, 15)

    def test_a_custom_card_blanks_on_its_own_schedule(self):
        # The closing blank is timed from the card's OWN cost, not the baked
        # card's: a cheap replacement must leave when its hold expires, not
        # linger for the seconds the baked card's paint would have taken.
        card = small_card(ink=7)
        _, show_times = build_timeline([page_at(30.0)], card=False)
        hold = plan_hold(card.cost(), show_times[0])
        off = card.cost() / PACKETS_PER_SEC + hold

        stream = build_stream([page_at(30.0)], 40.0, card=card)
        before = decode_at(stream, off - 0.2)
        assert 7 in set(before.framebuffer[INTERIOR].flatten().tolist())
        after = decode_at(stream, off + 0.2)
        assert set(np.unique(after.framebuffer)) <= {BG, BORDER}

    def test_a_custom_card_is_gone_by_the_time_lyrics_are_up(self):
        stream = build_stream([page_at(30.0)], 40.0, card=small_card(ink=7))
        assert 7 not in set(decode_at(stream, 30.5).framebuffer.flatten().tolist())

    def test_an_expensive_card_is_skipped_on_a_short_intro(self):
        # Every interior tile carries twelve inks, so the paint burst alone
        # runs far past the window; the same window fits the baked card.
        rows = np.arange(SCREEN_H, dtype=np.uint8) % 12 + 4
        pixels = np.repeat(rows[:, None], SCREEN_W, axis=1)
        pixels[: TILE_H, :] = BG
        pixels[-TILE_H:, :] = BG
        pixels[:, : TILE_W] = BG
        pixels[:, -TILE_W:] = BG
        expensive = Card(
            pixels=pixels, palette={i: (i, 0, 15 - i) for i in range(4, 16)}
        )

        page = page_at(8.0)
        _, show_times = build_timeline([page], card=False)
        assert plan_hold(expensive.cost(), show_times[0]) is None
        assert plan_hold(attribution_card().cost(), show_times[0]) is not None

        events, _ = build_timeline([page], card=expensive)
        assert not [e for e in events if e.kind == "card"]
        with_baked, _ = build_timeline([page], card=True)
        assert [e for e in with_baked if e.kind == "card"]

        screen = decode_at(build_stream([page], 20.0, card=expensive), 1.0)
        assert set(np.unique(screen.framebuffer)) <= {BG, BORDER}


class TestNoCardPassthrough:
    def test_card_false_leaves_the_callers_palette_untouched(self):
        # Including at an index a card would claim: the invariant documented
        # on `build_stream`.
        palette = dict(DEFAULT_PALETTE) | {4: (1, 2, 3)}
        stream = build_stream([page_at(30.0)], 40.0, palette, card=False)
        assert decode_at(stream, 2.0).clut[4] == (1, 2, 3)

    def test_card_true_overlays_the_same_index(self):
        palette = dict(DEFAULT_PALETTE) | {4: (1, 2, 3)}
        stream = build_stream([page_at(30.0)], 40.0, palette, card=True)
        assert decode_at(stream, 2.0).clut[4] == card_asset.PALETTE[4]
