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
    JobKind.PAGE.value: JobSpec("karaoke_backend.jobs.transcribe:run_page"),
    JobKind.RESPLIT.value: JobSpec("karaoke_backend.jobs.resplit:run_resplit"),
    JobKind.CATALOG_IMPORT.value: JobSpec(
        "karaoke_backend.jobs.catalog_import:run_catalog_import"
    ),
    # Mirrors for the same reason ingest does: this job IS the song's
    # creation. A failed video import leaves a row with no stems and no video,
    # and nothing else will ever fix it.
    JobKind.VIDEO_IMPORT.value: JobSpec(
        "karaoke_backend.jobs.video_import:run_video_import",
        mirrors_song_status=True,
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


def register_job_kind(
    kind: str, target: str, *, mirrors_song_status: bool = False
) -> None:
    """Add a kind whose handler lives outside this package.

    The composition-time half of the seam described in the module docstring:
    called once, at startup, by whatever composes an installed extension into
    the app. Registration is add-only. A kind already present — built-in or
    previously registered — is refused rather than replaced, because a queue
    is durable: rows of that kind may already be sitting in ``jobs``, and
    silently swapping the spec would change what those rows DO on their next
    claim.
    """
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
    _SPECS[kind] = JobSpec(target, mirrors_song_status=mirrors_song_status)


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
