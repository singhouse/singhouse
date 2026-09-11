# SPDX-License-Identifier: MIT
"""Minimal OpenAI-chat-completions client (stdlib only).

Speaks ``POST {base_url}/chat/completions`` so a local llama-server or
ollama and any hosted OpenAI-compatible endpoint are interchangeable via
config. Deliberately urllib rather than a new HTTP dependency: correction
runs serially in a background job, needs no streaming, and every failure
collapses to one exception the caller treats as "fall back to heuristic".
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)


class CorrectionUnavailable(Exception):
    """The endpoint could not produce a usable completion (transport/HTTP
    error, timeout, or malformed envelope). Never fatal to the sync job."""


class OpenAIChatClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: float = 120.0,
    ):
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    def complete_json(self, system: str, user: str) -> str:
        """One non-streaming completion; returns message content.

        ``response_format`` is omitted: thinking models (Qwen3.8 etc.)
        conflict with it and hang until timeout. The prompts already
        instruct JSON-only output and the validators catch anything else.
        """
        body = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(
            self.url, data=json.dumps(body).encode("utf-8"), headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.load(resp)
            return data["choices"][0]["message"]["content"]
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise CorrectionUnavailable(f"endpoint unreachable: {e}") from e
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
            raise CorrectionUnavailable(f"malformed completion envelope: {e}") from e
