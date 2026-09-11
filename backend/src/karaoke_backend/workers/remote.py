# SPDX-License-Identifier: AGPL-3.0-only
"""
Offload GPU/MPS-heavy worker steps to a remote host over SSH + rsync.

The local box's GPU is dead, so stem separation (demucs + mel_band_roformer)
and Heart transcription are dispatched to an Apple-Silicon worker (a Mac mini)
that has MPS. The backend, database, file storage and HTTP serving all stay
local; only the two compute subprocesses move.

Activation is purely env-driven::

    KARAOKE_REMOTE_HOST    e.g. "user@192.168.1.50" (unset → everything runs locally)
    KARAOKE_REMOTE_DIR     default "karaoke-worker" (relative to the remote home)
    KARAOKE_REMOTE_PYTHON  default "<DIR>/.venv/bin/python"

The remote side is provisioned by ``backend/scripts/setup-mac-worker.sh`` and
runs the scripts in ``backend/workers/remote_runtime/`` (rsync'd to
``<DIR>/scripts/``). Per-job scratch lives under ``<DIR>/work/<uuid>`` and is
removed when the job finishes.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
REMOTE_HOST = os.getenv("KARAOKE_REMOTE_HOST", "").strip()
REMOTE_DIR = os.getenv("KARAOKE_REMOTE_DIR", "karaoke-worker").strip().rstrip("/")
REMOTE_PYTHON = os.getenv("KARAOKE_REMOTE_PYTHON", "").strip() or f"{REMOTE_DIR}/.venv/bin/python"
REMOTE_BIN = f"{REMOTE_DIR}/bin"  # holds the bundled ffmpeg symlink

HEART_CKPT = f"{REMOTE_DIR}/ckpt/HeartTranscriptor-oss"
HEART_SCRIPT = f"{REMOTE_DIR}/scripts/mac_heart_transcriptor.py"
SEPARATE_SCRIPT = f"{REMOTE_DIR}/scripts/mac_separate.py"
KARAOKE_MODEL_DIR = f"{REMOTE_DIR}/ckpt/audio-separator-models"
KARAOKE_MODEL = os.getenv(
    "KARAOKE_MODEL",
    "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
)

# Long-lived sessions: tolerate ~2h of remote compute without TCP keepalive death.
_SSH_OPTS = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=240",
]


def is_enabled() -> bool:
    """True when offload is configured."""
    return bool(REMOTE_HOST)


# --------------------------------------------------------------------------- #
# SSH / rsync primitives (synchronous — call from a thread/executor)
# --------------------------------------------------------------------------- #
def _ssh(remote_cmd: str, timeout: int) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["ssh", *_SSH_OPTS, REMOTE_HOST, remote_cmd],
        capture_output=True, text=True, timeout=timeout,
    )
    return proc


def _ssh_checked(remote_cmd: str, timeout: int) -> subprocess.CompletedProcess:
    proc = _ssh(remote_cmd, timeout)
    if proc.returncode != 0:
        raise RuntimeError(
            f"remote command failed (exit {proc.returncode}): {proc.stderr[-800:]}"
        )
    return proc


def _build_cmd(argv: list[str], *, with_ffmpeg: bool = False) -> str:
    """Quote argv into a single remote-shell command string.

    ``$PATH`` is left unquoted so the remote shell expands it; everything else
    is shell-quoted.
    """
    quoted = " ".join(shlex.quote(a) for a in argv)
    if with_ffmpeg:
        return f"PATH={shlex.quote(REMOTE_BIN)}:$PATH {quoted}"
    return quoted


def _push(local: Path, remote_rel: str, timeout: int = 600) -> None:
    subprocess.run(
        ["rsync", "-a", "-e", "ssh " + " ".join(_SSH_OPTS),
         str(local), f"{REMOTE_HOST}:{remote_rel}"],
        check=True, capture_output=True, text=True, timeout=timeout,
    )


def _pull(remote_rel: str, local: Path, timeout: int = 600) -> None:
    subprocess.run(
        ["rsync", "-a", "-e", "ssh " + " ".join(_SSH_OPTS),
         f"{REMOTE_HOST}:{remote_rel}", str(local)],
        check=True, capture_output=True, text=True, timeout=timeout,
    )


def _mkjob(*, with_out: bool = False) -> str:
    """Create and return a per-job remote scratch dir (relative to remote home)."""
    job = f"{REMOTE_DIR}/work/{uuid.uuid4().hex}"
    target = f"{job}/out" if with_out else job
    _ssh_checked(f"mkdir -p {shlex.quote(target)}", timeout=30)
    return job


def _rmjob(job: str) -> None:
    if not job or "/work/" not in job:  # guard against rm -rf of anything important
        return
    try:
        _ssh(f"rm -rf {shlex.quote(job)}", timeout=30)
    except Exception as exc:  # cleanup is best-effort
        logger.warning("remote cleanup failed for %s: %s", job, exc)


def _parse_last_json(stdout: str) -> dict:
    for line in reversed(stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError("no JSON object on remote stdout")


# --------------------------------------------------------------------------- #
# Transcription
# --------------------------------------------------------------------------- #
class RemoteHeartTranscriber:
    """Drop-in for ``lyricsync.transcription.HeartTranscriber`` that runs the
    Heart model on the remote MPS host instead of a local subprocess.

    VAD runs locally (cheap, CPU) exactly as in the local transcriber; only the
    model forward passes move to the Mac. Returns the same ``TranscriptionResult``
    type, so ``word_sync_worker`` and the transcription cache are unaffected.
    """

    def __init__(
        self,
        *,
        use_vad: bool = True,
        vad_config=None,
        timeout: int = 1200,
        allow_temperature_fallback: bool = False,
    ):
        self.use_vad = use_vad
        self.vad_config = vad_config
        self.timeout = timeout
        # Off by default: the first pass decodes greedily at 0.0 so it is
        # reproducible. Only the manual re-transcribe action asks for the ladder.
        self.allow_temperature_fallback = allow_temperature_fallback

    def transcribe(self, audio_path: str, language: Optional[str] = None):
        from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

        job = _mkjob()
        vad_tmp: Optional[str] = None
        try:
            audio_name = Path(audio_path).name
            audio_remote = f"{job}/{audio_name}"
            _push(Path(audio_path), audio_remote)

            argv = [
                REMOTE_PYTHON, HEART_SCRIPT, audio_remote,
                "--model-path", HEART_CKPT,
            ]
            if language:
                argv += ["--language", language]
            if self.allow_temperature_fallback:
                argv.append("--temperature-fallback")

            if self.use_vad:
                from lyricsync.audio.io import read_wav_mono
                from lyricsync.audio.vad import rms_vad_segments

                samples, sr = read_wav_mono(audio_path)
                vad_segs = rms_vad_segments(samples, sr, self.vad_config)
                tf = tempfile.NamedTemporaryFile(mode="w", suffix=".vad.json", delete=False)
                json.dump(vad_segs, tf)
                tf.close()
                vad_tmp = tf.name
                vad_remote = f"{job}/vad.json"
                _push(Path(vad_tmp), vad_remote)
                argv += ["--vad-segments", vad_remote]
                logger.info(
                    "RemoteHeartTranscriber: VAD produced %d segments (%.1fs audio)",
                    len(vad_segs), len(samples) / sr,
                )

            logger.info("Running remote HeartTranscriptor on %s", REMOTE_HOST)
            proc = _ssh(_build_cmd(argv), timeout=self.timeout)
            if proc.stderr:
                for line in proc.stderr.strip().splitlines()[-20:]:
                    logger.info("remote-heart: %s", line)
            if proc.returncode != 0:
                raise RuntimeError(
                    f"remote HeartTranscriptor failed (exit {proc.returncode}): "
                    f"{proc.stderr[-500:]}"
                )

            raw = _parse_last_json(proc.stdout)
            if "error" in raw:
                raise RuntimeError(f"remote HeartTranscriptor error: {raw['error']}")
        finally:
            if vad_tmp:
                try:
                    os.unlink(vad_tmp)
                except OSError:
                    pass
            _rmjob(job)

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
            "RemoteHeartTranscriber: %d segments, %d total words",
            len(segments), sum(len(s.words) for s in segments),
        )
        return TranscriptionResult(
            segments=segments,
            language=raw.get("language"),
            full_text=raw.get("full_text", ""),
        )


# --------------------------------------------------------------------------- #
# Separation
# --------------------------------------------------------------------------- #
def remote_separate(
    audio_path: Path,
    stems_dir: Path,
    *,
    demucs_model: str,
    karaoke_model: str = "",
    timeout: int = 1800,
) -> dict[str, Path]:
    """Run both separation passes on the remote MPS host.

    Produces ``lead_vocals.wav`` and ``backing_vocals.wav`` directly in
    ``stems_dir``, and returns the local paths of the Pass-1 ``drums``/``bass``/
    ``other`` stems (staged under ``stems_dir/_remote_raw``) so the caller can
    do the instrumental/karaoke ffmpeg mixes locally.

    ``karaoke_model`` is an already-resolved Pass-2 model FILENAME (the caller
    validated the operator's pick against ``karaoke_models.CHOICES``); empty
    means this host's configured ``KARAOKE_MODEL``. ``mac_separate.py`` has
    taken ``--karaoke-model`` per call since it was written, so a model the
    remote has never seen needs no re-provisioning — audio-separator downloads
    it into ``ckpt/audio-separator-models`` on first use, inside this timeout.
    """
    stems_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = stems_dir / "_remote_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    job = _mkjob(with_out=True)
    try:
        input_remote = f"{job}/{audio_path.name}"
        _push(audio_path, input_remote, timeout=timeout)

        argv = [
            REMOTE_PYTHON, SEPARATE_SCRIPT, input_remote,
            "--output-dir", f"{job}/out",
            "--demucs-model", demucs_model,
            "--device", "mps",
            "--karaoke-model", karaoke_model or KARAOKE_MODEL,
            "--karaoke-model-dir", KARAOKE_MODEL_DIR,
        ]
        logger.info(
            "Running remote separation on %s (pass 2: %s)",
            REMOTE_HOST,
            karaoke_model or KARAOKE_MODEL,
        )
        proc = _ssh(_build_cmd(argv, with_ffmpeg=True), timeout=timeout)
        if proc.stderr:
            for line in proc.stderr.strip().splitlines()[-30:]:
                logger.info("remote-sep: %s", line)
        if proc.returncode != 0:
            raise RuntimeError(
                f"remote separation failed (exit {proc.returncode}): {proc.stderr[-500:]}"
            )
        status = _parse_last_json(proc.stdout)
        if not status.get("ok"):
            raise RuntimeError(f"remote separation error: {status.get('error')}")
        logger.info("remote separation status: %s", status)

        # Pull all produced stems back (rsync the dir contents into raw_dir).
        _pull(f"{job}/out/", raw_dir, timeout=timeout)
    finally:
        _rmjob(job)

    # lead/backing belong in stems_dir; drums/bass/other stay in raw_dir for mixing.
    import shutil
    for name in ("lead_vocals.wav", "backing_vocals.wav"):
        src = raw_dir / name
        if src.exists():
            shutil.move(str(src), str(stems_dir / name))

    return {
        "drums": raw_dir / "drums.wav",
        "bass": raw_dir / "bass.wav",
        "other": raw_dir / "other.wav",
    }
