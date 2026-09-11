# SPDX-License-Identifier: AGPL-3.0-only
"""Modal-hosted OpenAI-compatible LLM endpoint for lyric correction.

Serves the same Qwen3.6-35B-A3B the Mac mini runs — but the official FP8
checkpoint on an H100 via vLLM, so a region call that takes 3-9 min of
thinking on the M2 finishes in ~20-40 s. The lyricsync correction client
speaks OpenAI chat completions, so switching between the Mac and this is
purely `KARAOKE_LLM_BASE_URL`/`KARAOKE_LLM_MODEL`/`KARAOKE_LLM_API_KEY`.

Deploy / use:
    cd backend && .venv/bin/modal deploy modal_llm.py
    # endpoint prints as https://<workspace>--karaoke-llm-serve.modal.run
    KARAOKE_LLM_BASE_URL=https://…modal.run/v1 \
    KARAOKE_LLM_MODEL=Qwen/Qwen3.6-35B-A3B-FP8 \
    KARAOKE_LLM_API_KEY=$(cat ~/.config/karaoke/modal-llm-token) …

Cost control: the container scales to zero after ``SCALEDOWN`` idle seconds
and cold-boots in ~3-5 min (weights cached in a modal.Volume after the
first boot). The bearer token (auto-generated into
``~/.config/karaoke/modal-llm-token``, chmod 600, never committed) keeps
random internet traffic from burning GPU-hours on the public URL.
"""

import secrets
import subprocess
from pathlib import Path

import modal

APP_NAME = "karaoke-llm"
MODEL_NAME = "Qwen/Qwen3.6-35B-A3B-FP8"
PORT = 8000
MAX_MODEL_LEN = 32768          # region prompts are ~2k + a few k of thinking
SCALEDOWN = 15 * 60

TOKEN_FILE = Path.home() / ".config" / "karaoke" / "modal-llm-token"


def _local_token() -> str:
    """Bearer token shared by the server and callers; generated once."""
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(token + "\n")
    TOKEN_FILE.chmod(0o600)
    return token


app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm>=0.19.0", "huggingface_hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

hf_cache = modal.Volume.from_name(f"{APP_NAME}-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name(f"{APP_NAME}-vllm-cache", create_if_missing=True)


@app.function(
    image=image,
    gpu="H100",
    timeout=60 * 60,
    scaledown_window=SCALEDOWN,
    volumes={
        "/root/.cache/huggingface": hf_cache,
        "/root/.cache/vllm": vllm_cache,
    },
    secrets=[modal.Secret.from_dict({"VLLM_API_KEY": _local_token()})],
)
@modal.concurrent(max_inputs=8)
@modal.web_server(port=PORT, startup_timeout=20 * 60)
def serve():
    import os

    cmd = [
        "vllm", "serve", MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--max-model-len", str(MAX_MODEL_LEN),
        # Splits Qwen's thinking into reasoning_content; message.content
        # stays clean JSON for the correction client.
        "--reasoning-parser", "qwen3",
        "--api-key", os.environ["VLLM_API_KEY"],
    ]
    subprocess.Popen(cmd)
