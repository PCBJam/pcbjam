#!/bin/bash
# Ad-hoc build for the jspi-coroutine harness (Makefile.wasm wiring in Phase 3).
# Compiles the REAL kicad/thirdparty/libcontext (JSPI backend).
set -eo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../../../.. && pwd)"
EMXX="${EMXX:-$ROOT/tools/emsdk/upstream/emscripten/em++}"
LIBCTX="$ROOT/kicad/thirdparty/libcontext"

COMMON=(
  -I"$LIBCTX"
  -O1
  -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1
  -sJSPI -sJSPI_EXPORTS=pcbjam_libctx_entry,main
  -sMODULARIZE=1 -sEXPORT_ES6=1
  -sALLOW_MEMORY_GROWTH=1
)

"$EMXX" coroutine_jspi_test.cpp "$LIBCTX/libcontext.cpp" "${COMMON[@]}" \
  -sENVIRONMENT=node,web \
  -o coroutine_jspi_test.mjs

# pthread variant (index.html?pt=1 / run_pt.mjs) — same battery with the
# pthread runtime linked, mirroring jspi-stack's *_pt build.
"$EMXX" coroutine_jspi_test.cpp "$LIBCTX/libcontext.cpp" "${COMMON[@]}" \
  -pthread -sPTHREAD_POOL_SIZE=2 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sENVIRONMENT=node,web,worker \
  -o coroutine_jspi_test_pt.mjs

echo "built: coroutine_jspi_test.mjs + coroutine_jspi_test_pt.mjs"
