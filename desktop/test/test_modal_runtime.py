# SPDX-License-Identifier: AGPL-3.0-only
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DESKTOP = Path(__file__).parents[1]
sys.path.insert(0, str(DESKTOP))
import modal_runtime as runtime

DIGEST = "a" * 64
CONFIG = {"app": "private-app", "environment": "main", "version": 7,
          "tokenId": "ak_private-id", "tokenSecret": "as_private-secret",
          "consent": {"uploads": True, "usage": True}}
CONTRACT = {"schema": 1, "protocolReference": "protocol-v1", "protocolSha256": DIGEST,
            "requiredTags": {"protocol": "protocol-v1", "digest": DIGEST},
            "functions": {"separation": f"separate_{DIGEST}", "transcription": f"transcribe_{DIGEST}"},
            "qualification": {"passed": True, "protocolSha256": DIGEST, "evidenceReference": "verified-run-1"}}


def sdk_fixture(fail=False):
    calls = []
    client = object()

    async def credentials(token_id, token_secret):
        calls.append("credentials")
        assert (token_id, token_secret) == (CONFIG["tokenId"], CONFIG["tokenSecret"])
        if fail:
            raise RuntimeError(CONFIG["tokenSecret"])
        return client

    async def tags(**kwargs):
        assert kwargs == {"client": client}
        calls.append("tags")
        return CONTRACT["requiredTags"]

    async def lookup(name, **kwargs):
        assert name == CONFIG["app"]
        assert kwargs == {"client": client, "create_if_missing": False, "environment_name": "main"}
        calls.append("lookup")
        return SimpleNamespace(get_tags=SimpleNamespace(aio=tags))

    def from_name(app, name, **kwargs):
        assert app == CONFIG["app"] and name in CONTRACT["functions"].values()
        assert kwargs == {"client": client, "version": 7, "environment_name": "main"}
        calls.append("function")

        async def hydrate(**kwargs):
            assert kwargs == {"client": client}
            calls.append("hydrate")
        return SimpleNamespace(hydrate=SimpleNamespace(aio=hydrate))
    return SimpleNamespace(Client=SimpleNamespace(from_credentials=SimpleNamespace(aio=credentials)),
                           App=SimpleNamespace(lookup=SimpleNamespace(aio=lookup)),
                           Function=SimpleNamespace(from_name=from_name)), calls


class RuntimeTests(unittest.TestCase):
    def assert_disabled_without_import(self, config, contract, error):
        with patch.object(runtime.importlib, "import_module", side_effect=AssertionError("SDK import forbidden")) as load:
            descriptor = runtime.prepare_modal_runtime(config, contract)
        self.assertFalse(descriptor["enabled"])
        self.assertFalse(descriptor["publicStatus"]["ready"])
        self.assertEqual(descriptor["publicStatus"]["errorCode"], error)
        self.assertNotIn("config", descriptor)
        self.assertNotIn("functions", descriptor)
        self.assertNotIn(CONFIG["tokenSecret"], str(descriptor))
        load.assert_not_called()

    def test_both_consents_are_required_before_any_sdk_access(self):
        for consent in ({"uploads": True, "usage": False}, {"uploads": False, "usage": True},
                        {"uploads": 1, "usage": True}, None, {}):
            self.assert_disabled_without_import({**CONFIG, "consent": consent}, CONTRACT, "consent-required")

    def test_missing_qualification_and_protocol_mismatch_never_import_sdk(self):
        for qualification in (None, {}, {**CONTRACT["qualification"], "passed": False},
                              {**CONTRACT["qualification"], "protocolSha256": "b" * 64},
                              {**CONTRACT["qualification"], "evidenceReference": "/private/path"}):
            self.assert_disabled_without_import(CONFIG, {**CONTRACT, "qualification": qualification}, "release-qualification-unavailable")

    def test_invalid_config_or_contract_never_import_sdk(self):
        self.assert_disabled_without_import(None, CONTRACT, "invalid-config")
        self.assert_disabled_without_import({**CONFIG, "version": True}, CONTRACT, "invalid-config")
        self.assert_disabled_without_import(CONFIG, None, "release-contract-unavailable")
        self.assert_disabled_without_import(CONFIG, {**CONTRACT, "functions": {"separation": "unbound"}}, "release-contract-unavailable")

    def test_metadata_failure_never_enables_routing_or_exposes_credentials(self):
        sdk, calls = sdk_fixture(fail=True)
        descriptor = runtime.prepare_modal_runtime(CONFIG, CONTRACT, sdk)
        self.assertFalse(descriptor["enabled"])
        self.assertTrue(descriptor["publicStatus"]["qualified"])
        self.assertFalse(descriptor["publicStatus"]["ready"])
        self.assertNotIn(CONFIG["tokenSecret"], str(descriptor))
        self.assertEqual(calls, ["credentials"])

    def test_qualified_compatible_config_is_internal_only(self):
        sdk, calls = sdk_fixture()
        descriptor = runtime.prepare_modal_runtime(CONFIG, CONTRACT, sdk)
        self.assertTrue(descriptor["enabled"])
        self.assertEqual(descriptor["config"], CONFIG)
        self.assertEqual(descriptor["functions"], CONTRACT["functions"])
        public = descriptor["publicStatus"]
        self.assertTrue(all(public[k] for k in ("accessChecked", "compatible", "qualified", "ready")))
        self.assertNotIn(CONFIG["tokenSecret"], str(public))
        self.assertNotIn(CONFIG["tokenId"], str(public))
        self.assertEqual(calls, ["credentials", "lookup", "tags", "function", "hydrate", "function", "hydrate"])
        descriptor["config"]["consent"]["uploads"] = False
        self.assertTrue(CONFIG["consent"]["uploads"])


if __name__ == "__main__":
    unittest.main()
