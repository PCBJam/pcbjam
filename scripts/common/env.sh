#!/bin/bash
# Environment setup for KiCad WASM build scripts

# Get script and project directories using unique names to avoid conflicts
_KICAD_WASM_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_KICAD_WASM_SCRIPTS_DIR="$(dirname "$_KICAD_WASM_COMMON_DIR")"
_KICAD_WASM_PROJECT_ROOT="$(dirname "$_KICAD_WASM_SCRIPTS_DIR")"

# Export paths
export PROJECT_ROOT="$_KICAD_WASM_PROJECT_ROOT"
export SCRIPTS_DIR="$_KICAD_WASM_SCRIPTS_DIR"
export COMMON_DIR="$_KICAD_WASM_COMMON_DIR"

# Use our config.sub wrapper for autoconf projects (emconfigure)
# This intercepts config.sub calls to use our version with emscripten/wasm32 support
# CONFIG_SHELL is critical: nested configures do SHELL=${CONFIG_SHELL-/bin/sh}
export SHELL="$SCRIPTS_DIR/config/config-sub-wrapper.sh"
export CONFIG_SHELL="$SCRIPTS_DIR/config/config-sub-wrapper.sh"

# Build output directories (inside the project)
export BUILD_ROOT="$PROJECT_ROOT/build-wasm"
export DEPS_ROOT="$BUILD_ROOT/deps"
export SYSROOT="$BUILD_ROOT/sysroot"
export STAMPS_DIR="$BUILD_ROOT/stamps"

# Source directories
export KICAD_SOURCE="$PROJECT_ROOT/kicad"
export WXWIDGETS_SOURCE="$PROJECT_ROOT/wxwidgets"
export WASM_COMPAT="$PROJECT_ROOT/wasm"
export STUBS_DIR="$PROJECT_ROOT/stubs"
export CMAKE_MODULES="$PROJECT_ROOT/cmake"

# wxWidgets build location
export WX_BUILD="$BUILD_ROOT/wxwidgets"

# Emscripten settings
export EMSDK_QUIET=1

# Exception model for ALL WASM translation units — the C/C++ dependencies, wxWidgets, and KiCad
# (build-wx-wasm.sh and build-kicad-target.sh source this file and reuse DEPS_EH_FLAGS). Native
# WebAssembly exceptions (legacy binary encoding) are the only build mode. -sSUPPORT_LONGJMP=wasm is
# required because the deps that use setjmp/longjmp (freetype, cairo, OpenCASCADE) must use wasm
# setjmp — emscripten's JS-longjmp implementation cannot coexist with -fwasm-exceptions (it would
# leave emscripten_longjmp undefined). -sWASM_LEGACY_EXCEPTIONS=1 selects the EH binary encoding our
# post-link Asyncify + catch-arm-hoisting pass can consume (Asyncify can't handle exnref).
export DEPS_EH_FLAGS="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1"

# Emscripten SDK setup
# If EMSDK is already set (e.g. Docker entrypoint sourced emsdk_env.sh), use it.
# Otherwise auto-install a local copy under tools/emsdk/.
# emsdk's activation script deliberately unsets a caller-provided EM_CACHE.
# Preserve it across activation so Docker can keep Emscripten's downloaded ports
# and generated sysroot in the named build-cache volume.
_KICAD_WASM_REQUESTED_EM_CACHE="${EM_CACHE:-}"
if [ -n "$EMSDK" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
    # emsdk already active (e.g., Docker entrypoint sourced it)
    source "$EMSDK/emsdk_env.sh" 2>/dev/null
else
    # Local emsdk: auto-install if missing, then source its environment
    # The emsdk bundles its own Python, Node, and LLVM — no Homebrew needed
    _EMSDK_DIR="$_KICAD_WASM_PROJECT_ROOT/tools/emsdk"
    _EMSDK_ENV="$_EMSDK_DIR/emsdk_env.sh"

    if [ ! -f "$_EMSDK_ENV" ]; then
        echo "Emscripten SDK not found. Installing..."
        "$_KICAD_WASM_SCRIPTS_DIR/setup-emsdk.sh"
    fi

    if [ -f "$_EMSDK_ENV" ]; then
        source "$_EMSDK_ENV" 2>/dev/null
    fi
fi

if [ -n "$_KICAD_WASM_REQUESTED_EM_CACHE" ]; then
    export EM_CACHE="$_KICAD_WASM_REQUESTED_EM_CACHE"
fi
unset _KICAD_WASM_REQUESTED_EM_CACHE

# --- Ensure a working `python` command for build codegen steps --------------
# Some build steps run scripts via a `#!/usr/bin/env python` shebang (e.g.
# wxWidgets' src/stc/gen_iface.py, which regenerates wx/stc/stc.h). The bundled
# emsdk ships only `python3`; modern macOS has no system `python`; and a pyenv
# shim with no configured version silently shadows PATH and aborts the build
# with "pyenv: python: command not found". Guard on actually *running* python
# (the pyenv shim exists but fails), and shim `python` -> python3 so this can't
# break across machines/CI.
if ! python -c '' >/dev/null 2>&1; then
    # Prefer emsdk's bundled python3, fall back to any python3 on PATH.
    _PY3="$(ls "$_KICAD_WASM_PROJECT_ROOT"/tools/emsdk/python/*/bin/python3 2>/dev/null | head -n1)"
    [ -x "$_PY3" ] || _PY3="$(command -v python3 || true)"
    if [ -n "$_PY3" ]; then
        _PY_SHIM_DIR="$BUILD_ROOT/python-shim"
        mkdir -p "$_PY_SHIM_DIR"
        ln -sf "$_PY3" "$_PY_SHIM_DIR/python"
        export PATH="$_PY_SHIM_DIR:$PATH"
    fi
fi

# Common compiler flags
export EMCC_CFLAGS="-fPIC -DEMSCRIPTEN"
export EMCC_CXXFLAGS="-fPIC -DEMSCRIPTEN -std=c++17"

# Use ccache if available for faster rebuilds
if command -v ccache &> /dev/null; then
    export CC="ccache emcc"
    export CXX="ccache em++"
fi

# Debug mode (default: ON, use --release to disable)
# This can be overridden by setting DEBUG_BUILD=0 before sourcing this file
DEBUG_BUILD="${DEBUG_BUILD:-1}"

if [ "$DEBUG_BUILD" = "1" ]; then
    export BUILD_TYPE="Debug"
    export DEBUG_CFLAGS="-g -O1"
    export DEBUG_LDFLAGS="-g -gsource-map"
else
    export BUILD_TYPE="Release"
    export DEBUG_CFLAGS="-O2"
    export DEBUG_LDFLAGS=""
fi

export DEBUG_BUILD BUILD_TYPE DEBUG_CFLAGS DEBUG_LDFLAGS

# Parallel jobs (default to 1 for memory-constrained environments like Docker)
# Can be overridden with -j N flag or by setting JOBS/PARALLEL_JOBS env vars
if [ -n "$PARALLEL_JOBS" ]; then
    export JOBS="$PARALLEL_JOBS"
elif [ -z "$JOBS" ]; then
    # Default to 1 for sequential builds (safer for memory)
    # Use -j N to override for faster builds on machines with more RAM
    export JOBS=1
fi

# Common linker flags for WASM
export WASM_LDFLAGS="\
-sALLOW_MEMORY_GROWTH=1 \
-sINITIAL_MEMORY=256MB \
-sSTACK_SIZE=5MB \
-sASYNCIFY=1 \
-sASYNCIFY_STACK_SIZE=16384 \
-sLEGACY_GL_EMULATION \
-sMAX_WEBGL_VERSION=2"

# Threading flags (when enabled)
export PTHREAD_LDFLAGS="\
-pthread \
-sPROXY_TO_PTHREAD=1 \
-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency \
-sOFFSCREENCANVAS_SUPPORT=1"

# Create output directories
mkdir -p "$BUILD_ROOT" "$DEPS_ROOT" "$SYSROOT"/{lib,include,share} "$STAMPS_DIR"

# Source other common files
source "$COMMON_DIR/versions.sh"
source "$COMMON_DIR/functions.sh"

# Print environment info (only if not in quiet mode)
if [ "${QUIET:-0}" != "1" ]; then
    echo "KiCad WASM Build Environment"
    echo "  Project root: $PROJECT_ROOT"
    echo "  Build root:   $BUILD_ROOT"
    echo "  Sysroot:      $SYSROOT"
fi
