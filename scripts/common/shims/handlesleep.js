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
    // Flight recorder: a capped ring of asyncify/fiber events (never printed
    // during normal operation), dumped to the console ONCE when a trap
    // signature surfaces — so a prod console export carries the exact event
    // sequence and machine state at death instead of just stack shapes.
    // window.__wxAsyncifyDump() returns it on demand.
    var __recMax = 96;
    Asyncify.__rec = [];
    var __rec = function(ev) {
      var r = Asyncify.__rec;
      r.push(((typeof performance !== "undefined" ? performance.now() : 0) | 0) + " " + ev);
      if (r.length > __recMax) r.shift();
    };
    Asyncify.__recPush = __rec;

    var __dumpState = function() {
      var F = (typeof Fibers !== "undefined") ? Fibers : null;
      var pend = Array.isArray(Asyncify.__pendingSleepContexts)
        ? Asyncify.__pendingSleepContexts.map(function(c) { return c.capturedData || 0; }).join(",")
        : "n/a";
      var head = "[wx-asyncify] STATE"
        + " state=" + Asyncify.state
        + " currData=" + (Asyncify.currData || 0)
        + " inSleepWake=" + (Asyncify.__inSleepWake || 0)
        + " exportStack=" + (Asyncify.exportCallStack ? Asyncify.exportCallStack.length : -1)
        + " pendingSleeps=[" + pend + "]"
        + (F ? (" nextFiber=" + F.nextFiber
                + " trampolining=" + F.trampolineRunning
                + " root=" + F.__rootFiber
                + " valid=[" + (F.__validSuspensions ? Array.from(F.__validSuspensions).join(",") : "") + "]"
                + " parked=[" + (F.__internallyParked ? Array.from(F.__internallyParked).join(",") : "") + "]"
                + " deferrals=" + (F.__rootDeferrals || 0))
             : " (no Fibers)");
      return head + "\n[wx-asyncify] RECORDER (oldest first):\n  " + Asyncify.__rec.join("\n  ");
    };
    if (typeof window !== "undefined") {
      window.__wxAsyncifyDump = __dumpState;
      // Auto-dump beside the first trap signatures in the console — the one
      // artifact prod reports reliably contain.
      var __dumps = 0;
      var __onTrap = function(msg) {
        if (__dumps >= 2) return;
        if (!/index out of bounds|unreachable executed|table index|indirect call signature|null function or function signature|memory access out of bounds/i.test(msg)) return;
        ++__dumps;
        try { console.error(__dumpState()); } catch (e) {}
      };
      window.addEventListener("error", function(e) {
        __onTrap(e && e.error instanceof Error ? e.error.message : String((e && e.message) || ""));
      });
      window.addEventListener("unhandledrejection", function(e) {
        __onTrap(e && e.reason instanceof Error ? e.reason.message : String((e && e.reason) || ""));
      });
    }

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
      __rec("sleep s=" + Asyncify.state + " cd=" + (Asyncify.currData || 0)
            + " w=" + (Asyncify.__inSleepWake || 0));
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
            __rec("wake buf=" + (sleepCtx.capturedData || 0) + " cdWas=" + (Asyncify.currData || 0));
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
            // Mark the synchronous wake window: everything below wakeUp() —
            // the rewind, the resumed code running forward, its next unwind —
            // executes inside it. A fiber completion whose root-entry lands
            // in this window rewinds the root WHILE the wake's own rewind is
            // in flight (the four identical prod trap stacks:
            // maybeStopUnwind → trampoline → finishContextSwitch →
            // doRewind(root) → unreachable). The stale-fiber guard below
            // defers such root entries by one macrotask.
            Asyncify.__inSleepWake = (Asyncify.__inSleepWake || 0) + 1;
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
            } finally {
              Asyncify.__inSleepWake -= 1;
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

// === Stale-fiber-rewind guard (the decoded 2026-07/08 prod board-load trap) ===
//
// A fiber whose body asyncify-parks inside handleSleep is suspended in a way
// the fiber machinery cannot see: its struct still holds the CONSUMED data of
// its last real swap-out. The C++ libcontext guard (swap_suspended) closes the
// simple case, but caller attribution can be poisoned — a fresh JS entry that
// jumps while g_current_context still points at a parked fiber writes a fresh
// suspension INTO that parked fiber's struct, so the flag lies. This guard is
// attribution-proof: it tracks validity at the emscripten-fiber layer itself.
//
// A fiber becomes safely resumable ONLY when a real swap-out writes its
// suspension — observable here because fiber_swap sets Asyncify.currData to
// oldFiber's asyncify data (fiber+20) and finishContextSwitch runs before
// anything else touches it. Consuming a suspension (the rewind path) removes
// it. A suspended-path entry for a fiber with NO live suspension is exactly
// the stale rewind that produced "unreachable executed" + a poisoned runtime
// (docs/features/async/16) — REFUSE it: the dropped dispatch ghost-resolves
// (the jump-ghost contract), the parked body completes via its own wake.
if (typeof Fibers !== "undefined"
    && typeof Fibers.finishContextSwitch === "function"
    && !Fibers.__staleRewindGuardInstalled) {
  // Fibers whose last swap-out wrote a live (unconsumed) suspension.
  Fibers.__validSuspensions = new Set();
  // Fibers whose last slice ended in a handleSleep park instead of a swap-out:
  // their body is mid-sleep, so entering them is unsafe no matter what their
  // struct holds (a misattributed jump may have written a valid-LOOKING
  // foreign suspension into it).
  Fibers.__internallyParked = new Set();
  // fiber → the sleep buffer its internal park is waiting on. A LATER
  // "swap-out" of that fiber is genuine only if this sleep has resolved
  // (its context left __pendingSleepContexts) — a misattributed jump from a
  // fresh JS entry writes the fiber's struct while the sleep is still
  // pending, and must not launder the fiber back into the valid set.
  Fibers.__parkSleepBuf = new Map();

  var __origFinishContextSwitch = Fibers.finishContextSwitch.bind(Fibers);
  var __fiberRefusals = 0;

  var __refuseFiber = function(newFiber, why) {
    __fcsRec("refuse new=" + newFiber);
    ++__fiberRefusals;
    if (__fiberRefusals <= 10 || __fiberRefusals % 100 === 0) {
      console.warn("[wx-asyncify] fiber-resume-refused: fiber=" + newFiber + " " + why
                   + " (occurrence " + __fiberRefusals + ")");
    }
    // No context is entered. The unwind that got us here already completed
    // (state Normal); clear the dangling currData so the next fresh park
    // does not read a foreign pointer.
    Asyncify.currData = null;
  };

  var __fcsRec = (typeof Asyncify !== "undefined" && Asyncify.__recPush)
    ? Asyncify.__recPush
    : function() {};

  Fibers.finishContextSwitch = function(newFiber) {
    __fcsRec("fcs old=" + (Asyncify.currData ? Asyncify.currData - 20 : 0)
             + " new=" + newFiber
             + (newFiber === Fibers.__rootFiber ? " ROOT" : "")
             + " w=" + (Asyncify.__inSleepWake || 0));
    // The swap that scheduled this switch just suspended its old fiber and
    // left currData = oldFiber+20 (fiber_swap's unwind path); record that
    // suspension as live — and a GENUINE swap-out also ends any internal
    // park. Genuine means the fiber's pending sleep (if any) has resolved;
    // otherwise this is a misattributed fresh-entry jump writing into a
    // parked fiber's struct, and the fiber must stay quarantined.
    // finishContextSwitch only runs for genuine fiber switches, so currData
    // here is never a handleSleep buffer.
    if (Asyncify.currData) {
      var oldFiber = Asyncify.currData - 20;
      // The very first switch is always main → coroutine: remember the ROOT
      // context. The root is exempt from quarantine below — after a rewind
      // into it, execution continues into the whole main loop (which parks in
      // its yield as a matter of course); reading that park as "the entered
      // fiber is mid-body" quarantined MAIN and starved every coroutine
      // return (empty collab results across the board on the first build of
      // this guard).
      if (Fibers.__rootFiber === undefined) {
        Fibers.__rootFiber = oldFiber;
      }
      var parkBuf = Fibers.__parkSleepBuf.get(oldFiber);
      var stillParked = parkBuf !== undefined
          && Array.isArray(Asyncify.__pendingSleepContexts)
          && Asyncify.__pendingSleepContexts.some(function(c) { return c.capturedData === parkBuf; });
      if (!stillParked) {
        Fibers.__validSuspensions.add(oldFiber);
        Fibers.__internallyParked.delete(oldFiber);
        Fibers.__parkSleepBuf.delete(oldFiber);
      }
    }

    var isRoot = newFiber === Fibers.__rootFiber;
    var HEAPU32v = (typeof GROWABLE_HEAP_U32 === "function") ? GROWABLE_HEAP_U32() : HEAPU32;
    var entryPoint = HEAPU32v[((newFiber + 12) >>> 2) >>> 0];
    if (!isRoot && Fibers.__internallyParked.has(newFiber)) {
      // Root is exempt from THIS check only: it "parks" in the main loop's
      // yield as a matter of course (quarantining it starved every coroutine
      // return — 19 collab e2e reds on the first guard build).
      __refuseFiber(newFiber, "is asyncify-parked mid-body (sleep in flight)");
      return;
    }
    if (entryPoint === 0) {
      // Suspended-fiber path: about to rewind newFiber+20 — root INCLUDED.
      // Consume-once semantics are the actual prod killer's cure (all four
      // trap stacks, v0.1.19–22): each fiber_swap suspension is rewindable
      // exactly once. Two fibers completing against ONE root suspension
      // epoch (a tool fiber and a collab fiber both waking around
      // open:settled) makes the second finishContextSwitch(root) rewind
      // already-consumed data → "unreachable executed" → poisoned runtime.
      // Refusing the second consumption loses nothing: the fiber that
      // yielded stays properly suspended (recorded above), and the root
      // continues via its real pending resume (its own sleep wake or the
      // next fresh JS entry) — the same contract as libcontext's
      // ghost-resume epochs, enforced one layer lower.
      if (!Fibers.__validSuspensions.has(newFiber)) {
        __refuseFiber(newFiber, isRoot
          ? "root suspension already consumed - a second rewind would replay stale frames"
          : "has no live suspension - rewinding would replay stale data");
        return;
      }
      Fibers.__validSuspensions.delete(newFiber);
    }

    var ret = __origFinishContextSwitch(newFiber);

    // How did the entered fiber's synchronous slice end? Another fiber swap
    // (nextFiber set — the trampoline loop continues, proper suspension) or a
    // handleSleep park (currData holds a sleep buffer — the body is mid-sleep
    // and must not be entered until it properly swaps out). Never applied to
    // the root: its rewound continuation runs the whole main loop, whose
    // routine yield park says nothing about a fiber body.
    if (!isRoot && !Fibers.nextFiber && Asyncify.currData) {
      Fibers.__internallyParked.add(newFiber);
      Fibers.__parkSleepBuf.set(newFiber, Asyncify.currData);
    }

    return ret;
  };

  Fibers.__staleRewindGuardInstalled = true;
}
// === End stale-fiber-rewind guard ===
