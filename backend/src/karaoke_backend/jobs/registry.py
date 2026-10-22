# SPDX-License-Identifier: AGPL-3.0-only
"""kind → handler. The one place that knows what a job kind means.

Core's own kinds are listed here at import time. An installed extension
package can also run its long work through this queue, and its handlers live
outside this package where no import-time table can name them — so the table
is add-to-able: the extension calls ``register_job_kind`` once at composition
time, and from then on its kind flows through the same ``get_spec`` /
``known_kinds`` lookups as the built-ins. The worker cannot tell the
difference, which is the point: the queue, the leases, and the job API are
core's; only the handler behind the kind is not.

**Lanes.** Every kind also declares which concurrency budget it draws from.
The ``processing`` lane is for work that separates, transcribes or aligns —
GPU-bound, minutes per job, and capped by ``KARAOKE_JOB_CONCURRENCY`` because
two of them at once is how a card runs out of VRAM. The ``fast`` lane is for
work that only moves or repackages media that already exists: a catalog
provider downloading a finished karaoke track, a video or CD+G file being
adopted. It has its own budget (``KARAOKE_FAST_JOB_CONCURRENCY``) so that a
singer's request at a live show is never stuck behind an evening's worth of
queued generations. ``processing`` is the default for every kind, extension
kinds included, because the failure modes are lopsided: a fast job wrongly in
the processing lane only waits, while a heavy job wrongly in the fast lane
runs beside another heavy job and can take the GPU down with both.

Composition time means DURING plugin/extension import — before the lifespan
starts the worker — never in a lifespan startup hook. The queue is durable:
a row of the extension's kind can be sitting in ``jobs`` from the previous
run, and the worker's first claim pass terminally fails any kind it cannot
resolve. Registering after the worker starts races exactly that pass.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module
from typing import Awaitable, Callable, Optional

from karaoke_backend.jobs.base import JobContext
from karaoke_backend.models.song import Job, JobKind

JobHandler = Callable[[JobContext], Awaitable[Optional[str]]]

# The two concurrency budgets a kind can draw from. See the module docstring.
LANE_PROCESSING = "processing"
LANE_FAST = "fast"
LANES: tuple[str, ...] = (LANE_PROCESSING, LANE_FAST)


def _check_lane(lane: object) -> None:
    if lane not in LANES:
        raise ValueError(f"job lane must be one of {LANES!r}, not {lane!r}")


@dataclass(frozen=True)
class JobSpec:
    # "module:attribute", resolved on every dispatch rather than bound at
    # import time. Two reasons: the handler modules import back into
    # ``karaoke_backend.api`` for the constants they share with the routes, so
    # binding here would make the registry unimportable from a router; and a
    # test that patches the handler on its own module gets what it patched.
    target: str
    # Whether a FAILED job should drag its Song to `failed` too. True only
    # where the job IS the song's creation: an ingest that fails leaves a song
    # with no stems and nothing else will ever fix it. A re-transcription of an
    # existing song must not knock it out of the library, and catalog imports
    # mirror from inside the provider, as they always have.
    mirrors_song_status: bool = False
    # Which concurrency budget the worker charges this kind against. Only a
    # kind whose handler provably never separates, transcribes or aligns —
    # and never calls into anything that does — belongs in ``fast``; a job
    # that needs that work enqueues a processing-lane job for it instead.
    lane: str = LANE_PROCESSING

    def __post_init__(self) -> None:
        _check_lane(self.lane)

    @property
    def handler(self) -> JobHandler:
        module_name, _, attribute = self.target.partition(":")
        return getattr(import_module(module_name), attribute)


_SPECS: dict[str, JobSpec] = {
    JobKind.INGEST.value: JobSpec(
        "karaoke_backend.jobs.ingest:run_ingest", mirrors_song_status=True
    ),
    JobKind.RETRANSCRIBE.value: JobSpec(
        "karaoke_backend.jobs.transcribe:run_retranscribe"
    ),
    JobKind.REALIGN.value: JobSpec("karaoke_backend.jobs.transcribe:run_realign"),
    # Neither mirrors: both act on a song that is already in the library and
    # already playable. A re-page that fails leaves the existing lyrics set
    # alone, and a re-split that fails leaves the existing stems byte for byte
    # as they were — flipping the song to `failed` would take a working song
    # out of the library over a refinement that did not land.
    #
    # Both stay in the processing lane. A re-split is a separation. A re-page
    # runs no aligner, but it holds a slot for an LLM round trip of up to
    # ``KARAOKE_LLM_TIMEOUT`` against an operator-configured endpoint that may
    # be a local model on the same GPU — neither fast nor safe to run beside
    # a separation.
    JobKind.PAGE.value: JobSpec("karaoke_backend.jobs.transcribe:run_page"),
    JobKind.RESPLIT.value: JobSpec("karaoke_backend.jobs.resplit:run_resplit"),
    # Fast: the handler only resolves the provider and calls its
    # ``run_import``, whose protocol contract is to retrieve an item the user
    # already has and ADOPT its finished stems. A provider that wanted
    # generation would have to enqueue a processing-lane job of its own.
    JobKind.CATALOG_IMPORT.value: JobSpec(
        "karaoke_backend.jobs.catalog_import:run_catalog_import",
        lane=LANE_FAST,
    ),
    # Mirrors for the same reason ingest does: this job IS the song's
    # creation. A failed video import leaves a row with no stems and no video,
    # and nothing else will ever fix it. Fast: an ffmpeg audio extraction and
    # a file copy — nothing is separated, transcribed or aligned.
    JobKind.VIDEO_IMPORT.value: JobSpec(
        "karaoke_backend.jobs.video_import:run_video_import",
        mirrors_song_status=True,
        lane=LANE_FAST,
    ),
    # Fast for the same reason: a CPU decode of the CD+G packet stream piped
    # into ffmpeg, bounded by its own media timeout, plus an audio transcode.
    JobKind.CDG_IMPORT.value: JobSpec(
        "karaoke_backend.jobs.cdg_import:run_cdg_import",
        mirrors_song_status=True,
        lane=LANE_FAST,
    ),
    # Mirrors for the same reason the two above do: the job IS the song's
    # creation. It materialises the audio and then delegates to run_ingest, so
    # a failure at either end leaves a row with no stems that nothing will fix.
    JobKind.PLEX_IMPORT.value: JobSpec(
        "karaoke_backend.jobs.plex_import:run_plex_import",
        mirrors_song_status=True,
    ),
}


# Snapshotted before any registration can happen: the built-ins are core's
# contract with its own handlers, and nothing composed in later may redefine
# or remove one.
_BUILTIN_KINDS: frozenset[str] = frozenset(_SPECS)

# The kind is stored in ``jobs.kind``; a kind the column would truncate is
# refused at registration, not discovered as a row that never matches a spec.
_KIND_MAX_LENGTH: int = Job.__table__.c.kind.type.length


def get_spec(kind: Optional[str]) -> Optional[JobSpec]:
    if kind is None:
        return None
    return _SPECS.get(kind)


def known_kinds() -> frozenset[str]:
    return frozenset(_SPECS)


def fast_lane_kinds() -> frozenset[str]:
    """The kinds the fast lane may claim. Read fresh on every claim.

    The processing lane is defined as its complement rather than as its own
    list, which is what keeps an UNKNOWN kind on today's path: a row whose
    kind has no spec is claimable by the processing lane and terminally
    failed there by the worker, exactly as before lanes existed.
    """
    return frozenset(kind for kind, spec in _SPECS.items() if spec.lane == LANE_FAST)


def lane_of(kind: Optional[str]) -> str:
    """The lane a kind draws from; ``processing`` for an unknown kind."""
    spec = get_spec(kind)
    return spec.lane if spec is not None else LANE_PROCESSING


def register_job_kind(
    kind: str,
    target: str,
    *,
    mirrors_song_status: bool = False,
    lane: str = LANE_PROCESSING,
) -> None:
    """Add a kind whose handler lives outside this package.

    The composition-time half of the seam described in the module docstring:
    called once, at startup, by whatever composes an installed extension into
    the app. Registration is add-only. A kind already present — built-in or
    previously registered — is refused rather than replaced, because a queue
    is durable: rows of that kind may already be sitting in ``jobs``, and
    silently swapping the spec would change what those rows DO on their next
    claim.

    ``lane`` defaults to ``processing``, the safe side; an extension opts a
    kind into ``fast`` only when its handler never runs heavy processing
    itself. An unrecognised lane is refused here, before any row of the kind
    can be queued under a budget that does not exist.
    """
    _check_lane(lane)
    if not isinstance(kind, str) or not kind:
        raise ValueError("job kind must be a non-empty string")
    if len(kind) > _KIND_MAX_LENGTH:
        raise ValueError(
            f"job kind {kind!r} is longer than the {_KIND_MAX_LENGTH} "
            f"characters the jobs table stores"
        )
    if kind in _SPECS:
        raise ValueError(f"job kind {kind!r} is already registered")
    # The target's shape is checked here because claim time is too late: the
    # worker translates a *missing* module or attribute into a clean job
    # failure, but a target that is not "module:attr" at all blows up inside
    # resolution and wedges the claimed row until its lease expires.
    if not isinstance(target, str):
        raise ValueError("job target must be a 'module:attribute' string")
    module_name, sep, attribute = target.partition(":")
    if not sep or not attribute or not module_name or module_name.startswith("."):
        raise ValueError(
            f"job target {target!r} is not an absolute 'module:attribute' path"
        )
    _SPECS[kind] = JobSpec(
        target, mirrors_song_status=mirrors_song_status, lane=lane
    )


def unregister_job_kind(kind: str) -> None:
    """Remove a registered kind; a no-op if it was never added.

    Exists so a composition can be torn down and rebuilt — tests, mostly —
    without registrations accumulating in module state between assemblies.
    The built-ins are not removable: the rest of core enqueues them by name
    and a registry that could lose one would fail every such job at claim
    time.
    """
    if kind in _BUILTIN_KINDS:
        raise ValueError(f"job kind {kind!r} is built in and cannot be removed")
    _SPECS.pop(kind, None)
