# SPDX-License-Identifier: MIT
"""Acoustic re-timing stage: CTC forced alignment in a worker process, fused here.

``CtcFusionAligner`` runs the bundled ``_ctc_worker.py`` in a separate
"processing" Python that has torch/torchaudio, and returns each acoustic
model's per-word spans. ``apply_acoustic_alignment`` fuses those with the
result's existing word times (see ``ctc_fusion``) and rewrites only the
``start``/``end`` of every word: text, word count and line structure are
unchanged. Any failure keeps the existing timing and records why.
"""
from __future__ import annotations

import importlib.resources
import json
import logging
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

import numpy as np

from lyricsync._types import SyncResult, TimedWord
from lyricsync.alignment import ctc_fusion

logger = logging.getLogger(__name__)

ENGINE = "ctc-fusion-1"
METADATA_KEY = "acoustic_alignment"


class AcousticAlignmentError(RuntimeError):
    """The acoustic aligner could not produce spans (worker error, timeout, cancel)."""


@dataclass
class AcousticSpans:
    """Per-model word spans from an acoustic aligner.

    ``spans[model]`` holds one ``(start, end)`` per input word, in seconds;
    NaN where the model has no time for that word.
    """
    spans: dict[str, list[tuple[float, float]]]
    models_failed: dict[str, str] = field(default_factory=dict)
    device: str | None = None
    info: dict = field(default_factory=dict)
    # Models the worker never got to (it timed out, crashed or was killed after
    # finishing the others), with why. Empty for a complete run.
    models_lost: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class AcousticAligner(Protocol):
    """Anything that can time a word list against vocal audio, per acoustic model."""

    def align_words(self, audio_paths: list[str], words: list[str]) -> AcousticSpans: ...


def _terminate_tree_and_reap(proc: subprocess.Popen, original_error: BaseException) -> None:
    """Best-effort bounded tree cleanup, then re-raise the original failure."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, check=False, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:
            pass
        try:
            proc.communicate(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            logger.error("CTC worker did not reap after forced termination")
    except OSError:
        pass
    raise original_error


def _default_script_path() -> Path:
    try:
        ref = importlib.resources.files("lyricsync.alignment") / "_ctc_worker.py"
        return Path(str(ref))
    except Exception:  # noqa: BLE001
        return Path(__file__).parent / "_ctc_worker.py"


class CtcFusionAligner:
    """Runs the CTC worker script in a separate Python with torch/torchaudio.

    Model weights download on first use into the processing Python's torch hub
    and Hugging Face caches. With ``allow_cpu=False`` (the default) the worker
    refuses to run without CUDA, so the caller keeps its existing timing.
    """

    def __init__(
        self,
        python_path: str | Path,
        script_path: str | Path | None = None,
        allow_cpu: bool = False,
        cancel_event: threading.Event | None = None,
        timeout: int = 1800,
        models: tuple[str, ...] | None = None,
    ):
        self.python_path = Path(python_path)
        self.script_path = Path(script_path) if script_path is not None else _default_script_path()
        self.allow_cpu = allow_cpu
        self.cancel_event = cancel_event
        self.timeout = timeout
        self.models = tuple(models) if models is not None else None

    def align_words(self, audio_paths: list[str], words: list[str]) -> AcousticSpans:
        if not self.python_path.exists():
            raise AcousticAlignmentError(f"Python interpreter not found: {self.python_path}")
        if not self.script_path.exists():
            raise AcousticAlignmentError(f"CTC worker script not found: {self.script_path}")

        req: dict = {"audio_paths": [str(p) for p in audio_paths], "words": list(words),
                     "allow_cpu": self.allow_cpu}
        if self.models is not None:
            req["models"] = list(self.models)

        with tempfile.TemporaryDirectory(prefix="lyricsync-ctc-") as tmp:
            in_path = Path(tmp) / "request.json"
            out_path = Path(tmp) / "result.json"
            in_path.write_text(json.dumps(req), encoding="utf-8")
            cmd = [str(self.python_path), str(self.script_path),
                   "--input", str(in_path), "--output", str(out_path)]
            logger.info("Running CTC worker: %s (%d words, %d audio)",
                        " ".join(cmd), len(words), len(audio_paths))
            options = ({"start_new_session": True} if os.name == "posix" else
                       {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)})
            # Bytes, not text: universal-newline decoding would turn every
            # carriage-return progress update into its own line.
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    **options)
            deadline = time.monotonic() + self.timeout
            stderr = b""
            killed: AcousticAlignmentError | None = None
            try:
                while True:
                    try:
                        _, stderr = proc.communicate(timeout=0.1)
                        break
                    except subprocess.TimeoutExpired:
                        if self.cancel_event is not None and self.cancel_event.is_set():
                            _terminate_tree_and_reap(
                                proc, AcousticAlignmentError("CTC worker cancelled"),
                            )
                        if time.monotonic() >= deadline:
                            _terminate_tree_and_reap(
                                proc,
                                AcousticAlignmentError(
                                    f"CTC worker timed out after {self.timeout}s"),
                            )
            except AcousticAlignmentError as e:
                if self.cancel_event is not None and self.cancel_event.is_set():
                    raise
                killed = e
            stderr_text = _log_worker_stderr(stderr or b"")
            raw = _read_result(out_path)

        if killed is not None:
            return _partial_or_raise(raw, str(killed), killed)
        if isinstance(raw, dict) and "error" in raw:
            err = AcousticAlignmentError(f"CTC worker error: {raw['error']}")
            return _partial_or_raise(raw, f"worker error: {raw['error']}", err)
        if proc.returncode != 0 or not isinstance(raw, dict) or not raw.get("complete", True):
            err = AcousticAlignmentError(
                f"CTC worker failed (exit {proc.returncode}): {stderr_text[-500:]}"
            )
            return _partial_or_raise(raw, f"worker exited with status {proc.returncode}", err)
        return _to_spans(raw)


_WARN_RE = re.compile(r"warn|error|exception|traceback|fail|refus", re.IGNORECASE)


def _log_worker_stderr(data: bytes) -> str:
    """Log worker stderr: progress-bar redraws collapsed, routine lines at DEBUG."""
    text = data.decode("utf-8", errors="replace")
    kept = []
    for raw_line in text.split("\n"):
        parts = [p for p in raw_line.split("\r") if p.strip()]
        if not parts:
            continue
        line = parts[-1].rstrip()
        kept.append(line)
        level = logging.WARNING if _WARN_RE.search(line) else logging.DEBUG
        logger.log(level, "CTC worker: %s", line)
    return "\n".join(kept)


def _read_result(path: Path):
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _to_spans(raw: dict, lost: dict[str, str] | None = None) -> AcousticSpans:
    spans: dict[str, list[tuple[float, float]]] = {}
    for name, rows in (raw.get("spans") or {}).items():
        spans[name] = [
            (float("nan") if a is None else float(a), float("nan") if b is None else float(b))
            for a, b in rows
        ]
    info = {k: raw[k] for k in ("engine", "elapsed", "duration", "peak_vram_mb",
                                "peak_vram_reserved_mb") if k in raw}
    return AcousticSpans(
        spans=spans,
        models_failed=dict(raw.get("models_failed") or {}),
        device=raw.get("device"),
        info=info,
        models_lost=dict(lost or {}),
    )


def _partial_or_raise(raw, why: str, err: AcousticAlignmentError) -> AcousticSpans:
    """Keep the models a dead worker finished, when enough character models did."""
    if isinstance(raw, dict):
        done = [m for m in ctc_fusion.CHAR_MODELS if m in (raw.get("spans") or {})]
        if len(done) >= ctc_fusion.MIN_CHAR_MODELS:
            lost = {m: why for m in (raw.get("models_pending") or [])}
            logger.warning("CTC worker did not finish (%s); using the %d model(s) it completed",
                           why, len(raw.get("spans") or {}))
            return _to_spans(raw, lost)
    raise err


def _result_words(result: SyncResult) -> list[TimedWord]:
    return [w for line in result.lines for w in line]


def _check_structure(result: SyncResult) -> str:
    """Empty when every segment word lines up with the line words, else the mismatch."""
    words = _result_words(result)
    seg_words = [w for seg in result.segments for w in seg.get("words", [])]
    if len(seg_words) != len(words):
        return f"segment words ({len(seg_words)}) and line words ({len(words)}) differ"
    for sw, lw in zip(seg_words, words, strict=True):
        if sw.get("text") != lw.text:
            return "segment and line word texts differ"
    return ""


def _retime(result: SyncResult, spans: np.ndarray) -> None:
    """Rewrite start/end; text, word count and line grouping stay as they are.

    Everything is computed before anything is assigned, so the result is either
    fully re-timed or untouched.
    """
    times = [(float(a), float(b)) for a, b in np.asarray(spans, float)]
    if len(times) != sum(len(line) for line in result.lines):
        raise ValueError("re-timed span count does not match the result's words")
    new_lines = []
    k = 0
    for line in result.lines:
        new_lines.append([
            TimedWord(text=w.text, start=times[k + j][0], end=times[k + j][1],
                      interpolated=w.interpolated)
            for j, w in enumerate(line)
        ])
        k += len(line)
    k = 0
    seg_updates = []
    for seg in result.segments:
        seg_words = seg.get("words", [])
        word_times = times[k:k + len(seg_words)]
        if len(word_times) != len(seg_words):
            raise ValueError("segment words outnumber the re-timed spans")
        k += len(seg_words)
        seg_updates.append((seg, seg_words, word_times))
    if k != len(times):
        raise ValueError("re-timed span count does not match the result's words")

    result.lines[:] = new_lines
    for seg, seg_words, word_times in seg_updates:
        for w, (s, e) in zip(seg_words, word_times, strict=True):
            w["start"], w["end"] = s, e
        if seg_words and "start" in seg:
            seg["start"] = word_times[0][0]
        if seg_words and "end" in seg:
            seg["end"] = max(e for _, e in word_times)


def apply_acoustic_alignment(
    result: SyncResult,
    aligner: AcousticAligner,
    audio_paths: list[str],
    *,
    start_shift: float = ctc_fusion.DEFAULT_START_SHIFT,
    join_gap: float = ctc_fusion.DEFAULT_JOIN_GAP,
    tail_extend: float = ctc_fusion.DEFAULT_TAIL_EXTEND,
    flag_threshold: float = ctc_fusion.DEFAULT_FLAG_THRESHOLD,
) -> dict:
    """Re-time ``result`` in place against ``audio_paths``; never raises.

    Records (and returns) a summary under ``result.metadata.extra["acoustic_alignment"]``.
    ``flagged_words`` are flat word indices over ``result.lines`` in line order
    (the same order as ``result.segments[*]["words"]``); flagged words are still
    re-timed, the flag is informational. ``models_lost`` names models a worker
    that timed out or crashed never finished, when enough others did.
    """
    meta: dict = {
        "engine": ENGINE,
        "applied": False,
        "reason": "",
        "models_used": [],
        "models_skipped": {},
        "models_lost": {},
        "partial": False,
        "params": {"start_shift": start_shift, "join_gap": join_gap,
                   "tail_extend": tail_extend, "flag_threshold": flag_threshold},
        "flagged_count": 0,
        "flagged_words": [],
    }
    result.metadata.extra[METADATA_KEY] = meta
    try:
        words = _result_words(result)
        mismatch = _check_structure(result)
        paths = [str(p) for p in audio_paths if p]
        if mismatch:
            meta["reason"] = f"result structure not supported: {mismatch}"
        elif not words:
            meta["reason"] = "no words to re-time"
        elif not paths:
            meta["reason"] = "no audio available"
        elif missing := [p for p in paths if not Path(p).exists()]:
            meta["reason"] = f"audio not found: {missing[0]}"
        else:
            out = aligner.align_words(paths, [w.text for w in words])
            meta["models_skipped"] = dict(out.models_failed)
            meta["models_lost"] = dict(getattr(out, "models_lost", {}) or {})
            meta["partial"] = bool(meta["models_lost"])
            if out.device:
                meta["device"] = out.device
            if out.info:
                meta["worker"] = dict(out.info)
            voter = np.array([[w.start, w.end] for w in words], float)
            fused = ctc_fusion.fuse(
                {k: np.asarray(v, float) for k, v in out.spans.items()}, voter,
                start_shift=start_shift, join_gap=join_gap,
                tail_extend=tail_extend, flag_threshold=flag_threshold,
            )
            meta["models_used"] = [m for m in ctc_fusion.START_VOTERS if m in out.spans]
            if not fused.applied:
                meta["reason"] = fused.reason
            elif not np.all(np.isfinite(fused.spans)):
                meta["reason"] = "fused timing is not finite"
            else:
                _retime(result, fused.spans)
                meta["applied"] = True
                meta["flagged_count"] = len(fused.flagged)
                meta["flagged_words"] = fused.flagged
    except Exception as e:  # noqa: BLE001 — this stage must never fail the sync
        meta["reason"] = f"{type(e).__name__}: {e}"[:500]
    if meta["applied"]:
        logger.info("Acoustic alignment applied (%s; %d flagged)",
                    ", ".join(meta["models_used"]), meta["flagged_count"])
    else:
        logger.warning("Acoustic alignment skipped, keeping existing timing: %s", meta["reason"])
    return meta
