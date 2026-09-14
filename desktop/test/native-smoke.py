# SPDX-License-Identifier: AGPL-3.0-only
"""Exercise an assembled native payload using only bundled runtime resources.

Run with Python: native-smoke.py --native /path/to/native [--copy].
Only generated media and temporary libraries are used. This verifies HTTP media
delivery, not physical audio output, projector behavior, or OS installation.
"""

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class Backend:
    def __init__(self, native, data, cwd):
        executable = native / ("python/python.exe" if os.name == "nt" else "python/bin/python3")
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "COMSPEC")
               if key in os.environ}
        env.update({"PATH": "",
                    "TMP": str(cwd), "TEMP": str(cwd), "TMPDIR": str(cwd)})
        self.log = tempfile.TemporaryFile()
        self.process = subprocess.Popen(
            [str(executable), "-I", "-B", str(native / "backend.py"),
             "--native", str(native), "--runtime", str(data)],
            cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.log, start_new_session=os.name != "nt")
        self.lines = queue.Queue()
        threading.Thread(target=lambda: self.lines.put(self.process.stdout.readline()),
                         daemon=True).start()
        self.http = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def ready(self):
        try:
            line = self.lines.get(timeout=45)
        except queue.Empty:
            raise RuntimeError("Native backend readiness timed out") from None
        require(bool(line), "Native backend exited before readiness")
        self.handshake = json.loads(line)
        self.origin = self.handshake["origin"]
        require(self.origin.startswith("http://127.0.0.1:"), "Backend is not loopback-only")
        # The announcement is emitted by a lifespan hook, just before uvicorn
        # begins accepting connections. Confirm the nonce over HTTP as the
        # desktop parent does instead of racing the listening socket.
        deadline = time.monotonic() + 15
        while True:
            try:
                response = json.loads(self.request("/desktop-ready"))
                require(response["nonce"] == self.handshake["nonce"],
                        "Readiness nonce did not match the owned process")
                break
            except urllib.error.URLError:
                require(time.monotonic() < deadline, "Owned backend did not accept connections")
                time.sleep(0.05)

    def request(self, path, *, data=None, headers=None, expected=200):
        request = urllib.request.Request(self.origin + path, data=data, headers=headers or {})
        try:
            response = self.http.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            require(response.status == expected,
                    f"Unexpected HTTP status {response.status} for {path}; expected {expected}")
            return body

    def login(self):
        self.request("/api/auth/gate", data=json.dumps({
            "password": self.handshake["password"]}).encode(),
            headers={"Content-Type": "application/json", "Origin": self.origin})

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                os.killpg(self.process.pid, signal.SIGKILL)
            else:
                self.process.kill()
            self.process.wait(timeout=5)
            raise RuntimeError("Native backend did not exit after parent pipe closed")
        finally:
            self.process.stdout.close()
            self.log.close()


def exercise(native, temporary):
    cwd = temporary / "empty-home"
    cwd.mkdir()
    data = temporary / "library"
    python = native / ("python/python.exe" if os.name == "nt" else "python/bin/python3")
    probe = subprocess.run([str(python), "-I", "-B", "-c",
        "import importlib.util; assert all(importlib.util.find_spec(p) is None "
        "for p in ('torch', 'faster_whisper', 'ctranslate2', 'transformers'))"],
        cwd=cwd, capture_output=True, timeout=20)
    require(probe.returncode == 0, "Base payload includes local AI dependencies")
    ffmpeg = native / "ffmpeg/bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    video = temporary / "Synthetic - Native smoke.mp4"
    result = subprocess.run([str(ffmpeg), "-nostdin", "-v", "error", "-f", "lavfi",
        "-i", "color=c=blue:s=320x180:r=25", "-f", "lavfi", "-i",
        "sine=frequency=220:sample_rate=48000", "-t", "2", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-c:a", "aac", str(video)],
        cwd=cwd, capture_output=True, timeout=30)
    require(result.returncode == 0, "Bundled FFmpeg could not generate the synthetic fixture")
    first = Backend(native, data, cwd)
    try:
        first.ready()
        first.request("/api/songs", expected=401)
        first.request("/health", headers={"Host": "foreign.invalid"}, expected=403)
        first.request("/health", headers={"Origin": "https://foreign.invalid"}, expected=403)
        first.request("/health")
        first.login()
        first.request("/api/songs")
        settings = (data / "settings.json").read_bytes()
        boundary = "NativeSmokeSyntheticBoundary"
        multipart = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                     f"filename=\"{video.name}\"\r\nContent-Type: video/mp4\r\n\r\n").encode()
        multipart += video.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        submitted = json.loads(first.request("/api/import/video", data=multipart,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                     "Origin": first.origin}, expected=202))
        song_id = submitted["song_id"]
        deadline = time.monotonic() + 60
        while True:
            song = json.loads(first.request(f"/api/songs/{song_id}"))
            if song["status"] == "ready":
                break
            require(song["status"] != "failed", "Synthetic prepared-video import failed")
            require(time.monotonic() < deadline, "Synthetic prepared-video import timed out")
            time.sleep(0.25)
        require(bool(first.request(song["video_url"])), "Video delivery was empty")
        stem = first.request(song["stems"]["instrumental"])
        require(stem[:4] == b"fLaC", "Instrumental delivery was not FLAC audio")
        decoded = subprocess.run([str(ffmpeg), "-nostdin", "-v", "error", "-i",
            "pipe:0", "-f", "s16le", "pipe:1"], input=stem,
            capture_output=True, timeout=20)
        require(decoded.returncode == 0 and len(decoded.stdout) > 48000,
                "Delivered instrumental could not be decoded by bundled FFmpeg")
        second = Backend(native, data, cwd)
        try:
            second.process.wait(timeout=15)
            require(second.process.returncode != 0, "Concurrent library owner was accepted")
            second.log.seek(0)
            require(b"already open" in second.log.read(), "Second backend did not reject the library lock")
        finally:
            second.close()
    finally:
        first.close()
    require(data.is_dir(), "Shutdown deleted the persistent library")
    restarted = Backend(native, data, cwd)
    try:
        restarted.ready()
        require((data / "settings.json").read_bytes() == settings,
                "Restart changed persistent settings or session secret")
        restarted.request("/api/songs", expected=401)
        restarted.login()
        restored = json.loads(restarted.request(f"/api/songs/{song_id}"))
        require(restored["status"] == "ready", "Restart lost the prepared song")
        require(bool(restarted.request(restored["video_url"])), "Restart lost prepared media")
    finally:
        restarted.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", required=True, type=Path)
    parser.add_argument("--copy", action="store_true", help="Copy payload to a fresh path before testing relocation")
    args = parser.parse_args()
    native = args.native.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="singhouse-native-smoke-") as folder:
        temporary = Path(folder)
        if args.copy:
            native = Path(shutil.copytree(native, temporary / "relocated native", symlinks=True))
        exercise(native, temporary)
    print("PASS: isolated native boot, authentication, origin/host checks, prepared-video import/media, library lock, persistent restart")


if __name__ == "__main__":
    main()
