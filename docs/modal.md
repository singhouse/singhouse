# Processing on Your Own Modal Account

When running Singhouse from source (or as a self-hosted server), you can offload GPU stem separation and Heart transcription to a [Modal](https://modal.com) app deployed inside **your own Modal account**.

* **Opt-in & User-Owned:** Offloading is off by default. Singhouse does not operate a shared cloud service, receive your audio, or manage your Modal billing.
* **Source/Server Only:** The instructions below apply to source checkouts with the `modal` extra installed (`./backend[modal]`). In packaged desktop builds, cloud processing remains disabled until a qualified desktop deployment contract is enabled.
* **Billing Note:** Deploying builds a remote container image and runs GPU workloads on your Modal account. Check Modal's pricing and your workspace limits before deploying.

---

## 1. Install and Authenticate the Modal CLI

Create a Python 3.12+ virtual environment, install the backend with the `modal` extra, and authenticate with your Modal account:

```sh
python3 -m venv .venv-modal
source .venv-modal/bin/activate
python -m pip install -e './backend[modal]'
modal setup
```

*(If you manage credentials via environment variables, you can provide `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` instead of running `modal setup`. Keep both out of version control and frontend configs.)*

## 2. Deploy the GPU Separation & Transcription App

From the repository root, deploy `backend/modal_app.py`:

```sh
KARAOKE_MODAL_APP=karaoke-gpu \
KARAOKE_MODAL_GPU=T4 \
KARAOKE_MODEL=mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt \
modal deploy backend/modal_app.py
```

These environment variables are read by `modal deploy` at build time (it does not read `backend/.env`):

| Variable | Default | Effect at Deploy Time |
| --- | --- | --- |
| `KARAOKE_MODAL_APP` | `karaoke-gpu` | Names the Modal app in your workspace. |
| `KARAOKE_MODAL_GPU` | `T4` | Selects the Modal GPU class (primary cost/speed lever). |
| `KARAOKE_MODEL` | `mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt` | Default Pass-2 backing-vocal separation model baked into the container image. |

During image build, your Modal container downloads the `HeartTranscriptor` checkpoint, Demucs `mdx_extra`, and the configured `audio-separator` weights directly from their upstreams. Re-run `modal deploy` whenever you change the app name, GPU class, model, or `modal_app.py`.

## 3. Enable Modal Offload in the Backend

Configure your Singhouse backend environment (`.env` or service environment) to route jobs to your deployed Modal app:

```sh
export KARAOKE_MODAL=1
export KARAOKE_MODAL_APP=karaoke-gpu
```

Ensure the backend process has access to your Modal credentials (`~/.modal.toml` or `MODAL_TOKEN_*`).

**How it works at runtime:**

1. When a song is imported, the backend sends the audio to your Modal app.
2. Your Modal container runs Pass-1 (Demucs) and Pass-2 (RoFormer) separation plus Heart transcription, returning the stems and transcript.
3. The local backend mixes the final stems with FFmpeg, runs local word alignment (and local CTC acoustic re-timing if a local CUDA environment is present), and saves the result.

To disable cloud offload at any time, unset `KARAOKE_MODAL` (or set it to `0`/`false`).

---

## 4. Optional: OpenAI-Compatible LLM Endpoint for Lyric Paging

Regular word alignment and lyric display require no LLM. However, Singhouse supports optional LLM-assisted page grouping (`llm_paging`) using any OpenAI-compatible `/v1/chat/completions` endpoint.

### Option A: Use an Existing Local or Remote OpenAI-Compatible Endpoint

Point the backend at your endpoint in `backend/.env` and restart the server:

```sh
export KARAOKE_LLM_BASE_URL='http://localhost:11434/v1'   # e.g., Ollama, vLLM, or OpenAI-compatible API
export KARAOKE_LLM_MODEL='local'
export KARAOKE_LLM_TIMEOUT='600'
# Optional auth (KARAOKE_LLM_API_KEY takes precedence over _FILE):
export KARAOKE_LLM_API_KEY_FILE="$HOME/.config/karaoke/llm-token"
```

### Option B: Deploy the Example vLLM App on Modal (High Cost)

`backend/modal_llm.py` is an optional example script that serves `Qwen/Qwen3.6-35B-A3B-FP8` via vLLM on an H100 GPU. **Review H100 pricing and persistent volume costs before deploying:**

```sh
cd backend
../.venv-modal/bin/modal deploy modal_llm.py
```

The deploy script creates two persistent Modal volumes for model caching and writes a `0600` bearer token to `~/.config/karaoke/modal-llm-token` (injected remotely as `VLLM_API_KEY`). Point your backend at the deployed URL:

```sh
export KARAOKE_LLM_BASE_URL='https://your-workspace--karaoke-llm-serve.modal.run/v1'
export KARAOKE_LLM_MODEL='Qwen/Qwen3.6-35B-A3B-FP8'
export KARAOKE_LLM_API_KEY_FILE="$HOME/.config/karaoke/modal-llm-token"
```

When valid LLM settings are configured, `/api/features` reports `llm_paging: true` and paging controls appear in the UI. If an endpoint fails during ingest, Singhouse falls back to standard lyric paging automatically.
