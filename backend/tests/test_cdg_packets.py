# SPDX-License-Identifier: AGPL-3.0-only
"""Packet-level conformance for the CD+G encoder.

These assert the wire format itself -- byte layout, field widths, bit order --
against the published spec, so a refactor that still "looks right" on screen
cannot quietly emit packets a hardware player would reject.
"""

from __future__ import annotations

import pytest

from karaoke_backend.cdg import packets, spec
from karaoke_backend.cdg.spec import (
    CDG_BORDER_PRESET,
    CDG_LOAD_CLUT_HI,
    CDG_LOAD_CLUT_LO,
    CDG_MEMORY_PRESET,
    CDG_TILE_NORMAL,
    CDG_TILE_XOR,
    PACKET_BYTES,
    SC_CDG_COMMAND,
    TILE_H,
    TILE_W,
)


class TestSpecValuesArePinned:
    """Written-out values, so the constants themselves are under test.

    Every other assertion in this file compares an emitted packet against the
    same `spec` symbol the encoder built it from, so the two move together and
    a wrong constant is invisible -- change `SC_CDG_COMMAND` to 0x08 and the
    rest of the suite still passes while no player on earth reads the output.
    These are the one place the numbers appear independently.
    """

    def test_emitted_opcodes_are_the_published_ones(self):
        rows = [0] * 12
        assert packets.memory_preset(0)[:2] == bytes([0x09, 1])
        assert packets.border_preset(0)[:2] == bytes([0x09, 2])
        assert packets.tile_block(0, 0, 0, 1, rows)[:2] == bytes([0x09, 6])
        assert packets.tile_block(0, 0, 0, 1, rows, xor=True)[:2] == bytes([0x09, 38])
        assert packets.load_clut([(0, 0, 0)] * 8)[:2] == bytes([0x09, 30])
        assert packets.load_clut([(0, 0, 0)] * 8, high=True)[:2] == bytes([0x09, 31])

    def test_stream_geometry_is_the_published_one(self):
        assert (spec.PACKET_BYTES, spec.PACKETS_PER_SEC) == (24, 300)
        assert (spec.SCREEN_W, spec.SCREEN_H) == (300, 216)
        assert (spec.TILE_W, spec.TILE_H) == (6, 12)
        assert (spec.TILE_COLS, spec.TILE_ROWS) == (50, 18)

    def test_layout_choices_are_pinned(self):
        # Ours, not the format's -- but the layout tests derive their expected
        # coordinates from these, so a drift would move test and code together.
        assert (spec.REGION_COL0, spec.REGION_COLS, spec.REGION_W) == (2, 46, 276)
        assert (spec.LINE_TILE_H, spec.LINE_H) == (3, 36)
        assert (spec.TEXT_ROW0, spec.TEXT_ROWS, spec.MAX_SCREEN_LINES) == (1, 16, 5)
        assert spec.MAX_PAGE_LINES == 4
        assert (spec.BG, spec.BORDER, spec.TEXT, spec.HILITE) == (0, 1, 2, 3)
        assert spec.XOR_INK == 1  # TEXT ^ HILITE, the operand that lights a glyph


class TestPacketFraming:
    def test_packet_is_24_bytes_with_cdg_command(self):
        pkt = packets.packet(CDG_MEMORY_PRESET, b"\x01")
        assert len(pkt) == PACKET_BYTES
        assert pkt[0] == SC_CDG_COMMAND
        assert pkt[1] == CDG_MEMORY_PRESET

    def test_header_and_trailer_parity_bytes_are_zero(self):
        pkt = packets.packet(CDG_TILE_NORMAL, bytes(range(16)))
        assert pkt[2:4] == b"\x00\x00"
        assert pkt[20:24] == b"\x00\x00\x00\x00"

    def test_short_data_is_zero_padded(self):
        pkt = packets.packet(CDG_BORDER_PRESET, b"\x03")
        assert pkt[4] == 0x03
        assert pkt[5:20] == b"\x00" * 15

    def test_overlong_data_is_truncated_to_16_bytes(self):
        pkt = packets.packet(CDG_TILE_NORMAL, bytes(range(32)))
        assert len(pkt) == PACKET_BYTES
        assert pkt[4:20] == bytes(range(16))

    def test_instruction_is_masked_to_six_bits(self):
        # The top two bits belong to the subcode channel, not the instruction.
        assert packets.packet(0xC0 | CDG_TILE_XOR)[1] == CDG_TILE_XOR


class TestClut:
    @pytest.mark.parametrize(
        "rgb,expected",
        [
            ((0, 0, 0), (0x00, 0x00)),
            ((15, 15, 15), (0x3F, 0x3F)),
            # r=15 -> 1111, g=0 -> 0000, b=0: high = 111100, low = 000000
            ((15, 0, 0), (0x3C, 0x00)),
            # g=15 -> high gets 11, low gets 11 in bits 5..4
            ((0, 15, 0), (0x03, 0x30)),
            ((0, 0, 15), (0x00, 0x0F)),
        ],
    )
    def test_colour_packs_into_two_six_bit_bytes(self, rgb, expected):
        assert tuple(packets.clut_entry(rgb)) == expected

    def test_clut_bytes_never_exceed_six_bits(self):
        for r in range(16):
            for g in range(16):
                for b in range(16):
                    high, low = packets.clut_entry((r, g, b))
                    assert high <= 0x3F and low <= 0x3F

    def test_load_clut_selects_low_or_high_bank(self):
        entries = [(0, 0, 0)] * 8
        assert packets.load_clut(entries, high=False)[1] == CDG_LOAD_CLUT_LO
        assert packets.load_clut(entries, high=True)[1] == CDG_LOAD_CLUT_HI

    def test_load_clut_carries_eight_entries(self):
        entries = [(i, i, i) for i in range(8)]
        pkt = packets.load_clut(entries)
        for i, rgb in enumerate(entries):
            assert pkt[4 + 2 * i : 6 + 2 * i] == packets.clut_entry(rgb)


class TestPresets:
    def test_memory_preset_carries_colour_and_repeat(self):
        pkt = packets.memory_preset(5, repeat=3)
        assert pkt[1] == CDG_MEMORY_PRESET
        assert pkt[4] == 5
        assert pkt[5] == 3

    def test_preset_colour_is_masked_to_the_16_entry_palette(self):
        assert packets.memory_preset(0xFF)[4] == 0x0F
        assert packets.border_preset(0xFF)[4] == 0x0F


class TestTileBlocks:
    def test_field_layout(self):
        rows = [0] * TILE_H
        pkt = packets.tile_block(7, 11, color0=2, color1=3, rows=rows)
        assert pkt[1] == CDG_TILE_NORMAL
        assert pkt[4] == 2  # colour0
        assert pkt[5] == 3  # colour1
        assert pkt[6] == 7  # tile row
        assert pkt[7] == 11  # tile column

    def test_xor_flag_selects_the_xor_instruction(self):
        rows = [0] * TILE_H
        assert packets.tile_block(0, 0, 0, 1, rows, xor=True)[1] == CDG_TILE_XOR

    def test_row_is_five_bits_and_column_is_six(self):
        # 18 tile rows and 50 tile columns fit; the masks are the spec's, and
        # an out-of-range value must not bleed into a neighbouring field.
        pkt = packets.tile_block(0xFF, 0xFF, 0, 1, [0] * TILE_H)
        assert pkt[6] == 0x1F
        assert pkt[7] == 0x3F

    def test_pack_tile_rows_puts_the_leftmost_pixel_in_bit_five(self):
        tile = [[0] * TILE_W for _ in range(TILE_H)]
        tile[0][0] = 1  # leftmost pixel of the top row
        tile[1][TILE_W - 1] = 1  # rightmost pixel of the next row
        rows = packets.pack_tile_rows(tile)
        assert rows[0] == 0x20
        assert rows[1] == 0x01

    def test_wrong_row_count_is_refused_rather_than_mis_framed(self):
        # Too few rows would pad out of the parity bytes, too many would
        # overrun them; either way the packet is silently wrong on the wire.
        for count in (TILE_H - 1, TILE_H + 1, 0):
            with pytest.raises(ValueError, match="row bytes"):
                packets.tile_block(0, 0, 0, 1, [0] * count)

    def test_pack_tile_rows_returns_one_byte_per_pixel_row(self):
        tile = [[1] * TILE_W for _ in range(TILE_H)]
        rows = packets.pack_tile_rows(tile)
        assert len(rows) == TILE_H
        assert all(r == 0x3F for r in rows)
