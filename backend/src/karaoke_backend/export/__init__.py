# SPDX-License-Identifier: AGPL-3.0-only
"""Single-song CD+G / MP3+G export.

The ``cdg`` package is the format layer: it encodes glyph masks it is handed
and deliberately rasterises nothing. This package is the layer above it — the
text rasteriser (``raster``), which needs Pillow and a vendored font, and the
export service (``service``), which resolves a song's audio and word-synced
lyrics, encodes the stream, and assembles the deliverable file.

Pillow is an optional dependency (the ``export`` extra). Everything here
imports without it; ``raster.raster_available()`` is the runtime probe callers
gate on.
"""
