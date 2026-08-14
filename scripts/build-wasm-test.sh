#!/bin/bash
# Build the wxWidgets WASM test applications

# Redirect all output to a log file (re-execs script with redirection)
source "$(dirname "$0")/common/logging.sh"
# Default to all cores BEFORE env.sh (its docker-safe JOBS=1 default would stick
# otherwise); an explicit JOBS/PARALLEL_JOBS from the caller still wins. Measured
# 2026-07-02 (16-core M4 Max): clean build 15m36s at -j1 → ~2min, peak RAM ~11 GB.
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
source "$(dirname "$0")/common/env.sh"
# This script creates library symlinks and builds the test apps
#
# Usage:
#   ./build-wasm-test.sh              # Incremental build (default)
#   ./build-wasm-test.sh --clean      # Clean build from scratch
#   ./build-wasm-test.sh --debug      # Build with debug symbols
#   ./build-wasm-test.sh menu         # Build only the menu test
#   ./build-wasm-test.sh --debug menu # Build menu test with debug symbols

set -e

DEBUG_BUILD=0
CLEAN_BUILD=0
TARGET=""

# Parse arguments
for arg in "$@"; do
    if [ "$arg" = "--debug" ]; then
        DEBUG_BUILD=1
    elif [ "$arg" = "--clean" ]; then
        CLEAN_BUILD=1
    elif [ "$arg" != "" ]; then
        TARGET="$arg"
    fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TESTS_DIR="$PROJECT_ROOT/tests"

BUILD_DIR="$PROJECT_ROOT/build-wasm/wxwidgets"
WASM_APP_DIR="$TESTS_DIR/apps"
STANDALONE_DIR="$WASM_APP_DIR/standalone"

echo "=== Building wxWidgets WASM Test Applications ==="
if [ "$DEBUG_BUILD" = "1" ]; then
    echo "Mode: DEBUG (with DWARF symbols and source maps)"
else
    echo "Mode: Release (optimized)"
fi
if [ -n "$TARGET" ]; then
    echo "Target: $TARGET"
else
    echo "Target: all"
fi
echo "Project root: $PROJECT_ROOT"
echo "wxWidgets build: $BUILD_DIR"
echo "Test app dir: $WASM_APP_DIR"

# Verify wxWidgets is built
if [ ! -f "$BUILD_DIR/wx-config" ]; then
    echo "ERROR: wxWidgets not built. Run build-wx-wasm.sh first"
    exit 1
fi

# Create library symlinks
# wx-config outputs paths like libwx_baseu-3.2.a but files are named libwx_baseu-3.2-emscripten.a
echo ""
echo "=== Creating library symlinks ==="
cd "$BUILD_DIR/lib"
for f in libwx_*-emscripten.a; do
    if [ -f "$f" ]; then
        link="${f%-emscripten.a}.a"
        if [ ! -e "$link" ]; then
            ln -s "$f" "$link"
            echo "Created: $link -> $f"
        fi
    fi
done

# Build the test apps
echo ""
echo "=== Building test applications ==="
cd "$WASM_APP_DIR"

# Determine make target
if [ -n "$TARGET" ]; then
    MAKE_TARGET="$TARGET"
else
    MAKE_TARGET="all"
fi

# Clean if requested
if [ "$CLEAN_BUILD" = "1" ]; then
    echo "Cleaning build artifacts..."
    make -f Makefile.wasm clean 2>/dev/null || true
fi

# JSPI: no binaryen instrumentation exists — no fork build, no stub dance, no
# post-link pass, no shim injection (the jspi-scheduler ships as a --pre-js
# from Makefile.wasm). emcc's real wasm-opt runs in-link like any normal build.

# Build (pass DEBUG flag if requested). App links are independent, so honor
# JOBS/PARALLEL_JOBS from env.sh.
if [ "$DEBUG_BUILD" = "1" ]; then
    make -j"${JOBS:-1}" -f Makefile.wasm DEBUG=1 "$MAKE_TARGET"
else
    make -j"${JOBS:-1}" -f Makefile.wasm "$MAKE_TARGET"
fi
make_rc=$?
if [ "$make_rc" -ne 0 ]; then
    echo "" >&2
    echo "ERROR: make failed (exit $make_rc)." >&2
    exit "$make_rc"
fi

echo ""
echo "=== Build complete ==="

# JSPI micro-harnesses (jspi-stack, jspi-coroutine): still on their ad-hoc
# per-directory build.sh scripts (Makefile.wasm wiring is the Phase 3 TODO).
# Without this the jspi/ Playwright suites 404 their built .mjs modules on any
# machine that never ran the scripts by hand — which is exactly what CI is.
if [ -z "$TARGET" ]; then
    echo ""
    echo "=== JSPI micro-harnesses ==="
    for harness in jspi-stack jspi-coroutine; do
        echo "Building $harness..."
        "$STANDALONE_DIR/$harness/build.sh"
    done
fi

if [ -n "$TARGET" ]; then
    # Show just the built target
    echo ""
    if [ -f "$STANDALONE_DIR/$TARGET/${TARGET}_test.html" ]; then
        echo "Built: $TARGET"
        ls -lh "$STANDALONE_DIR/$TARGET/${TARGET}_test.html"
    elif [ -f "$WASM_APP_DIR/${TARGET}_test.html" ]; then
        echo "Built: $TARGET"
        ls -lh "$WASM_APP_DIR/${TARGET}_test.html"
    else
        echo "Warning: Expected output file not found"
    fi
else
    # Show all built targets
    echo ""
    echo "Main test app:"
    ls -lh "$WASM_APP_DIR"/minimal_test.html 2>/dev/null || echo "  (not built)"

    echo ""
    echo "Standalone test apps:"
    for test in menu clipboard filedialog layout aui toolbar grid dialog timer tree; do
        if [ -f "$STANDALONE_DIR/$test/${test}_test.html" ]; then
            echo "  $test: OK"
            ls -lh "$STANDALONE_DIR/$test/${test}_test.html"
        else
            echo "  $test: (not built)"
        fi
    done
fi

echo ""
echo "To run the tests:"
echo "  cd $TESTS_DIR"
echo "  npm install"
echo "  npm test"
