# SPDX-License-Identifier: AGPL-3.0-only
"""Cross-assembly checks that never execute foreign code."""
import importlib.util
import gzip
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("assemble", Path(__file__).parents[1] / "build/assemble.py")
assemble = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(Path(__file__).parents[1] / "build"))
try:
    spec.loader.exec_module(assemble)
finally:
    sys.path.pop(0)


class AssemblyTests(unittest.TestCase):
    def test_memory_policy_selects_only_native_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "processing-memory"
            source.mkdir()
            for target in ("linux-x64", "win32-x64"):
                (source / f"{target}.json").write_text(target)
            with patch.object(assemble, "DESKTOP", root):
                for target in ("linux-x64", "win32-x64", "darwin-arm64"):
                    output = root / target
                    output.mkdir()
                    assemble.copy_processing_memory_policy(target, output)
                    path = output / "processing-memory.json"
                    if target == "darwin-arm64":
                        self.assertFalse(path.exists())
                    else:
                        self.assertEqual(path.read_text(), target)

    def test_generic_assembly_descriptor_binds_opaque_payload_and_pairing(self):
        files = {"backend.py": "a" * 64, "static/index.html": "b" * 64}
        core = assemble.assembly_descriptor(files)
        self.assertEqual(core["kind"], "singhouse-assembly")
        self.assertNotIn("pairedCoreReleaseId", core)
        premium = assemble.assembly_descriptor(files, "premium", "c" * 64)
        self.assertEqual(premium["pairedCoreReleaseId"], "c" * 64)
        with self.assertRaisesRegex(ValueError, "exact paired"):
            assemble.assembly_descriptor(files, "premium")
        with self.assertRaisesRegex(ValueError, "cannot declare"):
            assemble.assembly_descriptor(files, "core", "c" * 64)

    def test_executable_unpack_supports_existing_gzip_and_pinned_single_member_zip(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = b"synthetic native executable"
            for archive_format in ("gzip", "zip"):
                with self.subTest(archive=archive_format):
                    source = root / ("input." + archive_format)
                    executable = root / "ffmpeg"
                    if archive_format == "gzip":
                        source.write_bytes(gzip.compress(data))
                        record = {}
                    else:
                        with zipfile.ZipFile(source, "w") as archive:
                            archive.writestr("ffmpeg", data)
                        record = {"archive": "zip", "member": "ffmpeg"}
                    assemble.unpack_executable(source, record, executable)
                    self.assertEqual(executable.read_bytes(), data)
                    executable.unlink()

    def test_executable_zip_rejects_undeclared_members_and_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, executable = root / "input.zip", root / "ffmpeg"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("ffmpeg", b"synthetic")
                archive.writestr("../outside", b"must never extract")
            with self.assertRaisesRegex(ValueError, "unexpected layout"):
                assemble.unpack_executable(source, {"archive": "zip", "member": "ffmpeg"}, executable)
            with self.assertRaisesRegex(ValueError, "basename"):
                assemble.unpack_executable(source, {"archive": "zip", "member": "../outside"}, executable)
            self.assertFalse(executable.exists())
            self.assertEqual(list(root.iterdir()), [source])

    def test_untracked_build_inputs_make_source_dirty_but_ignored_outputs_do_not(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(assemble, "ROOT", Path(temporary)):
            root = Path(temporary)
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
            git("init")
            (root / ".gitignore").write_text("frontend/dist/\n")
            git("add", ".gitignore")
            git("-c", "user.name=Assembly test", "-c", "user.email=assembly@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "-m", "Synthetic fixture")
            output = root / "frontend/dist/index.html"
            output.parent.mkdir(parents=True)
            output.write_text("ignored generated output")
            self.assertFalse(assemble.source_provenance()["sourceDirty"])
            for relative in ("backend/src/karaoke_backend/untracked.py", "frontend/public/untracked.svg"):
                with self.subTest(input=relative):
                    path = root / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("untracked build input")
                    self.assertTrue(assemble.source_provenance()["sourceDirty"])
                    path.unlink()
                    self.assertFalse(assemble.source_provenance()["sourceDirty"])

    def test_frontend_notices_include_tailwind_despite_dev_dependency_flag(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            frontend, output = root / "frontend", root / "output"
            packages = {
                "node_modules/tailwindcss": {"name": "tailwindcss", "version": "3.4.19", "dev": True},
                "node_modules/@fontsource-variable/space-grotesk": {
                    "name": "@fontsource-variable/space-grotesk", "version": "5.3.0"},
                "node_modules/eslint": {"name": "eslint", "version": "10.8.1", "dev": True},
            }
            license_text = b"MIT License\n\nCopyright (c) Tailwind Labs, Inc.\n"
            for relative, metadata in packages.items():
                package = frontend / relative
                package.mkdir(parents=True)
                (package / "package.json").write_text(json.dumps(metadata | {"license": "MIT"}))
                if metadata["name"] != "eslint":
                    (package / "LICENSE").write_bytes(license_text)
            (frontend / "package-lock.json").write_text(json.dumps({"packages": packages}))
            (output / "static/assets").mkdir(parents=True)
            assemble.collect_notices(frontend, output)
            notices = output / "notices/frontend"
            self.assertEqual((notices / "tailwindcss/LICENSE").read_bytes(), license_text)
            inventory = json.loads((notices / "inventory.json").read_text())
            self.assertEqual({entry["name"] for entry in inventory},
                             {"tailwindcss", "@fontsource-variable/space-grotesk"})
            tailwind = next(entry for entry in inventory if entry["name"] == "tailwindcss")
            self.assertEqual(tailwind["version"], "3.4.19")
            self.assertEqual(tailwind["license"], "MIT")

    def test_export_source_requires_valid_identity_and_does_not_claim_clean(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(assemble, "ROOT", Path(temporary)):
            for invalid in (None, "", "abc", "x" * 40):
                with self.assertRaises(SystemExit):
                    assemble.source_provenance(invalid)
            result = assemble.source_provenance("A" * 40)
            self.assertEqual(result, {"sourceCommit": "a" * 40, "sourceDirty": None, "sourceExport": True})

    def test_repository_identity_takes_precedence_over_export_hint(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(assemble, "ROOT", Path(temporary)):
            (Path(temporary) / ".git").write_text("gitdir: /example")
            with patch.object(assemble.subprocess, "check_output", side_effect=["b" * 40 + "\n", b" M file"]):
                result = assemble.source_provenance("a" * 40)
            self.assertEqual(result, {"sourceCommit": "b" * 40, "sourceDirty": True, "sourceExport": False})

    def test_target_paths_use_target_os_and_python_minor(self):
        root = Path("/payload")
        self.assertEqual(assemble.python_path(root, "win32-x64"), root / "python/python.exe")
        self.assertEqual(assemble.python_path(root, "linux-arm64"), root / "python/bin/python3")
        self.assertEqual(assemble.site_packages(root, "win32-x64", "3.12.14"), root / "python/Lib/site-packages")
        self.assertEqual(assemble.site_packages(root, "linux-arm64", "3.12.14"), root / "python/lib/python3.12/site-packages")

    def test_cross_inspection_cannot_execute_target_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "ffmpeg"
            binary.write_bytes(b"foreign executable --enable-gpl")
            with patch.object(assemble.subprocess, "check_output", side_effect=AssertionError("Foreign execution")):
                report = assemble.inspect_executable(binary, cross=True)
            self.assertEqual(report["status"], "UNTESTED")
            self.assertTrue(report["nativeExecutionRequired"])

    def test_cross_inspection_rejects_nonfree_flag_across_read_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "ffmpeg"
            binary.write_bytes(b"0" * (1024 * 1024 - 7) + b"--enable-nonfree")
            with self.assertRaisesRegex(SystemExit, "Non-redistributable"):
                assemble.inspect_executable(binary, cross=True)

    def test_native_inspection_executes_version_and_rejects_nonfree(self):
        with patch.object(assemble.subprocess, "check_output", return_value="configuration: --enable-nonfree") as run:
            with self.assertRaisesRegex(SystemExit, "Non-redistributable"):
                assemble.inspect_executable(Path("/native/ffmpeg"), cross=False)
            run.assert_called_once_with(["/native/ffmpeg", "-version"], text=True)

    def test_metadata_reads_only_target_dist_info_without_importing_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            info = directory / "example-1.0.dist-info"
            info.mkdir()
            (info / "METADATA").write_text("Metadata-Version: 2.1\nName: example\nVersion: 1.0\n")
            package = directory / "example"
            package.mkdir()
            (package / "__init__.py").write_text("raise RuntimeError('must never import foreign code')")
            with patch.object(assemble.subprocess, "check_output", side_effect=AssertionError("No execution")):
                self.assertEqual(assemble.metadata(directory), {"example": "1.0"})


if __name__ == "__main__":
    unittest.main()
