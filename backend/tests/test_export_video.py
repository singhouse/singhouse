# SPDX-License-Identifier: AGPL-3.0-only
"""Video export sessions: rendered frames into ffmpeg, or a prepared video
remuxed with the chosen stem.

ffmpeg is replaced by a fake ``Popen`` for the contract tests: it records the
command, collects what is written to stdin, and writes the output file when
waited on. One end-to-end test drives the real ffmpeg when it is installed.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import wave
from pathlib import Path

import pytest
from httpx import AsyncClient

from karaoke_backend.api.auth import require_user
from karaoke_backend.api.identity import SINGLE_HOST_ID, Identity
from karaoke_backend.database import AsyncSessionLocal
from karaoke_backend.export import service, video
from karaoke_backend.main import app
from karaoke_backend.models.song import LyricsSet, Song

_HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None

_WORD_SYNC = {
    "lines": [
        [
            {"text": "Lorem", "start": 0.2, "end": 0.5},
            {"text": "ipsum", "start": 0.6, "end": 0.9},
        ]
    ]
}

JPEG = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"


class FakeStdin:
    def __init__(self, sink: list):
        self.sink = sink
        self.closed = False

    def write(self, data: bytes) -> int:
        if self.closed:
            raise ValueError("write to closed file")
        self.sink.append(data)
        return len(data)

    def close(self) -> None:
        self.closed = True


class FakePopen:
    instances: list["FakePopen"] = []
    exit_code = 0

    def __init__(self, cmd, stdin=None, stdout=None, stderr=None):
        self.cmd = list(cmd)
        self.written: list[bytes] = []
        self.stdin = FakeStdin(self.written) if stdin == subprocess.PIPE else None
        self.returncode = None
        self.killed = False
        FakePopen.instances.append(self)

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            if self.killed:
                self.returncode = -9
            else:
                if FakePopen.exit_code == 0:
                    Path(self.cmd[-1]).write_bytes(b"mp4:" + b"".join(self.written))
                self.returncode = FakePopen.exit_code
        return self.returncode

    def kill(self):
        self.killed = True
        if self.returncode is None:
            self.returncode = -9


@pytest.fixture(autouse=True)
def isolated_sessions(monkeypatch, tmp_path):
    monkeypatch.setattr(video, "TEMP_ROOT", tmp_path / "video-tmp")
    monkeypatch.setattr(video, "_sessions", {})
    yield
    for session in list(video._sessions.values()):
        video._teardown(session, video.CANCELLED)


@pytest.fixture
def fake_ffmpeg(monkeypatch):
    FakePopen.instances = []
    FakePopen.exit_code = 0
    monkeypatch.setattr(video.subprocess, "Popen", FakePopen)

    async def probe(path):
        return 0.1  # three frames at 30 fps

    monkeypatch.setattr(service, "_probe_duration", probe)
    return FakePopen


def _write_wav(path: Path, seconds: float = 1.0) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * int(8000 * seconds))


async def _seed(
    tmp_path: Path,
    *,
    stems: tuple[str, ...] = ("instrumental.wav", "karaoke.wav"),
    video_name: str | None = None,
    word_sync: dict | None = _WORD_SYNC,
    owner_id: int = SINGLE_HOST_ID,
    duration: float | None = None,
) -> int:
    stems_dir = tmp_path / "stems"
    stems_dir.mkdir(exist_ok=True)
    for name in stems:
        _write_wav(stems_dir / name)
    if video_name:
        (stems_dir / video_name).write_bytes(b"prepared-video")
    async with AsyncSessionLocal() as db:
        song = Song(
            owner_id=owner_id,
            artist="Artist",
            title="Title",
            filename="t.mp3",
            status="ready",
            stems_path=str(stems_dir),
            video_filename=video_name,
            duration=duration,
        )
        db.add(song)
        await db.commit()
        if word_sync is not None:
            row = LyricsSet(
                owner_id=owner_id, song_id=song.id, word_sync_json=json.dumps(word_sync)
            )
            db.add(row)
            await db.commit()
            song.active_lyrics_id = row.id
            await db.commit()
        return song.id


def _frames(count: int) -> list:
    return [("frames", (f"f{i}.jpg", io.BytesIO(JPEG), "image/jpeg")) for i in range(count)]


async def _put(client: AsyncClient, session: str, index: int, count: int):
    return await client.put(
        f"/api/export/video/{session}/frames",
        data={"index": str(index)},
        files=_frames(count),
    )


# ---------------------------------------------------------------------------
# Opening a session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_frames_session_starts_ffmpeg_on_stdin(client, tmp_path, fake_ffmpeg):
    song_id = await _seed(tmp_path)
    resp = await client.post(
        f"/api/export/songs/{song_id}/video",
        json={"audio": "instrumental", "fps": 30, "width": 1280, "height": 720},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "frames"
    assert body["duration"] == pytest.approx(0.1)
    assert body["frames_expected"] == 3
    assert isinstance(body["session"], str) and len(body["session"]) >= 16

    cmd = fake_ffmpeg.instances[0].cmd
    assert cmd[:10] == [
        "ffmpeg", "-y", "-f", "image2pipe", "-c:v", "mjpeg",
        "-framerate", "30", "-i", "pipe:0",
    ]
    assert cmd[10:12] == ["-i", str(tmp_path / "stems" / "instrumental.wav")]
    for flag in (["-c:v", "libx264"], ["-preset", "veryfast"], ["-crf", "20"],
                 ["-pix_fmt", "yuv420p"], ["-c:a", "aac"], ["-b:a", "192k"],
                 ["-movflags", "+faststart"]):
        i = cmd.index(flag[0], 12)
        assert cmd[i:i + 2] == flag
    assert "-shortest" in cmd
    assert cmd[-1].endswith(".mp4")
    assert body["session"] not in cmd[-1]

    status = (await client.get(f"/api/export/video/{body['session']}")).json()
    assert status == {"state": "rendering", "received": 0, "frames_expected": 3}


@pytest.mark.asyncio
async def test_frames_session_refuses_missing_stem_like_mp3g(client, tmp_path, fake_ffmpeg):
    song_id = await _seed(tmp_path, stems=("instrumental.wav",))
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"audio": "karaoke"})
    assert resp.status_code == 409
    assert resp.json()["detail"] == "No karaoke mix found for this song; try Instrumental"
    assert fake_ffmpeg.instances == []


@pytest.mark.asyncio
async def test_frames_session_needs_word_sync(client, tmp_path, fake_ffmpeg):
    song_id = await _seed(tmp_path, word_sync=None)
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"audio": "karaoke"})
    assert resp.status_code == 409
    assert fake_ffmpeg.instances == []


@pytest.mark.asyncio
async def test_over_thirty_minutes_is_refused(client, tmp_path, fake_ffmpeg, monkeypatch):
    async def long_probe(path):
        return 30 * 60 + 1.0

    monkeypatch.setattr(service, "_probe_duration", long_probe)
    song_id = await _seed(tmp_path)
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"audio": "karaoke"})
    assert resp.status_code == 409
    assert "30 minutes" in resp.json()["detail"]
    assert fake_ffmpeg.instances == []


@pytest.mark.asyncio
async def test_unknown_and_foreign_songs_are_404(client, tmp_path, fake_ffmpeg):
    assert (await client.post("/api/export/songs/9999/video", json={})).status_code == 404
    foreign = await _seed(tmp_path, owner_id=SINGLE_HOST_ID + 1)
    assert (await client.post(f"/api/export/songs/{foreign}/video", json={})).status_code == 404


@pytest.mark.asyncio
async def test_only_the_720p_30fps_shape_is_accepted(client, tmp_path, fake_ffmpeg):
    song_id = await _seed(tmp_path)
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"fps": 60})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_prepared_video_is_remuxed_with_the_chosen_stem(client, tmp_path, fake_ffmpeg):
    song_id = await _seed(tmp_path, video_name="video.mp4", word_sync=None)
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"audio": "karaoke"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "remux"
    assert body["ready"] in (True, False)

    session = video._sessions[body["session"]]
    await session.task
    stems = tmp_path / "stems"
    cmd = fake_ffmpeg.instances[0].cmd
    assert cmd == [
        "ffmpeg", "-y", "-i", str(stems / "video.mp4"), "-i", str(stems / "karaoke.wav"),
        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-movflags", "+faststart", cmd[-1],
    ]
    status = (await client.get(f"/api/export/video/{body['session']}")).json()
    assert status["state"] == "ready"
    assert status["filename"].endswith(" - Artist - Title.mp4")

    file = await client.get(f"/api/export/video/{body['session']}/file")
    assert file.status_code == 200
    assert "Artist - Title.mp4" in file.headers["content-disposition"]


@pytest.mark.asyncio
async def test_prepared_video_without_stems_is_copied_unchanged(client, tmp_path, fake_ffmpeg):
    song_id = await _seed(tmp_path, stems=(), video_name="video.mp4", word_sync=None)
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"audio": "karaoke"})
    assert resp.status_code == 200, resp.text
    token = resp.json()["session"]
    await video._sessions[token].task
    assert fake_ffmpeg.instances == []
    file = await client.get(f"/api/export/video/{token}/file")
    assert file.status_code == 200
    assert file.content == b"prepared-video"


@pytest.mark.asyncio
async def test_prepared_video_refuses_a_missing_requested_stem(client, tmp_path, fake_ffmpeg):
    song_id = await _seed(tmp_path, stems=("instrumental.wav",), video_name="video.mp4")
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"audio": "karaoke"})
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Frames, finish, file, cancel
# ---------------------------------------------------------------------------


async def _open(client, tmp_path) -> str:
    song_id = await _seed(tmp_path)
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"audio": "karaoke"})
    assert resp.status_code == 200, resp.text
    return resp.json()["session"]


@pytest.mark.asyncio
async def test_frames_are_accepted_in_order_and_out_of_order_is_409(client, tmp_path, fake_ffmpeg):
    token = await _open(client, tmp_path)
    first = await _put(client, token, 0, 2)
    assert first.status_code == 200
    assert first.json() == {"received": 2}

    replay = await _put(client, token, 0, 1)
    assert replay.status_code == 409
    skip = await _put(client, token, 3, 1)
    assert skip.status_code == 409

    last = await _put(client, token, 2, 1)
    assert last.json() == {"received": 3}
    assert fake_ffmpeg.instances[0].written == [JPEG, JPEG, JPEG]

    extra = await _put(client, token, 3, 1)
    assert extra.status_code == 409


@pytest.mark.asyncio
async def test_trailing_frames_after_ffmpeg_finished_are_accepted(client, tmp_path, fake_ffmpeg):
    token = await _open(client, tmp_path)
    proc = fake_ffmpeg.instances[0]
    await _put(client, token, 0, 2)

    def closed_pipe(data):
        raise BrokenPipeError("ffmpeg finished at the end of the audio")

    proc.wait()  # ffmpeg ended cleanly and wrote the file
    proc.stdin.write = closed_pipe
    resp = await _put(client, token, 2, 1)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"received": 3}
    done = await client.post(f"/api/export/video/{token}/finish")
    assert done.status_code == 200, done.text


@pytest.mark.asyncio
async def test_frames_after_ffmpeg_failed_are_refused(client, tmp_path, fake_ffmpeg):
    fake_ffmpeg.exit_code = 1
    token = await _open(client, tmp_path)
    proc = fake_ffmpeg.instances[0]
    proc.wait()

    def closed_pipe(data):
        raise BrokenPipeError("ffmpeg exited")

    proc.stdin.write = closed_pipe
    resp = await _put(client, token, 0, 1)
    assert resp.status_code == 409
    assert (await client.get(f"/api/export/video/{token}")).json()["state"] == "failed"


@pytest.mark.asyncio
async def test_non_jpeg_frames_are_refused(client, tmp_path, fake_ffmpeg):
    token = await _open(client, tmp_path)
    resp = await client.put(
        f"/api/export/video/{token}/frames",
        data={"index": "0"},
        files=[("frames", ("f.png", io.BytesIO(b"\x89PNG"), "image/png"))],
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_finish_produces_the_file(client, tmp_path, fake_ffmpeg):
    token = await _open(client, tmp_path)
    early = await client.post(f"/api/export/video/{token}/finish")
    assert early.status_code == 409

    await _put(client, token, 0, 3)
    resp = await client.post(f"/api/export/video/{token}/finish")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ready"] is True
    assert body["filename"].endswith(" - Artist - Title.mp4")
    assert body["bytes"] == len(b"mp4:" + JPEG * 3)
    assert fake_ffmpeg.instances[0].stdin.closed

    session = video._sessions[token]
    assert session.output.is_file()
    assert session.output.parent.parent == tmp_path / "video-tmp"

    status = (await client.get(f"/api/export/video/{token}")).json()
    assert status["state"] == "ready"
    assert status["filename"] == body["filename"]

    file = await client.get(f"/api/export/video/{token}/file")
    assert file.status_code == 200
    assert file.headers["content-type"] == "video/mp4"
    assert file.content == b"mp4:" + JPEG * 3
    assert "Artist - Title.mp4" in file.headers["content-disposition"]
    assert session.downloaded_at is not None


@pytest.mark.asyncio
async def test_failed_encode_is_500_without_ffmpeg_output(client, tmp_path, fake_ffmpeg):
    fake_ffmpeg.exit_code = 1
    token = await _open(client, tmp_path)
    video._sessions[token].stderr_path.write_text("secret-ffmpeg-detail")
    await _put(client, token, 0, 3)
    resp = await client.post(f"/api/export/video/{token}/finish")
    assert resp.status_code == 500
    assert "secret-ffmpeg-detail" not in resp.text
    assert (await client.get(f"/api/export/video/{token}")).json()["state"] == "failed"


@pytest.mark.asyncio
async def test_cancel_kills_ffmpeg_and_removes_files(client, tmp_path, fake_ffmpeg):
    token = await _open(client, tmp_path)
    await _put(client, token, 0, 1)
    workdir = video._sessions[token].workdir
    assert workdir.is_dir()

    resp = await client.delete(f"/api/export/video/{token}")
    assert resp.status_code == 204
    assert fake_ffmpeg.instances[0].killed
    assert not workdir.exists()
    assert (await client.get(f"/api/export/video/{token}")).status_code == 404
    assert (await _put(client, token, 1, 1)).status_code == 404


@pytest.mark.asyncio
async def test_another_user_gets_404(client, tmp_path, fake_ffmpeg):
    token = await _open(client, tmp_path)
    app.dependency_overrides[require_user] = lambda: Identity(id=SINGLE_HOST_ID + 1)
    try:
        assert (await client.get(f"/api/export/video/{token}")).status_code == 404
        assert (await _put(client, token, 0, 1)).status_code == 404
        assert (await client.post(f"/api/export/video/{token}/finish")).status_code == 404
        assert (await client.get(f"/api/export/video/{token}/file")).status_code == 404
        assert (await client.delete(f"/api/export/video/{token}")).status_code == 404
    finally:
        app.dependency_overrides.pop(require_user, None)
    assert token in video._sessions
    assert not fake_ffmpeg.instances[0].killed


@pytest.mark.asyncio
async def test_idle_sessions_and_fetched_files_are_cleaned_up(client, tmp_path, fake_ffmpeg):
    idle = await _open(client, tmp_path)
    idle_dir = video._sessions[idle].workdir

    done = await _open(client, tmp_path)
    await _put(client, done, 0, 3)
    await client.post(f"/api/export/video/{done}/finish")
    await client.get(f"/api/export/video/{done}/file")
    done_session = video._sessions[done]

    now = video._sessions[idle].last_activity
    video.reap(now + video.INACTIVITY_SECONDS - 1)
    assert idle in video._sessions and done in video._sessions

    video.reap(now + video.INACTIVITY_SECONDS + 1)
    assert idle not in video._sessions
    assert not idle_dir.exists()
    assert fake_ffmpeg.instances[0].killed

    video.reap(done_session.downloaded_at + video.RETENTION_AFTER_DOWNLOAD_SECONDS + 1)
    assert done not in video._sessions
    assert not done_session.workdir.exists()


# ---------------------------------------------------------------------------
# Real ffmpeg
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.skipif(not _HAVE_FFMPEG, reason="ffmpeg not installed")
async def test_real_ffmpeg_encodes_jpeg_frames_with_audio(client, tmp_path):
    Image = pytest.importorskip("PIL.Image")
    song_id = await _seed(tmp_path)
    resp = await client.post(f"/api/export/songs/{song_id}/video", json={"audio": "karaoke"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    token, count = body["session"], body["frames_expected"]
    assert count == 30

    buf = io.BytesIO()
    Image.new("RGB", (1280, 720), (20, 10, 30)).save(buf, "JPEG", quality=92)
    frame = buf.getvalue()
    for start in range(0, count, 10):
        files = [("frames", (f"{i}.jpg", io.BytesIO(frame), "image/jpeg")) for i in range(10)]
        put = await client.put(
            f"/api/export/video/{token}/frames", data={"index": str(start)}, files=files
        )
        assert put.status_code == 200, put.text

    done = await client.post(f"/api/export/video/{token}/finish")
    assert done.status_code == 200, done.text
    out = video._sessions[token].output
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height",
         "-of", "json", str(out)],
        capture_output=True, text=True, check=True,
    )
    streams = json.loads(probe.stdout)["streams"]
    codecs = {s["codec_name"] for s in streams}
    assert codecs == {"h264", "aac"}
    picture = next(s for s in streams if s["codec_name"] == "h264")
    assert (picture["width"], picture["height"]) == (1280, 720)
