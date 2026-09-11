# SPDX-License-Identifier: AGPL-3.0-only
"""Turning timed pages into a constant-rate CD+G stream.

Two steps. `build_timeline` decides *when* things happen -- page shows, word
wipes, screen blanks -- and `serialize` runs those events through a `Display`
and lays the resulting packets onto the format's fixed 300-packets-per-second
grid, padding the gaps with no-ops.

The grid is why the two steps are separate: packets cannot overlap in time, so
a burst (a page swap is three packets plus one per glyph tile) pushes later
packets forward. `serialize` tracks that cursor, which means an event's
*requested* time is a floor, not a guarantee.
"""

from __future__ import annotations

import math
from typing import NamedTuple

from .card import plan_hold
from .card_source import Card, attribution_card
from .display import Display, LineLayout, show_cost
from .spec import (
    DEFAULT_PALETTE,
    MAX_STREAM_SECONDS,
    NOOP_PACKET,
    PACKETS_PER_SEC,
    PAGE_HOLD,
    PAGE_LEAD,
    PAGE_PAINT_MARGIN,
    TILE_W,
)

# Event priorities, applied as a tiebreak when several land on the same
# timestamp: a blank must precede the show that replaces it, and a show must
# precede any wipe against it.
_PRIO_INIT = 0
_PRIO_CARD = 1
_PRIO_BLANK = 2
_PRIO_SHOW = 3
_PRIO_WIPE = 4

#: Minimum gap between a page's blank and the next page's show. Below this the
#: screen would flicker rather than read as an instrumental break.
_MIN_BLANK_GAP = 0.75

#: A page never turns less than this after the previous page's last word, nor
#: less than this after the previous page appeared.
_MIN_TURN_AFTER_LAST_WORD = 0.05
_MIN_TURN_BETWEEN_SHOWS = 0.5

#: A page always holds at least this long past its final word before blanking.
_MIN_HOLD = 0.25


class Page(NamedTuple):
    """A screenful of lines and the times that bracket it."""

    layouts: list[LineLayout]
    first: float  # start of the page's first word
    last: float  # end of the page's last word
    fade_in: float | None  # authored show time, if the doc specified one
    fade_out: float | None  # authored blank time, if the doc specified one


class Event(NamedTuple):
    time: float
    priority: int
    kind: str  # "init" | "show" | "wipe" | "blank"
    payload: object


def _resolve_card(card: Card | bool) -> Card | None:
    """True means the attribution card; a `Card` is itself; False/None, none."""
    return attribution_card() if card is True else (card or None)


def build_timeline(
    pages: list[Page], *, card: Card | bool = False
) -> tuple[list[Event], list[float]]:
    """Schedule show/wipe/blank events for `pages`, ordered by first word.

    A page appears at its authored fade-in, or a lead before its first word --
    but never while the previous page is still being sung, which is the
    constraint that keeps a fast song from swapping the screen out from under a
    singer. The screen blanks at a page's fade-out when the next page is not
    due soon, so instrumental breaks go dark instead of holding stale lyrics.

    The lead is `PAGE_LEAD` or the page's own paint burst plus
    `PAGE_PAINT_MARGIN`, whichever is longer, so a dense page finishes drawing
    before its first word instead of displacing the opening wipes. An authored
    fade-in is honoured only up to that same deadline: a late one starves the
    wipe, and a lagging highlight is worse than an early appearance.

    With `card`, a card opens the stream -- the attribution card for `True`, or
    a caller-supplied `Card` -- but only into whatever silence the first page
    leaves, and only if that is long enough to read. It is scheduled last,
    against show times that are already decided, so it can never displace a
    lyric.

    `card` defaults OFF here and ON in `build_stream`. The card draws in palette
    entries the lyric renderer does not own, and only `build_stream` loads them:
    a caller driving this two-step path by hand with a bare `Display` would
    otherwise paint the card into an unloaded CLUT and get a black smear.
    """
    show_times: list[float] = []
    for i, page in enumerate(pages):
        # NaN loses every comparison below silently and would scramble the
        # event sort; an infinity overflows the packet-index arithmetic in
        # `serialize`. Both are worth naming here rather than downstream.
        for field in ("first", "last", "fade_in", "fade_out"):
            value = getattr(page, field)
            if value is not None and not math.isfinite(value):
                raise ValueError(f"page {i}: {field} is {value!r}")

        paint = show_cost(page.layouts) / PACKETS_PER_SEC + PAGE_PAINT_MARGIN
        deadline = page.first - max(PAGE_LEAD, paint)
        when = page.fade_in if page.fade_in is not None else deadline
        when = max(min(when, deadline), 0.0)
        if i > 0:
            when = max(
                when,
                pages[i - 1].last + _MIN_TURN_AFTER_LAST_WORD,
                show_times[-1] + _MIN_TURN_BETWEEN_SHOWS,
            )
        show_times.append(when)

    events: list[Event] = [Event(0.0, _PRIO_INIT, "init", None)]

    for i, page in enumerate(pages):
        events.append(Event(show_times[i], _PRIO_SHOW, "show", i))

        for layout in page.layouts:
            for rect in layout.rects:
                width = rect.x1 - rect.x0
                # Subdivide the word into roughly tile-wide steps so the
                # highlight sweeps across it instead of snapping on at the end.
                steps = max(1, math.ceil(width / TILE_W))
                duration = max(0.0, rect.word["end"] - rect.word["start"])
                for k in range(steps):
                    xa = rect.x0 + round(k * width / steps)
                    xb = rect.x0 + round((k + 1) * width / steps)
                    when = rect.word["start"] + (k + 1) / steps * duration
                    events.append(
                        Event(when, _PRIO_WIPE, "wipe", (layout.line_idx, xa, xb))
                    )

        off = page.fade_out if page.fade_out is not None else page.last + PAGE_HOLD
        off = max(off, page.last + _MIN_HOLD)
        next_show = show_times[i + 1] if i + 1 < len(pages) else None
        if next_show is None or next_show - off > _MIN_BLANK_GAP:
            events.append(Event(off, _PRIO_BLANK, "blank", None))

    card_obj = _resolve_card(card)
    if card_obj is not None:
        hold = plan_hold(card_obj.cost(), show_times[0] if show_times else None)
        if hold is not None:
            events.append(Event(0.0, _PRIO_CARD, "card", card_obj))
            events.append(
                Event(
                    card_obj.cost() / PACKETS_PER_SEC + hold,
                    _PRIO_BLANK,
                    "blank",
                    None,
                )
            )

    events.sort(key=lambda e: (e.time, e.priority))
    return events, show_times


def serialize(
    events: list[Event],
    display: Display,
    pages: list[Page],
    duration: float,
) -> bytes:
    """Run `events` through `display` and lay the packets onto the time grid.

    Packets are placed at their event's packet index, or at the cursor if an
    earlier burst has not finished emitting -- the stream is constant-rate, so
    a busy moment displaces later packets rather than dropping them.

    Raises `ValueError` for a duration that is not a finite, non-negative
    number of seconds within `MAX_STREAM_SECONDS`. Output size is a pure
    function of duration here, so an unchecked one is an unbounded allocation.
    """
    if not math.isfinite(duration) or not 0 <= duration <= MAX_STREAM_SECONDS:
        raise ValueError(
            f"duration must be 0..{MAX_STREAM_SECONDS}s, got {duration!r}"
        )
    # Nothing may be *scheduled* past the end of the audio plus its one-second
    # tail: a word timed years out otherwise sizes the grid from its own packet
    # index instead of from the duration the caller declared.
    limit = int(duration * PACKETS_PER_SEC) + PACKETS_PER_SEC

    grid: dict[int, bytes] = {}
    cursor = 0

    for event in events:
        if event.kind == "init":
            pkts = display.init_packets()
        elif event.kind == "show":
            page = pages[event.payload]
            pkts = display.show_page(page.layouts)
            # The page may be showing late; anything already sung is filled in
            # at once so the wipe resumes mid-line rather than restarting.
            pkts += display.backfill_sung(event.time)
        elif event.kind == "wipe":
            line_idx, xa, xb = event.payload
            pkts = display.wipe_word(line_idx, xa, xb)
        elif event.kind == "card":
            pkts = display.show_bitmap(event.payload.pixels)
        elif event.kind == "blank":
            pkts = display.blank()
        else:
            pkts = []

        start = min(max(int(event.time * PACKETS_PER_SEC), cursor), limit)
        for offset, pkt in enumerate(pkts):
            grid[start + offset] = pkt
        cursor = start + len(pkts)

    # Run a second past the audio so a player does not end on a half-drawn
    # screen if its clock leads ours slightly. A burst that began inside the
    # window is allowed to finish, which is the only way past `limit`.
    total = max(cursor, limit)
    out = bytearray()
    for i in range(total):
        out += grid.get(i, NOOP_PACKET)
    return bytes(out)


def build_stream(
    pages: list[Page],
    duration: float,
    palette: dict[int, tuple[int, int, int]] | None = None,
    *,
    card: Card | bool = True,
) -> bytes:
    """Encode timed pages into a complete .cdg stream.

    The attribution card is on by default: it is what an export owes the tool
    that made it, and it costs nothing in wall-clock terms because it only ever
    occupies silence the song already had. A `Card` supplies replacement art
    under the same scheduling rules. `card=False` serves tests, callers
    assembling a fragment, and the export service's plain attribution-card
    setting (default on, freely switchable).

    The card's ink is folded into the palette only when a card is actually
    drawn -- the card's own entries win at colliding indices, since the card
    cannot render in colours it was not drawn for. `card=False` has to leave a
    caller's palette exactly as passed, including at the indices a card would
    otherwise claim.
    """
    events, _ = build_timeline(pages, card=card)
    card_obj = _resolve_card(card)
    if card_obj is not None:
        merged = dict(DEFAULT_PALETTE if palette is None else palette)
        merged.update(card_obj.palette)
        display = Display(palette=merged)
    else:
        display = Display(palette=palette)
    return serialize(events, display, pages, duration)
