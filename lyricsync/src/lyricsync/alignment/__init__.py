# SPDX-License-Identifier: MIT
from lyricsync.alignment._base import Aligner
from lyricsync.alignment.matching import normalize, word_match_score
from lyricsync.alignment.lrc import parse_lrc, strip_lrc_tags

__all__ = ["Aligner", "normalize", "word_match_score", "parse_lrc", "strip_lrc_tags"]

def __getattr__(name):
    if name == "NeedlemanWunschAligner":
        from lyricsync.alignment.needleman_wunsch import NeedlemanWunschAligner
        return NeedlemanWunschAligner
    if name == "LrcAnchoredAligner":
        from lyricsync.alignment.lrc_anchored import LrcAnchoredAligner
        return LrcAnchoredAligner
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
