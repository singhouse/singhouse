# SPDX-License-Identifier: AGPL-3.0-only
"""Final playback storage; separator intermediates retain their WAV contract."""
from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

from karaoke_backend.workers.modal_worker import _await_subprocess
from karaoke_backend.stem_layout import allowed_stem_filenames

PLAYABLE_BASES = ("lead_vocals", "backing_vocals", "instrumental", "karaoke")


def stem_format() -> str:
    """Read the operator setting at job time and refuse unknown formats."""
    value = os.getenv("STEM_FORMAT", "mp3").strip().lower()
    if value not in {"mp3", "flac"}:
        raise ValueError("STEM_FORMAT must be mp3 or flac")
    return value


def stem_codec_args(format: str | None = None) -> list[str]:
    format = stem_format() if format is None else format
    if format == "mp3":
        return ["-c:a", "libmp3lame", "-b:a", "256k", "-f", "mp3"]
    if format == "flac":
        return ["-af", "aresample=osf=s16:dither_method=triangular",
                "-c:a", "flac", "-sample_fmt", "s16", "-f", "flac"]
    raise ValueError("Stem output must be mp3 or flac")


async def encode_stem(source: Path, target: Path) -> None:
    """Encode, fully decode to validate, then atomically publish one stem.

    Never removes the source. MP3's Xing header carries gapless trim information;
    leave it enabled so independently encoded stems retain their sample alignment.
    Cancellation kills/reaps each child before removing its temporary output.
    """
    args = stem_codec_args(target.suffix.lstrip("."))
    temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
    try:
        await _await_subprocess([
            "ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(source),
            "-map", "0:a:0", "-vn", *args, str(temporary),
        ], timeout=600)
        if not temporary.is_file() or temporary.stat().st_size == 0:
            raise RuntimeError(f"Stem encoder produced no audio: {target.name}")
        await _await_subprocess([
            "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(temporary),
            "-map", "0:a:0", "-f", "null", "-",
        ], timeout=600)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


async def finalize_stems(stems_dir: Path, bases=None) -> None:
    """Encode all playable WAVs before deleting any; retained WAVs permit retry."""
    format = stem_format()
    if bases is None:
        bases = sorted({Path(name).stem for name in allowed_stem_filenames(stems_dir)})
    sources = [stems_dir / f"{base}.wav" for base in bases
               if (stems_dir / f"{base}.wav").is_file()]
    for source in sources:
        await encode_stem(source, source.with_suffix(f".{format}"))
    for source in sources:
        source.unlink()
        # Do not let a previous failed attempt shadow the selected output.
        for suffix in {".mp3", ".flac"} - {f".{format}"}:
            source.with_suffix(suffix).unlink(missing_ok=True)
