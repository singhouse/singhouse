# SPDX-License-Identifier: MIT
"""LLM-assisted alignment correction.

Deterministic alignment fails two ways the heuristics can't fix: garble
cascades (mis-matched words hiding inside trusted anchors) and wide-gap
placement guesses. This package finds those suspect regions, asks an
OpenAI-compatible endpoint to re-time them, validates the answer
mechanically, and falls back to the heuristic on any failure.
"""

from lyricsync.correction.apply import RegionCorrector

__all__ = ["RegionCorrector"]
