// === AsyncifyScheduler (S1 — mailbox front-end live; scheduler core lands in S2) ===
// __WX_SCHEDULER_SHIM_SOURCE__ — injector idempotence sentinel. Must appear ONLY in
// this file: the obvious marker (__wxSchedulerInstalled) also occurs in evtloop.cpp's
// EM_JS probe text inside every glue, which made the injector skip real injections.
// docs/features/async/17-mailbox-scheduler-plan.md · injected only on WX_SCHEDULER=1 builds.
//
// S1 state: the MAILBOX is live — deferred browser callbacks (wx timers, via
// wx/wasm/private/mailbox.h) are enqueued here on expiry and delivered by the wx
// event pump (evtloop.cpp wxWasmMailboxDeliver) from a clean dispatch context,
// only when the dispatch interlock is free. The legacy handlesleep.js shim
// (injected just above) remains authoritative for currData until S2, when the
// scheduler core (registry, deferred drain, fiber tracking) lands here gated on
// the N1 single-writer tripwire.
if (typeof Asyncify !== "undefined" && !globalThis.__wxSchedulerInstalled) {
  globalThis.__wxSchedulerInstalled = true;
  Asyncify.__schedulerBuild = 1;

  var AsyncifyScheduler = {
    // --- S1 mailbox -------------------------------------------------------
    // Due messages, FIFO. {fn, arg} are wasm function-pointer / pointer ints;
    // the C side (wxWasmMailboxDeliver) pops and calls them. Exactly-once:
    // a message stays queued until the pump delivers it — there is no drop
    // path, matching the emscripten_async_call contract it replaces.
    mailbox: [],
    enqueued: 0,
    delivered: 0,
    _tickArmed: false,
    enqueueAfter: function (fn, arg, ms) {
      var self = this;
      setTimeout(function () {
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
    // Re-arms at 17ms while messages remain (the interlock may be held; the
    // C side skips delivery then). One retry loop for the WHOLE queue — this
    // replaces the per-timer retry storms of the legacy path.
    _armDeliveryTick: function () {
      if (this._tickArmed) return;
      this._tickArmed = true;
      var self = this;
      setTimeout(function tick() {
        try {
          if (Module["_wxWasmMailboxTick"]) Module["_wxWasmMailboxTick"]();
        } catch (e) {
          self._tickArmed = false;
          // Mirror wxWasmScheduleProcessEvents' guard: a trapped delivery
          // must not leave the interlock held or a parked nested DoRun stuck.
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
    // Wraps the audited production mutators (docs/features/async/18) at the
    // Module boundary: a call made while `kicadOpenFileBusy()` reads true is
    // QUEUED and DELIVERED after the open settles, in FIFO order, resolving a
    // returned promise — the doc-17 §3b drop→deliver flip, applied at the one
    // choke point every caller shares (standalone app, kicad e2e harness).
    // The not-busy path is byte-compatible: same synchronous call, same
    // return value. Busy-path callers historically got a gate no-op (empty
    // delta / dropped apply), so the promise is strictly more information.
    // Under PROXY_TO_PTHREAD this wraps in the window context where app code
    // calls; in worker contexts the names are absent and nothing wraps.
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
        // The pump must be unkillable: any exception escaping this body would
        // end the setTimeout chain and wedge the queue forever (observed: 559
        // messages frozen through a 240 s drain-wait). Per-delivery errors
        // reject that caller's promise; anything else is beaconed and the
        // chain re-arms regardless.
        try {
          if (!self._openBusy()) {
            // Time-boxed drain: a long queue (a hammer of snapshots against a
            // big board) must not monopolize the main thread in one burst —
            // paint, the title update, and input all starve. ~8 ms of work per
            // 16 ms tick keeps the page live while the backlog drains in order.
            var t0 = now();
            while (self.mutatorQueue.length > 0 && now() - t0 < 8) {
              if (self._openBusy()) break; // a delivered call re-opened the window
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

    // --- S2 scheduler core (not yet live) ---------------------------------
    // ctx = { id, kind: 'main'|'modal'|'nested'|'coroutine'|'sleep',
    //         buffer, status: 'running'|'parked'|'ready', wakeReason, result }
    contexts: new Map(),
    readyQueue: [],
    running: null,
    transitionRunning: false,
    trampolineRunning: false,

    // S2 fills these in. They throw today so a premature caller is loud, not
    // silent — nothing in an S1 build calls them.
    park: function () { throw new Error("[wx-scheduler] park(): not implemented until S2"); },
    resume: function () { throw new Error("[wx-scheduler] resume(): not implemented until S2"); },
    drain: function () { throw new Error("[wx-scheduler] drain(): not implemented until S2"); },

    state: function () {
      return "[wx-scheduler] build=1 impl=S1-mailbox"
        + " mailbox=" + this.mailbox.length
        + " enqueued=" + this.enqueued
        + " delivered=" + this.delivered
        + " mutQ=" + this.mutatorQueue.length
        + " mutWrapped=" + this.mutatorsWrapped
        + " mutDelivered=" + this.mutatorsDelivered
        + " contexts=" + this.contexts.size
        + " ready=" + this.readyQueue.length
        + " transition=" + this.transitionRunning;
    },
  };

  globalThis.__wxScheduler = AsyncifyScheduler;

  // Wrap the embind mutators once the runtime has registered them. The shim
  // executes at glue load (before instantiation), so chaining
  // onRuntimeInitialized is normally enough; the calledRun branch covers a
  // shim injected into an already-running Module (defensive).
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

  console.log("[wx-scheduler] scaffolding installed (S1, mailbox live)");
}
// === End AsyncifyScheduler ===
