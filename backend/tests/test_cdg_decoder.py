# SPDX-License-Identifier: AGPL-3.0-only
"""Resource and time bounds at the CD+G decoder's untrusted-input seam."""

from __future__ import annotations

import pytest

from karaoke_backend.cdg import (
    Decoder,
    MAX_DECODE_PACKETS,
    MAX_DECODE_SECONDS,
    PACKET_BYTES,
    decode_at,
)
from karaoke_backend.cdg.spec import NOOP_PACKET
from karaoke_backend.cdg import packets
from karaoke_backend.cdg.spec import (
    CDG_DEFINE_TRANSPARENT,
    CDG_SCROLL_COPY,
    CDG_SCROLL_PRESET,
)
import numpy as np


def test_decode_budget_is_thirty_minutes_of_packets():
    assert MAX_DECODE_SECONDS == 30 * 60
    assert MAX_DECODE_PACKETS == MAX_DECODE_SECONDS * 300


def test_exact_packet_budget_is_accepted(monkeypatch):
    applied = 0

    def count_apply(self, packet):
        nonlocal applied
        applied += 1

    monkeypatch.setattr(Decoder, "apply", count_apply)
    stream = NOOP_PACKET * MAX_DECODE_PACKETS

    # The bulk preflight inspects the whole stream before dispatch. Decoding
    # only time zero proves the exact-size stream crosses that boundary without
    # making this resource-limit test itself replay half a million packets.
    decode_at(stream, 0)

    assert applied == 1


def test_one_packet_over_budget_is_rejected_before_apply(monkeypatch):
    applied = 0

    def count_apply(self, packet):
        nonlocal applied
        applied += 1

    monkeypatch.setattr(Decoder, "apply", count_apply)
    stream = b"\x00" * (PACKET_BYTES * (MAX_DECODE_PACKETS + 1))

    with pytest.raises(ValueError, match=rf"{MAX_DECODE_PACKETS + 1} packets"):
        decode_at(stream, 0)

    assert applied == 0


@pytest.mark.parametrize("seconds", [-0.001, float("nan"), float("inf"), -float("inf")])
def test_non_finite_or_negative_decode_time_is_rejected(seconds):
    with pytest.raises(ValueError, match="finite non-negative"):
        decode_at(NOOP_PACKET, seconds)


def test_time_zero_includes_the_first_packet():
    decoder = decode_at(NOOP_PACKET, 0)
    assert decoder.packets_applied == 1


def test_an_empty_or_partial_stream_dispatches_no_packet():
    assert decode_at(b"", 0).packets_applied == 0
    assert decode_at(b"\x00" * (PACKET_BYTES - 1), 0).packets_applied == 0


def test_incremental_decoder_refuses_packet_after_exact_budget():
    decoder = Decoder()
    decoder.packets_applied = MAX_DECODE_PACKETS

    with pytest.raises(ValueError, match=rf"{MAX_DECODE_PACKETS}-packet limit"):
        decoder.apply(NOOP_PACKET)

    assert decoder.packets_applied == MAX_DECODE_PACKETS


def test_scroll_copy_wraps_a_tile_and_scroll_preset_fills_the_exposed_edge():
    decoder = Decoder()
    decoder.framebuffer[:, :] = np.arange(300, dtype=np.uint16) % 16
    before = decoder.framebuffer.copy()
    decoder.apply(packets.packet(CDG_SCROLL_COPY, bytes([0, 0x20, 0])))
    assert np.array_equal(decoder.framebuffer[:, :-6], before[:, 6:])
    assert np.array_equal(decoder.framebuffer[:, -6:], before[:, :6])

    decoder.apply(packets.packet(CDG_SCROLL_PRESET, bytes([7, 0x10, 0])))
    assert np.all(decoder.framebuffer[:, :6] == 7)


def test_scroll_fine_offsets_move_the_display_without_mutating_memory():
    decoder = Decoder()
    decoder.clut[1] = (15, 0, 0)
    decoder.framebuffer[5, 7] = 1
    before = decoder.framebuffer.copy()

    decoder.apply(packets.packet(CDG_SCROLL_COPY, bytes([0, 0x02, 0x03])))

    assert np.array_equal(decoder.framebuffer, before)
    assert decoder.to_rgb()[2, 5].tolist() == [255, 0, 0]


def test_transparent_colour_is_flattened_to_black_for_standalone_playback():
    decoder = Decoder()
    decoder.clut[5] = (15, 2, 1)
    decoder.framebuffer[:, :] = 5
    decoder.apply(packets.packet(CDG_DEFINE_TRANSPARENT, bytes([5])))
    assert np.all(decoder.to_rgb() == 0)
