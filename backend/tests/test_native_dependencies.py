# SPDX-License-Identifier: AGPL-3.0-only
"""The show backend must remain usable without local AI dependencies."""

import os
from pathlib import Path
import subprocess
import sys
import tomllib


BACKEND = Path(__file__).resolve().parents[1]


def test_whisper_is_an_opt_in_dependency():
    project = tomllib.loads((BACKEND / "pyproject.toml").read_text())["project"]
    lyricsync = [item for item in project["dependencies"] if item.startswith("lyricsync")]
    assert len(lyricsync) == 1
    assert "whisper" not in lyricsync[0]
    assert any("lyricsync[whisper]" in item
               for item in project["optional-dependencies"]["whisper"])


def test_show_backend_starts_without_ai_packages(tmp_path):
    # A new interpreter prevents conftest's imported modules from masking an
    # eager import. Reject the dependencies even if the test runner has them.
    probe = r'''
import importlib.abc
import sys

blocked = {"torch", "torchaudio", "torchcodec", "transformers", "demucs",
           "audio_separator", "faster_whisper", "ctranslate2", "modal"}

class NoAI(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.partition(".")[0] in blocked:
            raise ModuleNotFoundError("AI package unavailable: " + fullname)

sys.meta_path.insert(0, NoAI())
from fastapi.testclient import TestClient
from karaoke_backend.main import app

with TestClient(app) as client:
    for path in ("/health", "/api/songs", "/api/queue"):
        response = client.get(path)
        assert response.status_code == 200, (path, response.status_code, response.text)

assert not blocked.intersection(sys.modules)
'''
    env = {key: value for key, value in os.environ.items()
           if key in {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC"}}
    env.update({
        "HOME": str(tmp_path), "USERPROFILE": str(tmp_path),
        "PYTHONPATH": os.pathsep.join((str(BACKEND / "src"),
                                       str(BACKEND.parent / "lyricsync/src"))),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DATABASE_URL": "sqlite+aiosqlite:///" + str(tmp_path / "show.db"),
        "UPLOADS_DIR": str(tmp_path / "uploads"),
        "STEMS_DIR": str(tmp_path / "stems"),
        "SESSION_SECRET": "isolated-native-dependency-test",
        "AUTH_MODE": "single_host", "KARAOKE_PROVIDERS": "none",
        "KARAOKE_PROVIDERS_DIR": "", "KARAOKE_LRCLIB": "0", "KARAOKE_MODAL": "0",
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    })
    result = subprocess.run([sys.executable, "-c", probe], cwd=tmp_path, env=env,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
