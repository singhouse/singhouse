# SPDX-License-Identifier: AGPL-3.0-only
"""The handler contract: what a job hands its orchestrator, and how it fails.

Separate from ``registry`` so handlers can import this without the registry
importing them back.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


class LeaseLost(Exception):
    """This worker no longer holds the job it is running. Stop, write nothing.

    The `claimed_by` predicate protects the `jobs` row, and only that row. A
    handler also writes `songs` and `lyrics_sets`, which have no claim column
    and cannot be guarded the same way — so the guard becomes control flow:
    the first refused job-row write raises this, and the handler unwinds
    before it can touch anything else.

    Distinct from ``JobFailure`` on purpose. A failure is an outcome this
    worker is entitled to record; a lost lease means the outcome belongs to
    whoever holds the job now, and recording anything would overwrite a live
    run with the conclusions of a dead one.
    """


class JobFailure(Exception):
    """A failure the operator should read, with the raw detail behind it.

    ``message`` is what the UI shows; ``error`` is the unredacted text (paths,
    exception strings) the account holder is entitled to and a guest is not.
    Anything else a handler raises is reported as an unexpected error.
    """

    def __init__(self, message: str, error: Optional[str] = None) -> None:
        super().__init__(message)
        self.message = message
        self.error = error if error is not None else message


@dataclass(frozen=True)
class JobContext:
    """Everything a handler is allowed to assume about its job.

    Notably NOT a session: handlers open short ones per write. Holding one
    across a fifteen-minute separation pins a connection and stalls the
    heartbeat that is keeping the lease alive.
    """

    job_id: str
    kind: str
    worker_id: str
    owner_id: int
    song_id: Optional[int] = None
    attempts: int = 1
    payload: dict[str, Any] = field(default_factory=dict)
