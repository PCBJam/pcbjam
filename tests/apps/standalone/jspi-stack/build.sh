#!/bin/bash
# Ad-hoc build for the jspi-stack harness (Makefile.wasm wiring lands in Phase 3).
# Uses the worktree-local emsdk (tools/emsdk, 6.0.6). EH flags mirror production.
set -eo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../../../.. && pwd)"
EMCC="${EMCC:-$ROOT/tools/emsdk/upstream/emscripten/em++}"

COMMON=(
  -O1
  -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=1
  -sJSPI -sJSPI_EXPORTS=activation
  -sEXPORTED_RUNTIME_METHODS=stackSave,stackRestore,HEAPU8
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web,worker
  -sALLOW_MEMORY_GROWTH=1
)

"$EMCC" stack_test.cpp -o stack_test.mjs "${COMMON[@]}" \
  -sEXPORTED_FUNCTIONS=_activation,_stomp,_stack_current,_stack_base,_stack_end,_main,_malloc,_free

"$EMCC" stack_test.cpp -o stack_test_pt.mjs "${COMMON[@]}" \
  -pthread -sPTHREAD_POOL_SIZE=2 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sEXPORTED_FUNCTIONS=_activation,_stomp,_stack_current,_stack_base,_stack_end,_main,_malloc,_free,_start_churn,_stop_churn

echo "built: stack_test.mjs + stack_test_pt.mjs"
