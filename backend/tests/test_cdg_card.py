# SPDX-License-Identifier: AGPL-3.0-only
"""The baked attribution card: its asset, its painting, and its timing.

Painting is checked by decoding the stream back, like the rest of the encoder
suite -- a card that encodes but decodes wrong is exactly the failure a
round-trip catches and an inspection of emitted packets does not.

The card's one hard promise is that it never delays a lyric, so the timing
tests assert that directly: the same songs are encoded with and without it and
the page-show packets have to land in the same place.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import pytest

from karaoke_backend import branding
from karaoke_backend.cdg import (
    Decoder,
    Display,
    Page,
    bitmap_cost,
    build_stream,
    build_timeline,
    card_cost,
    card_palette,
    card_pixels,
    check_fingerprint,
    decode_at,
    plan_card,
)
from karaoke_backend.cdg.display import show_cost
from karaoke_backend.cdg import card as card_mod
from karaoke_backend.cdg import card_asset
from karaoke_backend.cdg.spec import (
    BG,
    BORDER,
    CARD_MAX_HOLD,
    CARD_MIN_HOLD,
    DEFAULT_PALETTE,
    PACKETS_PER_SEC,
    SCREEN_H,
    SCREEN_W,
    TEXT,
    TILE_H,
    TILE_W,
)

from .test_cdg_encode import dense_page, make_line

#: The border ring `blank()` paints. The card's art sits inside it, so
#: comparisons against the asset exclude it.
INTERIOR = (slice(TILE_H, SCREEN_H - TILE_H), slice(TILE_W, SCREEN_W - TILE_W))


def page_at(first: float, last: float | None = None) -> Page:
    """One modest page whose first word starts at `first`."""
    last = first + 1.0 if last is None else last
    return Page(
        layouts=[make_line(0, [(0, 60, first, last)])],
        first=first,
        last=last,
        fade_in=None,
        fade_out=None,
    )


def assert_page_lands_on_time(page: Page, duration: float) -> None:
    """The card must leave the page's arrival bit-identical.

    The scheduled show time is not the interesting number -- `serialize`
    displaces a burst that collides with an earlier one, which is exactly how a
    card would eat into a lyric without moving a single event. So both streams
    are decoded at the moment the card-less one has finished painting the page:
    if the card cost the page anything at all, the two screens differ.

    Comparing screens rather than hunting for the first TEXT pixel matters
    because the card's own copy is drawn in TEXT too -- a naive scan finds the
    card and calls it a lyric.

    The probe lands on the burst's LAST scheduled packet, not a comfortable
    moment after it. Any slack here is a blind spot exactly as wide as the slack
    itself, and the collision this guards against costs three packets -- the
    size of the blank that ends the card. An earlier version of this helper
    probed 0.01s past the burst and could not see it.
    """
    _, show_times = build_timeline([page], card=False)
    last = int(show_times[0] * PACKETS_PER_SEC) + show_cost(page.layouts) - 1
    when = (last + 0.5) / PACKETS_PER_SEC
    with_card = decode_at(build_stream([page], duration), when).framebuffer
    without = decode_at(
        build_stream([page], duration, card=False), when
    ).framebuffer
    assert np.array_equal(with_card, without)


def multi_ink_overlays(pixels: np.ndarray) -> int:
    """XOR overlay packets a bitmap needs: inks beyond the first, per tile."""
    blocks = np.asarray(pixels).reshape(
        SCREEN_H // TILE_H, TILE_H, SCREEN_W // TILE_W, TILE_W
    )
    return sum(
        max(0, len({int(c) for c in np.unique(blocks[r, :, c, :])} - {BG}) - 1)
        for r in range(blocks.shape[0])
        for c in range(blocks.shape[2])
    )


class TestAsset:
    def test_the_baked_card_matches_the_branding_it_was_cut_from(self):
        # The whole point of the fingerprint: a rename that does not regenerate
        # the card ships an export advertising the old name.
        check_fingerprint()

    def test_the_fingerprint_moves_when_the_copy_does(self, monkeypatch):
        monkeypatch.setattr(branding, "PRODUCT_URL", "example.invalid")
        with pytest.raises(ValueError, match="stale"):
            check_fingerprint()

    def test_the_fingerprint_moves_when_the_layout_does(self, monkeypatch):
        layout = dict(card_asset.LAYOUT)
        layout["mark_px"] = layout["mark_px"] + 6
        monkeypatch.setattr(card_asset, "LAYOUT", layout)
        with pytest.raises(ValueError, match="stale"):
            check_fingerprint()

    def test_decodes_to_a_full_screen_of_palette_indices(self):
        pixels = card_pixels()
        assert pixels.shape == (SCREEN_H, SCREEN_W)
        assert pixels.dtype == np.uint8

    def test_is_read_only(self):
        # It is cached and handed to every export in the process; a caller that
        # scribbled on it would corrupt the rest of them.
        with pytest.raises(ValueError):
            card_pixels()[0, 0] = 9

    def test_a_truncated_asset_is_refused_rather_than_reshaped(self, monkeypatch):
        import base64
        import zlib

        short = zlib.compress(bytes(SCREEN_W * SCREEN_H - 1))
        monkeypatch.setattr(
            card_asset, "PIXELS_B64", base64.b64encode(short).decode("ascii")
        )
        # Both caches, and in a finally: card_cost caches on top of
        # card_pixels, and leaving the two disagreeing is the one way cost and
        # emission can diverge.
        try:
            card_mod.card_pixels.cache_clear()
            card_mod.card_cost.cache_clear()
            with pytest.raises(ValueError, match="decodes to"):
                card_pixels()
        finally:
            card_mod.card_pixels.cache_clear()
            card_mod.card_cost.cache_clear()

    def test_uses_only_indices_the_asset_declares(self):
        used = {int(c) for c in np.unique(card_pixels())}
        assert used <= {BG, TEXT} | set(card_asset.PALETTE)

    def test_leaves_the_lyric_palette_alone(self):
        # The card and the lyrics share one CLUT load, which only works if the
        # card draws in indices the renderer does not use.
        assert set(card_asset.PALETTE).isdisjoint(DEFAULT_PALETTE)
        merged = card_palette()
        for index, color in DEFAULT_PALETTE.items():
            assert merged[index] == color

    def test_palette_entries_fit_the_cluts_four_bits_per_channel(self):
        for color in card_asset.PALETTE.values():
            assert len(color) == 3
            assert all(0 <= channel <= 15 for channel in color)

    def test_the_art_stays_clear_of_the_border_ring(self):
        # Players may overscan the outer tile, and `blank()` paints it BORDER
        # regardless -- anything drawn there is lost on some rigs and fights the
        # border on the rest.
        edge = card_pixels().copy()
        edge[INTERIOR] = BG
        assert not edge.any()


class TestPainting:
    def test_round_trips_through_the_decoder(self):
        display = Display(palette=card_palette())
        decoder = Decoder()
        for pkt in display.show_bitmap(card_pixels()):
            decoder.apply(pkt)
        assert np.array_equal(
            decoder.framebuffer[INTERIOR], np.asarray(card_pixels())[INTERIOR]
        )

    def test_the_border_ring_is_painted_border_not_card_background(self):
        display = Display(palette=card_palette())
        decoder = Decoder()
        for pkt in display.show_bitmap(card_pixels()):
            decoder.apply(pkt)
        assert decoder.framebuffer[0, 0] == BORDER

    def test_cost_is_exactly_what_painting_emits(self):
        # The scheduler subtracts this from the intro before deciding whether
        # the card fits; a cost that undercounted would push the first page.
        assert card_cost() == len(Display().show_bitmap(card_pixels()))

    def test_the_card_really_does_exercise_multi_ink_tiles(self):
        # Otherwise the XOR overlay path below is untested by the real asset
        # and this suite would pass on a one-colour card.
        pixels = np.asarray(card_pixels())
        blocks = pixels.reshape(SCREEN_H // TILE_H, TILE_H, SCREEN_W // TILE_W, TILE_W)
        multi = sum(
            len({int(c) for c in np.unique(blocks[r, :, c, :])} - {BG}) > 1
            for r in range(blocks.shape[0])
            for c in range(blocks.shape[2])
        )
        assert multi > 0
        inked = int(
            (blocks != BG).any(axis=(1, 3)).sum()
        )
        # Strictly more packets than inked tiles: the excess IS the overlays.
        assert card_cost() == 3 + inked + multi_ink_overlays(pixels)
        assert card_cost() > 3 + inked

    @pytest.mark.parametrize("inks", [(4, 5), (4, 5, 6), (2, 4, 5, 6)])
    def test_a_tile_holding_several_inks_decodes_to_all_of_them(self, inks):
        # One NORMAL write plus one XOR per further ink. The XOR only lands on
        # the right colour because it goes down over background.
        pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        for row, ink in enumerate(inks):
            pixels[TILE_H + row, TILE_W : TILE_W + 4] = ink
        decoder = Decoder()
        for pkt in Display().show_bitmap(pixels):
            decoder.apply(pkt)
        assert np.array_equal(decoder.framebuffer[INTERIOR], pixels[INTERIOR])

    def test_cost_and_painting_agree_on_synthetic_bitmaps(self):
        pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        pixels[TILE_H : TILE_H + 3, TILE_W : TILE_W + 30] = 4
        pixels[TILE_H + 3 : TILE_H + 6, TILE_W : TILE_W + 30] = 5
        assert bitmap_cost(pixels) == len(Display().show_bitmap(pixels))

    def test_an_empty_bitmap_costs_only_the_clear(self):
        blank = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        assert bitmap_cost(blank) == 3

    @pytest.mark.parametrize(
        "bad",
        [
            np.zeros((SCREEN_H, SCREEN_W - 1), dtype=np.uint8),
            np.zeros((SCREEN_H, SCREEN_W, 3), dtype=np.uint8),
            np.zeros(SCREEN_W, dtype=np.uint8),
        ],
    )
    def test_a_wrong_shaped_bitmap_is_refused(self, bad):
        with pytest.raises(ValueError, match="bitmap shape"):
            bitmap_cost(bad)

    def test_a_float_bitmap_is_refused_rather_than_painting_nothing(self):
        # Masks are built by comparing the tile against int-truncated inks, so
        # a float grid emits packets that paint no pixels at all -- the cost
        # still matches, so nothing downstream notices the picture vanished.
        bad = np.zeros((SCREEN_H, SCREEN_W))
        bad[TILE_H, TILE_W] = 4.2
        with pytest.raises(ValueError, match="dtype"):
            bitmap_cost(bad)

    @pytest.mark.parametrize("index", [16, 17, 255])
    def test_an_index_outside_the_palette_is_refused(self, index):
        # `tile_block` masks to four bits, so 17 would silently paint as 1.
        bad = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        bad[TILE_H, TILE_W] = index
        with pytest.raises(ValueError, match="outside the 16-entry palette"):
            bitmap_cost(bad)

    def test_the_xor_overlay_does_not_assume_the_background_is_zero(self):
        # The overlay's operand is BG ^ colour, not colour. With the shipped
        # BG of 0 the two are identical, so only a non-zero BG tells them apart.
        pixels = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        pixels[:] = 7
        pixels[TILE_H, TILE_W : TILE_W + 3] = 4
        pixels[TILE_H + 1, TILE_W : TILE_W + 3] = 5
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("karaoke_backend.cdg.display.BG", 7)
            decoder = Decoder()
            for pkt in Display().show_bitmap(pixels):
                decoder.apply(pkt)
        assert np.array_equal(decoder.framebuffer[INTERIOR], pixels[INTERIOR])


class TestTiming:
    def test_a_long_intro_gets_the_full_hold(self):
        assert plan_card(60.0) == CARD_MAX_HOLD

    def test_a_short_intro_gets_no_card_at_all(self):
        # Not a brief flash: an unreadable card is worse than none.
        assert plan_card(card_cost() / PACKETS_PER_SEC + CARD_MIN_HOLD / 2) is None

    def test_a_window_landing_exactly_on_the_floor_still_gets_a_card(self):
        # Pins >= rather than >, which no swept value happens to hit.
        exact = card_cost() / PACKETS_PER_SEC + card_mod._BLANK_SLACK + CARD_MIN_HOLD
        assert plan_card(exact) == pytest.approx(CARD_MIN_HOLD)

    def test_the_hold_is_never_below_the_floor(self):
        paint = card_cost() / PACKETS_PER_SEC
        for available in np.arange(0.0, paint + CARD_MAX_HOLD + 1.0, 0.05):
            hold = plan_card(float(available))
            assert hold is None or CARD_MIN_HOLD <= hold <= CARD_MAX_HOLD

    def test_paint_plus_hold_always_fits_the_window(self):
        paint = card_cost() / PACKETS_PER_SEC
        for available in np.arange(0.0, 20.0, 0.05):
            hold = plan_card(float(available))
            if hold is not None:
                assert paint + hold <= float(available)

    @pytest.mark.parametrize("first", [3.0, 4.0, 4.68, 6.0, 12.0, 40.0])
    def test_the_card_never_moves_the_first_page(self, first):
        # 4.68 is the tightest fit found by sweeping `first` at packet
        # resolution for the current card (337 packets); re-sweep when the
        # mark is redrawn, since a heavier card needs a longer lead.
        assert_page_lands_on_time(page_at(first), first + 10.0)

    @pytest.mark.parametrize("first", [3.0, 4.5, 6.0, 20.0])
    def test_the_card_never_moves_a_dense_page(self, first):
        # A dense page already needs its whole lead to paint; the card has to
        # give way rather than share.
        assert_page_lands_on_time(dense_page(first=first), first + 20.0)

    @pytest.mark.parametrize("first", [4.68, 5.0, 8.0, 30.0])
    def test_the_card_stays_up_for_the_hold_it_planned(self, first):
        """The card is readable for as long as `plan_card` promised.

        Not just "on screen at some instant": the blank has to be scheduled a
        full paint plus hold in, so the whole point of CARD_MIN_HOLD -- that a
        card either reads or does not appear -- survives. Dropping the paint
        term from the blank's time leaves the card up for a fraction of its
        hold and every single-instant probe still passes.
        """
        page = page_at(first)
        hold = plan_card(build_timeline([page], card=False)[1][0])
        assert hold is not None
        stream = build_stream([page], first + 20.0)
        paint = card_cost() / PACKETS_PER_SEC

        def card_is_up(when: float) -> bool:
            screen = decode_at(stream, when).framebuffer
            return bool(np.isin(screen, list(card_asset.PALETTE)).any())

        assert card_is_up(paint + 0.05)
        assert card_is_up(paint + hold - 0.05)
        assert not card_is_up(paint + hold + 0.05)

    def test_the_screen_is_clear_of_the_card_the_instant_the_page_is_due(self):
        page = page_at(20.0)
        _, show_times = build_timeline([page], card=False)
        screen = decode_at(build_stream([page], 30.0), show_times[0] - 0.01)
        assert not np.isin(screen.framebuffer, list(card_asset.PALETTE)).any()

    def test_the_card_is_cleared_before_the_page_shows(self):
        events, show_times = build_timeline([page_at(20.0)], card=True)
        blanks = [e.time for e in events if e.kind == "blank"]
        assert min(blanks) < show_times[0]

    def test_no_pages_still_gets_a_card(self):
        # An instrumental export is still an export; there is nothing to delay.
        events, _ = build_timeline([], card=True)
        assert [e.kind for e in events if e.kind == "card"] == ["card"]


class TestStream:
    def test_the_card_is_on_screen_during_its_hold(self):
        stream = build_stream([page_at(30.0)], 40.0)
        screen = decode_at(stream, card_cost() / PACKETS_PER_SEC + 0.5)
        assert np.array_equal(
            screen.framebuffer[INTERIOR], np.asarray(card_pixels())[INTERIOR]
        )

    def test_the_card_is_gone_by_the_time_lyrics_are_up(self):
        stream = build_stream([page_at(30.0)], 40.0)
        screen = decode_at(stream, 30.5)
        assert not np.isin(
            screen.framebuffer, list(card_asset.PALETTE)
        ).any()

    def test_card_false_leaves_the_intro_empty(self):
        stream = build_stream([page_at(30.0)], 40.0, card=False)
        screen = decode_at(stream, card_cost() / PACKETS_PER_SEC + 0.5)
        assert set(np.unique(screen.framebuffer)) <= {BG, BORDER}

    def test_a_song_that_starts_singing_immediately_gets_no_card(self):
        stream = build_stream([page_at(0.4)], 10.0)
        screen = decode_at(stream, 0.3)
        assert not np.isin(screen.framebuffer, list(card_asset.PALETTE)).any()

    def test_the_clut_carries_the_card_colours_even_with_a_custom_palette(self):
        # A custom lyric palette must not knock the card's own ink out of
        # the CLUT: they occupy different indices precisely so both fit.
        palette = dict(DEFAULT_PALETTE) | {TEXT: (15, 0, 15)}
        stream = build_stream([page_at(30.0)], 40.0, palette)
        screen = decode_at(stream, card_cost() / PACKETS_PER_SEC + 0.5)
        for index, color in card_asset.PALETTE.items():
            assert screen.clut[index] == color
        assert screen.clut[TEXT] == (15, 0, 15)


class TestGeneratorAgreement:
    """The asset against the sources it was baked from.

    Skipped where the frontend tree is absent -- an installed wheel has the
    baked card but not the component it came from.
    """

    @staticmethod
    def _generator():
        script = (
            Path(__file__).resolve().parents[2]
            / "backend/scripts/gen-card-asset.py"
        )
        if not script.is_file():
            pytest.skip("generator not present")
        spec = importlib.util.spec_from_file_location("gen_card_asset", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, script.resolve().parents[2]

    def test_the_mark_has_not_been_redrawn_since_the_card_was_baked(self):
        gen, root = self._generator()
        source = root / gen.MARK_SOURCE
        if not source.is_file():
            pytest.skip("frontend tree not present")
        assert gen.fingerprint_mark(gen.extract_mark(source)) == (
            card_asset.MARK_FINGERPRINT
        ), "the brand mark changed; re-run backend/scripts/gen-card-asset.py"

    def test_the_generators_copy_fingerprint_matches_the_runtimes(self):
        # Two implementations of the same hash, one in the generator and one in
        # `cdg.card`. They are only useful while they agree -- and this compares
        # them WITHOUT first copying the asset's LAYOUT over the generator's,
        # which would reduce it to checking that sha256 equals sha256.
        gen, _ = self._generator()
        assert gen.fingerprint_copy(
            branding.ATTRIBUTION_CARD_TEXT, branding.PRODUCT_URL
        ) == card_mod.fingerprint()

    def test_the_generators_constants_still_describe_the_baked_card(self):
        """The asset's own fingerprint cannot catch this.

        `check_fingerprint` hashes `card_asset.LAYOUT` and compares against
        `card_asset.FINGERPRINT` -- both from the same generated file, so it is
        self-consistent whatever the generator now says. Editing the generator's
        point size, threshold or ink base changes what a REGENERATED card would
        look like while every fingerprint stays happy.
        """
        gen, root = self._generator()
        assert gen.LAYOUT == card_asset.LAYOUT
        assert (gen.SCREEN_W, gen.SCREEN_H) == (card_asset.WIDTH, card_asset.HEIGHT)

        source = root / gen.MARK_SOURCE
        if not source.is_file():
            pytest.skip("frontend tree not present")
        mark = gen.extract_mark(source)
        # Also the one check that catches a hand-edit of the generated palette,
        # which no fingerprint covers: the colours have to be the mark's.
        assert {
            gen.INK_BASE + i: gen.to444(rgb)
            for i, (_, rgb) in enumerate(mark.colors)
        } == card_asset.PALETTE
