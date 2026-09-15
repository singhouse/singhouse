# SPDX-License-Identifier: AGPL-3.0-only
"""Bounded, durable import of one bare CDG or one MP3+G ZIP."""

from __future__ import annotations

import asyncio
import logging
import math
import os
import stat
import subprocess
import tempfile
import threading
import zipfile
from pathlib import Path, PurePosixPath

from sqlalchemy import update

from karaoke_backend.cdg import (
    Decoder,
    MAX_DECODE_PACKETS,
    MAX_DECODE_SECONDS,
    PACKET_BYTES,
    PACKETS_PER_SEC,
)
from karaoke_backend.jobs import queue
from karaoke_backend.jobs.base import JobContext, JobFailure, LeaseLost
from karaoke_backend.models.song import JobPhase, Song

logger = logging.getLogger(__name__)

CDG_FILENAME = "graphics.cdg"
VIDEO_FILENAME = "video.mp4"
AUDIO_FILENAME = "instrumental.flac"
# CDG mutates at 300 packets/s, but browsers display video frames. Sampling
# after each ten-packet interval preserves a smooth 30 fps wipe while bounding
# a 30-minute import at 54,000 fixed-size frames.
RENDER_FPS = 30
MAX_ARCHIVE_ENTRIES = 32
MAX_ENTRY_NAME = 255
MAX_AUDIO_BYTES = 500 * 1024 * 1024
MAX_CDG_BYTES = MAX_DECODE_PACKETS * PACKET_BYTES + PACKET_BYTES - 1
MAX_TOTAL_UNCOMPRESSED = MAX_AUDIO_BYTES + MAX_CDG_BYTES
_AUDIO_EXTENSIONS = frozenset({".mp3"})  # the existing MP3+G exporter contract
_PROBE_TIMEOUT = 120
_MEDIA_TIMEOUT = 1800


class CdgImportError(Exception):
    pass


def _unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _safe_members(archive: zipfile.ZipFile) -> tuple[zipfile.ZipInfo, zipfile.ZipInfo]:
    infos = archive.infolist()
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        raise CdgImportError(f"The archive has more than {MAX_ARCHIVE_ENTRIES} entries.")
    seen: set[str] = set()
    files: list[zipfile.ZipInfo] = []
    for info in infos:
        name = info.filename
        pure = PurePosixPath(name)
        folded = name.casefold()
        if (not name or len(name) > MAX_ENTRY_NAME or pure.is_absolute()
                or ".." in pure.parts or "\\" in name):
            raise CdgImportError("The archive contains an unsafe entry name.")
        if folded in seen:
            raise CdgImportError("The archive contains duplicate entry names.")
        seen.add(folded)
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise CdgImportError("The archive contains a symbolic link.")
        if info.flag_bits & 0x1:
            raise CdgImportError("Encrypted MP3+G archives are not supported.")
        if not info.is_dir():
            if len(pure.parts) != 1:
                raise CdgImportError("MP3+G files must be at the archive root.")
            files.append(info)
    if sum(i.file_size for i in files) > MAX_TOTAL_UNCOMPRESSED:
        raise CdgImportError("The archive expands beyond the 513 MB limit.")
    cdgs = [i for i in files if Path(i.filename).suffix.lower() == ".cdg"]
    audios = [i for i in files if Path(i.filename).suffix.lower() in _AUDIO_EXTENSIONS]
    if len(cdgs) != 1 or len(audios) != 1 or len(files) != 2:
        raise CdgImportError("An MP3+G ZIP must contain exactly one .cdg and one .mp3 file.")
    cdg, audio = cdgs[0], audios[0]
    if cdg.file_size > MAX_CDG_BYTES or audio.file_size > MAX_AUDIO_BYTES:
        raise CdgImportError("An MP3+G entry exceeds its size limit.")
    if Path(cdg.filename).stem.casefold() != Path(audio.filename).stem.casefold():
        raise CdgImportError("The .cdg and .mp3 entries must have the same base name.")
    return cdg, audio


def _copy_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo, dest: Path, cap: int) -> None:
    tmp = dest.parent / f".{dest.name}.tmp"
    _unlink(tmp)
    total = 0
    try:
        with archive.open(info) as src, tmp.open("wb") as out:
            while chunk := src.read(1024 * 1024):
                total += len(chunk)
                if total > cap:
                    raise CdgImportError(f"Archive entry {info.filename!r} exceeds its size limit.")
                out.write(chunk)
        os.replace(tmp, dest)
    except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
        raise CdgImportError("The MP3+G archive could not be read; it may be corrupt.") from exc
    finally:
        _unlink(tmp)


def _prepare_source(upload: Path, work: Path) -> tuple[Path, Path | None]:
    work.mkdir(parents=True, exist_ok=True)
    cdg = work / CDG_FILENAME
    if upload.suffix.lower() == ".cdg":
        if upload.stat().st_size > MAX_CDG_BYTES:
            raise CdgImportError("The CD+G stream exceeds the 30-minute packet limit.")
        tmp = work / f".{CDG_FILENAME}.tmp"
        _unlink(tmp)
        try:
            with upload.open("rb") as src, tmp.open("wb") as out:
                while chunk := src.read(1024 * 1024):
                    out.write(chunk)
            os.replace(tmp, cdg)
        finally:
            _unlink(tmp)
        return cdg, None
    try:
        with zipfile.ZipFile(upload) as archive:
            cdg_info, audio_info = _safe_members(archive)
            _copy_member(archive, cdg_info, cdg, MAX_CDG_BYTES)
            audio = work / "source.mp3"
            _copy_member(archive, audio_info, audio, MAX_AUDIO_BYTES)
            return cdg, audio
    except (OSError, zipfile.BadZipFile) as exc:
        raise CdgImportError("The MP3+G ZIP could not be read; it may be corrupt.") from exc


def _run(cmd: list[str], timeout: int) -> None:
    # Decoder diagnostics are attacker-influenced and can be much larger than
    # the media. Keep them off the heap, retaining only a small tail on error.
    with tempfile.TemporaryFile() as errors:
        try:
            result = subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=errors,
                timeout=timeout,
            )
        except FileNotFoundError as exc:
            raise CdgImportError("ffmpeg is required to import CD+G files.") from exc
        except subprocess.TimeoutExpired as exc:
            raise CdgImportError(
                "ffmpeg timed out while importing this CD+G file."
            ) from exc
        if result.returncode:
            logger.error("ffmpeg failed during CD+G import: %s", _tail(errors))
            raise CdgImportError("ffmpeg could not prepare this CD+G file.")


def _tail(stream, limit: int = 1000) -> str:
    """Read at most ``limit`` trailing bytes from a disk-backed subprocess log."""
    stream.seek(0, os.SEEK_END)
    stream.seek(max(0, stream.tell() - limit))
    return stream.read(limit).decode(errors="replace")


def _make_audio(source: Path | None, dest: Path, duration: float) -> None:
    tmp = dest.parent / f".{dest.name}.tmp"
    _unlink(tmp)
    if source is None:
        cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
               "-t", f"{duration:.6f}", "-map_metadata", "-1", "-c:a", "flac",
               "-sample_fmt", "s16", "-f", "flac", str(tmp)]
    else:
        cmd = ["ffmpeg", "-y", "-i", str(source), "-vn", "-map_metadata", "-1",
               "-c:a", "flac", "-sample_fmt", "s16", "-f", "flac", str(tmp)]
    try:
        _run(cmd, _MEDIA_TIMEOUT)
        if not tmp.is_file():
            raise CdgImportError("ffmpeg did not produce the audio track.")
        os.replace(tmp, dest)
    finally:
        _unlink(tmp)


def _render(cdg_path: Path, dest: Path) -> float:
    stream = cdg_path.read_bytes()
    packet_count = len(stream) // PACKET_BYTES
    if packet_count > MAX_DECODE_PACKETS:
        raise CdgImportError("The CD+G stream exceeds the 30-minute packet limit.")
    if packet_count == 0:
        raise CdgImportError("The CD+G stream contains no complete packets.")
    duration = packet_count / PACKETS_PER_SEC
    tmp = dest.parent / f".{dest.name}.tmp"
    _unlink(tmp)
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pixel_format", "rgb24",
           "-video_size", "300x216", "-framerate", str(RENDER_FPS), "-i", "-",
           "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
           "-f", "mp4", str(tmp)]
    decoder = Decoder()
    packets_per_frame = PACKETS_PER_SEC // RENDER_FPS
    try:
        with tempfile.TemporaryFile() as errors:
            try:
                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors)
            except FileNotFoundError as exc:
                raise CdgImportError("ffmpeg is required to import CD+G files.") from exc
            timed_out = False

            def kill_at_deadline() -> None:
                nonlocal timed_out
                timed_out = True
                proc.kill()

            watchdog = threading.Timer(_MEDIA_TIMEOUT, kill_at_deadline)
            watchdog.daemon = True
            watchdog.start()
            try:
                assert proc.stdin is not None
                for start in range(0, packet_count, packets_per_frame):
                    for index in range(start, min(start + packets_per_frame, packet_count)):
                        decoder.apply(stream[index * PACKET_BYTES:(index + 1) * PACKET_BYTES])
                    proc.stdin.write(decoder.to_rgb().tobytes())
                proc.stdin.close()
                code = proc.wait()
            except (BrokenPipeError, OSError) as exc:
                proc.kill()
                proc.wait()
                if timed_out:
                    raise CdgImportError("ffmpeg timed out while rendering this CD+G file.") from exc
                raise CdgImportError("ffmpeg could not render this CD+G file.") from exc
            finally:
                watchdog.cancel()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
            if timed_out:
                raise CdgImportError("ffmpeg timed out while rendering this CD+G file.")
            if code or not tmp.is_file():
                errors.seek(0)
                detail = errors.read()[-1000:].decode(errors="replace")
                logger.error("ffmpeg failed rendering CD+G: %s", detail)
                raise CdgImportError("ffmpeg could not render this CD+G file.")
        os.replace(tmp, dest)
        return duration
    finally:
        _unlink(tmp)


def completed(stems: Path) -> bool:
    return all((stems / name).is_file() for name in (VIDEO_FILENAME, AUDIO_FILENAME))


async def _persist(song_id: int, stems: Path, duration: float) -> None:
    from karaoke_backend.database import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        await db.execute(update(Song).where(Song.id == song_id).values(
            status="ready", duration=duration, stems_path=str(stems), video_filename=VIDEO_FILENAME,
        ))
        await db.commit()


async def run_cdg_import(ctx: JobContext) -> str:
    from karaoke_backend.api.separate import STEMS_DIR, UPLOADS_DIR
    if ctx.song_id is None:
        raise JobFailure("CD+G import job has no song")
    stems = STEMS_DIR / str(ctx.song_id)
    upload_name = ctx.payload.get("upload_name")
    upload = UPLOADS_DIR / Path(str(upload_name)).name if upload_name else None

    async def progress(value: int, message: str) -> None:
        if not await queue.update_progress(ctx.job_id, ctx.worker_id, phase=JobPhase.IMPORTING.value,
                                           progress=value, message=message):
            raise LeaseLost(ctx.job_id)
    try:
        await progress(0, "Reading the CD+G file")
        if completed(stems):
            video_duration = await asyncio.to_thread(_probe_duration, stems / AUDIO_FILENAME)
            if not await queue.heartbeat(ctx.job_id, ctx.worker_id):
                raise LeaseLost(ctx.job_id)
            await _persist(ctx.song_id, stems, video_duration)
            if upload:
                _unlink(upload)
            await progress(100, "CD+G import complete")
            return "CD+G import complete"
        if upload is None or not upload.is_file():
            raise CdgImportError("The uploaded CD+G file is gone — upload it again.")
        if upload.suffix.lower() not in {".cdg", ".zip"}:
            raise CdgImportError("Upload a bare .cdg or an MP3+G .zip file.")
        cdg, source_audio = await asyncio.to_thread(_prepare_source, upload, stems)
        if source_audio is not None:
            source_duration = await asyncio.to_thread(_probe_duration, source_audio)
            if source_duration > MAX_DECODE_SECONDS:
                raise CdgImportError("The MP3+G audio exceeds the 30-minute single-song limit.")
        await progress(15, "Rendering the karaoke graphics")
        graphics_duration = await asyncio.to_thread(_render, cdg, stems / VIDEO_FILENAME)
        await progress(70, "Preparing the audio track")
        await asyncio.to_thread(_make_audio, source_audio, stems / AUDIO_FILENAME, graphics_duration)
        duration = await asyncio.to_thread(_probe_duration, stems / AUDIO_FILENAME)
        await progress(90, "Saving the song")
        if not await queue.heartbeat(ctx.job_id, ctx.worker_id):
            raise LeaseLost(ctx.job_id)
        await _persist(ctx.song_id, stems, duration)
        _unlink(upload)
        if source_audio:
            _unlink(source_audio)
        await progress(100, "CD+G import complete")
        return "CD+G import complete"
    except LeaseLost:
        raise
    except CdgImportError as exc:
        raise JobFailure(str(exc)) from exc


def _probe_duration(path: Path) -> float:
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
    # Even ffprobe's output is derived from caller media. Disk-backed streams
    # keep a corrupt file from amplifying diagnostics into process memory.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try:
            proc = subprocess.run(
                cmd,
                stdout=output,
                stderr=errors,
                timeout=_PROBE_TIMEOUT,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            raise CdgImportError(
                "ffprobe could not read the prepared audio track."
            ) from exc
        output.seek(0)
        raw_duration = output.read(128)
        too_much_output = bool(output.read(1))
        try:
            duration = float(raw_duration.strip())
        except (ValueError, TypeError) as exc:
            raise CdgImportError(
                "The prepared audio track has no usable duration."
            ) from exc
        if (
            proc.returncode
            or too_much_output
            or not math.isfinite(duration)
            or duration <= 0
        ):
            if proc.returncode:
                logger.error("ffprobe failed during CD+G import: %s", _tail(errors))
            raise CdgImportError("The prepared audio track has no usable duration.")
    return duration
