#!/bin/bash
# Post-process the Emscripten-generated <app>.js for KiCad WASM (pcbnew, eeschema,
# pl_editor, calculator, …).
#
# The actual JavaScript that gets injected lives in readable, standalone files in
# scripts/common/shims/ (not inline heredocs):
#   - asyncify-scheduler.js    the mailbox/scheduler (docs/features/async/17) —
#                              the ONLY asyncify runtime (the legacy handlesleep.js
#                              opt-out was deleted at doc 20 D-1)
#   - diagnostics.js           optional logging-only instrumentation (see SHIM_DIAGNOSTICS)
#
# Native wasm-EH is the only build mode, so the .js has no invoke_* wrappers / dynCall_<sig> call
# sites to bind. The build still links -sDYNCALLS=1, so asyncify-INSTRUMENTED dynCall_* trampolines
# exist as wasm EXPORTS; the empty-callback fixes below route function-pointer stubs through
# wasmExports["dynCall_<sig>"]. This MUST be the wasm trampoline, NOT getWasmTableEntry — the latter
# bypasses the instrumentation and breaks unwind/rewind through indirect calls ("indirect call
# signature mismatch" — caught every frame in Firefox; a hard renderer crash in Chrome/V8).
#
# Usage:
#   inject-dyncall-shims.sh <pcbnew.js>
#   SHIM_DIAGNOSTICS=1 inject-dyncall-shims.sh <pcbnew.js>   # also inject diagnostics.js

set -e

JS_FILE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM_DIR="$SCRIPT_DIR/shims"

# One-line toggle for the diagnostics module (default OFF).
SHIM_DIAGNOSTICS="${SHIM_DIAGNOSTICS:-0}"

if [ -z "$JS_FILE" ] || [ ! -f "$JS_FILE" ]; then
    echo "Error: JS file not found: $JS_FILE"
    echo "Usage: $0 <path/to/pcbnew.js>"
    exit 1
fi
for f in asyncify-scheduler.js diagnostics.js; do
    if [ ! -f "$SHIM_DIR/$f" ]; then
        echo "Error: missing shim source $SHIM_DIR/$f"
        exit 1
    fi
done

# --- 1. Empty-callback fixes ---------------------------------------------------
# Emscripten+pthreads emits some direct-call paths as no-op ((a1)=>{}) stubs that ARE used. Native
# wasm-EH eliminates the invoke_* wrappers, so the .js has no dynCall_<sig> call sites to bind — but
# the DYNCALLS=1 trampolines are still EXPORTED on the wasm, so route each function-pointer stub
# through wasmExports["dynCall_<sig>"]. This MUST be the wasm trampoline, NOT getWasmTableEntry: the
# fiber entry runs a coroutine that suspends+rewinds via Asyncify, and an Asyncify rewind cannot
# resume through getWasmTableEntry's JS wrapper — the fiber would re-enter from the top and the tool's
# Wait() re-runs (tool_manager ScheduleWait "!pendingWait" assert + busy-loop). The instrumented
# dynCall_<sig> export rewinds correctly. (Without these fixes the libcontext fiber entry stays the
# empty (a1=>{}) stub, so tool coroutines never start and every GAL app stalls at InvokeTool.)
#
# With ASSERTIONS enabled, Emscripten emits a throwing fiber-entry stub instead of the empty stub if
# wasm-emscripten-finalize did not add dynCall_vi. Do not rewrite that to a direct table call: table
# entries are not Asyncify-instrumented exports and cannot be used as the rewind entry. Reject the
# artifact at build time with the actual toolchain diagnosis.
FIBER_DYNCALL_ERROR='Attempted to invoke wasm function pointer with signature "vi", but no such functions have gotten exported!'
if grep -qF "$FIBER_DYNCALL_ERROR" "$JS_FILE"; then
    echo "ERROR: Emscripten fiber glue has no dynCall_vi export in $JS_FILE" >&2
    echo "ERROR: wasm-emscripten-finalize must be real during the em++ link (not the large-app no-op stub)" >&2
    exit 1
fi

echo "Fixing empty callback arrow functions..."
TOTAL_FIXED=0
apply_fix() { # <grep/sed pattern> <sed replacement> <label>
    local before; before=$(grep -c "$1" "$JS_FILE" || true)
    if [ "$before" -gt 0 ]; then
        # Portable in-place edit (BSD `sed -i ''` and GNU `sed -i` differ; temp+mv works on both).
        sed "s/$1/$2/g" "$JS_FILE" > "${JS_FILE}.sedtmp" && mv "${JS_FILE}.sedtmp" "$JS_FILE"
        local after; after=$(grep -c "$1" "$JS_FILE" || true)
        echo "  Fixed $((before - after)) $3"
        TOTAL_FIXED=$((TOTAL_FIXED + before - after))
    fi
}
apply_fix '((a1, a2, a3) => {})(eventTypeId,' '((a1, a2, a3) => wasmExports["dynCall_iiii"](callbackfunc, a1, a2, a3))(eventTypeId,' "HTML5 event callback(s) (wasmExports.dynCall_iiii)"
apply_fix 'var result = (a1 => {})(arg);' 'var result = wasmExports["dynCall_ii"](ptr, arg);' "pthread entry callback(s) (wasmExports.dynCall_ii)"
apply_fix 'return (a1 => {})(sig);' 'return wasmExports["dynCall_vi"](fp, sig);' "signal handler callback(s) (wasmExports.dynCall_vi)"
apply_fix 'var wrapper = () => (a1 => {})(arg);' 'var wrapper = () => wasmExports["dynCall_vi"](func, arg);' "async timer callback(s) (wasmExports.dynCall_vi)"
apply_fix 'var iterFunc = (() => {});' 'var iterFunc = () => wasmExports["dynCall_v"](func);' "main loop callback(s) (wasmExports.dynCall_v)"
apply_fix '(a1 => {})(userData);' 'wasmExports["dynCall_vi"](entryPoint, userData);' "fiber entry callback(s) (wasmExports.dynCall_vi)"
echo "Total: Fixed $TOTAL_FIXED empty callback(s)"

# --- 3. Asyncify scheduler shim ------------------------------------------------
# Injected after Emscripten's fiber glue (the _emscripten_fiber_swap.isAsync marker),
# or at EOF for non-fiber apps (a plain wx app still needs the currData machinery:
# without it a rewind resuming through a fresh wasm re-entry hits
# _asyncify_start_rewind(null) -> "memory access out of bounds").
#
# asyncify-scheduler.js (docs/features/async/17) is the ONLY asyncify runtime:
# it owns the currData capture/restore, fiber guard, and trampoline heal, and
# adds the deferred-wake drain + N1 single-writer tripwire + the mailbox/wait
# lanes. The legacy handlesleep.js opt-out (WX_SCHEDULER=0) and the ablation
# skip (SHIM_DISABLE_HANDLESLEEP) were deleted at doc 20 D-1 together with the
# wx C++ paths they exercised.
inject_shim_at_marker() { # <shim file> <label>
    local shim_file="$1" label="$2"
    local marker
    marker=$(grep -n '^_emscripten_fiber_swap\.isAsync = true;$' "$JS_FILE" | head -1 | cut -d: -f1)
    if [ -z "$marker" ]; then
        echo "" >> "$JS_FILE"
        cat "$SHIM_DIR/$shim_file" >> "$JS_FILE"
        echo "Injected $label at EOF (no fiber glue)"
    else
        head -n "$marker" "$JS_FILE" > "${JS_FILE}.tmp"
        echo "" >> "${JS_FILE}.tmp"
        cat "$SHIM_DIR/$shim_file" >> "${JS_FILE}.tmp"
        tail -n +$((marker + 1)) "$JS_FILE" >> "${JS_FILE}.tmp"
        mv "${JS_FILE}.tmp" "$JS_FILE"
        echo "Injected $label after line $marker"
    fi
}

# NOTE: idempotence via the shim-source sentinel, not __wxSchedulerInstalled —
# that string also appears in evtloop.cpp's EM_JS probe inside every glue.
if grep -q '__WX_SCHEDULER_SHIM_SOURCE__' "$JS_FILE"; then
    echo "asyncify-scheduler already present - skipping"
else
    inject_shim_at_marker asyncify-scheduler.js "asyncify-scheduler"
fi

# --- 3b. embind dynCall fallback (dynCallLegacy -> wasmExports) ----------------
# embind's generic caller (getDynCaller) routes through dynCallLegacy, which only
# reads Module["dynCall_<sig>"]. But the DYNCALLS=1 trampolines are wasm EXPORTS,
# not Module properties, so that lookup is undefined and an Asyncify unwind/rewind
# through an embind call (e.g. kicadOpenFile -> OpenProjectFiles) dies with
# "f is not a function" in Asyncify.doRewind. Add a wasmExports fallback so the
# instrumented trampoline is found and rewind survives.
if grep -q 'embind dynCall fallback installed' "$JS_FILE"; then
    echo "dynCallLegacy fallback already present - skipping"
elif grep -qF '  var f = Module["dynCall_" + sig];' "$JS_FILE"; then
    perl -0pi -e 's/(\Q  var f = Module["dynCall_" + sig];\E)/$1\n  \/\/ embind dynCall fallback installed: DYNCALLS=1 trampolines live on wasmExports, not Module.\n  if (!f && typeof wasmExports !== "undefined") f = wasmExports["dynCall_" + sig];/' "$JS_FILE"
    echo "Injected dynCallLegacy wasmExports fallback"
else
    echo "Warning: dynCallLegacy pattern not found - skipping embind dynCall fallback"
fi

# --- 3d. Embind invoker: don't Promise-wrap a SYNCHRONOUS nested call ------------------------------
# Emscripten's invoker returns a Promise iff Asyncify.currData is set AFTER the wasm call. The
# scheduler can restore another physical context's saved currData around a nested native entry, so a
# synchronous snapshot/control export can otherwise be mis-detected as async and return
# "[object Promise]". Capture currData before the call and only treat it as async if THIS call leaves
# a NEW buffer. The execution-owner gateway controls whether that entry is allowed in the first place.
if grep -q 'Asyncify.currData !== __ehPrev' "$JS_FILE"; then
    echo "embind invoker currData re-entrancy fix already present - skipping"
elif grep -q 'return Asyncify.currData ? Asyncify.whenDone' "$JS_FILE"; then
    perl -0pi -e 's/(invokerFnBody \+= \(returns \|\| isAsync \? "var rv = " : ""\))/invokerFnBody += "var __ehPrev = Asyncify.currData;\\n";\n  $1/' "$JS_FILE"
    perl -0pi -e 's/return Asyncify\.currData \? Asyncify\.whenDone/return (Asyncify.currData && Asyncify.currData !== __ehPrev) ? Asyncify.whenDone/' "$JS_FILE"
    echo "Injected embind invoker currData re-entrancy fix"
else
    echo "Warning: embind invoker currData pattern not found - skipping embind re-entrancy fix"
fi

# --- 3c. Fiber trampoline self-heal -------------------------------------------
# Any exception or internal Asyncify unwind that crosses Emscripten's generated fiber trampoline can
# skip its plain `trampolineRunning = false` tail. The flag then stays true and every later fiber swap
# becomes a no-op. The wx main loop now starts on a detached scheduler context, so its startup no
# longer creates this topology; other generated-fiber clients still require exception-safe cleanup.
# Wrap the loop in try/finally so the generated guard always resets.
# (The SHIM_DISABLE_TRAMPOLINE_HEAL ablation skip was deleted at doc 20 D-1
# with the races_test_noheal build that used it.)
if grep -qF '} finally { Fibers.trampolineRunning = false; }' "$JS_FILE"; then
    echo "fiber trampoline self-heal already present - skipping"
elif grep -qF 'Fibers.trampolineRunning = true;' "$JS_FILE"; then
    perl -0pi -e 's/(Fibers\.trampolineRunning = true;)(\s*)(do \{.*?\} while \(Fibers\.nextFiber\);)(\s*)(Fibers\.trampolineRunning = false;)/$1$2try {$3} finally { $5 }/s' "$JS_FILE"
    echo "Injected fiber trampoline self-heal (try/finally)"
else
    echo "Warning: Fibers.trampoline pattern not found - skipping trampoline self-heal"
fi

# --- 4. Optional diagnostics (logging only) -----------------------------------
if [ "$SHIM_DIAGNOSTICS" = "1" ]; then
    if grep -q 'DIAG] Asyncify/fiber/modal diagnostics installed' "$JS_FILE"; then
        echo "diagnostics already present - skipping"
    else
        echo "" >> "$JS_FILE"
        cat "$SHIM_DIR/diagnostics.js" >> "$JS_FILE"
        echo "Appended diagnostics module (SHIM_DIAGNOSTICS=1)"
    fi
else
    echo "diagnostics disabled (set SHIM_DIAGNOSTICS=1 to enable)"
fi
