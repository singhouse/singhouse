# SPDX-License-Identifier: AGPL-3.0-only
"""End-to-end CD+G encoding, verified by decoding the stream back.

Every assertion here goes through the decoder rather than inspecting the
encoder's intermediate state, so these are true round-trip checks: if the
encoder emits a packet a player would read differently than we intended, the
framebuffer says so.

Glyph masks are synthetic rectangles. Nothing here needs a font, and no real
lyrics are involved.
"""

from __future__ import annotations

import numpy as np
import pytest

from karaoke_backend.cdg import (
    Decoder,
    Display,
    LineLayout,
    Page,
    WordRect,
    build_stream,
    build_timeline,
    decode_at,
    iter_packets,
)
from karaoke_backend.cdg.display import show_cost
from karaoke_backend.cdg.spec import (
    BG,
    HILITE,
    LINE_H,
    MAX_PAGE_LINES,
    MAX_SCREEN_LINES,
    MAX_STREAM_SECONDS,
    PACKET_BYTES,
    PACKETS_PER_SEC,
    REGION_COL0,
    REGION_W,
    TEXT,
    TEXT_ROW0,
    TILE_H,
    TILE_W,
)

# Glyph band inside a line: rows 6..30 of the 36-pixel line box.
_GLYPH_TOP, _GLYPH_BOTTOM = 6, 30


def make_line(line_idx: int, spans) -> LineLayout:
    """Build a line whose 'glyphs' are solid rectangles.

    `spans` is [(x0, x1, start, end), ...] in region-local pixels and seconds.
    """
    mask = np.zeros((LINE_H, REGION_W), dtype=np.uint8)
    rects = []
    for x0, x1, start, end in spans:
        mask[_GLYPH_TOP:_GLYPH_BOTTOM, x0:x1] = 1
        rects.append(WordRect({"text": "x", "start": start, "end": end}, x0, x1))
    return LineLayout(line_idx=line_idx, mask=mask, rects=rects)


def one_page_stream(spans, duration=10.0, **page_kwargs):
    line = make_line(0, spans)
    page = Page(
        layouts=[line],
        first=min(s[2] for s in spans),
        last=max(s[3] for s in spans),
        fade_in=page_kwargs.get("fade_in"),
        fade_out=page_kwargs.get("fade_out"),
    )
    return build_stream([page], duration), page


def dense_page(first: float = 6.0, span: float = 1.0, **page_kwargs) -> Page:
    """The worst case for paint time: four full-width lines, ~555 packets.

    Lines are sung one after another, a second each, as a real page is -- four
    full-width lines highlighting at once would need 552 wipe packets inside
    one second, which the 300/s stream cannot carry at any schedule.
    """
    layouts = [
        make_line(i, [(0, REGION_W, first + i * span, first + (i + 1) * span)])
        for i in range(MAX_PAGE_LINES)
    ]
    return Page(
        layouts=layouts,
        first=first,
        last=first + MAX_PAGE_LINES * span,
        fade_in=page_kwargs.get("fade_in"),
        fade_out=page_kwargs.get("fade_out"),
    )


def screen_row(page_lines: int = 1, line: int = 0) -> int:
    """Absolute pixel row through the glyph band of a centred page line."""
    from karaoke_backend.cdg.spec import LINE_TILE_H, TEXT_ROWS

    top_tile = TEXT_ROW0 + (TEXT_ROWS - LINE_TILE_H * page_lines) // 2
    return (top_tile + LINE_TILE_H * line) * TILE_H + _GLYPH_TOP + 2


class TestStreamShape:
    def test_stream_is_whole_packets(self):
        stream, _ = one_page_stream([(0, 60, 1.0, 2.0)])
        assert len(stream) % PACKET_BYTES == 0

    def test_stream_runs_at_least_a_second_past_the_audio(self):
        duration = 8.0
        stream, _ = one_page_stream([(0, 60, 1.0, 2.0)], duration=duration)
        packets_emitted = len(stream) // PACKET_BYTES
        assert packets_emitted >= int(duration * PACKETS_PER_SEC) + PACKETS_PER_SEC

    def test_gaps_are_filled_with_noop_packets(self):
        stream, _ = one_page_stream([(0, 60, 4.0, 5.0)])
        # Nothing is scheduled in the last second, so the tail is all no-ops.
        tail = stream[-PACKETS_PER_SEC * PACKET_BYTES :]
        assert set(tail) == {0}


class TestPaintAndWipe:
    def test_glyphs_are_painted_before_the_first_word(self):
        stream, _ = one_page_stream([(0, 60, 4.0, 5.0)])
        # The page shows PAGE_LEAD (2s) before the first word at t=4.
        screen = decode_at(stream, 3.0).framebuffer
        row = screen_row()
        painted = screen[row, REGION_COL0 * TILE_W : REGION_COL0 * TILE_W + 60]
        assert set(painted.tolist()) == {TEXT}

    def test_nothing_is_highlighted_before_the_word_starts(self):
        stream, _ = one_page_stream([(0, 60, 4.0, 5.0)])
        screen = decode_at(stream, 3.5).framebuffer
        assert HILITE not in set(screen.flatten().tolist())

    def test_word_is_fully_highlighted_after_it_ends(self):
        stream, _ = one_page_stream([(0, 60, 4.0, 5.0)])
        screen = decode_at(stream, 5.2).framebuffer
        row = screen_row()
        swept = screen[row, REGION_COL0 * TILE_W : REGION_COL0 * TILE_W + 60]
        assert set(swept.tolist()) == {HILITE}

    def test_wipe_advances_left_to_right_through_a_word(self):
        # One 60px word from t=4 to t=6; halfway through, the left half is
        # highlighted and the right half is not.
        stream, _ = one_page_stream([(0, 60, 4.0, 6.0)], duration=12.0)
        screen = decode_at(stream, 5.0).framebuffer
        row = screen_row()
        x = REGION_COL0 * TILE_W
        left = screen[row, x : x + 24]
        right = screen[row, x + 42 : x + 60]
        assert set(left.tolist()) == {HILITE}
        assert set(right.tolist()) == {TEXT}

    def test_later_word_does_not_highlight_before_its_turn(self):
        stream, _ = one_page_stream(
            [(0, 60, 4.0, 5.0), (66, 126, 6.0, 7.0)], duration=12.0
        )
        screen = decode_at(stream, 5.2).framebuffer
        row = screen_row()
        x = REGION_COL0 * TILE_W
        assert set(screen[row, x : x + 60].tolist()) == {HILITE}
        assert set(screen[row, x + 66 : x + 126].tolist()) == {TEXT}

    def test_background_around_glyphs_is_never_recoloured_by_the_wipe(self):
        stream, _ = one_page_stream([(0, 60, 4.0, 5.0)])
        screen = decode_at(stream, 5.2).framebuffer
        row = screen_row()
        x = REGION_COL0 * TILE_W
        # Just above the glyph band, inside the same tiles the wipe touched.
        above = screen[row - _GLYPH_TOP, x : x + 60]
        assert set(above.tolist()) == {BG}


class TestPixelExactRoundTrip:
    """Solid tile-aligned blocks hide bit-order faults; these do not."""

    @staticmethod
    def _asymmetric_mask() -> np.ndarray:
        """A mask with no horizontal, vertical, or tile-local symmetry."""
        mask = np.zeros((LINE_H, REGION_W), dtype=np.uint8)
        rng = np.random.default_rng(20260813)
        patch = rng.integers(0, 2, size=(LINE_H, 120), dtype=np.uint8)
        mask[:, 7:127] = patch  # deliberately not tile-aligned
        return mask

    def test_decoded_glyphs_match_the_source_mask_pixel_for_pixel(self):
        mask = self._asymmetric_mask()
        layout = LineLayout(
            line_idx=0,
            mask=mask,
            rects=[WordRect({"text": "x", "start": 4.0, "end": 5.0}, 7, 127)],
        )
        page = Page([layout], 4.0, 5.0, None, None)
        stream = build_stream([page], 10.0)

        # Sample after the page is painted but before the wipe begins.
        screen = decode_at(stream, 3.0).framebuffer

        from karaoke_backend.cdg.spec import LINE_TILE_H, TEXT_ROWS

        top = (TEXT_ROW0 + (TEXT_ROWS - LINE_TILE_H) // 2) * TILE_H
        x = REGION_COL0 * TILE_W
        painted = screen[top : top + LINE_H, x : x + REGION_W]

        assert np.array_equal((painted == TEXT).astype(np.uint8), mask)
        assert np.array_equal((painted == BG).astype(np.uint8), 1 - mask)

    def test_wipe_highlights_exactly_the_glyph_pixels_and_nothing_else(self):
        mask = self._asymmetric_mask()
        layout = LineLayout(
            line_idx=0,
            mask=mask,
            rects=[WordRect({"text": "x", "start": 4.0, "end": 5.0}, 7, 127)],
        )
        page = Page([layout], 4.0, 5.0, None, None)
        stream = build_stream([page], 10.0)
        screen = decode_at(stream, 5.3).framebuffer

        from karaoke_backend.cdg.spec import LINE_TILE_H, TEXT_ROWS

        top = (TEXT_ROW0 + (TEXT_ROWS - LINE_TILE_H) // 2) * TILE_H
        x = REGION_COL0 * TILE_W
        painted = screen[top : top + LINE_H, x : x + REGION_W]

        assert np.array_equal((painted == HILITE).astype(np.uint8), mask)
        assert TEXT not in set(painted.flatten().tolist())


class TestXorSafety:
    def test_rewiping_a_band_emits_nothing(self):
        """A pixel XORed twice would toggle its highlight back off."""
        display = Display()
        line = make_line(0, [(0, 60, 0.0, 1.0)])
        display.init_packets()
        display.show_page([line])
        first = display.wipe_word(0, 0, 60)
        second = display.wipe_word(0, 0, 60)
        assert first != []
        assert second == []

    def test_overlapping_wipes_leave_the_overlap_highlighted_not_reverted(self):
        """The band 24..36 is swept twice; a double XOR would send it back to TEXT."""
        display = Display()
        decoder = Decoder()

        def feed(pkts):
            for pkt in pkts:
                decoder.apply(pkt)

        feed(display.init_packets())
        feed(display.show_page([make_line(0, [(0, 60, 0.0, 1.0)])]))
        feed(display.wipe_word(0, 0, 36))
        feed(display.wipe_word(0, 24, 60))

        row = screen_row()
        x = REGION_COL0 * TILE_W
        assert set(decoder.framebuffer[row, x : x + 60].tolist()) == {HILITE}

    def test_full_line_wipe_leaves_every_glyph_pixel_highlighted(self):
        stream, _ = one_page_stream(
            [(0, 36, 4.0, 4.5), (36, 72, 4.5, 5.0), (72, 108, 5.0, 5.5)],
            duration=12.0,
        )
        screen = decode_at(stream, 5.7).framebuffer
        row = screen_row()
        x = REGION_COL0 * TILE_W
        assert set(screen[row, x : x + 108].tolist()) == {HILITE}


class TestBlanking:
    def test_screen_blanks_after_the_page_when_nothing_follows(self):
        stream, _ = one_page_stream([(0, 60, 4.0, 5.0)], duration=12.0)
        # PAGE_HOLD is 1s, so the blank lands around t=6.
        screen = decode_at(stream, 7.0).framebuffer
        row = screen_row()
        x = REGION_COL0 * TILE_W
        assert set(screen[row, x : x + 60].tolist()) == {BG}

    def test_no_blank_between_pages_that_follow_each_other_closely(self):
        pages = [
            Page([make_line(0, [(0, 60, 2.0, 3.0)])], 2.0, 3.0, None, None),
            Page([make_line(1, [(0, 60, 3.6, 4.6)])], 3.6, 4.6, None, None),
        ]
        events, _ = build_timeline(pages)
        blanks = [e for e in events if e.kind == "blank"]
        # Only the trailing blank after the final page.
        assert len(blanks) == 1
        assert blanks[0].time > 4.6


class TestPageScheduling:
    def test_a_page_never_shows_while_the_previous_is_still_being_sung(self):
        pages = [
            Page([make_line(0, [(0, 60, 2.0, 6.0)])], 2.0, 6.0, None, None),
            Page([make_line(1, [(0, 60, 6.2, 8.0)])], 6.2, 8.0, None, None),
        ]
        _, show_times = build_timeline(pages)
        assert show_times[1] >= pages[0].last

    def test_authored_fade_in_is_honoured(self):
        pages = [Page([make_line(0, [(0, 60, 9.0, 10.0)])], 9.0, 10.0, 5.0, None)]
        _, show_times = build_timeline(pages)
        assert show_times[0] == pytest.approx(5.0)

    def test_show_time_is_never_negative(self):
        pages = [Page([make_line(0, [(0, 60, 0.2, 1.0)])], 0.2, 1.0, None, None)]
        _, show_times = build_timeline(pages)
        assert show_times[0] >= 0.0

    def test_late_page_backfills_words_already_sung(self):
        # The first page runs long, forcing the second to show after some of
        # its own words have already passed; those must appear highlighted.
        pages = [
            Page([make_line(0, [(0, 60, 1.0, 8.0)])], 1.0, 8.0, None, None),
            Page([make_line(1, [(0, 60, 7.0, 7.5), (66, 126, 9.0, 9.5)])], 7.0, 9.5, None, None),
        ]
        from karaoke_backend.cdg import serialize

        events, show_times = build_timeline(pages)
        stream = serialize(events, Display(), pages, 14.0)
        assert show_times[1] > 7.5  # the first word is already over

        screen = decode_at(stream, show_times[1] + 0.3).framebuffer
        row = screen_row()
        x = REGION_COL0 * TILE_W
        assert set(screen[row, x : x + 60].tolist()) == {HILITE}
        assert set(screen[row, x + 66 : x + 126].tolist()) == {TEXT}


class TestPaintBudget:
    """A page swap is one packet per glyph tile, and the stream is fixed-rate.

    A dense page takes real time to draw, and anything scheduled while it is
    still drawing gets displaced behind it -- which on screen is the highlight
    lagging the singer, the one artefact karaoke cannot have.
    """

    def test_the_worst_case_page_really_is_slow_to_paint(self):
        # Guards the premise of the tests below: if a future layout change made
        # a full page cheap, they would pass for the wrong reason.
        cost = show_cost(dense_page().layouts)
        assert cost / PACKETS_PER_SEC > 1.5

    def test_a_dense_page_finishes_painting_before_its_first_word(self):
        page = dense_page(first=6.0)
        _, show_times = build_timeline([page])
        paint_ends = show_times[0] + show_cost(page.layouts) / PACKETS_PER_SEC
        assert paint_ends <= page.first

    def test_a_late_authored_fade_in_is_pulled_back_to_leave_paint_time(self):
        # 5.5 leaves half a second to lay down ~1.85s of tiles; honouring it
        # verbatim would push the opening wipes more than a second late.
        page = dense_page(first=6.0, fade_in=5.5)
        _, show_times = build_timeline([page])
        assert show_times[0] < 5.5
        paint_ends = show_times[0] + show_cost(page.layouts) / PACKETS_PER_SEC
        assert paint_ends <= page.first

    def test_an_early_authored_fade_in_is_still_honoured(self):
        page = dense_page(first=9.0, fade_in=3.0)
        _, show_times = build_timeline([page])
        assert show_times[0] == pytest.approx(3.0)

    def test_the_first_word_of_a_dense_page_highlights_on_time(self):
        page = dense_page(first=6.0, fade_in=5.5)
        stream = build_stream([page], 12.0)
        screen = decode_at(stream, 7.2).framebuffer
        row = screen_row(page_lines=MAX_PAGE_LINES, line=0)
        x = REGION_COL0 * TILE_W
        assert set(screen[row, x : x + REGION_W].tolist()) == {HILITE}


class TestInputBounds:
    """Output size is a pure function of duration, so duration is a limit."""

    @pytest.mark.parametrize(
        "duration", [float("inf"), float("nan"), -1.0, MAX_STREAM_SECONDS + 1]
    )
    def test_an_unusable_duration_is_refused(self, duration):
        page = Page([make_line(0, [(0, 60, 1.0, 2.0)])], 1.0, 2.0, None, None)
        with pytest.raises(ValueError, match="duration"):
            build_stream([page], duration)

    def test_a_far_future_event_cannot_blow_up_the_stream(self):
        # A word timed years out would otherwise size the grid from its own
        # packet index rather than from the declared duration -- 1e7 seconds is
        # a 72 GB allocation.
        page = Page([make_line(0, [(0, 60, 1e7, 1e7 + 1)])], 1e7, 1e7 + 1, None, None)
        stream = build_stream([page], 10.0)
        assert len(stream) < 15 * PACKETS_PER_SEC * PACKET_BYTES

    @pytest.mark.parametrize("bad", [float("inf"), float("nan")])
    @pytest.mark.parametrize("field", ["first", "last", "fade_in", "fade_out"])
    def test_a_non_finite_page_time_is_named(self, field, bad):
        page = Page([make_line(0, [(0, 60, 1.0, 2.0)])], 1.0, 2.0, None, None)
        with pytest.raises(ValueError, match=field):
            build_timeline([page._replace(**{field: bad})])


class TestRasteriserSeam:
    """The caller supplies glyph masks, so this is where bad shapes enter."""

    def test_a_wrong_shaped_mask_is_named_not_indexed_past(self):
        layout = LineLayout(
            line_idx=3,
            mask=np.zeros((LINE_H, REGION_W - 1), dtype=np.uint8),
            rects=[],
        )
        with pytest.raises(ValueError, match="line 3"):
            Display().show_page([layout])

    def test_a_non_array_mask_is_reported_rather_than_crashing(self):
        layout = LineLayout(line_idx=0, mask=[[0, 1], [1, 0]], rects=[])
        with pytest.raises(ValueError, match="expected"):
            Display().show_page([layout])

    def test_more_lines_than_the_screen_holds_is_refused(self):
        layouts = [
            make_line(i, [(0, 60, 1.0, 2.0)]) for i in range(MAX_SCREEN_LINES + 1)
        ]
        with pytest.raises(ValueError, match="screen fits"):
            Display().show_page(layouts)

    def test_a_full_screen_of_lines_is_accepted(self):
        layouts = [make_line(i, [(0, 60, 1.0, 2.0)]) for i in range(MAX_SCREEN_LINES)]
        assert Display().show_page(layouts)


class TestDecoderConformance:
    def test_memory_preset_fills_the_whole_screen(self):
        from karaoke_backend.cdg import packets

        decoder = Decoder()
        decoder.apply(packets.memory_preset(9))
        assert set(decoder.framebuffer.flatten().tolist()) == {9}

    def test_border_preset_touches_only_the_outer_ring(self):
        from karaoke_backend.cdg import packets

        decoder = Decoder()
        decoder.apply(packets.memory_preset(0))
        decoder.apply(packets.border_preset(7))
        assert decoder.framebuffer[0, 0] == 7
        assert decoder.framebuffer[-1, -1] == 7
        assert decoder.framebuffer[TILE_H, TILE_W] == 0

    def test_off_screen_tile_is_dropped_not_wrapped(self):
        from karaoke_backend.cdg import packets

        decoder = Decoder()
        before = decoder.framebuffer.copy()
        # Tile row 17 is the last valid row (18 rows); 20 is off-screen.
        decoder.apply(packets.tile_block(20, 0, 0, 1, [0x3F] * TILE_H))
        assert np.array_equal(decoder.framebuffer, before)

    def test_non_cdg_subcode_packets_are_ignored(self):
        decoder = Decoder()
        before = decoder.framebuffer.copy()
        decoder.apply(b"\x01" + b"\x00" * (PACKET_BYTES - 1))
        assert np.array_equal(decoder.framebuffer, before)

    def test_clut_round_trips_through_the_decoder(self):
        from karaoke_backend.cdg import packets

        entries = [(0, 0, 0), (15, 15, 15), (15, 0, 0), (0, 15, 0), (0, 0, 15),
                   (7, 3, 11), (1, 2, 3), (12, 13, 14)]
        decoder = Decoder()
        decoder.apply(packets.load_clut(entries, high=False))
        assert decoder.clut[:8] == entries

    def test_high_clut_bank_loads_indices_eight_to_fifteen(self):
        from karaoke_backend.cdg import packets

        entries = [(i, i, i) for i in range(8, 16)]
        decoder = Decoder()
        decoder.apply(packets.load_clut(entries, high=True))
        assert decoder.clut[8:] == entries
        assert decoder.clut[:8] == [(0, 0, 0)] * 8

    def test_to_rgb_scales_four_bit_channels_to_full_range(self):
        from karaoke_backend.cdg import packets

        decoder = Decoder()
        decoder.apply(packets.load_clut([(15, 15, 15)] + [(0, 0, 0)] * 7))
        decoder.apply(packets.memory_preset(0))
        rgb = decoder.to_rgb()
        assert rgb.shape[2] == 3
        assert rgb[0, 0].tolist() == [255, 255, 255]

    def test_iter_packets_yields_only_whole_packets(self):
        stream = b"\x00" * (PACKET_BYTES * 3 + 5)
        assert len(list(iter_packets(stream))) == 3
