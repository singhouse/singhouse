# SPDX-License-Identifier: AGPL-3.0-only
"""CD+G subcode packet builders.

Every packet is 24 bytes: a 4-byte header (command, instruction, two parity
bytes we leave zero), 16 data bytes, and 4 trailing parity bytes. Only the low
6 bits of each byte are meaningful -- the top two are reserved for the subcode
channel -- so every field is masked on the way out.

Pure stdlib on purpose: this layer is the format, and it stays importable
without numpy or any rendering dependency.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from .spec import (
    CDG_BORDER_PRESET,
    CDG_LOAD_CLUT_HI,
    CDG_LOAD_CLUT_LO,
    CDG_MEMORY_PRESET,
    CDG_TILE_NORMAL,
    CDG_TILE_XOR,
    SC_CDG_COMMAND,
    TILE_H,
    TILE_W,
)


def packet(instruction: int, data: bytes | Sequence[int] = b"") -> bytes:
    """Wrap 16 data bytes in a CD+G subcode packet, padding or truncating."""
    payload = (bytes(data) + b"\x00" * 16)[:16]
    return bytes([SC_CDG_COMMAND, instruction & 0x3F, 0, 0]) + payload + b"\x00" * 4


def clut_entry(rgb: tuple[int, int, int]) -> bytes:
    """Pack one 4-bit-per-channel colour into the CLUT's two 6-bit bytes.

    Layout is [--rrrrgg][--ggbbbb]: red and the top two green bits in the first
    byte, the low two green bits and blue in the second.
    """
    r, g, b = rgb
    high = ((r & 0xF) << 2) | ((g & 0xF) >> 2)
    low = ((g & 0x3) << 4) | (b & 0xF)
    return bytes([high & 0x3F, low & 0x3F])


def load_clut(entries: Iterable[tuple[int, int, int]], *, high: bool = False) -> bytes:
    """Load eight palette entries -- indices 0-7, or 8-15 when `high` is set."""
    data = b"".join(clut_entry(c) for c in entries)
    return packet(CDG_LOAD_CLUT_HI if high else CDG_LOAD_CLUT_LO, data)


def memory_preset(color: int, repeat: int = 0) -> bytes:
    """Fill the whole screen with one palette index.

    `repeat` is the spec's redundancy counter: the same preset is sent several
    times so a player that dropped a packet still lands on a clean screen.
    """
    return packet(CDG_MEMORY_PRESET, bytes([color & 0x0F, repeat & 0x0F]))


def border_preset(color: int) -> bytes:
    """Fill the one-tile border ring with a palette index."""
    return packet(CDG_BORDER_PRESET, bytes([color & 0x0F]))


def tile_block(
    tile_row: int,
    tile_col: int,
    color0: int,
    color1: int,
    rows: Sequence[int],
    *,
    xor: bool = False,
) -> bytes:
    """Paint one 6x12 tile.

    `rows` is 12 packed bytes, one per pixel row, bit 5 = leftmost pixel. A set
    bit selects `color1`, a clear bit `color0`. With `xor` the two colours are
    XORed into the framebuffer instead of replacing it, which is how a
    highlight sweeps across existing glyphs without repainting them.
    """
    if len(rows) != TILE_H:
        # Short rows would pad with parity zeros and long rows would overrun
        # into them -- both mis-frame the packet silently, so refuse instead.
        raise ValueError(f"tile needs exactly {TILE_H} row bytes, got {len(rows)}")
    data = bytes([color0 & 0x0F, color1 & 0x0F, tile_row & 0x1F, tile_col & 0x3F])
    data += bytes(int(r) & 0x3F for r in rows)
    return packet(CDG_TILE_XOR if xor else CDG_TILE_NORMAL, data)


def pack_tile_rows(tile) -> list[int]:
    """Pack a (12, 6) 0/1 array into the 12 row bytes `tile_block` expects."""
    out = []
    for py in range(TILE_H):
        bits = 0
        for px in range(TILE_W):
            if tile[py][px]:
                bits |= 0x20 >> px
        out.append(bits)
    return out
