# SPDX-License-Identifier: AGPL-3.0-only
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import struct
import subprocess
import unittest
import zlib

spec = importlib.util.spec_from_file_location("assemble_processing", Path(__file__).parents[1] / "build/assemble_processing.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ProcessingPackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = self.root / "payload"
        (self.payload / "python/bin").mkdir(parents=True)
        (self.payload / "python/bin/python3").write_bytes(b"fixture")
        (self.payload / "NOTICE.fixture").write_bytes(b"MIT notice")
        self.lock = {"schema": 1, "kind": "processing-input", "appVersion": "0.1.0", "backendVersion": "0.1.0", "lyricsyncVersion": "0.1.0",
                     "pythonVersion": "3.12.14", "platform": "linux", "arch": "x64", "accelerator": "cpu", "python": "python/bin/python3",
                     "sourceCommit": "a" * 40, "capabilities": ["transcription"], "models": ["whisper"], "modelCapabilities": {"whisper": "transcription"},
                     "excludedPackages": builder.EXCLUDED_PACKAGES,
                     "packages": [{"name": "fixture", "version": "1", "license": "MIT", "sourceUrl": "https://example.org/fixture.whl", "sha256": "b" * 64, "notices": ["NOTICE.fixture"]}],
                     "files": [{"path": "python/bin/python3", "size": 7, "sha256": hashlib.sha256(b"fixture").hexdigest(), "executable": True},
                               {"path": "NOTICE.fixture", "size": 10, "sha256": hashlib.sha256(b"MIT notice").hexdigest(), "executable": False}]}
        self.lock_path = self.root / "lock.json"

    def assemble(self):
        self.lock_path.write_text(json.dumps(self.lock))
        return builder.assemble(self.payload, self.lock_path, self.root / "output")

    def test_fixture_pack_is_locked_and_has_local_artifacts(self):
        manifest = self.assemble()
        self.assertEqual(manifest["kind"], "processing")
        # Archive form is the default: no per-file URLs, local part URLs.
        self.assertTrue(all("url" not in record for record in manifest["files"]))
        self.assertTrue(manifest["archive"]["parts"][0]["url"].startswith("file:"))
        self.assertEqual([record for record in manifest["files"]], self.lock["files"])
        self.assertEqual(manifest["provenance"]["lockSha256"], builder.digest(self.lock_path))
        self.assertEqual(json.loads(manifest["provenance"]["inputLock"]), self.lock)
        self.assertIn("lyricsync.transcription.heart", manifest["probe"]["modules"])

    def test_crlf_lock_bytes_survive_embedding_and_packaging(self):
        raw = (json.dumps(self.lock, indent=2) + "\n").replace("\n", "\r\n").encode("utf-8")
        self.assertIn(b"\r\n", raw)
        self.lock_path.write_bytes(raw)
        manifest = builder.assemble(self.payload, self.lock_path, self.root / "output")
        retained = json.loads((self.root / "output/manifest.json").read_text())
        expected_digest = hashlib.sha256(raw).hexdigest()
        for value in (manifest, retained):
            embedded = value["provenance"]["inputLock"].encode("utf-8")
            self.assertEqual(embedded, raw)
            self.assertEqual(hashlib.sha256(embedded).hexdigest(), expected_digest)
            self.assertEqual(value["provenance"]["lockSha256"], expected_digest)
        self.assertEqual((self.root / "output/input-lock.json").read_bytes(), raw)

    def test_assembled_manifest_is_accepted_by_runtime_consumer(self):
        module = (Path(__file__).parents[1] / "runtime_manager.mjs").as_uri()
        script = """import fs from 'node:fs';
const {validateProcessingManifest}=await import(process.argv[1]);
const value=JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
validateProcessingManifest(value, {appVersion:'0.1.0',backendVersion:'0.1.0',lyricsyncVersion:'0.1.0',platform:'linux',arch:'x64'}, [value.provenance.lockSha256]);
"""
        self.lock_path.write_text(json.dumps(self.lock))
        for name, options in (("blobs", {"blobs": True}), ("archive", {})):
            with self.subTest(form=name):
                output = self.root / name
                manifest = builder.assemble(self.payload, self.lock_path, output, **options)
                subprocess.run(["node", "--input-type=module", "-e", script, module,
                                str(output / "manifest.json")], check=True)
                if name == "blobs":
                    for record in manifest["files"]:
                        self.assertTrue(record["url"].startswith("file:"))
                        self.assertEqual(builder.digest(output / "blobs" / record["sha256"]), record["sha256"])
                self.assertIn("UNTESTED", manifest["provenance"]["qualification"])

    def test_rejects_changed_and_unlisted_files(self):
        (self.payload / "extra").write_text("untracked")
        with self.assertRaisesRegex(ValueError, "entire payload"):
            self.assemble()
        (self.payload / "extra").unlink()
        (self.payload / "python/bin/python3").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "lock"):
            self.assemble()

    def test_rejects_symlinks_and_missing_package_provenance(self):
        (self.payload / "link").symlink_to(self.payload / "python/bin/python3")
        with self.assertRaisesRegex(ValueError, "symbolic"):
            self.assemble()
        (self.payload / "link").unlink()
        self.lock["packages"][0].pop("license")
        with self.assertRaisesRegex(ValueError, "provenance"):
            self.assemble()

    def test_rejects_missing_notice_and_incomplete_model_binding(self):
        self.lock["packages"][0]["notices"] = ["MISSING"]
        with self.assertRaisesRegex(ValueError, "notices"):
            self.assemble()
        self.lock["packages"][0]["notices"] = ["NOTICE.fixture"]
        self.lock["modelCapabilities"] = {}
        with self.assertRaisesRegex(ValueError, "Every model"):
            self.assemble()

    def test_rejects_diffq_provenance_code_metadata_and_notices(self):
        for name in ("diffq", "diffq-fixed"):
            self.lock["packages"][0]["name"] = name
            with self.assertRaisesRegex(ValueError, "Excluded non-commercial"):
                self.assemble()
        self.lock["packages"][0]["name"] = "fixture"
        self.lock["excludedPackages"] = {}
        with self.assertRaisesRegex(ValueError, "exact diffq exclusion"):
            self.assemble()
        self.lock["excludedPackages"] = builder.EXCLUDED_PACKAGES
        path = self.payload / "python/lib/python3.12/site-packages/diffq/__init__.py"
        path.parent.mkdir(parents=True)
        path.write_text("excluded")
        data = path.read_bytes()
        self.lock["files"].append({"path": path.relative_to(self.payload).as_posix(), "size": len(data),
                                   "sha256": hashlib.sha256(data).hexdigest(), "executable": False})
        with self.assertRaisesRegex(ValueError, "excluded diffq"):
            self.assemble()


def archive_stream(output, manifest):
    """Independently decode the documented archive format; return the file bytes."""
    stream = b"".join((output / "archive" / Path(part["url"]).name).read_bytes() for part in manifest["archive"]["parts"])
    if stream[:4] != b"\x1f\x8b\x08\x00" or len(stream) < 18:
        raise AssertionError("Not a single plain gzip member")
    inflater = zlib.decompressobj(-zlib.MAX_WBITS)
    data = inflater.decompress(stream[10:]) + inflater.flush()
    if not inflater.eof or inflater.unused_data[8:] or len(inflater.unused_data) != 8:
        raise AssertionError("Archive must be exactly one gzip member with no trailing bytes")
    crc, size = int.from_bytes(inflater.unused_data[:4], "little"), int.from_bytes(inflater.unused_data[4:], "little")
    if crc != zlib.crc32(data) or size != len(data) % 2 ** 32:
        raise AssertionError("Archive trailer does not match its content")
    files, offset = {}, 0
    for record in manifest["files"]:
        files[record["path"]] = data[offset:offset + record["size"]]
        offset += record["size"]
    if offset != len(data):
        raise AssertionError("Archive holds bytes beyond the manifest inventory")
    return files


class ArchivePackTests(unittest.TestCase):
    """Archive output, determinism, splitting, and legacy pack conversion."""

    BASE = "https://example.org/releases/v1/"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = self.root / "payload"
        noise = b"".join(hashlib.sha256(str(i).encode()).digest() for i in range(400))
        self.contents = {
            "lib/zero-start": (b"", False),
            "python/bin/python3": (b"fixture python", True),
            "NOTICE.fixture": (b"MIT notice", False),
            "lib/a/b/c/duplicate-one.txt": (b"same bytes twice", False),
            "lib/x/duplicate-two.txt": (b"same bytes twice", False),
            "lib/bin/tool": (b"#!/bin/sh\nexit 0\n", True),
            "lib/data/noise.bin": (noise, False),
            "lib/zero-end": (b"", False),
        }
        for path, (data, _) in self.contents.items():
            (self.payload / path).parent.mkdir(parents=True, exist_ok=True)
            (self.payload / path).write_bytes(data)
        lock = {"schema": 1, "kind": "processing-input", "appVersion": "0.1.0", "backendVersion": "0.1.0", "lyricsyncVersion": "0.1.0",
                "pythonVersion": "3.12.14", "platform": "linux", "arch": "x64", "accelerator": "cpu", "python": "python/bin/python3",
                "sourceCommit": "a" * 40, "capabilities": ["transcription"], "models": ["whisper"], "modelCapabilities": {"whisper": "transcription"},
                "excludedPackages": builder.EXCLUDED_PACKAGES,
                "packages": [{"name": "fixture", "version": "1", "license": "MIT", "sourceUrl": "https://example.org/fixture.whl", "sha256": "b" * 64, "notices": ["NOTICE.fixture"]}],
                "files": [{"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "executable": executable}
                          for path, (data, executable) in self.contents.items()]}
        self.lock_path = self.root / "lock.json"
        self.lock_path.write_text(json.dumps(lock, indent=2) + "\n")
        self.lock_sha = hashlib.sha256(self.lock_path.read_bytes()).hexdigest()

    def tree(self, directory):
        return {path.relative_to(directory).as_posix(): path.read_bytes() for path in sorted(directory.rglob("*")) if path.is_file()}

    def test_archive_round_trip_restores_every_file_by_manifest_layout(self):
        manifest = builder.assemble(self.payload, self.lock_path, self.root / "out", archive_base_url=self.BASE)
        parts = manifest["archive"]["parts"]
        self.assertEqual(manifest["archive"]["format"], "concat-gzip-v1")
        name = f"singhouse-processing-linux-x64-cpu-{self.lock_sha[:16]}.pack.gz"
        self.assertEqual([part["url"] for part in parts], [self.BASE + name + ".001"])
        self.assertEqual(sorted(path.name for path in (self.root / "out/archive").iterdir()), [name + ".001"])
        for part in parts:
            data = (self.root / "out/archive" / Path(part["url"]).name).read_bytes()
            self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), (part["size"], part["sha256"]))
        restored = archive_stream(self.root / "out", manifest)
        self.assertEqual(restored, {path: data for path, (data, _) in self.contents.items()})
        self.assertEqual(json.loads((self.root / "out/manifest.json").read_text()), manifest)
        self.assertEqual((self.root / "out/input-lock.json").read_bytes(), self.lock_path.read_bytes())
        self.assertFalse((self.root / "out/blobs").exists())

    def test_output_is_byte_reproducible(self):
        first = builder.assemble(self.payload, self.lock_path, self.root / "one", archive_base_url=self.BASE, archive_part_size=1000)
        second = builder.assemble(self.payload, self.lock_path, self.root / "two", archive_base_url=self.BASE, archive_part_size=1000)
        self.assertEqual(first, second)
        self.assertEqual(self.tree(self.root / "one"), self.tree(self.root / "two"))

    def test_parts_split_the_compressed_stream_at_the_configured_size(self):
        whole = builder.assemble(self.payload, self.lock_path, self.root / "whole", archive_base_url=self.BASE)
        split = builder.assemble(self.payload, self.lock_path, self.root / "split", archive_base_url=self.BASE,
                                 archive_part_size=1000, archive_name="runtime.pack.gz")
        parts = split["archive"]["parts"]
        self.assertGreater(len(parts), 3)
        self.assertEqual([Path(part["url"]).name for part in parts], [f"runtime.pack.gz.{i:03d}" for i in range(1, len(parts) + 1)])
        self.assertTrue(all(part["size"] == 1000 for part in parts[:-1]) and 0 < parts[-1]["size"] <= 1000)
        joined = b"".join((self.root / "split/archive" / Path(part["url"]).name).read_bytes() for part in parts)
        self.assertEqual(joined, (self.root / "whole/archive" / Path(whole["archive"]["parts"][0]["url"]).name).read_bytes())
        self.assertEqual(archive_stream(self.root / "split", split), archive_stream(self.root / "whole", whole))
        with self.assertRaisesRegex(ValueError, "more than 64 parts"):
            builder.assemble(self.payload, self.lock_path, self.root / "tiny", archive_part_size=16)

    def test_from_pack_matches_a_fresh_assembly_without_the_payload(self):
        builder.assemble(self.payload, self.lock_path, self.root / "legacy", blobs=True)
        fresh = builder.assemble(self.payload, self.lock_path, self.root / "fresh", archive_base_url=self.BASE, archive_part_size=1000)
        shutil.rmtree(self.payload)
        converted = builder.from_pack(self.root / "legacy", self.root / "converted", archive_base_url=self.BASE, archive_part_size=1000)
        self.assertEqual(converted, fresh)
        self.assertEqual(self.tree(self.root / "converted"), self.tree(self.root / "fresh"))
        # The command line drives the same writer.
        subprocess.run([sys.executable, str(Path(builder.__file__)), "--from-pack", str(self.root / "legacy"),
                        "--output", str(self.root / "cli"), "--archive-base-url", self.BASE, "--archive-part-size", "1000"], check=True)
        self.assertEqual(self.tree(self.root / "cli"), self.tree(self.root / "fresh"))

    def test_from_pack_rejects_changed_blobs_locks_and_manifests(self):
        builder.assemble(self.payload, self.lock_path, self.root / "legacy", blobs=True)
        record = json.loads(self.lock_path.read_text())["files"][2]
        def broken(name, mutate):
            pack = self.root / name
            shutil.copytree(self.root / "legacy", pack)
            mutate(pack)
            return pack
        blob = lambda pack: pack / "blobs" / record["sha256"]
        cases = [
            ("same-size blob change", lambda pack: blob(pack).write_bytes(b"MIT n0tice"), "changed while packaging"),
            ("short blob", lambda pack: blob(pack).write_bytes(b"MIT"), "blob"),
            ("missing blob", lambda pack: blob(pack).unlink(), "blob"),
            ("symlinked blob", lambda pack: (blob(pack).unlink(), blob(pack).symlink_to(self.payload / "NOTICE.fixture")), "blob"),
            ("edited lock", lambda pack: (pack / "input-lock.json").write_bytes((pack / "input-lock.json").read_bytes() + b" "), "input-lock"),
            ("edited manifest", lambda pack: (pack / "manifest.json").write_text(
                (pack / "manifest.json").read_text().replace('"cpu"', '"cuda"')), "fresh assembly"),
            ("already archive form", lambda pack: (pack / "manifest.json").write_text(json.dumps(
                {**json.loads((pack / "manifest.json").read_text()), "archive": {}})), "fresh assembly"),
        ]
        for name, mutate, message in cases:
            with self.subTest(case=name):
                pack = broken(name.replace(" ", "-"), mutate)
                with self.assertRaisesRegex(ValueError, message):
                    builder.from_pack(pack, self.root / ("out-" + name.replace(" ", "-")))

    def test_from_pack_rehosts_an_archive_pack_with_full_reverification(self):
        first = builder.assemble(self.payload, self.lock_path, self.root / "first", archive_part_size=1000)
        fresh = builder.assemble(self.payload, self.lock_path, self.root / "fresh", archive_base_url=self.BASE,
                                 archive_part_size=700, archive_name="runtime.pack.gz")
        shutil.rmtree(self.payload)
        rehosted = builder.from_pack(self.root / "first", self.root / "rehosted", archive_base_url=self.BASE,
                                     archive_part_size=700, archive_name="runtime.pack.gz")
        self.assertEqual(rehosted, fresh)
        self.assertEqual(self.tree(self.root / "rehosted"), self.tree(self.root / "fresh"))
        # Re-hosting a re-hosted pack (published URLs) with the original options
        # restores the original parts byte for byte.
        back = builder.from_pack(self.root / "rehosted", self.root / "back", archive_part_size=1000)
        self.assertEqual(back["archive"]["parts"][0]["sha256"], first["archive"]["parts"][0]["sha256"])
        self.assertEqual({k: v for k, v in self.tree(self.root / "back").items() if k.startswith("archive/")},
                         {k: v for k, v in self.tree(self.root / "first").items() if k.startswith("archive/")})
        subprocess.run([sys.executable, str(Path(builder.__file__)), "--from-pack", str(self.root / "first"),
                        "--output", str(self.root / "cli"), "--archive-base-url", self.BASE, "--archive-part-size", "700",
                        "--archive-name", "runtime.pack.gz"], check=True)
        self.assertEqual(self.tree(self.root / "cli"), self.tree(self.root / "fresh"))

    def test_from_pack_rejects_archive_packs_that_fail_any_check_before_writing(self):
        builder.assemble(self.payload, self.lock_path, self.root / "source", archive_part_size=1000)
        honest = json.loads((self.root / "source/manifest.json").read_text())
        stream = b"".join((self.root / "source/archive" / Path(part["url"]).name).read_bytes() for part in honest["archive"]["parts"])
        lock = json.loads(self.lock_path.read_text())
        data = b"".join(self.contents[record["path"]][0] for record in lock["files"])

        def gzip(content):
            compressor = zlib.compressobj(6, zlib.DEFLATED, -zlib.MAX_WBITS)
            return (builder.GZIP_HEADER + compressor.compress(content) + compressor.flush()
                    + struct.pack("<II", zlib.crc32(content), len(content) & 0xFFFFFFFF))

        def republish(compressed):
            # A self-consistent manifest for different archive bytes: part
            # digests match, so only the stream and lock checks can object.
            def mutate(pack):
                manifest = json.loads((pack / "manifest.json").read_text())
                for path in (pack / "archive").iterdir():
                    path.unlink()
                parts = [compressed[i:i + 1000] for i in range(0, len(compressed), 1000)]
                manifest["archive"]["parts"] = []
                for index, part in enumerate(parts):
                    name = f"bad.pack.gz.{index + 1:03d}"
                    (pack / "archive" / name).write_bytes(part)
                    manifest["archive"]["parts"].append({"url": "https://example.org/r/" + name,
                                                         "sha256": hashlib.sha256(part).hexdigest(), "size": len(part)})
                (pack / "manifest.json").write_text(json.dumps(manifest))
            return mutate

        flipped = bytearray(stream)
        flipped[-8] ^= 0xFF
        first_part = lambda pack: pack / "archive" / Path(honest["archive"]["parts"][0]["url"]).name
        tampered = data.replace(b"MIT notice", b"MIT n0tice")
        cases = [
            ("flipped part byte", lambda pack: first_part(pack).write_bytes(
                first_part(pack).read_bytes()[:500] + bytes([first_part(pack).read_bytes()[500] ^ 1]) + first_part(pack).read_bytes()[501:]),
             "does not match its manifest"),
            ("flipped header byte", lambda pack: first_part(pack).write_bytes(
                bytes([first_part(pack).read_bytes()[0] ^ 1]) + first_part(pack).read_bytes()[1:]), "does not match its manifest"),
            ("missing part", lambda pack: first_part(pack).unlink(), "archive part"),
            ("symlinked part", lambda pack: (shutil.copy(first_part(pack), self.root / "elsewhere"), first_part(pack).unlink(),
                                             first_part(pack).symlink_to(self.root / "elsewhere")), "archive part"),
            ("extra gzip member", republish(stream + gzip(b"extra")), "trailing"),
            ("trailing garbage", republish(stream + b"garbage"), "trailing"),
            ("extra uncompressed byte", republish(gzip(data + b"x")), "trailing"),
            ("flipped trailer CRC", republish(bytes(flipped)), "trailer"),
            ("truncated stream", republish(stream[:-20]), "truncated|trailer"),
            ("optional header fields", republish(b"\x1f\x8b\x08\x08" + stream[4:]), "gzip member"),
            ("wrong file inside archive", republish(gzip(tampered)), "does not match its lock"),
            ("short uncompressed stream", republish(gzip(data[:-1])), "ended before|does not match its lock"),
            ("edited manifest", lambda pack: (pack / "manifest.json").write_text(
                (pack / "manifest.json").read_text().replace('"cpu"', '"cuda"')), "fresh assembly"),
            ("per-file URL in archive pack", lambda pack: (pack / "manifest.json").write_text(json.dumps(
                {**honest, "files": [{**record, "url": "https://example.org/f"} for record in honest["files"]]})), "fresh assembly"),
            ("nested part name", lambda pack: (pack / "manifest.json").write_text(json.dumps(
                {**honest, "archive": {**honest["archive"], "parts": [{**honest["archive"]["parts"][0], "url": "https://example.org/a/..%2Fx"}]}})),
             "flat names"),
        ]
        real_write = builder.write_output
        for name, mutate, message in cases:
            with self.subTest(case=name):
                pack = self.root / name.replace(" ", "-")
                shutil.copytree(self.root / "source", pack)
                mutate(pack)
                writes = []

                def recording(*args, **kwargs):
                    writes.append(args[0])
                    return real_write(*args, **kwargs)
                builder.write_output = recording
                try:
                    with self.assertRaisesRegex(ValueError, message):
                        builder.from_pack(pack, self.root / "out" / name.replace(" ", "-"))
                finally:
                    builder.write_output = real_write
                # Archive faults are found by the verification pass, before any output exists.
                self.assertEqual(writes, [])
                self.assertFalse((self.root / "out").exists() and any((self.root / "out").iterdir()))

    def test_failed_assembly_leaves_no_partial_output(self):
        real = builder.checked_chunks
        written = []

        def failing(record, source):
            if record["path"] == "lib/data/noise.bin":
                yield next(real(record, source))
                # Output already exists in the temporary sibling at this point.
                written.append(sorted(path.relative_to(self.root / "out").as_posix() for path in (self.root / "out").rglob("*") if path.is_file()))
                raise OSError("simulated read failure mid-stream")
            yield from real(record, source)
        builder.checked_chunks = failing
        try:
            for options, kind in ((dict(archive_part_size=4000), "/archive/"), (dict(blobs=True), "/blobs/")):
                with self.subTest(options=options), self.assertRaisesRegex(OSError, "simulated"):
                    builder.assemble(self.payload, self.lock_path, self.root / "out" / "pack", **options)
                self.assertTrue(any(kind in path for path in written[-1]), written)
                self.assertFalse(any(path.startswith("pack/") for path in written[-1]))
                # Nothing remains: no parts or blobs without a manifest, no temporary directory.
                self.assertEqual(list((self.root / "out").iterdir()), [])
        finally:
            builder.checked_chunks = real
        manifest = builder.assemble(self.payload, self.lock_path, self.root / "out" / "pack", archive_part_size=4000)
        self.assertEqual(sorted(path.name for path in (self.root / "out").iterdir()), ["pack"])
        self.assertTrue(manifest["archive"]["parts"][0]["url"].startswith((self.root / "out" / "pack" / "archive").absolute().as_uri()))
        with self.assertRaisesRegex(ValueError, "Output exists"):
            builder.assemble(self.payload, self.lock_path, self.root / "out" / "pack")

    def test_delivery_options_are_mutually_exclusive_and_validated(self):
        invalid = [
            dict(base_url="https://example.org/blobs/", archive_base_url=self.BASE),
            dict(blobs=True, archive_part_size=1000),
            dict(blobs=True, archive_name="runtime.pack.gz"),
            dict(archive_part_size=0), dict(archive_part_size=2 ** 31), dict(archive_part_size=True),
            dict(archive_name="nested/name"), dict(archive_name=".."), dict(archive_name="name with space"),
            dict(archive_base_url="https://example.org/no-slash"), dict(archive_base_url="http://example.org/"),
            dict(archive_base_url="https://example.org/?token=1/"), dict(archive_base_url="https://user:secret@example.org/"),
            dict(archive_base_url="file://server/share/"),
        ]
        for options in invalid:
            with self.subTest(options=options), self.assertRaises(ValueError):
                builder.assemble(self.payload, self.lock_path, self.root / "never", **options)
            self.assertFalse((self.root / "never").exists())
        script = str(Path(builder.__file__))
        for args in (["--blobs", "--archive-name", "x"], ["--base-url", "https://example.org/b/", "--archive-base-url", self.BASE],
                     ["--from-pack", str(self.root), "--blobs"], ["--from-pack", str(self.root), "--payload", str(self.payload)],
                     []):
            with self.subTest(args=args):
                lock_args = [] if "--from-pack" in args else ["--payload", str(self.payload), "--lock", str(self.lock_path)]
                if not args:
                    lock_args = ["--payload", str(self.payload)]
                result = subprocess.run([sys.executable, script, *lock_args, *args, "--output", str(self.root / "never")],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse((self.root / "never").exists())

    @unittest.skipIf(sys.platform == "win32", "uses a POSIX bundled-interpreter stand-in")
    def test_runtime_manager_installs_the_assembled_archive(self):
        manifest = builder.assemble(self.payload, self.lock_path, self.root / "out", archive_part_size=1000)
        self.assertGreater(len(manifest["archive"]["parts"]), 1)
        desktop = Path(__file__).parents[1]
        script = """const {RuntimeManager}=await import(process.argv[1]);
import fs from 'node:fs';
const manifest=JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const manager=new RuntimeManager(process.argv[3], {appVersion:'0.1.0',backendVersion:'0.1.0',lyricsyncVersion:'0.1.0',platform:'linux',arch:'x64'},
  {lockPython:process.argv[4], durabilityHelper:process.argv[5], trustedLocks:[manifest.provenance.lockSha256], fetchImpl:()=>{throw new Error('offline')}});
manager.probe=async()=>({});
const installed=await manager.install(manifest);
process.stdout.write(JSON.stringify({directory: installed.directory}));
"""
        result = subprocess.run(["node", "--input-type=module", "-e", script, (desktop / "runtime_manager.mjs").as_uri(),
                                 str(self.root / "out/manifest.json"), str(self.root / "store"), sys.executable,
                                 str(desktop / "backend.py")], check=True, capture_output=True, text=True)
        directory = Path(json.loads(result.stdout)["directory"])
        for path, (data, executable) in self.contents.items():
            self.assertEqual((directory / path).read_bytes(), data)
            self.assertEqual((directory / path).stat().st_mode & 0o777, 0o700 if executable else 0o600)
        self.assertEqual(list((self.root / "store/staging").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
