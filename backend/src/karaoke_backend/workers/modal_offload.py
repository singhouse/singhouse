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


def is_enabled() -> bool:
    """True when Modal offload is configured (and the SDK imports)."""
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

    return modal.Function.from_name(APP_NAME, fn_name)


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
    stems_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = stems_dir / "_remote_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    audio_bytes = audio_path.read_bytes()
    logger.info("Running Modal separation (app=%s, %d bytes in)", APP_NAME, len(audio_bytes))

    fn = _lookup("separate_remote")
    # The Pass-2 model is sent ONLY when the operator picked a non-default one.
    # `separate_remote` grew that parameter in this repo, but the deployed Modal
    # app is a separate artifact that only changes on `modal deploy` — so a
    # stock separation must keep the exact three-argument call an older
    # deployment understands, and a pick against a stale deployment degrades to
    # the baked-in model with a loud warning instead of failing the job.
    extra = {"karaoke_model": karaoke_model} if karaoke_model else {}
    # A configured model is part of the requested result.  A stale deployment
    # must fail loudly rather than silently run its baked-in substitute.
    result = fn.remote(audio_bytes, audio_path.name, demucs_model, **extra)

    if not result.get("ok"):
        raise RuntimeError(f"Modal separation error: {result.get('error')}")
    logger.info("Modal separation status: pass2=%s", result.get("pass2"))
    if result.get("pass2") == "fallback":
        logger.warning("Modal pass-2 fell back: %s", result.get("pass2_error"))

    # lead/backing → stems_dir; drums/bass/other → raw_dir for mixing.
    for name in ("lead_vocals", "backing_vocals"):
        data = result.get(name)
        if data:
            (stems_dir / f"{name}.wav").write_bytes(data)
    for name in ("drums", "bass", "other"):
        data = result.get(name)
        if data:
            (raw_dir / f"{name}.wav").write_bytes(data)

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
            vad_segments = rms_vad_segments(samples, sr, self.vad_config)
            logger.info(
                "ModalHeartTranscriber: VAD produced %d segments (%.1fs audio)",
                len(vad_segments), len(samples) / sr,
            )

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
