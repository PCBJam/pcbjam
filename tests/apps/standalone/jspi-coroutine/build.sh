#!/bin/bash
# Ad-hoc build for the jspi-coroutine harness (Makefile.wasm wiring in Phase 3).
# Compiles the REAL kicad/thirdparty/libcontext with -DPCBJAM_JSPI.
set -eo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../../../.. && pwd)"
EMXX="${EMXX:-$ROOT/tools/emsdk/upstream/emscripten/em++}"
LIBCTX="$ROOT/kicad/thirdparty/libcontext"

"$EMXX" coroutine_jspi_test.cpp "$LIBCTX/libcontext.cpp" \
  -I"$LIBCTX" \
  -DPCBJAM_JSPI=1 \
  -O1 \
  -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1 \
  -sJSPI -sJSPI_EXPORTS=pcbjam_libctx_entry,main \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web \
  -sALLOW_MEMORY_GROWTH=1 \
  -o coroutine_jspi_test.mjs

echo "built: coroutine_jspi_test.mjs"
