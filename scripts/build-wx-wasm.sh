#!/bin/bash
# Build wxWidgets for WebAssembly (the DOM port: widgets are real HTML
# elements; owner-drawn widgets render into per-window canvas islands)
#
# CI cache epoch: 2 (2026-07-29). CI's wx cache key hashes THIS FILE
# (.github/workflows/wasm-build.yml "Restore wx build cache"), so editing this
# header is how a poisoned build-wasm/wxwidgets cache gets discarded. Bumped
# after a restored cache failed with "No rule to make target
# 3rdparty/pcre/src/pcre2_chartables.c": pcre's makefile rm's that path and
# re-links it to pcre2_chartables.c.dist at configure time, so a cache captured
# around that window restores a build tree whose pcre rule can no longer be
# satisfied from a clean checkout. Bump the number to force a fresh wx build.

# Redirect all output to a log file (re-execs script with redirection)
source "$(dirname "$0")/common/logging.sh"

# Default to all cores BEFORE sourcing env.sh — env.sh exports a docker-safe
# JOBS=1 when unset, which would make the "${JOBS:-nproc}" fallback below it
# dead code (this build ran make -j1 everywhere for that reason). An explicit
# JOBS/PARALLEL_JOBS from the caller still wins (e.g. the docker pipeline's -j
# via build-kicad-target.sh).
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

# Source common environment (sets up local emsdk)
source "$(dirname "$0")/common/env.sh"
# Build-progress markers (parsed by scripts/build-monitor.sh).
source "$(dirname "$0")/common/stages.sh"
# This builds the GUI-enabled wxWidgets needed for KiCad
#
# Prerequisites:
# - Emscripten SDK (auto-installed by env.sh via scripts/setup-emsdk.sh)
# - autoconf (for regenerating configure from configure.in)
#
# To regenerate Makefile.in from bakefiles (after modifying files.bkl):
#   cd wxwidgets/build/bakefiles
#   docker run --rm -v "$(pwd)/../..":"$(pwd)/../.." -w "$(pwd)" \
#     ghcr.io/vslavik/bakefile:0.2 bakefile_gen
#
# Usage:
#   ./build-wx-wasm.sh          # Incremental build (default)
#   ./build-wx-wasm.sh --clean  # Clean build from scratch

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WX_SOURCE="$PROJECT_ROOT/wxwidgets"

# Parse arguments: --clean or --no-clean (default; kept for the kicad
# pipeline's explicit call), in any order.
CLEAN_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --clean)    CLEAN_BUILD=1 ;;
        --no-clean) CLEAN_BUILD=0 ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

BUILD_DIR="$PROJECT_ROOT/build-wasm/wxwidgets"
WXLIB_PREFIX="libwx_wasmu"

# Async-backend stamp: the JSPI migration changed COMPILE flags in ways the
# configure-cached incremental build cannot see — building over a stale
# asyncify-era tree silently links a MIXED library. Force a clean build
# whenever the stamp disagrees.
BACKEND_STAMP="$BUILD_DIR/.pcbjam-async-backend"
# Single backend since the JSPI migration: the stamp still force-cleans any
# pre-migration tree (asyncify objects would silently mix into the library).
CURRENT_BACKEND="jspi"
# ABSENT stamp = unknown provenance = same as a mismatch: an incremental build
# over objects of unknown backend produced a MIXED library once (jspi evtloop
# EM_JS in the glue next to live fiber dispatch — --allow-multiple-definition
# hid it and the editor took the fiber branch at runtime under JSPI).
if [ -d "$BUILD_DIR" ] && [ "$(cat "$BACKEND_STAMP" 2>/dev/null)" != "$CURRENT_BACKEND" ]; then
    echo "=== Async backend changed ($(cat "$BACKEND_STAMP" 2>/dev/null || echo unknown) -> $CURRENT_BACKEND): forcing clean wx build ==="
    CLEAN_BUILD=1
fi

# Use our config.sub wrapper for autoconf projects
# CONFIG_SHELL is critical: nested configures (pcre, etc.) do SHELL=${CONFIG_SHELL-/bin/sh}
# Without CONFIG_SHELL, nested configures would reset SHELL to /bin/sh and bypass our wrapper
export SHELL="$SCRIPT_DIR/config/config-sub-wrapper.sh"
export CONFIG_SHELL="$SCRIPT_DIR/config/config-sub-wrapper.sh"

# Disable autom4te cache to keep submodules clean
export AUTOM4TE="$SCRIPT_DIR/config/autom4te-wrapper.sh"

echo "=== Building wxWidgets for WASM ==="
echo "Project root: $PROJECT_ROOT"
echo "Build dir: $BUILD_DIR"
echo "wxWidgets source: $WX_SOURCE"

# Verify we're in the right place
if [ ! -f "$WX_SOURCE/configure.in" ]; then
    echo "ERROR: wxWidgets source not found at $WX_SOURCE"
    echo "Make sure the wxwidgets submodule is initialized"
    exit 1
fi

# Regenerate configure if configure.in or autoconf_inc.m4 is newer.
# (configure.in sincludes autoconf_inc.m4, which bakefile regenerates from
# build/bakefiles/files.bkl — new build conditions live there.)
if [ "$WX_SOURCE/configure.in" -nt "$WX_SOURCE/configure" ] || \
   [ "$WX_SOURCE/autoconf_inc.m4" -nt "$WX_SOURCE/configure" ]; then
    echo "configure inputs changed, regenerating configure..."
    (cd "$WX_SOURCE" && autoconf)
fi

# Incremental build by default, use --clean for full rebuild
if [ "$CLEAN_BUILD" = "1" ]; then
    echo "Cleaning build directory..."
    rm -rf "$BUILD_DIR"
fi

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Determine if we need to run configure
# Skip configure if:
# 1. Makefile exists (already configured)
# 2. configure.in hasn't changed since last configure
NEEDS_CONFIGURE=0
if [ ! -f "$BUILD_DIR/Makefile" ]; then
    echo "Not configured yet, will run configure..."
    NEEDS_CONFIGURE=1
elif [ "$WX_SOURCE/configure.in" -nt "$BUILD_DIR/Makefile" ]; then
    echo "configure.in changed since last configure, will reconfigure..."
    NEEDS_CONFIGURE=1
elif [ "$WX_SOURCE/configure" -nt "$BUILD_DIR/Makefile" ]; then
    echo "configure script changed, will reconfigure..."
    NEEDS_CONFIGURE=1
elif [ "$WX_SOURCE/Makefile.in" -nt "$BUILD_DIR/Makefile" ]; then
    # Makefile.in is regenerated from build/bakefiles/files.bkl (see header);
    # the build Makefile must be re-derived or new source files are ignored.
    echo "Makefile.in changed since last configure, will reconfigure..."
    NEEDS_CONFIGURE=1
else
    echo "Already configured, skipping configure (use clean build to reconfigure)"
fi

if [ $NEEDS_CONFIGURE -eq 1 ]; then
    # Configure with emconfigure
    # Key flags based on wxWidgets-wasm:
    # --host=emscripten          Host system (detected via config.sub)
    # --disable-shared           Build static libraries
    # --with-opengl              Enable OpenGL/WebGL support
    # --enable-exceptions        Enable C++ exceptions (needed for KiCad debug builds)
    # --disable-richtext         Not needed for KiCad, simplifies build
    # --without-libtiff          Avoid external dependencies
    # --disable-xlocale          Browser environment handles locale

    kw_stage wxwidgets-configure
    echo ""
    echo "=== Configuring ==="

    # Regenerate autotools files in bundled PCRE to fix version mismatch
    # The bundled PCRE was generated with automake 1.16.1 but build systems
    # may have different versions. Running autoreconf ensures compatibility.
    if command -v autoreconf &> /dev/null; then
        echo "Regenerating autotools files for bundled PCRE..."
        (cd "$WX_SOURCE/3rdparty/pcre" && autoreconf -fi 2>/dev/null || true)
    fi

    # Ensure Emscripten's zlib port is built (works in Docker and on host)
    # This populates the cache sysroot with zlib.h and libz.a
    echo "Building Emscripten zlib port..."
    embuilder build zlib

    # Get Emscripten cache sysroot path (portable across environments)
    EM_CACHE_SYSROOT="$(em-config CACHE)/sysroot"
    echo "Emscripten cache sysroot: $EM_CACHE_SYSROOT"

    # Set flags for Emscripten compatibility
    # Z_HAVE_UNISTD_H ensures zlib includes <unistd.h> for read/write/lseek
    # Include pcre2 headers from the build directory (generated during configure)
    PCRE2_INCLUDE="$BUILD_DIR/3rdparty/pcre/src"

    # Configure debug/release flags based on DEBUG_BUILD environment variable
    if [ "${DEBUG_BUILD:-1}" = "1" ]; then
        WX_DEBUG_FLAGS="-g -O1"
        WX_CONFIGURE_DEBUG="--enable-debug"
        echo "Building wxWidgets in DEBUG mode"
    else
        WX_DEBUG_FLAGS="-O2"
        WX_CONFIGURE_DEBUG=""
        echo "Building wxWidgets in RELEASE mode"
    fi

    # Exception model: native WebAssembly exceptions (legacy binary encoding) + wasm setjmp/longjmp,
    # single-sourced from scripts/common/env.sh. -sWASM_LEGACY_EXCEPTIONS=1 pins the EH binary
    # encoding (exnref is not adopted across our pinned emsdk/browsers). See docs/features/wasm-exceptions/.
    WX_EH_FLAGS="$DEPS_EH_FLAGS"
    echo "wx EH model flags: ${WX_EH_FLAGS}"

    # Include emscripten cache sysroot for zlib headers
    export CFLAGS="-DZ_HAVE_UNISTD_H=1 -I$EM_CACHE_SYSROOT/include ${WX_DEBUG_FLAGS} ${WX_EH_FLAGS} -pthread -matomics -mbulk-memory"
    export CXXFLAGS="-DZ_HAVE_UNISTD_H=1 -I$EM_CACHE_SYSROOT/include -I$PCRE2_INCLUDE ${WX_DEBUG_FLAGS} ${WX_EH_FLAGS} -pthread -matomics -mbulk-memory"
    export LDFLAGS="-L$EM_CACHE_SYSROOT/lib/wasm32-emscripten"

    emconfigure "$WX_SOURCE/configure" \
        --host=emscripten \
        --without-subdirs \
        --disable-shared \
        --with-opengl \
        --enable-exceptions \
        --disable-richtext \
        --without-libtiff \
        --disable-xlocale \
        --with-cxx=17 \
        --enable-utf8 \
        --with-zlib=sys \
        --with-regex=builtin \
        ${WX_CONFIGURE_DEBUG}
    # --with-regex=builtin: without it a host pkg-config can find the host's
    # pcre2 (homebrew on macOS) and configure silently picks "regex sys", which
    # skips the bundled 3rdparty/pcre build dir the next step requires.

    # Build PCRE first to avoid race condition with parallel builds
    # PCRE headers (pcre2.h) must be generated before regex.cpp compiles
    echo ""
    echo "=== Building PCRE first (dependency) ==="
    # Serial relative to the main build (it fully completes first); parallel inside.
    emmake make -j${JOBS} -C 3rdparty/pcre
fi

# Ensure the Emscripten zlib port exists before compiling. We configure with
# --with-zlib=sys, which resolves zlib.h/libz.a to the emsdk cache sysroot —
# populated only by `embuilder build zlib` in the configure branch above. When
# the build dir arrives pre-configured (e.g. CI restores build-wasm/wxwidgets
# from cache onto a runner with a freshly installed emsdk), configure is
# skipped and any recompile of a zlib-using TU (zipstrm.cpp, zstream.cpp, ...)
# fails with "'zlib.h' file not found" — deterministically, so the serial
# retry below can't clear it.
EM_CACHE_SYSROOT="$(em-config CACHE)/sysroot"
if [ ! -f "$EM_CACHE_SYSROOT/include/zlib.h" ]; then
    echo "Emscripten zlib port missing from $EM_CACHE_SYSROOT; building it..."
    # --force: embuilder stamps the port as built on libz.a alone, so a
    # half-populated cache (lib present, headers gone) would no-op without it.
    embuilder build zlib --force
fi

# Build wxWidgets
kw_stage wxwidgets-compile
echo ""
echo "=== Building wxWidgets (using ${JOBS} parallel jobs) ==="
# A clean -jN build occasionally fails non-deterministically: a burst of GUI
# translation units (toplevel.cpp, dirdlgg.cpp, the generic colour/dir dialogs,
# ...) all abort at once with bogus "incomplete type 'wxBitmap'" / "wxIcon has
# no member IsOk" / "unknown type 'wxTranslations'" errors, while neighbouring
# files compile fine. It never happens at -j1 (the host default) — it's a
# parallel-build race over a generated/regenerated header (config.status can
# re-emit wx/setup.h, and emscripten warms its cache on first use), so some
# compiles read a file mid-rewrite. The same source builds cleanly on a retry.
# Rather than serialize the whole (slow) build, fall back to a serial pass only
# when the parallel one trips: it resumes from the already-built objects, so it
# just recompiles the few that lost the race. A genuine error still fails the
# -j1 pass and surfaces. (Same spirit as the serial PCRE pre-build above.)
if ! emmake make -j${JOBS}; then
    echo ""
    echo "=== Parallel build failed; retrying serially to clear the clean-build race ==="
    emmake make -j1
fi

# Create library symlinks (remove -emscripten suffix for CMake compatibility)
echo ""
echo "=== Creating library symlinks ==="
cd "$BUILD_DIR/lib"
for lib in *-emscripten.a; do
    # Skip symlinks - only process real files (stub symlinks are handled below)
    if [ -f "$lib" ] && [ ! -L "$lib" ]; then
        newname="${lib/-emscripten/}"
        rm -f "$newname"  # Remove existing symlink/file to avoid conflicts
        ln -sf "$lib" "$newname"
    fi
done

# Create stub libraries for components wx-config reports but we didn't build
# KiCad doesn't use these directly
echo "Creating stub libraries..."
for stub in richtext webview; do
    # Remove any existing symlinks first to avoid "same file" errors
    rm -f "${WXLIB_PREFIX}_${stub}-3.2.a" "${WXLIB_PREFIX}_${stub}-3.2-emscripten.a"
    emar rcs "${WXLIB_PREFIX}_${stub}-3.2.a"
    ln -sf "${WXLIB_PREFIX}_${stub}-3.2.a" "${WXLIB_PREFIX}_${stub}-3.2-emscripten.a"
done

cd "$BUILD_DIR"

echo ""
mkdir -p "$BUILD_DIR" && printf %s "$CURRENT_BACKEND" > "$BACKEND_STAMP"
echo "=== Build complete ==="
ls -lh "$BUILD_DIR"/lib/*.a 2>/dev/null || echo "Libraries built in $BUILD_DIR/lib"
