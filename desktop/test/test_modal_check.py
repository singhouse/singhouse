# SPDX-License-Identifier: AGPL-3.0-only
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

HELPER = Path(__file__).parents[1] / "modal_check.py"
spec = importlib.util.spec_from_file_location("modal_check", HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
CONFIG = {"app": "user-app", "environment": "main", "version": 3,
          "tokenId": "ak_test", "tokenSecret": "as_private-test-secret"}
CONTRACT = {"schema": 1, "protocolReference": "protocol-v1", "protocolSha256": "a" * 64,
            "requiredTags": {"protocol": "protocol-v1", "digest": "a" * 64},
            "functions": {"separation": "separate_" + "a" * 64, "transcription": "transcribe_" + "a" * 64}}


def fake_sdk(tags=None, fail_function=False):
    calls = []
    client = object()

    async def credentials(token_id, token_secret):
        calls.append(("credentials", token_id, token_secret))
        return client

    async def get_tags(**kwargs):
        assert kwargs == {"client": client}
        calls.append(("tags",))
        return CONTRACT["requiredTags"] if tags is None else tags

    async def lookup(name, **kwargs):
        calls.append(("lookup", name, kwargs))
        assert kwargs == {"client": client, "environment_name": "main", "create_if_missing": False}
        return SimpleNamespace(get_tags=SimpleNamespace(aio=get_tags))

    def from_name(app, name, **kwargs):
        calls.append(("function", app, name, kwargs))
        assert kwargs == {"client": client, "environment_name": "main", "version": 3}

        async def hydrate(**kwargs):
            assert kwargs == {"client": client}
            calls.append(("hydrate", name))
            if fail_function:
                raise RuntimeError(CONFIG["tokenSecret"])
        # No remote/spawn/invocation attributes exist; any attempt would fail.
        return SimpleNamespace(hydrate=SimpleNamespace(aio=hydrate))

    return SimpleNamespace(Client=SimpleNamespace(from_credentials=SimpleNamespace(aio=credentials)),
                           App=SimpleNamespace(lookup=SimpleNamespace(aio=lookup)),
                           Function=SimpleNamespace(from_name=from_name)), calls


class MetadataTests(unittest.TestCase):
    def test_access_and_compatibility_never_claim_readiness(self):
        sdk, calls = fake_sdk()
        result = helper.run(json.dumps(CONFIG), CONTRACT, sdk)
        self.assertTrue(result["accessChecked"])
        self.assertTrue(result["compatible"])
        self.assertFalse(result["qualified"])
        self.assertFalse(result["ready"])
        self.assertEqual([c[0] for c in calls], ["credentials", "lookup", "tags", "function", "hydrate", "function", "hydrate"])
        self.assertEqual([c[2] for c in calls if c[0] == "function"], list(CONTRACT["functions"].values()))

    def test_absent_or_invalid_release_contract_cannot_grant_compatibility(self):
        for contract in (None, {}, {**CONTRACT, "protocolSha256": "bad"}, {**CONTRACT, "requiredTags": {"unrelated": "value"}}):
            sdk, calls = fake_sdk()
            result = helper.run(json.dumps(CONFIG), contract, sdk)
            self.assertTrue(result["accessChecked"])
            self.assertFalse(result["compatible"])
            self.assertEqual(result["errorCode"], "release-contract-unavailable")
            self.assertNotIn("function", [c[0] for c in calls])

    def test_tag_mismatch_blocks_function_lookup(self):
        sdk, calls = fake_sdk(tags={"protocol": "old"})
        result = helper.run(json.dumps(CONFIG), CONTRACT, sdk)
        self.assertEqual(result["errorCode"], "protocol-tags-mismatch")
        self.assertNotIn("function", [c[0] for c in calls])

    def test_protocol_names_are_bound_to_exact_version_lookup(self):
        for functions in ({"separation": "separate", "transcription": "transcribe"},
                          {**CONTRACT["functions"], "separation": "separate_" + "b" * 64}):
            sdk, calls = fake_sdk()
            output = helper.run(json.dumps(CONFIG), {**CONTRACT, "functions": functions}, sdk)
            self.assertFalse(output["compatible"])
            self.assertNotIn("function", [c[0] for c in calls])
        # Matching current tags cannot make a historical version compatible if
        # it does not expose that exact protocol-addressed function.
        sdk, calls = fake_sdk(fail_function=True)
        output = helper.run(json.dumps(CONFIG), CONTRACT, sdk)
        self.assertTrue(output["accessChecked"])
        self.assertFalse(output["compatible"])
        self.assertEqual(next(c[3]["version"] for c in calls if c[0] == "function"), 3)

    def test_function_hydration_failure_is_redacted(self):
        sdk, _ = fake_sdk(fail_function=True)
        result = helper.run(json.dumps(CONFIG), CONTRACT, sdk)
        self.assertFalse(result["compatible"])
        self.assertEqual(result["stages"]["functions"], "failed")
        self.assertNotIn(CONFIG["tokenSecret"], json.dumps(result))

    def test_invalid_config_does_not_touch_sdk(self):
        for key, value in [("app", "../app"), ("environment", ""), ("version", True),
                           ("version", 0), ("version", "3"), ("tokenSecret", "secret\n"), ("tokenId", "")]:
            sdk, calls = fake_sdk()
            result = helper.run(json.dumps({**CONFIG, key: value}), CONTRACT, sdk)
            self.assertEqual(result["errorCode"], "invalid-config")
            self.assertEqual(calls, [])
        self.assertEqual(helper.run("not JSON")["errorCode"], "invalid-config")
        self.assertEqual(helper.run(json.dumps({**CONFIG, "contract": CONTRACT}))["errorCode"], "invalid-config")

    def test_internal_timeout(self):
        sdk, _ = fake_sdk()

        async def stalled(*args):
            await asyncio.sleep(10)
        sdk.Client.from_credentials.aio = stalled
        result = asyncio.run(helper.check_metadata(CONFIG, CONTRACT, sdk, timeout=0.001))
        self.assertEqual(result["errorCode"], "metadata-check-timeout")
        self.assertFalse(result["compatible"])

    def test_subprocess_suppresses_sdk_output_and_ambient_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "modal.py").write_text('''import os
from pathlib import Path
print("SECRET SDK OUTPUT")
os.write(1, b"SECRET NATIVE OUTPUT")
os.write(2, b"SECRET STDERR")
assert "MODAL_TOKEN_ID" not in os.environ
assert "MODAL_TOKEN_SECRET" not in os.environ
assert "MODAL_SERVER_URL" not in os.environ
assert Path(os.environ["MODAL_CONFIG_PATH"]).read_text() == ""
Path(__file__).with_suffix(".verified").write_text("isolated")
__version__ = "wrong-version"
''')
            env = {**os.environ, "PYTHONPATH": directory, "MODAL_TOKEN_ID": "ambient-secret",
                   "MODAL_TOKEN_SECRET": "ambient-secret", "MODAL_SERVER_URL": "https://invalid.example"}
            process = subprocess.run([sys.executable, str(HELPER)], input=json.dumps(CONFIG),
                                     text=True, capture_output=True, env=env, timeout=10)
            result = json.loads(process.stdout)
            self.assertEqual(result["errorCode"], "sdk-unavailable")
            self.assertEqual(Path(directory, "modal.verified").read_text(), "isolated")
            self.assertEqual(process.stderr, "")
            self.assertNotIn("SECRET", process.stdout)
            self.assertEqual(process.returncode, 0)


if __name__ == "__main__":
    unittest.main()
