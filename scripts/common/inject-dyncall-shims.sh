#!/bin/bash
# Post-process the Emscripten-generated <app>.js for KiCad WASM (pcbnew, eeschema,
# pl_editor, calculator, …).
#
# The actual JavaScript that gets injected lives in readable, standalone files in
# scripts/common/shims/ (not inline heredocs):
#   - handlesleep.js           nested-Asyncify handleSleep currData save/restore (#9153)
#   - asyncify-scheduler.js    WX_SCHEDULER=1 builds only: the mailbox/scheduler
#                              (docs/features/async/17; S0 = observation-only skeleton)
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
#   WX_SCHEDULER=1 inject-dyncall-shims.sh <pcbnew.js>       # also inject the scheduler (dual-glue variant)

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
for f in handlesleep.js asyncify-scheduler.js diagnostics.js; do
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

# --- 3. Asyncify shim: legacy handleSleep fix OR the S2 scheduler --------------
# Injected after Emscripten's fiber glue (the _emscripten_fiber_swap.isAsync marker),
# or at EOF for non-fiber apps (a plain wx app still needs the currData machinery:
# without it a rewind resuming through a fresh wasm re-entry hits
# _asyncify_start_rewind(null) -> "memory access out of bounds").
#
# WX_SCHEDULER=1 (doc 17 S2): asyncify-scheduler.js REPLACES handlesleep.js — it
# subsumes the capture/restore, fiber guard, and trampoline heal, and adds the
# deferred-wake drain + N1 single-writer tripwire. Injecting BOTH would
# double-manage the wake path (the scheduler refuses to install its core then).
#
# SHIM_DISABLE_HANDLESLEEP=1 skips the legacy shim: the asyncify-races red-green
# harness uses it to keep the historical "sleep buffer clobbered by fiber swap"
# crash reproducible. On WX_SCHEDULER=1 builds the variant still gets the
# scheduler — the ablation pins become scheduler-subsumption pins (doc 17 §3c).
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

if [ "${WX_SCHEDULER:-0}" = "1" ]; then
    # NOTE: idempotence via the shim-source sentinel, not __wxSchedulerInstalled —
    # that string also appears in evtloop.cpp's EM_JS probe inside every glue.
    if grep -q '__WX_SCHEDULER_SHIM_SOURCE__' "$JS_FILE"; then
        echo "asyncify-scheduler already present - skipping"
    else
        inject_shim_at_marker asyncify-scheduler.js "asyncify-scheduler (replaces handlesleep; WX_SCHEDULER=1)"
    fi
elif [ "${SHIM_DISABLE_HANDLESLEEP:-0}" = "1" ]; then
    echo "handleSleep fix DISABLED (SHIM_DISABLE_HANDLESLEEP=1) - ablation build"
elif grep -q '__nestedHandleSleepInstalled' "$JS_FILE"; then
    echo "handleSleep fix already present - skipping"
else
    inject_shim_at_marker handlesleep.js "handleSleep fix"
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

# --- 3d. Embind invoker: don't Promise-wrap a SYNCHRONOUS call when the main loop is parked --------
# Emscripten's embind invoker returns a Promise iff Asyncify.currData is set AFTER the wasm call. But
# the native-EH per-frame-yield main loop parks via Asyncify (currData stays SET between frames), so a
# JS-initiated embind call (e.g. kicadCollabSnapshot from a test or the UI) that does NOT itself
# suspend is mis-detected as async and returns "[object Promise]" instead of the value -> the caller's
# JSON.parse(...) gets "[object Promise]". Capture currData before the call and only treat it as async
# if THIS call left a NEW currData. Harmless under legacy/JS-EH (currData is null when the app is idle).
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
# emscripten_set_main_loop(...,1) throws "unwind" during startup to establish the
# main loop. KiCad establishes that loop from inside a tool coroutine, so the throw
# propagates THROUGH Fibers.trampoline()'s do/while, skipping its
# `trampolineRunning = false` reset. The flag then stays true forever and
# Fibers.trampoline() becomes a permanent no-op (guard: `if (!trampolineRunning ...)`),
# so every later fiber swap silently fails to switch — the schematic load and all
# post-idle tool actions hang. Wrap the loop in try/finally so the flag is always
# reset (self-healing).
# SHIM_DISABLE_TRAMPOLINE_HEAL=1 skips it: used by the asyncify-races red-green
# harness to keep the historical "park throw wedges the trampoline guard" hang
# reproducible.
if [ "${SHIM_DISABLE_TRAMPOLINE_HEAL:-0}" = "1" ]; then
    echo "fiber trampoline self-heal DISABLED (SHIM_DISABLE_TRAMPOLINE_HEAL=1) - ablation build"
elif grep -qF '} finally { Fibers.trampolineRunning = false; }' "$JS_FILE"; then
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
