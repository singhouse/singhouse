#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Transcriber-isolation sweep: each backend with ref=none, so we measure
# transcription quality independent of alignment.
set -euo pipefail
cd "$(dirname "$0")/../.."
RUNS=lyricsync/scripts/runs
# Repo-root-relative path to the reference word-sync JSON; the private eval
# layout sets LYRICSYNC_REF to its own convention.
REF="${LYRICSYNC_REF:-reference_word_data.json}"
mkdir -p "$RUNS"

MODELS=(base large-v3-turbo large-v3 heart)

for model in "${MODELS[@]}"; do
  out="$RUNS/${model}-none.json"
  if [[ -s "$out" ]]; then
    echo "skip (exists): $out"
  else
    echo "=== run: $model / none ==="
    python lyricsync/scripts/run_drive.py "$model" none -o "$out"
  fi
done

echo
echo "=== eval ==="
for model in "${MODELS[@]}"; do
  out="$RUNS/${model}-none.json"
  [[ -s "$out" ]] && python lyricsync/scripts/eval.py "$REF" "$out" --label "${model}"
done
