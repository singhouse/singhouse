# SPDX-License-Identifier: AGPL-3.0-only
import json
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "desktop" / "qualification" / "qualify.py"
MATRIX = ROOT / "desktop" / "qualification" / "matrix.template.json"


class QualificationToolTest(unittest.TestCase):
    def test_checked_in_matrix_is_valid(self):
        result = subprocess.run(
            ["python3", str(TOOL), "validate", str(MATRIX)],
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("valid matrix", result.stdout)

    def test_inventory_hashes_supplied_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact = root / "candidate.bin"
            output = root / "machine.json"
            artifact.write_bytes(b"candidate")
            result = subprocess.run(
                [
                    "python3",
                    str(TOOL),
                    "inventory",
                    "--candidate-revision",
                    "a" * 40,
                    "--artifact",
                    str(artifact),
                    "--output",
                    str(output),
                ],
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["candidateRevision"], "a" * 40)
            self.assertEqual(report["artifacts"][0]["size"], 9)
            self.assertEqual(len(report["artifacts"][0]["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
