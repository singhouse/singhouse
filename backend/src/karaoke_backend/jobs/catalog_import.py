# SPDX-License-Identifier: AGPL-3.0-only
"""Catalog-import handler — resolve the provider by name, then hand off.

The provider protocol is unchanged and deliberately so: providers are
out-of-tree code that already own their job row's lifecycle,
terminal state included. This handler resolves the name against the CORE
registry and calls ``run_import``; the worker then notices whether the
provider already wrote a terminal state and leaves it alone if so.

That ownership goes further than the terminal state: shipped providers write
their own progress STRINGS into `Job.status` mid-import ("downloading",
"adopting", "parsing_lyrics") because that column was the only progress
channel before the durable queue gave the row a `phase`. The queue's lease predicates are
written to tolerate it — see ``queue.heartbeat`` and ``queue.requeue_expired``
— so an import that a provider has moved off `running` still holds its lease
and is still recoverable if its process dies.

The registry import is the core one on purpose. ``karaoke_premium`` must
never appear in this module's import graph — a module-scope premium import
here registers premium tables on core's ``Base`` and trips the core
metadata-purity gate.
"""

from __future__ import annotations

import logging
from typing import Optional

from karaoke_backend.api.providers import get_provider
from karaoke_backend.jobs import queue
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost
from karaoke_backend.models.song import JobPhase

logger = logging.getLogger(__name__)


async def run_catalog_import(ctx: JobContext) -> Optional[str]:
    payload = ctx.payload
    provider_name = payload.get("provider")
    external_id = payload.get("external_id")
    if not provider_name or not external_id:
        raise JobFailure("Import job is missing its provider or item id")

    provider = get_provider(provider_name)
    if provider is None:
        # The provider was registered when the route accepted the import and
        # is gone now — a plugin removed or a boot without it. Say so plainly
        # rather than leaving the row running until its lease lapses.
        raise JobFailure(
            "The catalog provider for this import is no longer available",
            f"catalog provider {provider_name!r} is not registered",
        )

    # The last write this handler makes before the provider takes the row
    # over, so it is also the last chance to notice the claim is not ours.
    if not await queue.update_progress(
        ctx.job_id, ctx.worker_id, phase=JobPhase.IMPORTING.value
    ):
        raise LeaseLost(ctx.job_id)

    try:
        await provider.run_import(
            job_id=ctx.job_id,
            song_id=ctx.song_id,
            owner_id=ctx.owner_id,
            external_id=external_id,
        )
    except LeaseLost:
        raise
    except Exception as exc:
        logger.exception("Catalog import %s failed", ctx.job_id)
        raise JobFailure("Import failed", str(exc)) from exc
    return None
