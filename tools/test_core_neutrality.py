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
PUBLIC_BRAND_DOCS = (
    "docs/install-desktop.md",
    "docs/modal.md",
    "docs/release-notes-draft.md",
    "docs/release-qualification.md",
    "docs/support-diagnostics.md",
    "docs/asahi-local-test.md",
    "docs/release-checklist.md",
)
LOOKUP = "https://api.github.com/" + "users/YOUR_LOGIN"
HOME_SAMPLE = "/" + "home/fixture_account/media"
PRIVATE_BRAND = "retired_fixture"
VENDOR_SAMPLE = "fixture_vendor"


class LegalLiteralTests(unittest.TestCase):
    def check_gate(
        self, filename, content, *, private_brand=None, private_infra=None,
        extra_files=None,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            files = {filename: content, **(extra_files or {})}
            for relative, body in files.items():
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(body + "\n")
            subprocess.run(
                ["git", "-C", directory, "add", "--", *files], check=True,
            )
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

    def test_named_public_docs_may_name_product_but_not_private_brands(self):
        for filename in PUBLIC_BRAND_DOCS:
            with self.subTest(filename=filename, kind="public-product"):
                self.assert_gate(filename, PRODUCT.title(), 0)
            with self.subTest(filename=filename, kind="private-brand"):
                output = self.assert_gate(
                    filename, PRODUCT.title() + " " + PRIVATE_BRAND, 1,
                    private_brand=PRIVATE_BRAND,
                )
                self.assertIn(filename + ":1:", output)
                self.assertIn("FAIL: brand literals", output)

    def test_unlisted_public_doc_still_requires_brand_indirection(self):
        self.assert_gate("docs/another-guide.md", PRODUCT.title(), 1)

    def test_named_public_docs_remain_in_vendor_and_infra_checks(self):
        content = PRODUCT.title() + " " + VENDOR_SAMPLE + " " + HOME_SAMPLE
        for filename in PUBLIC_BRAND_DOCS:
            with self.subTest(filename=filename):
                output = self.assert_gate(filename, content, 1)
                self.assertIn("FAIL: vendor literals", output)
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

    def test_hit_labels_treat_awkward_filenames_as_data(self):
        cases = (
            ("docs/vendor|fixture.txt", VENDOR_SAMPLE, "FAIL: vendor literals"),
            ("premium/vendor&fixture.txt", VENDOR_SAMPLE, "FAIL: vendor literals"),
            ("frontend/src/import|fixture.js", "karaoke_premium", "FAIL: premium import paths"),
            ("frontend/src/-download-fixture.js", "Download this", "FAIL: Download-verb language"),
            ("frontend/src/auth&fixture.js", "invite_token", "FAIL: multi-user auth markers"),
            ("frontend/src/rotation|fixture.js", "useRotationStore", "FAIL: premium rotation markers"),
        )
        for filename, content, failure in cases:
            with self.subTest(filename=filename):
                output = self.assert_gate(filename, content, 1)
                self.assertIn(filename + ":1:" + content, output)
                self.assertIn(failure, output)
                self.assertNotIn("sed:", output)

    def test_dangling_reference_label_treats_filename_as_data(self):
        filename = "docs/dangling|fixture.md"
        withheld = "notes/withheld.md"
        output = self.assert_gate(
            filename,
            f"See {withheld}",
            1,
            private_brand="retired_fixture",
            private_infra="fixture_infra",
            extra_files={
                withheld: "private notes",
                "tools/keep-private.txt": withheld,
            },
        )
        self.assertIn(filename + ":1:See " + withheld, output)
        self.assertIn("FAIL: surviving files reference keep-private paths", output)
        self.assertNotIn("sed:", output)

    def test_git_quoted_filenames_fail_closed_during_enumeration(self):
        for filename in (r"docs/backslash\fixture.txt", "docs/newline\nfixture.txt"):
            with self.subTest(filename=filename):
                output = self.assert_gate(filename, VENDOR_SAMPLE, 1)
                self.assertIn("FAIL: tracked paths missing from the worktree", output)


if __name__ == "__main__":
    unittest.main()
