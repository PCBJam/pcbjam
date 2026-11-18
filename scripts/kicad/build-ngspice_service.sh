#!/bin/bash
# Build ngspice_service.{js,wasm} — the eeschema simulator's ngspice worker
# module (wasm/ngspice-service/). Unlike occ_service this does NOT go through
# the kicad CMake tree: the module contains no KiCad/wx code, so it configures
# standalone against the sysroot ngspice artifacts (much faster to iterate,
# and buildable without the full editor dependency set).
#
# Artifacts: ${BUILD_ROOT}/kicad-ngspice_service/ngspice_service/ngspice_service.{js,wasm}
# — the kicad-<app>/<subdir>/ layout every other app uses, so docker/build.sh's
# output copy and tests/scripts/setup-kicad-wasm.sh's docker-volume fallback
# find them without special-casing.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"

# Parse arguments
CLEAN=0
for arg in "$@"; do
    case $arg in
        --clean)
            CLEAN=1
            shift
            ;;
    esac
done

NGSPICE_SERVICE_BUILD="${BUILD_ROOT}/kicad-ngspice_service"

if [ $CLEAN -eq 1 ]; then
    log_info "Cleaning ngspice_service build..."
    rm -rf "${NGSPICE_SERVICE_BUILD}"
fi

# The ngspice dep (sharedspice static lib + code-model archives + spinit + the
# code model kit) is stamped, so this is a no-op when already built.
"${SCRIPT_DIR}/../deps/build-ngspice.sh"

log_info "Building ngspice_service..."

mkdir -p "${NGSPICE_SERVICE_BUILD}"
cd "${NGSPICE_SERVICE_BUILD}"

emcmake cmake "${WASM_COMPAT}/ngspice-service" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="${NGSPICE_SERVICE_BUILD}/ngspice_service" \
    -DNGSPICE_SYSROOT="${SYSROOT}" \
    -DNGSPICE_EH_FLAGS="${DEPS_EH_FLAGS}"

emmake make -j${JOBS}

for f in ngspice_service.js ngspice_service.wasm; do
    if [ ! -f "${NGSPICE_SERVICE_BUILD}/ngspice_service/$f" ]; then
        log_error "ngspice_service build incomplete: missing $f"
        exit 1
    fi
done

log_info "ngspice_service build complete: ${NGSPICE_SERVICE_BUILD}/ngspice_service/ngspice_service.{js,wasm}"
