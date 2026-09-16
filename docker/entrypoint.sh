#!/bin/bash
set -e

# Source Emscripten environment
source /emsdk/emsdk_env.sh 2>/dev/null

# Sync source from host to workspace volume
# This fixes macOS Docker timestamp issues with bind mounts
# (autoconf sanity checks fail when timestamps appear inconsistent)
# Touch transferred files to set container timestamps for correct make detection
# Automated builds perform their own checksum-based sync after startup. Do not
# race that sync (or compilation) with a second, timestamp-based background copy.
if [[ "${KICAD_SKIP_ENTRYPOINT_SYNC:-0}" != "1" && -d /workspace-host ]]; then
    echo "Syncing source code to container volume..."
    rsync -ai --delete \
        --exclude='build-wasm' \
        --exclude='output' \
        --exclude='tools/emsdk' \
        /workspace-host/ /workspace/ | \
        grep "^>f" | \
        sed "s/^[^ ]* //" | \
        while read f; do touch "/workspace/$f" 2>/dev/null; done
    echo "Sync complete."
fi

# Execute command or start shell
exec "$@"
