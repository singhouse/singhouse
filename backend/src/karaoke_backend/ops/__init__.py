# SPDX-License-Identifier: AGPL-3.0-only
"""Operator CLIs packaged as console-script entry points.

These modules back the core ``[project.scripts]`` in pyproject.toml
(``kb-seed-lyrics-reference``). Because the package is
installed (editable in dev, ``--no-deps`` editable in deployment), they import
``karaoke_backend`` by its real dotted path — no ``sys.path`` bootstrapping.
"""
