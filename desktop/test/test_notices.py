# SPDX-License-Identifier: AGPL-3.0-only
"""Frontend notice collection preserves UTF-8 metadata and original license bytes."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("notices", Path(__file__).parents[1] / "build/notices.py")
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class NoticeEncodingTests(unittest.TestCase):
    def test_utf8_metadata_with_windows_legacy_default_and_exact_license_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            frontend, output = root / "frontend", root / "output"
            font = "@fontsource-variable/space-grotesk"
            # UTF-8 for Ł includes 0x81, which is undefined in Windows cp1252.
            metadata = {"name": "notice-fixture", "version": "1.0.0",
                        "author": "Łódź", "license": "LicenseRef-Łódź"}
            packages = {"node_modules/notice-fixture": metadata,
                        f"node_modules/{font}": {"name": font, "version": "1.0.0", "license": "OFL-1.1"}}
            original_license = b"Fixture license\r\nUTF-8: \xc5\x81\xc3\xb3d\xc5\xba\r\n\x81\xff\n"
            for relative, package in packages.items():
                directory = frontend / relative
                directory.mkdir(parents=True)
                (directory / "package.json").write_bytes(json.dumps(package, ensure_ascii=False).encode("utf-8"))
                (directory / "LICENSE").write_bytes(original_license)
            (frontend / "package-lock.json").write_bytes(
                json.dumps({"description": "Łódź", "packages": packages}, ensure_ascii=False).encode("utf-8"))
            (output / "static/assets").mkdir(parents=True)
            read_text, write_text = Path.read_text, Path.write_text
            writes = []

            def legacy_read(path, encoding=None, **kwargs):
                return read_text(path, encoding=encoding or "cp1252", **kwargs)

            def legacy_write(path, data, encoding=None, **kwargs):
                writes.append(encoding)
                return write_text(path, data, encoding=encoding or "cp1252", **kwargs)

            with patch.object(Path, "read_text", legacy_read), patch.object(Path, "write_text", legacy_write):
                notices.collect(frontend, output)

            destination = output / "notices/frontend"
            inventory = json.loads((destination / "inventory.json").read_bytes().decode("utf-8"))
            self.assertEqual(writes, ["utf-8"])
            self.assertEqual(len(inventory), 2)
            fixture = next(entry for entry in inventory if entry["name"] == "notice-fixture")
            self.assertEqual(fixture["license"], metadata["license"])
            self.assertEqual(fixture["texts"], ["LICENSE"])
            for package in packages.values():
                self.assertEqual((destination / package["name"].replace("/", "_") / "LICENSE").read_bytes(), original_license)
            self.assertEqual((output / "static/assets/SpaceGrotesk-LICENSE.txt").read_bytes(), original_license)


if __name__ == "__main__":
    unittest.main()
