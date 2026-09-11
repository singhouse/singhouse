#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Sweep whisper models × ref modes for Drive, then report.
# Run from repo root with backend venv active.
set -euo pipefail

cd "$(dirname "$0")/../.."
RUNS=lyricsync/scripts/runs
# Repo-root-relative path to the reference word-sync JSON; the private eval
# layout sets LYRICSYNC_REF to its own convention.
REF="${LYRICSYNC_REF:-reference_word_data.json}"
mkdir -p "$RUNS"

CONFIGS=(
  "base synced"
  "base plain"
  "base none"
  "large-v3-turbo synced"
  "large-v3-turbo plain"
  "large-v3-turbo none"
  "large-v3 synced"
  "large-v3 plain"
)

for cfg in "${CONFIGS[@]}"; do
  read -r model ref <<<"$cfg"
  out="$RUNS/${model}-${ref}.json"
  if [[ -s "$out" ]]; then
    echo "skip (exists): $out"
  else
    echo "=== run: $model / $ref ==="
    python lyricsync/scripts/run_drive.py "$model" "$ref" -o "$out"
  fi
done

echo
echo "=== eval ==="
for cfg in "${CONFIGS[@]}"; do
  read -r model ref <<<"$cfg"
  out="$RUNS/${model}-${ref}.json"
  [[ -s "$out" ]] && python lyricsync/scripts/eval.py "$REF" "$out" --label "${model}+${ref}"
done
