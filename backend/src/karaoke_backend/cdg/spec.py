# SPDX-License-Identifier: AGPL-3.0-only
"""CD+G format constants.

CD+G is the Red Book graphics extension: a constant-rate stream of 24-byte
subcode packets -- 4 packets per CD sector x 75 sectors/s = 300 packets/s --
that paint a 300x216, 16-colour indexed screen in 6x12-pixel tiles.

Reference: Jim Bumgardner, "CD+G Revealed" (https://jbum.com/cdg_revealed.html).
The format is a published, decades-old CD specification; this is an independent
implementation from that public description.
"""

from __future__ import annotations

# --- stream geometry --------------------------------------------------------

PACKET_BYTES = 24
PACKETS_PER_SEC = 300  # 4 packets/sector * 75 sectors/s
NOOP_PACKET = b"\x00" * PACKET_BYTES

SCREEN_W = 300
SCREEN_H = 216
TILE_W = 6
TILE_H = 12

TILE_COLS = SCREEN_W // TILE_W  # 50
TILE_ROWS = SCREEN_H // TILE_H  # 18

# --- subcode instructions ---------------------------------------------------

SC_CDG_COMMAND = 0x09

CDG_MEMORY_PRESET = 1
CDG_BORDER_PRESET = 2
CDG_TILE_NORMAL = 6
CDG_SCROLL_PRESET = 20
CDG_SCROLL_COPY = 24
CDG_DEFINE_TRANSPARENT = 28
CDG_LOAD_CLUT_LO = 30
CDG_LOAD_CLUT_HI = 31
CDG_TILE_XOR = 38

# --- palette ----------------------------------------------------------------
#
# Only indices 0-3 carry meaning in the lyric renderer; the rest stay black.
# Entries are 4-bit-per-channel RGB, which is what the CLUT instructions carry.

BG = 0
BORDER = 1
TEXT = 2  # unsung lyrics
HILITE = 3  # sung lyrics

#: XOR operand that recolours a TEXT pixel to HILITE and leaves BG untouched.
XOR_INK = TEXT ^ HILITE

DEFAULT_PALETTE: dict[int, tuple[int, int, int]] = {
    BG: (0, 0, 7),  # dark blue
    BORDER: (0, 0, 0),  # black
    TEXT: (15, 15, 15),  # white
    HILITE: (15, 13, 0),  # amber
}

# --- text region (tile-aligned) ---------------------------------------------
#
# The outermost tile row/column on each edge is border, per the CD+G convention
# that players may overscan it.

REGION_COL0 = 2  # left tile column of the text region (x = 12px)
REGION_COLS = 46  # text region width in tiles (276px, x 12..288)
REGION_W = REGION_COLS * TILE_W

LINE_TILE_H = 3  # each display line is 3 tile rows tall (36px)
LINE_H = LINE_TILE_H * TILE_H
TEXT_ROW0 = 1  # first non-border tile row
TEXT_ROWS = 16  # tile rows available for text (rows 1..16)

#: Lines that fit on one screen: 16 tile rows / 3 per line.
MAX_SCREEN_LINES = TEXT_ROWS // LINE_TILE_H

# --- paging -----------------------------------------------------------------
#
# These mirror the stage player's grouping so an exported .cdg pages the same
# way the on-screen show does.

MAX_PAGE_LINES = 4  # lines per synthesized page
PAGE_BREAK_GAP = 3.0  # silence longer than this between lines starts a page
PAGE_LEAD = 2.0  # a page is shown at least this early, before its first word
PAGE_HOLD = 1.0  # a page lingers this long after its last word

#: Slack left between the end of a page's paint burst and its first word.
#:
#: A page swap emits one packet per glyph tile, and the stream is constant-rate,
#: so a dense page takes real time to draw: a full-width four-line page is ~555
#: packets, or 1.85s -- comfortably past `PAGE_LEAD`. Any wipe scheduled while
#: the burst is still emitting gets displaced behind it, which reads as the
#: highlight lagging the singer. So the lead is the larger of `PAGE_LEAD` and
#: the page's own measured paint cost plus this margin.
PAGE_PAINT_MARGIN = 0.25

# --- attribution card -------------------------------------------------------
#
# An export opens on a card naming the tool that made it. The card is only ever
# shown in the silence a song already has before its first word: it costs real
# packets to paint, and a lyric that arrives late because of branding is a bug,
# not a trade-off. Hence a hold that is clamped by what is available, and a
# floor below which the card is skipped outright rather than flashed.

CARD_MAX_HOLD = 5.0

#: Below this a card is not shown at all. A card that appears and vanishes
#: inside a second reads as a glitch and is unreadable besides, so a song with
#: a short intro simply gets no card.
CARD_MIN_HOLD = 1.5

# --- limits -----------------------------------------------------------------

#: Most packets a decoder instance will accept from one CD+G stream.
#:
#: Decode cost is driven by packet count, and a hostile stream can make every
#: packet an expensive tile write rather than the no-op-heavy mix a normal
#: disc carries. Thirty minutes is well beyond a single karaoke song while
#: putting a deterministic ceiling on that CPU work and on the whole-packet
#: portion of a stream (12,960,000 bytes at 24 bytes/packet). The decoder's
#: longstanding behavior is to ignore a trailing partial packet.
#: This is deliberately tighter than ``MAX_STREAM_SECONDS``: the encoder's
#: four-hour ceiling also accommodates generated artifacts, while the decoder
#: is about to receive files supplied by a caller.
MAX_DECODE_SECONDS = 30 * 60
MAX_DECODE_PACKETS = MAX_DECODE_SECONDS * PACKETS_PER_SEC

#: Longest stream this encoder will produce, in seconds.
#:
#: The stream is fixed-rate, so output size is a pure function of duration
#: (300 packets/s * 24 bytes = 7.2 KB/s); an unchecked duration is an
#: unbounded allocation. Four hours is far past any single song while still
#: capping the buffer near 100 MB.
MAX_STREAM_SECONDS = 4 * 3600
