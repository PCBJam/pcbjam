// jspi-scheduler.js — the wx scheduler shim for the JSPI runtime.
//
// Ships as a --pre-js. Provides the S4 token-wait registry
// (beginWait/waitPromise/resolveWait/resolveTopWait/waitEarlyResolved/
// takeWaitResult/pendingWaits/shutdown) that every C++ bridge and web
// caller relies on, plus the two things JSPI needs:
//
//  1. ACTIVATION TRACKING. Every promising export the app declares is wrapped
//     so the shim always knows which activation is executing synchronously
//     (an explicit stack; JS is single-threaded so this is exact).
//
//  2. SHADOW-STACK DISCIPLINE (emscripten #27364, red/green-proven by
//     tests/apps/standalone/jspi-stack). JSPI switches the native stack per
//     activation but NOT the C spill stack. Every wrapped activation runs on
//     its own pooled spill-stack region with SP swapped at the window
//     boundaries ("green-region", same as libcontext's JSPI backend — KiCad
//     tool coroutines carry their own regions there and do NOT route through
//     here). Green-copy (snapshot/restore of the suspended range) is
//     deliberately NOT used: it rolls back writes other activations make
//     into parked frames' locals (stack-allocated wxDialog members mutated
//     by a cross-tick EndModal), resurrecting dead state at resume.
//
// Observability: an event ring + live activation table via __wxWaitDump().

(function () {
  "use strict";

  if (globalThis.__wxSchedulerInstalled) {
    return; // idempotent under double injection
  }

  var RING_CAP = 256;

  var S = {
    // --- mailbox lane (timers/wheel; ordering machinery, mechanism-free) ----
    // enqueueAfter queues a C callback; delivery happens through the dedicated
    // _wxWasmMailboxTick export from a fresh task, in order. The tick is a
    // suspension inside a delivered handler parks the tick's own activation,
    // and the rejection path carries the same containment (a throwing handler
    // must not leave a parked quasi-modal unresolved).
    mailbox: [],
    enqueued: 0,
    delivered: 0,
    _tickArmed: false,
    enqueueAfter: function (fn, arg, ms) {
      var self = this;
      setTimeout(function () {
        if (self.dead) return; // never deliver into a torn-down app
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
    _tickErrorContainment: function (e) {
      if (Module["_wx_dispatch_abandon"]) Module["_wx_dispatch_abandon"]();
      this.resolveTopWait("nested", 0);
      this.resolveTopWait("modal", 5101); // wxID_CANCEL
      console.warn("[wx-scheduler] mailbox tick error: " + e);
    },
    _armDeliveryTick: function () {
      if (this._tickArmed) return;
      this._tickArmed = true;
      var self = this;
      setTimeout(function tick() {
        if (self.dead) { self._tickArmed = false; return; }
        var p;
        try {
          p = Module["_wxWasmMailboxTick"] ? Module["_wxWasmMailboxTick"]() : undefined;
        } catch (e) {
          self._tickArmed = false;
          self._tickErrorContainment(e);
          throw e;
        }
        Promise.resolve(p).catch(function (e) { self._tickErrorContainment(e); });
        if (self.mailbox.length > 0) {
          setTimeout(tick, 17);
        } else {
          self._tickArmed = false;
        }
      }, 0);
    },

    // --- S1 embind lane --
    // Mutators (doc 18 classification) must not enter wasm while a load is in
    // flight: the open activation is suspended mid-load and a collab-apply /
    // save / theme flip entering between its parks would mutate the board
    // under it. The exclusion is semantic, independent of the suspension
    // mechanism. The FIFO drains, in order, once kicadOpenFileBusy clears.
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
        this._note("wrapped", "mutators", this.mutatorsWrapped);
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

    // The embind PARKERs (kicadOpenFile / kicadOpenFiles / kicadLibsReload,
    // registered emscripten::async()): wrap them with the
    // same activation tracking as the raw promising exports, so their parks
    // (wxWasmYieldUntil inside the load) find a tracked record and get the
    // green-region spill-stack discipline. Embind names live on Module WITHOUT
    // the underscore prefix, hence the separate installer.
    PARKER_NAMES: [
      "kicadOpenFile",
      "kicadOpenFiles",
      "kicadLibsReload",
      "kicadLibsAddEntry",
    ],
    _wrapParkers: function () {
      var wrapped = 0;
      for (var i = 0; i < this.PARKER_NAMES.length; i++) {
        var name = this.PARKER_NAMES[i];
        if (typeof Module[name] === "function") {
          Module[name] = this._wrapPromising(name, Module[name], this.PARKER_REGION_BYTES);
          wrapped++;
        }
      }
      this._note("wrapped", "parkers", wrapped);
      return wrapped;
    },

    // --- S4 wait registry (contract-compatible) ----------------------------
    waits: new Map(), // token -> {kind, promise, resolve, resolved, result, awaited}
    waitSeq: 0,
    waitStacks: {},   // kind -> [unresolved tokens], LIFO
    waitsBegun: 0,
    waitsResolved: 0,
    earlyWaitResolves: 0,

    beginWait: function (kind) {
      var token = ++this.waitSeq;
      var entry = { kind: kind, resolved: false, resolve: null, promise: null };
      entry.promise = new Promise(function (resolve) { entry.resolve = resolve; });
      this.waits.set(token, entry);
      (this.waitStacks[kind] = this.waitStacks[kind] || []).push(token);
      this.waitsBegun++;
      this._note("beginWait", kind, token);
      return token;
    },

    waitPromise: function (token) {
      var entry = this.waits.get(token);
      if (!entry) {
        console.warn("[wx-scheduler] waitPromise(" + token + "): unknown token");
        return Promise.resolve(0);
      }
      if (entry.resolved) {
        // resolved before the waiter parked (early-resolve window)
        this.waits.delete(token);
        return Promise.resolve(entry.result | 0);
      }
      entry.awaited = true;
      this._note("park", entry.kind, token);
      return this._suspendOn(entry.promise, entry.kind, token);
    },

    waitEarlyResolved: function (token) {
      var entry = this.waits.get(token);
      return entry && entry.resolved ? 1 : 0;
    },

    takeWaitResult: function (token) {
      var entry = this.waits.get(token);
      if (!entry || !entry.resolved) return 0;
      this.waits.delete(token);
      return entry.result | 0;
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
      entry.result = result | 0;
      entry.resolve(result | 0);
      this._note("resolve", entry.kind, token);
      if (entry.awaited) {
        this.waits.delete(token);
      } else {
        // early resolve: keep the entry, result attached, for the late waiter
        this.earlyWaitResolves++;
      }
      return true;
    },

    resolveTopWait: function (kind, result) {
      var stack = this.waitStacks[kind];
      if (!stack || stack.length === 0) return false;
      return this.resolveWait(stack[stack.length - 1], result);
    },

    pendingWaits: function (kind) {
      var stack = this.waitStacks[kind];
      return stack ? stack.length : 0;
    },

    dead: false,
    shutdown: function (why) {
      this.dead = true;
      // S6 teardown contract: queued-but-
      // undelivered mutators FAIL LOUDLY instead of hanging their callers,
      // and undelivered mailbox messages drop — the pumps stop themselves on
      // the dead flag.
      var q = this.mutatorQueue.splice(0, this.mutatorQueue.length);
      for (var i = 0; i < q.length; i++) {
        try { q[i].reject(new Error("wx scheduler shutdown: " + why)); } catch (e) { /* reject never throws */ }
      }
      this.mailbox.length = 0;
      var stranded = this.waits.size;
      if (stranded) {
        console.warn("[wx-scheduler] shutdown (" + why + ") stranded:" + stranded);
      } else {
        // teardown-gate contract (e2e/app-quit.spec.ts): a clean exit must
        // SAY so on the console
        console.log("[wx-scheduler] shutdown (" + why + ") clean");
      }
      this._note("shutdown", why, stranded);
    },

    // --- activation tracking + shadow-stack discipline ---------------------
    //
    // Window model (JS is single-threaded, so this is exact):
    //   * FIRST window — a promising export runs synchronously from its JS
    //     caller until first suspend or completion. It is a real JS call
    //     frame, so _actStack (push in the wrap, pop in its finally) mirrors
    //     the JS stack exactly, including exports entered synchronously from
    //     inside a resumed window.
    //   * RESUMED window — the engine re-enters a suspended activation from a
    //     promise reaction. There is NO JS frame of ours around it, so it is
    //     tracked by _windowLive instead.
    //   The wasm code executing at any suspension therefore belongs to
    //   _actStack's top when non-empty, else to _windowLive.
    //
    // Discipline: GREEN-REGION (per-activation spill-stack region + SP swap
    // at the window boundaries), the same leg of the jspi-stack red/green
    // bake-off the libcontext JSPI backend uses. NOT green-copy: a snapshot/
    // restore of the suspended range rolls back writes that OTHER activations
    // legitimately made into the parked frames' locals — a stack-allocated
    // wxDialog whose EndModal (from another tick's window) cleared
    // m_isShowingModal would have the flag restored to true at resume, and
    // its destructor then fires EndModal(wxID_CANCEL) into some OUTER modal's
    // wait (observed as the triple-modal LIFO failure). With a region per
    // activation nothing else ever executes on a parked activation's stack,
    // so cross-activation writes persist and nothing needs copying.
    //
    // Resume TURNSTILE: SP swaps must happen (a) only at microtask
    // boundaries (never while wasm frames are live on the JS stack) and
    // (b) for at most ONE activation between wasm re-entries — between our
    // swap and the engine's actual re-entry other microtasks still run, and
    // a second swap would redirect it. So ready resumes queue in
    // _resumeReady and _pumpResume (microtask-scheduled only) arms exactly
    // one and resolves its gate; the engine's re-entry is the only reaction
    // on that gate. The next pump happens when that window ENDS — its next
    // suspension or its completion — both of which we observe.
    _actSeq: 0,
    _actStack: [],        // records of FIRST windows currently on the JS stack
    _suspended: new Map(),// actId -> record, while suspended (dump/watchdog)
    _windowLive: null,    // record whose RESUMED window is executing (or armed)
    _resumeReady: [],     // FIFO of {rec, gate} whose wait promise resolved

    _sp: function () { return Module["stackSave"](); },
    _setSp: function (v) { Module["stackRestore"](v); },

    _top: function () {
      return this._actStack.length
          ? this._actStack[this._actStack.length - 1]
          : null;
    },

    // Per-activation spill-stack regions, pooled (malloc'd from the wasm
    // heap; wx dispatch chains are shallow compared to tool coroutines —
    // the deep KiCad tool bodies run on libcontext's own 256K regions).
    // PARKER_REGION_BYTES for the embind load chains (kicadOpenFile parses
    // whole boards on this stack).
    // KiCad dispatch chains and board loads run DEEP (a full board parse
    // happens on the parker's region; a paint dispatch can recurse through
    // tool handlers) — an overflowing region scribbles the heap below it and
    // kills the renderer. Regions are pooled, so generous sizes cost little.
    REGION_BYTES: 1024 * 1024,
    PARKER_REGION_BYTES: 8 * 1024 * 1024,
    _regionPool: {},      // size -> [regions]
    // This file is a --pre-js, so the glue's bare _malloc/_free are in scope
    // at call time; Module["_malloc"] is the fallback for glue shapes that
    // attach them there instead.
    _mallocFn: function () {
      return (typeof _malloc === "function") ? _malloc : Module["_malloc"];
    },
    _freeFn: function () {
      return (typeof _free === "function") ? _free : Module["_free"];
    },
    _regionAlloc: function (size) {
      var pool = (this._regionPool[size] = this._regionPool[size] || []);
      var r = pool.pop();
      if (r) return r;
      var base = this._mallocFn()(size);
      if (!base) throw new Error("[wx-scheduler] region alloc failed (" + size + ")");
      // A JS-initiated _malloc can GROW wasm memory, and glue code holding
      // pre-growth views then writes into a detached buffer (observed: the
      // fd_write out-param never landing, musl's __stdio_write retrying a
      // 0-byte writev forever). Refresh the glue's views immediately; the
      // install-time preallocation below makes this path rare to begin with.
      try {
        if (typeof updateMemoryViews === "function" && typeof wasmMemory !== "undefined"
            && typeof HEAPU8 !== "undefined" && HEAPU8.buffer !== wasmMemory.buffer) {
          updateMemoryViews();
        }
      } catch (e) { /* non-glue host (unit tests) */ }
      // The wasm C stack REQUIRES 16-byte alignment; wasm32 malloc only
      // guarantees 8. A region top at base+size can be 8 (mod 16), and a
      // misaligned SP skews every alignment-derived address in the
      // activation by 8 (observed: EM_ASM's readEmAsmArgs assert, and musl
      // __stdio_write passing an iov pointer 8 below the array it populated
      // -> an infinite 0-byte writev retry loop wedging the main thread).
      // Align the top DOWN; the lost <16 bytes are spare.
      return { base: base, top: (base + size) & ~15, size: size };
    },
    // Fill the pools while nothing is suspended (runtime init): any memory
    // growth this causes happens at a safe boundary instead of mid-window.
    _preallocRegions: function (haveParkers) {
      // Host without a wasm heap (the vitest fake runtime): nothing to fill.
      if (typeof this._mallocFn() !== "function") return;
      var i, rs = [];
      for (i = 0; i < 8; i++) rs.push(this._regionAlloc(this.REGION_BYTES));
      if (haveParkers) for (i = 0; i < 2; i++) rs.push(this._regionAlloc(this.PARKER_REGION_BYTES));
      for (i = 0; i < rs.length; i++) this._regionFree(rs[i]);
    },
    _regionFree: function (r) {
      var pool = (this._regionPool[r.size] = this._regionPool[r.size] || []);
      if (pool.length < 8) pool.push(r);
      else this._freeFn()(r.base);
    },

    // Wrap one promising export so the shim tracks its windows and gives the
    // activation its own spill region. The returned promise
    // (WebAssembly.promising exports and embind async() invokers always
    // return one) settles when the ACTIVATION completes — that frees the
    // region and un-parks the turnstile.
    _wrapPromising: function (name, fn, regionBytes) {
      var S = this;
      var bytes = regionBytes || S.REGION_BYTES;
      return function () {
        var enclosingSp = S._sp();
        var region = S._regionAlloc(bytes);
        var rec = {
          id: ++S._actSeq,
          kind: name,
          region: region,
          entrySp: region.top,
          suspendedAt: 0
        };
        S._actStack.push(rec);
        S._setSp(region.top);
        var out;
        try {
          out = fn.apply(this, arguments);
        } finally {
          var popped = S._actStack.pop();
          if (popped !== rec) {
            console.warn("[wx-scheduler] activation stack imbalance at " + name);
          }
          // First window over (completed, suspended, or threw): the caller
          // continues on the enclosing stack either way.
          S._setSp(enclosingSp);
          if (!(out && typeof out.then === "function")) {
            // sync throw or non-promise return: the activation is over now
            S._endActivation(rec);
          }
        }
        if (out && typeof out.then === "function") {
          out.then(
            function () { S._endActivation(rec); },
            function () { S._endActivation(rec); }
          );
        }
        return out;
      };
    },

    _endActivation: function (rec) {
      this._suspended.delete(rec.id);
      if (this._windowLive === rec) {
        // completed from a RESUMED window: wasm's epilogue left SP at the
        // region top — put the enclosing stack back before anything else
        // enters wasm.
        this._windowLive = null;
        if (rec.enclosingSp !== undefined) this._setSp(rec.enclosingSp);
      }
      if (rec.region) {
        this._regionFree(rec.region);
        rec.region = null;
      }
      var S = this;
      queueMicrotask(function () { S._pumpResume(); });
    },

    _pumpResume: function () {
      if (this.dead) return;
      if (this._windowLive) {
        // Self-heal: an activation that suspended RAW (bypassing the shim)
        // or completed untracked never ends its window here; without this
        // the pump would refuse resumes forever. Anything armed >2s while
        // resumes queue is such a leak — clear it loudly. (A window whose
        // wasm is genuinely executing can't be observed here at all: the
        // pump only runs between JS jobs.)
        var w = this._windowLive;
        if (w.windowArmedAt && Date.now() - w.windowArmedAt > 2000
            && this._resumeReady.length) {
          console.warn("[wx-scheduler] force-clearing stuck window act "
            + w.id + ":" + w.kind + " — some suspension bypassed the shim");
          this._note("forceClearWindow", w.kind, w.id);
          this._windowLive = null;
        } else {
          return;
        }
      }
      if (this._resumeReady.length === 0) return;
      var e = this._resumeReady.shift();
      var rec = e.rec;
      if (rec.dead) {
        // Quarantined (coroutine released while parked): the body's C++ is
        // freed — a late wake must never re-enter it. Drop the wake; the
        // gate promise parks the leaked activation forever (censused C-side).
        console.warn("[wx-scheduler] dropping wake for quarantined " + rec.id);
        this._note("deadWakeDropped", rec.kind, rec.id);
        var S = this;
        queueMicrotask(function () { S._pumpResume(); });
        return;
      }
      this._suspended.delete(rec.id);
      rec.suspendedAt = 0;
      // Arm the window: remember the enclosing stack (to put back when this
      // window ends) and point SP back into the activation's own region,
      // exactly where it suspended.
      rec.enclosingSp = this._sp();
      rec.windowArmedAt = Date.now();
      // Truthful attribution for the resumed slice's NEXT suspension: after
      // a foreign wake a coroutine re-enters through plain C with nothing on
      // the path to re-arm g_current (own-yield resumes re-set it C-side —
      // idempotent with this). Before the SP swap: make_current has real
      // frames (registry lookup) and must run on the enclosing stack.
      this._libctxMakeCurrent(rec.lcid || 0);
      this._setSp(rec.sp);
      this._windowLive = rec;
      // The engine's re-entry is the only reaction on the gate; microtasks
      // queued before it can only enqueue further resumes (no SP swaps —
      // _windowLive is set), so SP survives untouched until wasm runs.
      if (e.rejected) e.gate.reject(e.value);
      else e.gate.resolve(e.value);
    },

    // Untracked activations (main — the runtime calls it before the wraps
    // exist — and libctx coroutine bodies doing FOREIGN yields like
    // sleepYield) get a FRESH anonymous record per suspension. Not a shared
    // singleton: main is eternally parked on its frame yield, and a
    // singleton would let a coroutine's suspension overwrite main's saved
    // SP (cross-wired resumes). An uncontended activation like main still
    // keeps a stable identity naturally: its next suspension is attributed
    // to its own live window (rec === _windowLive) and reuses the record.
    _anonSeq: 0,

    // Route a suspension through the turnstile. No byte copying: the
    // activation's frames live in its own region (main: the central stack)
    // and stay valid while parked; only the shared SP global is handed back
    // and forth.
    _suspendOn: function (p, kind, token) {
      var S = this;
      // A FOREIGN yield from inside a KiCad coroutine body belongs to the
      // COROUTINE's activation — the wx entry that entered it is still on
      // the JS stack and must not be double-booked (its own libctx-enter
      // suspension already owns that record).
      var lcid = 0;
      try {
        lcid = (typeof _pcbjam_libctx_current === "function") ? _pcbjam_libctx_current()
             : (Module["_pcbjam_libctx_current"] ? Module["_pcbjam_libctx_current"]() : 0);
      } catch (e) { /* pre-runtime */ }
      var rec;
      if (lcid) {
        rec = S._libctxRecs[lcid] || (S._libctxRecs[lcid] = {
          id: "lc" + lcid, kind: "libctx", region: null,
          entrySp: S._sp(), suspendedAt: 0, libctx: true, lcid: lcid
        });
      } else {
        rec = S._actStack.length ? S._top() : S._windowLive;
      }
      if (!rec) {
        rec = {
          id: --S._anonSeq, kind: "untracked", region: null,
          entrySp: S._sp(), suspendedAt: 0, anon: true
        };
      }
      rec.sp = S._sp();
      rec.suspendedAt = Date.now();
      rec.waitKind = kind;
      rec.waitToken = token;
      S._suspended.set(rec.id, rec);
      // A coroutine that parks stops being the "current context": whatever
      // the event loop runs next would otherwise attribute ITS suspensions
      // to this parked coroutine (g_current dangles — no C code runs on the
      // unwind path). The arm below re-establishes it on resume.
      if (lcid) S._libctxMakeCurrent(0);
      if (S._windowLive === rec) {
        // a RESUMED window just suspended again — its window ends here; put
        // the enclosing stack back for whatever runs next.
        S._windowLive = null;
        if (rec.enclosingSp !== undefined) S._setSp(rec.enclosingSp);
        queueMicrotask(function () { S._pumpResume(); });
      }
      // (a FIRST window's end — including its SP hand-back — is the wrap's
      // finally; the completion hook frees the region.)
      var gate = {};
      gate.promise = new Promise(function (res, rej) {
        gate.resolve = res;
        gate.reject = rej;
      });
      p.then(
        function (v) {
          S._resumeReady.push({ rec: rec, gate: gate, value: v, rejected: false });
          queueMicrotask(function () { S._pumpResume(); });
        },
        function (err) {
          S._resumeReady.push({ rec: rec, gate: gate, value: err, rejected: true });
          queueMicrotask(function () { S._pumpResume(); });
        }
      );
      return gate.promise;
    },

    // --- libcontext (KiCad coroutine) turnstile integration ----------------
    // The coroutine backend manages its own spill REGIONS and SP save/restore
    // around its awaits, but its engine-level resumes must still be
    // SERIALIZED with everyone else's: un-turnstiled, the microtask that
    // restores the coroutine's SP can interleave with a turnstile arm, and
    // whichever runs last wins — the resumed wasm then spills into another
    // activation's region (observed: PCB_SELECTION_TOOL's first Wait()
    // trapping "memory access out of bounds" in Chromium, engine-ordering
    // dependent). The coroutine's ENTER/RESUME awaits suspend the CALLING wx
    // activation and route through promiseYield; the YIELD suspends the
    // COROUTINE'S OWN activation and uses these two hooks instead (explicit
    // SP, no _actStack attribution — at yield time the stack top is the
    // caller, not the coroutine).
    _libctxRecs: {},
    // Re-point the C-side g_current at the activation being armed (0 = root).
    // Leaf export; absent on heapless hosts (vitest) and pre-runtime — no-op.
    _libctxMakeCurrent: function (lcid) {
      try {
        if (typeof _pcbjam_libctx_make_current === "function") _pcbjam_libctx_make_current(lcid);
        else if (typeof Module !== "undefined" && Module["_pcbjam_libctx_make_current"]) Module["_pcbjam_libctx_make_current"](lcid);
      } catch (e) { /* pre-runtime */ }
    },
    libctxSuspend: function (id, p, sp) {
      var S = this;
      var rec = S._libctxRecs[id] || (S._libctxRecs[id] = {
        id: "lc" + id, kind: "libctx", region: null,
        entrySp: sp, suspendedAt: 0, libctx: true, lcid: id
      });
      rec.sp = sp;
      rec.suspendedAt = Date.now();
      rec.waitKind = "libctx";
      rec.waitToken = 0;
      S._suspended.set(rec.id, rec);
      // Parked: clear the C-side current-context pointer (see _suspendOn).
      S._libctxMakeCurrent(0);
      if (S._windowLive === rec) {
        S._windowLive = null;
        if (rec.enclosingSp !== undefined) S._setSp(rec.enclosingSp);
        queueMicrotask(function () { S._pumpResume(); });
      }
      var gate = {};
      gate.promise = new Promise(function (res, rej) {
        gate.resolve = res;
        gate.reject = rej;
      });
      p.then(
        function (v) {
          S._resumeReady.push({ rec: rec, gate: gate, value: v, rejected: false });
          queueMicrotask(function () { S._pumpResume(); });
        },
        function (err) {
          S._resumeReady.push({ rec: rec, gate: gate, value: err, rejected: true });
          queueMicrotask(function () { S._pumpResume(); });
        }
      );
      return gate.promise;
    },
    // Coroutine released while parked (quarantine contract): mark the record
    // dead so the pump drops any late wake (never re-enter the freed body),
    // and forget it. The rec object itself stays reachable from pending
    // p.then closures — the dead flag is what protects those paths.
    libctxQuarantine: function (id) {
      var rec = this._libctxRecs[id];
      if (!rec) return;
      rec.dead = true;
      this._suspended.delete(rec.id);
      if (this._windowLive === rec) {
        // Released from within its own running slice: that slice's wasm is
        // executing on this region RIGHT NOW — restoring the enclosing SP
        // here would yank the stack out from under it. Just drop the window
        // marker; the turnstile moves on when this job ends. (g_current is
        // reset C-side by release_fcontext.)
        console.warn("[wx-scheduler] quarantine of the LIVE window lc" + id
          + " — self-release mid-slice; skipping SP restore");
        this._windowLive = null;
      }
      delete this._libctxRecs[id];
      this._note("libctxQuarantine", "libctx", rec.id);
      var S = this;
      queueMicrotask(function () { S._pumpResume(); });
    },
    // Coroutine's entry activation completed (finished or trapped): end its
    // window so the turnstile moves on.
    libctxEnd: function (id) {
      var S = this;
      var rec = S._libctxRecs[id];
      if (!rec) return;
      S._suspended.delete(rec.id);
      if (S._windowLive === rec) {
        S._windowLive = null;
        if (rec.enclosingSp !== undefined) S._setSp(rec.enclosingSp);
      }
      delete S._libctxRecs[id];
      queueMicrotask(function () { S._pumpResume(); });
    },

    // Suspension helpers the wx EM_ASYNC_JS bodies route through, so every
    // park shares the one discipline implementation.
    frameYield: function () {
      return this._suspendOn(
        new Promise(function (r) { requestAnimationFrame(function () { r(0); }); }),
        "frame", 0);
    },
    sleepYield: function (ms) {
      return this._suspendOn(
        new Promise(function (r) { setTimeout(function () { r(0); }, ms); }),
        "sleep", 0);
    },
    promiseYield: function (p, kind) {
      return this._suspendOn(Promise.resolve(p), kind || "promise", 0);
    },

    // Called once the runtime is up: wrap the app's promising entry exports.
    // The list mirrors -sJSPI_EXPORTS (main excluded: the runtime calls it
    // before this hook can matter, and boot suspensions predate any tracked
    // activation anyway — see _suspendOn's null-rec path).
    installExportWraps: function (names) {
      var wrapped = 0;
      for (var i = 0; i < names.length; i++) {
        var key = "_" + names[i];
        if (typeof Module[key] === "function") {
          Module[key] = this._wrapPromising(names[i], Module[key]);
          wrapped++;
        }
      }
      this._note("wrapped", "exports", wrapped);
      return wrapped;
    },

    // --- observability ------------------------------------------------------
    _ring: [],
    _note: function (ev, a, b) {
      this._ring.push([Date.now(), ev, String(a), b | 0]);
      if (this._ring.length > RING_CAP) this._ring.shift();
    },

    dump: function () {
      var acts = [];
      this._suspended.forEach(function (rec) {
        acts.push({
          id: rec.id, kind: rec.kind, waitKind: rec.waitKind || null,
          token: rec.waitToken || 0,
          suspendedMs: rec.suspendedAt ? Date.now() - rec.suspendedAt : 0
        });
      });
      return {
        dead: this.dead,
        waitsBegun: this.waitsBegun,
        waitsResolved: this.waitsResolved,
        earlyWaitResolves: this.earlyWaitResolves,
        pendingWaits: this.waits.size,
        runningActivations: this._actStack.length,
        suspendedActivations: acts,
        mutatorsWrapped: this.mutatorsWrapped,
        mutatorsDelivered: this.mutatorsDelivered,
        mutatorQueueDepth: this.mutatorQueue.length,
        ring: this._ring.slice(-64)
      };
    }
  };

  globalThis.__wxScheduler = S;
  globalThis.__wxSchedulerInstalled = true; // wxWasmSchedulerAssertInstalled probe

  // --- diagnostic signals ---------------------------------------------------
  // SuspendError attributor: a SuspendError means a PLAIN (non-promising)
  // wasm entry tried to park — a missed -sJSPI_EXPORTS/installExportWraps
  // entry. The engine cannot say WHICH export, but the live dump (what was
  // wrapped, what was executing) is exactly the targeting data needed.
  if (typeof addEventListener === "function") {
    var suspendErr = function (m) {
      if (!m || !/suspend/i.test(String(m))) return;
      console.error("[wx-scheduler] SuspendError: a NON-promising wasm entry "
        + "tried to park — add the missing entry export to -sJSPI_EXPORTS and "
        + "installExportWraps. dump=" + JSON.stringify(S.dump()));
    };
    addEventListener("unhandledrejection", function (ev) {
      suspendErr(ev && ev.reason && (ev.reason.message || ev.reason));
    });
    addEventListener("error", function (ev) {
      suspendErr(ev && (ev.message || (ev.error && ev.error.message)));
    });
  }
  // Lost-wake watchdog: an activation parked on a TOKEN wait whose registry
  // entry is GONE (resolved+consumed or never registered) can never be
  // resumed — a lost wake. Frame/sleep parks are excluded (a hidden tab
  // legitimately parks the frame yield for minutes).
  setInterval(function () {
    if (S.dead) return;
    S._suspended.forEach(function (rec) {
      if (!rec.waitToken || rec.waitKind === "frame" || rec.waitKind === "sleep") return;
      if (rec.suspendedAt && Date.now() - rec.suspendedAt > 30000
          && !S.waits.has(rec.waitToken) && !rec._lostWakeWarned) {
        rec._lostWakeWarned = true;
        console.warn("[wx-scheduler] LOST WAKE: act " + rec.id + ":" + rec.kind
          + " parked " + Math.round((Date.now() - rec.suspendedAt) / 1000)
          + "s on " + rec.waitKind + "/" + rec.waitToken
          + " but the wait is no longer registered");
      }
    });
  }, 10000);
  globalThis.__wxWaitDump = function () { return S.dump(); };

  // Self-install the activation wraps once the runtime is up (this file ships
  // as a --pre-js, so Module exists here). The name set mirrors the
  // suspension-capable half of -sJSPI_EXPORTS; absent names are skipped.
  if (typeof Module !== "undefined") {
    var prevInit = Module["onRuntimeInitialized"];
    Module["onRuntimeInitialized"] = function () {
      if (prevInit) prevInit();
      S.installExportWraps([
        "wx_dom_event", "wx_dom_mouse", "wx_window_close", "wx_window_move",
        "wx_window_resize", "ProcessEvents", "wxWasmMailboxTick",
        "wxWasmTopLevelTick", "wxWasmJobTick"
      ]);
      // KiCad-only surfaces; both installers skip absent names, so the wx
      // test apps (no embind) pass through here untouched.
      var parkers = S._wrapParkers();
      S._wrapMutators();
      S._preallocRegions(parkers > 0);
    };
  }
})();
