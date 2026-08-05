// === AsyncifyScheduler (S0 scaffolding — observation-only) ===
// docs/features/async/17-mailbox-scheduler-plan.md · injected only on WX_SCHEDULER=1 builds.
//
// S0 contract: this file changes NO runtime behavior. It claims the namespace, the
// registry data structures, and the build marker so (a) the dual-glue build variant
// exists and can run the full suite, and (b) tests can detect which runtime they're on.
// S2 turns this into the sole owner of Asyncify.currData/state (doc 13 §1): the four
// hooks (handleSleep wrap, fiber-swap tracking, trampoline ownership, deferred drain)
// land there, gated on the N1 single-writer tripwire. Until then the legacy
// handlesleep.js shim (injected just above) stays authoritative.
if (typeof Asyncify !== "undefined" && !globalThis.__wxSchedulerInstalled) {
  globalThis.__wxSchedulerInstalled = true;
  Asyncify.__schedulerBuild = 1;

  var AsyncifyScheduler = {
    // ctx = { id, kind: 'main'|'modal'|'nested'|'coroutine'|'sleep',
    //         buffer, status: 'running'|'parked'|'ready', wakeReason, result }
    contexts: new Map(),
    readyQueue: [],
    running: null,
    transitionRunning: false,
    trampolineRunning: false,

    // S2 fills these in. They throw today so a premature caller is loud, not silent —
    // nothing in an S0 build calls them.
    park: function () { throw new Error("[wx-scheduler] park(): not implemented until S2"); },
    resume: function () { throw new Error("[wx-scheduler] resume(): not implemented until S2"); },
    drain: function () { throw new Error("[wx-scheduler] drain(): not implemented until S2"); },

    state: function () {
      return "[wx-scheduler] build=1 impl=S0-observation-only"
        + " contexts=" + this.contexts.size
        + " ready=" + this.readyQueue.length
        + " running=" + this.running
        + " transition=" + this.transitionRunning;
    },
  };

  globalThis.__wxScheduler = AsyncifyScheduler;
  console.log("[wx-scheduler] scaffolding installed (S0, observation-only)");
}
// === End AsyncifyScheduler ===
