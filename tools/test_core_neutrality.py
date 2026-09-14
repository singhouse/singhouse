#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Regression checks for narrowly permitted legal-record literals."""

from pathlib import Path
import re
import subprocess
import tempfile
import unittest


GATE = Path(__file__).with_name("check_core_neutrality.sh")
PRODUCT = re.search(r"BRAND_PATTERN=.*join_pattern '([^']+)'", GATE.read_text())[1]
LEGAL_FILES = (
    ".github/scripts/cla.cjs", "CLA.md", "CCLA.md", "CLA-SIGNATURES.json",
    "CONTRIBUTING.md", "LICENSING.md",
)
LOOKUP = "https://api.github.com/" + "users/YOUR_LOGIN"
HOME_SAMPLE = "/" + "home/fixture_account/media"
PRIVATE_BRAND = "retired_fixture"
VENDOR_SAMPLE = "fixture_vendor"


class LegalLiteralTests(unittest.TestCase):
    def check_gate(self, filename, content, *, private_brand=None, private_infra=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            target = root / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content + "\n")
            subprocess.run(["git", "-C", directory, "add", filename], check=True)
            if private_brand or private_infra:
                (root / "tools").mkdir(exist_ok=True)
                supplement = root / "tools" / ("private-" + "patterns.txt")
                supplement.write_text(
                    f"brand:{private_brand or PRIVATE_BRAND}\n"
                    + f"infra:{private_infra or 'fixture_infra'}\n"
                )
            result = subprocess.run(
                ["bash", str(GATE), directory], capture_output=True, text=True,
            )
            return result.returncode, result.stdout + result.stderr

    def assert_gate(self, filename, content, expected, **kwargs):
        code, output = self.check_gate(filename, content, **kwargs)
        self.assertEqual(code, expected, output)
        return output

    def test_legal_names_allowed_with_and_without_supplement(self):
        for filename in LEGAL_FILES:
            for supplement in (None, PRIVATE_BRAND):
                with self.subTest(filename=filename, supplement=supplement):
                    self.assert_gate(filename, PRODUCT.title(), 0, private_brand=supplement)

    def test_private_brand_still_rejected_in_every_legal_record(self):
        for filename in LEGAL_FILES:
            for private in (PRIVATE_BRAND, PRODUCT + "_private_fixture"):
                with self.subTest(filename=filename, private=private):
                    output = self.assert_gate(
                        filename, PRODUCT + " " + private.upper(), 1, private_brand=private,
                    )
                    self.assertIn(filename + ":1:", output)
                    self.assertIn("FAIL: brand literals", output)

    def test_ordinary_files_still_require_brand_indirection(self):
        for filename in ("docs/contributor.md", "docs/CLA.md", "frontend/src/example.js"):
            with self.subTest(filename=filename):
                self.assert_gate(filename, PRODUCT, 1)

    def test_desktop_delivery_may_name_public_product_but_not_private_brands(self):
        for filename in ("desktop/main.mjs", "desktop/build/package.mjs", "desktop/README.md"):
            with self.subTest(filename=filename):
                self.assert_gate(filename, PRODUCT.title(), 0)
                output = self.assert_gate(
                    filename, PRODUCT.title() + " " + PRIVATE_BRAND, 1,
                    private_brand=PRIVATE_BRAND,
                )
                self.assertIn("FAIL: brand literals", output)

    def test_desktop_brand_exception_does_not_disable_other_gates(self):
        output = self.assert_gate("desktop/main.mjs", VENDOR_SAMPLE, 1)
        self.assertIn("FAIL: vendor literals", output)
        output = self.assert_gate("desktop/main.mjs", HOME_SAMPLE, 1)
        self.assertIn("FAIL: private-infra literals", output)

    def test_exact_lookup_url_allowed(self):
        for content in (LOOKUP, "`" + LOOKUP + "`", LOOKUP + " followed by text"):
            with self.subTest(content=content):
                self.assert_gate("CONTRIBUTING.md", content, 0)

    def test_private_brand_starting_with_dash_is_rejected(self):
        private = "-private_fixture"
        output = self.assert_gate("CLA.md", private, 1, private_brand=private)
        self.assertIn("FAIL: brand literals", output)
        self.assertNotIn("invalid option", output)

    def test_lookup_account_suffix_is_not_exempt(self):
        for suffix in ("_REALACCOUNT", "-fixture", "42", "fixture"):
            with self.subTest(suffix=suffix):
                output = self.assert_gate("CONTRIBUTING.md", LOOKUP + suffix, 1)
                self.assertIn("FAIL: private-infra literals", output)

    def test_lookup_does_not_hide_home_path_on_same_line(self):
        output = self.assert_gate("CONTRIBUTING.md", LOOKUP + " " + HOME_SAMPLE, 1)
        self.assertIn("FAIL: private-infra literals", output)
        self.assertIn(LOOKUP + " " + HOME_SAMPLE, output)

    def test_lookup_does_not_hide_supplement_infra(self):
        self.assert_gate(
            "CONTRIBUTING.md", LOOKUP + " fixture.internal", 1,
            private_infra=r"fixture\.internal",
        )

    def test_other_account_lookup_is_not_exempt(self):
        self.assert_gate("CONTRIBUTING.md", LOOKUP.replace("YOUR_LOGIN", "fixture"), 1)


if __name__ == "__main__":
    unittest.main()
