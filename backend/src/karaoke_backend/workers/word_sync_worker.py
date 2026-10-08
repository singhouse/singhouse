# SPDX-License-Identifier: AGPL-3.0-only
"""
Word-level lyrics sync worker — thin wrapper around the lyricsync library.

Returns a dict in the word_data shape (lines/segments/metadata) the
orchestrator expects, plus a recommended `label` describing the run config
so the orchestrator can persist it as a LyricsSet.

The transcription step (Heart on GPU ~30 s, large-v3 similar) is cached
to disk per ``(song_id, model, use_vad)``. ``generate_word_sync()`` will
hit the cache when present and only burn GPU on a miss (unless
``force_transcribe=True``, which bypasses the read and re-runs the model);
``realign_only()`` reuses the cache and errors cleanly if it's not there.
A forced re-transcription archives the entry it is about to overwrite as a
write-once ``.baseline.json`` sibling (the deterministic first pass); the
canonical path stays authoritative and every reader keeps using the newest.

Decoding is deterministic by default: every built-in transcriber pins
``temperature=0.0``. ``allow_temperature_fallback=True`` re-arms the
0.0/0.1/0.2/0.4 rescue ladder and is set only by the manual re-transcribe
action, which is the rescue path.
"""

import asyncio
import dataclasses
import logging
import os
import threading
from functools import partial
from pathlib import Path
from typing import Callable, Optional

from lyricsync import AcousticAlignmentError, CtcFusionAligner, PipelineConfig, SyncPipeline
from lyricsync.alignment.ctc_aligner import CUDA_UNAVAILABLE
from lyricsync.alignment.ctc_aligner import ENGINE as ACOUSTIC_ENGINE
from lyricsync.alignment.ctc_aligner import METADATA_KEY as ACOUSTIC_METADATA_KEY
from lyricsync.transcription import FasterWhisperTranscriber, HeartTranscriber

from karaoke_backend import plugins
from karaoke_backend.workers import modal_offload, transcription_cache
from karaoke_backend.workers.managed_processing import (
    InvalidAttestation,
    accelerator_device,
    require_selected_models,
    validated_attestation,
)

logger = logging.getLogger(__name__)

WHISPER_MODELS = {"tiny", "base", "small", "medium", "large", "large-v2", "large-v3"}
TRANSCRIBER_MODELS = {"heart"}
ALL_MODELS = WHISPER_MODELS | TRANSCRIBER_MODELS
DEFAULT_MODEL = "heart"

def _attested_accelerator(model: str = DEFAULT_MODEL) -> str | None:
    device = accelerator_device(capability="transcription")
    require_selected_models("transcription", ["heart-transcriptor"] if model == "heart" else [])
    return device

# Default is cwd-relative (cwd=backend/ is invariant: systemd WorkingDirectory
# and dev docs). HEART_SCRIPT is file-adjacent and correctly moves with the code.
# abspath, NOT resolve(): bin/python is a symlink to the system interpreter, so
# resolving it spawns /usr/bin/pythonX.Y with no venv site-packages.
DEMUCS_PYTHON = Path(
    os.path.abspath(
        os.getenv("KARAOKE_PROCESSING_PYTHON")
        or os.getenv("KARAOKE_DEMUCS_PYTHON", ".venv-demucs/bin/python")
    )
)
HEART_SCRIPT = Path(__file__).resolve().parent / "heart_transcriptor.py"

# ── Acoustic word timing ──────────────────────────────────────────────────
# A final lyricsync stage that re-times every word against the vocal audio
# with several CTC acoustic models, run in the same processing Python as the
# Heart transcriber. It only rewrites word start/end and falls back to the
# existing timing on any failure; the outcome is recorded in the lyric set's
# metadata under ``acoustic_alignment``.
ACOUSTIC_ENV = "KARAOKE_ACOUSTIC_ALIGNMENT"          # default on; 0/false/off disables
ACOUSTIC_CPU_ENV = "KARAOKE_ACOUSTIC_ALIGNMENT_CPU"  # default off: CUDA only
ACOUSTIC_TIMEOUT_ENV = "KARAOKE_ACOUSTIC_ALIGNMENT_TIMEOUT"
# Generous because the first run downloads the model weights (~7.5 GB)
# inside the worker call; a warm run takes a small fraction of this.
ACOUSTIC_DEFAULT_TIMEOUT = 3600
ACOUSTIC_REF_MODES = frozenset({"plain", "synced"})
ACOUSTIC_PROGRESS_MESSAGE = (
    "Aligning words to the vocals (the first run downloads the models)"
)
# Backing-vocal stem summed with the lead for alignment (preference order).
_BACKING_STEM_EXTS = (".flac", ".wav", ".mp3")
_FALSE_VALUES = {"0", "false", "off", "no"}
_TRUE_VALUES = {"1", "true", "on", "yes"}


# Set when the worker refuses for lack of CUDA: the device will not appear
# while this process runs, so later songs skip the spawn.
_cuda_unavailable = False


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if raw in _FALSE_VALUES:
        return False
    if raw in _TRUE_VALUES:
        return True
    return default


def _ref_mode(plain_lyrics: Optional[str], synced_lyrics: Optional[str]) -> str:
    return "synced" if synced_lyrics else "plain" if plain_lyrics else "none"


def acoustic_disabled_reason(ref_mode: str) -> Optional[str]:
    """Why the acoustic stage will not run for this request, or None if it will.

    A run that passes these rules can still fall back at run time (no CUDA
    without ``KARAOKE_ACOUSTIC_ALIGNMENT_CPU``, worker error, timeout); that
    reason is recorded by the stage itself. A CUDA refusal is remembered for
    the rest of the process.
    """
    if ref_mode not in ACOUSTIC_REF_MODES:
        return f"not enabled for reference mode {ref_mode!r}"
    if not _env_flag(ACOUSTIC_ENV, True):
        return f"disabled by {ACOUSTIC_ENV}"
    try:
        managed = validated_attestation() is not None
    except InvalidAttestation:
        managed = True
    if managed:
        return "the managed desktop processing runtime does not include the acoustic models"
    if not DEMUCS_PYTHON.exists():
        return "processing Python not found"
    if _cuda_unavailable:
        return f"{CUDA_UNAVAILABLE} (remembered from an earlier run in this process)"
    return None


def alignment_audio_paths(vocals_path: str) -> tuple[str, list[str]]:
    """``(primary, extras)`` audio for the acoustic stage.

    The transcriber hears the lead-vocals stem only; alignment hears lead plus
    backing, so words sung by backing voices still have audio to align to. A
    full ``vocals.*`` stem (or any other stem) is used alone.
    """
    path = Path(vocals_path)
    if path.stem != "lead_vocals":
        return str(path), []
    for ext in _BACKING_STEM_EXTS:
        backing = path.with_name(f"backing_vocals{ext}")
        if backing.exists():
            return str(path), [str(backing)]
    return str(path), []


class _ReportingAligner:
    """Wraps an aligner to report a progress message when the stage starts."""

    def __init__(self, inner, progress_fn: Optional[Callable[[str], None]]):
        self._inner = inner
        self._progress_fn = progress_fn

    def align_words(self, audio_paths, words):
        if self._progress_fn is not None:
            try:
                self._progress_fn(ACOUSTIC_PROGRESS_MESSAGE)
            except Exception as exc:  # noqa: BLE001 — progress must not fail the stage
                logger.warning("Could not report acoustic alignment progress: %s", exc)
        try:
            return self._inner.align_words(audio_paths, words)
        except AcousticAlignmentError as exc:
            if exc.kind == CUDA_UNAVAILABLE:
                global _cuda_unavailable
                _cuda_unavailable = True
            raise


def _acoustic_timeout() -> int:
    raw = os.getenv(ACOUSTIC_TIMEOUT_ENV, "").strip()
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
        logger.warning("Ignoring invalid %s=%r", ACOUSTIC_TIMEOUT_ENV, raw)
    return ACOUSTIC_DEFAULT_TIMEOUT


def _make_acoustic_aligner(
    *,
    cancel_event: threading.Event | None,
    progress_fn: Optional[Callable[[str], None]] = None,
):
    aligner = CtcFusionAligner(
        python_path=DEMUCS_PYTHON,
        allow_cpu=_env_flag(ACOUSTIC_CPU_ENV, False),
        cancel_event=cancel_event,
        timeout=_acoustic_timeout(),
    )
    return _ReportingAligner(aligner, progress_fn)


def _acoustic_setup(
    pipeline_config: Optional[PipelineConfig],
    ref_mode: str,
    *,
    cancel_event: threading.Event | None,
    progress_fn: Optional[Callable[[str], None]],
):
    """``(effective_config, aligner_or_None, disabled_reason_or_None)``.

    The backend owns the enablement decision: the stored ``pipeline_config``
    shows whether the stage was asked to run for this set.
    """
    pipeline_config = pipeline_config or PipelineConfig()
    reason = acoustic_disabled_reason(ref_mode)
    if reason is not None:
        return dataclasses.replace(pipeline_config, acoustic_alignment=False), None, reason
    aligner = _make_acoustic_aligner(cancel_event=cancel_event, progress_fn=progress_fn)
    return dataclasses.replace(pipeline_config, acoustic_alignment=True), aligner, None


def available_models() -> set[str]:
    """Model names this backend can transcribe with.

    The hardcoded built-ins (:data:`ALL_MODELS`) unioned with any names
    advertised by installed transcriber plugins. Built-in names ALWAYS win a
    collision — a plugin re-declaring one is warned about and that name is left
    pointing at the built-in. With no plugin installed this returns exactly
    ``ALL_MODELS`` (the additive-hook invariant); the built-in
    dispatch chain in :func:`_make_transcriber` is untouched.
    """
    models = set(ALL_MODELS)
    for ep_name, provider in plugins.instantiate_group(plugins.GROUP_TRANSCRIBERS):
        for model in getattr(provider, "models", ()) or ():
            if model in ALL_MODELS:
                logger.warning(
                    "Transcriber plugin %r declares built-in model %r — "
                    "built-in wins, plugin declaration ignored for that name",
                    ep_name,
                    model,
                )
                continue
            models.add(model)
    return models


def _plugin_transcriber(whisper_model: str, *, use_vad: bool):
    """Return a transcriber from the first enabled plugin that advertises
    ``whisper_model``, else ``None``.

    Consulted ONLY for non-built-in names (see :func:`_make_transcriber`), so
    the built-in dispatch chain is never reached or altered by a plugin.
    """
    for ep_name, provider in plugins.instantiate_group(plugins.GROUP_TRANSCRIBERS):
        try:
            if whisper_model not in (getattr(provider, "models", ()) or ()):
                continue
            if not provider.is_enabled():
                continue
            return provider.create(whisper_model, use_vad=use_vad)
        except Exception:  # noqa: BLE001 — a bad plugin must not break dispatch
            logger.exception(
                "Transcriber plugin %r failed to create model %r",
                ep_name,
                whisper_model,
            )
            continue
    return None


def _make_transcriber(
    whisper_model: str, *, use_vad: bool, allow_temperature_fallback: bool = False,
    cancel_event: threading.Event | None = None,
):
    """Build the transcriber for ``whisper_model``.

    ``allow_temperature_fallback`` is forwarded to the BUILT-IN transcribers
    only — it is a constructor option, not part of the ``Transcriber`` protocol,
    so plugin-provided transcribers never receive it and keep whatever decoding
    policy they already had.
    """
    if whisper_model not in ALL_MODELS:
        # Non-built-in name: dispatch to a transcriber plugin (additive
        # hook). Built-in names never enter this branch, so the built-in chain
        # below is byte-for-byte unchanged when no plugin is installed.
        transcriber = _plugin_transcriber(whisper_model, use_vad=use_vad)
        if transcriber is not None:
            return transcriber
        raise ValueError(f"No transcriber plugin provides model {whisper_model!r}")
    if whisper_model == "heart":
        if modal_offload.is_enabled():
            # Run the Heart model on a Modal GPU container.
            return modal_offload.ModalHeartTranscriber(
                use_vad=use_vad,
                allow_temperature_fallback=allow_temperature_fallback,
            )
        if not DEMUCS_PYTHON.exists():
            logger.warning(
                "Demucs python not found at %s — heart transcription spawn will "
                "fail (set KARAOKE_DEMUCS_PYTHON or create .venv-demucs)",
                DEMUCS_PYTHON,
            )
        return HeartTranscriber(
            python_path=DEMUCS_PYTHON,
            script_path=HEART_SCRIPT,
            use_vad=use_vad,
            allow_temperature_fallback=allow_temperature_fallback,
            cancel_event=cancel_event,
            accelerator=_attested_accelerator(whisper_model),
        )
    accelerator = _attested_accelerator(whisper_model)
    if accelerator == "mps":
        raise RuntimeError("Managed Metal does not support faster-whisper")
    device_options = ({"device": accelerator,
                       "compute_type": "float16" if accelerator == "cuda" else "int8"}
                      if accelerator else {})
    return FasterWhisperTranscriber(
        model=whisper_model,
        allow_temperature_fallback=allow_temperature_fallback,
        **device_options,
    )


def _read_api_key() -> str:
    """Resolve the LLM API key: env var first, then key-file."""
    key = os.environ.get("KARAOKE_LLM_API_KEY", "").strip()
    if key:
        return key
    key_file = os.environ.get("KARAOKE_LLM_API_KEY_FILE", "").strip()
    if key_file:
        try:
            return Path(key_file).expanduser().read_text().strip()
        except OSError as e:
            logger.warning("Cannot read KARAOKE_LLM_API_KEY_FILE: %s", e)
    return ""


def _with_env_correction(cfg: PipelineConfig) -> PipelineConfig:
    """No longer auto-enables correction from env.

    Correction is now per-request (upload UI toggle → ``make_correction_config``).
    Env vars supply creds only; they no longer imply intent. This function is
    kept as a passthrough so existing callers are unchanged.
    """
    return cfg


def make_correction_config(cfg: PipelineConfig) -> PipelineConfig:
    """Enable LLM correction on ``cfg`` using env-configured endpoint creds.

    Used when the request explicitly toggles correction on (the env vars
    supply the endpoint/key; the toggle supplies the intent).
    """
    if cfg.correction.enabled:
        return cfg
    base_url = os.environ.get("KARAOKE_LLM_BASE_URL", "").strip()
    if not base_url:
        logger.warning("LLM correction requested but KARAOKE_LLM_BASE_URL is unset")
        return cfg
    correction = dataclasses.replace(
        cfg.correction,
        enabled=True,
        base_url=base_url,
        model=os.environ.get("KARAOKE_LLM_MODEL", "local"),
        api_key=_read_api_key(),
        timeout=float(os.environ.get("KARAOKE_LLM_TIMEOUT", "600")),
    )
    return dataclasses.replace(cfg, correction=correction)


def _make_pipeline(
    whisper_model: str,
    *,
    use_vad: bool = True,
    config: Optional[PipelineConfig] = None,
    correction_progress_fn=None,
    allow_temperature_fallback: bool = False,
    cancel_event: threading.Event | None = None,
    acoustic_aligner=None,
) -> SyncPipeline:
    """Build a configured SyncPipeline.

    Heart defaults to ``use_vad=True`` because the eval data shows it cuts
    mean start-offset error from ~700 ms to ~150 ms (and gets ~83 % of words
    within 250 ms vs ~74 % without VAD).
    """
    transcriber = _make_transcriber(
        whisper_model,
        use_vad=use_vad,
        allow_temperature_fallback=allow_temperature_fallback,
        cancel_event=cancel_event,
    )
    cfg = _with_env_correction(config or PipelineConfig())
    return SyncPipeline(
        transcriber=transcriber, config=cfg,
        correction_progress_fn=correction_progress_fn,
        acoustic_aligner=acoustic_aligner,
    )


def describe_run(whisper_model: str, *, use_vad: bool = True) -> str:
    """Produce a human-readable label for a transcription run."""
    if whisper_model == "heart":
        return "heart-vad" if use_vad else "heart"
    return whisper_model


def _result_to_dict(
    result,
    *,
    artist: str,
    title: str,
    whisper_model: str,
    use_vad: bool,
    plain_lyrics: Optional[str],
    synced_lyrics: Optional[str],
    pipeline_config: PipelineConfig,
    allow_temperature_fallback: bool,
    acoustic_disabled: Optional[str] = None,
) -> dict:
    """Shape a SyncResult into the word_data dict the orchestrator expects.

    Per-word dicts stay ``{text, start, end}``; the acoustic stage's record
    (including its low-confidence word indices) lives only in the metadata.
    """
    ref_mode = _ref_mode(plain_lyrics, synced_lyrics)

    lines_as_dicts = [
        [{"text": w.text, "start": w.start, "end": w.end} for w in line]
        for line in result.lines
    ]

    cfg_dict = dataclasses.asdict(pipeline_config)
    # The stored metadata is user-visible; a bearer token must never land
    # in the DB no matter how the config reached us.
    cfg_dict.get("correction", {}).pop("api_key", None)

    extra = dict(result.metadata.extra)
    if acoustic_disabled is not None and ACOUSTIC_METADATA_KEY not in extra:
        extra[ACOUSTIC_METADATA_KEY] = {
            "engine": ACOUSTIC_ENGINE,
            "enabled": False,
            "applied": False,
            "reason": acoustic_disabled,
        }
    elif isinstance(extra.get(ACOUSTIC_METADATA_KEY), dict):
        extra[ACOUSTIC_METADATA_KEY] = {"enabled": True, **extra[ACOUSTIC_METADATA_KEY]}

    return {
        "segments": result.segments,
        "lines": lines_as_dicts,
        "metadata": {
            "words_total": result.metadata.words_total,
            "words_matched": result.metadata.words_matched,
            "words_corrected": result.metadata.words_corrected,
            "words_interpolated": result.metadata.words_interpolated,
            "lines_total": result.metadata.lines_total,
            "method": result.metadata.method,
            "artist": artist,
            "title": title,
            "language": result.metadata.language,
            "model": whisper_model,
            "use_vad": bool(use_vad and whisper_model == "heart"),
            "ref_mode": ref_mode,
            # Which decoding policy produced THIS set. Without it a rescue
            # result and a deterministic one are indistinguishable after the
            # fact, and telling a real regression from a reroll is the whole
            # point of pinning the first pass to greedy.
            "temperature_fallback": bool(allow_temperature_fallback),
            "pipeline_config": cfg_dict,
            **extra,
        },
    }


def _may_write_cache(
    guard: Optional[Callable[[], bool]], cache_file: Path
) -> bool:
    """Ask the caller whether the cache write is still ours to make.

    ``force_transcribe`` made this a write the cache-hit path never reached, so
    it needs the same protection the DB write in ``jobs.transcribe._persist_set``
    already has: a worker whose lease lapsed mid-transcription would otherwise
    wake up and overwrite the cache with a transcription no lyrics set
    corresponds to, and the next ``/realign`` would align against it.

    A guard that raises is treated as "don't write" — this runs deep inside the
    blocking pipeline thread and must never take the transcription down with it;
    the caller's own claim re-check is what actually fails the job.
    """
    if guard is None:
        return True
    try:
        allowed = bool(guard())
    except Exception as exc:  # noqa: BLE001 — see docstring
        logger.warning(
            "Transcription cache write guard failed for %s — skipping the write: %s",
            cache_file,
            exc,
        )
        return False
    if not allowed:
        logger.warning(
            "Skipping transcription cache write for %s: the job's claim was lost, "
            "so this transcription has no lyrics set to belong to",
            cache_file,
        )
    return allowed


def _run_blocking(
    *,
    vocals_path: str,
    artist: str,
    title: str,
    plain_lyrics: Optional[str],
    synced_lyrics: Optional[str],
    whisper_model: str,
    language: Optional[str],
    use_vad: bool,
    song_id: Optional[int],
    pipeline_config: PipelineConfig,
    correction_progress_fn=None,
    allow_temperature_fallback: bool = False,
    force_transcribe: bool = False,
    cache_write_guard: Optional[Callable[[], bool]] = None,
    cancel_event: threading.Event | None = None,
    stage_progress_fn: Optional[Callable[[str], None]] = None,
) -> Optional[dict]:
    """Cache-aware transcribe-then-align (synchronous core).

    ``force_transcribe`` skips the cache READ only: the transcriber always runs
    and the result still overwrites the cache, so a later realign/resume keeps
    working off the newest transcription. Without it (the ingest default) a hit
    goes straight to ``align_only`` — otherwise a manual re-transcribe of a song
    whose settings are unchanged would replay the cached run and never
    re-transcribe at all.

    ``cache_write_guard`` is an optional last-moment liveness check consulted
    just before the cache write (see :func:`_may_write_cache`).

    The acoustic word-timing stage (when enabled) runs inside ``align_only``
    on every run, after the cache read/write, so the cache keeps storing the
    raw transcription. ``stage_progress_fn(message)`` is called when it starts.
    """
    if not Path(vocals_path).exists():
        logger.warning("Vocals stem not found: %s", vocals_path)
        return None

    label = describe_run(whisper_model, use_vad=use_vad)
    cache_file = (
        transcription_cache.cache_path(song_id, label) if song_id is not None else None
    )

    if force_transcribe:
        cached = None
        logger.info(
            "force_transcribe: re-running the model (%s)",
            f"bypassing transcription cache {cache_file}"
            if cache_file is not None
            else "no song_id, so there is no transcription cache to bypass",
        )
    else:
        cached = transcription_cache.load(cache_file) if cache_file else None
    pipeline_config, acoustic_aligner, acoustic_disabled = _acoustic_setup(
        pipeline_config, _ref_mode(plain_lyrics, synced_lyrics),
        cancel_event=cancel_event, progress_fn=stage_progress_fn,
    )
    align_audio, extra_audio = alignment_audio_paths(vocals_path)
    pipeline = _make_pipeline(
        whisper_model, use_vad=use_vad, config=pipeline_config,
        correction_progress_fn=correction_progress_fn,
        allow_temperature_fallback=allow_temperature_fallback,
        cancel_event=cancel_event,
        acoustic_aligner=acoustic_aligner,
    )

    if cached is not None:
        logger.info(
            "Transcription cache hit: %s — running align_only", cache_file,
        )
        result = pipeline.align_only(
            whisper_result=cached,
            plain_lyrics=plain_lyrics,
            synced_lyrics=synced_lyrics,
            audio_path=align_audio,
            extra_audio_paths=extra_audio,
        )
    else:
        try:
            transcription = pipeline.transcriber.transcribe(vocals_path, language)
        except Exception as exc:
            logger.error("Transcription failed: %s", exc)
            return None

        if cache_file is not None and _may_write_cache(cache_write_guard, cache_file):
            if force_transcribe:
                # Archive BEFORE overwriting, and only here: the ingest path
                # writes into an empty slot, so there is nothing to preserve.
                # Write-once inside `preserve_baseline`, so the archive keeps
                # the deterministic FIRST pass rather than tracking the most
                # recent re-roll: keep both files, newest stays active.
                #
                # Belt and braces on top of the OSError `preserve_baseline`
                # already swallows. By here the transcription is DONE and has
                # cost real GPU time; nothing the archive can do is worth
                # discarding it, so no failure mode of an optional bookkeeping
                # copy is allowed to reach the caller.
                try:
                    transcription_cache.preserve_baseline(cache_file)
                except Exception as exc:  # noqa: BLE001 - see above
                    logger.warning("Failed to preserve transcription baseline: %s", exc)
            try:
                transcription_cache.save(cache_file, transcription)
            except OSError as exc:
                logger.warning("Failed to write transcription cache: %s", exc)

        result = pipeline.align_only(
            whisper_result=transcription,
            plain_lyrics=plain_lyrics,
            synced_lyrics=synced_lyrics,
            audio_path=align_audio,
            extra_audio_paths=extra_audio,
        )

    if result is None:
        return None

    return _result_to_dict(
        result,
        artist=artist,
        title=title,
        whisper_model=whisper_model,
        use_vad=use_vad,
        plain_lyrics=plain_lyrics,
        synced_lyrics=synced_lyrics,
        pipeline_config=pipeline_config,
        allow_temperature_fallback=allow_temperature_fallback,
        acoustic_disabled=acoustic_disabled,
    )


async def generate_word_sync(
    vocals_path: str,
    artist: str,
    title: str,
    plain_lyrics: Optional[str] = None,
    synced_lyrics: Optional[str] = None,
    whisper_model: str = DEFAULT_MODEL,
    language: Optional[str] = None,
    use_vad: bool = True,
    song_id: Optional[int] = None,
    pipeline_config: Optional[PipelineConfig] = None,
    correction_progress_fn=None,
    allow_temperature_fallback: bool = False,
    force_transcribe: bool = False,
    cache_write_guard: Optional[Callable[[], bool]] = None,
    stage_progress_fn: Optional[Callable[[str], None]] = None,
) -> Optional[dict]:
    """Full pipeline: transcribe (cached) → align → word-level sync.

    Returns a dict shaped as::

        {
            "segments": [...],
            "lines": [[{"text", "start", "end"}, ...], ...],
            "metadata": {... lyricsync metadata ...,
                         "model": <name>, "use_vad": bool,
                         "ref_mode": "synced"|"plain"|"none",
                         "temperature_fallback": bool,
                         "pipeline_config": {...}},
        }

    ``metadata["acoustic_alignment"]`` records the acoustic word-timing stage:
    whether it was enabled and applied, a short reason when not, the models
    used/skipped, its parameters and the low-confidence word indices
    (``flagged_words``). Per-word dicts stay ``{text, start, end}``.

    The raw transcription is cached at
    ``STEMS_DIR/{song_id}/transcription.{label}.json`` so a follow-up
    ``realign_only(...)`` can skip the GPU run.

    Both new flags default to False, which is what the ingest path wants: a
    deterministic greedy decode, cache-aware. Only the manual re-transcribe
    action sets them — ``allow_temperature_fallback`` re-arms the
    0.0/0.1/0.2/0.4 rescue ladder, ``force_transcribe`` makes the run actually
    re-transcribe instead of replaying the ingest-populated cache.
    """
    valid_models = available_models()
    if whisper_model not in valid_models:
        raise ValueError(
            f"Invalid model {whisper_model!r}. Must be one of: {sorted(valid_models)}"
        )

    cfg = pipeline_config or PipelineConfig()

    loop = asyncio.get_running_loop()
    cancel_event = threading.Event()
    future = loop.run_in_executor(
        None,
        partial(
            _run_blocking,
            vocals_path=vocals_path,
            artist=artist,
            title=title,
            plain_lyrics=plain_lyrics,
            synced_lyrics=synced_lyrics,
            whisper_model=whisper_model,
            language=language,
            use_vad=use_vad,
            song_id=song_id,
            pipeline_config=cfg,
            correction_progress_fn=correction_progress_fn,
            allow_temperature_fallback=allow_temperature_fallback,
            force_transcribe=force_transcribe,
            cache_write_guard=cache_write_guard,
            cancel_event=cancel_event,
            stage_progress_fn=stage_progress_fn,
        ),
    )
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        cancel_event.set()
        try:
            # Capacity belongs to the work, not merely its asyncio wrapper.
            # Plugins, Modal clients, and in-process transcribers have no
            # universal cancellation protocol, so a noncooperative backend
            # deliberately delays shutdown rather than allowing overlap.
            await asyncio.shield(future)
        except Exception:
            pass
        raise


def _realign_blocking(
    *,
    song_id: int,
    artist: str,
    title: str,
    plain_lyrics: Optional[str],
    synced_lyrics: Optional[str],
    whisper_model: str,
    use_vad: bool,
    pipeline_config: PipelineConfig,
    vocals_path: Optional[str],
    correction_progress_fn=None,
    cancel_event: threading.Event | None = None,
    stage_progress_fn: Optional[Callable[[str], None]] = None,
) -> Optional[dict]:
    label = describe_run(whisper_model, use_vad=use_vad)
    cache_file = transcription_cache.cache_path(song_id, label)

    cached = transcription_cache.load(cache_file)
    if cached is None:
        raise FileNotFoundError(
            f"No cached transcription for song {song_id} ({label}). "
            f"Run a full transcription first."
        )

    pipeline_config, acoustic_aligner, acoustic_disabled = _acoustic_setup(
        pipeline_config, _ref_mode(plain_lyrics, synced_lyrics),
        cancel_event=cancel_event, progress_fn=stage_progress_fn,
    )
    align_audio, extra_audio = (
        alignment_audio_paths(vocals_path) if vocals_path else (None, [])
    )
    pipeline = _make_pipeline(
        whisper_model, use_vad=use_vad, config=pipeline_config,
        correction_progress_fn=correction_progress_fn,
        acoustic_aligner=acoustic_aligner,
    )
    result = pipeline.align_only(
        whisper_result=cached,
        plain_lyrics=plain_lyrics,
        synced_lyrics=synced_lyrics,
        audio_path=align_audio,
        extra_audio_paths=extra_audio,
    )
    if result is None:
        return None

    return _result_to_dict(
        result,
        artist=artist,
        title=title,
        whisper_model=whisper_model,
        use_vad=use_vad,
        plain_lyrics=plain_lyrics,
        synced_lyrics=synced_lyrics,
        pipeline_config=pipeline_config,
        # A realign never transcribes, so no decoding policy was exercised for
        # this result. The cached transcription's own policy is not recorded
        # (the cache label deliberately ignores it).
        allow_temperature_fallback=False,
        acoustic_disabled=acoustic_disabled,
    )


async def realign_only(
    song_id: int,
    artist: str,
    title: str,
    plain_lyrics: Optional[str] = None,
    synced_lyrics: Optional[str] = None,
    whisper_model: str = DEFAULT_MODEL,
    use_vad: bool = True,
    pipeline_config: Optional[PipelineConfig] = None,
    vocals_path: Optional[str] = None,
    correction_progress_fn=None,
    stage_progress_fn: Optional[Callable[[str], None]] = None,
) -> Optional[dict]:
    """Realign cached transcription against new reference lyrics.

    ``vocals_path`` enables the onset-trim pass (word starts that sit in
    silence get pushed to the next voice onset). The cache stores raw
    transcription timestamps, so the trim re-applies on every realign.

    ``correction_progress_fn`` is reported for the same reason the transcribe
    path reports it: LLM correction is an ALIGNMENT-stage pass, so a config
    with correction enabled makes this call spend minutes inside the aligner,
    and a job that publishes nothing for that long looks wedged. It only fires
    on a PLAIN-TEXT reference: a synced (LRC) reference is aligned by the
    LRC-anchored aligner, which holds no corrector, and an unanchored realign
    reaches no aligner at all. In either of those a correction-enabled config
    is honoured in the sense that nothing rejects it — and corrects nothing.

    ``vocals_path`` is also the acoustic word-timing stage's audio (with a
    sibling backing-vocals stem, see :func:`alignment_audio_paths`), so a
    re-align re-times an existing song without re-transcribing it. On
    cancellation the stage's worker process is terminated; the job cancels
    without waiting for the rest of the thread, as before.

    Raises ``FileNotFoundError`` if no cache exists for the given
    ``(song_id, whisper_model, use_vad)`` triple.
    """
    valid_models = available_models()
    if whisper_model not in valid_models:
        raise ValueError(
            f"Invalid model {whisper_model!r}. Must be one of: {sorted(valid_models)}"
        )

    cfg = pipeline_config or PipelineConfig()

    loop = asyncio.get_running_loop()
    cancel_event = threading.Event()
    future = loop.run_in_executor(
        None,
        partial(
            _realign_blocking,
            song_id=song_id,
            artist=artist,
            title=title,
            plain_lyrics=plain_lyrics,
            synced_lyrics=synced_lyrics,
            whisper_model=whisper_model,
            use_vad=use_vad,
            pipeline_config=cfg,
            vocals_path=vocals_path,
            correction_progress_fn=correction_progress_fn,
            cancel_event=cancel_event,
            stage_progress_fn=stage_progress_fn,
        ),
    )
    try:
        return await future
    except asyncio.CancelledError:
        cancel_event.set()
        raise
