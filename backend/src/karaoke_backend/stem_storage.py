# SPDX-License-Identifier: AGPL-3.0-only
"""Safe resolution of legacy and generation-backed song artifacts."""
from pathlib import Path
from karaoke_backend.models.song import Song

GENERATIONS = ".generations"

def stems_root(song: Song, default_root: Path) -> Path:
    return Path(song.stems_path) if song.stems_path else default_root / str(song.id)

def valid_generation(value: str) -> bool:
    return value == Path(value).name and value.replace("-", "").isalnum()

def active_stems_dir(song: Song, default_root: Path) -> Path:
    root = stems_root(song, default_root)
    value = song.active_stem_generation
    if value is None:
        return root
    return root / GENERATIONS / value if valid_generation(value) else root / ".invalid-generation"
