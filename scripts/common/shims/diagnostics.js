// === Asyncify / fiber / modal diagnostics (LOGGING ONLY — no behavior change) ===
//
// Injected only when inject-dyncall-shims.sh runs with SHIM_DIAGNOSTICS=1.
// Observability for the Chrome/V8 renderer crash on the first coroutine resume
// (the main-context Asyncify rewind). Does NOT swallow or alter any call — it
// logs and traces, then delegates, so the real crash still happens and can be
// observed right up to the faulting point.
(function() {
  var modalActive = false;
  var glTraceActive = false;   // armed at the first main rewind (rewindId===0) below
  var glCallSeq = 0;
  var glTraceCap = 8000;       // safety cap so a non-crashing run can't log forever
  var tableLen = function() { return (typeof wasmTable !== "undefined" && wasmTable) ? wasmTable.length : -1; };
  var asyncState = function() { return (typeof Asyncify !== "undefined") ? Asyncify.state : "N/A"; };

  // 1. Timer scheduling — flag function pointers already out of bounds at schedule time.
  if (typeof _emscripten_async_call !== "undefined") {
    var __origAsyncCall = _emscripten_async_call;
    _emscripten_async_call = function(func, arg, millis) {
      var inBounds = func >= 0 && func < tableLen();
      console.log("[DIAG_ASYNC_CALL] func=" + func + " arg=" + arg + " millis=" + millis +
                   " inBounds=" + inBounds + " modalActive=" + modalActive + " state=" + asyncState());
      if (!inBounds) { console.log("[DIAG_ASYNC_CALL] OUT OF BOUNDS at schedule time! func=" + func); console.trace(); }
      return __origAsyncCall(func, arg, millis);
    };
  }

  // 2. Rewind target selection — which export Asyncify will re-enter on rewind.
  if (typeof Asyncify !== "undefined" && Asyncify.setDataRewindFunc) {
    var __origSetRewind = Asyncify.setDataRewindFunc.bind(Asyncify);
    Asyncify.setDataRewindFunc = function(ptr, forced) {
      console.log("[DIAG_REWIND_FUNC] ptr=" + ptr + " forced=" + forced + " state=" + Asyncify.state +
                   " modalActive=" + modalActive + " callStack=" + JSON.stringify(Asyncify.exportCallStack));
      return __origSetRewind(ptr, forced);
    };
  }

  // 3. doRewind — the actual rewind that crashes V8. Log the buffer + saved rewind id
  //    immediately before re-entering wasm, so the last line before the crash names it.
  if (typeof Asyncify !== "undefined" && typeof Asyncify.doRewind === "function") {
    var __origDoRewind = Asyncify.doRewind.bind(Asyncify);
    var heap32 = function () { return (typeof GROWABLE_HEAP_I32 === "function") ? GROWABLE_HEAP_I32() : HEAP32; };
    Asyncify.doRewind = function(ptr) {
      var H = heap32();
      var rd = function (off) { try { return H[((ptr + off) >> 2)]; } catch (e) { return -999; } };
      // asyncify_data layout: [ptr+0]=current stack pos (top of saved data),
      // [ptr+4]=stack end, [ptr+8]=rewindId. Saved call-index/locals live below [ptr+0].
      var curPos = rd(0), stackEnd = rd(4), rewindId = rd(8);
      var name = (Asyncify.callStackIdToName && Asyncify.callStackIdToName[rewindId]) || "?";
      var usedBytes = curPos - (ptr + 12);
      console.log("[DIAG_DOREWIND] ptr=" + ptr + " rewindId=" + rewindId + " (" + name + ")" +
                   " curPos=" + curPos + " stackEnd=" + stackEnd + " usedBytes=" + usedBytes +
                   " state=" + asyncState() + " — re-entering wasm now");
      // Arm the WebGL tracer exactly at the main rewind (the crash window: the silent V8
      // abort happens right after this rewind returns to main, before coroutine #2/first paint).
      if (rewindId === 0 && !glTraceActive) {
        glTraceActive = true;
        console.log("[DIAG_GL] tracing ARMED at main rewind (rewindId=0)");
      }
      // Dump the saved call-index chain (first words of the buffer) so we can see the
      // depth/shape of what the rewind replays at the crash.
      try {
        var words = [];
        var start = ptr + 12;
        for (var a = start; a < curPos && a < start + 256; a += 4) words.push(H[(a >> 2)]);
        console.log("[DIAG_DOREWIND] saved-data[" + words.length + "w]: " + JSON.stringify(words));
      } catch (e) {}
      try {
        return __origDoRewind(ptr);
      } catch (e) {
        console.log("[DIAG_DOREWIND] EXCEPTION during rewind: " + e + " | " + (e && e.stack));
        throw e;
      }
    };
  }

  // 4. dynCall_vi — log (and trace) out-of-bounds pointers but DO NOT swallow; call through.
  if (typeof dynCall_vi === "function") {
    var __origDynCallVi = dynCall_vi;
    dynCall_vi = function(index, a0) {
      if (index < 0 || index >= tableLen()) {
        console.log("[DIAG_DYNCALL_VI] OUT OF BOUNDS index=" + index + " tableLen=" + tableLen() +
                      " modalActive=" + modalActive + " state=" + asyncState());
        console.trace();
      }
      return __origDynCallVi(index, a0);
    };
  }

  // 5. Modal lifecycle: poll the scheduler wait registry ("modal" waits).
  //    (The legacy Module._endModal hook was deleted at doc 20 D-1.)
  if (typeof Module !== "undefined") {
    var lastModalWaits = 0;
    setInterval(function() {
      var S = globalThis.__wxScheduler;
      if (!S || typeof S.pendingWaits !== "function") return;
      var n = S.pendingWaits("modal");
      if (n !== lastModalWaits) {
        console.log("[DIAG_MODAL] modal waits " + lastModalWaits + " -> " + n +
                    ", state=" + asyncState());
        modalActive = n > 0;
        lastModalWaits = n;
      }
    }, 100);
  }

  // 6. EM_ASYNC_JS sleeps (wxWasmYieldUntilJs, js_enumerateFonts, clipboard, etc.) — log
  //    enter/wake so we can see whether an async sleep is NESTED with a fiber swap
  //    at the crash (the #9153 collision). Logging only; delegates unchanged.
  if (typeof Asyncify !== "undefined" && typeof Asyncify.handleSleep === "function") {
    var __diagOrigHandleSleep = Asyncify.handleSleep.bind(Asyncify);
    var diagSleepId = 0;
    Asyncify.handleSleep = function(startAsync) {
      var id = ++diagSleepId;
      console.log("[DIAG_SLEEP] ENTER id=" + id + " state=" + asyncState() +
                   " currData=" + ((typeof Asyncify.currData !== "undefined" && Asyncify.currData) || "null"));
      return __diagOrigHandleSleep(function(wakeUp) {
        return startAsync(function(result) {
          console.log("[DIAG_SLEEP] WAKE id=" + id + " state=" + asyncState() +
                       " currData=" + ((typeof Asyncify.currData !== "undefined" && Asyncify.currData) || "null"));
          return wakeUp(result);
        });
      });
    };
  }

  // 7. WebGL call tracer — pinpoint the exact GL op that crashes Chrome's renderer.
  //    KiCad runs the GAL on an OffscreenCanvas in the pthread worker (PROXY_TO_PTHREAD +
  //    OFFSCREENCANVAS_SUPPORT), and this diagnostics code runs in that same worker, so we
  //    hook getContext where the context is actually created. Each call logs via
  //    console.error (immediate flush → captured even just before a hard V8 abort), but
  //    only once glTraceActive is set (at the main rewind), so volume = the crash window.
  function wrapGLContext(ctx, kind) {
    if (!ctx) return ctx;
    try { if (ctx.__diagWrapped) return ctx; ctx.__diagWrapped = true; } catch (e) {}
    console.log("[DIAG_GL] context created kind=" + kind);
    return new Proxy(ctx, {
      get: function(target, prop) {
        var val = target[prop];
        if (typeof val === "function") {
          return function() {
            if (glTraceActive && glCallSeq < glTraceCap) {
              console.log("[DIAG_GL] #" + (++glCallSeq) + " " + String(prop));
            }
            return val.apply(target, arguments);
          };
        }
        return val;
      }
    });
  }
  function hookGetContext(proto, kind) {
    if (!proto || typeof proto.getContext !== "function" || proto.__diagGCHooked) return;
    proto.__diagGCHooked = true;
    var orig = proto.getContext;
    proto.getContext = function(type) {
      // Log the ATTEMPT before calling through, so if getContext itself crashes the
      // renderer (e.g. a Chrome/ANGLE WebGL-context bug) this is the last line we see.
      if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") {
        var attrs = "";
        try { attrs = JSON.stringify(arguments[1] || {}); } catch (e) {}
        console.log("[DIAG_GL] getContext(" + kind + ":" + type + ") attrs=" + attrs + " — calling through now");
      }
      var ctx = orig.apply(this, arguments);
      if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") {
        console.log("[DIAG_GL] getContext returned " + (ctx ? "a context" : "NULL"));
        try { return wrapGLContext(ctx, kind + ":" + type); } catch (e) { return ctx; }
      }
      return ctx;
    };
  }
  if (typeof OffscreenCanvas !== "undefined") hookGetContext(OffscreenCanvas.prototype, "offscreen");
  if (typeof HTMLCanvasElement !== "undefined") hookGetContext(HTMLCanvasElement.prototype, "html");

  // 8. dynCall_ii / dynCall_vi invocation tracer (logging only). The shim routes the
  //    pthread-entry (ii) and fiber-entry/signal/timer (vi) callbacks through these bound
  //    instrumented dynCall_<sig>. Wrap them to log each invocation + the function pointer,
  //    armed at the main rewind (glTraceActive) so volume = the crash window. The LAST line
  //    before the silent crash names the faulting dispatch + its ptr. Tag thread for context.
  var __thr = (typeof ENVIRONMENT_IS_PTHREAD !== "undefined" && ENVIRONMENT_IS_PTHREAD) ? "worker" : "main";
  var __fnName = function(ptr) {
    try { var f = getWasmTableEntry(ptr); return (f && f.name) ? f.name : "?"; } catch (e) { return "?err"; }
  };
  try {
    if (typeof dynCall_ii === "function") {
      var __origDCii = dynCall_ii;
      dynCall_ii = function(ptr, a0) {
        if (glTraceActive && glCallSeq < glTraceCap)
          console.log("[DIAG_DC] " + __thr + " dynCall_ii ptr=" + ptr + " name=" + __fnName(ptr) + " #" + (++glCallSeq));
        return __origDCii(ptr, a0);
      };
    }
  } catch (e) {}
  try {
    if (typeof dynCall_vi === "function") {
      var __origDCvi = dynCall_vi;
      var __asy = function() {
        if (typeof Asyncify === "undefined") return "noAsyncify";
        var st = Asyncify.state;
        var cd = (Asyncify.currData || 0);
        return "state=" + st + " currData=" + cd;
      };
      dynCall_vi = function(ptr, a0) {
        var big = glTraceActive && ptr > 15000;   // the rare large-index 'vi' dispatches (incl. the stalling 20078)
        if (glTraceActive && glCallSeq < glTraceCap) {
          console.log("[DIAG_DC] " + __thr + " dynCall_vi ptr=" + ptr + " name=" + __fnName(ptr) + " arg=" + a0 + " #" + (++glCallSeq));
        }
        if (big) {
          // Asyncify state going IN: if it's non-NORMAL (1=unwinding, 2=rewinding) the
          // leftover coroutine state is making the instrumented dispatch misbehave.
          console.log("[DIAG_DC_VI] ENTER ptr=" + ptr + " " + __asy());
          var r = __origDCvi(ptr, a0);
          // If this RETURNED line never appears, the dispatch unwound/stalled and never came back.
          console.log("[DIAG_DC_VI] RETURNED ptr=" + ptr + " " + __asy());
          return r;
        }
        return __origDCvi(ptr, a0);
      };
    }
  } catch (e) {}

  // 9. Periodic asyncify-state monitor (main thread). After dynCall_vi(20078)=
  //    setupUIConditions appears to unwind-and-never-rewind, this timer (which still runs
  //    on the idle event loop) reveals the post-stall Asyncify.state: if it's stuck at
  //    1 (UNWINDING) or 2 (REWINDING) with a fixed currData, the app yielded and the
  //    rewind was never scheduled. Logs only on change + a heartbeat.
  if (typeof Asyncify !== "undefined" && __thr === "main") {
    var __lastSt = -999, __lastCd = -999, __hb = 0;
    setInterval(function() {
      var st = Asyncify.state, cd = (Asyncify.currData || 0);
      if (st !== __lastSt || cd !== __lastCd) {
        console.log("[DIAG_ASTATE] change -> state=" + st + " currData=" + cd);
        __lastSt = st; __lastCd = cd;
      } else if (st !== 0 && (++__hb % 6 === 0)) {
        console.log("[DIAG_ASTATE] STILL state=" + st + " currData=" + cd + " (stuck?)");
      }
    }, 500);
  }

  console.log("[DIAG] Asyncify/fiber/modal diagnostics installed (logging only) [" + __thr + "]");
})();
// === End diagnostics ===
