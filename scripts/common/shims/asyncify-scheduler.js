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
        + " contexts=" + this.contexts.size
        + " ready=" + this.readyQueue.length
        + " transition=" + this.transitionRunning;
    },
  };

  globalThis.__wxScheduler = AsyncifyScheduler;
  console.log("[wx-scheduler] scaffolding installed (S1, mailbox live)");
}
// === End AsyncifyScheduler ===
