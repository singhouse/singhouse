# SPDX-License-Identifier: MIT
from __future__ import annotations

import importlib.resources
import json
import logging
import os
import subprocess
import tempfile
import threading
import time
import signal
from pathlib import Path
from typing import Optional

from lyricsync._config import VadConfig
from lyricsync._types import TimedWord, TranscriptionResult, TranscriptionSegment

logger = logging.getLogger(__name__)

def _terminate_tree_and_reap(proc, original_error: BaseException) -> None:
    """Best-effort bounded tree cleanup, then re-raise the original failure."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, check=False, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        try: proc.kill()
        except OSError: pass
    try:
        proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        try: proc.kill()
        except OSError: pass
        try: proc.communicate(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            logger.error("HeartTranscriptor child did not reap after forced termination")
    except OSError:
        pass
    raise original_error


class HeartTranscriber:
    """Transcription using HeartTranscriptor via subprocess.

    HeartTranscriptor is a fine-tuned Whisper model for lyrics transcription.
    It runs in a separate Python environment (e.g., a venv with torch+transformers).

    With ``use_vad=True``, RMS-VAD is run in the parent process and the resulting
    segments are passed to the subprocess so the HF pipeline runs per segment
    (no whole-file 30s chunking — first-chunk word smear and line-boundary jumps
    go away, at the cost of one model forward per VAD segment).
    """

    def __init__(
        self,
        python_path: str | Path,
        script_path: str | Path | None = None,
        timeout: int = 600,
        use_vad: bool = True,
        vad_config: VadConfig | None = None,
        allow_temperature_fallback: bool = False,
        cancel_event: threading.Event | None = None,
        accelerator: str | None = None,
    ):
        self.python_path = Path(python_path)
        self.timeout = timeout
        self.use_vad = use_vad
        self.vad_config = vad_config
        # Off by default so a transcription is reproducible (greedy 0.0 decode);
        # callers that want the 0.0/0.1/0.2/0.4 rescue ladder opt in explicitly.
        self.allow_temperature_fallback = allow_temperature_fallback
        self.cancel_event = cancel_event
        self.accelerator = accelerator

        if script_path is not None:
            self.script_path = Path(script_path)
        else:
            # Look for bundled script via importlib.resources
            try:
                ref = importlib.resources.files("lyricsync.transcription") / "_heart_script.py"
                self.script_path = Path(str(ref))
            except Exception:
                self.script_path = Path(__file__).parent / "_heart_script.py"

    def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
    ) -> TranscriptionResult:
        if not self.python_path.exists():
            raise RuntimeError(f"Python interpreter not found: {self.python_path}")
        if not self.script_path.exists():
            raise RuntimeError(f"HeartTranscriptor script not found: {self.script_path}")

        cmd = [str(self.python_path), str(self.script_path), audio_path]
        if language:
            cmd.extend(["--language", language])
        if self.allow_temperature_fallback:
            cmd.append("--temperature-fallback")
        if self.accelerator:
            cmd.extend(["--device", self.accelerator])

        vad_tmp: Optional[str] = None
        if self.use_vad:
            from lyricsync.audio.io import read_wav_mono
            from lyricsync.audio.vad import rms_vad_segments

            samples, sr = read_wav_mono(audio_path)
            vad_segs = rms_vad_segments(samples, sr, self.vad_config)
            tf = tempfile.NamedTemporaryFile(
                mode="w", suffix=".vad.json", delete=False,
            )
            json.dump(vad_segs, tf)
            tf.close()
            vad_tmp = tf.name
            cmd.extend(["--vad-segments", vad_tmp])
            logger.info(
                "HeartTranscriber: VAD produced %d segments (%.1fs audio)",
                len(vad_segs), len(samples) / sr,
            )

        logger.info("Running HeartTranscriptor: %s", " ".join(cmd))

        try:
            options = ({"start_new_session": True} if os.name == "posix" else
                       {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)})
            proc_handle = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **options)
            deadline = time.monotonic() + self.timeout
            while True:
                try:
                    stdout, stderr = proc_handle.communicate(timeout=0.1)
                    break
                except subprocess.TimeoutExpired:
                    if self.cancel_event is not None and self.cancel_event.is_set():
                        _terminate_tree_and_reap(proc_handle, RuntimeError("HeartTranscriptor cancelled"))
                    if time.monotonic() >= deadline:
                        _terminate_tree_and_reap(proc_handle, subprocess.TimeoutExpired(cmd, self.timeout))
            proc = subprocess.CompletedProcess(cmd, proc_handle.returncode, stdout, stderr)
        finally:
            if vad_tmp:
                try:
                    os.unlink(vad_tmp)
                except OSError:
                    pass

        if proc.stderr:
            for line in proc.stderr.strip().splitlines():
                logger.info("HeartTranscriptor: %s", line)

        if proc.returncode != 0:
            raise RuntimeError(
                f"HeartTranscriptor failed (exit {proc.returncode}): {proc.stderr[-500:]}"
            )

        raw = json.loads(proc.stdout)
        if "error" in raw:
            raise RuntimeError(f"HeartTranscriptor error: {raw['error']}")

        # Convert to typed result
        segments: list[TranscriptionSegment] = []
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
            "HeartTranscriptor: %d segments, %d total words",
            len(segments),
            sum(len(s.words) for s in segments),
        )

        return TranscriptionResult(
            segments=segments,
            language=raw.get("language"),
            full_text=raw.get("full_text", ""),
        )
