# SPDX-License-Identifier: AGPL-3.0-only
"""Core-metadata purity tripwire.

The core alembic baseline (generated later from ``Base.metadata``) must be
permanently premium-free. This locks two invariants that guard it:

1. Importing ONLY the core models package registers EXACTLY the core tables
   (the ``EXPECTED`` set below) and pulls no premium code into the import
   graph. Run in a subprocess
   so an unrelated in-process import (conftest, another test, main's multi
   branch) can never mask a real leak.

2. ``owner_id`` STAYS on the core Song/Job/LyricsSet models. Core single-host
   scoping keys off it (``owner_id == SINGLE_HOST_ID``) and the same query path
   serves premium tenant isolation, so it is core plumbing, not a premium
   column. It enters the baseline as a nullable, FK-less integer (existing and
   premium DBs keep their baked-in FK; premium re-adds DB-level enforcement in
   its own migration). This test fails loudly if it is ever dropped.
"""

import subprocess
import sys

from karaoke_backend.models.song import Job, LyricsSet, Song

_PURITY_PROBE = r"""
import sys
import karaoke_backend.models as m

EXPECTED = {"songs", "jobs", "lyrics_sets", "queue_entries", "play_history", "app_settings"}
PREMIUM = {"users", "invites", "shows", "singers", "singer_songs"}

tables = set(m.Base.metadata.tables)
problems = []
if tables != EXPECTED:
    problems.append("core Base.metadata.tables=%s != %s" % (sorted(tables), sorted(EXPECTED)))
leaked = tables & PREMIUM
if leaked:
    problems.append("premium tables leaked into core metadata: %s" % sorted(leaked))
if "karaoke_premium" in sys.modules:
    problems.append("karaoke_premium was imported into the core models graph")

if problems:
    sys.stderr.write("IMPURE: " + " ; ".join(problems) + "\n")
    sys.exit(1)
sys.stdout.write("PURE\n")
"""


def test_core_models_import_graph_is_premium_free():
    proc = subprocess.run(
        [sys.executable, "-c", _PURITY_PROBE],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, (
        f"core metadata purity probe failed:\nstdout={proc.stdout}\nstderr={proc.stderr}"
    )
    assert proc.stdout.strip() == "PURE"


def test_owner_id_retained_on_core_models():
    # Encodes the Option-A decision (keep owner_id in core). If a future change
    # strips it, ~15 core scoping sites break in core-only mode — fail here first.
    for model in (Song, Job, LyricsSet):
        assert hasattr(model, "owner_id"), f"{model.__name__} lost its owner_id column"
