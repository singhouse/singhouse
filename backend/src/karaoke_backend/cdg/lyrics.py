# SPDX-License-Identifier: AGPL-3.0-only
"""Normalising a word-sync document into CD+G pages.

The encoder wants lines grouped into screenfuls with clean start/end times. A
word-sync doc may or may not carry explicit page structure, so this module
honours it when present and falls back to the same grouping heuristic the stage
player uses -- break on a long silence, or at `MAX_PAGE_LINES` -- so an export
pages the way the live show does.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

from .display import LineLayout
from .spec import MAX_PAGE_LINES, PAGE_BREAK_GAP
from .timeline import Page


def _line_span(words: list[dict]) -> tuple[float, float]:
    return min(w["start"] for w in words), max(w["end"] for w in words)


def _finite(value: Any) -> float | None:
    """The value as a float, or None if it is not a finite number.

    Infinities and NaN are the interesting case: both survive `float()`, then
    detonate much later -- NaN silently loses every comparison the scheduler
    makes, and an infinity overflows the packet-index arithmetic.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clean_words(raw: Any) -> list[dict]:
    """Keep words that have text and a usable numeric span, in document order."""
    words = []
    if not isinstance(raw, (list, tuple)):
        return words
    for w in raw:
        if not isinstance(w, dict):
            continue
        # `dict.get` falls back only on a *missing* key, so an explicit
        # {"word": null} must be caught here or it renders as "None".
        raw_text = w.get("word")
        if raw_text is None:
            raw_text = w.get("text")
        if raw_text is None:
            continue
        text = str(raw_text).strip()
        if not text:
            continue
        start = _finite(w.get("start"))
        end = _finite(w.get("end"))
        if start is None or end is None:
            continue
        # Tolerate inverted spans rather than dropping the word: a zero-length
        # wipe still highlights, a missing word leaves a hole in the line.
        if end < start:
            end = start
        words.append({"text": text, "start": start, "end": end})
    return words


def normalize_doc(word_sync: dict) -> tuple[list[list[dict] | None], list[dict]]:
    """Split a word-sync doc into `(lines, page_defs)`.

    `lines` stays index-aligned with the document's own lines -- `None` where a
    line has no usable words -- so explicit page references by line index
    remain valid. `page_defs` is a list of
    `{"line_idxs", "fade_in", "fade_out"}`.

    Every field is treated as untrusted: word-sync docs arrive from
    transcription, from imports, and from hand editing, and a malformed one
    should produce a thinner export rather than an exception.
    """
    if not isinstance(word_sync, dict):
        return [], []

    raw_lines = word_sync.get("lines")
    if not isinstance(raw_lines, (list, tuple)) or not raw_lines:
        segments = word_sync.get("segments")
        raw_lines = [
            seg.get("words")
            for seg in (segments if isinstance(segments, (list, tuple)) else [])
            if isinstance(seg, dict) and seg.get("words")
        ]

    lines: list[list[dict] | None] = []
    for raw in raw_lines:
        words = _clean_words(raw)
        lines.append(words or None)

    page_defs: list[dict] = []
    claimed: set[int] = set()

    pages = word_sync.get("pages")
    for page in pages if isinstance(pages, (list, tuple)) else []:
        if not isinstance(page, dict) or not isinstance(page.get("line_idx"), list):
            continue
        # A line may appear on exactly one page. Rendering it twice paints two
        # copies and wipes only whichever the lookup happens to find first, so
        # repeats -- within this page or already claimed by an earlier one --
        # are dropped here rather than surfacing as a half-highlighted screen.
        idxs = list(
            dict.fromkeys(
                i
                for i in page["line_idx"]
                if isinstance(i, int)
                and not isinstance(i, bool)
                and 0 <= i < len(lines)
                and lines[i]
                and i not in claimed
            )
        )
        if not idxs:
            continue
        claimed.update(idxs)

        fades = {}
        for key, field in (("fade_in", "fade_in_start"), ("fade_out", "fade_out_start")):
            fades[key] = _finite(page.get(field))

        # An authored page may hold more lines than a CD+G screen can show, so
        # oversized ones are chunked: the first chunk keeps the fade-in, the
        # last keeps the fade-out, and the middle inherits neither.
        chunks = [
            idxs[i : i + MAX_PAGE_LINES] for i in range(0, len(idxs), MAX_PAGE_LINES)
        ]
        for ci, chunk in enumerate(chunks):
            page_defs.append(
                {
                    "line_idxs": chunk,
                    "fade_in": fades["fade_in"] if ci == 0 else None,
                    "fade_out": fades["fade_out"] if ci == len(chunks) - 1 else None,
                }
            )

    # Everything the document did not claim gets the player's grouping.
    current: list[int] = []
    prev_end: float | None = None
    for i, words in enumerate(lines):
        if not words or i in claimed:
            continue
        start, end = _line_span(words)
        long_gap = prev_end is not None and start - prev_end > PAGE_BREAK_GAP
        if current and (len(current) >= MAX_PAGE_LINES or long_gap):
            page_defs.append({"line_idxs": current, "fade_in": None, "fade_out": None})
            current = []
        current.append(i)
        prev_end = end
    if current:
        page_defs.append({"line_idxs": current, "fade_in": None, "fade_out": None})

    return lines, page_defs


def build_pages(
    lines: list[list[dict] | None],
    page_defs: list[dict],
    render_line: Callable[[list[dict]], LineLayout],
) -> list[Page]:
    """Render each page definition into a `Page`, sorted by first word.

    `render_line` turns one line's words into a `LineLayout`. Passing it in is
    how a caller chooses a glyph rasteriser without this module depending on
    one; it need not set `line_idx`, which is stamped from the document here.
    """
    pages: list[Page] = []
    for definition in page_defs:
        layouts: list[LineLayout] = []
        # Deduped again for callers that build page defs themselves: a line
        # rendered twice on one page highlights only one of the two copies.
        for idx in dict.fromkeys(definition["line_idxs"]):
            words = lines[idx]
            if not words:
                continue
            layout = render_line(words)
            layouts.append(layout._replace(line_idx=idx))
        if not layouts:
            continue
        spans = [_line_span(lines[layout.line_idx]) for layout in layouts]
        pages.append(
            Page(
                layouts=layouts,
                first=min(s[0] for s in spans),
                last=max(s[1] for s in spans),
                fade_in=definition.get("fade_in"),
                fade_out=definition.get("fade_out"),
            )
        )
    pages.sort(key=lambda p: p.first)
    return pages
