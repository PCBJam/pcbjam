// === AsyncifyScheduler (S2 — scheduler core: registry, deferred wakes, single writer) ===
// __WX_SCHEDULER_SHIM_SOURCE__ — injector idempotence sentinel. Must appear ONLY in
// this file: the obvious marker (__wxSchedulerInstalled) also occurs in evtloop.cpp's
// EM_JS probe text inside every glue, which made the injector skip real injections.
// docs/features/async/17-mailbox-scheduler-plan.md · injected only on WX_SCHEDULER=1 builds.
//
// S2 state: this file REPLACES the legacy handlesleep.js on scheduler builds (the
// injector's either-or flip). It carries:
//   S1 · the wx mailbox (timer/wheel messages, wx/wasm/private/mailbox.h) and the
//        embind mutator lane (doc 18 classification).
//   S2 · the scheduler core — every behavior the legacy shim provided (per-sleep
//        currData capture/restore, the stale-fiber consume-once/quarantine guard,
//        wake-window flags, flight recorder, trampoline heal) PLUS:
//        - DEFERRED WAKES: a sleep wake arriving while a transition is in flight
//          (state != Normal, or the fiber trampoline mid-loop) is queued and
//          delivered from a clean macrotask when the slot frees — the aliased-wake
//          class becomes unrepresentable instead of merely detected (doc 12 §law).
//        - N1 SINGLE-WRITER TRIPWIRE: Asyncify.currData is an accessor; a write
//          from pure JS (no wasm frames on the export stack) without scheduler
//          authorization is a STRAY — beaconed, counted, and (opt-in strict mode)
//          thrown. Wasm-driven writes (fiber_swap, handleSleep internals) are
//          runtime-legitimate and pass through.
// Contract surfaces kept name-identical (external readers!): Asyncify.__wakingRoot
// (libcontext EM_JS wasm_root_wake_in_flight), __inSleepWake, __wakingOwnerFiber,
// __pendingSleepContexts, Fibers.__fcsTotal/__rootHotTotal/__rootFiber/
// __validSuspensions/__internallyParked/__parkSleepBuf/__inFiberEntry,
// the "[wx-asyncify] STATE"/"RECORDER" dump formats, window.__wxAsyncifyDump.
if (typeof Asyncify !== "undefined" && !globalThis.__wxSchedulerInstalled) {
  globalThis.__wxSchedulerInstalled = true;
  Asyncify.__schedulerBuild = 1;

  var AsyncifyScheduler = {
    // --- S1 wx mailbox ----------------------------------------------------
    mailbox: [],
    enqueued: 0,
    delivered: 0,
    _tickArmed: false,
    enqueueAfter: function (fn, arg, ms) {
      var self = this;
      setTimeout(function () {
        if (self.dead) return; // S6: never deliver into a torn-down app
        self.mailbox.push({ fn: fn, arg: arg });
        self.enqueued++;
        self._armDeliveryTick();
      }, ms);
    },
    pop: function () {
      var m = this.mailbox.shift();
      if (m) this.delivered++;
      return m || null;
    },
    // Deliver via a dedicated PLAIN export call (wxWasmMailboxTick), never
    // from inside a pump's awaited ProcessEvents ccall — a fiber swap there
    // sits on the JS-awaits-a-suspending-export boundary (#13302) and traps.
    _armDeliveryTick: function () {
      if (this._tickArmed) return;
      this._tickArmed = true;
      var self = this;
      setTimeout(function tick() {
        if (self.dead) { self._tickArmed = false; return; }
        try {
          if (Module["_wxWasmMailboxTick"]) Module["_wxWasmMailboxTick"]();
        } catch (e) {
          self._tickArmed = false;
          if (Module["_wx_dispatch_abandon"]) Module["_wx_dispatch_abandon"]();
          var exits = Module["_wxNestedLoopExit"];
          if (exits && exits.length) (exits.pop())();
          throw e;
        }
        if (self.mailbox.length > 0) {
          setTimeout(tick, 17);
        } else {
          self._tickArmed = false;
        }
      }, 0);
    },

    // --- S1 embind lane ---------------------------------------------------
    MUTATOR_NAMES: [
      "kicadSetChrome", "kicadSetReadOnly",
      "kicadCollabApply", "kicadCollabApplyItems",
      "kicadCollabSnapshot", "kicadCollabSnapshotItems",
      "kicadCollabPresenceStart", "kicadCollabSetRemote",
      "kicadCollabSetPins", "kicadCollabSetStyle",
      "kicadCollabSetViewport", "kicadCollabFitViewport",
      "kicadCollabReleaseSelection", "kicadSetColorTheme",
      "kicadSaveBoard", "kicadSaveSchematic", "kicadSaveDrawingSheet",
    ],
    mutatorQueue: [],
    mutatorsWrapped: 0,
    mutatorsDelivered: 0,
    _mutatorPumpArmed: false,
    _openBusy: function () {
      var probe = Module["kicadOpenFileBusy"];
      if (typeof probe !== "function") return false;
      try { return !!probe(); } catch (e) { return true; }
    },
    _wrapMutators: function () {
      var self = this;
      this.MUTATOR_NAMES.forEach(function (name) {
        var orig = Module[name];
        if (typeof orig !== "function") return;
        self.mutatorsWrapped++;
        Module[name] = function () {
          var args = arguments;
          var call = function () { return orig.apply(Module, args); };
          if (self.mutatorQueue.length === 0 && !self._openBusy()) {
            self.mutatorsDelivered++;
            return call();
          }
          return new Promise(function (resolve, reject) {
            self.mutatorQueue.push({ name: name, call: call, resolve: resolve, reject: reject });
            self._armMutatorPump();
          });
        };
      });
      if (this.mutatorsWrapped > 0)
        console.log("[wx-scheduler] embind lane: wrapped " + this.mutatorsWrapped + " mutator(s)");
    },
    _armMutatorPump: function () {
      if (this._mutatorPumpArmed) return;
      this._mutatorPumpArmed = true;
      var self = this;
      var now = (typeof performance !== "undefined" && performance.now)
        ? function () { return performance.now(); }
        : function () { return Date.now(); };
      setTimeout(function pump() {
        if (self.dead) { self._mutatorPumpArmed = false; return; }
        // Unkillable: an exception escaping this body would end the setTimeout
        // chain and wedge the queue forever (observed: 559 frozen messages).
        try {
          if (!self._openBusy()) {
            // Time-boxed drain: ~8 ms of work per 16 ms tick keeps the page
            // live while a long backlog drains in order.
            var t0 = now();
            while (self.mutatorQueue.length > 0 && now() - t0 < 8) {
              if (self._openBusy()) break;
              var m = self.mutatorQueue.shift();
              self.mutatorsDelivered++;
              try { m.resolve(m.call()); } catch (e) { m.reject(e); }
            }
          }
        } catch (e) {
          self._pumpErrors = (self._pumpErrors || 0) + 1;
          if (self._pumpErrors <= 5)
            console.warn("[wx-scheduler] mutator pump error (occurrence "
              + self._pumpErrors + "): " + e);
        }
        if (self.mutatorQueue.length > 0) setTimeout(pump, 16);
        else self._mutatorPumpArmed = false;
      }, 16);
    },

    // --- S4 wait registry ---------------------------------------------------
    // Token-based waits (doc 13 §2: wasm_begin_async_wait / wasm_yield_until /
    // wasm_resolve_wait). A wait is begun BEFORE the C++ side parks, so a
    // resolve that races ahead of the park (EndModal during Show()) simply
    // pre-resolves the promise — yieldUntil then returns immediately. Per-kind
    // LIFO stacks give wx modal/nested semantics ("innermost first") without
    // the legacy per-wait resolver stacks (_wxModalResolvers /
    // _wxNestedLoopExit), which die on scheduler builds. Resolution flows
    // through the S2 deferred-wake law automatically: resolving a wait wakes
    // its parked sleep via the wrapped handleSleep path.
    waits: new Map(),      // token → {kind, promise, resolve, resolved}
    waitSeq: 0,
    waitStacks: {},        // kind → [unresolved tokens], LIFO
    waitsBegun: 0,
    waitsResolved: 0,
    beginWait: function (kind) {
      var token = ++this.waitSeq;
      var entry = { kind: kind, resolved: false, resolve: null, promise: null };
      var self = this;
      entry.promise = new Promise(function (resolve) { entry.resolve = resolve; });
      this.waits.set(token, entry);
      (this.waitStacks[kind] = this.waitStacks[kind] || []).push(token);
      this.waitsBegun++;
      return token;
    },
    waitPromise: function (token) {
      var entry = this.waits.get(token);
      if (!entry) {
        console.warn("[wx-scheduler] waitPromise(" + token + "): unknown token");
        return Promise.resolve(0);
      }
      return entry.promise;
    },
    resolveWait: function (token, result) {
      var entry = this.waits.get(token);
      if (!entry || entry.resolved) return false;
      entry.resolved = true;
      this.waitsResolved++;
      var stack = this.waitStacks[entry.kind];
      if (stack) {
        var idx = stack.indexOf(token);
        if (idx !== -1) stack.splice(idx, 1);
      }
      this.waits.delete(token);
      entry.resolve(result | 0);
      return true;
    },
    // Resolve the INNERMOST unresolved wait of a kind (wx LIFO semantics).
    resolveTopWait: function (kind, result) {
      var stack = this.waitStacks[kind];
      if (!stack || stack.length === 0) return false;
      return this.resolveWait(stack[stack.length - 1], result);
    },
    pendingWaits: function (kind) {
      var stack = this.waitStacks[kind];
      return stack ? stack.length : 0;
    },

    // --- S2 scheduler core state -------------------------------------------
    // Deferred sleep wakes: {deliver, result} queued because a transition was
    // in flight when the wake arrived. Delivered FIFO from a clean macrotask.
    readyWakes: [],
    deferredWakes: 0,
    drainedWakes: 0,
    _wakeDrainArmed: false,
    // N1: pure-JS currData writes seen without scheduler authorization.
    strayWrites: 0,
    strictStrays: false,   // tests set true → stray throws instead of beaconing
    _authorizedWrite: 0,
    authorize: function (fn) {
      this._authorizedWrite++;
      try { return fn(); } finally { this._authorizedWrite--; }
    },

    // --- S6 lifetime --------------------------------------------------------
    // Called when the wx main loop exits (DoRun's top-level return path). The
    // app object is about to be destroyed: delivering anything after this
    // point runs callbacks into freed C++ state. Queued mutators reject,
    // queued messages and wakes drop — loudly, so a teardown that strands
    // work is visible in the console instead of surfacing as a later UAF.
    dead: false,
    shutdown: function (reason) {
      if (this.dead) return;
      this.dead = true;
      var stranded = {
        mailbox: this.mailbox.length,
        mutators: this.mutatorQueue.length,
        wakes: this.readyWakes.length,
        waits: this.waits.size,
      };
      this.mailbox.length = 0;
      for (var i = 0; i < this.mutatorQueue.length; i++) {
        try { this.mutatorQueue[i].reject(new Error("[wx-scheduler] shutdown: " + reason)); } catch (e) {}
      }
      this.mutatorQueue.length = 0;
      this.readyWakes.length = 0;
      if (stranded.mailbox || stranded.mutators || stranded.wakes || stranded.waits) {
        console.warn("[wx-scheduler] shutdown (" + reason + ") stranded:"
          + " mailbox=" + stranded.mailbox
          + " mutators=" + stranded.mutators
          + " wakes=" + stranded.wakes
          + " pendingWaits=" + stranded.waits);
      } else {
        console.log("[wx-scheduler] shutdown (" + reason + ") clean");
      }
    },

    state: function () {
      return "[wx-scheduler] build=1 impl=S2-core"
        + (this.dead ? " DEAD" : "")
        + " mailbox=" + this.mailbox.length
        + " enqueued=" + this.enqueued
        + " delivered=" + this.delivered
        + " mutQ=" + this.mutatorQueue.length
        + " mutWrapped=" + this.mutatorsWrapped
        + " mutDelivered=" + this.mutatorsDelivered
        + " readyWakes=" + this.readyWakes.length
        + " deferredWakes=" + this.deferredWakes
        + " drainedWakes=" + this.drainedWakes
        + " strayWrites=" + this.strayWrites
        + " waits=" + this.waits.size
        + " waitsBegun=" + this.waitsBegun
        + " waitsResolved=" + this.waitsResolved;
    },
  };

  globalThis.__wxScheduler = AsyncifyScheduler;

  // ======================================================================
  // S2 core install. Skipped defensively if the legacy shim somehow got in
  // first — double-managing the wake path corrupts (the injector's either-or
  // flip should make this unreachable).
  // ======================================================================
  if (Asyncify.__nestedHandleSleepInstalled) {
    console.warn("[wx-scheduler] legacy handlesleep present - S2 core NOT installed (dual-management guard)");
  } else if (typeof Asyncify.handleSleep === "function"
             && typeof Asyncify.allocateData === "function") {

    // --- flight recorder + state dump (ported verbatim-in-spirit from
    // handlesleep.js; formats are parsed by guard-beacons.ts and
    // apps/tests/tools/repro-board-load.ts — do not change shapes) ---------
    Asyncify.__pendingSleepContexts = [];
    var __recMax = 96;
    Asyncify.__rec = [];
    var __rec = function (ev) {
      var r = Asyncify.__rec;
      r.push(((typeof performance !== "undefined" ? performance.now() : 0) | 0) + " " + ev);
      if (r.length > __recMax) r.shift();
    };
    Asyncify.__recPush = __rec;

    var __dumpState = function () {
      var F = (typeof Fibers !== "undefined") ? Fibers : null;
      var pend = Array.isArray(Asyncify.__pendingSleepContexts)
        ? Asyncify.__pendingSleepContexts.map(function (c) { return c.capturedData || 0; }).join(",")
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
                + " fcsTotal=" + (F.__fcsTotal || 0)
                + " rootHotTotal=" + (F.__rootHotTotal || 0)
                + " valid=[" + (F.__validSuspensions ? Array.from(F.__validSuspensions).join(",") : "") + "]"
                + " parked=[" + (F.__internallyParked ? Array.from(F.__internallyParked).join(",") : "") + "]"
                + " deferrals=" + (F.__rootDeferrals || 0))
             : " (no Fibers)")
        + " | " + AsyncifyScheduler.state();
      return head + "\n[wx-asyncify] RECORDER (oldest first):\n  " + Asyncify.__rec.join("\n  ");
    };
    if (typeof window !== "undefined") {
      window.__wxAsyncifyDump = __dumpState;
      var __dumps = 0;
      var __onTrap = function (msg) {
        if (__dumps >= 2) return;
        if (!/index out of bounds|unreachable executed|table index|indirect call signature|null function or function signature|memory access out of bounds/i.test(msg)) return;
        ++__dumps;
        try { console.error(__dumpState()); } catch (e) {}
      };
      window.addEventListener("error", function (e) {
        __onTrap(e && e.error instanceof Error ? e.error.message : String((e && e.message) || ""));
      });
      window.addEventListener("unhandledrejection", function (e) {
        __onTrap(e && e.reason instanceof Error ? e.reason.message : String((e && e.reason) || ""));
      });
    }

    var __wxAsyncifyReport = (function () {
      var counts = {};
      return function (kind, msg, withStack) {
        var n = (counts[kind] = (counts[kind] || 0) + 1);
        if (n > 10 && n % 100 !== 0) return;
        var line = "[wx-asyncify] " + kind + ": " + msg + " (occurrence " + n + ")";
        if (withStack) {
          try { line += "\n" + String(new Error().stack).split("\n").slice(1, 8).join("\n"); } catch (e) {}
        }
        console.warn(line);
      };
    })();

    // --- N1: single-writer accessor on Asyncify.currData ------------------
    // Writes made while compiled code is on the export stack are the wasm
    // runtime's own (fiber_swap, handleSleep's park/stop paths) — legitimate.
    // A pure-JS write (empty export stack) must come from a scheduler-
    // authorized span; anything else is a STRAY: the exact shape of every
    // historical corruption's bad write. Beacon + count; strict mode throws.
    (function () {
      var realCurrData = Asyncify.currData; // null at install time
      Object.defineProperty(Asyncify, "currData", {
        configurable: true,
        get: function () { return realCurrData; },
        set: function (v) {
          if ((!Asyncify.exportCallStack || Asyncify.exportCallStack.length === 0)
              && AsyncifyScheduler._authorizedWrite === 0
              && !(typeof Fibers !== "undefined" && Fibers.trampolineRunning)) {
            AsyncifyScheduler.strayWrites++;
            __wxAsyncifyReport("stray-currdata-write",
              "currData=" + (v || 0) + " written from pure JS without scheduler authorization", true);
            if (AsyncifyScheduler.strictStrays)
              throw new Error("[wx-scheduler] stray currData write (strict mode)");
          }
          realCurrData = v;
        },
      });
    })();

    // --- deferred-wake drain ----------------------------------------------
    var __transitionFree = function () {
      return Asyncify.state === 0
        && !(typeof Fibers !== "undefined" && Fibers.trampolineRunning);
    };
    AsyncifyScheduler._scheduleWakeDrain = function () {
      if (this._wakeDrainArmed) return;
      this._wakeDrainArmed = true;
      var self = this;
      setTimeout(function () {
        self._wakeDrainArmed = false;
        if (self.dead) return; // S6: parked stacks are gone with the app
        // Deliver from a CLEAN macrotask (export stack empty by construction).
        while (self.readyWakes.length > 0 && __transitionFree()) {
          var w = self.readyWakes.shift();
          self.drainedWakes++;
          w.deliver(w.result);
        }
        if (self.readyWakes.length > 0) self._scheduleWakeDrain();
      }, 0);
    };

    // --- handleSleep wrap: registry + capture/restore + deferral ----------
    var __originalAllocateData = Asyncify.allocateData.bind(Asyncify);
    Asyncify.allocateData = function () {
      var ptr = __originalAllocateData();
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
    Asyncify.handleSleep = function (startAsync) {
      __rec("sleep s=" + Asyncify.state + " cd=" + (Asyncify.currData || 0)
            + " w=" + (Asyncify.__inSleepWake || 0));
      if (Asyncify.state === 0 && Asyncify.currData) {
        __wxAsyncifyReport("concurrent-park",
          "handleSleep entered while currData=" + Asyncify.currData, true);
      }
      if (Asyncify.state === 1) {
        __wxAsyncifyReport("reentrant-state",
          "handleSleep entered mid-unwind (state=1) currData=" + Asyncify.currData, true);
      }
      // Only a FRESH park (state 0) allocates data and needs tracking; the
      // state-2 resume re-entry returns synchronously through the rewind
      // branch (a context pushed for it leaks one per resume).
      if (Asyncify.state !== 0) {
        return __originalHandleSleep(startAsync);
      }
      var sleepCtx = {
        capturedData: null,
        cleanedUp: false,
        rootOwned: (typeof Fibers === "undefined")
          || (!Fibers.__inFiberEntry
              && !(Asyncify.__wakingOwnerFiber || false)),
      };
      Asyncify.__pendingSleepContexts.push(sleepCtx);

      var cleanup = function () {
        if (sleepCtx.cleanedUp) return;
        sleepCtx.cleanedUp = true;
        var idx = Asyncify.__pendingSleepContexts.indexOf(sleepCtx);
        if (idx !== -1) Asyncify.__pendingSleepContexts.splice(idx, 1);
      };

      try {
        return __originalHandleSleep(function (wakeUp) {
          // deliver(): the legacy shim's whole wake path — restore OUR buffer,
          // mark the wake window, swallow the "unwind" sentinel.
          var deliver = function (result) {
            __rec("wake buf=" + (sleepCtx.capturedData || 0) + " cdWas=" + (Asyncify.currData || 0)
                  + (sleepCtx.rootOwned ? " R" : " f"));
            if (sleepCtx.capturedData) {
              if (Asyncify.currData !== sleepCtx.capturedData) {
                __wxAsyncifyReport(
                  Asyncify.currData ? "aliased-wake-live" : "overlapped-wake",
                  "restoring currData=" + sleepCtx.capturedData +
                    " over " + (Asyncify.currData || "null") +
                    " state=" + Asyncify.state, !!Asyncify.currData);
              }
              AsyncifyScheduler.authorize(function () {
                Asyncify.currData = sleepCtx.capturedData;
              });
            }
            cleanup();
            Asyncify.__inSleepWake = (Asyncify.__inSleepWake || 0) + 1;
            var prevWakingOwnerFiber = Asyncify.__wakingOwnerFiber || false;
            Asyncify.__wakingOwnerFiber = !sleepCtx.rootOwned;
            var prevWakingRoot = Asyncify.__wakingRoot || 0;
            if (sleepCtx.rootOwned) Asyncify.__wakingRoot = (Asyncify.__wakingRoot || 0) + 1;
            try {
              return wakeUp(result);
            } catch (e) {
              if (e === "unwind") return;
              throw e;
            } finally {
              Asyncify.__inSleepWake -= 1;
              Asyncify.__wakingOwnerFiber = prevWakingOwnerFiber;
              if (sleepCtx.rootOwned) Asyncify.__wakingRoot = prevWakingRoot;
            }
          };
          return startAsync(function (result) {
            // THE S2 LAW (doc 12): a wake never starts a rewind while another
            // transition is in flight — it enqueues and the drain delivers
            // from a clean macrotask when the slot frees. The legacy shim
            // could only beacon this window (aliased-wake-live); the
            // scheduler removes it.
            if (!__transitionFree()) {
              AsyncifyScheduler.deferredWakes++;
              __rec("defer-wake buf=" + (sleepCtx.capturedData || 0)
                    + " s=" + Asyncify.state);
              AsyncifyScheduler.readyWakes.push({ deliver: deliver, result: result });
              AsyncifyScheduler._scheduleWakeDrain();
              return;
            }
            return deliver(result);
          });
        });
      } catch (e) {
        cleanup();
        throw e;
      }
    };

    // Transition-completion signal: maybeStopUnwind is where an unwind
    // finishes (state → Normal) and the trampoline runs queued fiber
    // switches. After it settles, deferred wakes may proceed.
    var __originalMaybeStopUnwind = Asyncify.maybeStopUnwind.bind(Asyncify);
    Asyncify.maybeStopUnwind = function () {
      var ret = __originalMaybeStopUnwind();
      if (AsyncifyScheduler.readyWakes.length > 0 && __transitionFree())
        AsyncifyScheduler._scheduleWakeDrain();
      return ret;
    };

    Asyncify.__nestedHandleSleepInstalled = true; // compat: tools probe this
    console.log("[wx-scheduler] S2 core installed (deferred wakes + N1 accessor)");
  }

  // --- stale-fiber-rewind guard (ported from handlesleep.js; semantics
  // unchanged — these encode the consume-once/quarantine contracts of
  // docs/features/async/16) + trampoline heal ownership -------------------
  if (typeof Fibers !== "undefined"
      && typeof Fibers.finishContextSwitch === "function"
      && !Fibers.__staleRewindGuardInstalled) {
    Fibers.__validSuspensions = new Set();
    Fibers.__internallyParked = new Set();
    Fibers.__parkSleepBuf = new Map();

    var __origFinishContextSwitch = Fibers.finishContextSwitch.bind(Fibers);
    var __fiberRefusals = 0;

    var __fcsRec = (typeof Asyncify !== "undefined" && Asyncify.__recPush)
      ? Asyncify.__recPush
      : function () {};

    var __refuseFiber = function (newFiber, why) {
      __fcsRec("refuse new=" + newFiber);
      ++__fiberRefusals;
      if (__fiberRefusals <= 10 || __fiberRefusals % 100 === 0) {
        console.warn("[wx-asyncify] fiber-resume-refused: fiber=" + newFiber + " " + why
                     + " (occurrence " + __fiberRefusals + ")");
      }
      AsyncifyScheduler.authorize(function () {
        Asyncify.currData = null;
      });
    };

    Fibers.finishContextSwitch = function (newFiber) {
      Fibers.__fcsTotal = (Fibers.__fcsTotal || 0) + 1;
      if (newFiber === Fibers.__rootFiber && (Asyncify.__inSleepWake || 0) > 0) {
        Fibers.__rootHotTotal = (Fibers.__rootHotTotal || 0) + 1;
      }
      var __remStr = "";
      if (Asyncify.currData) {
        var __H = (typeof GROWABLE_HEAP_U32 === "function") ? GROWABLE_HEAP_U32() : HEAPU32;
        __remStr = " rem=" + (__H[((Asyncify.currData + 4) >>> 2) >>> 0] - __H[(Asyncify.currData >>> 2) >>> 0])
          + " rf=" + (Asyncify.getDataRewindFuncName ? Asyncify.getDataRewindFuncName(Asyncify.currData) : "?")
          + " es=[" + (Asyncify.exportCallStack || []).join("|") + "]";
      }
      __fcsRec("fcs old=" + (Asyncify.currData ? Asyncify.currData - 20 : 0)
               + " new=" + newFiber
               + (newFiber === Fibers.__rootFiber ? " ROOT" : "")
               + " w=" + (Asyncify.__inSleepWake || 0) + __remStr);
      if (Asyncify.currData) {
        var oldFiber = Asyncify.currData - 20;
        if (Fibers.__rootFiber === undefined) {
          Fibers.__rootFiber = oldFiber;
        }
        var parkBuf = Fibers.__parkSleepBuf.get(oldFiber);
        var stillParked = parkBuf !== undefined
            && Array.isArray(Asyncify.__pendingSleepContexts)
            && Asyncify.__pendingSleepContexts.some(function (c) { return c.capturedData === parkBuf; });
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
        __refuseFiber(newFiber, "is asyncify-parked mid-body (sleep in flight)");
        return;
      }
      if (entryPoint === 0) {
        if (!Fibers.__validSuspensions.has(newFiber)) {
          __refuseFiber(newFiber, isRoot
            ? "root suspension already consumed - a second rewind would replay stale frames"
            : "has no live suspension - rewinding would replay stale data");
          return;
        }
        Fibers.__validSuspensions.delete(newFiber);
      }

      if (!isRoot) Fibers.__inFiberEntry = (Fibers.__inFiberEntry || 0) + 1;
      var ret;
      try {
        // The original writes currData (entry path nulls it, resume path sets
        // the fiber's buffer) from pure JS — scheduler-supervised here.
        ret = AsyncifyScheduler.authorize(function () {
          return __origFinishContextSwitch(newFiber);
        });
      } finally {
        if (!isRoot) Fibers.__inFiberEntry -= 1;
      }

      if (!isRoot && !Fibers.nextFiber && Asyncify.currData) {
        Fibers.__internallyParked.add(newFiber);
        Fibers.__parkSleepBuf.set(newFiber, Asyncify.currData);
      }

      return ret;
    };

    // Trampoline heal ownership (subsumes inject-dyncall-shims §3c): a throw
    // escaping the trampoline loop must not leave trampolineRunning wedged —
    // that guard being stuck turns every later fiber swap into a silent no-op.
    var __origTrampoline = Fibers.trampoline.bind(Fibers);
    Fibers.trampoline = function () {
      try {
        return __origTrampoline();
      } catch (e) {
        Fibers.trampolineRunning = false;
        throw e;
      }
    };

    Fibers.__staleRewindGuardInstalled = true;
  }

  // Wrap the embind mutators once the runtime has registered them.
  if (typeof Module !== "undefined") {
    if (Module["calledRun"]) {
      AsyncifyScheduler._wrapMutators();
    } else {
      var __wxSchedPrevInit = Module["onRuntimeInitialized"];
      Module["onRuntimeInitialized"] = function () {
        if (typeof __wxSchedPrevInit === "function") __wxSchedPrevInit();
        AsyncifyScheduler._wrapMutators();
      };
    }
  }

  console.log("[wx-scheduler] scaffolding installed (S2, core live)");
}
// === End AsyncifyScheduler ===
