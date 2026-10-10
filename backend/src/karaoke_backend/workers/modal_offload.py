# SPDX-License-Identifier: AGPL-3.0-only
"""
Offload GPU-heavy worker steps to a Modal cloud container.

The compute lives in ``backend/modal_app.py`` (deployed separately with
``modal deploy``); this module is the dispatcher-side client. The backend, DB,
file storage and HTTP serving all stay local — only the two GPU subprocesses
(stem separation, Heart transcription) move to Modal.

Activation is purely env-driven::

    KARAOKE_MODAL=1                 # enable (unset/0 → fall through to local)
    KARAOKE_MODAL_APP=karaoke-gpu   # deployed Modal app name (must match modal_app.py)

Authentication uses the standard Modal client config: ``~/.modal.toml`` (written
by ``modal token set``) or ``MODAL_TOKEN_ID`` / ``MODAL_TOKEN_SECRET`` env vars
(preferred under systemd, which has no interactive login).

``modal_separate`` produces
``lead_vocals.wav`` / ``backing_vocals.wav`` in ``stems_dir`` and returns the
drums/bass/other paths for local ffmpeg mixing; ``ModalHeartTranscriber`` is a
drop-in for ``lyricsync.transcription.HeartTranscriber``.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
APP_NAME = os.getenv("KARAOKE_MODAL_APP", "karaoke-gpu").strip()
_ENABLED = os.getenv("KARAOKE_MODAL", "").strip().lower() in ("1", "true", "yes", "on")
_DESKTOP = None


def configure_desktop(descriptor):
    """Set once during private bootstrap, before workers or requests start.

    The bootstrap validates the release contract, consent and remote metadata.
    This method is not an HTTP/settings API and never persists credentials.
    """
    global _DESKTOP, APP_NAME
    if _DESKTOP is not None:
        raise RuntimeError("Desktop processing was already configured")
    if descriptor.get("enabled") is True:
        APP_NAME = descriptor["config"]["app"]
    _DESKTOP = descriptor


def is_enabled() -> bool:
    """True when Modal offload is configured (and the SDK imports)."""
    if _DESKTOP is not None:
        return _DESKTOP.get("enabled") is True
    if not _ENABLED:
        return False
    try:
        import modal  # noqa: F401
    except ImportError:
        logger.warning("KARAOKE_MODAL set but `modal` SDK not installed — ignoring.")
        return False
    return True


def readiness() -> dict[str, object]:
    """Describe user-owned Modal configuration without substituting for it."""
    if _DESKTOP is not None:
        status = _DESKTOP["publicStatus"]
        return {**status, "desktop_qualified": _DESKTOP.get("enabled") is True,
                "sdk_available": _DESKTOP.get("enabled") is True,
                "credentials_configured": status.get("configured") is True}
    configured = _ENABLED
    sdk_available = False
    if configured:
        try:
            import modal  # noqa: F401
        except ImportError:
            pass
        else:
            sdk_available = True
    token_configured = bool(
        os.getenv("MODAL_TOKEN_ID", "").strip()
        and os.getenv("MODAL_TOKEN_SECRET", "").strip()
    )
    home_raw = os.getenv("HOME", "").strip()
    config_file = Path(home_raw).expanduser() / ".modal.toml" if home_raw else None
    credentials_configured = token_configured or bool(
        config_file is not None and config_file.is_file()
    )
    return {
        "configured": configured,
        "ready": configured and sdk_available and credentials_configured and bool(APP_NAME),
        "sdk_available": sdk_available,
        "credentials_configured": credentials_configured,
        "app": APP_NAME,
    }


def _lookup(fn_name: str):
    """Resolve a deployed Modal function handle by app + function name."""
    import modal

    if _DESKTOP is not None:
        if _DESKTOP.get("enabled") is not True:
            raise RuntimeError("User-owned Modal processing is not ready")
        config = _DESKTOP["config"]
        role = {"separate_remote": "separation", "transcribe_remote": "transcription"}.get(fn_name)
        if role is None:
            raise RuntimeError("Unsupported desktop processing function")
        client = modal.Client.from_credentials(config["tokenId"], config["tokenSecret"])
        return modal.Function.from_name(config["app"], _DESKTOP["functions"][role],
                                        environment_name=config["environment"], version=config["version"], client=client)

    return modal.Function.from_name(APP_NAME, fn_name)


def _wav_layout(data: bytes) -> tuple[int, int, int]:
    """Validate complete uncompressed RIFF WAV and return rate/channels/frames.

    Demucs emits IEEE float; separator models may emit integer PCM. The
    standard wave module does not support IEEE float on all supported Python
    versions, so inspect bounded RIFF chunks directly without an ML dependency.
    """
    import struct

    def invalid():
        raise RuntimeError("Modal separation returned an invalid or truncated WAV stem")

    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        invalid()
    if struct.unpack_from("<I", data, 4)[0] + 8 != len(data):
        invalid()
    position, fmt, payload = 12, None, None
    while position < len(data):
        if position + 8 > len(data):
            invalid()
        tag, size = struct.unpack_from("<4sI", data, position)
        start = position + 8
        end = start + size
        if end > len(data):
            invalid()
        if tag == b"fmt ":
            if fmt is not None or size < 16:
                invalid()
            fmt = data[start:end]
        elif tag == b"data":
            if payload is not None:
                invalid()
            payload = size
        position = end + (size % 2)
    if position != len(data) or fmt is None or not payload:
        invalid()
    codec, channels, rate, byte_rate, block, bits = struct.unpack_from("<HHIIHH", fmt)
    if codec == 0xFFFE:
        if len(fmt) < 40 or struct.unpack_from("<H", fmt, 16)[0] < 22:
            invalid()
        guid = fmt[24:40]
        if guid[4:] != bytes.fromhex("00001000800000aa00389b71"):
            invalid()
        codec = int.from_bytes(guid[:4], "little")
    if codec not in (1, 3) or channels < 1 or rate < 1:
        invalid()
    if bits not in ((8, 16, 24, 32) if codec == 1 else (32, 64)):
        invalid()
    if block != channels * (bits // 8) or byte_rate != rate * block or payload % block:
        invalid()
    return rate, channels, payload // block


# --------------------------------------------------------------------------- #
# Separation
# --------------------------------------------------------------------------- #
def modal_separate(
    audio_path: Path,
    stems_dir: Path,
    *,
    demucs_model: str,
    karaoke_model: str = "",
    timeout: int = 1800,
) -> dict[str, Path]:
    """Run both separation passes on Modal GPU, stage results locally.

    Writes ``lead_vocals.wav`` and
    ``backing_vocals.wav`` into ``stems_dir``, stages drums/bass/other under
    ``stems_dir/_remote_raw``, and returns those three local paths so the caller
    can run the instrumental/karaoke ffmpeg mixes locally.
    """
    audio_bytes = audio_path.read_bytes()
    logger.info("Running Modal separation (app=%s, %d bytes in)", APP_NAME, len(audio_bytes))

    fn = _lookup("separate_remote")
    # An explicit model selection must never silently use a different model.
    extra = {"karaoke_model": karaoke_model} if karaoke_model else {}
    result = fn.remote(audio_bytes, audio_path.name, demucs_model, **extra)

    if not isinstance(result, dict) or result.get("ok") is not True:
        detail = result.get("error") if isinstance(result, dict) else "invalid response"
        raise RuntimeError(f"Modal separation error: {detail}")
    if result.get("pass2") != "ok":
        raise RuntimeError("Modal separation did not complete the lead/backing split")
    required = ("lead_vocals", "backing_vocals", "drums", "bass", "other")
    for name in required:
        if not isinstance(result.get(name), bytes) or not result[name]:
            raise RuntimeError(f"Modal separation missing or invalid {name} stem")

    layouts = [_wav_layout(result[name]) for name in required]
    if len(set(layouts)) != 1:
        raise RuntimeError("Modal separation stems have mismatched audio layouts")

    # Validate the entire response before touching existing artifacts. Stage all
    # bytes first, and roll back caught publication failures. This does not
    # promise a power-loss-atomic transaction across multiple files.
    import tempfile

    stems_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = stems_dir / "_remote_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".modal-", dir=stems_dir) as scratch:
        staged = Path(scratch)
        for name in required:
            (staged / f"{name}.wav").write_bytes(result[name])
        import shutil

        targets = {
            name: (stems_dir if name in ("lead_vocals", "backing_vocals") else raw_dir)
            / f"{name}.wav" for name in required
        }
        backups = {}
        for name, target in targets.items():
            if target.exists():
                if not target.is_file():
                    raise RuntimeError(f"Modal stem target is not a file: {target.name}")
                backup = staged / f"{name}.previous"
                shutil.copy2(target, backup)
                backups[name] = backup
        published = []
        try:
            for name, target in targets.items():
                (staged / f"{name}.wav").replace(target)
                published.append(name)
        except BaseException:
            for name in reversed(published):
                if name in backups:
                    backups[name].replace(targets[name])
                else:
                    targets[name].unlink()
            raise

    return {
        "drums": raw_dir / "drums.wav",
        "bass": raw_dir / "bass.wav",
        "other": raw_dir / "other.wav",
    }


# --------------------------------------------------------------------------- #
# Transcription
# --------------------------------------------------------------------------- #
class ModalHeartTranscriber:
    """Drop-in for ``lyricsync.transcription.HeartTranscriber`` that runs the
    Heart model on Modal GPU instead of a local subprocess.

    VAD runs locally (cheap, CPU) exactly as in the local transcriber;
    only the model forward passes move to Modal. Returns the same
    ``TranscriptionResult`` type, so ``word_sync_worker`` and the transcription
    cache are unaffected.
    """

    def __init__(
        self,
        *,
        use_vad: bool = True,
        vad_config=None,
        timeout: int = 1800,
        allow_temperature_fallback: bool = False,
    ):
        self.use_vad = use_vad
        self.vad_config = vad_config
        self.timeout = timeout
        # Off by default: the first pass decodes greedily at 0.0 so it is
        # reproducible. Only the manual re-transcribe action asks for the ladder.
        self.allow_temperature_fallback = allow_temperature_fallback

    def transcribe(self, audio_path: str, language: Optional[str] = None):
        from lyricsync._types import (
            TimedWord,
            TranscriptionResult,
            TranscriptionSegment,
        )

        vad_segments = None
        if self.use_vad:
            from lyricsync.audio.io import read_wav_mono
            from lyricsync.audio.vad import rms_vad_segments

            samples, sr = read_wav_mono(audio_path)
            # The remote function has no device-memory probe, so an "auto" cap
            # (``max_segment_duration=None``) is not re-split there: slices go
            # out at the VAD's 30 s ceiling. Modal GPUs are data-centre cards
            # with no desktop on them, so this is the top auto tier. Silent
            # stems still get the 15 s whole-file window. An explicit cap is
            # passed through unchanged.
            vad_segments = rms_vad_segments(samples, sr, self.vad_config)
            logger.info(
                "ModalHeartTranscriber: VAD produced %d segments (%.1fs audio)",
                len(vad_segments), len(samples) / sr,
            )

        if vad_segments == []:
            return TranscriptionResult(segments=[], language=language or "en", full_text="")

        audio_bytes = Path(audio_path).read_bytes()
        logger.info("Running Modal HeartTranscriptor (app=%s)", APP_NAME)

        fn = _lookup("transcribe_remote")
        raw = fn.remote(
            audio_bytes,
            Path(audio_path).name,
            vad_segments,
            language or "en",
            self.allow_temperature_fallback,
        )
        if "error" in raw:
            raise RuntimeError(f"Modal HeartTranscriptor error: {raw['error']}")

        segments: list = []
        for seg in raw.get("segments", []):
            words = [
                TimedWord(
                    text=w.get("word", w.get("text", "")).strip(),
                    start=w.get("start", 0),
                    end=w.get("end", 0),
                )
                for w in seg.get("words", [])
                if (w.get("word", w.get("text", ""))).strip()
            ]
            segments.append(TranscriptionSegment(
                start=seg.get("start", 0),
                end=seg.get("end", 0),
                text=seg.get("text", ""),
                words=words,
            ))

        logger.info(
            "ModalHeartTranscriber: %d segments, %d total words",
            len(segments), sum(len(s.words) for s in segments),
        )
        return TranscriptionResult(
            segments=segments,
            language=raw.get("language"),
            full_text=raw.get("full_text", ""),
        )
