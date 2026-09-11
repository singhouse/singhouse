# SPDX-License-Identifier: AGPL-3.0-only
"""Run an isolated, disposable development backend for the desktop shell."""

from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager, redirect_stdout
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import socket
import struct
import sys
import tempfile
import threading
import wave


def validate_root(root: Path) -> Path:
    root = root.resolve(strict=True)
    for relative in ("backend/src/karaoke_backend/__init__.py",
                     "lyricsync/src/lyricsync/__init__.py", "frontend/dist/index.html"):
        path = root / relative
        if not path.is_file() or not path.resolve().is_relative_to(root):
            raise RuntimeError(f"Missing release source or built frontend: {relative}")
    for path in (root / "frontend/dist").rglob("*"):
        if path.is_symlink():
            raise RuntimeError("Built frontend must not contain symbolic links")
    return root


def reject_plugins() -> None:
    for distribution in importlib.metadata.distributions():
        if any(ep.group.startswith("karaoke_backend.")
               for ep in distribution.entry_points):
            raise RuntimeError("Use a clean core-only environment without backend plugins")
    if importlib.util.find_spec("karaoke_premium") is not None:
        raise RuntimeError("Use a clean core-only environment")


def isolated_environment(runtime: Path, origin: str, password: str) -> dict[str, str]:
    # Preserve only OS executable discovery; every application setting is new.
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR", "COMSPEC")
           if key in os.environ}
    env.update({
        "HOME": str(runtime), "USERPROFILE": str(runtime),
        "TMPDIR": str(runtime), "TMP": str(runtime), "TEMP": str(runtime),
        "XDG_CACHE_HOME": str(runtime / "cache"),
        "XDG_CONFIG_HOME": str(runtime / "config"),
        "XDG_DATA_HOME": str(runtime / "data"),
        "HF_HOME": str(runtime / "cache/huggingface"),
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "PYTHONDONTWRITEBYTECODE": "1", "AUTH_MODE": "single_host",
        "DATABASE_URL": "sqlite+aiosqlite:///" + str(runtime / "desktop.db"),
        "UPLOADS_DIR": str(runtime / "uploads"), "STEMS_DIR": str(runtime / "stems"),
        "SESSION_SECRET": secrets.token_urlsafe(48),
        "SESSION_COOKIE": "karaoke_session", "SESSION_HTTPS_ONLY": "false",
        "KARAOKE_GATE_PASSWORD": password, "BASE_URL": origin,
        "CORS_ORIGINS": origin, "KARAOKE_PROVIDERS_DIR": "", "KARAOKE_PROVIDERS": "none",
        "KARAOKE_LRCLIB": "0", "KARAOKE_MODAL": "0", "LOG_LEVEL": "INFO",
    })
    return env


class LoopbackOnly:
    """Reject foreign Host and Origin headers, including DNS rebinding."""

    def __init__(self, app, origin: str):
        self.app = app
        self.origin = origin.encode("ascii")
        self.authority = self.origin.removeprefix(b"http://")

    async def __call__(self, scope, receive, send):
        if scope["type"] in {"http", "websocket"}:
            headers = scope.get("headers", [])
            hosts = [v for k, v in headers if k.lower() == b"host"]
            origins = [v for k, v in headers if k.lower() == b"origin"]
            if hosts != [self.authority] or (origins and origins != [self.origin]):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await send({"type": "http.response.start", "status": 403,
                                "headers": [(b"content-type", b"text/plain")]})
                    await send({"type": "http.response.body", "body": b"Forbidden"})
                return
        await self.app(scope, receive, send)


def write_tone(path: Path, frequency: float) -> None:
    """Original quiet synthetic tone, sixty seconds, with smooth pulse edges."""
    rate = 16000
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        # Integer frequencies make this one-second loop phase continuous.
        second = bytearray()
        for index in range(rate):
            t = index / rate
            envelope = math.sin(math.pi * t) ** 2
            second.extend(struct.pack("<h", round(500 * envelope * math.sin(2 * math.pi * frequency * t))))
        for _ in range(60):
            output.writeframes(second)


def watch_parent(fd: int) -> threading.Event:
    """Signal parent loss when its lifetime pipe closes, even during startup.

    Direct launches must also keep stdin open. A daemon uses raw reads so an
    open pipe cannot hold Python's buffered stdin lock during interpreter exit.
    The server consumes the flag in its main loop, after startup has completed,
    so normal lifespan shutdown and temporary-directory cleanup still run.
    """
    closed = threading.Event()

    def read_until_eof():
        try:
            while os.read(fd, 4096):
                pass
        except OSError:
            pass
        finally:
            closed.set()

    threading.Thread(target=read_until_eof, name="desktop-parent", daemon=True).start()
    return closed


def demo_word_sync() -> dict:
    """Canonical timed words for both the player's loader and stage renderer."""
    phrases = ["Soft light circles slowly", "Small waves drift gently", "Bright dots follow time"]
    lines = [[{"text": word, "start": 2 + n * 5 + i, "end": 2.8 + n * 5 + i}
              for i, word in enumerate(phrases[n % len(phrases)].split())]
             for n in range(11)]
    segments = [{"start": line[0]["start"], "end": line[-1]["end"],
                 "text": " ".join(word["text"] for word in line), "words": line}
                for line in lines]
    return {"segments": segments, "lines": lines, "metadata": {"method": "synthetic"}}


async def seed_demo(app) -> None:
    from karaoke_backend.api.identity import SINGLE_HOST_ID
    from karaoke_backend.database import AsyncSessionLocal
    from karaoke_backend.models.song import LyricsSet, Song

    stems = Path(os.environ["STEMS_DIR"]) / "synthetic-demo"
    stems.mkdir(parents=True)
    await asyncio.to_thread(write_tone, stems / "instrumental.wav", 220.0)
    await asyncio.to_thread(write_tone, stems / "lead_vocals.wav", 330.0)
    word_sync = demo_word_sync()
    async with AsyncSessionLocal() as db:
        song = Song(owner_id=SINGLE_HOST_ID, artist="Synthetic demo",
                    title="Quiet light", filename="synthetic-demo.wav", duration=60,
                    status="ready", stems_path=str(stems), lyrics_synced=True)
        db.add(song)
        await db.flush()
        lyrics = LyricsSet(owner_id=SINGLE_HOST_ID, song_id=song.id, source="manual",
                           label="Original synthetic timed words",
                           plain_lyrics="\n".join(segment["text"] for segment in word_sync["segments"]),
                           word_sync_json=json.dumps(word_sync))
        db.add(lyrics)
        await db.flush()
        song.active_lyrics_id = lyrics.id
        await db.commit()


@contextmanager
def runtime_directory(supplied: Path | None = None):
    """Use a new runtime, or the empty private directory owned by the parent."""
    if supplied is None:
        with tempfile.TemporaryDirectory(prefix="karaoke-desktop-") as temporary:
            yield Path(temporary)
        return
    if not supplied.is_absolute() or supplied.is_symlink() or not supplied.is_dir():
        raise RuntimeError("Runtime must be an existing absolute directory, not a symbolic link")
    info = supplied.stat()
    if hasattr(os, "getuid") and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise RuntimeError("Runtime must be private and owned by the current user")
    if any(supplied.iterdir()):
        raise RuntimeError("Runtime must be empty")
    try:
        yield supplied.resolve()
    finally:
        shutil.rmtree(supplied, ignore_errors=False)


def run(root: Path, demo: bool, runtime_path: Path | None = None) -> None:
    root = validate_root(root)
    reject_plugins()
    sys.dont_write_bytecode = True
    for package, source in (("karaoke_backend", root / "backend/src"),
                            ("lyricsync", root / "lyricsync/src")):
        if package in sys.modules:
            raise RuntimeError("Backend packages were imported before isolation")
        sys.path.insert(0, str(source))
        spec = importlib.util.find_spec(package)
        if spec is None or Path(spec.origin).resolve() != (source / package / "__init__.py").resolve():
            raise RuntimeError(f"Cannot load release source for {package}")
    original_cwd = Path.cwd()
    protocol_stdout = sys.stdout
    with runtime_directory(runtime_path) as runtime:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
            password, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            environment = isolated_environment(runtime, origin, password)
            os.environ.clear()
            os.environ.update(environment)
            shutil.copytree(root / "frontend/dist", runtime / "static", ignore=shutil.ignore_patterns("*.map"))
            os.chdir(runtime)
            try:
                with redirect_stdout(sys.stderr):
                    import uvicorn
                    from fastapi.responses import JSONResponse
                    from starlette.routing import Route
                    from karaoke_backend.main import app

                    async def ready(request):
                        return JSONResponse({"nonce": nonce}, headers={"Cache-Control": "no-store"})

                    app.router.routes.insert(0, Route("/desktop-ready", ready, methods=["GET"]))
                    # Keep the core's provider-router insertion anchor consistent.
                    app.state.provider_route_anchor += 1
                    if demo:
                        app.state.lifespan_startup_hooks.append(seed_demo)

                    async def announce(app):
                        print(json.dumps({"origin": origin, "password": password, "nonce": nonce}),
                              file=protocol_stdout, flush=True)

                    app.state.lifespan_startup_hooks.append(announce)
                    parent_closed = watch_parent(sys.stdin.fileno())

                    class ParentBoundServer(uvicorn.Server):
                        async def on_tick(self, counter):
                            return parent_closed.is_set() or await super().on_tick(counter)

                    server = ParentBoundServer(uvicorn.Config(
                        LoopbackOnly(app, origin), host="127.0.0.1", port=0,
                        proxy_headers=False, access_log=False, log_config=None,
                    ))
                    server.run(sockets=[listener])
                    if not server.started:
                        raise RuntimeError("Backend startup failed")
            finally:
                os.chdir(original_cwd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--runtime", type=Path, help="Empty private directory created by the parent")
    args = parser.parse_args()
    try:
        run(args.root, args.demo, args.runtime)
    except Exception as error:
        print(f"Desktop backend failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
