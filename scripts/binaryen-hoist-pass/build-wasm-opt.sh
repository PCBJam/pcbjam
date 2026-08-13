#!/bin/bash
# Build the host post-process Binaryen tools from our submodule: wasm-opt (with the
# catch-arm-hoisting pass, --hoist-cpp-catches) AND wasm-emscripten-finalize.
#
# Source of truth is the tracked Binaryen submodule (binaryen/, branch wasm-port =
# upstream version_130 + src/passes/HoistCppCatches.cpp). This configures an out-of-source
# build into the gitignored build-wasm/ tree and prints the wasm-opt path on stdout
# (build progress to stderr); wasm-emscripten-finalize lands next to it in the same bin/
# (apply-finalize.sh derives it from the wasm-opt dir). Building both from one submodule
# keeps finalize and asyncify on a single Binaryen version and removes the host emsdk
# dependency from the post-process. See docs/features/wasm-exceptions/06-spike-plan.md (Phase 1.5).
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${PROJECT_ROOT}/binaryen"
BUILD="${PROJECT_ROOT}/build-wasm/tools/binaryen-hoist-build"

if [ ! -f "${SRC}/src/passes/HoistCppCatches.cpp" ]; then
    echo "ERROR: binaryen submodule is missing the hoist pass." >&2
    echo "       Run: git submodule update --init binaryen" >&2
    exit 1
fi

# CI fast-path: the workflow cache-restores bin/ + lib/ keyed on the exact submodule
# SHA and sets this var on a hit, so the restored binaries are authoritative — skip
# cmake+ninja. Trust only if both tools actually RUN: the binaries dynamically link
# lib/libbinaryen.so, so an existence check alone passes on an incomplete restore
# (bin/ without lib/ shipped a red main, run 28585074335) while --version proves the
# loader resolves everything. Never set the var locally when iterating on the pass:
# uncommitted source edits would be silently ignored (the SHA key can't see them).
if [ "${BINARYEN_TRUST_PREBUILT:-0}" = "1" ] \
   && "${BUILD}/bin/wasm-opt" --version >/dev/null 2>&1 \
   && "${BUILD}/bin/wasm-emscripten-finalize" --version >/dev/null 2>&1; then
    echo "Using prebuilt Binaryen tools (BINARYEN_TRUST_PREBUILT=1): ${BUILD}/bin" >&2
    echo "${BUILD}/bin/wasm-opt"
    exit 0
fi

# Binaryen is a HOST tool. scripts/common/env.sh deliberately exports
# CC="ccache emcc" and CXX="ccache em++" for the surrounding Wasm build; if
# those leak into this one-time CMake configure, every object is compiled for
# Wasm and the host libbinaryen link later fails at `em++ -shared`. Select the
# host compilers explicitly, and repair an old cache which recorded the
# Emscripten compiler as ccache's first argument.
HOST_CC="$(command -v cc)"
HOST_CXX="$(command -v c++)"
POISONED_CACHE=0
if [ -f "${BUILD}/CMakeCache.txt" ] \
   && grep -Eq '^CMAKE_CXX_COMPILER_ARG1:STRING=.*em\+\+' \
        "${BUILD}/CMakeCache.txt"; then
    POISONED_CACHE=1
fi

# Configure once (mirrors scripts/common/get-wasm-opt.sh's from-source flags),
# or reconfigure a cache created before the host/compiler boundary was made
# explicit. CMake invalidates the affected objects when the compiler changes.
if [ ! -f "${BUILD}/build.ninja" ] || [ "${POISONED_CACHE}" = "1" ]; then
    echo "Configuring Binaryen submodule build (one-time, ~5 min to build)..." >&2
    cmake -S "${SRC}" -B "${BUILD}" -G Ninja \
        -DCMAKE_C_COMPILER="${HOST_CC}" \
        -DCMAKE_CXX_COMPILER="${HOST_CXX}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_CXX_FLAGS="-Wno-maybe-uninitialized" \
        -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON -DBUILD_TESTS=OFF >&2
fi

ninja -C "${BUILD}" wasm-opt wasm-emscripten-finalize >&2

echo "${BUILD}/bin/wasm-opt"
