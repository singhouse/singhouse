# SPDX-License-Identifier: MIT
"""HeartTranscriber delivers child stderr lines while the child runs.

The fake child exposes only pipes: ``communicate`` fails the test, as partial
output from it is not available on every platform.
"""
import io
import json
import os
import subprocess
import sys
import threading

import pytest

from lyricsync.transcription import heart as heart_mod
from lyricsync.transcription.heart import HeartTranscriber


class FakeChild:
    """A running child whose stderr the test writes to and whose exit it controls."""

    pid = 999999

    def __init__(self, stdout_text):
        read_fd, self._write_fd = os.pipe()
        self.stderr = io.TextIOWrapper(io.FileIO(read_fd, "r"), encoding="utf-8")
        self.stdout = io.StringIO(stdout_text)
        self.exited = threading.Event()
        self.returncode = None
        self.killed = False

    def write_stderr(self, text):
        os.write(self._write_fd, text.encode())

    def exit(self, code=0):
        if self._write_fd is not None:
            os.close(self._write_fd)
            self._write_fd = None
        self.returncode = code
        self.exited.set()

    def poll(self):
        return self.returncode if self.exited.is_set() else None

    def wait(self, timeout=None):
        if not self.exited.wait(timeout):
            raise subprocess.TimeoutExpired("fake", timeout)
        return self.returncode

    def kill(self):
        self.killed = True
        self.exit(-9)

    def communicate(self, timeout=None):
        raise AssertionError("stderr streaming must not depend on communicate()")


@pytest.fixture
def child_factory(monkeypatch, tmp_path):
    created = []

    def install(stdout_text=json.dumps({"segments": []})):
        child = FakeChild(stdout_text)
        created.append(child)
        monkeypatch.setattr(heart_mod.subprocess, "Popen", lambda *args, **kwargs: child)
        return child

    def kill_group(pid, sig):
        for child in created:
            if child.pid == pid:
                child.kill()

    def taskkill(*args, **kwargs):
        for child in created:
            child.kill()
        return subprocess.CompletedProcess(args, 0)

    # Never signal a real process group from the fake child.
    if os.name == "posix":
        monkeypatch.setattr(heart_mod.os, "killpg", kill_group)
    else:
        monkeypatch.setattr(heart_mod.subprocess, "run", taskkill)
    yield install
    for child in created:
        if not child.exited.is_set():
            child.exit()
        child.stderr.close()


def transcriber(tmp_path, lines, **options):
    script = tmp_path / "worker.py"
    script.touch()
    return HeartTranscriber(sys.executable, script, use_vad=False, on_stderr_line=lines.append, **options)


def test_lines_arrive_before_the_child_exits_without_partial_output(child_factory, tmp_path):
    large = json.dumps({"segments": [], "full_text": "x" * (4 * 1024 * 1024)})
    child = child_factory(large)
    lines = []

    def on_line(line):
        lines.append(line)
        if line == "DEVICE cpu":
            # Exit only after the notice was delivered, so delivery is mid-run.
            child.exit(0)

    script = tmp_path / "worker.py"
    script.touch()
    worker = HeartTranscriber(sys.executable, script, use_vad=False, timeout=20, on_stderr_line=on_line)
    child.write_stderr("loading\r50%\rDEVICE cpu\n")
    result = worker.transcribe("audio.wav")
    assert lines == ["loading", "50%", "DEVICE cpu"]
    assert result.full_text == "x" * (4 * 1024 * 1024)


def test_cancel_still_delivers_lines_read_before_termination(child_factory, tmp_path):
    child = child_factory()
    lines = []
    cancel = threading.Event()
    worker = transcriber(tmp_path, lines, timeout=20, cancel_event=cancel)

    original = worker._deliver

    def deliver(line):
        original(line)
        if line == "DEVICE cpu":
            cancel.set()

    worker._deliver = deliver
    child.write_stderr("DEVICE cpu\n")
    with pytest.raises(RuntimeError, match="cancelled"):
        worker.transcribe("audio.wav")
    assert lines == ["DEVICE cpu"]
    assert child.killed


def test_timeout_delivers_lines_and_reaps_without_communicate(child_factory, tmp_path):
    child = child_factory()
    lines = []
    worker = transcriber(tmp_path, lines, timeout=0.5)
    child.write_stderr("DEVICE cpu\nwaiting")
    with pytest.raises(subprocess.TimeoutExpired):
        worker.transcribe("audio.wav")
    # The unterminated tail is delivered once the pipe closes on termination.
    assert lines == ["DEVICE cpu", "waiting"]
    assert child.killed


def test_failing_callback_does_not_fail_transcription(child_factory, tmp_path):
    child = child_factory()

    def broken(line):
        raise ValueError("notice sink unavailable")

    script = tmp_path / "worker.py"
    script.touch()
    worker = HeartTranscriber(sys.executable, script, use_vad=False, timeout=20, on_stderr_line=broken)
    child.write_stderr("DEVICE cpu\n")
    threading.Timer(0.2, child.exit).start()
    assert worker.transcribe("audio.wav").segments == []


def test_real_child_with_large_stdout_and_stderr_does_not_deadlock(tmp_path):
    script = tmp_path / "worker.py"
    script.write_text(
        "import json, sys\n"
        "for index in range(20000):\n"
        "    sys.stderr.write(f'progress {index}\\r')\n"
        "sys.stderr.write('DEVICE cpu\\n')\n"
        "print(json.dumps({'segments': [], 'full_text': 'y' * (2 * 1024 * 1024)}))\n"
    )
    lines = []
    worker = HeartTranscriber(sys.executable, script, use_vad=False, timeout=60, on_stderr_line=lines.append)
    result = worker.transcribe(str(tmp_path / "audio.wav"))
    assert len(result.full_text) == 2 * 1024 * 1024
    assert lines[0] == "progress 0" and lines[-1] == "DEVICE cpu" and len(lines) == 20001
