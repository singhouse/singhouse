# SPDX-License-Identifier: AGPL-3.0-only
"""The desktop parent owns the optional lookup preference; no network calls."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from starlette.requests import Request

spec = importlib.util.spec_from_file_location("desktop_backend", Path(__file__).parents[1] / "backend.py")
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class LyricsLookupTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, value, token="parent-secret", raw=False):
        body = value if raw else json.dumps(value).encode()
        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}
        request = Request({"type": "http", "method": "POST", "path": "/desktop-lyrics-lookup",
                           "headers": [(b"x-singhouse-desktop-token", token.encode())]}, receive)
        return await backend.desktop_lyrics_lookup_endpoint("parent-secret")(request)

    async def test_only_parent_can_change_lookup(self):
        with patch.dict(os.environ, {"KARAOKE_LRCLIB": "0"}):
            for token in ("", "session-cookie", "wrong-token"):
                response = await self.invoke({"enabled": True}, token)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(os.environ["KARAOKE_LRCLIB"], "0")
            for enabled in (True, False):
                response = await self.invoke({"enabled": enabled})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(json.loads(response.body), {"enabled": enabled})
                self.assertEqual(os.environ["KARAOKE_LRCLIB"], "1" if enabled else "0")

    async def test_invalid_preferences_never_enable_lookup(self):
        with patch.dict(os.environ, {"KARAOKE_LRCLIB": "0"}):
            for value in ({}, [], None, {"enabled": 1}, {"enabled": "true"},
                          {"enabled": True, "other": True}):
                self.assertEqual((await self.invoke(value)).status_code, 400)
                self.assertEqual(os.environ["KARAOKE_LRCLIB"], "0")
            self.assertEqual((await self.invoke(b"invalid", raw=True)).status_code, 400)


if __name__ == "__main__":
    unittest.main()
