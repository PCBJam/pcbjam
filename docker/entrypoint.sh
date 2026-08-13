#!/bin/bash
set -e

# Source Emscripten environment
source /emsdk/emsdk_env.sh 2>/dev/null

# Sync source from host to workspace volume
# This fixes macOS Docker timestamp issues with bind mounts
# (autoconf sanity checks fail when timestamps appear inconsistent)
# Touch transferred files to set container timestamps for correct make detection
SYNC_READY_FILE=/tmp/kicad-source-sync-ready
rm -f "$SYNC_READY_FILE"

if [[ -d /workspace-host ]]; then
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

# docker compose reports the container as running before this entrypoint sync
# finishes. Store this container start's PID-1 start tick, not just an empty
# marker: /tmp survives a container restart, so an old file must not release a
# second rsync before the restarted entrypoint finishes its first one.
awk '{ print $22 }' /proc/1/stat > "$SYNC_READY_FILE"

# Execute command or start shell
exec "$@"
