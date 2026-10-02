# Deploy processing to your own Modal account

The source-install backend can send stem separation and Heart transcription
jobs to a Modal app that you deploy and pay for in your own account. This path
is optional and off by default. singhouse does not provide a shared Modal
deployment, receive the audio, or manage your Modal account.

Desktop setup can save credentials using operating-system encryption and check
account/deployment metadata without uploading audio or invoking processing.
This check distinguishes account access from deployment compatibility; it does
not qualify inference or enable cloud processing. A missing desktop deployment
contract is reported as unverified. Exporting environment variables before
opening the desktop app does not enable Modal processing.

The deployment and processing instructions below apply to a source checkout
with the `modal` extra. The source deployment is not yet a qualified desktop
deployment. Do not deploy it solely to clear a desktop setup warning.

Deploying builds a remote image and can create billable work. Review Modal's
current pricing and account limits before running a deploy or a job. The setup
below does not require changing singhouse's local-processing configuration.

## Install and authenticate the CLI

Use Python 3.12 or newer to create an environment for the deploy tool, install
the backend's Modal extra, and authenticate the CLI with your Modal account:

```sh
python3 -m venv .venv-modal
. .venv-modal/bin/activate
python -m pip install -e './backend[modal]'
modal setup
```

You can use `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` instead of the interactive
setup when your environment already manages those credentials. Keep both out of
the repository and out of frontend configuration.

## Deploy GPU separation and transcription

Run the deploy from the repository root:

```sh
KARAOKE_MODAL_APP=karaoke-gpu \
KARAOKE_MODAL_GPU=T4 \
KARAOKE_MODEL=mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt \
modal deploy backend/modal_app.py
```

These three variables are read by the local `modal deploy` process. It does not
load `backend/.env`.

| Variable | Default | Effect at deploy time |
|---|---|---|
| `KARAOKE_MODAL_APP` | `karaoke-gpu` | Names the Modal app. The backend must call the same name. |
| `KARAOKE_MODAL_GPU` | `T4` | Selects the GPU class and is the main cost control. Use a class available to your account. |
| `KARAOKE_MODEL` | `mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt` | Selects the default second-pass separation model baked into the image. |

The build downloads the Heart checkpoint, Demucs `mdx_extra`, and the configured
audio-separator models into the remote image. Those downloads are initiated by
you and remain subject to their upstream terms. Re-run the deploy after changing
the app name, GPU class, model, dependencies, or deploy script.

Configure the singhouse backend separately:

```sh
export KARAOKE_MODAL=1
export KARAOKE_MODAL_APP=karaoke-gpu
```

`KARAOKE_MODAL` is the run-time switch. `KARAOKE_MODAL_APP` must exactly match
the deployed app name. The backend process also needs access to your Modal
credentials. `KARAOKE_MODAL_GPU` and `KARAOKE_MODEL` do not reconfigure an
already deployed image when they are placed only in `backend/.env`.

For each offloaded job, the backend sends the imported audio to your Modal app.
The app returns separated stems and Heart transcription results; singhouse then
stores and processes them on the local machine. Disable offload by removing
`KARAOKE_MODAL` or setting it to a value other than `1`, `true`, `yes`, or `on`.

## Optional OpenAI-compatible LLM endpoint

`backend/modal_llm.py` is a separate, high-cost example that serves the named
Qwen model through vLLM on an H100. It is not required for Modal separation or
transcription. Deploy it only after reviewing the model terms, GPU cost, and the
fact that lyric text is sent to that endpoint:

```sh
cd backend
../.venv-modal/bin/modal deploy modal_llm.py
```

The deploy script creates two persistent Modal volumes for model caches and
generates a bearer token in `~/.config/karaoke/modal-llm-token` with mode `0600`.
It injects that value into the remote container as `VLLM_API_KEY`; you do not set
`VLLM_API_KEY` in `backend/.env` or in the deploy shell.

After deployment, point the backend at the printed HTTPS endpoint:

```sh
export KARAOKE_LLM_BASE_URL='https://your-workspace--karaoke-llm-serve.modal.run/v1'
export KARAOKE_LLM_MODEL='Qwen/Qwen3.6-35B-A3B-FP8'
export KARAOKE_LLM_API_KEY_FILE="$HOME/.config/karaoke/modal-llm-token"
```

The endpoint scales to zero after 15 idle minutes, but persistent volumes and
GPU execution may still incur charges under your Modal plan. Deleting or
redeploying resources is an account operation; use Modal's dashboard or current
CLI documentation to inspect the resources in your account before changing them.
