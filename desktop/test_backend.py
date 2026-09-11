# SPDX-License-Identifier: AGPL-3.0-only
"""Isolation boundary tests; run with python -m unittest discover -s desktop."""

import asyncio
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location("desktop_backend", Path(__file__).with_name("backend.py"))
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class IsolationTests(unittest.TestCase):
    def test_demo_has_player_segments_and_consistent_stage_lines(self):
        payload = backend.demo_word_sync()
        # The player accepts initial timed lyrics only when segments exists;
        # the stage then prefers lines. Keep both representations consistent.
        self.assertTrue(payload["segments"])
        self.assertEqual(len(payload["segments"]), len(payload["lines"]))
        for segment, line in zip(payload["segments"], payload["lines"]):
            self.assertEqual(segment["words"], line)
            self.assertEqual(segment["text"], " ".join(word["text"] for word in line))
            self.assertEqual(segment["start"], line[0]["start"])
            self.assertEqual(segment["end"], line[-1]["end"])
            self.assertGreaterEqual(segment["start"], 0)
            self.assertLessEqual(segment["end"], 60)
            for word in line:
                self.assertLess(word["start"], word["end"])

    def test_supplied_runtime_cleanup_and_rejection_of_existing_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir(mode=0o700)
            with backend.runtime_directory(runtime) as active:
                (active / "desktop.db").write_text("disposable")
            self.assertFalse(runtime.exists())
            runtime.mkdir(mode=0o700)
            marker = runtime / "existing.db"
            marker.write_text("keep")
            with self.assertRaisesRegex(RuntimeError, "empty"):
                with backend.runtime_directory(runtime):
                    self.fail("Nonempty runtime accepted")
            self.assertEqual(marker.read_text(), "keep")
            link = root / "link"
            link.symlink_to(runtime)
            with self.assertRaisesRegex(RuntimeError, "symbolic link"):
                with backend.runtime_directory(link):
                    self.fail("Symlink runtime accepted")

    def test_parent_pipe_eof_exits_child_and_cleans_runtime(self):
        script = '''
import importlib.util, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("launcher", sys.argv[1])
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
with tempfile.TemporaryDirectory(prefix="desktop-watch-test-") as temporary:
    print(temporary, flush=True)
    parent_closed = launcher.watch_parent(sys.stdin.fileno())
    if not parent_closed.wait(10):
        raise SystemExit(2)
'''
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", script, str(Path(__file__).with_name("backend.py"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            runtime = Path(process.stdout.readline().strip())
            self.assertTrue(runtime.is_dir())
            process.stdin.write("still alive\n")
            process.stdin.flush()
            self.assertIsNone(process.poll())
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertFalse(runtime.exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            process.stderr.close()
            if not process.stdin.closed:
                process.stdin.close()

    def test_inherited_credentials_and_service_settings_are_removed(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://production",
                                   "KARAOKE_PROVIDERS_DIR": "/private",
                                   "KARAOKE_REMOTE_HOST": "live",
                                   "KARAOKE_GATE_PASSWORD_HASH": "old",
                                   "KARAOKE_LLM_API_KEY": "secret",
                                   "PYTHONPATH": "/private"}):
            env = backend.isolated_environment(Path("/tmp/disposable"), "http://127.0.0.1:1234", "fresh")
        self.assertEqual(env["DATABASE_URL"], "sqlite+aiosqlite:////tmp/disposable/desktop.db")
        self.assertEqual(env["KARAOKE_PROVIDERS_DIR"], "")
        self.assertEqual(env["KARAOKE_GATE_PASSWORD"], "fresh")
        for key in ("KARAOKE_REMOTE_HOST", "KARAOKE_GATE_PASSWORD_HASH", "KARAOKE_LLM_API_KEY", "PYTHONPATH"):
            self.assertNotIn(key, env)

    def test_plugin_metadata_rejected_without_loading_plugin(self):
        distribution = types.SimpleNamespace(entry_points=[types.SimpleNamespace(group="karaoke_backend.future_plugin")])
        with patch.object(backend.importlib.metadata, "distributions", return_value=[distribution]):
            with self.assertRaisesRegex(RuntimeError, "without backend plugins"):
                backend.reject_plugins()

    def test_host_origin_boundary_and_duplicate_headers(self):
        async def request(headers):
            messages = []
            async def inner(scope, receive, send):
                await send({"type": "http.response.start", "status": 204})
            async def send(message):
                messages.append(message)
            await backend.LoopbackOnly(inner, "http://127.0.0.1:1234")(
                {"type": "http", "headers": headers}, None, send)
            return messages[0]["status"]
        host = (b"host", b"127.0.0.1:1234")
        self.assertEqual(asyncio.run(request([host])), 204)
        self.assertEqual(asyncio.run(request([host, (b"origin", b"http://127.0.0.1:1234")])), 204)
        for headers in ([], [host, host], [(b"host", b"rebind.example:1234")],
                        [host, (b"origin", b"null")], [host, (b"origin", b"https://evil.example")]):
            self.assertEqual(asyncio.run(request(headers)), 403)

    def test_demo_audio_is_quiet_and_sixty_seconds(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "tone.wav"
            backend.write_tone(path, 220.0)
            with wave.open(str(path)) as audio:
                self.assertEqual(audio.getnframes() / audio.getframerate(), 60)
                self.assertEqual(audio.getnchannels(), 1)
                data = audio.readframes(audio.getframerate())
            import struct
            samples = struct.unpack("<" + "h" * (len(data) // 2), data)
            self.assertGreater(max(samples), 0)
            self.assertLessEqual(max(abs(value) for value in samples), 500)

    def test_frontend_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ("backend/src/karaoke_backend/__init__.py",
                             "lyricsync/src/lyricsync/__init__.py", "frontend/dist/index.html"):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("")
            self.assertEqual(backend.validate_root(root), root)
            (root / "frontend/dist/private").symlink_to(root / "backend")
            with self.assertRaisesRegex(RuntimeError, "symbolic links"):
                backend.validate_root(root)


if __name__ == "__main__":
    unittest.main()
