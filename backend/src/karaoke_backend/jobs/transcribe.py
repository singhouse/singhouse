# SPDX-License-Identifier: AGPL-3.0-only
"""Re-transcribe, re-align and re-page orchestrators, out of ``api/lyrics_sets``.

All three are single-phase: there is no artifact to checkpoint between
"started" and "produced a lyrics set", so a requeue simply runs them again.
That is cheap for realign, which aligns off the cached transcription, and
cheaper still for re-page, which touches neither GPU nor aligner — but NOT for
re-transcribe: it forces past that cache by design, so every attempt burns a
full GPU transcription. None of them
touches ``Song.status`` — a re-transcription of a song that is already `ready`
must not knock it out of the library if it fails, and that is the pre-queue
semantic these preserve.

All three can run the same optional LLM stages as the upload path. This keeps
correction and paging as explicit choices when a song's lyrics are redone.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from sqlalchemy import update

from karaoke_backend.jobs import queue
from karaoke_backend.jobs._llm import make_correction_progress_callback
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost
from karaoke_backend.models.song import JobPhase, LyricsSet, LyricsSource, Song
from karaoke_backend.workers.llm_paging import (
    PAGING_APPLIED,
    PAGING_STATUS_KEY,
    page_word_sync,
    paging_text_from_word_sync,
)
from karaoke_backend.workers.word_sync_worker import (
    describe_run,
    generate_word_sync,
    make_correction_config,
    realign_only,
)

logger = logging.getLogger(__name__)

_CACHE_GUARD_TIMEOUT_SECONDS = 5.0

# What a re-paged set's label ends in, and what one already so labelled is
# recognized by.
PAGED_SUFFIX = "-paged"


def _label_for_set(
    base_label: str, ref_mode: str, *, realigned: bool, rescue: bool = False
) -> str:
    suffix_parts = []
    # Unanchored is the unlabeled baseline (matches the ingest path, which
    # only suffixes when a reference was actually used); anchored modes are
    # the ones that carry a suffix.
    if ref_mode != "none":
        suffix_parts.append(ref_mode)
    if realigned:
        suffix_parts.append("realigned")
    # A rescue run decoded with the temperature ladder armed, so it is not
    # reproducible the way an ingest-produced set is. Say so in the label —
    # otherwise the two are indistinguishable in the set picker.
    if rescue:
        suffix_parts.append("rescue")
    if not suffix_parts:
        return base_label
    return f"{base_label}-" + "-".join(suffix_parts)


def _pipeline_config(payload: dict):
    """Rebuild the frozen lyricsync config from the payload's plain dict."""
    from karaoke_backend.api.lyrics_sets import PipelineConfigIn, _to_pipeline_config

    raw = payload.get("pipeline_config")
    return _to_pipeline_config(PipelineConfigIn(**raw) if raw else None)


async def _announce(
    ctx: JobContext, *, phase: str, progress: int, message: str
) -> None:
    """Publish progress, and treat a refused write as a lost claim."""
    if not await queue.update_progress(
        ctx.job_id, ctx.worker_id, phase=phase, progress=progress, message=message
    ):
        raise LeaseLost(ctx.job_id)


async def _persist_set(
    ctx: JobContext,
    *,
    word_data: dict,
    label: str,
    plain_lyrics: Optional[str],
    synced_lyrics: Optional[str],
    activate: bool,
    source: str = LyricsSource.TRANSCRIPTION.value,
) -> None:
    """Save ``word_data`` as a new lyrics set, optionally making it active.

    ``source`` defaults to the transcription provenance both sync jobs
    produce. The re-page job overrides it: paging regroups lines that are
    already there, so the set it writes came from wherever the original came
    from — calling a re-paged manual edit a transcription would be a lie about
    where the words came from.
    """
    from karaoke_backend.database import AsyncSessionLocal

    # Re-verify the claim before the multi-table write. `lyrics_sets` and
    # `songs` carry no claim column, so nothing at the SQL layer would stop a
    # worker whose lease lapsed during a long transcription from adding a
    # second lyrics set and re-pointing the song at it.
    if not await queue.heartbeat(ctx.job_id, ctx.worker_id):
        raise LeaseLost(ctx.job_id)

    async with AsyncSessionLocal() as db:
        new_set = LyricsSet(
            song_id=ctx.song_id,
            owner_id=ctx.owner_id,
            source=source,
            label=label,
            is_verified=False,
            plain_lyrics=plain_lyrics,
            synced_lyrics=synced_lyrics,
            word_sync_json=json.dumps(word_data),
            metadata_json=json.dumps(word_data["metadata"]),
        )
        db.add(new_set)
        await db.flush()

        if activate:
            await db.execute(
                update(Song)
                .where(Song.id == ctx.song_id)
                .values(active_lyrics_id=new_set.id)
            )
        await db.commit()
        set_id = new_set.id

    logger.info("Job %s saved lyrics set %d (%s)", ctx.job_id, set_id, label)


def _make_cache_write_guard(
    job_id: str,
    worker_id: str,
    loop: asyncio.AbstractEventLoop,
):
    """Bridge the transcription thread's cache-write check to the async queue.

    Same shape as the lease re-check in :func:`_persist_set`, and for the same
    reason — but it has to run from the executor thread ``_run_blocking`` lives
    on, so it hops back to the loop the way ``jobs.ingest`` does for correction
    progress.

    Returning False is not an error path the transcription can unwind: it just
    declines the write, and the orchestrator's own ``_persist_set`` claim check
    is what actually fails the job a moment later.
    """

    def still_claimed() -> bool:
        future = asyncio.run_coroutine_threadsafe(
            queue.heartbeat(job_id, worker_id), loop
        )
        try:
            return bool(future.result(timeout=_CACHE_GUARD_TIMEOUT_SECONDS))
        except Exception as exc:  # noqa: BLE001 — see docstring
            future.cancel()
            logger.warning(
                "Could not confirm the claim on job %s before the transcription "
                "cache write: %s",
                job_id,
                exc,
            )
            return False

    return still_claimed


def _correction_for(ctx: JobContext, payload: dict):
    """`(pipeline_config, correction_progress_fn)` for this job's payload.

    Correction is a stage INSIDE alignment — the aligners hold the corrector —
    so both handlers can offer it, and both need the progress bridge: an LLM
    pass over a song's regions runs for minutes with nothing else writing to
    the job row.

    Only the PLAIN-TEXT aligners hold one, though. A synced reference is
    dispatched to the LRC-anchored aligner, which is built without a corrector,
    so the request is honoured and corrects nothing. That is logged rather
    than refused: the caller may well have asked for both, and the LRC
    anchoring is the better result of the two.
    """
    pipeline_config = _pipeline_config(payload)
    if not payload.get("llm_correction"):
        return pipeline_config, None

    if payload.get("synced_lyrics"):
        logger.info(
            "Job %s: LLM correction requested with a synced (LRC) reference — "
            "the LRC-anchored aligner holds no corrector, so no correction "
            "will run",
            ctx.job_id,
        )

    return (
        make_correction_config(pipeline_config),
        make_correction_progress_callback(
            ctx.job_id, ctx.worker_id, asyncio.get_running_loop()
        ),
    )


async def _maybe_page(
    ctx: JobContext,
    word_data: dict,
    plain_lyrics: Optional[str],
    payload: dict,
) -> dict:
    """Run LLM paging when the request asked for it, else pass the payload on.

    The reference lyrics are the paging input when there are any; an
    unanchored run has none, so its own transcribed lines stand in. Either way
    the outcome is recorded in the metadata and never fails the job — the
    lyrics set is worth saving whether or not the LLM grouped it into pages.
    """
    if not payload.get("llm_paging"):
        return word_data
    await _announce(
        ctx,
        phase=JobPhase.ALIGNING.value,
        progress=60,
        message="Structuring pages (LLM)",
    )
    paging_text = plain_lyrics or paging_text_from_word_sync(word_data)
    return await page_word_sync(word_data, paging_text)


async def run_retranscribe(ctx: JobContext) -> Optional[str]:
    payload = ctx.payload
    whisper_model = payload["whisper_model"]
    use_vad = bool(payload.get("use_vad", True))
    plain_lyrics = payload.get("plain_lyrics")
    synced_lyrics = payload.get("synced_lyrics")
    pipeline_config, correction_progress_fn = _correction_for(ctx, payload)

    await _announce(
        ctx,
        phase=JobPhase.TRANSCRIBING.value,
        progress=10,
        message="Running transcription",
    )

    try:
        word_data = await generate_word_sync(
            vocals_path=payload["vocals_path"],
            artist=payload.get("artist") or "",
            title=payload.get("title") or "",
            plain_lyrics=plain_lyrics,
            synced_lyrics=synced_lyrics,
            whisper_model=whisper_model,
            language=payload.get("language"),
            use_vad=use_vad,
            song_id=ctx.song_id,
            pipeline_config=pipeline_config,
            correction_progress_fn=correction_progress_fn,
            # This is the RESCUE path, and the only caller that sets either
            # flag. The ingest pass is deterministic (greedy 0.0) and
            # cache-aware; a manual re-transcribe re-arms the temperature
            # ladder AND must actually re-run the model — ingest always leaves
            # a cache entry behind, so without force_transcribe this job would
            # silently replay that same transcription and the ladder would
            # never execute.
            allow_temperature_fallback=True,
            force_transcribe=True,
            # force_transcribe makes the cache write reachable on a path that
            # used to always hit the cache, so it needs the same claim re-check
            # the DB write below has.
            cache_write_guard=_make_cache_write_guard(
                ctx.job_id, ctx.worker_id, asyncio.get_running_loop()
            ),
        )
    except Exception as exc:
        logger.exception("Re-transcribe %s failed", ctx.job_id)
        raise JobFailure("Re-transcription failed", str(exc)) from exc
    if word_data is None:
        raise JobFailure(
            "Re-transcription failed", "Transcription returned no result"
        )

    word_data = await _maybe_page(ctx, word_data, plain_lyrics, payload)

    label = _label_for_set(
        describe_run(whisper_model, use_vad=use_vad),
        payload.get("reference_mode", "none"),
        realigned=False,
        rescue=True,
    )
    await _persist_set(
        ctx,
        word_data=word_data,
        label=label,
        plain_lyrics=plain_lyrics,
        synced_lyrics=synced_lyrics,
        activate=bool(payload.get("activate", True)),
    )
    return f"Saved as '{label}'"


async def run_realign(ctx: JobContext) -> Optional[str]:
    payload = ctx.payload
    whisper_model = payload["whisper_model"]
    use_vad = bool(payload.get("use_vad", True))
    plain_lyrics = payload.get("plain_lyrics")
    synced_lyrics = payload.get("synced_lyrics")
    pipeline_config, correction_progress_fn = _correction_for(ctx, payload)

    await _announce(
        ctx,
        phase=JobPhase.ALIGNING.value,
        progress=20,
        message="Aligning cached transcription",
    )

    try:
        word_data = await realign_only(
            song_id=ctx.song_id,
            artist=payload.get("artist") or "",
            title=payload.get("title") or "",
            plain_lyrics=plain_lyrics,
            synced_lyrics=synced_lyrics,
            whisper_model=whisper_model,
            use_vad=use_vad,
            pipeline_config=pipeline_config,
            correction_progress_fn=correction_progress_fn,
            vocals_path=payload.get("vocals_path"),
        )
    except Exception as exc:
        logger.exception("Realign %s failed", ctx.job_id)
        raise JobFailure("Realignment failed", str(exc)) from exc
    if word_data is None:
        raise JobFailure("Realignment failed", "Realignment returned no result")

    word_data = await _maybe_page(ctx, word_data, plain_lyrics, payload)

    label = _label_for_set(
        describe_run(whisper_model, use_vad=use_vad),
        payload.get("reference_mode", "none"),
        realigned=True,
    )
    await _persist_set(
        ctx,
        word_data=word_data,
        label=label,
        plain_lyrics=plain_lyrics,
        synced_lyrics=synced_lyrics,
        activate=bool(payload.get("activate", True)),
    )
    return f"Saved as '{label}'"


async def run_page(ctx: JobContext) -> Optional[str]:
    """Re-page an existing lyrics set: same words and timings, new grouping.

    The cheapest of the three by an order of magnitude — no GPU, no aligner,
    one LLM round trip against words that are already timed. It exists because
    paging used to be reachable only at upload time, so a song ingested
    without it could never be paged without re-transcribing the whole thing.

    Failure is refusal, not degradation: paging that produced nothing writes
    NO set. The alternative is a library filling with identical duplicates
    labelled ``-paged`` that are not paged.
    """
    from karaoke_backend.database import AsyncSessionLocal

    payload = ctx.payload
    lyrics_set_id = payload["lyrics_set_id"]

    await _announce(
        ctx,
        phase=JobPhase.ALIGNING.value,
        progress=20,
        message="Structuring pages (LLM)",
    )

    async with AsyncSessionLocal() as db:
        original = await db.get(LyricsSet, lyrics_set_id)
        if original is None or original.song_id != ctx.song_id:
            raise JobFailure(
                "The lyrics set to re-page is gone",
                f"Lyrics set {lyrics_set_id} no longer belongs to song {ctx.song_id}",
            )
        # Read every field off the row inside the session: the ORM object is
        # detached once the session closes and the LLM call below takes
        # minutes, which is far too long to hold a connection open.
        source = original.source
        label = original.label
        plain_lyrics = original.plain_lyrics
        synced_lyrics = original.synced_lyrics
        word_sync_json = original.word_sync_json

    if not word_sync_json:
        raise JobFailure(
            "That lyrics set has no word timings to page",
            f"Lyrics set {lyrics_set_id} has no word_sync_json",
        )
    try:
        word_data = json.loads(word_sync_json)
    except ValueError as exc:
        raise JobFailure(
            "That lyrics set's word timings could not be read", str(exc)
        ) from exc

    paging_text = plain_lyrics or paging_text_from_word_sync(word_data)
    word_data = await page_word_sync(word_data, paging_text)
    if word_data.get("metadata", {}).get(PAGING_STATUS_KEY) != PAGING_APPLIED:
        raise JobFailure(
            "LLM paging produced no pages",
            f"The LLM returned no usable page structure for lyrics set "
            f"{lyrics_set_id}; nothing was saved.",
        )

    # Re-paging a set that was already paged is a legitimate thing to do —
    # the LLM is not deterministic — but "x-paged-paged-paged" is not a label
    # anyone can read. The suffix says what the set is, not how many times it
    # got there.
    base = label or "set"
    new_label = base if base.endswith(PAGED_SUFFIX) else f"{base}{PAGED_SUFFIX}"
    await _persist_set(
        ctx,
        word_data=word_data,
        label=new_label,
        plain_lyrics=plain_lyrics,
        synced_lyrics=synced_lyrics,
        activate=bool(payload.get("activate", True)),
        source=source,
    )
    return f"Saved as '{new_label}'"
