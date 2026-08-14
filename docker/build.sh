#!/bin/bash
# Build a KiCad app (pcbnew, eeschema, calculator) inside Docker, then run
# the ENV shim on the host.
#
# Usage:
#   ./docker/build.sh <app>[,<app>...] [args...]
#
# Apps:
#   kicad_editor   merged PCB + schematic editor image — serves all four editors
#                  (PCB / Footprint / Schematic / Symbol) via runtime --frame
#   calculator     PCB calculator
#   pl_editor      drawing-sheet editor
#   gerbview       Gerber viewer
#   all            build all of the above
#   pcbnew         standalone PCB engine (debug aid; not deployed — kicad_editor is)
#   eeschema       standalone schematic engine (debug aid; not deployed)
#
# A comma-separated list builds just those apps in order (e.g.
# "calculator,pl_editor" — used to exercise the multi-app path cheaply).
#
# Any extra args are forwarded to scripts/kicad/build-<app>.sh (e.g. -j 8,
# --full, --release, --diag=gal).
#
# The build is split into two phases:
# 1. Docker: Compile KiCad to WASM (fully finalized; JSPI links in-container)
# 2. Host: ENV merge shim on the glue (patch-env-shim.mjs)

# Auto-launch the live progress dashboard in this terminal (handled by logging.sh,
# which owns the TTY before it re-execs us with output redirected). Set KICAD_NO_MONITOR=1
# to disable. MUST be set before sourcing logging.sh — that's where the dashboard is
# launched, in the pre-re-exec process.
export KICAD_MONITOR=1

# Redirect all output to a log file (re-execs script with redirection).
# MUST be sourced before arg parsing — the re-exec relies on the original
# "$@", so any shifts before this point would strip args from the re-exec.
source "$(dirname "$0")/../scripts/common/logging.sh"

# Build-progress markers (parsed by scripts/build-monitor.sh).
source "$(dirname "$0")/../scripts/common/stages.sh"

# Pinned toolchain version (single source of truth). Exported so the compose build.args can pass it
# into the Docker image's emsdk install — bumping the toolchain is then a one-line edit in versions.sh.
source "$(dirname "$0")/../scripts/common/versions.sh"
export EMSCRIPTEN_VERSION

set -e

# Stop the builder container when the build ends (any exit path). A lingering
# idle builder keeps the Docker Desktop VM ballooned — each project's builder
# is capped at ${KICAD_DOCKER_MEM:-32G}, and with per-worktree compose projects
# two forgotten containers once read as ~56 GB of host RAM (page cache +
# high-water ballooning). The container is pure scaffolding: all caches live in
# the named volumes and `up -d` restarts it in seconds. Set
# KICAD_KEEP_CONTAINER=1 to keep it running for interactive exec/debugging.
_COMPOSE_FILE="$(cd "$(dirname "$0")" && pwd)/docker-compose.yml"
stop_builder() {
    if [[ "${KICAD_KEEP_CONTAINER:-0}" != "1" ]]; then
        docker compose -f "${_COMPOSE_FILE}" stop >/dev/null 2>&1 || true
    fi
}

# Emit a completion/failure marker no matter how the build ends, so the monitor
# can stop on a clean "done" or show an aborted state instead of hanging.
trap '_rc=$?; if [ $_rc -eq 0 ]; then kw_done; else kw_fail $_rc; fi; stop_builder' EXIT
# On Ctrl-C, mark the build aborted so the final dashboard frame shows failed
# (not a stale "running" state). The EXIT trap above also fires; the monitor reads
# the last marker, so the duplicate is harmless.
trap 'kw_fail 130; exit 130' INT TERM

cd "$(dirname "$0")/.."

VALID_APPS="kicad_editor | pcbnew | eeschema | calculator | pl_editor | gerbview | kicad_tools | occ_service | ngspice_service | all"

usage() {
    echo "Usage: ./docker/build.sh <app>[,<app>...] [args...]" >&2
    echo "  <app>: ${VALID_APPS}" >&2
    echo "  args:  forwarded to scripts/kicad/build-<app>.sh (e.g. -j 8, --release)" >&2
}

# First positional arg must be the app name. No default — picking one would
# silently build the wrong thing for someone who forgot the argument.
if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi
if [[ $# -lt 1 ]] || [[ "$1" == -* ]]; then
    echo "Error: missing <app> argument" >&2
    usage
    exit 1
fi
APP_NAME="$1"
shift

# Expand the app argument into APPS[]: "all", a single app, or a comma list.
# kicad_editor first in "all" — the merged image is the deployed bundle and the
# longest compile, so it starts first and surfaces failures earliest.
# pcbnew/eeschema stay buildable as standalone debug aids but are not part of
# "all" (not deployed). kicad_tools joined "all" for the runner-image CI
# (tasks-runner 0001 R2).
if [[ "$APP_NAME" == "all" ]]; then
    APPS=(kicad_editor occ_service ngspice_service calculator pl_editor gerbview kicad_tools)
else
    IFS=',' read -r -a APPS <<< "$APP_NAME"
    for app in "${APPS[@]}"; do
        case "$app" in
            kicad_editor|pcbnew|eeschema|calculator|pl_editor|gerbview|kicad_tools|occ_service|ngspice_service) ;;
            *)
                echo "Error: unknown app '$app' (expected: ${VALID_APPS})" >&2
                usage
                exit 1
                ;;
        esac
    done
fi

# Use branch name as Docker Compose project name for isolated containers/volumes.
# Honor a pre-set COMPOSE_PROJECT_NAME so a build can target an existing volume
# (e.g. reuse another branch's already-provisioned deps).
BRANCH_NAME=$(git rev-parse --abbrev-ref HEAD | tr '/' '-' | tr '[:upper:]' '[:lower:]')
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-kicad-wasm-${BRANCH_NAME}}"
echo "Using Docker project: ${COMPOSE_PROJECT_NAME}"
echo "Building app: ${APP_NAME}"

# Build phase (cache split). The container compile emits the finalized wasm;
# the host tail is only the ENV merge shim on the glue. Splitting compile and
# postprocess lets CI cache the expensive compile once and re-run just the
# host tail — see .github/workflows/.
#   (default) both       — compile in-container, then host post-process.
#   --compile-only       — only the in-container compile → wasm+glue in output/.
#   --postprocess-only   — only the host post-process (ENV merge shim) on the
#                          existing output/ glue; NO container needed.
# Extracted here so they are NOT forwarded to the inner build-<app>.sh scripts.
PHASE="both"
_FILTERED=()
for _arg in "$@"; do
    case "$_arg" in
        --compile-only)     PHASE="compile" ;;
        --postprocess-only) PHASE="postprocess" ;;
        *) _FILTERED+=("$_arg") ;;
    esac
done
set -- "${_FILTERED[@]+"${_FILTERED[@]}"}"

# Add -j 10 by default if no -j flag is given
ARGS=("$@")
if [[ ! " ${ARGS[*]} " =~ " -j " ]]; then
    ARGS+=("-j" "10")
fi

# Container compile + source sync — skipped entirely for --postprocess-only,
# which is pure host work on the already-built base wasm in output/.
if [[ "$PHASE" != "postprocess" ]]; then

# Start container if not running. --build so the image is rebuilt when the pinned EMSCRIPTEN_VERSION
# (build-arg from versions.sh) changes; Docker layer-caches it to a near no-op when unchanged.
docker compose -f docker/docker-compose.yml up -d --build

# Sync source code to container volume (fixes macOS Docker VirtioFS issues)
# Use --checksum to only transfer files with different CONTENT, not timestamps.
# This avoids the timestamp mismatch cycle that caused full rebuilds every time.
# Transferred files get current container time, so make detects them correctly.
kw_stage container-sync
# Re-seed the emscripten ports cache from the persistent volume: /emsdk lives
# in the container layer, so any image-context edit recreates the container
# and wipes the cache — and the in-container github fetch is flaky. Seeds are
# staged once into the kicad-build-cache volume (emcache/ports); this copy
# survives every recreation. No-op when the staging dir is absent.
docker compose -f docker/docker-compose.yml exec kicad-wasm-builder bash -c \
    'if [ -d /workspace/build-wasm/emcache/ports ]; then \
        mkdir -p /emsdk/upstream/emscripten/cache/ports && \
        cp -a /workspace/build-wasm/emcache/ports/. /emsdk/upstream/emscripten/cache/ports/ && \
        echo "seeded emscripten ports cache from volume"; fi' || true
echo "Syncing source code to container..."
# rsync into the macOS-backed volume intermittently hits transient VirtioFS glitches:
# temp-file rename failures (exit 23) or vanished-source files (exit 24, harmless).
# --inplace avoids the temp-file+rename pattern that triggers exit 23; retry up to 3x
# for any residual flakiness (--checksum makes each retry skip already-synced files).
sync_rc=0
for sync_attempt in 1 2 3; do
    if docker compose -f docker/docker-compose.yml exec kicad-wasm-builder \
        rsync -r --delete --checksum --inplace \
            --exclude="build-wasm" \
            --exclude="output" \
            --exclude=".git" \
            --exclude="logs" \
            --exclude=".idea" \
            --exclude="node_modules" \
            --exclude="tools/emsdk" \
            /workspace-host/ /workspace/
    then
        sync_rc=0
    else
        sync_rc=$?
    fi
    { [ $sync_rc -eq 0 ] || [ $sync_rc -eq 24 ]; } && break
    echo "rsync attempt ${sync_attempt} failed (exit ${sync_rc}); retrying in 2s..."
    sleep 2
done
if [ $sync_rc -ne 0 ] && [ $sync_rc -ne 24 ]; then
    echo "ERROR: source sync failed after retries (exit ${sync_rc})"; exit 1
fi

fi  # end: container compile + sync guard ("$PHASE" != postprocess)

# Map an app name to its inner CMake build subdirectory. Most apps share their
# subdir name with the app name; pcb_calculator emits OUTPUT_NAME=calculator
# but lives under the pcb_calculator/ subtree.
kicad_subdir_for() {
    case "$1" in
        calculator)       echo "pcb_calculator" ;;
        pl_editor)        echo "pagelayout_editor" ;;
        *)                echo "$1" ;;
    esac
}

# Phase 1 of one app: compile in the container and copy the output to ./output.
# Args: <app> [index] [total] — index/total drive the monitor's app counter.
compile_app() {
    local app="$1"
    local index="${2:-1}"
    local total="${3:-1}"
    local subdir
    subdir=$(kicad_subdir_for "$app")
    kw_app "$app" "$index" "$total"
    echo ""
    echo "=== Building ${app} (${index}/${total}) ==="

    local out_dir="output"
    local kicad_build="kicad-${app}"

    # Run build inside the container.
    # -e EMSDK=/emsdk: `docker compose exec` bypasses the entrypoint that sources
    # emsdk_env.sh, so the build shell would lack emcc/embuilder on PATH. Setting
    # EMSDK lets scripts/common/env.sh source /emsdk/emsdk_env.sh and activate the toolchain.
    # BUILD_3D_VIEWER passes through EMPTY when the host didn't set it, so
    # build-kicad-target.sh can apply per-app defaults (ON for editors, OFF
    # for headless CLIs like kicad_tools — the gl1 shim needs glm).
    docker compose -f docker/docker-compose.yml exec -e EMSDK=/emsdk \
        -e BUILD_3D_VIEWER="${BUILD_3D_VIEWER:-}" \
        kicad-wasm-builder \
        "/workspace/scripts/kicad/build-${app}.sh" "${ARGS[@]}"

    # Copy output to host-accessible directory.
    # ${app}.wasm.debug.wasm contains DWARF debug info (when built with -gseparate-dwarf).
    kw_stage copy-output
    echo "Copying ${app} build output to ./${out_dir}/..."
    docker compose -f docker/docker-compose.yml exec kicad-wasm-builder \
        bash -c "mkdir -p /workspace/${out_dir} && \
            cp /workspace/build-wasm/${kicad_build}/${subdir}/${app}.{js,wasm,wasm.debug.wasm,wasm.map,worker.js} /workspace/${out_dir}/ 2>/dev/null || \
            cp /workspace/build-wasm/${kicad_build}/${subdir}/${app}.{js,wasm} /workspace/${out_dir}/; \
            cp /workspace/build-wasm/${kicad_build}/resources/images.tar.gz /workspace/${out_dir}/ 2>/dev/null || true; \
            cp /workspace/wxwidgets/build/wasm/wx.js /workspace/${out_dir}/ 2>/dev/null || true; \
            cp /workspace/wxwidgets/build/wasm/wx-dom.js /workspace/${out_dir}/ 2>/dev/null || true"

    # The container runs as root, so files in the bind-mounted ./output land
    # root-owned on the host. macOS Docker Desktop remaps ownership to the host
    # user, but on a Linux CI runner the host-side ENV-shim step can't write
    # into ./output. Hand ownership back.
    docker compose -f docker/docker-compose.yml exec kicad-wasm-builder \
        chown -R "$(id -u):$(id -g)" /workspace/output || true
}

# Phase 2 of one app: host-side post-processing (ENV merge shim). Pure host
# work on output/${app}.js — no container needed.
postprocess_app() {
    local app="$1"
    local out_dir="output"

    # The headless CLI and the OCC/ngspice services skip the ENV merge shim:
    # it exists for the interactive apps' runtime env overrides (?trace=),
    # which these targets never read.
    if [ "$app" = "kicad_tools" ] || [ "$app" = "occ_service" ] || [ "$app" = "ngspice_service" ]; then
        echo "Skipping host post-processing for ${app} (finalized in-container)"
        return 0
    fi

    # ENV merge shim: the emscripten glue never merges Module.ENV into the
    # runtime ENV (?trace= would be a silent no-op — see docs/features/libs/0013).
    kw_stage env-shim
    node ./scripts/common/patch-env-shim.mjs "${out_dir}/${app}.js"
}

TOTAL_APPS="${#APPS[@]}"

if [[ "$PHASE" == "compile" ]]; then
    # --compile-only: produce the wasm+glue in output/; no host post-process.
    idx=1
    for app in "${APPS[@]}"; do
        compile_app "$app" "$idx" "$TOTAL_APPS"
        idx=$((idx + 1))
    done
elif [[ "$PHASE" == "postprocess" ]]; then
    # --postprocess-only: pure host post-process on the existing output/ glue
    # (no container).
    for app in "${APPS[@]}"; do
        postprocess_app "$app"
    done
else
    # both, sequential.
    idx=1
    for app in "${APPS[@]}"; do
        compile_app "$app" "$idx" "$TOTAL_APPS"
        postprocess_app "$app"
        idx=$((idx + 1))
    done
fi

echo ""
echo "Build complete. Output files in ./output/"
ls -lh output/
