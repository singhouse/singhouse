# SPDX-License-Identifier: AGPL-3.0-only
"""Video export sessions: the client renders frames, ffmpeg encodes them.

A session belongs to the user who opened it and lives in an in-memory
registry keyed by a random token. Two kinds exist:

* ``frames`` — ffmpeg reads JPEG frames from stdin and muxes them with the
  chosen audio stem into an MP4. Frames arrive in order, in batches, and each
  one is written straight to ffmpeg's stdin; nothing is held beyond the
  request body that carried it.
* ``remux`` — the song already has its own prepared video. Its picture is
  kept as it is and paired with the chosen stem (or, for a song with no stems
  at all, the file is copied unchanged). This completes on its own.

Every session has a temp directory of its own. A session idle for
``INACTIVITY_SECONDS`` is cancelled and its files removed; a finished file is
removed ``RETENTION_AFTER_DOWNLOAD_SECONDS`` after it was first fetched.
Session tokens never appear in logs; the temp directories are not named
after them either.

Failures raise the typed exceptions from ``export.service`` so the router
maps them exactly like the other export routes.
"""

from __future__ import annotations

import asyncio
import logging
import math
import secrets
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from karaoke_backend.export import service
from karaoke_backend.models.song import Song

logger = logging.getLogger(__name__)

MAX_DURATION_SECONDS = 30 * 60
INACTIVITY_SECONDS = 10 * 60
RETENTION_AFTER_DOWNLOAD_SECONDS = 10 * 60
REAP_INTERVAL_SECONDS = 30
FINISH_TIMEOUT_SECONDS = 10 * 60
REMUX_TIMEOUT_SECONDS = 10 * 60
AUDIO_BITRATE = "192k"

# Where session temp directories are created; None is the system temp dir.
TEMP_ROOT: Optional[Path] = None

RENDERING = "rendering"
ENCODING = "encoding"
READY = "ready"
FAILED = "failed"
CANCELLED = "cancelled"


class SessionNotFound(service.ExportNotFound):
    """No such session for this user."""


@dataclass
class VideoSession:
    token: str
    owner_id: int
    song_id: int
    mode: str
    workdir: Path
    output: Path
    filename: str
    media_type: str = "video/mp4"
    fps: int = 30
    duration: Optional[float] = None
    frames_expected: int = 0
    received: int = 0
    state: str = RENDERING
    proc: Optional[subprocess.Popen] = None
    stderr_path: Optional[Path] = None
    task: Optional[asyncio.Task] = None
    last_activity: float = field(default_factory=time.monotonic)
    downloaded_at: Optional[float] = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def status(self) -> dict:
        body = {
            "state": self.state,
            "received": self.received,
            "frames_expected": self.frames_expected,
        }
        if self.state == READY:
            body["filename"] = self.filename
        return body


_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}

_sessions: dict[str, VideoSession] = {}
_reaper: Optional[asyncio.Task] = None


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def get_session(token: str, owner_id: int) -> VideoSession:
    """The caller's session; another user's is indistinguishable from none."""
    session = _sessions.get(token)
    if session is None or session.owner_id != owner_id:
        raise SessionNotFound("Export session not found")
    return session


def _register(session: VideoSession) -> None:
    global _reaper
    _sessions[session.token] = session
    if _reaper is None or _reaper.done():
        _reaper = asyncio.get_running_loop().create_task(_reap_loop())


async def _reap_loop() -> None:
    while _sessions:
        await asyncio.sleep(REAP_INTERVAL_SECONDS)
        try:
            expired = _collect_expired()
            if expired:
                await asyncio.to_thread(_release_all, expired)
        except Exception:
            logger.exception("video export cleanup failed")


def _collect_expired(now: Optional[float] = None) -> list[VideoSession]:
    """Unregister idle sessions and fetched files past their retention.

    Runs on the event loop and never blocks; the returned sessions still
    need ``_release`` to stop ffmpeg and remove their files.
    """
    now = time.monotonic() if now is None else now
    expired_sessions = []
    for token, session in list(_sessions.items()):
        if session.downloaded_at is not None:
            expired = now - session.downloaded_at >= RETENTION_AFTER_DOWNLOAD_SECONDS
        elif session.state == ENCODING:
            # Actively encoding; the encode carries its own deadline.
            expired = False
        else:
            expired = now - session.last_activity >= INACTIVITY_SECONDS
        if expired:
            _begin_teardown(session, CANCELLED)
            _sessions.pop(token, None)
            expired_sessions.append(session)
    return expired_sessions


def reap(now: Optional[float] = None) -> None:
    """Cancel idle sessions and drop finished files past their retention."""
    _release_all(_collect_expired(now))


def _release_all(sessions: list[VideoSession]) -> None:
    for session in sessions:
        _release(session)


def _kill(session: VideoSession) -> None:
    proc = session.proc
    if proc is not None and proc.poll() is None:
        try:
            proc.kill()
            proc.wait(timeout=10)
        except (OSError, subprocess.SubprocessError):
            logger.warning("could not stop ffmpeg for a song %s export", session.song_id)


def _begin_teardown(session: VideoSession, state: str) -> None:
    """The event-loop half of a teardown: mark the state, cancel the task."""
    # The state changes first, so work interrupted later sees why.
    session.state = state
    if session.task is not None and not session.task.done():
        session.task.cancel()


def _release(session: VideoSession) -> None:
    """The blocking half of a teardown: stop ffmpeg and remove the files."""
    _kill(session)
    if session.proc is not None and session.proc.stdin is not None:
        try:
            session.proc.stdin.close()
        except (OSError, ValueError):
            pass
    shutil.rmtree(session.workdir, ignore_errors=True)


def _teardown(session: VideoSession, state: str) -> None:
    _begin_teardown(session, state)
    _release(session)


async def cancel(token: str, owner_id: int) -> None:
    """Stop any ffmpeg work and delete the session's files."""
    session = get_session(token, owner_id)
    _begin_teardown(session, CANCELLED)
    _sessions.pop(token, None)
    await asyncio.to_thread(_release, session)


def _stderr_tail(session: VideoSession) -> str:
    try:
        return session.stderr_path.read_bytes()[-2000:].decode(errors="replace")
    except (OSError, AttributeError):
        return ""


# ---------------------------------------------------------------------------
# Opening a session
# ---------------------------------------------------------------------------


def _video_path(song: Song) -> Optional[Path]:
    """The song's prepared video on disk, or None (same rules as playback)."""
    name = song.video_filename
    if not name or name != Path(name).name:
        return None
    path = service._stems_dir(song) / name
    return path if path.is_file() else None


def _new_workdir() -> Path:
    root = TEMP_ROOT
    if root is not None:
        root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="video-export-", dir=root))


async def open_session(
    db: AsyncSession,
    *,
    song_id: int,
    owner_id: int,
    audio: str,
    lyrics_set_id: Optional[int],
    fps: int,
) -> dict:
    song = (
        await db.execute(
            select(Song).where(Song.id == song_id, Song.owner_id == owner_id)
        )
    ).scalar_one_or_none()
    if song is None:
        raise service.ExportNotFound(f"Song {song_id} not found")
    if song.status != "ready":
        raise service.ExportConflict(
            f"Song {song_id} is not ready yet (status: {song.status})"
        )

    base = service.filename_base(song.id, song.artist, song.title)
    stems_dir = service._stems_dir(song)
    video = _video_path(song)

    if video is not None:
        has_stems = service._find_audio(stems_dir, None) is not None
        stem: Optional[Path] = None
        if has_stems:
            stem = service._find_audio(stems_dir, audio)
            if stem is None:
                raise service.ExportConflict(service.missing_stem_message(audio))
        return await _open_remux(song, owner_id, base, video, stem)

    # A rendered video draws the song's lyrics; refuse a song without them,
    # and refuse a named lyrics set that is not this song's.
    await service._resolve_word_sync(db, song, lyrics_set_id)
    stem = service._find_audio(stems_dir, audio)
    if stem is None:
        raise service.ExportConflict(service.missing_stem_message(audio))
    duration = await service._probe_duration(stem)
    if duration is None:
        duration = song.duration
    if duration is None or duration <= 0:
        raise service.ExportConflict("Song duration is unknown; cannot render a video")
    if duration > MAX_DURATION_SECONDS:
        raise service.ExportConflict(
            "Video export is limited to songs of 30 minutes or less"
        )
    return await _open_frames(song, owner_id, base, stem, duration, fps)


async def _open_frames(
    song: Song, owner_id: int, base: str, stem: Path, duration: float, fps: int
) -> dict:
    workdir = _new_workdir()
    output = workdir / "video.mp4"
    stderr_path = workdir / "ffmpeg.log"
    cmd = [
        "ffmpeg", "-y",
        "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", str(fps), "-i", "pipe:0",
        "-i", str(stem),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", AUDIO_BITRATE,
        "-shortest", "-movflags", "+faststart",
        str(output),
    ]
    try:
        with open(stderr_path, "wb") as errors:
            proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors
            )
    except OSError as exc:
        shutil.rmtree(workdir, ignore_errors=True)
        logger.error("ffmpeg could not start for a song %s video export: %s", song.id, exc)
        raise service.ExportConflict("Video export needs ffmpeg") from exc

    session = VideoSession(
        token=secrets.token_urlsafe(24),
        owner_id=owner_id,
        song_id=song.id,
        mode="frames",
        workdir=workdir,
        output=output,
        filename=f"{base}.mp4",
        fps=fps,
        duration=duration,
        frames_expected=max(1, math.ceil(duration * fps)),
        proc=proc,
        stderr_path=stderr_path,
    )
    _register(session)
    return {
        "session": session.token,
        "mode": "frames",
        "duration": duration,
        "frames_expected": session.frames_expected,
    }


async def _open_remux(
    song: Song, owner_id: int, base: str, video: Path, stem: Optional[Path]
) -> dict:
    workdir = _new_workdir()
    if stem is None:
        # Copied unchanged, so the file keeps its own container and suffix.
        suffix = video.suffix.lower() or ".mp4"
    else:
        suffix = ".mp4"
    output = workdir / f"video{suffix}"
    session = VideoSession(
        token=secrets.token_urlsafe(24),
        owner_id=owner_id,
        song_id=song.id,
        mode="remux",
        workdir=workdir,
        output=output,
        filename=f"{base}{suffix}",
        media_type=_MEDIA_TYPES.get(suffix, "application/octet-stream"),
        stderr_path=workdir / "ffmpeg.log",
        state=ENCODING,
    )
    _register(session)
    session.task = asyncio.get_running_loop().create_task(
        _run_remux(session, video, stem)
    )
    # Let a quick copy finish before answering.
    await asyncio.sleep(0)
    return {"session": session.token, "mode": "remux", "ready": session.state == READY}


def _remux_blocking(session: VideoSession, video: Path, stem: Optional[Path]) -> bool:
    if stem is None:
        shutil.copyfile(video, session.output)
        return True
    cmd = [
        "ffmpeg", "-y", "-i", str(video), "-i", str(stem),
        "-map", "0:v", "-map", "1:a",
        "-c:v", "copy", "-c:a", "aac", "-b:a", AUDIO_BITRATE,
        "-shortest", "-movflags", "+faststart",
        str(session.output),
    ]
    with open(session.stderr_path, "wb") as errors:
        session.proc = subprocess.Popen(
            cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors
        )
    try:
        code = session.proc.wait(timeout=REMUX_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        _kill(session)
        return False
    return code == 0 and session.output.is_file()


async def _run_remux(session: VideoSession, video: Path, stem: Optional[Path]) -> None:
    try:
        ok = await asyncio.to_thread(_remux_blocking, session, video, stem)
    except asyncio.CancelledError:
        raise
    except OSError as exc:
        logger.error("video remux failed for song %s: %s", session.song_id, exc)
        ok = False
    if session.state == CANCELLED:
        return
    if ok:
        session.state = READY
    else:
        logger.error(
            "ffmpeg video remux failed for song %s: %s",
            session.song_id, _stderr_tail(session),
        )
        session.state = FAILED
    session.touch()


# ---------------------------------------------------------------------------
# Frames
# ---------------------------------------------------------------------------


async def write_frames(
    token: str, owner_id: int, index: int, frames: list
) -> dict:
    """Write one in-order batch of JPEG frames to ffmpeg.

    ``frames`` are file-like objects with an async ``read()`` (UploadFile).
    Each is read and written on its own, so at most one frame is in hand.
    """
    session = get_session(token, owner_id)
    if session.mode != "frames":
        raise service.ExportConflict("This export does not take frames")
    async with session.lock:
        if session.state != RENDERING:
            raise service.ExportConflict(f"This export is {session.state}")
        if index != session.received:
            raise service.ExportConflict(
                f"Expected frame {session.received}, got {index}"
            )
        if session.received + len(frames) > session.frames_expected:
            raise service.ExportConflict("More frames than the video needs")
        stdin = session.proc.stdin
        for upload in frames:
            data = await upload.read()
            if not data.startswith(b"\xff\xd8"):
                raise service.ExportConflict("Frames must be JPEG images")
            try:
                await asyncio.to_thread(stdin.write, data)
            except (OSError, ValueError) as exc:
                if session.state == RENDERING and await asyncio.to_thread(
                    _exited_cleanly, session.proc
                ):
                    # The audio ran out first and ffmpeg already finished
                    # the file (-shortest); the trailing frames are not needed.
                    session.received += 1
                    session.touch()
                    continue
                if session.state != CANCELLED:
                    session.state = FAILED
                    logger.error(
                        "ffmpeg stopped taking frames for song %s: %s",
                        session.song_id, _stderr_tail(session),
                    )
                raise service.ExportConflict("Video encoding stopped") from exc
            session.received += 1
            session.touch()
        return {"received": session.received}


def _exited_cleanly(proc: subprocess.Popen) -> bool:
    try:
        return proc.wait(timeout=5) == 0
    except subprocess.TimeoutExpired:
        return False


def _finish_blocking(session: VideoSession) -> int:
    proc = session.proc
    try:
        proc.stdin.close()
    except OSError:
        pass
    try:
        return proc.wait(timeout=FINISH_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        _kill(session)
        return -1


async def finish(token: str, owner_id: int) -> dict:
    session = get_session(token, owner_id)
    if session.mode != "frames":
        raise service.ExportConflict("This export finishes on its own")
    async with session.lock:
        if session.state == READY:
            return _ready_body(session)
        if session.state != RENDERING:
            raise service.ExportConflict(f"This export is {session.state}")
        if session.received != session.frames_expected:
            raise service.ExportConflict(
                f"{session.frames_expected - session.received} frames have not arrived"
            )
        session.state = ENCODING
        session.touch()
        code = await asyncio.to_thread(_finish_blocking, session)
        session.touch()
        if session.state == CANCELLED:
            raise service.ExportConflict("This export was cancelled")
        if code != 0 or not session.output.is_file():
            session.state = FAILED
            logger.error(
                "ffmpeg video encode failed for song %s: %s",
                session.song_id, _stderr_tail(session),
            )
            raise VideoEncodeFailed("Video encoding failed")
        session.state = READY
        return _ready_body(session)


class VideoEncodeFailed(service.ExportError):
    """ffmpeg did not produce the file; details are in the server log."""


def _ready_body(session: VideoSession) -> dict:
    return {
        "ready": True,
        "filename": session.filename,
        "bytes": session.output.stat().st_size,
    }


def status(token: str, owner_id: int) -> dict:
    session = get_session(token, owner_id)
    session.touch()
    return session.status()


def ready_file(token: str, owner_id: int) -> VideoSession:
    """The finished session, marked as fetched for retention."""
    session = get_session(token, owner_id)
    if session.state != READY or not session.output.is_file():
        raise service.ExportConflict("The video is not ready")
    session.touch()
    if session.downloaded_at is None:
        session.downloaded_at = time.monotonic()
    return session
