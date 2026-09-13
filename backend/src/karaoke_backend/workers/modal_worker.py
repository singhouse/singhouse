# SPDX-License-Identifier: AGPL-3.0-only
"""
Two-pass local stem separation worker.

Pass 1: Hybrid Demucs (mdx_extra) — vocals vs. instrumental
  Syed et al. 2025 found mdx_extra achieved 8.76 dB SDR for vocals on MUSDB18.

Pass 2: karaoke model — lead vs. backing vocals
  mel_band_roformer by default (SDR ~10.20), but the uploader can pick a
  different Pass-2 model per song from ``karaoke_models.CHOICES`` — the
  Roformer keeps a multi-tracked singer's doubles with the lead, and MDX-Net
  separates those better. Runs via python-audio-separator either way.

Output stems:
  - instrumental.wav   (drums + bass + other mixed)
  - lead_vocals.wav    (lead vocals only — fed to Whisper)
  - backing_vocals.wav (backing/harmony vocals)
  - karaoke.wav        (instrumental + backing vocals — for singing along)
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
import shutil
import signal
import subprocess
from pathlib import Path
from typing import Callable, Awaitable, Optional

from karaoke_backend import plugins
from karaoke_backend.workers import karaoke_models, modal_offload
from karaoke_backend.workers.managed_processing import InvalidAttestation, accelerator_device

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str, int, str], Awaitable[None]]

# Additive plugin hook: names a separator plugin to use INSTEAD of the built-in
# modal/local dispatch. Unset by default → built-in dispatch untouched.
SEPARATOR_ENV = "KARAOKE_SEPARATOR"

# Path to demucs/audio-separator venv python. Default is cwd-relative
# (cwd=backend/ is invariant: systemd WorkingDirectory and dev docs).
# abspath, NOT resolve(): bin/python is a symlink to the system interpreter, so
# resolving it spawns /usr/bin/pythonX.Y with no venv site-packages — and points
# .parent at /usr/bin, breaking the pass-2 audio-separator lookup as well.
DEMUCS_PYTHON = Path(
    os.path.abspath(
        os.getenv("KARAOKE_PROCESSING_PYTHON")
        or os.getenv("KARAOKE_DEMUCS_PYTHON", ".venv-demucs/bin/python")
    )
)

# Pass 1: Demucs model for vocal/instrumental separation
DEFAULT_DEMUCS_MODEL = os.getenv("DEMUCS_MODEL", "mdx_extra")

# Pass 2: DEFAULT karaoke model for the lead/backing vocal split. Not the only
# one: an upload may name any ID in ``karaoke_models.CHOICES``, and the choice
# that means "use this variable" is the allowlist's default.
KARAOKE_MODEL = os.getenv(
    "KARAOKE_MODEL",
    "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
)

# Where audio-separator caches the Pass 2 model. Defaults to a persistent
# on-disk path under backend/ — NOT audio-separator's own /tmp default, which is
# tmpfs and wiped on every reboot. A re-download over a flaky link can truncate,
# and modal_worker treats a Pass 2 load failure as non-fatal (full vocals as
# lead + silent backing), so a bad cache silently produces empty backing stems.
KARAOKE_MODEL_DIR = os.getenv(
    "AUDIO_SEPARATOR_MODEL_DIR",
    os.getenv("KARAOKE_MODEL_DIR", str(Path("ckpt/audio-separator-models").resolve())),
)


class StemSeparationError(Exception):
    """Raised when stem separation fails."""

def configured_accelerator() -> str:
    """Use a verified desktop device, preserving the legacy CUDA default."""
    try:
        return accelerator_device(capability="separation") or "cuda"
    except InvalidAttestation as exc:
        raise StemSeparationError(str(exc)) from exc


def configured_pass2_device() -> str | None:
    """Return audio-separator's managed device, or None in legacy mode."""
    if not os.getenv("KARAOKE_DESKTOP_PROCESSING_JSON", "").strip():
        return None
    device = configured_accelerator()
    declared = os.getenv("KARAOKE_AUDIO_SEPARATOR_DEVICE", "").strip()
    if declared != device or declared not in {"cpu", "cuda", "mps"}:
        raise StemSeparationError("Audio-separator device does not match attestation")
    return declared


def _find_demucs_output(out_dir: Path, model_name: str, audio_stem: str) -> Optional[Path]:
    """Find the demucs output directory (it nests under model_name/audio_stem/)."""
    candidate = out_dir / model_name / audio_stem
    if candidate.exists():
        return candidate
    # Fallback: first subdir under model dir
    model_dir = out_dir / model_name
    if model_dir.exists():
        for d in model_dir.iterdir():
            if d.is_dir():
                return d
    return None


async def _run_subprocess(cmd: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    """Run one job-owned child and reap it before returning or unwinding.

    ``subprocess.run`` in an executor outlives cancellation of the awaiting
    coroutine.  That allowed a timed-out job to release the worker's sole
    capacity slot while Demucs/ffmpeg was still consuming it.  Keep the child
    handle in the task which owns the job and always wait after terminating.
    """
    spawn_options = (
        {"start_new_session": True}
        if os.name == "posix"
        else {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    )
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **spawn_options,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except (asyncio.CancelledError, asyncio.TimeoutError):
        try:
            if process.returncode is None and os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            elif process.returncode is None:
                # taskkill receives an argv vector (no shell) and /T terminates
                # descendants before the direct child is awaited below.
                killer = await asyncio.create_subprocess_exec(
                    "taskkill", "/PID", str(process.pid), "/T", "/F",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(killer.wait(), timeout=5)
                if process.returncode is None:
                    process.kill()
        except (OSError, ProcessLookupError, asyncio.TimeoutError):
            logger.debug("Child tree exited during termination", exc_info=True)
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except OSError:
                    pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                logger.error("Child %s did not exit after forced termination", process.pid)
        raise
    result = subprocess.CompletedProcess(
        cmd,
        process.returncode,
        stdout.decode(errors="replace"),
        stderr.decode(errors="replace"),
    )
    if result.returncode != 0:
        raise StemSeparationError(
            f"Command failed (exit {result.returncode}):\n{result.stderr[-1000:]}"
        )
    return result


async def _await_subprocess(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    """Compatibility seam for tests and third-party patches of the old helper."""
    result = _run_subprocess(cmd, timeout=timeout)
    if inspect.isawaitable(result):
        result = await result
    return result


def _plugin_separator():
    """Return the separator plugin named by ``KARAOKE_SEPARATOR``, else ``None``.

    Read at call time. With ``KARAOKE_SEPARATOR`` unset (the default) this
    returns ``None`` immediately, so the built-in modal/local dispatch
    in :func:`separate_stems` is byte-for-byte unchanged (additive plugin hook).
    A named-but-missing or disabled plugin logs a warning and falls back to the
    built-in dispatch — the env can never silently disable separation.
    """
    name = os.getenv(SEPARATOR_ENV, "").strip()
    if not name:
        return None
    for ep_name, provider in plugins.instantiate_group(plugins.GROUP_SEPARATORS):
        if name not in (getattr(provider, "name", None), ep_name):
            continue
        try:
            if provider.is_enabled():
                return provider
            logger.warning(
                "%s=%s names a separator plugin that is not enabled — "
                "using built-in dispatch",
                SEPARATOR_ENV,
                name,
            )
        except Exception:  # noqa: BLE001 — a bad plugin must not break dispatch
            logger.exception(
                "Separator plugin %r failed selection — using built-in dispatch",
                name,
            )
        return None
    logger.warning(
        "%s=%s names no installed separator plugin — using built-in dispatch",
        SEPARATOR_ENV,
        name,
    )
    return None


def _accepts_karaoke_model(fn) -> bool:
    """True when ``fn`` can be called with a ``karaoke_model=`` keyword.

    A signature we cannot read (C callable, exotic wrapper) answers False —
    dropping the per-song pick beats a TypeError that fails the whole job.
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return False
    for param in sig.parameters.values():
        if param.kind is inspect.Parameter.VAR_KEYWORD:
            return True
        if param.name == "karaoke_model" and param.kind in (
            inspect.Parameter.KEYWORD_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        ):
            return True
    return False


async def run_pass2(
    vocals_src: Path,
    out_dir: Path,
    pass2_model: str,
    progress: ProgressCallback,
    allow_alphabetical_fallback: bool = True,
) -> tuple[Optional[Path], Optional[Path]]:
    """Split a vocal stem into lead and backing, and say what it produced.

    Returns ``(lead, backing)`` as paths INSIDE ``out_dir``; either may be
    ``None`` when that half could not be identified in the separator's output.
    Raises ``StemSeparationError`` when the separator itself fails.

    Deciding nothing is the point of the split. ``separate_stems`` answers a
    missing half with the full vocals and a silent backing track, because an
    ingest with imperfect stems still yields a usable song; the re-split job
    answers it by failing, because it would otherwise overwrite stems that
    already work. Neither policy belongs in here.

    ``allow_alphabetical_fallback`` is the one piece of guessing this function
    does: when the separator's filenames say nothing, it picks the pair by sort
    order. On a first ingest a guessed pair beats no song, so it stays on. A
    re-split turns it OFF — guessing wrong there swaps lead and backing on a
    song that was already correct, which is worse than refusing.
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    # audio-separator outputs: <filename>_(Vocals).wav and <filename>_(Instrumental).wav
    # For karaoke models: "Vocals" = lead vocals, "Instrumental" = backing vocals
    pass2_device = configured_pass2_device()
    # Managed packs relocate the selected interpreter and omit console-script
    # shebangs that point back at the build machine. Invoke the fixed package
    # entry point in that interpreter; isolation excludes cwd/user-site imports.
    entrypoint = ([str(DEMUCS_PYTHON), "-I", "-B", "-m",
                   "karaoke_backend.workers.managed_audio_separator"]
                  if pass2_device is not None else
                  [str(DEMUCS_PYTHON.parent / "audio-separator")])
    karaoke_cmd = [
        *entrypoint,
        str(vocals_src),
        "--model_filename", pass2_model,
        "--model_file_dir", KARAOKE_MODEL_DIR,
        "--output_dir", str(out_dir),
        "--output_format", "WAV",
    ]
    if pass2_device is not None:
        karaoke_cmd.extend(["--device", pass2_device])
    logger.info("Running karaoke separation (%s): %s", pass2_model, " ".join(karaoke_cmd))

    await _await_subprocess(karaoke_cmd, timeout=600)
    await progress("processing", 70, "Lead/backing split complete")

    lead: Optional[Path] = None
    backing: Optional[Path] = None
    for f in out_dir.iterdir():
        name_lower = f.name.lower()
        if "(vocals)" in name_lower or "_vocals_" in name_lower:
            lead = f
        elif "(instrumental)" in name_lower or "_instrumental_" in name_lower:
            backing = f

    # Fallback if naming convention didn't match
    if (lead is None or backing is None) and allow_alphabetical_fallback:
        outputs = sorted(out_dir.glob("*.wav"))
        if len(outputs) >= 2:
            # Convention: first alphabetically is usually instrumental/backing
            lead, backing = outputs[-1], outputs[0]
            logger.info("Karaoke output naming unclear, using alphabetical order")

    return lead, backing


async def separate_stems(
    audio_path: Path,
    stems_dir: Path,
    job_id: str,
    on_progress: Optional[ProgressCallback] = None,
    karaoke_model: Optional[str] = None,
) -> dict[str, Path]:
    """
    Two-pass stem separation pipeline.

    Pass 1: Demucs mdx_extra → vocals.wav + drums/bass/other
    Pass 2: karaoke model → lead_vocals + backing_vocals
    Then: mix instrumental, mix karaoke (instrumental + backing)

    ``karaoke_model`` is an ID from ``karaoke_models.CHOICES`` naming the Pass-2
    model for THIS job; ``None`` (the default) uses the server-configured
    ``KARAOKE_MODEL``. It is resolved to a filename once, here, so all three
    dispatch paths below carry the same already-validated string.
    """
    pass2_model = karaoke_models.resolve(karaoke_model, KARAOKE_MODEL)

    async def _progress(status: str, pct: int, msg: str) -> None:
        logger.info("[job %s] %s (%d%%) — %s", job_id, status, pct, msg)
        if on_progress:
            await on_progress(status, pct, msg)

    # Additive plugin hook: a separator plugin runs ONLY when KARAOKE_SEPARATOR
    # names an installed, enabled one. Unset by default → separator is None →
    # the built-in dispatch below is byte-for-byte unchanged.
    separator = _plugin_separator()
    if separator is not None:
        logger.info(
            "[job %s] separating via plugin %r (KARAOKE_SEPARATOR)",
            job_id,
            os.getenv(SEPARATOR_ENV, "").strip(),
        )
        # Plugins predate this argument, so it is offered and not forced: a
        # separator that never grew the keyword keeps working, it just cannot
        # honour a per-song pick. The signature is INSPECTED rather than the
        # call being retried on TypeError — a TypeError raised inside a
        # plugin's own body would otherwise separate the track twice.
        kwargs = {}
        if _accepts_karaoke_model(separator.separate):
            kwargs["karaoke_model"] = pass2_model
        else:
            logger.info(
                "Separator plugin %r takes no karaoke_model — Pass-2 pick ignored",
                os.getenv(SEPARATOR_ENV, "").strip(),
            )
        return await separator.separate(
            audio_path, stems_dir, job_id, _progress, **kwargs
        )

    if modal_offload.is_enabled():
        # Offload both passes to a Modal GPU container, then mix locally.
        return await _modal_separate_and_mix(
            audio_path, stems_dir, job_id, _progress, pass2_model
        )

    if not DEMUCS_PYTHON.exists():
        raise StemSeparationError(
            f"Demucs venv not found at {DEMUCS_PYTHON}. "
            f"Create it with: uv venv .venv-demucs --python 3.13 && "
            f"source .venv-demucs/bin/activate && "
            f"uv pip install demucs torch torchaudio torchcodec 'audio-separator[cpu]'"
        )

    stems_dir.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------------
    # Pass 1: Demucs — vocals vs. instrumental
    # ---------------------------------------------------------------
    model = DEFAULT_DEMUCS_MODEL
    await _progress("processing", 5, f"Pass 1: Demucs ({model}) — separating vocals...")

    demucs_out = stems_dir / "_demucs_out"
    demucs_out.mkdir(parents=True, exist_ok=True)

    demucs_cmd = [
        str(DEMUCS_PYTHON), "-m", "demucs.separate",
        "-n", model,
        "--device", configured_accelerator(),
        "--float32",
        "-o", str(demucs_out),
        str(audio_path),
    ]
    logger.info("Running demucs: %s", " ".join(demucs_cmd))
    await _progress("processing", 10, "Demucs running on GPU...")

    try:
        await _await_subprocess(demucs_cmd, timeout=900)
    except asyncio.TimeoutError:
        raise StemSeparationError("Demucs timed out after 15 minutes")

    await _progress("processing", 45, "Pass 1 complete")

    # Find demucs output
    audio_stem = audio_path.stem
    demucs_dir = _find_demucs_output(demucs_out, model, audio_stem)
    if not demucs_dir:
        raise StemSeparationError(f"Demucs output not found in {demucs_out / model}")

    vocals_src = demucs_dir / "vocals.wav"
    drums_src = demucs_dir / "drums.wav"
    bass_src = demucs_dir / "bass.wav"
    other_src = demucs_dir / "other.wav"

    if not vocals_src.exists():
        raise StemSeparationError(f"Vocals stem not found in {demucs_dir}")

    # ---------------------------------------------------------------
    # Pass 2: Karaoke model — lead vs. backing vocals
    # ---------------------------------------------------------------
    await _progress("processing", 50, "Pass 2: Splitting lead/backing vocals...")

    karaoke_out = stems_dir / "_karaoke_out"

    try:
        lead_out, backing_out = await run_pass2(
            vocals_src, karaoke_out, pass2_model, _progress
        )
    except StemSeparationError as e:
        # Pass 2 failure is non-fatal — fall back to using full vocals as lead
        logger.warning("Karaoke model failed, using full vocals as lead: %s", e)
        shutil.copy2(vocals_src, stems_dir / "lead_vocals.wav")
        _create_silent_wav(stems_dir / "backing_vocals.wav", vocals_src)
        await _progress("processing", 70, "Karaoke split failed, using full vocals")
    else:
        if lead_out is not None:
            shutil.copy2(lead_out, stems_dir / "lead_vocals.wav")
        else:
            shutil.copy2(vocals_src, stems_dir / "lead_vocals.wav")
            logger.warning("Lead vocals not found in karaoke output, using full vocals")
        if backing_out is not None:
            shutil.copy2(backing_out, stems_dir / "backing_vocals.wav")
        else:
            _create_silent_wav(stems_dir / "backing_vocals.wav", vocals_src)
            logger.warning("Backing vocals not found in karaoke output")

    # Mix instrumental + karaoke locally, then clean up Pass-1/2 scratch dirs.
    result = await _mix_and_finalize(stems_dir, drums_src, bass_src, other_src, _progress)
    shutil.rmtree(demucs_out, ignore_errors=True)
    shutil.rmtree(karaoke_out, ignore_errors=True)
    return result


async def _modal_separate_and_mix(
    audio_path: Path,
    stems_dir: Path,
    job_id: str,
    progress: ProgressCallback,
    karaoke_model: str,
) -> dict[str, Path]:
    """Offload both separation passes to a Modal GPU container, mix locally.

    ``modal_offload.modal_separate`` writes lead/backing into ``stems_dir``
    and stages drums/bass/other under ``stems_dir/_remote_raw``. The local
    ``_mix_and_finalize`` runs afterward.
    """
    model = DEFAULT_DEMUCS_MODEL
    await progress("processing", 5, f"Separating on Modal GPU ({modal_offload.APP_NAME})...")
    loop = asyncio.get_event_loop()
    future = loop.run_in_executor(
        None,
        lambda: modal_offload.modal_separate(
            audio_path, stems_dir, demucs_model=model, karaoke_model=karaoke_model
        ),
    )
    try:
        raw = await asyncio.shield(future)
    except asyncio.CancelledError:
        # The Modal client call has no cooperative cancellation handle. Keep
        # the sole processing slot until the remote invocation has returned.
        try:
            await asyncio.shield(future)
        except Exception:
            pass
        raise
    await progress("processing", 70, "Modal separation complete (lead/backing ready)")
    result = await _mix_and_finalize(
        stems_dir, raw["drums"], raw["bass"], raw["other"], progress
    )
    shutil.rmtree(stems_dir / "_remote_raw", ignore_errors=True)
    return result


async def _ensure_s16(path: Path) -> None:
    """Re-encode a stem to 16-bit PCM in place if it isn't already.

    audio-separator inherits its input's bit depth, so the MPS path can return
    32-bit WAV vocals — which browsers (Web Audio / <audio>) silently fail to
    decode, leaving the channel inaudible even though the file is valid. 16-bit
    s16le is universally playable. PCM s16→s16 is a no-op (we skip it via probe).
    """
    if not path.exists():
        return
    try:
        probe = await _await_subprocess(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_fmt", "-of", "csv=p=0", str(path)], 30
        )
        if probe.stdout.strip() == "s16":
            return
    except Exception:
        pass  # probe failed → fall through and transcode defensively
    tmp = path.with_suffix(".s16.wav")
    try:
        res = await _await_subprocess(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
         "-acodec", "pcm_s16le", str(tmp)], 300)
    except StemSeparationError as exc:
        logger.warning("Could not normalize %s to 16-bit: %s", path, exc)
        tmp.unlink(missing_ok=True)
        return
    if res.returncode == 0 and tmp.exists():
        tmp.replace(path)
    else:
        logger.warning("Could not normalize %s to 16-bit: %s", path, res.stderr[-300:])
        tmp.unlink(missing_ok=True)


async def mix_karaoke(
    instrumental_path: Path,
    backing_path: Path,
    karaoke_path: Path,
) -> bool:
    """Mix instrumental + backing into ``karaoke_path``; say whether it took.

    True means the ffmpeg mix ran and succeeded. False means the output is the
    instrumental alone — either because there was no backing stem to fold in,
    or because the mix failed and the bed was copied in its place. Ingest is
    happy with that fallback: a karaoke track missing its harmonies still
    plays. The re-split job checks the return instead, because there it would
    replace a good karaoke stem with a degraded one.
    """
    if instrumental_path.exists() and backing_path.exists():
        karaoke_mix_cmd = [
            "ffmpeg", "-y",
            "-i", str(instrumental_path),
            "-i", str(backing_path),
            "-filter_complex",
            "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[out]",
            "-map", "[out]",
            "-acodec", "pcm_s16le",
            str(karaoke_path),
        ]
        try:
            mix_result = await _await_subprocess(karaoke_mix_cmd, timeout=120)
        except StemSeparationError as exc:
            logger.warning("Karaoke mix failed: %s", exc)
            shutil.copy2(instrumental_path, karaoke_path)
            return False
        if mix_result.returncode == 0:
            return True
        logger.warning("Karaoke mix failed: %s", mix_result.stderr[:500])
        # Fallback: karaoke = instrumental only
        shutil.copy2(instrumental_path, karaoke_path)
    elif instrumental_path.exists():
        shutil.copy2(instrumental_path, karaoke_path)
    return False


async def _mix_and_finalize(
    stems_dir: Path,
    drums_src: Optional[Path],
    bass_src: Optional[Path],
    other_src: Optional[Path],
    progress: ProgressCallback,
) -> dict[str, Path]:
    """Mix the instrumental (drums+bass+other) and karaoke (instrumental+backing)
    tracks with ffmpeg. Shared by the local and Modal separation paths."""
    # Guarantee browser-playable vocal stems (audio-separator may emit 32-bit).
    for stem in (stems_dir / "lead_vocals.wav", stems_dir / "backing_vocals.wav"):
        normalized = _ensure_s16(stem)
        if inspect.isawaitable(normalized):
            await normalized

    # ---------------------------------------------------------------
    # Mix instrumental (drums + bass + other)
    # ---------------------------------------------------------------
    await progress("mixing", 75, "Mixing instrumental track...")
    instrumental_path = stems_dir / "instrumental.wav"

    parts = [p for p in [drums_src, bass_src, other_src] if p and p.exists()]
    if len(parts) == 3:
        mix_cmd = [
            "ffmpeg", "-y",
            "-i", str(drums_src),
            "-i", str(bass_src),
            "-i", str(other_src),
            "-filter_complex",
            "[0:a][1:a][2:a]amix=inputs=3:duration=longest:normalize=0[out]",
            "-map", "[out]",
            "-acodec", "pcm_s16le",
            str(instrumental_path),
        ]
        try:
            mix_result = await _await_subprocess(mix_cmd, timeout=120)
        except StemSeparationError as exc:
            logger.warning("Instrumental mix failed: %s", exc)
            mix_result = None
        if mix_result is not None and mix_result.returncode != 0:
            logger.warning("Instrumental mix failed: %s", mix_result.stderr[:500])
    elif len(parts) == 1:
        shutil.copy2(parts[0], instrumental_path)

    await progress("mixing", 85, "Instrumental ready")

    # ---------------------------------------------------------------
    # Mix karaoke (instrumental + backing vocals)
    # ---------------------------------------------------------------
    await progress("mixing", 87, "Mixing karaoke track (instrumental + backing)...")
    await mix_karaoke(
        instrumental_path,
        stems_dir / "backing_vocals.wav",
        stems_dir / "karaoke.wav",
    )

    await progress("mixing", 95, "Karaoke track ready")
    await progress("done", 100, "All stems ready")
    return _build_stem_paths(stems_dir)


def _create_silent_wav(path: Path, reference_wav: Path) -> None:
    """Create a silent WAV file with the same duration as a reference."""
    try:
        import wave
        with wave.open(str(reference_wav), "rb") as ref:
            params = ref.getparams()
        with wave.open(str(path), "wb") as out:
            out.setparams(params)
            out.writeframes(b"\x00" * (params.nframes * params.sampwidth * params.nchannels))
    except Exception as e:
        logger.warning("Failed to create silent backing vocals: %s", e)
        sample_rate = 44100
        num_samples = sample_rate * 10
        data_size = num_samples * 2
        header = (
            b"RIFF"
            + (36 + data_size).to_bytes(4, "little")
            + b"WAVE"
            + b"fmt "
            + (16).to_bytes(4, "little")
            + (1).to_bytes(2, "little")
            + (1).to_bytes(2, "little")
            + sample_rate.to_bytes(4, "little")
            + (sample_rate * 2).to_bytes(4, "little")
            + (2).to_bytes(2, "little")
            + (16).to_bytes(2, "little")
            + b"data"
            + data_size.to_bytes(4, "little")
            + b"\x00" * data_size
        )
        path.write_bytes(header)


def _build_stem_paths(stems_dir: Path) -> dict[str, Path]:
    """Return a dict of expected stem file paths."""
    return {
        "instrumental": stems_dir / "instrumental.wav",
        "lead_vocals": stems_dir / "lead_vocals.wav",
        "backing_vocals": stems_dir / "backing_vocals.wav",
        "karaoke": stems_dir / "karaoke.wav",
    }
