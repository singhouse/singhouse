# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for the filesystem-derived stem model.

These are plain sync tests against `stem_layout`, using tmp_path with empty
placeholder files — no real audio is needed since the module only stats names.
"""

from pathlib import Path

from karaoke_backend import stem_layout


def _touch(d: Path, *names: str) -> None:
    d.mkdir(parents=True, exist_ok=True)
    for n in names:
        (d / n).write_bytes(b"")


def test_standard_two_stem_wav(tmp_path):
    _touch(
        tmp_path,
        "instrumental.wav",
        "lead_vocals.wav",
        "backing_vocals.wav",
        "karaoke.wav",
    )
    payload = stem_layout.stem_urls_payload(tmp_path, "", 42)

    assert payload["instrumental"] == "/api/songs/42/stems/instrumental.wav"
    assert payload["karaoke"] == "/api/songs/42/stems/karaoke.wav"
    assert payload["lead_vocals"] == "/api/songs/42/stems/lead_vocals.wav"
    assert payload["backing_vocals"] == "/api/songs/42/stems/backing_vocals.wav"

    assert [(v["id"], v["name"]) for v in payload["vocals"]] == [
        ("lead", None),
        ("backing", None),
    ]
    assert payload["vocals"][0]["url"] == "/api/songs/42/stems/lead_vocals.wav"
    assert payload["vocals"][1]["url"] == "/api/songs/42/stems/backing_vocals.wav"


def test_named_multi_voice_roster_order(tmp_path):
    _touch(tmp_path, "instrumental.flac", "vocal_6.flac", "vocal_7.flac")
    voices = [{"id": "7", "name": "Jerry"}, {"id": "6", "name": "Bob"}]

    payload = stem_layout.stem_urls_payload(tmp_path, "", 9, voices)

    # Ordered by ROSTER (7 then 6), names resolved.
    assert [(v["id"], v["name"]) for v in payload["vocals"]] == [
        ("7", "Jerry"),
        ("6", "Bob"),
    ]
    assert payload["vocals"][0]["url"] == "/api/songs/9/stems/vocal_7.flac"
    assert payload["vocals"][1]["url"] == "/api/songs/9/stems/vocal_6.flac"

    # instrumental present; flat lead/backing keys absent (no standard vocals).
    assert payload["instrumental"] == "/api/songs/9/stems/instrumental.flac"
    assert "lead_vocals" not in payload
    assert "backing_vocals" not in payload
    assert "karaoke" not in payload


def test_flac_preferred_over_wav(tmp_path):
    _touch(tmp_path, "instrumental.flac", "instrumental.wav")

    payload = stem_layout.stem_urls_payload(tmp_path, "", 1)
    assert payload["instrumental"] == "/api/songs/1/stems/instrumental.flac"

    allowed = stem_layout.allowed_stem_filenames(tmp_path)
    assert "instrumental.flac" in allowed
    assert "instrumental.wav" in allowed


def test_vocal_id_not_in_roster_is_graceful(tmp_path):
    _touch(tmp_path, "vocal_99.flac")
    voices = [{"id": "6", "name": "Bob"}]  # 99 not named

    vocals = stem_layout.scan_vocals(tmp_path, voices)
    assert len(vocals) == 1
    assert vocals[0].id == "99"
    assert vocals[0].name is None
    assert vocals[0].filename == "vocal_99.flac"


def test_allowed_stem_filenames_excludes_strays(tmp_path):
    _touch(
        tmp_path,
        "instrumental.wav",
        "vocal_3.flac",
        "notes.txt",
        "weird.ogg",
    )
    allowed = stem_layout.allowed_stem_filenames(tmp_path)
    assert allowed == {"instrumental.wav", "vocal_3.flac"}
    assert "notes.txt" not in allowed
    assert "weird.ogg" not in allowed


def test_empty_and_nonexistent_dir(tmp_path):
    missing = tmp_path / "does_not_exist"
    assert stem_layout.scan_vocals(missing) == []
    assert stem_layout.allowed_stem_filenames(missing) == set()
    assert stem_layout.stem_urls_payload(missing, "", 5)["vocals"] == []

    empty = tmp_path / "empty"
    empty.mkdir()
    assert stem_layout.scan_vocals(empty) == []
    assert stem_layout.allowed_stem_filenames(empty) == set()
    assert stem_layout.stem_urls_payload(empty, "", 5)["vocals"] == []


def test_wellknown_wins_over_vocal_id_collision(tmp_path):
    # lead_vocals.* (well-known) claims id "lead"; a colliding vocal_lead.*
    # is NOT emitted as a second lane, but stays individually downloadable.
    _touch(tmp_path, "lead_vocals.wav", "vocal_lead.flac")
    vocals = stem_layout.scan_vocals(tmp_path)
    assert [v.id for v in vocals] == ["lead"]
    assert vocals[0].filename == "lead_vocals.wav"
    assert stem_layout.allowed_stem_filenames(tmp_path) == {
        "lead_vocals.wav",
        "vocal_lead.flac",
    }


def test_flat_lead_derived_from_vocal_lead(tmp_path):
    # A lone vocal_lead.* (no lead_vocals.*) surfaces as id "lead" and
    # back-fills the flat lead_vocals key.
    _touch(tmp_path, "vocal_lead.flac")
    payload = stem_layout.stem_urls_payload(tmp_path, "", 3)
    assert payload["lead_vocals"] == "/api/songs/3/stems/vocal_lead.flac"
    assert [v["id"] for v in payload["vocals"]] == ["lead"]


def test_malformed_voices_non_list_is_graceful(tmp_path):
    _touch(tmp_path, "vocal_6.flac")
    for bad in ({"id": "6"}, "nope", 7, None):
        vocals = stem_layout.scan_vocals(tmp_path, bad)
        assert [v.id for v in vocals] == ["6"]
        assert vocals[0].name is None


def test_unrostered_leftover_ids_sorted_after_rostered(tmp_path):
    _touch(tmp_path, "vocal_6.flac", "vocal_7.flac", "vocal_2.flac")
    voices = [{"id": "7", "name": "Jerry"}]  # only 7 is in the roster
    vocals = stem_layout.scan_vocals(tmp_path, voices)
    # rostered (7) first, then unrostered leftovers sorted (2, 6)
    assert [v.id for v in vocals] == ["7", "2", "6"]
    assert vocals[0].name == "Jerry"
    assert vocals[1].name is None and vocals[2].name is None


def test_vocal_id_flac_preferred(tmp_path):
    _touch(tmp_path, "vocal_6.flac", "vocal_6.wav")
    vocals = stem_layout.scan_vocals(tmp_path)
    assert [v.filename for v in vocals] == ["vocal_6.flac"]


# --- numbered generic vocal lanes: lead_vocals_<N> / backing_vocals_<N> ---


def test_numbered_lead_vocals_is_its_own_unnamed_lane(tmp_path):
    # Two leads the importer could not tell apart: the _2 file is a real lane.
    _touch(tmp_path, "instrumental.flac", "lead_vocals.flac", "lead_vocals_2.flac")
    voices = [
        {"id": "1", "name": "One"},
        {"id": "2", "name": "Two"},
        {"id": "3", "name": "Three"},
    ]

    payload = stem_layout.stem_urls_payload(tmp_path, "", 17, voices)

    # Numbered generics are never named, even with a fully named roster.
    assert [(v["id"], v["name"]) for v in payload["vocals"]] == [
        ("lead", None),
        ("lead_2", None),
    ]
    assert payload["vocals"][1]["url"] == "/api/songs/17/stems/lead_vocals_2.flac"

    # Flat back-compat keys stay base-only.
    assert payload["lead_vocals"] == "/api/songs/17/stems/lead_vocals.flac"
    assert "backing_vocals" not in payload

    assert stem_layout.allowed_stem_filenames(tmp_path) == {
        "instrumental.flac",
        "lead_vocals.flac",
        "lead_vocals_2.flac",
    }


def test_numbered_lanes_ride_behind_their_base_lane(tmp_path):
    _touch(
        tmp_path,
        "lead_vocals.flac",
        "lead_vocals_2.flac",
        "backing_vocals.flac",
        "backing_vocals_2.flac",
    )
    vocals = stem_layout.scan_vocals(tmp_path)
    assert [v.id for v in vocals] == ["lead", "lead_2", "backing", "backing_2"]
    assert all(v.name is None for v in vocals)


def test_numbered_lanes_sort_numerically_and_prefer_flac(tmp_path):
    _touch(
        tmp_path,
        "lead_vocals_10.flac",
        "lead_vocals_2.flac",
        "lead_vocals_2.wav",
    )
    vocals = stem_layout.scan_vocals(tmp_path)
    # 2 before 10 (numeric, not lexicographic); no base lead_vocals.* present.
    assert [(v.id, v.filename) for v in vocals] == [
        ("lead_2", "lead_vocals_2.flac"),
        ("lead_10", "lead_vocals_10.flac"),
    ]


def test_numbered_one_is_not_a_recognized_shape(tmp_path):
    # N starts at 2 — *_vocals_1 is not a lane and is not downloadable.
    _touch(tmp_path, "lead_vocals.flac", "lead_vocals_1.flac")
    assert [v.id for v in stem_layout.scan_vocals(tmp_path)] == ["lead"]
    assert stem_layout.allowed_stem_filenames(tmp_path) == {"lead_vocals.flac"}


# --- compound vocal ids: vocal_<id1>+<id2>[+...] ---


def test_compound_vocal_id_names_and_roster_position(tmp_path):
    # One file carries voices 7 and 8 combined; 9 has its own file.
    _touch(
        tmp_path,
        "instrumental.flac",
        "backing_vocals.flac",
        "vocal_7+8.flac",
        "vocal_9.flac",
    )
    voices = [
        {"id": "7", "name": "Alto"},
        {"id": "8", "name": "Tenor"},
        {"id": "9", "name": "Basso"},
    ]

    payload = stem_layout.stem_urls_payload(tmp_path, "", 66, voices)

    # backing is well-known and still leads; the compound sorts at voice 7.
    assert [(v["id"], v["name"]) for v in payload["vocals"]] == [
        ("backing", None),
        ("7+8", "Alto & Tenor"),
        ("9", "Basso"),
    ]
    assert payload["vocals"][1]["url"] == "/api/songs/66/stems/vocal_7+8.flac"
    assert "vocal_7+8.flac" in stem_layout.allowed_stem_filenames(tmp_path)


def test_compound_partial_names_resolve_to_none(tmp_path):
    _touch(tmp_path, "vocal_7+8.flac")
    voices = [{"id": "7", "name": "Alto"}, {"id": "8"}]  # 8 has no name

    vocals = stem_layout.scan_vocals(tmp_path, voices)
    assert [(v.id, v.name) for v in vocals] == [("7+8", None)]


def test_compound_with_no_rostered_constituent_falls_to_tail(tmp_path):
    _touch(tmp_path, "vocal_7.flac", "vocal_4+5.flac")
    voices = [{"id": "7", "name": "Jerry"}]

    vocals = stem_layout.scan_vocals(tmp_path, voices)
    assert [(v.id, v.name) for v in vocals] == [("7", "Jerry"), ("4+5", None)]


def test_compound_sorts_at_first_rostered_constituent(tmp_path):
    # 3 is unrostered, 9 is first in the roster -> the compound sorts at 9.
    _touch(tmp_path, "vocal_3+9.flac", "vocal_7.flac")
    voices = [{"id": "9", "name": "Basso"}, {"id": "7", "name": "Jerry"}]

    vocals = stem_layout.scan_vocals(tmp_path, voices)
    assert [(v.id, v.name) for v in vocals] == [("3+9", None), ("7", "Jerry")]


def test_degenerate_compound_ids_do_not_crash(tmp_path):
    _touch(tmp_path, "vocal_+.flac", "vocal_7+.flac", "vocal_7.flac")
    voices = [{"id": "7", "name": "Jerry"}]

    vocals = stem_layout.scan_vocals(tmp_path, voices)
    # 7 is rostered and leads; the malformed ids are ordinary unknown lanes.
    assert [(v.id, v.name) for v in vocals] == [
        ("7", "Jerry"),
        ("+", None),
        ("7+", None),
    ]
    assert stem_layout.allowed_stem_filenames(tmp_path) == {
        "vocal_+.flac",
        "vocal_7+.flac",
        "vocal_7.flac",
    }


def test_numbered_generics_and_compound_ids_coexist(tmp_path):
    _touch(
        tmp_path,
        "instrumental.flac",
        "lead_vocals.flac",
        "lead_vocals_2.flac",
        "vocal_7+8.flac",
        "vocal_9.flac",
    )
    voices = [
        {"id": "9", "name": "Basso"},
        {"id": "7", "name": "Alto"},
        {"id": "8", "name": "Tenor"},
    ]

    payload = stem_layout.stem_urls_payload(tmp_path, "", 5, voices)

    # Well-known lane + its numbered generic first, then roster order (9, 7+8).
    assert [(v["id"], v["name"]) for v in payload["vocals"]] == [
        ("lead", None),
        ("lead_2", None),
        ("9", "Basso"),
        ("7+8", "Alto & Tenor"),
    ]
    assert payload["lead_vocals"] == "/api/songs/5/stems/lead_vocals.flac"
    assert stem_layout.allowed_stem_filenames(tmp_path) == {
        "instrumental.flac",
        "lead_vocals.flac",
        "lead_vocals_2.flac",
        "vocal_7+8.flac",
        "vocal_9.flac",
    }


def test_mp3_lanes_and_format_independent_lookup(tmp_path, monkeypatch):
    monkeypatch.setenv("STEM_FORMAT", "flac")
    names = {"instrumental.mp3", "instrumental.flac", "lead_vocals.mp3",
             "lead_vocals_2.mp3", "backing_vocals.mp3", "vocal_7+8.mp3"}
    _touch(tmp_path, *names)
    assert stem_layout.resolve_stem(tmp_path, "instrumental").name == "instrumental.mp3"
    payload = stem_layout.stem_urls_payload(tmp_path, "", 1)
    assert [v["id"] for v in payload["vocals"]] == ["lead", "lead_2", "backing", "7+8"]
    assert all(v["url"].endswith(".mp3") for v in payload["vocals"])
    assert stem_layout.allowed_stem_filenames(tmp_path) == names
