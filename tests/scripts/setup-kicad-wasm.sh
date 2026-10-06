#!/bin/bash
# Copies KiCad WASM build output to test directory
#
# Priority: Use local output/ directory (populated by docker/build.sh)
# Fallback: Copy from Docker volume directly
#
# Copies whichever apps are present (pcbnew, eeschema, calculator).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

KICAD_TEST="$PROJECT_ROOT/tests/apps/kicad"
OUTPUT_DIR="$PROJECT_ROOT/output"

mkdir -p "$KICAD_TEST"

# Smart copy: skip when the destination already exists and is byte-identical to
# the source (cmp -s is portable across macOS/Linux). Makes this a real sync —
# re-running does not rewrite unchanged multi-hundred-MB .wasm files.
smart_cp() {
    local src="$1" destdir="$2"
    [ -f "$src" ] || return 0
    local dst="$destdir/$(basename "$src")"
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
        echo "  = $(basename "$src") (up-to-date)"
        return 0
    fi
    cp "$src" "$dst"
    echo "  + $(basename "$src")"
}

# Map an app name to its inner CMake build subdirectory. Most apps share their
# subdir name with the app name; pcb_calculator emits OUTPUT_NAME=calculator
# but lives under the pcb_calculator/ subtree of the build dir, and pl_editor's
# source lives under pagelayout_editor/.
kicad_subdir_for() {
    case "$1" in
        calculator)       echo "pcb_calculator" ;;
        pl_editor)        echo "pagelayout_editor" ;;
        *)                echo "$1" ;;
    esac
}

# Copy one app's artifacts (js, wasm, optional debug/map/worker). Returns 0
# if the app was present, 1 if neither output/ nor the docker volume has it.
copy_app() {
    local app="$1"
    local subdir
    subdir=$(kicad_subdir_for "$app")

    if [ -f "$OUTPUT_DIR/${app}.js" ] && [ -f "$OUTPUT_DIR/${app}.wasm" ]; then
        echo "Syncing ${app} WASM files from output directory..."
        smart_cp "$OUTPUT_DIR/${app}.js" "$KICAD_TEST"
        smart_cp "$OUTPUT_DIR/${app}.wasm" "$KICAD_TEST"
        smart_cp "$OUTPUT_DIR/${app}.wasm.map" "$KICAD_TEST"
        smart_cp "$OUTPUT_DIR/${app}.worker.js" "$KICAD_TEST"
        smart_cp "$OUTPUT_DIR/images.tar.gz" "$KICAD_TEST"
        return 0
    fi

    echo "Output ${app} not found locally, trying Docker volume..."
    if docker compose -f "$PROJECT_ROOT/docker/docker-compose.yml" cp \
         kicad-wasm-builder:/workspace/build-wasm/kicad-${app}/${subdir}/${app}.js "$KICAD_TEST/" 2>/dev/null \
       && docker compose -f "$PROJECT_ROOT/docker/docker-compose.yml" cp \
         kicad-wasm-builder:/workspace/build-wasm/kicad-${app}/${subdir}/${app}.wasm "$KICAD_TEST/" 2>/dev/null; then
        docker compose -f "$PROJECT_ROOT/docker/docker-compose.yml" cp \
            kicad-wasm-builder:/workspace/build-wasm/kicad-${app}/${subdir}/${app}.wasm.map "$KICAD_TEST/" 2>/dev/null || true
        docker compose -f "$PROJECT_ROOT/docker/docker-compose.yml" cp \
            kicad-wasm-builder:/workspace/build-wasm/kicad-${app}/${subdir}/${app}.worker.js "$KICAD_TEST/" 2>/dev/null || true
        docker compose -f "$PROJECT_ROOT/docker/docker-compose.yml" cp \
            kicad-wasm-builder:/workspace/build-wasm/kicad-${app}/resources/images.tar.gz "$KICAD_TEST/" 2>/dev/null || true
        return 0
    fi

    echo "  (no ${app} artifacts found — skipping)"
    return 1
}

found_any=0
# The four editors (pcbnew / eeschema / footprint_editor / symbol_editor) are ALL
# served by the ONE merged kicad_editor bundle: their harness HTMLs load
# kicad_editor.js and select the frame at runtime via --frame (editor-unification
# Part 2).
copy_app kicad_editor     && found_any=1
copy_app calculator       && found_any=1
copy_app pl_editor        && found_any=1
copy_app gerbview         && found_any=1
# OCC 3D service (lazy worker module; pcbnew's STEP export + model parsing)
copy_app occ_service      || true
# ngspice simulation service (lazy worker module; eeschema's simulator)
copy_app ngspice_service  || true

if [ "$found_any" -eq 0 ]; then
    echo "Error: no kicad_editor/calculator/pl_editor/gerbview artifacts found in output/ or docker volume" >&2
    exit 1
fi

# wxWidgets WASM JavaScript glue code (defines JS functions called from WASM)
echo "Syncing wxWidgets WASM glue code..."
if [ -f "$OUTPUT_DIR/wx.js" ]; then
    smart_cp "$OUTPUT_DIR/wx.js" "$KICAD_TEST"
else
    if docker compose -f "$PROJECT_ROOT/docker/docker-compose.yml" cp \
      kicad-wasm-builder:/workspace/wxwidgets/build/wasm/wx.js "$KICAD_TEST/" 2>/dev/null; then
        :
    else
        smart_cp "$PROJECT_ROOT/wxwidgets/build/wasm/wx.js" "$KICAD_TEST"
    fi
fi

# The control-layer shim loads after wx.js (the checked-in kicad pages
# reference both via <script> tags).
if [ -f "$OUTPUT_DIR/wx-dom.js" ]; then
    smart_cp "$OUTPUT_DIR/wx-dom.js" "$KICAD_TEST"
else
    smart_cp "$PROJECT_ROOT/wxwidgets/build/wasm/wx-dom.js" "$KICAD_TEST"
fi

# Demo board for the gerbview print test (tests/apps/kicad/gerbview-print.html).
# Provisioned (not committed; gitignored) from tests/fixtures/gerber-demo-board,
# a copy of the www.pcbjam.com Gerber demo's board, same pattern as the wasm
# artifacts above. gerbview-print.html fetches the subset of layers it needs
# from ./board/, so copying the whole set is harmless.
BOARD_SRC="$PROJECT_ROOT/tests/fixtures/gerber-demo-board"
if [ -d "$BOARD_SRC" ]; then
    echo "Provisioning gerbview demo board..."
    mkdir -p "$KICAD_TEST/board"
    for f in "$BOARD_SRC"/tinytapeout-demo-*; do
        smart_cp "$f" "$KICAD_TEST/board"
    done
else
    echo "  (demo board source $BOARD_SRC not found — skipping)"
fi

echo "KiCad WASM files synced to $KICAD_TEST"
ls -lh "$KICAD_TEST"
