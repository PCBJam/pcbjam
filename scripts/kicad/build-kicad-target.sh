#!/bin/bash
# Build a KiCad app (pcbnew, eeschema, calculator, pl_editor) for WebAssembly.
#
# Usage:
#   ./scripts/kicad/build-kicad-target.sh <app> [options]
#
# Args:
#   <app>         pcbnew | eeschema | calculator | pl_editor (required)
#
# Options:
#   --full        Full clean rebuild (dependencies + KiCad)
#   --clean-kicad Clean only KiCad build directory (not deps)
#   --build-deps  Build dependencies (default: skip)
#   --debug       Build with debug symbols (default)
#   --release     Build optimized without debug symbols
#   --diag=...    Diagnostic preprocessor flags (gal, coroutine, ctor, all)
#   -j N          Parallel compilation jobs (default: 1)
#
# Each app builds into its own tree: build-wasm/kicad-<app>/.
# Per-app extras live alongside generic stubs:
#   - wasm/bindings/<app>_embind.cpp        (optional)
#   - wasm/stubs/<app>_frame_stub.cpp       (optional, app-specific stubs)
#   - wasm/stubs/<app>_scripting_stub.cpp   (optional, app-specific scripting stubs)
#
# Most apps use the same name for the user-facing app, the CMake target, and
# the source subdirectory. Calculator is the exception: app=calculator but the
# upstream target and source subdir are both pcb_calculator (the OUTPUT_NAME
# property in pcb_calculator/CMakeLists.txt emits calculator.{js,wasm}).
# pl_editor is the standard case but its source subdir is pagelayout_editor.

set -e

if [ -z "$1" ]; then
    echo "Error: missing <app> argument (kicad_editor | pcbnew | eeschema | calculator | pl_editor | gerbview)" >&2
    exit 1
fi
APP_NAME="$1"
shift

# KICAD_TARGET: the CMake/make target name.
# KICAD_SUBDIR: the source/build subdirectory the target's artifacts land in.
# Most apps share all three names; the exceptions:
#   - calculator:    target+subdir are both pcb_calculator (OUTPUT_NAME=calculator)
#   - pl_editor:     subdir is pagelayout_editor (upstream source dir name)
# The footprint/symbol editors have no target of their own — the pcbnew/eeschema
# bundle opens them at runtime via single_top.cpp's --frame flag.
case "$APP_NAME" in
    kicad_editor)
        # Merged pcbnew+eeschema image (editor-unification Part 2): one executable
        # linking BOTH kifaces, frame chosen at runtime by --frame (pcb/fpedit/sch/
        # symedit). Target lives in wasm/editor/ (added by the fork's top-level
        # CMakeLists under -DKICAD_WASM_MERGED_EDITOR=ON); its binary dir doubles as
        # the artifact subdir.
        KICAD_TARGET="kicad_editor"
        KICAD_SUBDIR="kicad_editor"
        ;;
    pcbnew|eeschema|gerbview)
        KICAD_TARGET="$APP_NAME"
        KICAD_SUBDIR="$APP_NAME"
        ;;
    pl_editor)
        KICAD_TARGET="pl_editor"
        KICAD_SUBDIR="pagelayout_editor"
        ;;
    calculator)
        KICAD_TARGET="pcb_calculator"
        KICAD_SUBDIR="pcb_calculator"
        ;;
    kicad_tools)
        # Merged headless CLI (pcbjam-mcp 0001 tier 3a): both dieted kifaces —
        # .lib conversion (--convert-lib), --lint, --erc, --netlist, --bom,
        # --plot, --drc in one node image. (Supersedes the retired standalone
        # sym_convert / pcb_convert apps.) Its add_executable lives in
        # wasm/tools/ (added by the fork's top-level CMakeLists under
        # -DKICAD_TOOLS_WASM=ON); the binary dir doubles as the artifact
        # subdir of its own kicad-kicad_tools tree. A headless CLI has no 3D
        # viewer: skip the wasm/gl1 FFP shim compile (it needs glm, which the
        # libs sysroot doesn't guarantee) unless the caller forces it.
        KICAD_TARGET="kicad_tools"
        KICAD_SUBDIR="kicad_tools"
        BUILD_3D_VIEWER="${BUILD_3D_VIEWER:-OFF}"
        ;;
    occ_service)
        # Standalone OpenCASCADE 3D service (worker embind module). Target lives
        # in wasm/occ-service/ (added by the fork's top-level CMakeLists under
        # -DKICAD_OCC_SERVICE_WASM=ON); like kicad_editor, its binary dir
        # doubles as the artifact subdir of its own kicad-occ_service tree.
        KICAD_TARGET="occ_service"
        KICAD_SUBDIR="occ_service"
        ;;
    *)
        echo "Error: unknown app '$APP_NAME' (expected: kicad_editor | pcbnew | eeschema | calculator | pl_editor | gerbview | kicad_tools | occ_service)" >&2
        exit 1
        ;;
esac

# Which app's embind bindings to compile + link. Most apps use their own.
# NOTE kicad_tools deliberately does NOT reuse the editors' embind objects even
# though it links both kifaces: each kiface references exactly one embind
# symbol (kicadCollabOnSave), and linking a real bindings TU for it roots the
# whole editor surface from .init_array (~4x binary size — ysync 0009 size
# research). Its own wasm/bindings/kicad_tools_embind.cpp provides a no-op hook.
case "$APP_NAME" in
    # occ_service links the pcbnew kiface objects → pcbnew's embind object (its
    # own embind entry points live in occ_service_main.cpp, compiled inside the
    # CMake target).
    occ_service)      EMBIND_APP="pcbnew" ;;
    *)                EMBIND_APP="$APP_NAME" ;;
esac

# Embind linker support (--bind). kicad_tools has no bindings at all (see
# above) — dropping --bind keeps the embind JS/native runtime out entirely.
case "$APP_NAME" in
    kicad_tools)      EMBIND_LINK_FLAG="" ;;
    *)                EMBIND_LINK_FLAG="--bind" ;;
esac

# Which app's WASM stub libraries (scripting/frame placeholders) to link.
# kicad_editor links pcbnew's kiface objects, which reference the action-plugin
# scripting placeholders (pcbnewGet*); eeschema's frame stub arrives via CMake
# (target_sources on eeschema_kiface_objects), not this path.
case "$APP_NAME" in
    # kicad_tools links both kifaces: eeschema's frame stub comes through this
    # path, pcbnew's via CMake PCBNEW_WASM_STUBS.
    kicad_tools)      STUB_APP="eeschema" ;;
    kicad_editor)     STUB_APP="pcbnew" ;;
    # occ_service links the pcbnew kiface objects → pcbnew's stubs (frame +
    # action-plugin scripting placeholders), like the editors.
    occ_service)      STUB_APP="pcbnew" ;;
    *)                STUB_APP="$APP_NAME" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../common/env.sh"
source "${SCRIPT_DIR}/../common/versions.sh"
source "${SCRIPT_DIR}/../common/functions.sh"
source "${SCRIPT_DIR}/../common/stages.sh"

KICAD_DIR="${PROJECT_ROOT}/kicad"
WASM_LAYER="${PROJECT_ROOT}/wasm"

KICAD_BUILD="${BUILD_ROOT}/kicad-${APP_NAME}"
KICAD_STAMP="${BUILD_ROOT}/stamps/kicad-${APP_NAME}.stamp"
WX_BUILD="${BUILD_ROOT}/wxwidgets"

# Parse arguments - incremental build by default (optimized for development)
NO_CLEAN=1
FULL_CLEAN=0
SKIP_DEPS=1
DEBUG=0
DIAG_LIST=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --full)
            FULL_CLEAN=1
            NO_CLEAN=0
            SKIP_DEPS=0
            shift
            ;;
        --clean-kicad)
            NO_CLEAN=0
            shift
            ;;
        --build-deps)
            SKIP_DEPS=0
            shift
            ;;
        --debug)
            DEBUG=1
            shift
            ;;
        --release)
            DEBUG_BUILD=0
            export DEBUG_BUILD
            shift
            ;;
        --diag=*)
            DIAG_LIST="${1#--diag=}"
            shift
            ;;
        --diag)
            DIAG_LIST="$2"
            shift 2
            ;;
        -j)
            export JOBS="$2"
            shift 2
            ;;
        -j*)
            export JOBS="${1#-j}"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# Diagnostic preprocessor defines from --diag=<csv> (gal, coroutine, ctor, all).
# These gate the KI_DIAG_* macros in kicad/include/kicad_wasm_diag.h. Output goes
# to stdout ([KICAD_OUT] logs), never errors. Off by default.
DIAG_DEFINES=""
if [ -n "${DIAG_LIST}" ]; then
    IFS=',' read -ra _diag_cats <<< "${DIAG_LIST}"
    for _cat in "${_diag_cats[@]}"; do
        case "${_cat}" in
            gal)       DIAG_DEFINES="${DIAG_DEFINES} -DKICAD_DIAG_GAL=1" ;;
            coroutine) DIAG_DEFINES="${DIAG_DEFINES} -DKICAD_DIAG_COROUTINE=1" ;;
            ctor)      DIAG_DEFINES="${DIAG_DEFINES} -DKICAD_DIAG_CTOR=1" ;;
            all)       DIAG_DEFINES="${DIAG_DEFINES} -DKICAD_DIAG_GAL=1 -DKICAD_DIAG_COROUTINE=1 -DKICAD_DIAG_CTOR=1" ;;
            "")        ;;
            *)         log_warn "Unknown --diag category: '${_cat}' (valid: gal, coroutine, ctor, all)" ;;
        esac
    done
    log_info "Diagnostic logging enabled:${DIAG_DEFINES}"
fi

log_info "Building app: ${APP_NAME}"
log_info "Using ${JOBS} parallel jobs"

# Step 1: Clean build directories
if [ $FULL_CLEAN -eq 1 ]; then
    log_info "Full clean: removing all stamps and build directories..."
    rm -rf "${STAMPS_DIR}"/*
    rm -rf "${BUILD_ROOT}/deps"/*
    rm -rf "${BUILD_ROOT}/wxwidgets"
    rm -rf "${BUILD_ROOT}/stubs"
    rm -rf "${KICAD_BUILD}"
    rm -rf "${SYSROOT}"/*
elif [ $NO_CLEAN -eq 0 ]; then
    log_info "Cleaning KiCad ${APP_NAME} build directory..."
    rm -rf "${KICAD_BUILD}" "${KICAD_STAMP}"
else
    log_info "Incremental build (use --clean-kicad or --full to clean)"
fi

# Step 2: Build dependencies
# Note: --with-occ for OpenCASCADE. The ngspice dep is NOT needed here — the
# editor links only the sharedspice client stub; the engine is the separate
# ngspice_service app (scripts/kicad/build-ngspice_service.sh builds its dep).
if [ $SKIP_DEPS -eq 0 ]; then
    kw_stage deps
    log_info "Building dependencies..."
    "${SCRIPT_DIR}/../deps/build-all-deps.sh" --with-occ
else
    log_info "Skipping dependencies (use --build-deps or --full to build)"
fi

# Note: We don't check the KiCad stamp here for incremental builds.
# CMake handles dependency tracking - it will detect changed source files
# and only recompile what's needed. The stamp is created at the end for
# scripts that want to know if KiCad was ever built successfully.

# Step 4: Build wxWidgets (incremental - only recompiles changed files)
kw_stage wxwidgets
log_info "Building wxWidgets..."
"${SCRIPT_DIR}/../build-wx-wasm.sh" --no-clean

log_info "Building KiCad ${APP_NAME} ${KICAD_VERSION} for WASM..."

# Step 5: Set build type
# Exception model: native WebAssembly exceptions (legacy binary encoding) + wasm setjmp/longjmp,
# single-sourced from scripts/common/env.sh (KiCad and wxWidgets must agree — mixing EH models
# link-fails / traps; both build with exceptions enabled). -matomics -mbulk-memory are required for
# shared memory (pthreads).
KICAD_EH_FLAGS="$DEPS_EH_FLAGS"
log_info "KiCad EH model flags: ${KICAD_EH_FLAGS}"

# Use environment DEBUG_BUILD if set, otherwise check local --debug flag
# NOTE: We use -O1 for debug builds because -O0 produces WASM with too many
# locals for V8/Chrome to compile (error: "local count too large").
# -O1 keeps debug info but optimizes enough to stay under V8's limits.
if [ "${DEBUG_BUILD:-0}" = "1" ] || [ $DEBUG -eq 1 ]; then
    BUILD_TYPE="Debug"
    EXTRA_FLAGS="-g -O1 ${KICAD_EH_FLAGS} -matomics -mbulk-memory"
    # CMake defines DEBUG for Config=Debug (kicad/CMakeLists.txt:351). The embind TU (Step 7) is
    # compiled OUTSIDE CMake, so it must define DEBUG too — otherwise a DEBUG-gated virtual
    # (EDA_ITEM::Show, eda_item.h:471) occupies a vtable slot in the core's emitted vtable that the
    # embind TU doesn't account for, shifting every later slot by one. Then every virtual call made
    # from the embind TU past that slot (SetWidth/GetPosition/...) reads the wrong vtable offset and
    # mis-dispatches at runtime (call_indirect signature-mismatch trap; under native-EH the trap is
    # swallowed by the apply coroutine's catch_all → silent hang). See task #54 root-cause analysis.
    EMBIND_CONFIG_DEFINES="-DDEBUG"
    # -gseparate-dwarf puts debug info in a separate .debug.wasm file
    # This keeps the main WASM small (~200MB) while preserving full debug info
    # DevTools loads the debug file on-demand when debugging
    LINKER_DEBUG_FLAGS="-O1 -g -gseparate-dwarf ${KICAD_EH_FLAGS}"
    log_info "Building KiCad in DEBUG mode (separate DWARF for smaller main binary)"
else
    BUILD_TYPE="Release"
    EXTRA_FLAGS="-O2 ${KICAD_EH_FLAGS} -matomics -mbulk-memory"
    EMBIND_CONFIG_DEFINES=""   # Release defines no DEBUG in either TU → vtable layouts already match
    # -O0 at link time means emcc does not run wasm-opt itself (it only does at
    # -O2+). That is fine: step 8.2 below runs wasm-opt explicitly, so the module
    # is optimized either way. The old "wasm-opt OOMs on large modules" reason for
    # -O0 was Asyncify-era and no longer applies.
    LINKER_DEBUG_FLAGS="-O0 ${KICAD_EH_FLAGS}"
    log_info "Building KiCad in RELEASE mode (post-link wasm-opt runs in step 8.2)"
fi

# Suspension backend: JSPI (native stack switching). The headless CLIs
# (kicad_tools, occ_service) get no suspension backend — they run in
# node/workers where nothing may suspend. coroutine.h/libcontext key on
# __EMSCRIPTEN__ directly, so no ABI define is threaded through the TU flags.

# Step 6: Create build directory
mkdir -p "${KICAD_BUILD}"
cd "${KICAD_BUILD}"

# Step 6.1: Build stub libraries for missing symbols
# Generic stubs (libgit2, curl, nng) are shared across apps and built in BUILD_ROOT/stubs.
# App-specific stubs (e.g. pcbnew_scripting_stub) build into the same directory but
# are only linked in when the corresponding source exists.
STUBS_DIR="${PROJECT_ROOT}/wasm/stubs"
STUBS_BUILD="${BUILD_ROOT}/stubs"
mkdir -p "${STUBS_BUILD}"

# ABI-affecting flags shared by EVERY C++ TU compiled OUTSIDE CMake (the embind + the app stubs below).
# The core CMake TUs get all of these (DEBUG via Config=Debug -> kicad/CMakeLists.txt:351;
# KICAD_USE_PLATFORM_WASM; the char16_t char_traits force-include). A TU that misses any of them can
# diverge in vtable layout / ABI from the core — task #54: the embind missing -DDEBUG shifted its vtable
# slot offsets by one and hung the collab apply (call_indirect signature-mismatch). Keep them in ONE
# place so no out-of-CMake C++ TU can skew again. (EMBIND_CONFIG_DEFINES holds the build-config -DDEBUG,
# set in the BUILD_TYPE block above; empty in Release where neither side defines DEBUG.)
KICAD_TU_ABI_FLAGS="${EMBIND_CONFIG_DEFINES} -DKICAD_USE_PLATFORM_WASM=1 -include ${STUBS_DIR}/char_traits_uint16_workaround.h"

kw_stage kicad-stubs
log_info "Building stub libraries..."
# Compile libgit2 stub
emcc -c "${STUBS_DIR}/libgit2_stub.c" -o "${STUBS_BUILD}/libgit2_stub.o"
emar rcs "${STUBS_BUILD}/libgit2_stub.a" "${STUBS_BUILD}/libgit2_stub.o"

# Compile curl stub
emcc -c "${STUBS_DIR}/curl_stub.c" -o "${STUBS_BUILD}/curl_stub.o"
emar rcs "${STUBS_BUILD}/libcurl_stub.a" "${STUBS_BUILD}/curl_stub.o"

# Note: the GLU tesselator is provided by kicad/libs/kimath/glu_tess/glu_tess_impl.cpp,
# compiled as part of the GAL library (requires KiCad headers).

# Compile NNG stub (IPC API requires NNG but sockets don't work in WASM)
emcc -c -I"${STUBS_DIR}" "${STUBS_DIR}/nng_stub.c" -o "${STUBS_BUILD}/nng_stub.o"
emar rcs "${STUBS_BUILD}/libnng_stub.a" "${STUBS_BUILD}/nng_stub.o"

# wx flags for any C++ stubs that include wx headers
WX_CXXFLAGS=$("${WX_BUILD}/wx-config" --cxxflags 2>/dev/null || echo "-I${WX_BUILD}/lib/wx/include/emscripten-unicode-static-3.2 -I${PROJECT_ROOT}/wxwidgets/include")

# App-specific stubs:
# - pcbnew: pcbnew_scripting_stub.cpp (action-plugin scripting placeholders)
# - eeschema: eeschema_frame_stub.cpp (placeholder; grows as linker dictates)
APP_STUB_LINK=""
APP_SCRIPTING_STUB_SRC="${STUBS_DIR}/${STUB_APP}_scripting_stub.cpp"
if [ -f "${APP_SCRIPTING_STUB_SRC}" ]; then
    log_info "Building app scripting stub: ${STUB_APP}_scripting_stub.cpp"
    em++ -c ${KICAD_TU_ABI_FLAGS} ${WX_CXXFLAGS} "${APP_SCRIPTING_STUB_SRC}" -o "${STUBS_BUILD}/${STUB_APP}_scripting_stub.o"
    emar rcs "${STUBS_BUILD}/lib${STUB_APP}_scripting_stub.a" "${STUBS_BUILD}/${STUB_APP}_scripting_stub.o"
    APP_STUB_LINK="${APP_STUB_LINK} ${STUBS_BUILD}/lib${STUB_APP}_scripting_stub.a"
fi

APP_FRAME_STUB_SRC="${STUBS_DIR}/${STUB_APP}_frame_stub.cpp"
if [ -f "${APP_FRAME_STUB_SRC}" ] && [ -s "${APP_FRAME_STUB_SRC}" ]; then
    log_info "Building app frame stub: ${STUB_APP}_frame_stub.cpp"
    em++ -c ${KICAD_TU_ABI_FLAGS} ${WX_CXXFLAGS} "${APP_FRAME_STUB_SRC}" -o "${STUBS_BUILD}/${STUB_APP}_frame_stub.o"
    emar rcs "${STUBS_BUILD}/lib${STUB_APP}_frame_stub.a" "${STUBS_BUILD}/${STUB_APP}_frame_stub.o"
    APP_STUB_LINK="${APP_STUB_LINK} ${STUBS_BUILD}/lib${STUB_APP}_frame_stub.a"
fi

log_info "Stub libraries built"

# EMSDK is needed below (emscripten sysroot paths in the CMake invocation).
if [ -z "${EMSDK}" ]; then
    log_error "EMSDK environment variable is not set."
    exit 1
fi

# Step 6.5: Verify WASM support is in KiCad fork
# The kicad submodule should already have WASM port detection and kiplatform support
KICAD_CMAKE="${KICAD_DIR}/CMakeLists.txt"
if ! grep -q "msw|qt|gtk|osx|wasm" "${KICAD_CMAKE}"; then
    log_error "KiCad fork is missing WASM port detection support."
    log_error "Please ensure the kicad submodule has WASM modifications."
    exit 1
fi
KIPLATFORM_CMAKE="${KICAD_DIR}/libs/kiplatform/CMakeLists.txt"
if ! grep -q "KICAD_WX_PORT STREQUAL wasm" "${KIPLATFORM_CMAKE}"; then
    log_error "KiCad fork is missing kiplatform WASM support."
    log_error "Please ensure the kicad submodule has WASM modifications."
    exit 1
fi
log_info "KiCad WASM support verified"

# Embind object — built after CMake configure runs (so config.h exists). The
# linker line below references "${STUBS_BUILD}/${APP_NAME}_embind.o" so we
# create an empty placeholder when the source is missing, to keep the link
# line stable across apps.
# kicad_editor (merged image) links THREE embind objects: both per-editor TUs
# (compiled with -DKICAD_MERGED_EMBIND, which compiles out their duplicate
# definitions and shared-name registrations) plus the dispatcher TU that registers
# the shared JS names once — see wasm/bindings/kicad_editor_embind.cpp.
if [ "${APP_NAME}" = "kicad_editor" ]; then
    EMBIND_OBJ="${STUBS_BUILD}/pcbnew_embind.o ${STUBS_BUILD}/eeschema_embind.o ${STUBS_BUILD}/kicad_editor_embind.o"
else
    EMBIND_OBJ="${STUBS_BUILD}/${EMBIND_APP}_embind.o"
fi
EMBIND_SRC="${PROJECT_ROOT}/wasm/bindings/${EMBIND_APP}_embind.cpp"

# Step 7: Configure KiCad with CMake
# We use CMAKE_MODULE_PATH to inject our compatibility layer
kw_stage kicad-configure
log_info "Configuring KiCad with CMake..."
# emcc 6: -sUSE_ZLIB is gone; prebuild the zlib port (regular + PIC) so the
# explicit ZLIB_LIBRARY below always exists (PIC needed by the .so links).
"${EMSDK}/upstream/emscripten/embuilder" build zlib >/dev/null 2>&1 || true
"${EMSDK}/upstream/emscripten/embuilder" build zlib --pic >/dev/null 2>&1 || true

# CMAKE_SHARED/MODULE_LINKER_FLAGS below: set EXPLICITLY (a stale CMakeCache
# once resurrected experimental -L hacks), and carry the SAME ODR policy as
# the exe links (wasm/editor/CMakeLists.txt): KiCad deliberately ships
# wx-compat copies (wxGetContentRect in grid_checkbox.cpp vs wx grid.cpp)
# that emcc 6 kiface/.so links reject without --allow-multiple-definition.

# Use ccache if available (CMAKE_*_COMPILER_LAUNCHER is the proper CMake way)
CCACHE_OPTS=""
if command -v ccache &> /dev/null; then
    CCACHE_OPTS="-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache"
    log_info "Using ccache for compilation"
fi

# The merged headless CLI configures with BOTH diet options (each trims its
# own kiface for this tree; the eeschema one also trims the SCH_IO factory to
# the two KiCad plugins) plus the wasm/tools/ subdir gate.
KICAD_TOOLS_CMAKE_FLAG=""
if [ "${APP_NAME}" = "kicad_tools" ]; then
    KICAD_TOOLS_CMAKE_FLAG="-DKICAD_TOOLS_WASM=ON -DKICAD_SYM_CONVERTER_WASM=ON -DKICAD_PCB_CONVERTER_WASM=ON"
fi

# Merged pcbnew+eeschema editor: gates the wasm/editor/ subdir, the per-engine
# Kiface()/KIFACE_GETTER renames, and the PCB-side ODR symbol renames in the fork's
# CMake (see KICAD_WASM_MERGED_EDITOR in kicad/CMakeLists.txt). Only this tree
# (build-wasm/kicad-kicad_editor) configures with it ON.
MERGED_EDITOR_CMAKE_FLAG=""
if [ "${APP_NAME}" = "kicad_editor" ]; then
    MERGED_EDITOR_CMAKE_FLAG="-DKICAD_WASM_MERGED_EDITOR=ON"
fi

# The standalone OCC 3D service (worker embind module) — gates the
# wasm/occ-service/ subdir in the fork's top-level CMakeLists.
OCC_SERVICE_CMAKE_FLAG=""
if [ "${APP_NAME}" = "occ_service" ]; then
    OCC_SERVICE_CMAKE_FLAG="-DKICAD_OCC_SERVICE_WASM=ON"
fi

# 3D viewer: built by DEFAULT (BUILD_3D_VIEWER=ON). Opt out with BUILD_3D_VIEWER=OFF, which links the
# 3D stubs instead. The default renderer is still the GL-free CPU raytracer
# (RENDER_3D_RAYTRACE_RAM) blitted through a WebGL2 textured quad, but KiCad's fixed-function
# OpenGL renderer (RENDER_3D_OPENGL) now links against the REAL GL1->WebGL2 emulation layer
# (wasm/gl1, no -sLEGACY_GL_EMULATION): the shim implements the FFP-only entry points and
# --wrap-intercepts the Emscripten-owned names it must observe (wasm/gl1/wrapped_symbols.txt).
# Regression gate: tests/3d-regression (47 golden scenarios). The KiCad CMake option
# KICAD_BUILD_3D_VIEWER_WASM stays OFF upstream; our build passes it explicitly.
# See wasm/gl1/README.md and docs/features/fork-cleanup/10-3d-viewer.md.
BUILD_3D_VIEWER="${BUILD_3D_VIEWER:-ON}"
GL3D_LINK_FLAGS=""
if [ "${BUILD_3D_VIEWER}" = "ON" ]; then
    log_info "3D viewer ENABLED for WASM (BUILD_3D_VIEWER=ON) — compiling wasm/gl1 FFP shim"
    GL1_DIR="${PROJECT_ROOT}/wasm/gl1"
    while IFS= read -r gl1_src; do
        [ -n "${gl1_src}" ] || continue
        em++ -c ${EXTRA_FLAGS} -pthread -std=c++20 \
             -I"${GL1_DIR}/include" -I"${STUBS_DIR}" -I"${SYSROOT}/include" \
             "${GL1_DIR}/src/${gl1_src}" -o "${STUBS_BUILD}/${gl1_src%.cpp}.o"
        GL3D_LINK_FLAGS="${GL3D_LINK_FLAGS} ${STUBS_BUILD}/${gl1_src%.cpp}.o"
    done < "${GL1_DIR}/sources.txt"
    while IFS= read -r gl1_sym; do
        [ -n "${gl1_sym}" ] || continue
        GL3D_LINK_FLAGS="${GL3D_LINK_FLAGS} -Wl,--wrap=${gl1_sym}"
    done < "${GL1_DIR}/wrapped_symbols.txt"
fi

# Multi-threaded CPU raytracer (mainline threading restored): link the main-thread
# nanosleep-yield shim so the raw-thread raytracer joins (sleep_for busy-wait)
# yield to the JS event loop instead of deadlocking on-demand pthread-Worker
# creation (wasm/shims/nanosleep_yield.c, suspends via the jspi scheduler).
# The synchronous node CLIs must NOT link it: nothing in them may suspend and
# a blocking CLI wants libc's real blocking nanosleep anyway — node permits
# Atomics.wait on its main thread.
if [ "${APP_NAME}" = "kicad_tools" ] || [ "${APP_NAME}" = "occ_service" ]; then
    NANOSLEEP_YIELD_LINK=""
else
    # Every main-thread sleep suspends in place (legal on a promising
    # activation; EM_ASYNC_JS auto-wraps as WebAssembly.Suspending under
    # -sJSPI) and routes through the jspi-scheduler turnstile.
    emcc -c -pthread "${PROJECT_ROOT}/wasm/shims/nanosleep_yield.c" -o "${STUBS_BUILD}/nanosleep_yield.o"
    NANOSLEEP_YIELD_LINK="${STUBS_BUILD}/nanosleep_yield.o"
fi

# mallinfo() stub for the mimalloc build: -sMALLOC=mimalloc doesn't export the
# glibc mallinfo() that OpenCASCADE's OSD_MemInfo.cxx (libTKernel, pcbnew's 3D)
# references — without this the pcbnew link fails `undefined symbol: mallinfo`.
# Zeroed no-op (memory reporting only); harmless for apps that don't reference it.
emcc -c "${PROJECT_ROOT}/wasm/shims/mallinfo_stub.c" -o "${STUBS_BUILD}/mallinfo_stub.o"
MALLINFO_STUB_LINK="${STUBS_BUILD}/mallinfo_stub.o"

# Pre-warmed Web Worker pool size (emscripten pthreads). The 3D-viewer CPU raytracer runs
# KiCad's shared thread pool (hardware_concurrency long-lived threads, created at startup)
# AND, for camera-move preview + post-process passes, spawns its OWN set of raw std::thread
# workers — so a 3D-viewer session needs ~2x hardware_concurrency Workers *simultaneously*.
# With only one set pre-warmed, the raytracer's threads fall back to on-demand `new Worker()`,
# whose loaded→run handshake needs the main thread back in the JS event loop — which it can't
# reach while blocked in the render's busy-wait join (no PROXY_TO_PTHREAD; the join runs on the
# browser main thread). That circular wait is the 3D-viewer deadlock: moving the model, dragging
# or resizing the viewer all freeze the tab. Pre-warm enough Workers that on-demand creation
# never happens. Only 3D-viewer builds pay the extra startup Workers; other apps keep one set.
if [ "${BUILD_3D_VIEWER:-OFF}" = "ON" ]; then
    PTHREAD_POOL_EXPR='navigator.hardwareConcurrency*2+8'
else
    PTHREAD_POOL_EXPR='navigator.hardwareConcurrency'
fi

# Suspension link surface. Browser apps: -sJSPI + the promising-export census
# (scripts/common/jspi-exports.txt: the wx KEEPALIVE entries that can park +
# pcbjam_libctx_entry; regenerate by grep, not memory), the jspi-scheduler
# pre-js, and the runtime methods its spill-stack discipline needs
# (stackSave/stackRestore/HEAPU8). Headless CLIs: nothing — no suspension
# backend; nothing in them may suspend.
case "${APP_NAME}" in
    kicad_tools|occ_service)
        JSPI_LINK_FLAGS=""
        JSPI_RUNTIME_METHODS="-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8']"
        ;;
    *)
        JSPI_LINK_FLAGS="-sJSPI -sJSPI_EXPORTS=@${PROJECT_ROOT}/scripts/common/jspi-exports.txt --pre-js ${PROJECT_ROOT}/scripts/common/shims/jspi-scheduler.js"
        JSPI_RUNTIME_METHODS="-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8','stackSave','stackRestore','HEAPU8','HEAP8','HEAP32']"
        ;;
esac

emcmake cmake "${KICAD_DIR}" \
    ${CCACHE_OPTS} \
    ${KICAD_TOOLS_CMAKE_FLAG} \
    ${MERGED_EDITOR_CMAKE_FLAG} \
    ${OCC_SERVICE_CMAKE_FLAG} \
    -DCMAKE_BUILD_TYPE=${BUILD_TYPE} \
    -DCMAKE_INSTALL_PREFIX="${SYSROOT}" \
    -DCMAKE_MODULE_PATH="${WASM_LAYER}/cmake" \
    -DSYSROOT="${SYSROOT}" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_CXX_FLAGS="${EXTRA_FLAGS} -Xclang -fno-pch-timestamp -pthread --use-port=zlib -DKICAD_USE_PLATFORM_WASM=1${DIAG_DEFINES} -I${SYSROOT}/include -I${STUBS_DIR} -include ${STUBS_DIR}/char_traits_uint16_workaround.h" \
    -DCMAKE_C_FLAGS="${EXTRA_FLAGS} -pthread --use-port=zlib -I${SYSROOT}/include -I${STUBS_DIR}" \
    -DCMAKE_EXE_LINKER_FLAGS="${LINKER_DEBUG_FLAGS} -pthread ${JSPI_LINK_FLAGS} -sUSE_PTHREADS=1 -sMALLOC=mimalloc -sPTHREAD_POOL_SIZE='${PTHREAD_POOL_EXPR}' -sPTHREAD_POOL_SIZE_STRICT=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB -sMAX_WEBGL_VERSION=2 ${GL3D_LINK_FLAGS} ${NANOSLEEP_YIELD_LINK} ${MALLINFO_STUB_LINK} ${JSPI_RUNTIME_METHODS} ${EMBIND_LINK_FLAG} -L${SYSROOT}/lib -L${KICAD_BUILD}/common -L${KICAD_BUILD}/common/gal ${STUBS_BUILD}/libgit2_stub.a ${STUBS_BUILD}/libcurl_stub.a${APP_STUB_LINK} ${STUBS_BUILD}/libnng_stub.a ${EMBIND_OBJ}" \
    -DCMAKE_SHARED_LINKER_FLAGS="-Wl,--allow-multiple-definition" \
    -DCMAKE_MODULE_LINKER_FLAGS="-Wl,--allow-multiple-definition" \
    -DZLIB_LIBRARY="${EMSDK}/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/pic/libz.a" \
    -DZLIB_INCLUDE_DIR="${EMSDK}/upstream/emscripten/cache/sysroot/include" \
    -DCMAKE_PREFIX_PATH="${SYSROOT};${WX_BUILD}" \
    -DwxWidgets_CONFIG_EXECUTABLE="${WX_BUILD}/wx-config" \
    \
    -DKICAD_BUILD_QA_TESTS=OFF \
    -DKICAD_USE_EGL=OFF \
    -DKICAD_USE_BUNDLED_GLEW=ON \
    -DKICAD_BUILD_3D_VIEWER_WASM=${BUILD_3D_VIEWER} \
    -DKICAD_IPC_API=ON \
    -DKICAD_USE_PCH=ON \
    \
    -DZSTD_ROOT="${SYSROOT}" \
    -DZSTD_INCLUDE_DIR="${SYSROOT}/include" \
    -DZSTD_LIBRARY="${SYSROOT}/lib/libzstd.a" \
    -DGLM_INCLUDE_DIR="${SYSROOT}/include" \
    -DGLM_VERSION="0.9.9.8" \
    -DBOOST_ROOT="${SYSROOT}" \
    -DBoost_INCLUDE_DIR="${SYSROOT}/include" \
    -DBoost_LIBRARY_DIR="${SYSROOT}/lib" \
    -DBoost_NO_SYSTEM_PATHS=ON \
    -DBoost_NO_BOOST_CMAKE=ON \
    -DFREETYPE_INCLUDE_DIR_ft2build="${SYSROOT}/include/freetype2" \
    -DFREETYPE_INCLUDE_DIR_freetype2="${SYSROOT}/include/freetype2" \
    -DFREETYPE_LIBRARY="${SYSROOT}/lib/libfreetype.a" \
    -DHarfBuzz_INCLUDE_DIR="${SYSROOT}/include/harfbuzz" \
    -DHarfBuzz_LIBRARY="${SYSROOT}/lib/libharfbuzz.a" \
    -DOCC_INCLUDE_DIR="${SYSROOT}/include/opencascade" \
    -DOCC_LIBRARY_DIR="${SYSROOT}/lib" \
    -DProtobuf_INCLUDE_DIR="${SYSROOT}/include" \
    -DProtobuf_LIBRARY="${SYSROOT}/lib/libprotobuf.a" \
    -DProtobuf_LITE_LIBRARY="${SYSROOT}/lib/libprotobuf-lite.a" \
    -DProtobuf_PROTOC_EXECUTABLE="${SYSROOT}/bin/protoc" \
    -DODBC_CONFIG:STRING="stub-for-wasm" \
    -DODBCLIB:STRING="" \
    -DODBC_CFLAGS:STRING="" \
    -DODBC_LINK_FLAGS:STRING="" \
    -DODBC_LIBRARIES:STRING="" \
    \
    -DHAVE_STRCASECMP=1 \
    -DHAVE_STRNCASECMP=1

# Step 7.1: Compile Embind bindings (after CMake so config.h exists)
# Exposes KiCad objects to JavaScript for future Pyodide integration.
# When no app-specific source exists, build an empty object so the linker line
# referencing ${APP_NAME}_embind.o doesn't break.

# Compile one embind TU with the same includes and ABI-critical flags KiCad uses
# (KICAD_TU_ABI_FLAGS must match the core's -DDEBUG state or vtable dispatch skews —
# task #54). Args: <src> <obj> <app-include-subdir> [extra-defines]
compile_embind_tu() {
    local _src="$1" _obj="$2" _subdir="$3" _defines="${4:-}"

    local _includes="-I${KICAD_BUILD} -I${KICAD_DIR}/include -I${KICAD_DIR}/${_subdir} -I${KICAD_DIR}/common"
    # The editor-frame headers the bindings reach into (libs 0019 F3: the
    # Symbol Editor's open copy) live one level down, like eeschema's own
    # CMake include list (./symbol_editor).
    _includes+=" -I${KICAD_DIR}/${_subdir}/symbol_editor -I${KICAD_DIR}/${_subdir}/widgets"
    # Generated DSN-lexer headers (e.g. pcb_lexer.h, used transitively via kicad_clipboard.h →
    # pcb_io_kicad_sexpr_parser.h) are emitted into the common build subdir by make_lexer.
    _includes+=" -I${KICAD_BUILD}/common"
    _includes+=" -I${KICAD_DIR}/libs/core/include -I${KICAD_DIR}/libs/kimath/include -I${KICAD_DIR}/libs/kiplatform/include"
    _includes+=" -I${KICAD_DIR}/thirdparty/clipper2/Clipper2Lib/include"
    _includes+=" -I${KICAD_DIR}/thirdparty/nlohmann_json"
    _includes+=" -I${KICAD_DIR}/thirdparty/expected/include"
    _includes+=" -I${KICAD_DIR}/thirdparty/rtree"
    _includes+=" -I${KICAD_DIR}/thirdparty/fmt"
    _includes+=" -I${KICAD_DIR}/thirdparty/dynamic_bitset"
    _includes+=" -I${KICAD_DIR}/thirdparty/nanodbc"
    _includes+=" -I${KICAD_DIR}/thirdparty/picosha2"
    _includes+=" -I${KICAD_DIR}/thirdparty"
    # libcontext.h lives one level deeper; tool/coroutine.h does #include <libcontext.h>
    _includes+=" -I${KICAD_DIR}/thirdparty/libcontext"
    _includes+=" -I${SYSROOT}/include"

    # KiCad requires C++20 for concepts
    em++ -std=c++20 -c ${EXTRA_FLAGS} ${KICAD_TU_ABI_FLAGS} ${WX_CXXFLAGS} ${_defines} ${_includes} "${_src}" -o "${_obj}"
}

if [ "${APP_NAME}" = "kicad_editor" ]; then
    # Merged image: both per-editor TUs (with -DKICAD_MERGED_EMBIND compiling out
    # their duplicate definitions / shared-name registrations) + the dispatcher TU
    # registering the shared JS names once (wasm/bindings/kicad_editor_embind.cpp).
    # pcbnew's TU needs the generated lexer headers — pre-build pcbcommon (no wasted
    # work: kicad_editor depends on pcbcommon anyway; incremental no-op).
    log_info "Pre-building pcbcommon so generated lexer headers exist for the embind compile..."
    emmake make -j${JOBS} pcbcommon
    log_info "Compiling merged Embind bindings (pcbnew + eeschema + dispatcher)..."
    compile_embind_tu "${PROJECT_ROOT}/wasm/bindings/pcbnew_embind.cpp" \
                      "${STUBS_BUILD}/pcbnew_embind.o" pcbnew "-DKICAD_MERGED_EMBIND"
    compile_embind_tu "${PROJECT_ROOT}/wasm/bindings/eeschema_embind.cpp" \
                      "${STUBS_BUILD}/eeschema_embind.o" eeschema "-DKICAD_MERGED_EMBIND"
    compile_embind_tu "${PROJECT_ROOT}/wasm/bindings/kicad_editor_embind.cpp" \
                      "${STUBS_BUILD}/kicad_editor_embind.o" common
elif [ -f "${EMBIND_SRC}" ]; then
    # pcbnew's embind TU transitively includes generated lexer headers
    # (kicad_clipboard.h → pcb_io_kicad_sexpr_parser.h → pcb_lexer.h, emitted into
    # ${KICAD_BUILD}/common by make_lexer custom commands on the pcbcommon target).
    # On a fresh build dir they don't exist until make runs — build pcbcommon first.
    # No wasted work: the app target depends on pcbcommon anyway; incremental no-op.
    # Guard on EMBIND_APP (not APP_NAME) so any app whose embind IS pcbnew's also
    # pre-builds pcbcommon.
    if [ "${EMBIND_APP}" = "pcbnew" ]; then
        log_info "Pre-building pcbcommon so generated lexer headers exist for the embind compile..."
        emmake make -j${JOBS} pcbcommon
    fi
    log_info "Compiling Embind bindings (${APP_NAME})..."
    # The include home is the app the BINDINGS belong to, not the artifact
    # subdir — for occ_service the two differ (bindings = pcbnew's; artifacts
    # land in the wasm/occ-service target's own occ_service/ binary dir, which
    # has no KiCad sources).
    case "${EMBIND_APP}" in
        pcbnew)   EMBIND_INC_SUBDIR="pcbnew" ;;
        eeschema) EMBIND_INC_SUBDIR="eeschema" ;;
        *)        EMBIND_INC_SUBDIR="${KICAD_SUBDIR}" ;;
    esac
    compile_embind_tu "${EMBIND_SRC}" "${EMBIND_OBJ}" "${EMBIND_INC_SUBDIR}"
else
    log_info "No embind source for ${APP_NAME} (expected at ${EMBIND_SRC}); using empty placeholder"
    EMPTY_C="${STUBS_BUILD}/${APP_NAME}_embind_empty.c"
    : > "${EMPTY_C}"
    emcc -c "${EMPTY_C}" -o "${EMBIND_OBJ}"
fi

# Step 8: Build the app target
kw_stage kicad-compile
log_info "Building ${APP_NAME} (CMake target: ${KICAD_TARGET})..."

# The embind object (step 7.1) is injected via linker flags, NOT tracked as a CMake/
# make dependency — so when ONLY <app>_embind.cpp changes, make sees no changed source,
# skips the link, and the new bindings silently vanish from the binary. Force a relink
# whenever the freshly-compiled embind object is newer than the linked output.
LINK_OUT_JS="${KICAD_BUILD}/${KICAD_SUBDIR}/${APP_NAME}.js"
LINK_OUT_WASM="${KICAD_BUILD}/${KICAD_SUBDIR}/${APP_NAME}.wasm"
# EMBIND_OBJ may hold several objects (kicad_editor) — check each.
for _embind_obj in ${EMBIND_OBJ}; do
    if [ -f "${_embind_obj}" ] && [ -f "${LINK_OUT_JS}" ] && [ "${_embind_obj}" -nt "${LINK_OUT_JS}" ]; then
        log_info "Embind object newer than ${APP_NAME}.js — forcing relink to pick up new bindings"
        rm -f "${LINK_OUT_JS}" "${LINK_OUT_WASM}"
        break
    fi
done

emmake make -j${JOBS} "${KICAD_TARGET}"

# Step 8.1: Build bitmap resources (images.tar.gz)
# This creates the icon archive that KiCad loads at runtime. The headless
# converter/service targets have no GUI/icons, so skip it.
if [ "${APP_NAME}" != "kicad_tools" ] && [ "${APP_NAME}" != "occ_service" ]; then
    kw_stage kicad-bitmaps
    log_info "Building bitmap resources..."
    emmake make bitmap_archive_build
fi

# Step 8.2: post-link Binaryen pass. emcc only runs wasm-opt at link -O2+
# (link.py: should_run_binaryen_optimizer -> OPT_LEVEL >= 2) and we link at -O1,
# so without this the module gets no Binaryen pass at all and keeps its whole
# name section (measured 19.56 MB, ~20% of the editor wasm — -sJSPI sets
# ASYNCIFY=2, which suppresses wasm-ld's --strip-debug, leaving wasm-opt as the
# only thing that would drop it). Skipped for targets that already link -O2/-Oz
# (occ_service, kicad_tools, ngspice_service): emcc strips target_features when
# it ran the optimizer itself, so there is no hard-coded target list to
# maintain. Feature flags come from the module's own target_features section and
# so cannot drift from the link. Override with KICAD_WASM_OPT ("-Oz" for the
# smallest raw module, "-O2 -g" to keep the name section, "off" to skip).
KICAD_WASM_OPT="${KICAD_WASM_OPT:--O2}"
if [ "${KICAD_WASM_OPT}" != "off" ] && grep -aq "target_features" "${LINK_OUT_WASM}"; then
    kw_stage wasm-opt
    log_info "wasm-opt ${KICAD_WASM_OPT} on ${APP_NAME}.wasm..."
    "${EMSDK:-/emsdk}/upstream/bin/wasm-opt" ${KICAD_WASM_OPT} "${LINK_OUT_WASM}" -o "${LINK_OUT_WASM}.tmp"
    mv -f "${LINK_OUT_WASM}.tmp" "${LINK_OUT_WASM}"
fi

# Step 9: Create stamp file
create_stamp "${KICAD_STAMP}"
log_info "KiCad ${APP_NAME} build complete!"
log_info "Output: ${KICAD_BUILD}/${KICAD_SUBDIR}/${APP_NAME}.js"
