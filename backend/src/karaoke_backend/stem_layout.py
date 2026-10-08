# SPDX-License-Identifier: AGPL-3.0-only
"""Filesystem-derived stem model.

Core stems live on disk under a song's stems_path; the read side derives the
stem model from filenames on every request — there is no DB column for stems.
Recognized shapes (mp3 preferred over flac over wav when both exist):

    instrumental.{mp3,flac,wav}    -> the no-vocals bed (standard + named songs)
    karaoke.{mp3,flac,wav}         -> derived instrumental+backing mix (standard)
    lead_vocals.{mp3,flac,wav}     -> vocal id "lead"    (standard, unnamed)
    backing_vocals.{mp3,flac,wav}  -> vocal id "backing" (standard, unnamed)
    lead_vocals_<N>.{mp3,flac,wav} -> vocal id "lead_<N>"    (N >= 2, always unnamed)
    backing_vocals_<N>.{...}   -> vocal id "backing_<N>" (N >= 2, always unnamed)
    vocal_<id>.{mp3,flac,wav}      -> vocal id "<id>", display name from voices[]

A vocal id may be COMPOUND ("7+8"): one audio file carrying the combined
track of several rostered voices. Its display name is the constituent names
joined with " & " (all-or-nothing), and it sorts at the roster position of
its first rostered constituent.

Everything is additive: callers keep the flat well-known keys (instrumental,
lead_vocals, backing_vocals, karaoke) AND gain an ordered `vocals` list.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

STEM_EXTS = (".mp3", ".flac", ".wav")  # independent of the new-output setting

INSTRUMENTAL = "instrumental"
KARAOKE = "karaoke"

# well-known vocal filename base -> stable unnamed vocal id (standard songs)
_WELL_KNOWN_VOCALS = (("lead_vocals", "lead"), ("backing_vocals", "backing"))

_VOCAL_RE = re.compile(r"^vocal_(?P<id>.+)$")

# lead_vocals_2 / backing_vocals_3 / ... — extra generic lanes the importer
# writes for multi-lead songs whose voices could not be individually
# identified. N starts at 2 (N=1 is the un-suffixed base lane), so a stray
# *_vocals_1 is deliberately NOT recognized: no lane, no download. Zero-padded
# suffixes (_02) are rejected too — they would normalize into a colliding id.
_NUMBERED_VOCAL_RE = re.compile(r"^(?P<prefix>lead|backing)_vocals_(?P<n>[1-9]\d*)$")

# separator inside a compound vocal id, e.g. vocal_7+8 = voices 7 and 8 mixed
_COMPOUND_SEP = "+"
_COMPOUND_NAME_JOIN = " & "


def _numbered_vocal(stem: str) -> Optional[tuple[str, int]]:
    """("lead"|"backing", N) for a recognized numbered generic base, else None."""
    m = _NUMBERED_VOCAL_RE.match(stem)
    if not m:
        return None
    n = int(m.group("n"))
    if n < 2:
        return None
    return m.group("prefix"), n


@dataclass(frozen=True)
class VocalStem:
    id: str
    filename: str            # basename on disk, e.g. "vocal_6.flac"
    name: Optional[str] = None


def resolve_stem(stems_dir: Path, base: str) -> Optional[Path]:
    """Resolve existing audio independently of the configured output format."""
    for ext in STEM_EXTS:
        candidate = stems_dir / f"{base}{ext}"
        if candidate.is_file():
            return candidate
    return None


def _resolve(stems_dir: Path, base: str) -> Optional[str]:
    path = resolve_stem(stems_dir, base)
    return path.name if path else None


def _voice_names(voices) -> dict[str, str]:
    """id -> name from a word_sync voices[] list; ignores malformed entries."""
    out: dict[str, str] = {}
    if not isinstance(voices, list):
        return out
    for v in voices:
        if isinstance(v, dict) and v.get("id") is not None and v.get("name"):
            out[str(v["id"])] = str(v["name"])
    return out


def _voice_order(voices) -> list[str]:
    """Roster order of ids from voices[]; [] if malformed/missing."""
    order: list[str] = []
    if isinstance(voices, list):
        for v in voices:
            if isinstance(v, dict) and v.get("id") is not None:
                order.append(str(v["id"]))
    return order


def _roster_index(voices) -> dict[str, int]:
    """id -> first position in the voices[] roster order."""
    index: dict[str, int] = {}
    for pos, vid in enumerate(_voice_order(voices)):
        index.setdefault(vid, pos)
    return index


def _compound_parts(vid: str) -> Optional[list[str]]:
    """Constituent ids of a well-formed compound id, else None.

    Degenerate shapes ("+", "7+") are NOT compounds — they are treated as
    ordinary unrecognized ids: unnamed, and sorted to the tail.
    """
    if _COMPOUND_SEP not in vid:
        return None
    parts = vid.split(_COMPOUND_SEP)
    if any(not p for p in parts):
        return None
    return parts


def _lane_name(vid: str, names: dict[str, str]) -> Optional[str]:
    """Display name for a vocal id, or None when it cannot be resolved.

    A compound id resolves only if EVERY constituent is named in voices[] —
    no partial joins.
    """
    if vid in names:
        return names[vid]
    parts = _compound_parts(vid)
    if parts is None:
        return None
    resolved = [names.get(p) for p in parts]
    if any(n is None for n in resolved):
        return None
    return _COMPOUND_NAME_JOIN.join(n for n in resolved if n is not None)


def _roster_sort_key(vid: str, index: dict[str, int]) -> tuple[float, str]:
    """Sort key placing a vocal id at its roster position.

    A compound id takes the position of the FIRST of its constituents (in id
    order) that the roster names; ids the roster knows nothing about sort to
    the tail, alphabetically among themselves.
    """
    if vid in index:
        return (index[vid], vid)
    for part in _compound_parts(vid) or ():
        if part in index:
            return (index[part], vid)
    return (float("inf"), vid)


def scan_vocals(stems_dir: Path, voices=None) -> list[VocalStem]:
    """Ordered vocal stems present on disk.

    Order: the well-known lead lane then its numbered generic lanes
    (lead_2, lead_3, … ascending), then backing and its numbered lanes, then
    vocal_<id> stems at their voices[] roster position (a compound id sorts
    at its first rostered constituent), then any leftover vocal_<id> the
    roster does not know (sorted, unnamed lane). Degrades gracefully: a
    missing/empty voices[] simply yields unnamed lanes.
    """
    names = _voice_names(voices)
    result: list[VocalStem] = []
    seen: set[str] = set()

    ids_on_disk: set[str] = set()
    numbered: dict[str, set[tuple[int, str]]] = {
        vid: set() for _, vid in _WELL_KNOWN_VOCALS
    }
    if stems_dir.exists():
        for p in stems_dir.iterdir():
            if not p.is_file() or p.suffix not in STEM_EXTS:
                continue
            m = _VOCAL_RE.match(p.stem)
            if m:
                ids_on_disk.add(m.group("id"))
                continue
            num = _numbered_vocal(p.stem)
            if num:
                prefix, n = num
                numbered[prefix].add((n, p.stem))

    for base, vid in _WELL_KNOWN_VOCALS:
        fn = _resolve(stems_dir, base)
        if fn:
            result.append(VocalStem(id=vid, filename=fn, name=names.get(vid)))
            seen.add(vid)
        # Numbered generics ride immediately behind their base lane. They are
        # never named: voices[] cannot identify what the importer could not.
        for n, stem in sorted(numbered[vid]):
            nid = f"{vid}_{n}"
            if nid in seen:
                continue
            nfn = _resolve(stems_dir, stem)
            if nfn:
                result.append(VocalStem(id=nid, filename=nfn, name=None))
                seen.add(nid)

    index = _roster_index(voices)
    ordered = sorted(ids_on_disk, key=lambda vid: _roster_sort_key(vid, index))
    # A vocal_<id> whose id was already claimed by a well-known lane above
    # (e.g. a stray vocal_lead.* next to lead_vocals.*) yields to it — the
    # well-known lane wins. The shadowed file stays individually downloadable
    # via allowed_stem_filenames; it just isn't a second lane. Harmless.
    for vid in ordered:
        if vid in seen:
            continue
        fn = _resolve(stems_dir, f"vocal_{vid}")
        if fn:
            result.append(VocalStem(id=vid, filename=fn, name=_lane_name(vid, names)))
            seen.add(vid)

    return result


def instrumental_filename(stems_dir: Path) -> Optional[str]:
    return _resolve(stems_dir, INSTRUMENTAL)


def karaoke_filename(stems_dir: Path) -> Optional[str]:
    return _resolve(stems_dir, KARAOKE)


def _url(base_url: str, song_id: int, filename: str) -> str:
    return f"{base_url}/api/songs/{song_id}/stems/{filename}"


def stem_urls_payload(
    stems_dir: Path, base_url: str, song_id: int, voices=None
) -> dict:
    """Additive DTO payload: flat well-known keys + ordered `vocals` list.

    Keys are omitted (absent) when their file is not on disk, EXCEPT `vocals`
    which is always a list (possibly empty). Suitable for `StemURLs(**payload)`.
    """
    payload: dict = {}
    inst = instrumental_filename(stems_dir)
    if inst:
        payload["instrumental"] = _url(base_url, song_id, inst)
    kar = karaoke_filename(stems_dir)
    if kar:
        payload["karaoke"] = _url(base_url, song_id, kar)

    vocals = scan_vocals(stems_dir, voices)
    payload["vocals"] = [
        {"id": vs.id, "name": vs.name, "url": _url(base_url, song_id, vs.filename)}
        for vs in vocals
    ]
    for vs in vocals:  # flat back-compat keys
        if vs.id == "lead":
            payload["lead_vocals"] = _url(base_url, song_id, vs.filename)
        elif vs.id == "backing":
            payload["backing_vocals"] = _url(base_url, song_id, vs.filename)
    return payload


def allowed_stem_filenames(stems_dir: Path) -> set[str]:
    """Per-song download allowlist: every recognized stem basename actually on
    disk. Basenames only -> path-traversal-safe by construction. Includes all
    recognized extensions when several are present."""
    allowed: set[str] = set()
    if not stems_dir.exists():
        return allowed
    recognized_bases = {INSTRUMENTAL, KARAOKE, "lead_vocals", "backing_vocals"}
    for p in stems_dir.iterdir():
        if not p.is_file() or p.suffix not in STEM_EXTS:
            continue
        if (
            p.stem in recognized_bases
            or _VOCAL_RE.match(p.stem)
            or _numbered_vocal(p.stem)
        ):
            allowed.add(p.name)
    return allowed
