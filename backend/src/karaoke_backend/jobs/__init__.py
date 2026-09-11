# SPDX-License-Identifier: AGPL-3.0-only
"""Durable job queue.

The `jobs` table is the queue; ``queue`` holds the claim/lease machinery,
``worker`` the loop that drains it, and one module per job kind holds the
orchestrator that used to live inside a router.

Importing this package pulls in only ``queue`` — the handlers reach back into
``karaoke_backend.api`` for the route-side constants they share, so eager
imports here would make the package unimportable from a router.
"""

from karaoke_backend.jobs.queue import (
    RESTART_INTERRUPTION_MESSAGE,
    TERMINAL_STATUSES,
    enqueue,
    sweep_legacy,
)

__all__ = [
    "RESTART_INTERRUPTION_MESSAGE",
    "TERMINAL_STATUSES",
    "enqueue",
    "sweep_legacy",
]
