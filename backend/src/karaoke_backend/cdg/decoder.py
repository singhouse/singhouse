# SPDX-License-Identifier: AGPL-3.0-only
"""A software CD+G decoder.

Two jobs. It verifies the encoder -- decoding a stream we just wrote back into
a framebuffer is a true round-trip check that the emitted packets are
spec-correct -- and it is the reader that single-file CD+G playback and import
are built on.

Output is a plain indexed framebuffer plus the palette. Turning that into an
image belongs to whatever is displaying it, so this module needs nothing beyond
numpy.
"""

from __future__ import annotations

import math

import numpy as np

from .spec import (
    CDG_BORDER_PRESET,
    CDG_LOAD_CLUT_HI,
    CDG_LOAD_CLUT_LO,
    CDG_MEMORY_PRESET,
    CDG_SCROLL_COPY,
    CDG_SCROLL_PRESET,
    CDG_DEFINE_TRANSPARENT,
    CDG_TILE_NORMAL,
    CDG_TILE_XOR,
    MAX_DECODE_PACKETS,
    PACKET_BYTES,
    PACKETS_PER_SEC,
    SC_CDG_COMMAND,
    SCREEN_H,
    SCREEN_W,
    TILE_H,
    TILE_W,
)


class Decoder:
    """Replays a bounded packet stream into a 300x216 indexed framebuffer.

    The counter is a second line of defence for incremental callers. Bulk
    callers should use :func:`decode_at`, which can reject an oversized stream
    before dispatching even its first packet.
    """

    def __init__(self):
        self.framebuffer = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        self.clut: list[tuple[int, int, int]] = [(0, 0, 0)] * 16
        self.transparent: int | None = None
        self.h_offset = 0
        self.v_offset = 0
        self.packets_applied = 0

    def apply(self, pkt: bytes) -> None:
        """Apply one 24-byte packet. Non-CD+G subcode packets are ignored."""
        if self.packets_applied >= MAX_DECODE_PACKETS:
            raise ValueError(
                f"CD+G decode exceeds the {MAX_DECODE_PACKETS}-packet limit"
            )
        # Every packet costs dispatch CPU even when it is a no-op or malformed,
        # so every call consumes the budget rather than only recognised writes.
        self.packets_applied += 1
        if len(pkt) < 20 or (pkt[0] & 0x3F) != SC_CDG_COMMAND:
            return
        instr = pkt[1] & 0x3F
        data = pkt[4:20]

        if instr == CDG_MEMORY_PRESET:
            self.framebuffer[:] = data[0] & 0x0F

        elif instr == CDG_BORDER_PRESET:
            color = data[0] & 0x0F
            self.framebuffer[0:TILE_H, :] = color
            self.framebuffer[SCREEN_H - TILE_H :, :] = color
            self.framebuffer[TILE_H : SCREEN_H - TILE_H, 0:TILE_W] = color
            self.framebuffer[TILE_H : SCREEN_H - TILE_H, SCREEN_W - TILE_W :] = color

        elif instr in (CDG_TILE_NORMAL, CDG_TILE_XOR):
            color0 = data[0] & 0x0F
            color1 = data[1] & 0x0F
            y0 = (data[2] & 0x1F) * TILE_H
            x0 = (data[3] & 0x3F) * TILE_W
            # A tile addressed off-screen is malformed; players drop it rather
            # than wrapping, and so do we.
            if y0 + TILE_H > SCREEN_H or x0 + TILE_W > SCREEN_W:
                return
            for py in range(TILE_H):
                bits = data[4 + py] & 0x3F
                for px in range(TILE_W):
                    color = color1 if (bits >> (TILE_W - 1 - px)) & 1 else color0
                    if instr == CDG_TILE_XOR:
                        self.framebuffer[y0 + py, x0 + px] ^= color
                    else:
                        self.framebuffer[y0 + py, x0 + px] = color

        elif instr in (CDG_LOAD_CLUT_LO, CDG_LOAD_CLUT_HI):
            base = 8 if instr == CDG_LOAD_CLUT_HI else 0
            for i in range(8):
                high = data[2 * i] & 0x3F
                low = data[2 * i + 1] & 0x3F
                r = (high >> 2) & 0xF
                g = ((high & 0x3) << 2) | ((low >> 4) & 0x3)
                b = low & 0xF
                self.clut[base + i] = (r, g, b)

        elif instr in (CDG_SCROLL_PRESET, CDG_SCROLL_COPY):
            color = data[0] & 0x0F
            h_cmd, self.h_offset = (data[1] >> 4) & 0x03, data[1] & 0x07
            v_cmd, self.v_offset = (data[2] >> 4) & 0x03, data[2] & 0x0F
            dy = TILE_H if v_cmd == 1 else (-TILE_H if v_cmd == 2 else 0)
            dx = TILE_W if h_cmd == 1 else (-TILE_W if h_cmd == 2 else 0)
            if dx or dy:
                self.framebuffer[:] = np.roll(self.framebuffer, (dy, dx), axis=(0, 1))
                if instr == CDG_SCROLL_PRESET:
                    if dy > 0:
                        self.framebuffer[:dy, :] = color
                    elif dy < 0:
                        self.framebuffer[dy:, :] = color
                    if dx > 0:
                        self.framebuffer[:, :dx] = color
                    elif dx < 0:
                        self.framebuffer[:, dx:] = color

        elif instr == CDG_DEFINE_TRANSPARENT:
            # CD+G transparency assumes another picture behind the subcode
            # plane. This standalone player has no such layer, so to_rgb()
            # deliberately flattens the selected index against black.
            self.transparent = data[0] & 0x0F

    def to_rgb(self) -> np.ndarray:
        """Resolve the framebuffer through the palette to (H, W, 3) uint8 RGB.

        CD+G carries 4 bits per channel; scaling by 17 maps 0..15 onto 0..255
        exactly (0x0 -> 0x00, 0xF -> 0xFF).
        """
        lut = np.array(self.clut, dtype=np.uint8) * 17
        rgb = lut[self.framebuffer]
        # Scroll packets carry fine display offsets separately from the
        # whole-tile mutation above. A positive offset advances the scan origin
        # (the published left-scroll sequence is 1..5, then a six-pixel coarse
        # scroll and reset), so the displayed raster moves left/up. The CD+G
        # memory is circular for this scan; the safety border hides the wrap on
        # ordinary material.
        if self.h_offset or self.v_offset:
            rgb = np.roll(rgb, (-self.v_offset, -self.h_offset), axis=(0, 1))
        if self.transparent is not None:
            rgb = rgb.copy()
            transparent = np.roll(
                self.framebuffer == self.transparent,
                (-self.v_offset, -self.h_offset),
                axis=(0, 1),
            )
            rgb[transparent] = 0
        return rgb


def iter_packets(stream: bytes):
    """Yield each whole 24-byte packet in a .cdg stream."""
    for offset in range(0, len(stream) - PACKET_BYTES + 1, PACKET_BYTES):
        yield stream[offset : offset + PACKET_BYTES]


def decode_at(stream: bytes, seconds: float) -> Decoder:
    """Decode a bounded .cdg stream through ``seconds``.

    A stream of exactly :data:`MAX_DECODE_PACKETS` whole packets is accepted;
    one packet more is refused before a ``Decoder`` is constructed or
    ``Decoder.apply`` is called. As before, a trailing partial packet is
    ignored and time zero includes packet zero.
    """
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError(f"decode time must be a finite non-negative number, got {seconds!r}")

    packet_count = len(stream) // PACKET_BYTES
    if packet_count > MAX_DECODE_PACKETS:
        raise ValueError(
            f"CD+G stream has {packet_count} packets; limit is {MAX_DECODE_PACKETS}"
        )

    decoder = Decoder()
    last = min(int(seconds * PACKETS_PER_SEC), packet_count - 1)
    for i in range(last + 1):
        decoder.apply(stream[i * PACKET_BYTES : (i + 1) * PACKET_BYTES])
    return decoder
