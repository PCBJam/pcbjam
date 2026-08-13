#!/bin/bash
# Build a KiCad app (pcbnew, eeschema, calculator) inside Docker, then run
# asyncify and friends on the host.
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
# "calculator,pl_editor" — used to exercise the multi-app pipeline cheaply).
#
# Any extra args are forwarded to scripts/kicad/build-<app>.sh (e.g. -j 8,
# --full, --release, --diag=gal).
#
# The build is split into two phases:
# 1. Docker: Compile KiCad to WASM (without asyncify)
# 2. Host: dyncall shims + finalize + asyncify + wasm-opt -O1 (Binaryen submodule via build-wasm-opt.sh)
#
# KICAD_PIPELINE=1 (multi-app builds only): run phase 2 of each app in the
# background while the next app compiles in the container. wasm-opt is
# Amdahl-capped at ~4 effective cores, so on a many-core CI box the container
# would otherwise sit idle for the 1-2h of host-side wasm-opt (run 27226030304:
# 103 min of the 4h was tools serialized behind each other's wasm-opt). At most
# KICAD_PIPELINE_JOBS (default 2) postprocesses run concurrently — pcbnew's wasm-opt
# pass peaks ~34 GB RSS, so 2 fits the 128 GB CI box but NOT a dev Mac: leave
# KICAD_PIPELINE unset locally.
#
# Binaryen is downloaded automatically - no prerequisites needed.

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
# kicad_editor first in "all" — the merged image is the largest bundle, so its
# host-side wasm-opt chain is the critical path and must start as early as
# possible (especially with KICAD_PIPELINE=1). pcbnew/eeschema stay buildable as
# standalone debug aids but are not part of "all" (not deployed).
# kicad_tools joined "all" for the runner-image CI (tasks-runner 0001 R2) —
# it finalizes in-container (no host wasm-opt tail), so it never contends
# with the editor's critical path.
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

# Build phase (cache split). The container compile produces an OPT-INDEPENDENT
# base wasm; the only opt-DEPENDENT work is the final `wasm-opt -O$LEVEL` shrink
# inside the host post-process (apply-asyncify.sh). Splitting them lets CI cache
# the expensive compile once (shared regardless of the asyncify tail) and re-run just the
# asyncify/-O tail per opt level — see .github/workflows/.
#   (default) both       — compile in-container, then host post-process.
#   --compile-only       — only the in-container compile → base wasm in output/.
#   --postprocess-only   — only the host post-process (dyncall + finalize +
#                          asyncify + wasm-opt -O$BINARYEN_OPT_LEVEL) on the
#                          existing output/ base wasm; NO container needed
#                          (build-wasm-opt.sh self-provisions the Binaryen submodule).
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

# The entrypoint also initializes the named source volume. Compose returns as
# soon as the container starts, so wait for that exact container start's first
# sync before running the checksum sync below. The marker contains PID 1's
# start tick because /tmp survives a restart and may contain the previous
# start's marker. Without this handshake the two rsync processes can overwrite
# generated autotools files while wxWidgets is configuring.
docker compose -f docker/docker-compose.yml exec -T kicad-wasm-builder \
    timeout 120 bash -c \
    'read -r -a pid_stat < /proc/1/stat; start=${pid_stat[21]}; \
     until [ "$(cat /tmp/kicad-source-sync-ready 2>/dev/null)" = "$start" ]; \
     do sleep 0.1; done'

# Sync source code to container volume (fixes macOS Docker VirtioFS issues)
# Use --checksum to only transfer files with different CONTENT, not timestamps.
# This avoids the timestamp mismatch cycle that caused full rebuilds every time.
# Transferred files get current container time, so make detects them correctly.
kw_stage container-sync
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
    # user, but on a Linux CI runner the following host-side steps (dyncall,
    # finalize, asyncify) can't write into ./output. Hand ownership back.
    docker compose -f docker/docker-compose.yml exec kicad-wasm-builder \
        chown -R "$(id -u):$(id -g)" /workspace/output || true
}

# Phase 2 of one app: host-side post-processing (dyncall shims, finalize,
# asyncify + wasm-opt -O1). Pure host work on output/${app}.* — independent of the
# container, which is what makes it safe to run in the background while the
# next app compiles.
postprocess_app() {
    local app="$1"
    local out_dir="output"

    # The headless CLI and the OCC/ngspice services are finalized in-container
    # (real tools, small -g0 wasm) and build with ASYNCIFY=0, so they need no
    # host post-processing (no dyncall shims, no finalize, no asyncify).
    if [ "$app" = "kicad_tools" ] || [ "$app" = "occ_service" ] || [ "$app" = "ngspice_service" ]; then
        echo "Skipping host post-processing for ${app} (finalized in-container)"
        return 0
    fi

    # Inject dynCall shims (fixes "dynCall_* is not defined" errors in Emscripten 4.x)
    kw_stage dyncall-shims
    ./scripts/common/inject-dyncall-shims.sh "${out_dir}/${app}.js"

    # Merge Module.ENV into the runtime ENV: the emscripten glue never merges it,
    # so ?trace= (boot.ts sets Module.ENV.KICAD_TRACE) was a silent no-op —
    # environ_get on the app pthread proxies to the main thread, whose ENV stayed
    # empty. Replaces a manual per-build glue edit. Idempotent; runtime no-op when
    # Module.ENV is unset. See docs/features/libs/0013.
    node ./scripts/common/patch-env-shim.mjs "${out_dir}/${app}.js"

    # Apply wasm-emscripten-finalize on host (skipped in Docker due to memory limits)
    kw_stage finalize
    ./scripts/common/apply-finalize.sh "${out_dir}/${app}.wasm" "${out_dir}/${app}.wasm"

    # Apply asyncify transformation on host (the ASYNCIFY=0 CLIs returned
    # early above and never reach this).
    # apply-asyncify always runs the --hoist-cpp-catches pass FIRST (native wasm-EH is the only build
    # mode) so Asyncify can suspend from inside C++ catch arms, then asyncify + removelist + wasm-opt -O1.
    kw_stage asyncify
    ./scripts/common/apply-asyncify.sh "${out_dir}/${app}.wasm" "${out_dir}/${app}.wasm"
}

# --- Pipelined driver state (KICAD_PIPELINE=1) ---
# One background postprocess per app; logs + rc files land in logs/build/ so the
# interleaved output stays readable and failures survive until the final wait.
PIPELINE_PIDS=()
PIPELINE_APPS_BG=()
PIPELINE_LOG_DIR="logs/build"
PIPELINE_TS="$(date +%Y%m%d-%H%M%S)"

pipeline_running_count() {
    local n=0 pid
    for pid in "${PIPELINE_PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null && n=$((n + 1))
    done
    echo "$n"
}

# Launch postprocess_app in the background, capped at KICAD_PIPELINE_JOBS
# concurrent jobs (default 2: pcbnew's wasm-opt pass peaks ~34 GB RSS; two postprocesses
# plus the container compile fit the 128 GB CI box). Portable poll loop instead
# of `wait -n` (absent in macOS bash 3.2).
pipeline_postprocess() {
    local app="$1"
    local max_jobs="${KICAD_PIPELINE_JOBS:-2}"
    while [ "$(pipeline_running_count)" -ge "$max_jobs" ]; do
        sleep 10
    done
    local log_file="${PIPELINE_LOG_DIR}/postprocess-${app}-${PIPELINE_TS}.log"
    echo "Pipelining host-side postprocess of ${app} (log: ${log_file})"
    (
        postprocess_app "$app" >"$log_file" 2>&1
        echo $? >"${log_file}.rc"
    ) &
    PIPELINE_PIDS+=($!)
    PIPELINE_APPS_BG+=("$app")
}

# Wait for all background postprocesses, replay their logs into the main log,
# and fail if any of them failed.
pipeline_wait_all() {
    local failed=0 i pid app log_file rc
    for i in "${!PIPELINE_PIDS[@]}"; do
        pid="${PIPELINE_PIDS[$i]}"
        app="${PIPELINE_APPS_BG[$i]}"
        log_file="${PIPELINE_LOG_DIR}/postprocess-${app}-${PIPELINE_TS}.log"
        wait "$pid" || true
        rc="$(cat "${log_file}.rc" 2>/dev/null || echo 1)"
        echo ""
        echo "=== Postprocess ${app} (rc=${rc}) — ${log_file} ==="
        cat "$log_file" 2>/dev/null || true
        if [ "$rc" != "0" ]; then
            echo "ERROR: postprocess of ${app} failed (rc=${rc})"
            failed=1
        fi
    done
    return "$failed"
}

TOTAL_APPS="${#APPS[@]}"

# Shared pipeline trap: on a failure, kill orphaned background wasm-opt jobs
# (each ~30 GB) and keep the monitor's done/fail marker from the EXIT trap.
_install_pipeline_trap() {
    trap '_rc=$?; for p in "${PIPELINE_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; if [ $_rc -eq 0 ]; then kw_done; else kw_fail $_rc; fi; stop_builder' EXIT
}

if [[ "$PHASE" == "compile" ]]; then
    # --compile-only: produce the opt-independent base wasm; no host post-process.
    idx=1
    for app in "${APPS[@]}"; do
        compile_app "$app" "$idx" "$TOTAL_APPS"
        idx=$((idx + 1))
    done
elif [[ "$PHASE" == "postprocess" ]]; then
    # --postprocess-only: pure host post-process on the existing output/ base
    # wasm (no container). Parallelize across apps when pipelining.
    if [[ "${KICAD_PIPELINE:-0}" == "1" ]] && [ "$TOTAL_APPS" -gt 1 ]; then
        mkdir -p "$PIPELINE_LOG_DIR"
        kw_stage binaryen
        ./scripts/binaryen-hoist-pass/build-wasm-opt.sh >/dev/null  # pre-warm Binaryen (submodule) once
        _install_pipeline_trap
        for app in "${APPS[@]}"; do
            pipeline_postprocess "$app"
        done
        pipeline_wait_all
    else
        for app in "${APPS[@]}"; do
            postprocess_app "$app"
        done
    fi
elif [[ "${KICAD_PIPELINE:-0}" == "1" ]] && [ "$TOTAL_APPS" -gt 1 ]; then
    # both, pipelined: overlap app[i+1]'s container compile with app[i]'s host
    # post-process (KICAD_PIPELINE=1).
    mkdir -p "$PIPELINE_LOG_DIR"
    # Pre-build the Binaryen submodule once — two concurrent postprocesses racing
    # the first from-source build would collide.
    kw_stage binaryen
    ./scripts/binaryen-hoist-pass/build-wasm-opt.sh >/dev/null
    _install_pipeline_trap
    idx=1
    for app in "${APPS[@]}"; do
        compile_app "$app" "$idx" "$TOTAL_APPS"
        pipeline_postprocess "$app"
        idx=$((idx + 1))
    done
    pipeline_wait_all
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
