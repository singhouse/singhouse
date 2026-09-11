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

import numpy as np

from .spec import (
    CDG_BORDER_PRESET,
    CDG_LOAD_CLUT_HI,
    CDG_LOAD_CLUT_LO,
    CDG_MEMORY_PRESET,
    CDG_TILE_NORMAL,
    CDG_TILE_XOR,
    PACKET_BYTES,
    PACKETS_PER_SEC,
    SC_CDG_COMMAND,
    SCREEN_H,
    SCREEN_W,
    TILE_H,
    TILE_W,
)


class Decoder:
    """Replays subcode packets into a 300x216 indexed framebuffer."""

    def __init__(self):
        self.framebuffer = np.zeros((SCREEN_H, SCREEN_W), dtype=np.uint8)
        self.clut: list[tuple[int, int, int]] = [(0, 0, 0)] * 16

    def apply(self, pkt: bytes) -> None:
        """Apply one 24-byte packet. Non-CD+G subcode packets are ignored."""
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

    def to_rgb(self) -> np.ndarray:
        """Resolve the framebuffer through the palette to (H, W, 3) uint8 RGB.

        CD+G carries 4 bits per channel; scaling by 17 maps 0..15 onto 0..255
        exactly (0x0 -> 0x00, 0xF -> 0xFF).
        """
        lut = np.array(self.clut, dtype=np.uint8) * 17
        return lut[self.framebuffer]


def iter_packets(stream: bytes):
    """Yield each whole 24-byte packet in a .cdg stream."""
    for offset in range(0, len(stream) - PACKET_BYTES + 1, PACKET_BYTES):
        yield stream[offset : offset + PACKET_BYTES]


def decode_at(stream: bytes, seconds: float) -> Decoder:
    """Decode a .cdg stream up to `seconds` and return the resulting screen."""
    decoder = Decoder()
    last = min(int(seconds * PACKETS_PER_SEC), len(stream) // PACKET_BYTES - 1)
    for i in range(max(0, last) + 1):
        decoder.apply(stream[i * PACKET_BYTES : (i + 1) * PACKET_BYTES])
    return decoder
