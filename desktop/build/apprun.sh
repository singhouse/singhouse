#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

# Resolve our own location, not an inherited APPDIR. exec preserves the outer
# AppImage runtime ancestry used to authenticate the stable recovery launcher.
app_dir=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd -P)
for argument do
  case "$argument" in
    --no-sandbox|--no-sandbox=*|--disable-sandbox|--disable-sandbox=*|--disable-*-sandbox|--disable-*-sandbox=*|--single-process|--single-process=*|--in-process-gpu|--in-process-gpu=*)
      echo "singhouse requires Electron sandboxing; sandbox bypass arguments are not supported." >&2
      exit 1
      ;;
  esac
done

# Let Electron check the actual host sandbox facilities. Never retry without
# sandboxing or change host settings when namespaces or the helper are blocked.
export LD_LIBRARY_PATH="$app_dir/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Keep arguments unchanged: the authenticated recovery entrypoint parses them
# exactly. Both application windows require sandbox:true, also Electron's default.
exec "$app_dir/Singhouse" "$@"
