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

# Native wasm-EH is the only build mode. The emsdk-bundled Binaryen v121 crashes asyncifying wasm-EH,
# so we stub ONLY the in-link wasm-opt and run --hoist-cpp-catches + --asyncify post-link on the
# Binaryen submodule (version_130 + hoist pass) via apply-asyncify.sh. wasm-emscripten-finalize must
# remain real during the em++ link: it creates the dynCall_* exports used by Emscripten's fiber JS.
#
# KiCad's large-app build deliberately leaves both tools stubbed in the persistent Docker image.
# Do not overwrite that shared toolchain here. Give this process a private Binaryen overlay through
# Emscripten's supported EM_BINARYEN_ROOT setting instead. This also makes a focused test build
# independent of which app the container built immediately before it.
EMSDK_BINARYEN_BIN="$EMSDK/upstream/bin"
EMSDK_FINALIZE="$EMSDK_BINARYEN_BIN/wasm-emscripten-finalize"
REAL_FINALIZE="$EMSDK_FINALIZE"
[ -x "${EMSDK_FINALIZE}.real" ] && REAL_FINALIZE="${EMSDK_FINALIZE}.real"
WASMOPT_STUB="$PROJECT_ROOT/wasm/stubs/wasm-opt-stub.sh"
if [ ! -x "$REAL_FINALIZE" ]; then
    echo "ERROR: real wasm-emscripten-finalize not found: $REAL_FINALIZE" >&2
    exit 1
fi
if grep -aq 'Stub wasm-emscripten-finalize' "$REAL_FINALIZE"; then
    echo "ERROR: $REAL_FINALIZE is the no-op finalizer, not the real Binaryen tool" >&2
    exit 1
fi

EM_BINARYEN_OVERLAY="$(mktemp -d)"
mkdir -p "$EM_BINARYEN_OVERLAY/bin"
for binaryen_tool in "$EMSDK_BINARYEN_BIN"/*; do
    [ -f "$binaryen_tool" ] || continue
    tool_name="$(basename "$binaryen_tool")"
    case "$tool_name" in
        wasm-opt|wasm-emscripten-finalize) continue ;;
    esac
    ln -s "$binaryen_tool" "$EM_BINARYEN_OVERLAY/bin/$tool_name"
done
ln -s "$WASMOPT_STUB" "$EM_BINARYEN_OVERLAY/bin/wasm-opt"
ln -s "$REAL_FINALIZE" "$EM_BINARYEN_OVERLAY/bin/wasm-emscripten-finalize"
export EM_BINARYEN_ROOT="$EM_BINARYEN_OVERLAY"

EH_MARKER=""
_eh_cleanup() {
    [ -z "$EH_MARKER" ] || rm -f -- "$EH_MARKER"
    [ -z "$EM_BINARYEN_OVERLAY" ] || rm -rf -- "$EM_BINARYEN_OVERLAY"
}
EH_MARKER="$(mktemp)"   # created before the build so 'find -newer' below selects freshly-linked apps
trap _eh_cleanup EXIT
echo ""
echo "=== Building the Binaryen submodule (version_130 + hoist pass) ==="
# One binaryen everywhere: the submodule fork is version_130 (asyncify unchanged) + our hoist
# pass, so the same binary does --hoist-cpp-catches AND --asyncify/-O2. No separate v130 clone.
export HOIST_WASMOPT="$("$SCRIPT_DIR/binaryen-hoist-pass/build-wasm-opt.sh")"
export V130_WASMOPT="$HOIST_WASMOPT"
echo "  submodule wasm-opt: $HOIST_WASMOPT"
echo "  link Binaryen overlay: $EM_BINARYEN_OVERLAY"
echo "Stubbing in-link Asyncify in the private overlay (will run post-link instead)..."

# Build (pass DEBUG flag if requested). App links are independent, so honor
# JOBS/PARALLEL_JOBS from env.sh (each emcc link is slow due to Asyncify).
if [ "$DEBUG_BUILD" = "1" ]; then
    make -j"${JOBS:-1}" -f Makefile.wasm DEBUG=1 "$MAKE_TARGET"
else
    make -j"${JOBS:-1}" -f Makefile.wasm "$MAKE_TARGET"
fi
make_rc=$?
if [ "$make_rc" -ne 0 ]; then
    # Fail loudly. Silently continuing to the post-link leaves the freshly-linked apps
    # asyncify-stubbed / un-injected, which looks like mass test failures rather than a build
    # error. (The EXIT trap removes this process's private Binaryen overlay.)
    echo "" >&2
    echo "ERROR: make failed (exit $make_rc); aborting before the post-link step." >&2
    exit "$make_rc"
fi

# Inject the dyncall + asyncify-scheduler shims into every freshly-linked app. The
# scheduler's currData save/restore (Emscripten #9153) is needed: without it a rewind that
# resumes through a fresh wasm re-entry hits _asyncify_start_rewind(null) -> "memory access out
# of bounds" — e.g. a context-menu pick while the main loop is parked. The Makefile only injects
# it for the coroutine apps; inject-dyncall-shims.sh is idempotent (skips an already-shimmed glue),
# so re-running it here is safe. The .wasm gets post-link hoist + asyncify first.
echo ""
echo "=== Post-link --hoist-cpp-catches + --asyncify (${JOBS:-1}-wide) ==="
# The apps are independent here too (apply-asyncify rewrites each wasm in place; the shim
# injector's temp file is per-js), so fan the post-link out across JOBS like the make phase.
# This dominates the build: per-app wasm-opt can't feed many cores (small modules, serial
# parse/write), so parallelism must come from running apps side by side — serial 3m52s even
# with BINARYEN_CORES=16, vs 2m08s fanned out at ~11 GB peak RAM. HOIST_WASMOPT is resolved
# once above, so workers skip the binaryen ninja check. xargs fails the build (exit 123) if
# any app's post-link fails.
export SCRIPT_DIR
# Match EVERY freshly-linked app wasm, not just standalone/*/*_test.wasm: the main demo
# (apps/minimal_test.wasm) is at the apps/ root, and the coroutine-pthread repros + wxpt app
# are *_repro*.wasm / *_wxpt.wasm. The old '*_test.wasm under standalone' filter silently
# skipped all of those, so under native wasm-EH they never got hoist+asyncify and crashed at
# runtime with "asyncify_start_unwind not found".
find "$WASM_APP_DIR" -name '*.wasm' -newer "$EH_MARKER" -print0 \
  | xargs -0 -n1 -P "${JOBS:-1}" bash -c '
    set -eo pipefail
    w="$1"
    "$SCRIPT_DIR/common/apply-asyncify.sh" --no-removelist "$w"
    js="${w%.wasm}.js"
    if [ -f "$js" ]; then
        ( cd "$(dirname "$js")" && "$SCRIPT_DIR/common/inject-dyncall-shims.sh" "$(basename "$js")" )
    fi
' _
rm -f "$EH_MARKER"
EH_MARKER=""
_eh_cleanup; trap - EXIT
EM_BINARYEN_OVERLAY=""

echo ""
echo "=== Build complete ==="

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
