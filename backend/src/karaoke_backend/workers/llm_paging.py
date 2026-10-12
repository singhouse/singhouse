# SPDX-License-Identifier: AGPL-3.0-only
"""LLM-assisted page structuring for word-sync output.

Takes aligned word timings + plain reference lyrics and asks an
OpenAI-compatible LLM to group lines into display pages (with section
markers). Then applies the paged fade recipe (pre-roll, hold, uniform
fades) to produce a v2 word_sync payload with ``pages`` and ``lead_ins``.

Every failure degrades gracefully: if the LLM is unreachable or returns
garbage, the original word_sync is returned unchanged (no pages).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

from karaoke_backend.workers.llm_client import (
    PagingUnavailable, OpenAIChatClient, _read_api_key, paging_configured,
)

logger = logging.getLogger(__name__)

# Metadata key recording what paging did to a word_sync payload. Written on
# every :func:`page_word_sync` call, because "the LLM was asked and declined"
# and "nobody asked" are different facts and only one of them is worth a
# retry. The standalone re-page job reads it to refuse persisting a duplicate
# set, and the set list can label a run that came back empty.
PAGING_STATUS_KEY = "llm_paging"
PAGING_APPLIED = "applied"
PAGING_UNAVAILABLE = "unavailable"

PRE_ROLL = 1.2
HOLD = 1.3
FADE_DUR = 0.6
LEAD_IN_MIN_GAP = 1.5

# A silence at least this long between two sung lines is an instrumental break
# and must never sit inside a page: the page would hold its text, motionless,
# for the whole gap, and the stage only draws a countdown bar for a gap BETWEEN
# pages. Keep in step with `INSTRUMENTAL_GAP_SEC` in frontend/src/stage/adapter.mjs.
INSTRUMENTAL_GAP_SEC = 5.0

# Separates a prompt row's annotation from the lyric text after it. Something no
# lyric contains, so "the text after the fence" stays unambiguous however the
# words themselves are punctuated.
ANNOTATION_FENCE = "|>"

# The pager runs with or without timing annotation on its input rows, and the
# instrumental rule is the only part that differs — so the body is written once
# and the rule spliced in. (Concatenation, not str.format: the tail contains
# literal JSON braces.)
_SYSTEM_HEAD = """\
You are a karaoke display pager. Given song lyrics (one line per row),
group them into display pages for a karaoke screen.

Rules:
- Each page has 1-4 short display lines.
- Aim for 4-8 words per display line. A singer should be able to
  read each line in one glance.
- SPLIT long input lines at natural clause / comma / phrase boundaries
  into multiple display lines. For example:
    "Lanterns glow beyond the hill, quiet footsteps cross the sill"
  becomes TWO display lines:
    "Lanterns glow beyond the hill"
    "quiet footsteps cross the sill"
- Never split mid-phrase (e.g. don't separate an adjective from its
  noun, or a preposition from its object).
- Mark new_section=true on the first page of each structural section
  (verse, chorus, bridge, outro, etc.). The very first page is always
  new_section=true.
- Choruses that repeat should use the same page shape each time.
"""

# Un-annotated input: the model has only the words, so this is the most that
# can be asked. It cannot actually detect a break — the deterministic split in
# `apply_pages_to_word_sync` is what guarantees the outcome.
_RULE_PLAIN = """\
- Instrumental breaks / long gaps between sections → new page with
  new_section=true for the next sung line."""

# Annotated input. Measured 2026-09-06 against the configured provider on a song
# with two long instrumentals: un-annotated missed both breaks on every run;
# annotated honored both on every run. The "never copy the annotation" rules
# are load-bearing — a marker echoed into an output line fails `_validate_pages`
# and costs the song its pages entirely.
_RULE_TIMED = """\
- Each input row is: annotation, then "|>", then the lyric text. Everything
  before the "|>" is ANNOTATION — the line number, the [time it is sung], and
  any break marker. NEVER copy the annotation or the "|>" into an output line;
  output only the lyric text that follows it, exactly as written.
- Annotation "Ns-INSTRUMENTAL-BREAK-AFTER-THIS-LINE" means a long instrumental
  follows that row. That line MUST be the last line of its page, and the next
  line MUST start a new page with new_section=true."""

_SYSTEM_TAIL = """

Output strict JSON: {"pages": [{"lines": ["line text", ...], "new_section": bool}]}
All words from the input must appear exactly once, in order, across all
pages. You may split input lines but must not reorder, add, or drop words.
No commentary outside the JSON."""

_SYSTEM_PROMPT = _SYSTEM_HEAD + _RULE_PLAIN + _SYSTEM_TAIL
_TIMED_SYSTEM_PROMPT = _SYSTEM_HEAD + _RULE_TIMED + _SYSTEM_TAIL


def _span(line: list[dict]) -> Optional[tuple[float, float]]:
    """(first start, last end) of an aligned line, or None if it has no times."""
    starts = [w["start"] for w in line if isinstance(w.get("start"), (int, float))]
    ends = [w["end"] for w in line if isinstance(w.get("end"), (int, float))]
    return (min(starts), max(ends)) if starts and ends else None


def _line_spans(lines: list[str], flat: list[dict]) -> Optional[list[tuple[float, float]]]:
    """Time each prompt line by walking the aligned word stream alongside it.

    The two streams are token-for-token parallel — that is the same invariant
    `apply_pages_to_word_sync` already relies on to map words onto pages — so a
    line's words are simply the next ``len(line.split())`` aligned words.

    Returns None when that correspondence does not hold, in which case the
    caller falls back to an un-annotated prompt. A prompt built from mismatched
    streams would carry wrong times, which is worse than carrying none.
    """
    if sum(len(l.split()) for l in lines) != len(flat):
        return None
    spans, wi = [], 0
    for l in lines:
        n = len(l.split())
        span = _span(flat[wi:wi + n])
        if span is None:
            return None
        spans.append(span)
        wi += n
    return spans


def _mmss(t: float) -> str:
    # Round BEFORE splitting, or 59.97 formats as the nonexistent "0:60.0" —
    # in the one field the annotated prompt exists to make trustworthy.
    m, sec = divmod(round(t, 1), 60)
    return f"{int(m)}:{sec:04.1f}"


def _build_user_prompt(
    plain_lyrics: str,
    spans: Optional[list[tuple[float, float]]] = None,
) -> str:
    """Numbered lyric rows, annotated with sung times when they are known.

    Without ``spans`` this is a bare numbered list — all the model has ever had
    — and it cannot see an instrumental break at all. With them each row also
    carries when it is sung, and a row followed by a long silence is marked, so
    the break is a visible instruction rather than something to infer.
    """
    lines = [l.strip() for l in plain_lyrics.strip().splitlines() if l.strip()]
    rows = []
    for i, l in enumerate(lines):
        if spans is None:
            rows.append(f"{i+1}. {l}")
            continue
        # The marker rides on the line BEFORE the gap. Tried as a row of its own
        # first: the model read it as replacing that line and dropped the line's
        # words, which fails `_validate_pages` and loses the song its pages.
        # Everything up to the fence is annotation; everything after it is the
        # lyric, VERBATIM. `_validate_pages` compares the model's words against
        # the raw text, so rewriting the lyric to dodge a collision would fail
        # the very check the rewrite was meant to protect.
        gap = spans[i + 1][0] - spans[i][1] if i + 1 < len(lines) else 0.0
        mark = (
            f" {gap:.0f}s-INSTRUMENTAL-BREAK-AFTER-THIS-LINE"
            if gap >= INSTRUMENTAL_GAP_SEC
            else ""
        )
        rows.append(f"{i+1}. [{_mmss(spans[i][0])}]{mark} {ANNOTATION_FENCE} {l}")
    return (
        f"Group these {len(lines)} lyric lines into karaoke display pages:\n\n"
        + "\n".join(rows)
    )


def _words(text: str) -> list[str]:
    return [w.strip(".,;:!?\"'()-") for w in text.lower().split()]


def _validate_pages(data: dict, expected_lines: list[str]) -> Optional[list[dict]]:
    pages = data.get("pages")
    if not isinstance(pages, list) or not pages:
        return None
    collected_words: list[str] = []
    for p in pages:
        if not isinstance(p, dict):
            return None
        lines = p.get("lines")
        if not isinstance(lines, list) or not lines:
            return None
        for l in lines:
            if not isinstance(l, str):
                return None
            collected_words.extend(_words(l))
        if not isinstance(p.get("new_section", False), bool):
            p["new_section"] = bool(p.get("new_section"))
    expected_words: list[str] = []
    for l in expected_lines:
        expected_words.extend(_words(l))
    if collected_words != expected_words:
        return None
    return pages


def structure_pages(
    client: OpenAIChatClient,
    plain_lyrics: str,
    flat: Optional[list[dict]] = None,
) -> Optional[list[dict]]:
    """Call the LLM to group lyrics into pages. Returns None on any failure.

    ``flat`` is the aligned word stream the lyrics will be mapped onto. Given
    it, the prompt carries sung times and marks instrumental breaks; without
    it (or if it does not correspond to the text) the prompt degrades to the
    bare numbered list.
    """
    expected = [l.strip() for l in plain_lyrics.strip().splitlines() if l.strip()]
    if not expected:
        return None

    spans = _line_spans(expected, flat) if flat else None
    system_prompt = _TIMED_SYSTEM_PROMPT if spans else _SYSTEM_PROMPT
    user_prompt = _build_user_prompt(plain_lyrics, spans)

    for attempt in range(2):
        try:
            raw = client.complete_json(system_prompt, user_prompt)
            data = json.loads(raw)
        except (PagingUnavailable, json.JSONDecodeError) as e:
            if attempt == 0:
                user_prompt += (
                    f"\n\nYour previous reply was invalid ({e}). "
                    "Reply with ONLY the JSON object."
                )
                continue
            logger.info("LLM paging unavailable after retry: %s", e)
            return None

        pages = _validate_pages(data, expected)
        if pages is not None:
            return pages

        if attempt == 0:
            user_prompt += (
                "\n\nYour previous reply did not preserve every word exactly "
                "once in order. Fix it. Reply with ONLY the JSON object."
            )
            continue

    logger.info("LLM paging: validation failed after retry")
    return None


def _split_words_at_breaks(words: list[dict]) -> list[list[dict]]:
    """Split one display line wherever a long silence falls between its words.

    The pager groups lyric TEXT, so a break can land not just between two of
    its lines but between two words of one line — "I'm one of those <50s of
    banjo> It's hard for folks to see" is a single line to it. Cutting the
    word slice here turns every such break into a boundary BETWEEN lines,
    which is the only shape `_split_pages_at_breaks` (and the stage) can see.
    """
    pieces: list[list[dict]] = [[]]
    for word in words:
        previous = pieces[-1][-1] if pieces[-1] else None
        if previous is not None:
            end, start = previous.get("end"), word.get("start")
            if (
                isinstance(end, (int, float))
                and isinstance(start, (int, float))
                and start - end >= INSTRUMENTAL_GAP_SEC
            ):
                pieces.append([])
        pieces[-1].append(word)
    return [p for p in pieces if p]


def _page_span(
    lines_v2: list[list[dict]], line_idx: list[int]
) -> Optional[tuple[float, float]]:
    """(first sung, last sung) across a page, ignoring any untimed line."""
    spans = [s for s in (_span(lines_v2[i]) for i in line_idx) if s]
    return (min(s[0] for s in spans), max(s[1] for s in spans)) if spans else None


def _split_pages_at_breaks(
    lines_v2: list[list[dict]],
    pages_v2: list[dict],
) -> list[dict]:
    """Split any page whose lines straddle an instrumental break.

    The pager works from text, so a page can span a silence it had no way to
    see — and that page then holds its words, motionless, for the length of the
    gap, with no countdown bar, because the stage only draws one for a gap
    BETWEEN pages. This is the guarantee that the prompt annotation cannot be:
    it holds when no LLM is configured, when the endpoint is unreachable, and
    when the model simply ignores the marker.

    Splitting is right even when a long silence is an alignment failure rather
    than an instrumental — a page should not be held for it either way.
    """
    out: list[dict] = []
    for page in pages_v2:
        idx = page["line_idx"]
        groups: list[list[int]] = [[idx[0]]]
        for prev_i, next_i in zip(idx, idx[1:]):
            prev_span, next_span = _span(lines_v2[prev_i]), _span(lines_v2[next_i])
            gap = (
                next_span[0] - prev_span[1]
                if prev_span and next_span
                else 0.0  # untimed line: no evidence of a break, so don't split
            )
            if gap >= INSTRUMENTAL_GAP_SEC:
                groups.append([next_i])
            else:
                groups[-1].append(next_i)
        if len(groups) > 1:
            logger.info(
                "LLM paging: split a page across %d instrumental break(s)",
                len(groups) - 1,
            )
        for g_i, group in enumerate(groups):
            # Only the first piece keeps what the pager said about the page it
            # came from; a piece that starts after an instrumental is a new
            # section by construction. NB `new_section` is threaded this far and
            # then dropped (`del` below) — nothing reads it today. Kept faithful
            # so it means the right thing if a consumer ever appears.
            out.append({
                "line_idx": group,
                "new_section": page["new_section"] if g_i == 0 else True,
            })
    return out


def apply_pages_to_word_sync(
    word_data: dict,
    pages: list[dict],
) -> dict:
    """Regroup aligned word timings into the LLM-authored page structure.

    Mutates and returns ``word_data`` with added ``pages`` and ``lead_ins``
    keys plus updated metadata.
    """
    flat = [w for line in word_data["lines"] for w in line]

    lines_v2: list[list[dict]] = []
    pages_v2: list[dict] = []
    wi = 0
    for p in pages:
        line_idx: list[int] = []
        for l in p["lines"]:
            n = len(l.split())
            if wi + n > len(flat):
                logger.warning("LLM paging: token overrun — aborting page apply")
                return word_data
            for piece in _split_words_at_breaks(flat[wi:wi + n]):
                lines_v2.append(piece)
                line_idx.append(len(lines_v2) - 1)
            wi += n
        if not line_idx:
            continue  # a whitespace-only line carries no words to page
        pages_v2.append({"line_idx": line_idx, "new_section": p["new_section"]})

    if wi != len(flat):
        logger.warning(
            "LLM paging: token count mismatch (%d vs %d) — aborting",
            wi, len(flat),
        )
        return word_data

    pages_v2 = _split_pages_at_breaks(lines_v2, pages_v2)

    if not pages_v2:
        logger.warning("LLM paging: no page survived mapping — aborting")
        return word_data

    # Via `_page_span`, not raw `[0]["start"]`: a partially-timed line can now
    # lead a page (the split puts it there), and indexing blind would raise.
    sing = [_page_span(lines_v2, p["line_idx"]) for p in pages_v2]
    if any(s is None for s in sing):
        logger.warning("LLM paging: a page has no timed word — aborting")
        return word_data
    lead_ins: list[dict] = []
    for i, p in enumerate(pages_v2):
        s, e = sing[i]
        fin = max(0.0, s - PRE_ROLL)
        if i >= 2:
            fin = max(fin, pages_v2[i - 2]["fade_out_start"]
                      + pages_v2[i - 2]["fade_out_dur"])
        p["fade_in_start"] = round(fin, 3)
        p["fade_in_dur"] = FADE_DUR
        p["fade_out_start"] = round(e + HOLD, 3)
        p["fade_out_dur"] = FADE_DUR
        gap_in = s - sing[i - 1][1] if i else float("inf")
        if gap_in >= LEAD_IN_MIN_GAP:
            lead_ins.append({"line_idx": p["line_idx"][0], "start": p["fade_in_start"]})
        del p["new_section"]

    word_data["lines"] = lines_v2
    word_data["pages"] = pages_v2
    word_data["lead_ins"] = lead_ins
    meta = word_data.setdefault("metadata", {})
    meta["pages_source"] = "llm"
    meta["page_recipe"] = {"pre_roll": PRE_ROLL, "hold": HOLD, "fade": FADE_DUR}
    meta.setdefault("format_version", 2)
    return word_data


def paging_text_from_word_sync(word_data: dict) -> str:
    """The transcription's own lines as paging input, one line per row.

    The reference lyrics are the better input and are used whenever a set has
    them. This is the fallback for the far more common case — an unanchored
    transcription, which has no reference at all — and it is what makes paging
    re-runnable on a song that was ingested without it.
    """
    return "\n".join(
        " ".join(w["text"] for w in line) for line in word_data.get("lines", [])
    )


async def page_word_sync(word_data: dict, paging_text: str) -> dict:
    """Ask the operator's LLM to page ``word_data``, degrading to unchanged.

    Factored out of the ingest orchestrator so the re-transcribe, re-align and
    standalone re-page jobs run the SAME paging the upload path runs — the
    three ways to redo a song's lyrics all used to lose its pages.

    Every failure is swallowed and logged: no endpoint, an unreachable one, a
    reply that does not preserve the words. What comes back is then the input
    payload, flagged ``unavailable`` — a song with un-paged lyrics is a
    working song, and refusing one over a page grouping would be worse than
    the missing pages.
    """
    status = PAGING_UNAVAILABLE
    try:
        if not paging_configured():
            raise PagingUnavailable("No usable paging endpoint is configured")
        client = OpenAIChatClient(
            base_url=os.environ.get("KARAOKE_LLM_BASE_URL", "").strip(),
            model=os.environ.get("KARAOKE_LLM_MODEL", "local"),
            api_key=_read_api_key(),
            timeout=float(os.environ.get("KARAOKE_LLM_TIMEOUT", "600")),
        )
        # Blocking HTTP against a local LLM. On the event loop it would stall
        # every heartbeat in the process and cost the calling job its lease
        # for no reason.
        # The aligned words the pages will be mapped onto are also what lets
        # the prompt state when each line is sung, and where the instrumentals
        # are. Same stream, read twice.
        flat = [w for line in word_data.get("lines", []) for w in line]
        pages = await asyncio.to_thread(
            structure_pages, client, paging_text, flat
        )
        if pages:
            # `apply_pages_to_word_sync` mutates and returns its input, so the
            # returned object is never evidence on its own — and neither is
            # the `pages_source` it writes, because a payload being RE-paged
            # already carries that from last time. The `pages` list is: it is
            # replaced with a fresh object only on the completing path, and a
            # token mismatch returns before any assignment.
            pages_before = word_data.get("pages")
            paged = apply_pages_to_word_sync(word_data, pages)
            if paged.get("pages") is not pages_before:
                word_data = paged
                status = PAGING_APPLIED
    except Exception as exc:  # noqa: BLE001 — see the docstring
        logger.info("LLM paging skipped: %s", exc)

    word_data.setdefault("metadata", {})[PAGING_STATUS_KEY] = status
    return word_data
