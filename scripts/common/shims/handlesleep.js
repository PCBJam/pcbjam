// === Nested-Asyncify handleSleep currData save/restore (Emscripten #9153) ===
//
// Asyncify.currData is a single-slot global. When a fiber swap runs inside an
// EM_ASYNC_JS Promise await (e.g., wxDialog::ShowModal via startModal), the
// fiber swap overwrites currData with the fiber's asyncify_data, losing the
// sleep's own buffer. On Promise resolution, handleSleep's doRewind then uses
// the wrong buffer and crashes with "index out of bounds" or "unreachable".
//
// Workaround: intercept Asyncify.allocateData to record which pointer belongs to
// the active handleSleep; restore it to Asyncify.currData inside the wakeUp
// callback before handleSleep proceeds to _asyncify_start_rewind + doRewind.
if (typeof Asyncify !== "undefined") {
  if (typeof Asyncify.handleSleep === "function"
      && typeof Asyncify.allocateData === "function"
      && !Asyncify.__nestedHandleSleepInstalled) {
    // Stack of handleSleep contexts awaiting their allocateData association.
    Asyncify.__pendingSleepContexts = [];

    // Anomaly reporting (diagnostics only — behavior unchanged). This shim has
    // been SILENTLY repairing currData aliasing between concurrent parks since
    // it was written; production traps in exactly this family ("index out of
    // bounds" / "unreachable executed" during doRewind) keep arriving with no
    // way to tell whether the shim fired, mislinked, or was bypassed (fiber
    // swaps don't allocate through allocateData). Make every repair and every
    // concurrent-park window loud, so a saved console dump answers that.
    // Rate-limited per kind: first 10 in full, then every 100th.
    var __wxAsyncifyReport = (function() {
      var counts = {};
      return function(kind, msg, withStack) {
        var n = (counts[kind] = (counts[kind] || 0) + 1);
        if (n > 10 && n % 100 !== 0) return;
        var line = "[wx-asyncify] " + kind + ": " + msg + " (occurrence " + n + ")";
        if (withStack) {
          // The stack names WHICH EM_ASYNC_JS parked (__asyncjs__wxWasmYieldToBrowser,
          // startModal, js_enumerateFonts, ...) — the missing actor in every prod dump.
          try { line += "\n" + String(new Error().stack).split("\n").slice(1, 8).join("\n"); } catch (e) {}
        }
        console.warn(line);
      };
    })();

    var __originalAllocateData = Asyncify.allocateData.bind(Asyncify);
    Asyncify.allocateData = function() {
      var ptr = __originalAllocateData();
      // Associate with the innermost pending handleSleep not yet linked.
      for (var i = Asyncify.__pendingSleepContexts.length - 1; i >= 0; --i) {
        var ctx = Asyncify.__pendingSleepContexts[i];
        if (!ctx.capturedData) {
          ctx.capturedData = ptr;
          break;
        }
      }
      return ptr;
    };

    var __originalHandleSleep = Asyncify.handleSleep.bind(Asyncify);
    Asyncify.handleSleep = function(startAsync) {
      // A FRESH park (state 0 = Normal) starting while another chain's park is
      // still live: the single-slot currData is about to be overwritten. The
      // shim's restore below makes the POINTER survive, but nothing protects
      // deeper state (fiber swaps, freed buffers, out-of-order wakes) — this
      // window is where the trap family lives, and until now it was invisible.
      // state 2 (Rewinding) entries are NOT reported: every resume legally
      // re-enters handleSleep while rewinding with currData set (verified
      // empirically 2026-07-31 — the timer-park e2e produced ~100/s of them
      // on a healthy run).
      if (Asyncify.state === 0 && Asyncify.currData) {
        __wxAsyncifyReport(
          "concurrent-park",
          "handleSleep entered while currData=" + Asyncify.currData,
          true);
      }
      if (Asyncify.state === 1) {
        // Parking while an UNWIND is literally in progress is never legal —
        // if this ever fires it IS the bug.
        __wxAsyncifyReport(
          "reentrant-state",
          "handleSleep entered mid-unwind (state=1) currData=" + Asyncify.currData,
          true);
      }
      var sleepCtx = { capturedData: null, cleanedUp: false };
      Asyncify.__pendingSleepContexts.push(sleepCtx);

      var cleanup = function() {
        if (sleepCtx.cleanedUp) return;
        sleepCtx.cleanedUp = true;
        var idx = Asyncify.__pendingSleepContexts.indexOf(sleepCtx);
        if (idx !== -1) Asyncify.__pendingSleepContexts.splice(idx, 1);
      };

      try {
        return __originalHandleSleep(function(wakeUp) {
          return startAsync(function(result) {
            // wakeUp runs from pure JS on Promise resolution. Fiber swaps during
            // the await may have overwritten Asyncify.currData. Restore OUR buffer
            // so handleSleep's _asyncify_start_rewind and doRewind use it.
            if (sleepCtx.capturedData) {
              if (Asyncify.currData !== sleepCtx.capturedData) {
                // The repair firing. currData=null → the overlapping chain
                // already completed (benign overlap, but COUNT it: it proves
                // concurrent parks happen on this load). currData=<other> → a
                // DIFFERENT chain is parked right now and we are rewinding
                // around it — the dangerous interleave.
                __wxAsyncifyReport(
                  Asyncify.currData ? "aliased-wake-live" : "overlapped-wake",
                  "restoring currData=" + sleepCtx.capturedData +
                    " over " + (Asyncify.currData || "null") +
                    " state=" + Asyncify.state,
                  !!Asyncify.currData);
              }
              Asyncify.currData = sleepCtx.capturedData;
            }
            cleanup();
            try {
              return wakeUp(result);
            } catch (e) {
              // emscripten_set_main_loop(...,1) parks main() by throwing the
              // "unwind" sentinel. When main's LAST pre-park suspension was a
              // sleep, main is resumed from THIS wakeUp, so the sentinel
              // propagates here instead of into callMain's catch — surfacing as
              // an uncaught "unwind" promise rejection. Swallow it exactly like
              // callMain/handleException do on the direct path.
              if (e === "unwind") {
                return;
              }
              throw e;
            }
          });
        });
      } catch (e) {
        cleanup();
        throw e;
      }
    };

    Asyncify.__nestedHandleSleepInstalled = true;
  }
}
// === End nested-Asyncify handleSleep fix ===
