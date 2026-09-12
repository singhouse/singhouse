# SPDX-License-Identifier: AGPL-3.0-only
"""Public workers remain importable and select local compute without SSH files."""

import os
from pathlib import Path
import shutil
import subprocess
import sys


def test_public_workers_import_and_dispatch_without_private_modules(tmp_path):
    # Rehearse file-level assembly in a fresh process, avoiding previously
    # imported modules masking an accidental dependency on private code.
    source = Path(__file__).resolve().parents[1] / "src" / "karaoke_backend"
    package = tmp_path / "karaoke_backend"
    shutil.copytree(source, package, ignore=shutil.ignore_patterns("__pycache__"))
    (package / "workers" / "remote.py").unlink(missing_ok=True)
    shutil.rmtree(package / "workers" / "remote_runtime", ignore_errors=True)
    env = dict(os.environ, PYTHONPATH=str(tmp_path), KARAOKE_REMOTE_HOST="invalid.example",
               KARAOKE_MODAL="0", KARAOKE_SEPARATOR="")
    script = r'''
import asyncio
from pathlib import Path
from unittest.mock import patch
from karaoke_backend.workers import modal_worker, word_sync_worker
from lyricsync.transcription.heart import HeartTranscriber

assert isinstance(word_sync_worker._make_transcriber("heart", use_vad=False), HeartTranscriber)
# Enter actual separation dispatch but stop at its local interpreter check;
# neither a model load nor an audio subprocess is necessary to prove selection.
with patch.object(modal_worker, "DEMUCS_PYTHON", Path("missing-local-python")):
    try:
        asyncio.run(modal_worker.separate_stems(Path("audio.wav"), Path("stems"), "test"))
    except modal_worker.StemSeparationError as exc:
        assert "Demucs venv not found" in str(exc), str(exc)
    else:
        raise AssertionError("local separation should report its missing interpreter")
'''
    result = subprocess.run([sys.executable, "-c", script], env=env, cwd=tmp_path,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
