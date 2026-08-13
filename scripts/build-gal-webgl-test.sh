#!/bin/bash
#
# Build script for the WebGL GAL test harness (WASM)
#
# This builds a WASM module that renders GAL test scenarios using WebGL,
# allowing comparison against native OpenGL rendering.
#
# Uses a Makefile with direct em++ calls (like build-wasm-test.sh)
# to avoid emcmake Python 3.10+ requirement.
#
# Usage:
#   ./scripts/build-gal-webgl-test.sh              # Clean build (default)
#   ./scripts/build-gal-webgl-test.sh --no-clean   # Incremental build
#   ./scripts/build-gal-webgl-test.sh --debug      # Debug build with source maps
#

# Redirect all output to a log file (re-execs script with redirection)
source "$(dirname "$0")/common/logging.sh"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default to all cores BEFORE env.sh (its docker-safe JOBS=1 default would stick
# otherwise); an explicit JOBS/PARALLEL_JOBS from the caller still wins.
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

# Source common environment (sets up local emsdk)
QUIET=1 source "$SCRIPT_DIR/common/env.sh"

TEST_DIR="$PROJECT_ROOT/tests/gal-regression/wasm"
OUTPUT_DIR="$PROJECT_ROOT/tests/apps/gal-webgl"

echo "Building GAL WebGL Test..."
echo "  Test dir: $TEST_DIR"
echo "  Output dir: $OUTPUT_DIR"
echo "  EMSDK_PYTHON: ${EMSDK_PYTHON:-NOT SET}"
echo "  clang: $(which clang)"

# Verify em++ is available
if ! command -v em++ &> /dev/null; then
    echo "ERROR: em++ not found. Run: ./scripts/setup-emsdk.sh"
    exit 1
fi

echo "  Emscripten: $(em++ --version 2>&1 | head -1)"

# The execution-owner wx main loop enters an Emscripten fiber even in this
# rendering harness. Native wasm-EH cannot use the emsdk-bundled in-link
# Asyncify pass, so use the same private link overlay and pinned post-link pass
# as build-wasm-test.sh. Keep wasm-emscripten-finalize real: it emits the
# dynCall exports used by the generated fiber glue.
EMSDK_BINARYEN_BIN="$EMSDK/upstream/bin"
EMSDK_FINALIZE="$EMSDK_BINARYEN_BIN/wasm-emscripten-finalize"
REAL_FINALIZE="$EMSDK_FINALIZE"
[ -x "${EMSDK_FINALIZE}.real" ] && REAL_FINALIZE="${EMSDK_FINALIZE}.real"
WASMOPT_STUB="$PROJECT_ROOT/wasm/stubs/wasm-opt-stub.sh"

if [ ! -x "$REAL_FINALIZE" ] || grep -aq 'Stub wasm-emscripten-finalize' "$REAL_FINALIZE"; then
    echo "ERROR: real wasm-emscripten-finalize not found: $REAL_FINALIZE" >&2
    exit 1
fi

GAL_BINARYEN_OVERLAY="$(mktemp -d)"
mkdir -p "$GAL_BINARYEN_OVERLAY/bin"
for binaryen_tool in "$EMSDK_BINARYEN_BIN"/*; do
    [ -f "$binaryen_tool" ] || continue
    tool_name="$(basename "$binaryen_tool")"
    case "$tool_name" in
        wasm-opt|wasm-emscripten-finalize) continue ;;
    esac
    ln -s "$binaryen_tool" "$GAL_BINARYEN_OVERLAY/bin/$tool_name"
done
ln -s "$WASMOPT_STUB" "$GAL_BINARYEN_OVERLAY/bin/wasm-opt"
ln -s "$REAL_FINALIZE" "$GAL_BINARYEN_OVERLAY/bin/wasm-emscripten-finalize"
export EM_BINARYEN_ROOT="$GAL_BINARYEN_OVERLAY"

cleanup_gal_overlay() {
    [ -z "${GAL_BINARYEN_OVERLAY:-}" ] || rm -rf -- "$GAL_BINARYEN_OVERLAY"
}
trap cleanup_gal_overlay EXIT

export HOIST_WASMOPT="$("$SCRIPT_DIR/binaryen-hoist-pass/build-wasm-opt.sh")"
export V130_WASMOPT="$HOIST_WASMOPT"

# Parse arguments
# Default: clean build to avoid stale object file issues (header deps not tracked in old builds)
DEBUG_BUILD=0
CLEAN_BUILD=1

for arg in "$@"; do
    if [ "$arg" = "--debug" ]; then
        DEBUG_BUILD=1
    elif [ "$arg" = "--no-clean" ]; then
        CLEAN_BUILD=0
    fi
done

# Build using Makefile (compiles WebGL sources directly from kicad/)
cd "$TEST_DIR"

if [ "$CLEAN_BUILD" = "1" ]; then
    echo ""
    echo "Cleaning..."
    make clean 2>/dev/null || true
fi

# Always remove output files to ensure linker flags changes take effect
# (Makefile only tracks object file dependencies, not linker flag changes)
rm -f "$OUTPUT_DIR"/*.js "$OUTPUT_DIR"/*.wasm 2>/dev/null || true

# Generate shaders (converts GLSL 1.20 to GLSL ES 3.00)
# TODO: Eventually these should come from KiCad's build
echo ""
echo "Generating WebGL shaders..."
python3 generate_shaders.py

echo ""
echo "Building..."
if [ "$DEBUG_BUILD" = "1" ]; then
    make -j"${JOBS:-1}" DEBUG=1
else
    make -j"${JOBS:-1}"
fi

echo ""
echo "Applying the pinned post-link Asyncify pass..."
"$SCRIPT_DIR/common/apply-asyncify.sh" --no-removelist \
    "$OUTPUT_DIR/gal_webgl_test.wasm"
(
    cd "$OUTPUT_DIR"
    "$SCRIPT_DIR/common/inject-dyncall-shims.sh" gal_webgl_test.js
)

cleanup_gal_overlay
GAL_BINARYEN_OVERLAY=""
trap - EXIT

echo ""
echo "Build successful!"
echo ""
echo "Files in $OUTPUT_DIR:"
ls -lh "$OUTPUT_DIR"
echo ""
echo "To test locally:"
echo "  cd $PROJECT_ROOT/tests"
echo "  npx serve apps"
echo "  # Open http://localhost:3000/gal-webgl/gal_webgl_test.html"
