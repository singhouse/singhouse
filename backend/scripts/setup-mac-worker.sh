#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Provision an Apple-Silicon (MPS) host as a remote worker for GPU-heavy steps
# (stem separation + Heart transcription), for when this box's GPU is dead.
#
# Idempotent: safe to re-run. Installs uv + a Python 3.11 venv, the ML stack,
# a bundled ffmpeg, and rsyncs the model checkpoints and runner scripts to
# ~/<DIR> on the worker. The backend activates offload via:
#
#     KARAOKE_REMOTE_HOST=user@192.168.1.50   (see remote-worker.conf drop-in)
#
# Usage:
#     backend/scripts/setup-mac-worker.sh [user@host] [remote_dir]
#     KARAOKE_REMOTE_HOST=user@192.168.1.50 backend/scripts/setup-mac-worker.sh
#
set -euo pipefail

HOST="${1:-${KARAOKE_REMOTE_HOST:-}}"
DIR="${2:-${KARAOKE_REMOTE_DIR:-karaoke-worker}}"
PY_VERSION="3.11"

if [[ -z "$HOST" ]]; then
  echo "error: pass user@host (or set KARAOKE_REMOTE_HOST)" >&2
  exit 1
fi

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
ssh_() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
rsync_() { rsync -a -e "ssh ${SSH_OPTS[*]}" "$@"; }

echo ">> [1/7] worker layout"
ssh_ "mkdir -p '$DIR'/{scripts,ckpt,work,bin}"

echo ">> [2/7] uv"
ssh_ 'command -v uv >/dev/null 2>&1 || (test -x "$HOME/.local/bin/uv") || curl -LsSf https://astral.sh/uv/install.sh | sh'

echo ">> [3/7] python $PY_VERSION venv"
ssh_ "export PATH=\"\$HOME/.local/bin:\$PATH\"; cd '$DIR' && test -x .venv/bin/python || uv venv --python $PY_VERSION .venv"

echo ">> [4/7] ML deps (torch/transformers/librosa/demucs/audio-separator + ffmpeg)"
ssh_ "export PATH=\"\$HOME/.local/bin:\$PATH\"; cd '$DIR' && uv pip install --python .venv/bin/python \
    torch torchaudio transformers librosa soundfile numpy demucs 'audio-separator[cpu]' imageio-ffmpeg"

echo ">> [5/7] bundled ffmpeg symlink"
ssh_ "cd '$DIR'; FF=\$(.venv/bin/python -c 'import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())'); ln -sf \"\$FF\" bin/ffmpeg; bin/ffmpeg -version | head -1"

echo ">> [6/7] checkpoints (rsync; ~3.8 GB first time)"
rsync_ "$BACKEND_DIR/ckpt/HeartTranscriptor-oss" "$BACKEND_DIR/ckpt/audio-separator-models" "$HOST:$DIR/ckpt/"

echo ">> [7/7] runner scripts"
rsync_ "$BACKEND_DIR/workers/remote_runtime/" "$HOST:$DIR/scripts/"

echo ">> sanity"
ssh_ "cd '$DIR'; .venv/bin/python -c 'import torch; print(\"mps:\", torch.backends.mps.is_available())'; .venv/bin/audio-separator --version; du -sh ckpt/*"
echo ">> done. Worker '$HOST:$DIR' is ready."
