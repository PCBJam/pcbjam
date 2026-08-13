// === AsyncifyScheduler (S2 — scheduler core: registry, deferred wakes, single writer) ===
// __WX_SCHEDULER_SHIM_SOURCE__ — injector idempotence sentinel. Must appear ONLY in
// this file: the obvious marker (__wxSchedulerInstalled) also occurs in evtloop.cpp's
// EM_JS probe text inside every glue, which made the injector skip real injections.
// docs/features/async/17-mailbox-scheduler-plan.md · injected only on WX_SCHEDULER=1 builds.
//
// S2 state: this file is the only handleSleep scheduler on WX_SCHEDULER builds.
// The injector selects it instead of the predecessor shim. It carries:
//   S1 · the wx mailbox (timer/wheel messages, wx/wasm/private/mailbox.h) and the
//        Embind owner gateway (doc 18 classification).
//   S2 · the scheduler core — per-sleep currData capture/restore, the
//        consume-once fiber rewind guard,
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
    // Explicit runtime identity for browser-adapter ownership checks. The web
    // shell still supports one Emscripten process per page; changing the full
    // Module requires a navigation, not scheduler reinstall in this realm.
    ownerModule: typeof Module !== "undefined" ? Module : null,
    // --- S1 wx mailbox ----------------------------------------------------
    mailbox: [],
    // Count every accepted timer from schedule until native transport pops it.
    // A long native park can prevent due messages from draining, and a long
    // delay can retain the same native payload before it becomes due. One
    // reservation bound covers both states.
    MAX_MAILBOX_JOBS: 4096,
    mailboxReserved: 0,
    mailboxTimers: new Set(),
    // One reservation token owns either a not-yet-due JS timer or its exact
    // due mailbox record. Native cancellation can therefore revoke the same
    // message on either side of the timeout boundary without scanning by
    // callback address (which is not a unique timer identity).
    mailboxReservations: new Map(),
    mailboxReservationSeq: 0,
    mailboxCanceled: 0,
    mailboxBackpressureRejections: 0,
    enqueued: 0,
    delivered: 0,
    mailboxHighWater: 0,
    _tickArmed: false,
    enqueueAfter: function (fn, arg, ms, workClass, targetScope,
                            targetGeneration, discard, coalesce,
                            leaseIdLow, leaseIdHigh,
                            leaseParentLow, leaseParentHigh,
                            leaseGenerationLow, leaseGenerationHigh) {
      var self = this;
      if (self.dead) return 0;
      if (self.mailboxReserved >= self.MAX_MAILBOX_JOBS) {
        self.mailboxBackpressureRejections++;
        self._failScheduler("mailbox reservation capacity exceeded", false);
        return 0;
      }
      if (self.mailboxReservationSeq >= 0xffffffff) {
        self._failScheduler("mailbox reservation token space exhausted", false);
        return 0;
      }
      var reservationToken = ++self.mailboxReservationSeq;
      var record = { timer: null, message: null };
      self.mailboxReserved++;
      self.mailboxReservations.set(reservationToken, record);
      self.mailboxHighWater = Math.max(
        self.mailboxHighWater, self.mailboxReserved);
      var timer = setTimeout(function () {
        if (self.mailboxReservations.get(reservationToken) !== record) return;
        self.mailboxTimers.delete(timer);
        record.timer = null;
        if (self.dead) return; // S6: never deliver into a torn-down app
        var message = {
          reservationToken: reservationToken,
          fn: fn,
          arg: arg,
          workClass: workClass >>> 0,
          targetScope: targetScope >>> 0,
          targetGeneration: targetGeneration >>> 0,
          discard: discard >>> 0,
          coalesce: coalesce >>> 0,
          // Exact native LeaseToken captured when the timer was scheduled.
          // JS transports its lossless 32-bit words but never interprets it.
          leaseIdLow: leaseIdLow >>> 0,
          leaseIdHigh: leaseIdHigh >>> 0,
          leaseParentLow: leaseParentLow >>> 0,
          leaseParentHigh: leaseParentHigh >>> 0,
          leaseGenerationLow: leaseGenerationLow >>> 0,
          leaseGenerationHigh: leaseGenerationHigh >>> 0,
        };
        record.message = message;
        self.mailbox.push(message);
        self.enqueued++;
        self._armDeliveryTick();
      }, ms);
      record.timer = timer;
      self.mailboxTimers.add(timer);
      return reservationToken;
    },
    cancelMailbox: function (reservationToken) {
      reservationToken = reservationToken >>> 0;
      if (reservationToken === 0) return false;
      var record = this.mailboxReservations.get(reservationToken);
      if (!record) return false;

      if (record.timer !== null) {
        clearTimeout(record.timer);
        this.mailboxTimers.delete(record.timer);
        record.timer = null;
      } else {
        var index = this.mailbox.indexOf(record.message);
        if (index < 0) {
          this._failScheduler(
            "mailbox cancellation lost its exact due record", false);
          return false;
        }
        this.mailbox.splice(index, 1);
        record.message = null;
      }

      this.mailboxReservations.delete(reservationToken);
      if (this.mailboxReserved <= 0) {
        this._failScheduler("mailbox reservation accounting underflow", false);
        return false;
      }
      this.mailboxReserved--;
      this.mailboxCanceled++;
      return true;
    },
    pop: function () {
      var m = this.mailbox.shift();
      if (m) {
        var reservationToken = m.reservationToken >>> 0;
        var record = this.mailboxReservations.get(reservationToken);
        if (!record || record.message !== m) {
          this._failScheduler(
            "mailbox pop lost its exact reservation", false);
          return null;
        }
        this.mailboxReservations.delete(reservationToken);
        record.message = null;
        this.delivered++;
        if (this.mailboxReserved > 0) this.mailboxReserved--;
        else this._failScheduler("mailbox reservation accounting underflow", false);
      }
      return m || null;
    },

    // --- Physical native-entry arbiter -----------------------------------
    // Semantic owners decide WHICH stateful transaction may run. This FIFO
    // separately decides WHEN a fresh JavaScript-to-Wasm scheduler entry may
    // run. A context can be physically parked inside handleSleep while the
    // C++ registry still reports it as Running. Marking a sibling Ready in
    // that interval lets the old pump resume the sibling inside the first
    // wake. The resulting capture has the wrong rewind root.
    //
    // Admission is two phase. A leaf C++ probe first confirms that the
    // registry has no running context and no transition. Only then is the job
    // removed and called exactly once. Never use the suspending job's return
    // value as admission: an Asyncify unwind can return a placeholder and
    // make an already-consumed operation look refused.
    nativeEntryQueue: [],
    nativeEntryKeys: new Set(),
    MAX_NATIVE_ENTRY_JOBS: 4096,
    // Completed providers can retain large strings or ArrayBuffers while the
    // native-entry gate is busy. The job-count bound limits closure overhead;
    // this separate reservation limits the payloads held by exact completion
    // closures without limiting requests which are still fetching.
    MAX_NATIVE_COMPLETION_BYTES: 64 * 1024 * 1024,
    nativeCompletionQueuedBytes: 0,
    nativeCompletionHighWaterBytes: 0,
    nativeCompletionBackpressureRejections: 0,
    nativeEntryHighWater: 0,
    nativeEntryDeferred: 0,
    nativeEntryDelivered: 0,
    nativeEntryCoalesced: 0,
    nativeEntryAbandoned: 0,
    nativeEntryAbandonCallbacks: 0,
    nativeEntryAbandonErrors: 0,
    _nativeEntryDrainArmed: false,
    // Browser input has a separate receipt identity from the physical entry
    // job which eventually stages it.  A receipt can wait in nativeEntryQueue
    // while Asyncify is transitioning; a later safe callback must not enter
    // native code ahead of it.  Tokens are monotonic, bounded, and consumed
    // exactly once by the native staging leaf.
    ingressReceiptSeq: 0,
    ingressReceipts: new Map(),
    pendingIngressReceipts: new Set(),
    MAX_INGRESS_RECEIPTS: 4096,
    ingressReceiptHighWater: 0,
    ingressReceiptDeferred: 0,
    ingressReceiptDelivered: 0,
    // Native publishes only an immutable control-plane snapshot.  No browser
    // adapter discovers a modal at delayed delivery time.  Until native makes
    // its first publication, provenance is explicitly unavailable rather than
    // guessed to mean "no modal".
    ingressLeaseSnapshot: Object.freeze({
      available: false,
      hasLease: false,
      targetScope: 0,
      targetGeneration: 0,
      leaseIdLow: 0,
      leaseIdHigh: 0,
      leaseParentLow: 0,
      leaseParentHigh: 0,
      leaseGenerationLow: 0,
      leaseGenerationHigh: 0,
    }),
    // Positive sleeps which park a scheduler context have a JS timer as their
    // exact wake source. Keep that source in one owned record until either
    // the timer hands it to the native-entry FIFO or native cancellation
    // revokes it. Context ids are monotonic and one context can own at most
    // one such sleep at a time.
    contextSleeps: new Map(),
    MAX_CONTEXT_SLEEPS: 4096,
    contextSleepHighWater: 0,
    contextSleepsScheduled: 0,
    contextSleepsCancelled: 0,
    contextSleepsDelivered: 0,
    _failScheduler: function (reason, integrityUnknown) {
      globalThis.__wxWasmFailed = true;
      if (integrityUnknown) globalThis.__wxNativeIntegrityUnknown = true;
      this.shutdown(String(reason || "fatal scheduler failure"));
    },
    _nativeTransitionFree: function () {
      return Asyncify.state === 0
        && !(typeof Fibers !== "undefined" && Fibers.trampolineRunning);
    },
    publishIngressLeaseSnapshot: function (snapshot) {
      if (this.dead || !snapshot || typeof snapshot !== "object") return false;
      var normalized = {
        available: snapshot.available === true,
        hasLease: snapshot.hasLease === true,
        targetScope: snapshot.targetScope >>> 0,
        targetGeneration: snapshot.targetGeneration >>> 0,
        leaseIdLow: snapshot.leaseIdLow >>> 0,
        leaseIdHigh: snapshot.leaseIdHigh >>> 0,
        leaseParentLow: snapshot.leaseParentLow >>> 0,
        leaseParentHigh: snapshot.leaseParentHigh >>> 0,
        leaseGenerationLow: snapshot.leaseGenerationLow >>> 0,
        leaseGenerationHigh: snapshot.leaseGenerationHigh >>> 0,
      };
      var hasToken = normalized.leaseIdLow !== 0
        || normalized.leaseIdHigh !== 0
        || normalized.leaseParentLow !== 0
        || normalized.leaseParentHigh !== 0
        || normalized.leaseGenerationLow !== 0
        || normalized.leaseGenerationHigh !== 0;
      if (!normalized.available
          || (normalized.hasLease
              ? (normalized.targetScope === 0
                 || normalized.targetGeneration === 0
                 || !hasToken)
              : (normalized.targetScope !== 0
                 || normalized.targetGeneration !== 0
                 || hasToken))) {
        this.ingressLeaseSnapshot = Object.freeze({
          available: false,
          hasLease: false,
          targetScope: 0,
          targetGeneration: 0,
          leaseIdLow: 0,
          leaseIdHigh: 0,
          leaseParentLow: 0,
          leaseParentHigh: 0,
          leaseGenerationLow: 0,
          leaseGenerationHigh: 0,
        });
        return false;
      }
      this.ingressLeaseSnapshot = Object.freeze(normalized);
      return true;
    },
    _captureIngressReceipt: function () {
      if (this.dead) return 0;
      if (this.ingressReceipts.size >= this.MAX_INGRESS_RECEIPTS) {
        this._failScheduler("browser-ingress receipt capacity exceeded", false);
        return 0;
      }
      if (this.ingressReceiptSeq >= 0x7fffffff) {
        this._failScheduler("browser-ingress receipt token space exhausted", false);
        return 0;
      }
      var token = ++this.ingressReceiptSeq;
      var published = this.ingressLeaseSnapshot;
      var receipt = Object.freeze({
        sequence: token,
        snapshotAvailable: published.available === true,
        deferredBehindEarlier: this.pendingIngressReceipts.size > 0,
        hasLease: published.available === true && published.hasLease === true,
        targetScope: published.targetScope >>> 0,
        targetGeneration: published.targetGeneration >>> 0,
        leaseIdLow: published.leaseIdLow >>> 0,
        leaseIdHigh: published.leaseIdHigh >>> 0,
        leaseParentLow: published.leaseParentLow >>> 0,
        leaseParentHigh: published.leaseParentHigh >>> 0,
        leaseGenerationLow: published.leaseGenerationLow >>> 0,
        leaseGenerationHigh: published.leaseGenerationHigh >>> 0,
      });
      this.ingressReceipts.set(token, receipt);
      this.ingressReceiptHighWater = Math.max(
        this.ingressReceiptHighWater, this.ingressReceipts.size);
      return token;
    },
    captureNativeIngressReceipt: function () {
      return this._captureIngressReceipt();
    },
    takeIngressReceipt: function (token) {
      token = token >>> 0;
      var receipt = this.ingressReceipts.get(token);
      if (!receipt) return null;
      this.ingressReceipts.delete(token);
      this.pendingIngressReceipts.delete(token);
      this.ingressReceiptDelivered++;
      return receipt;
    },
    _enqueueNativeEntry: function (key, site, run, completionBytes,
                                  onAbandon) {
      if (this.dead || typeof run !== "function") return false;
      var coalesceKey = key === null || key === undefined || key === ""
        ? null : String(key);
      // A keyed job is a level signal: a later signal can coalesce into an
      // earlier closure.  An abandonment callback, by contrast, promises an
      // exact run-or-abandon edge.  Keep those contracts disjoint.
      if (coalesceKey !== null && typeof onAbandon === "function") return false;
      if (coalesceKey !== null && this.nativeEntryKeys.has(coalesceKey)) {
        this.nativeEntryCoalesced++;
        return true;
      }
      if (this.nativeEntryQueue.length >= this.MAX_NATIVE_ENTRY_JOBS) {
        this._failScheduler(
          "native-entry queue capacity exceeded at " + String(site), false);
        return false;
      }
      this.nativeEntryQueue.push({
        key: coalesceKey,
        site: String(site || "native entry"),
        run: run,
        completionBytes: completionBytes,
        // Pure-JS finalizer only. It may reject a Promise or release a JS
        // payload. It must never call a Wasm export, touch MEMFS/HEAP, or
        // finish a native proxy context: shutdown can mean native integrity
        // is already unknown.
        onAbandon: typeof onAbandon === "function" ? onAbandon : null,
      });
      if (coalesceKey !== null) this.nativeEntryKeys.add(coalesceKey);
      this.nativeEntryHighWater = Math.max(
        this.nativeEntryHighWater, this.nativeEntryQueue.length);
      this._armNativeEntryDrain();
      return true;
    },
    enqueueNativeEntry: function (key, site, run, onAbandon) {
      return this._enqueueNativeEntry(key, site, run, 0, onAbandon);
    },
    // Exact delayed completions use the same physical FIFO, with a byte
    // reservation for the payload retained by `run`. The reservation is
    // released immediately before the callback, when that payload stops being
    // queued and becomes the one actively consumed completion.
    enqueueNativeCompletion: function (site, estimatedBytes, run, onAbandon) {
      if (this.dead || typeof run !== "function") return false;
      if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0
          || estimatedBytes > this.MAX_NATIVE_COMPLETION_BYTES
          || this.nativeCompletionQueuedBytes + estimatedBytes
               > this.MAX_NATIVE_COMPLETION_BYTES) {
        this.nativeCompletionBackpressureRejections++;
        this._failScheduler(
          "native-completion byte capacity exceeded at " + String(site), false);
        return false;
      }

      var self = this;
      var accepted = this._enqueueNativeEntry(
        null, site, function () {
          return self.runNativeCompletion(String(site || "native completion")
            + " trapped", run);
        }, estimatedBytes, onAbandon);
      if (!accepted) return false;

      this.nativeCompletionQueuedBytes += estimatedBytes;
      this.nativeCompletionHighWaterBytes = Math.max(
        this.nativeCompletionHighWaterBytes,
        this.nativeCompletionQueuedBytes);
      return true;
    },
    _releaseNativeCompletionBytes: function (job) {
      var bytes = job && job.completionBytes;
      if (bytes === 0) return true;
      if (!Number.isSafeInteger(bytes) || bytes < 0
          || bytes > this.nativeCompletionQueuedBytes) {
        this._failScheduler(
          "native-completion payload accounting underflow", false);
        return false;
      }
      this.nativeCompletionQueuedBytes -= bytes;
      job.completionBytes = 0;
      return true;
    },
    _abandonQueuedNativeEntries: function (reason) {
      // Detach all scheduler ownership and capacity BEFORE user finalizers.
      // A finalizer can observe a closed, empty queue and cannot re-enqueue
      // because shutdown marks the scheduler dead first.
      var abandoned = this.nativeEntryQueue.splice(
        0, this.nativeEntryQueue.length);
      this.nativeEntryKeys.clear();
      this.nativeCompletionQueuedBytes = 0;
      this._nativeEntryDrainArmed = false;
      this.nativeEntryAbandoned += abandoned.length;

      for (var i = 0; i < abandoned.length; i++) {
        var job = abandoned[i];
        job.completionBytes = 0;
        // Drop the native/proxy delivery closure before calling any JS-only
        // observer. A terminal path must not use that closure as cleanup.
        job.run = null;
        var onAbandon = job.onAbandon;
        job.onAbandon = null;
        if (typeof onAbandon !== "function") continue;

        var error = new Error(
          "[wx-scheduler] native entry abandoned at " + job.site
            + ": " + reason);
        error.code = "WX_NATIVE_ENTRY_ABANDONED";
        error.site = job.site;
        this.nativeEntryAbandonCallbacks++;
        try {
          onAbandon(error);
        } catch (abandonError) {
          this.nativeEntryAbandonErrors++;
          console.error("[wx-scheduler] native-entry abandonment callback failed at "
            + job.site + ":", abandonError);
        }
      }
      abandoned.length = 0;
    },
    _cancelNativeEntryRun: function (run) {
      for (var i = 0; i < this.nativeEntryQueue.length; i++) {
        var job = this.nativeEntryQueue[i];
        if (job.run !== run) continue;
        this.nativeEntryQueue.splice(i, 1);
        if (job.key !== null) this.nativeEntryKeys.delete(job.key);
        if (!this._releaseNativeCompletionBytes(job)) return false;
        job.run = null;
        job.onAbandon = null;
        return true;
      }
      return false;
    },
    scheduleContextSleep: function (context, token, delay) {
      var self = this;
      context = context >>> 0;
      token = token >>> 0;
      delay = Math.max(1, Number(delay) || 1);

      if (self.dead || context === 0 || token === 0) return false;
      if (self.contextSleeps.has(context)) {
        self._failScheduler(
          "context " + context + " already owns a timed sleep", false);
        return false;
      }
      if (self.contextSleeps.size >= self.MAX_CONTEXT_SLEEPS) {
        self._failScheduler("context-sleep capacity exceeded", false);
        return false;
      }

      var record = { token: token, timer: null, run: null };
      record.run = function () {
        // Deletion happens before native entry. If native marks the context
        // Ready and that context is then retired, there is no stale timer
        // lease left for fiber_release() to revoke.
        if (self.contextSleeps.get(context) !== record) return;
        self.contextSleeps.delete(context);
        self.contextSleepsDelivered++;
        if (!self.canTouchNative()) return;
        if (typeof Module["_pcbjam_context_sleep_wake"] !== "function") {
          self._failScheduler("context-sleep wake export is missing", false);
          return;
        }
        if ((Module["_pcbjam_context_sleep_wake"](context, token) | 0) !== 1
            && !self.dead) {
          self._failScheduler(
            "context-sleep target refused its exact wake", false);
        }
      };
      record.timer = setTimeout(function () {
        if (self.contextSleeps.get(context) !== record || self.dead) return;
        record.timer = null;
        if (!self.enqueueNativeEntry(
              null, "context-sleep wake " + context, record.run)
            && !self.dead) {
          self._failScheduler(
            "context-sleep exact wake was not accepted", false);
        }
      }, delay);
      self.contextSleeps.set(context, record);
      self.contextSleepsScheduled++;
      self.contextSleepHighWater = Math.max(
        self.contextSleepHighWater, self.contextSleeps.size);
      return true;
    },
    cancelContextSleep: function (context, token) {
      context = context >>> 0;
      token = token >>> 0;
      var record = this.contextSleeps.get(context);
      // Terminal shutdown has already cleared every timer and native-entry
      // closure. Native teardown may release its parked stacks afterwards;
      // that is a successful revocation, not an ownership mismatch.
      if (!record) return this.dead;
      if (token === 0 || record.token !== token) {
        this._failScheduler(
          "context-sleep cancellation token mismatch for " + context, false);
        return false;
      }

      this.contextSleeps.delete(context);
      if (record.timer !== null) {
        clearTimeout(record.timer);
        record.timer = null;
      } else if (!this._cancelNativeEntryRun(record.run)) {
        this._failScheduler(
          "context-sleep cancellation lost its queued wake for " + context,
          false);
        return false;
      }
      this.contextSleepsCancelled++;
      return true;
    },
    releaseFiberGuard: function (fiber) {
      // Emscripten identifies a fiber by the address of emscripten_fiber_t.
      // The native registry calls this immediately before reclaiming that
      // object. Remove every compatibility-guard reference so allocator
      // address reuse cannot inherit an old suspension or park identity.
      fiber = fiber >>> 0;
      if (typeof Fibers === "undefined") return;
      if (Fibers.__validSuspensions)
        Fibers.__validSuspensions.delete(fiber);
      if (Fibers.__internallyParked)
        Fibers.__internallyParked.delete(fiber);
      if (Fibers.__parkSleepBuf)
        Fibers.__parkSleepBuf.delete(fiber);
      if (Fibers.__rootFiber === fiber)
        Fibers.__rootFiber = undefined;
    },
    _armNativeEntryDrain: function () {
      if (this._nativeEntryDrainArmed || this.dead
          || this.nativeEntryQueue.length === 0
          || !this._nativeTransitionFree()) return;
      this._nativeEntryDrainArmed = true;
      var self = this;
      setTimeout(function () {
        self._nativeEntryDrainArmed = false;
        if (self.dead || self.nativeEntryQueue.length === 0
            || !self._nativeTransitionFree()) return;

        var ready = Module["_wxWasmNativeEntryReady"];
        if (typeof ready !== "function") {
          self._failScheduler("native-entry readiness probe is missing", false);
          return;
        }
        try {
          if ((ready() | 0) !== 1) {
            // Level-triggered, not a timer retry. The next completed Asyncify
            // transition signals this queue through maybeStopUnwind().
            self.nativeEntryDeferred++;
            return;
          }
        } catch (e) {
          if (!self._terminalizeNativeTrap(
                "native-entry readiness probe trapped", e)) {
            globalThis.__wxWasmFailed = true;
            globalThis.__wxNativeIntegrityUnknown = true;
            self.shutdown("native-entry readiness probe trapped: " + String(e));
          }
          throw e;
        }

        // Consume before calling. A suspending export can unwind and return a
        // placeholder; it must never be replayed on that basis.
        var job = self.nativeEntryQueue.shift();
        if (job.key !== null) self.nativeEntryKeys.delete(job.key);
        self.nativeEntryDelivered++;
        // Consume the reservation before the callback. Promise reactions
        // cannot interleave until this synchronous completion returns, so the
        // active payload cannot overlap a newly queued one outside the cap.
        if (!self._releaseNativeCompletionBytes(job)) return;
        // From this point the delivery closure owns normal/trap settlement.
        // Shutdown must not also report this already-consumed job abandoned.
        job.onAbandon = null;
        try {
          job.run();
        } catch (e) {
          if (!self._terminalizeNativeTrap(job.site + " trapped", e)) {
            globalThis.__wxWasmFailed = true;
            globalThis.__wxNativeIntegrityUnknown = true;
            self.shutdown(job.site + " trapped: " + String(e));
          }
          throw e;
        }

        // At most one accepted entry runs in this macrotask. If its unwind
        // left the registry busy, the next leaf probe runs once and then waits
        // for the exact transition-completion edge.
        if (self.nativeEntryQueue.length > 0) self._armNativeEntryDrain();
      }, 0);
    },

    // Deliver via a dedicated PLAIN export call (wxWasmMailboxTick), never
    // from inside a pump's awaited ProcessEvents ccall — a fiber swap there
    // sits on the JS-awaits-a-suspending-export boundary (#13302) and traps.
    // Resume ready contexts from a FRESH task. Separate from the mailbox tick
    // because it must run even when the mailbox is empty: a context wake is
    // work the pump owns, not a queued message.
    _armSchedPump: function () {
      if (this._pumpArmed) return;
      this._pumpArmed = true;
      var self = this;
      if (!this.enqueueNativeEntry("sched-pump", "scheduler pump", function () {
        self._pumpArmed = false;
        if (self.dead) return;
        if (typeof Module["_wxWasmSchedPump"] !== "function") {
          self._failScheduler("scheduler-pump export is missing", false);
          return;
        }
        Module["_wxWasmSchedPump"]();
      })) this._pumpArmed = false;
    },
    _armDeliveryTick: function () {
      if (this._tickArmed) return;
      this._tickArmed = true;
      var self = this;
      if (!this.enqueueNativeEntry("mailbox", "mailbox delivery", function () {
        if (self.dead) { self._tickArmed = false; return; }
        if (typeof Module["_wxWasmMailboxTick"] !== "function") {
          self._tickArmed = false;
          self._failScheduler("mailbox delivery export is missing", false);
          return;
        }
        Module["_wxWasmMailboxTick"]();
        // The C++ tick transports every item present on entry into the typed
        // execution-owner queue. If admission is blocked, the release edge
        // arms that central queue directly; the JS mailbox never polls at
        // 17 ms. A later timer expiry observes _tickArmed=false and arms once.
        self._tickArmed = false;
        if (self.mailbox.length > 0) self._armDeliveryTick();
      })) this._tickArmed = false;
    },

    // A WebAssembly trap is not an application-level command failure. It can
    // leave native invariants, saved Asyncify stacks, and target lifetimes
    // unknowable, so the instance must become terminal before the trap escapes.
    // Keep this containment entirely in JavaScript: calling another Wasm export
    // to "unlock" the instance after a trap would enter the damaged runtime.
    nativeTraps: 0,
    _isNativeTrap: function (error) {
      if (typeof WebAssembly !== "undefined"
          && typeof WebAssembly.RuntimeError === "function"
          && error instanceof WebAssembly.RuntimeError) {
        return true;
      }

      // `instanceof` is not reliable across realms. Emscripten and browsers
      // also use a few stable trap messages when the original RuntimeError has
      // crossed a wrapper which did not preserve its prototype.
      if (error && error.name === "RuntimeError") return true;
      var message = String(error && error.message !== undefined
        ? error.message : error);
      return /index out of bounds|memory access out of bounds|out of bounds memory access|(?:^|RuntimeError:\s*)unreachable(?: executed)?(?:$|\n)|indirect call signature|null function or function signature|call_indirect to a null table entry/i.test(message);
    },
    _terminalizeNativeTrap: function (site, error) {
      if (!this._isNativeTrap(error)) return false;
      // Set this before shutdown. Shutdown clears pending EM_ASYNC_JS popup
      // resolvers; rejecting one would schedule a rewind into the native
      // instance which just trapped. The marker makes that cleanup abandon
      // the saved frame instead.
      globalThis.__wxNativeIntegrityUnknown = true;
      // A trap can pass through an inner wake/import catch and then the outer
      // Asyncify wrapper. Terminal containment is a one-way state transition,
      // not one action per JavaScript catch frame.
      if (this.dead && globalThis.__wxWasmFailed) {
        globalThis.__wxNativeIntegrityUnknown = true;
        return true;
      }
      this.nativeTraps++;
      globalThis.__wxWasmFailed = true;
      this.shutdown(site + ": " + String(error));
      return true;
    },
    // Promise/timer callbacks which were armed before shutdown can still run
    // afterwards. They must consult this before touching FS/HEAP, allocating in
    // the module, or calling any Wasm export. After a native trap even a
    // destructor/free is unsafe: abandon the JS payload and replace the module.
    canTouchNative: function () {
      return !this.dead && !globalThis.__wxNativeIntegrityUnknown;
    },
    // The one boundary for delayed JS completions which must touch Wasm
    // memory, FS, or an export. A trap closes the gate before it escapes, so a
    // Promise catch may report/fallback but cannot retry native work.
    runNativeCompletion: function (site, fn) {
      if (!this.canTouchNative()) return undefined;
      try {
        return fn();
      } catch (e) {
        this._terminalizeNativeTrap(site, e);
        throw e;
      }
    },
    // Complete one exact token wait from a delayed Promise/timer callback.
    // `prepare` may copy into MEMFS/HEAP or call malloc, and must return the
    // int32 result handed to the waiter. It runs immediately because it owns
    // the parked waiter's output pointers: queuing it behind the physical
    // readiness probe can deadlock the very context this completion wakes.
    // JavaScript cannot run this callback while Wasm is synchronously active;
    // resolveWait separately routes a context wake through the physical FIFO.
    runWaitCompletion: function (site, token, prepare) {
      token = token | 0;
      if (!this.canTouchNative() || token <= 0
          || typeof prepare !== "function") return false;
      var self = this;
      try {
        return this.runNativeCompletion(site, function () {
          var result = prepare() | 0;
          if (self.resolveWait(token, result)) return true;
          // A live completion cannot lose its exact token. Continue neither
          // with leaked output pointers nor with a caller that can never
          // resume.
          if (!self.dead)
            self._failScheduler(
              "wait completion lost exact token " + token + " at " + site,
              false);
          return false;
        }) === true;
      } catch (e) {
        // runNativeCompletion has already terminalized a native trap. An
        // ordinary JavaScript exception is just as fatal for this exact edge:
        // prepare may have partly written native output, and the caller owns
        // no other source which can settle its token. Stop the instance before
        // the exception reaches a Promise catch which might otherwise retry.
        if (!this.dead)
          this._failScheduler(
            "wait completion threw before exact token " + token
              + " settled at " + site + ": " + String(e),
            false);
        throw e;
      }
    },
    // Event-time ingress receipts are the one intentional immediate native
    // lane. They are strict transport leaves: native copies an owned payload,
    // captures the current semantic lease token, appends one queue record, and
    // arms this arbiter. It cannot admit, switch contexts, or suspend.
    //
    // Prove the physical leaf predicate synchronously and without yielding
    // before the receipt. A logical libcontext transition may still be active
    // while its Wasm stack is unwound in an async sleep, or imported JS may be
    // on the same synchronous stack. Neither state is a reason to call the
    // fresh-entry readiness probe: this strict leaf is safe because JavaScript
    // execution is serialized and it cannot admit, switch, or suspend.
    //
    // Neither case is safe during unwind/rewind or an Emscripten fiber
    // trampoline.  Retain the immutable JavaScript receipt in the physical
    // FIFO in that narrow window.  Native binds it to the semantic state at
    // the next safe queue boundary, exactly as a native GUI loop classifies an
    // event when it removes that event from the platform queue.  The staged
    // job still validates its captured DOM/window identity before mutation, so
    // a destroyed target cannot borrow a later modal generation.
    runNativeIngressReceipt: function (site, fn) {
      if (!this.canTouchNative() || typeof fn !== "function") return false;
      var token = this._captureIngressReceipt();
      if (!token) return false;
      var self = this;
      var deliver = function () {
        var result;
        try {
          result = fn(token);
        } finally {
          // The native staging leaf must take the exact receipt.  A refusal
          // may return after taking it, but an accepted call which forgot the
          // token would lose both FIFO and modal provenance.
          if (self.ingressReceipts.has(token) && !self.dead) {
            self.ingressReceipts.delete(token);
            self.pendingIngressReceipts.delete(token);
            self._failScheduler(
              String(site) + " did not consume its ingress receipt", false);
          }
        }
        return result;
      };
      // Once any earlier external receipt is retained, every later receipt
      // joins the same FIFO even if Asyncify has become Normal in between.
      // This closes the A-deferred/B-inline overtaking window.
      if (!this._nativeTransitionFree()
          || this.pendingIngressReceipts.size > 0) {
        this.pendingIngressReceipts.add(token);
        var queued = this.enqueueNativeEntry(null, site, function () {
          var staged = deliver();
          if ((staged | 0) !== 1 && !self.dead)
            self._failScheduler(String(site) + " was refused", false);
        });
        if (queued) {
          this.nativeEntryDeferred++;
          this.ingressReceiptDeferred++;
          // This method reports ownership transfer, not synchronous native
          // completion.  The immutable receipt now belongs to the FIFO.
          return 1;
        }
        this.pendingIngressReceipts.delete(token);
        this.ingressReceipts.delete(token);
        return false;
      }

      try {
        // fn may call ONLY the transport staging export. Its native guard
        // makes the final coordinator-failure and envelope checks.
        return deliver();
      } catch (e) {
        this._terminalizeNativeTrap(site, e);
        throw e;
      }
    },
    _detachNativeBrowserIngress: function () {
      // Emscripten's generated keyboard/mouse/touch handlers otherwise remain
      // able to call function-table entries after fail-stop. Removing them is
      // a pure JavaScript operation, so it is safe even when native integrity
      // is unknown. Custom wx browser callbacks consult canTouchNative().
      try {
        if (typeof JSEvents !== "undefined"
            && typeof JSEvents.removeAllEventListeners === "function") {
          JSEvents.removeAllEventListeners();
        }
      } catch (e) {
        console.error("[wx-scheduler] native ingress detach failed:", e);
      }
    },

    // --- S1 embind owner gateway -----------------------------------------
    // Only completed-payload, stateful C++ calls belong here. The gateway
    // submits an opaque JS job id to wx; wx admits it as Ordinary work on a
    // fresh dispatch context and calls deliverMutator() while that semantic
    // owner is live. Network/service functions are deliberately absent: their
    // fetches remain concurrent and enqueue only the completed stateful apply.
    // Any entry which reads or writes mutable wx/KiCad state must
    // cross this boundary. "Read-only" describes the C++ operation, not its
    // concurrency contract: walking a selection, viewport, document, or
    // library-use graph while another owner is parked is just as unsafe as a
    // write. Small scheduler/control probes stay synchronous; network fetches
    // stay outside so independent I/O remains concurrent.
    MUTATOR_NAMES: [
      "kicadSetChrome", "kicadSetReadOnly",
      "kicadCollabApply", "kicadCollabApplyItems",
      "kicadCollabSnapshot", "kicadCollabSnapshotItems",
      "kicadCollabGetPos", "kicadCollabGetViewport",
      "kicadCollabGetSelection", "kicadCollabGetSelectionFull",
      "kicadCollabTestGetCrossMapped", "kicadCollabTestGetLocked",
      "kicadCollabTestListItems", "kicadCollabTestDemoSet",
      "kicadCollabTestItemBlob", "kicadCollabTestUndoDepth",
      // These hooks model ordinary local edits in browser tests. They are
      // exported in the normal bundles and touch the same document, undo, and
      // selection state as UI input, so a "Test" prefix is not an ownership
      // exemption. Only the narrow kicadTest* scheduler collision levers stay
      // direct.
      "kicadCollabTestAddText", "kicadCollabTestMoveFirst",
      "kicadCollabTestRemoveItem", "kicadCollabTestRotateItem",
      "kicadCollabTestUndo", "kicadCollabTestSelectComponent",
      "kicadCollabTestSelectByUuid", "kicadCollabTestSelectFirst",
      "kicadCollabTestClearSelection", "kicadCollabTestSetFieldText",
      "kicadCollabTestAddWire", "kicadCollabTestAddJunction",
      "kicadCollabTestAddNoConnect", "kicadCollabTestAddLabel",
      "kicadCollabTestAddSymbol", "kicadCollabTestMoveSchItem",
      "kicadCollabTestMirrorSchItem", "kicadCollabTestDuplicateSchItem",
      "kicadCollabTestSetPadSize", "kicadCollabTestMoveEndpoint",
      "kicadCollabTestAddTrack", "kicadCollabTestAddVia",
      "kicadCollabTestAddBoardText", "kicadCollabTestAddZone",
      "kicadCollabTestFlipBoardItem", "kicadCollabTestSetFootprintField",
      "kicadCollabTestSetBoardItemLocked", "kicadCollabTestMoveBoardItem",
      "kicadCollabTestDuplicateBoardItem", "kicadCollabTestRunOnFiberPark",
      "kicadCollabTestRunOnFiberModal",
      "kicadCollabPresenceStart", "kicadCollabSetRemote",
      "kicadCollabSetPins", "kicadCollabSetStyle",
      "kicadCollabSetViewport", "kicadCollabFitViewport",
      "kicadCollabReleaseSelection", "kicadSetColorTheme",
      "kicadLibsReload", "kicadLibsSymbolUsage",
      "kicadSaveBoard", "kicadSaveSchematic", "kicadSaveDrawingSheet",
    ],
    mutatorQueue: [],       // FIFO of job ids; head is the only submitted job
    mutatorJobs: new Map(), // job id -> JS closure + settle-once state
    MAX_MUTATOR_JOBS: 10000,
    MAX_MUTATOR_PAYLOAD_BYTES: 16 * 1024 * 1024,
    mutatorQueuedBytes: 0,
    mutatorHighWaterJobs: 0,
    mutatorHighWaterBytes: 0,
    mutatorBackpressureRejections: 0,
    mutatorJobLimitRejections: 0,
    mutatorByteLimitRejections: 0,
    mutatorSeq: 0,
    mutatorInFlight: 0,
    mutatorsWrapped: 0,
    mutatorsSubmitted: 0,
    mutatorsDelivered: 0,
    _mutatorPumpArmed: false,
    _nextMutatorId: function () {
      // Job ids cross a wasm32 integer boundary. Skip zero (the empty token)
      // and avoid reusing an id which is still present after wraparound.
      for (var i = 0; i < 0x7fffffff; i++) {
        this.mutatorSeq = (this.mutatorSeq % 0x7fffffff) + 1;
        if (!this.mutatorJobs.has(this.mutatorSeq)) return this.mutatorSeq;
      }
      throw new Error("[wx-scheduler] embind job id space exhausted");
    },
    // Every audited gateway export accepts primitive Embind values or JSON
    // strings. Reference-shaped arguments would remain mutable after enqueue
    // and can retain an unknowable object graph, so reject them conservatively;
    // a future adapter must copy/serialize such payloads before this boundary.
    _estimateMutatorPayloadBytes: function (args) {
      var limit = this.MAX_MUTATOR_PAYLOAD_BYTES;
      var total = 0;
      for (var i = 0; i < args.length; i++) {
        var value = args[i];
        var type = typeof value;

        if (value === null) total += 4;
        else if (type === "undefined") total += 1;
        else if (type === "boolean") total += 4;
        else if (type === "number") total += 8;
        else if (type === "string") total += value.length * 2;
        else if (type === "bigint") total += 16 + Math.ceil(value.toString(16).length / 2);
        else if (type === "symbol") {
          var description = value.description;
          total += 16 + (description ? description.length * 2 : 0);
        } else return limit + 1;

        if (!Number.isSafeInteger(total) || total > limit) return limit + 1;
      }

      return total;
    },
    _mutatorBackpressureError: function (reason, estimatedBytes) {
      var error = new Error(
        "[wx-scheduler] stateful command queue capacity exceeded");
      error.code = "WX_MUTATOR_BACKPRESSURE";
      error.reason = reason;
      error.pendingJobs = this.mutatorJobs.size;
      error.pendingBytes = this.mutatorQueuedBytes;
      error.estimatedBytes = estimatedBytes;
      error.maxJobs = this.MAX_MUTATOR_JOBS;
      error.maxBytes = this.MAX_MUTATOR_PAYLOAD_BYTES;
      return error;
    },
    _wrapMutators: function () {
      var self = this;
      var wrappedNow = 0;
      this.MUTATOR_NAMES.forEach(function (name) {
        var orig = Module[name];
        if (typeof orig !== "function") return;
        // Export discovery can run more than once. Wrapping our own gateway
        // would make the outer job call an inner job queued behind itself.
        if (orig.__wxMutatorWrapped) return;
        self.mutatorsWrapped++;
        wrappedNow++;
        var wrapped = function () {
          return self._enqueueMutator(
            name,
            orig,
            Array.prototype.slice.call(arguments),
            null
          );
        };
        // Runtime adapters use this private hook for resource-affine work. The
        // guard runs immediately before the native closure, so destroying a
        // sheet binding makes an already-submitted job inert.
        wrapped.__wxGuardedCall = function (args, isCurrent) {
          return self._enqueueMutator(name, orig, args, isCurrent);
        };
        wrapped.__wxMutatorWrapped = true;
        Module[name] = wrapped;
      });
      if (wrappedNow > 0)
        console.log("[wx-scheduler] embind owner gateway: wrapped "
          + wrappedNow + " mutator(s)");
    },
    _enqueueMutator: function (name, orig, args, isCurrent) {
      var self = this;
      if (self.dead)
        return Promise.reject(new Error("[wx-scheduler] shutdown: application is dead"));

      var estimatedBytes;
      try {
        estimatedBytes = self._estimateMutatorPayloadBytes(args);
      } catch (e) {
        // A hostile Proxy or unsupported value shape is not allowed to bypass
        // the bound or turn a Promise-returning gateway into a synchronous
        // throw. Treat it as an unmeasurable over-limit payload.
        estimatedBytes = self.MAX_MUTATOR_PAYLOAD_BYTES + 1;
      }
      var rejectionReason = "";
      if (self.mutatorJobs.size >= self.MAX_MUTATOR_JOBS)
        rejectionReason = "jobs";
      else if (estimatedBytes > self.MAX_MUTATOR_PAYLOAD_BYTES
               || self.mutatorQueuedBytes + estimatedBytes
                    > self.MAX_MUTATOR_PAYLOAD_BYTES)
        rejectionReason = "bytes";

      if (rejectionReason) {
        self.mutatorBackpressureRejections++;
        if (rejectionReason === "jobs") self.mutatorJobLimitRejections++;
        else self.mutatorByteLimitRejections++;
        return Promise.reject(
          self._mutatorBackpressureError(rejectionReason, estimatedBytes));
      }

      return new Promise(function (resolve, reject) {
        var id;
        try { id = self._nextMutatorId(); }
        catch (e) { reject(e); return; }

        self.mutatorJobs.set(id, {
          id: id,
          name: name,
          call: function () { return orig.apply(Module, args); },
          isCurrent: typeof isCurrent === "function" ? isCurrent : null,
          resolve: resolve,
          reject: reject,
          state: "queued",
          nativeComplete: false,
          resultReady: false,
          resultOk: false,
          result: undefined,
          estimatedBytes: estimatedBytes,
          guardFailure: null,
          settled: false,
        });
        self.mutatorQueue.push(id);
        self.mutatorQueuedBytes += estimatedBytes;
        self.mutatorHighWaterJobs = Math.max(
          self.mutatorHighWaterJobs, self.mutatorJobs.size);
        self.mutatorHighWaterBytes = Math.max(
          self.mutatorHighWaterBytes, self.mutatorQueuedBytes);
        self._armMutatorPump();
      });
    },
    // Public queue fence for browser consumers and deterministic tests.  The
    // fence is an Ordinary owner job in the SAME bounded FIFO as every Embind
    // mutator.  Its Promise therefore resolves only after native delivery and
    // the exact OwnerToken retirement reported by completeMutator().  It is
    // deliberately not a native-entry callback and has no synchronous/direct
    // fallback: either the owner lane accepts it, or the returned Promise
    // rejects under the lane's normal backpressure/shutdown rules.
    executionBarrier: function (label) {
      if (label !== undefined
          && (typeof label !== "string" || label.length > 256)) {
        return Promise.reject(new TypeError(
          "[wx-scheduler] executionBarrier label must be a string of at most 256 characters"));
      }
      var name = "execution barrier";
      if (label) name += ": " + label;
      return this._enqueueMutator(name, function () {}, [], null);
    },
    _mutatorIsCurrent: function (job) {
      if (!job || !job.isCurrent) return true;
      try { return !!job.isCurrent(); }
      catch (e) {
        if (this._terminalizeNativeTrap("mutator generation guard trapped", e))
          throw e;
        job.guardFailure = e;
        return false;
      }
    },
    _staleMutatorError: function (job) {
      if (job && job.guardFailure) return job.guardFailure;
      var error = new Error("[wx-scheduler] stale resource-affine mutator");
      error.code = "WX_MUTATOR_STALE";
      return error;
    },
    _rejectStaleMutator: function (job) {
      var error = this._staleMutatorError(job);
      this._settleMutator(job, false, error);
    },
    // Programmatic opens are stateful and can park deeply. A shallow Start
    // export moves the real body to an owned dispatch context; this wrapper
    // exposes its exact tail as a Promise without nesting a suspending Embind
    // call inside another Wasm/JS/Wasm stack.
    _wrapOpenFile: function () {
      var self = this;
      [
        ["kicadOpenFile", "kicadOpenFileStart"],
        ["kicadOpenFiles", "kicadOpenFilesStart"],
      ].forEach(function (names) {
        var name = names[0];
        var start = Module[names[1]];
        var current = Module[name];
        if (typeof start !== "function" || typeof current !== "function" ||
            current.__wxOwnedOpenWrapped) return;

        var wrapped = function (payload) {
          // Mint the token in pure JS. A token returned from the suspending
          // body would be only its unwind placeholder.
          var token = self.beginWait("open");
          if (!token) {
            var unavailable = new Error(
              "[wx-scheduler] owned open rejected after native shutdown"
            );
            unavailable.code = "WX_OPEN_NATIVE_UNAVAILABLE";
            return Promise.reject(unavailable);
          }

          // Mark the exact wait as observed before native submission. A
          // synchronous fail-stop can reject it from inside start(); attaching
          // afterwards would leak the entry and create an unhandled rejection.
          var openPromise = self.waitPromise(token).then(function (r) {
            return !!r;
          });
          try {
            var accepted = start(token, payload);
            if (accepted === false || accepted === 0) {
              var rejected = new Error(
                "[wx-scheduler] " + names[1] + " rejected the owned open"
              );
              rejected.code = "WX_OPEN_SUBMIT_REJECTED";
              // shutdown() may already have rejected and removed this exact
              // awaited token. Preserve that terminal error when it did.
              var rejectedExact = self.rejectOpenWait(token, rejected);
              if (!rejectedExact && self.canTouchNative())
                return Promise.reject(rejected);
              return openPromise;
            }
          } catch (e) {
            if (self._isNativeTrap(e)) {
              // shutdown rejects every pending open. Attach an internal observer
              // before terminalizing because this synchronous trap is rethrown
              // instead of returning the open Promise to its caller.
              openPromise.catch(function () {});
              self._terminalizeNativeTrap("owned-open submission trapped", e);
              throw e;
            }
            self.rejectOpenWait(token, e);
            return openPromise;
          }
          return openPromise;
        };
        wrapped.__wxOwnedOpenWrapped = true;
        Module[name] = wrapped;
        console.log("[wx-scheduler] open lane: " + name +
          " routed through an owned dispatch context");
      });
    },
    _armMutatorPump: function () {
      if (this._mutatorPumpArmed || this.mutatorInFlight || this.dead) return;
      this._mutatorPumpArmed = true;
      var self = this;
      if (!this.enqueueNativeEntry("mutator-submit", "Embind job submission", function () {
        self._mutatorPumpArmed = false;
        if (self.dead || self.mutatorInFlight) return;

        var id = self.mutatorQueue[0];
        var job = self.mutatorJobs.get(id);
        if (!job) {
          if (self.mutatorQueue.length > 0) self.mutatorQueue.shift();
          self._armMutatorPump();
          return;
        }
        if (!self._mutatorIsCurrent(job)) {
          if (!job.settled) self._rejectStaleMutator(job);
          return;
        }

        var submit = Module["_wxWasmEmbindSubmit"];
        if (typeof submit !== "function") {
          self._settleMutator(job, false,
            new Error("[wx-scheduler] wxWasmEmbindSubmit export is missing"));
          return;
        }

        job.state = "submitted";
        self.mutatorInFlight = id;
        self.mutatorsSubmitted++;
        try {
          // This is transport only. C++ queues Ordinary work and calls the JS
          // closure later from a fresh, admitted dispatch context.
          if (submit(id) === 0)
            self._settleMutator(job, false,
              new Error("[wx-scheduler] Embind job submission was rejected"));
        } catch (e) {
          if (self._terminalizeNativeTrap("Embind job submission trapped", e))
            throw e;
          self._settleMutator(job, false, e);
        }
      })) this._mutatorPumpArmed = false;
    },
    _settleMutator: function (job, ok, value) {
      if (!job || job.settled) return false;
      if (!Number.isSafeInteger(job.estimatedBytes)
          || job.estimatedBytes < 0
          || job.estimatedBytes > this.mutatorQueuedBytes) {
        throw new Error("[wx-scheduler] mutator payload accounting underflow");
      }
      job.settled = true;
      job.state = ok ? "fulfilled" : "rejected";
      this.mutatorQueuedBytes -= job.estimatedBytes;
      job.estimatedBytes = 0;
      this.mutatorJobs.delete(job.id);
      if (this.mutatorQueue[0] === job.id) this.mutatorQueue.shift();
      else {
        var index = this.mutatorQueue.indexOf(job.id);
        if (index >= 0) this.mutatorQueue.splice(index, 1);
      }
      if (this.mutatorInFlight === job.id) this.mutatorInFlight = 0;
      try {
        if (ok) job.resolve(value);
        else job.reject(value);
      } finally {
        this._armMutatorPump();
      }
      return true;
    },
    _recordMutatorResult: function (job, ok, value) {
      if (!job || job.settled || job.resultReady) return false;
      job.resultReady = true;
      job.resultOk = ok;
      job.result = value;
      this._finishMutatorIfReady(job);
      return true;
    },
    _finishMutatorIfReady: function (job) {
      if (!job || job.settled || !job.nativeComplete || !job.resultReady)
        return false;
      return this._settleMutator(job, job.resultOk, job.result);
    },
    // Called only by wxWasmEmbindSubmit's queued C++ callback. Application
    // exceptions become ticket rejection. Native traps are terminal and must
    // escape through the scheduler fiber; a late callback after shutdown is an
    // inert stale job id.
    deliverMutator: function (id) {
      id = id >>> 0;
      if (this.dead || id === 0 || this.mutatorInFlight !== id) return 0;
      var job = this.mutatorJobs.get(id);
      if (!job || job.state !== "submitted") return 0;
      if (!this._mutatorIsCurrent(job)) {
        this._recordMutatorResult(job, false, this._staleMutatorError(job));
        return 1;
      }

      job.state = "running";
      this.mutatorsDelivered++;
      var result;
      try {
        result = job.call();
      } catch (e) {
        if (this._terminalizeNativeTrap("Embind job delivery trapped", e))
          throw e;
        this._recordMutatorResult(job, false, e);
        return 1;
      }

      if (result && typeof result.then === "function") {
        // deliverMutator runs inside an admitted Wasm -> JS -> Wasm owner
        // callback. A thenable here means the raw wrapper suspended (or an
        // async closure escaped) across that nested boundary. The apparent
        // Promise is not a safe completion edge: the native owner is still
        // live and Asyncify may already have unwound through this delivery.
        // Treat this as lost physical integrity, not as an async application
        // result which can be awaited and retried.
        Promise.resolve(result).catch(function () {});
        this._failScheduler(
          "raw Embind mutator returned a thenable during owner delivery", true);
        return 0;
      }
      this._recordMutatorResult(job, true, result);
      return 1;
    },
    // Native delivery is only the START of the transaction. wx calls this
    // after the semantic OwnerToken really retires, which can be much later
    // when runOnFiber parked inside Asyncify. A command ticket needs BOTH the
    // JavaScript return/rejection and this exact native completion edge.
    completeMutator: function (id, nativeFailure) {
      id = id >>> 0;
      if (this.dead || id === 0 || this.mutatorInFlight !== id) return 0;
      var job = this.mutatorJobs.get(id);
      if (!job || job.settled || job.state === "queued") return 0;

      job.nativeComplete = true;
      if (nativeFailure) {
        var error = new Error("[wx-scheduler] native owner failed: " + nativeFailure);
        error.code = "WX_NATIVE_OWNER_FAILED";
        // Owner failure is authoritative even when the shallow Embind wrapper
        // returned a placeholder value before its fiber body reached the tail.
        job.resultReady = true;
        job.resultOk = false;
        job.result = error;
      }
      this._finishMutatorIfReady(job);
      return 1;
    },

    // --- S4 wait registry ---------------------------------------------------
    // Token-based waits (doc 13 §2: wasm_begin_async_wait / wasm_yield_until /
    // wasm_resolve_wait). A wait is begun BEFORE the C++ side parks, so a
    // resolve that races ahead of the park (EndModal during Show()) simply
    // pre-resolves the promise — yieldUntil then returns immediately. Every
    // completion carries its exact token; there is no kind-wide or LIFO
    // resolver fallback. Resolution flows through the S2 deferred-wake law.
    waits: new Map(),      // token → settle-once numeric wait/open promise state
    waitSeq: 0,
    MAX_WAITS: 4096,
    waitHighWater: 0,
    waitsBegun: 0,
    waitsResolved: 0,
    waitsAbandoned: 0,
    earlyWaitResolves: 0,  // resolves that landed before their waiter parked
    beginWait: function (kind) {
      if (!this.canTouchNative()) return 0;
      if (this.waitSeq >= 0x7fffffff) {
        this._failScheduler("wait-token space exhausted", false);
        return 0;
      }
      if (this.waits.size >= this.MAX_WAITS) {
        this._failScheduler("wait registry capacity exceeded", false);
        return 0;
      }
      var token = ++this.waitSeq;
      var entry = {
        kind: kind,
        resolved: false,
        failed: false,
        resolve: null,
        reject: null,
        promise: null,
        contextParked: false,
        contextRun: null,
      };
      entry.promise = new Promise(function (resolve, reject) {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      this.waits.set(token, entry);
      this.waitsBegun++;
      this.waitHighWater = Math.max(this.waitHighWater, this.waits.size);
      return token;
    },
    waitPromise: function (token) {
      var entry = this.waits.get(token);
      if (!entry) {
        var reason = this.dead
          ? "wait requested after scheduler shutdown"
          : "waitPromise lost exact token " + token;
        if (!this.dead) this._failScheduler(reason, false);
        return Promise.reject(new Error("[wx-scheduler] " + reason));
      }
      if (entry.failed) {
        this.waits.delete(token);
        return entry.promise;
      }
      if (entry.resolved) {
        // Resolved before the waiter parked (the early-resolve window).
        // Consume the retained entry and hand the real result over — the old
        // path warned "unknown token" and returned 0, dropping it.
        this.waits.delete(token);
        return Promise.resolve(entry.result | 0);
      }
      entry.awaited = true;
      return entry.promise;
    },
    // An early-resolved wait keeps its entry until the C++ waiter checks it.
    // entry (see resolveWait) so the result is not lost. wxWasmYieldUntil peeks
    // before parking a context and consumes the result instead of parking a
    // context nobody will ever resume.
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
    // This token's waiter parked a scheduler context instead of
    // suspending its stack in place, so there is no promise anyone awaits —
    // resolving one would strand the context forever. Marked from C++ at park
    // time; resolveWait routes such tokens to the registry instead.
    noteContextWait: function (token) {
      var entry = this.waits.get(token);
      if (!entry || entry.resolved || entry.failed || entry.contextParked)
        return false;
      entry.contextParked = true;
      return true;
    },
    resolveWait: function (token, result) {
      if (!this.canTouchNative()) return false;
      var entry = this.waits.get(token);
      if (!entry || entry.resolved || entry.failed) return false;
      entry.resolved = true;
      this.waitsResolved++;
      if (entry.contextParked) {
        // Exact wakes are FIFO payload jobs, not coalesced pump signals. The
        // physical entry arbiter first proves that no sibling context is
        // active, then this job marks only the token's recorded context Ready.
        // A separate coalesced scheduler-pump job resumes it from another
        // fresh task.
        var self = this;
        var run = function () {
          if (self.waits.get(token) !== entry || entry.contextRun !== run)
            return;
          entry.contextRun = null;
          self.waits.delete(token);
          var resolveContext = Module["_wxWasmSchedResolveContextWait"];
          if (typeof resolveContext !== "function") {
            self._failScheduler(
              "exact context-wait resolver export is missing", false);
            return;
          }
          if ((resolveContext(token, result | 0) | 0) !== 1) {
            if (!self.dead)
              self.shutdown("native context refused its exact wait wake");
            return;
          }
          self._armSchedPump();
        };
        entry.contextRun = run;
        if (!this.enqueueNativeEntry(
              null, "context-wait resolution " + token, run)) {
          entry.contextRun = null;
          return false;
        }
        return true;
      }
      entry.result = result | 0;
      entry.resolve(result | 0);
      if (entry.awaited) {
        this.waits.delete(token);
      } else {
        // Nobody has parked on this token yet (the early-resolve window:
        // a bridge whose request settled before the C++ frame reached the
        // park). Keep the entry, result attached — wxWasmYieldUntil or a late
        // waitPromise consumes it. Deleting here is what stranded the first
        // The discarded-result implementation made the later park wait on a
        // wake which nobody could send.
        this.earlyWaitResolves++;
      }
      return true;
    },
    // Public owned opens must not strand their callers after terminal native
    // failure. Other wait kinds are consumed by C++ context parking and keep
    // their numeric resolution contract; only an open token is rejected.
    rejectOpenWait: function (token, error) {
      var entry = this.waits.get(token);
      if (!entry || entry.kind !== "open" || entry.resolved || entry.failed)
        return false;
      entry.failed = true;
      entry.reject(error);
      if (entry.awaited) this.waits.delete(token);
      return true;
    },
    pendingWaits: function (kind) {
      var count = 0;
      this.waits.forEach(function (entry) {
        if (entry.kind === kind && !entry.resolved && !entry.failed) count++;
      });
      return count;
    },

    // --- S2 scheduler core state -------------------------------------------
    // Deferred sleep wakes: {deliver, result} queued because a transition was
    // in flight when the wake arrived. Delivered FIFO from a clean macrotask.
    readyWakes: [],
    MAX_READY_WAKES: 4096,
    readyWakeHighWater: 0,
    deferredWakes: 0,
    drainedWakes: 0,
    _wakeDrainArmed: false,
    // N1: pure-JS currData writes seen without scheduler authorization.
    strayWrites: 0,
    // Fresh in-place Asyncify parks that began on a non-main stack (a tool
    // coroutine or scheduler context). The physical-suspension reducer
    // requires this count to remain zero.
    inplaceParksOnFiberStack: 0,
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
      // Cleanup is deferred below so exact native discard callbacks get the
      // first chance to release their tokens. Capture the module now: a
      // replacement runtime can rebind the global Module before that
      // microtask runs, and this scheduler must never clean its successor.
      var moduleAtShutdown = typeof Module !== "undefined" ? Module : null;
      this._detachNativeBrowserIngress();
      try {
        var rejectPopupLeases = moduleAtShutdown
          ? moduleAtShutdown["wxRejectContextMenuLeases"] : null;
        if (typeof rejectPopupLeases === "function")
          rejectPopupLeases("[wx-scheduler] shutdown: " + reason);
      } catch (popupError) {
        console.error("[wx-scheduler] popup lease shutdown failed:", popupError);
      }
      // Native fail-stop calls shutdown before it discards its typed queue.
      // Defer these pure-JS catch-all releases until the current call stack
      // returns: exact native discard callbacks get first ownership of their
      // tokens, while a JS-only terminal path still drops every retained
      // browser payload at the same turn's microtask checkpoint.
      var discardBrowserIngress = function () {
        ["wxDiscardDomBrowserLifetime", "wxDiscardDomEventSnapshots",
         "wxDiscardFileDropBatches",
         "wxDiscardBitmapResources", "wxDiscardGLPatchTimer"]
          .forEach(function (name) {
            try {
              var discard = moduleAtShutdown ? moduleAtShutdown[name] : null;
              if (typeof discard === "function") discard();
            } catch (discardError) {
              console.error("[wx-scheduler] " + name
                + " shutdown cleanup failed:", discardError);
            }
          });
      };
      if (typeof queueMicrotask === "function")
        queueMicrotask(discardBrowserIngress);
      else
        Promise.resolve().then(discardBrowserIngress);
      var stranded = {
        mailbox: this.mailboxReserved,
        mutators: this.mutatorJobs.size,
        nativeEntries: this.nativeEntryQueue.length,
        ingressReceipts: this.ingressReceipts.size,
        nativeCompletionBytes: this.nativeCompletionQueuedBytes,
        contextSleeps: this.contextSleeps.size,
        wakes: this.readyWakes.length,
        waits: this.waits.size,
      };
      this.mailboxTimers.forEach(function (timer) { clearTimeout(timer); });
      this.mailboxTimers.clear();
      this.mailboxReservations.clear();
      this.mailbox.length = 0;
      this.mailboxReserved = 0;
      this.contextSleeps.forEach(function (record) {
        if (record.timer !== null) clearTimeout(record.timer);
      });
      this.contextSleeps.clear();
      // This first clears queue ownership and byte accounting. It then calls
      // only opt-in PURE-JS abandonment callbacks. Native delivery closures
      // are dropped and are never reused as terminal cleanup.
      this._abandonQueuedNativeEntries(String(reason));
      this.ingressReceipts.clear();
      this.pendingIngressReceipts.clear();
      this.ingressLeaseSnapshot = Object.freeze({
        available: false,
        hasLease: false,
        targetScope: 0,
        targetGeneration: 0,
        leaseIdLow: 0,
        leaseIdHigh: 0,
        leaseParentLow: 0,
        leaseParentHigh: 0,
        leaseGenerationLow: 0,
        leaseGenerationHigh: 0,
      });
      var jobs = Array.from(this.mutatorJobs.values());
      for (var i = 0; i < jobs.length; i++) {
        this._settleMutator(jobs[i], false,
          new Error("[wx-scheduler] shutdown: " + reason));
      }
      var openFailure = new Error("[wx-scheduler] shutdown: " + reason);
      openFailure.code = "WX_OPEN_OWNER_FAILED";
      var waits = Array.from(this.waits.entries());
      for (var w = 0; w < waits.length; w++) {
        var waitEntry = waits[w][1];
        if (waitEntry.kind === "open") {
          this.rejectOpenWait(waits[w][0], openFailure);
        } else {
          // A numeric wait belongs to an Asyncify or libcontext native frame.
          // Rejecting or resolving it after terminal failure could rewind that
          // damaged frame. Release only the JS registry references; module
          // replacement owns the parked native context's lifetime.
          this.waitsAbandoned++;
        }
        waitEntry.contextRun = null;
        waitEntry.resolve = null;
        waitEntry.reject = null;
        waitEntry.promise = null;
      }
      this.waits.clear();
      this.mutatorQueue.length = 0;
      this.mutatorJobs.clear();
      // Every live job above settled exactly once. Keep shutdown non-throwing
      // if an already-corrupt build violated the invariant, but make the reset
      // visible rather than carrying stale capacity into diagnostics.
      if (this.mutatorQueuedBytes !== 0) {
        console.error("[wx-scheduler] shutdown corrected mutator byte accounting: "
          + this.mutatorQueuedBytes);
        this.mutatorQueuedBytes = 0;
      }
      this.mutatorInFlight = 0;
      this._mutatorPumpArmed = false;
      this.readyWakes.length = 0;
      if (stranded.mailbox || stranded.mutators || stranded.nativeEntries
          || stranded.ingressReceipts
          || stranded.nativeCompletionBytes
          || stranded.contextSleeps
          || stranded.wakes || stranded.waits) {
        console.warn("[wx-scheduler] shutdown (" + reason + ") stranded:"
          + " mailbox=" + stranded.mailbox
          + " mutators=" + stranded.mutators
          + " nativeEntries=" + stranded.nativeEntries
          + " ingressReceipts=" + stranded.ingressReceipts
          + " nativeCompletionBytes=" + stranded.nativeCompletionBytes
          + " contextSleeps=" + stranded.contextSleeps
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
        + " mailboxReserved=" + this.mailboxReserved
        + " mailboxHwm=" + this.mailboxHighWater
        + " mailboxBackpressure=" + this.mailboxBackpressureRejections
        + " enqueued=" + this.enqueued
        + " delivered=" + this.delivered
        + " mutQ=" + this.mutatorQueue.length
        + " mutWrapped=" + this.mutatorsWrapped
        + " mutSubmitted=" + this.mutatorsSubmitted
        + " mutDelivered=" + this.mutatorsDelivered
        + " mutBytes=" + this.mutatorQueuedBytes
        + " mutJobsHwm=" + this.mutatorHighWaterJobs
        + " mutBytesHwm=" + this.mutatorHighWaterBytes
        + " mutBackpressure=" + this.mutatorBackpressureRejections
        + " mutBackpressureJobs=" + this.mutatorJobLimitRejections
        + " mutBackpressureBytes=" + this.mutatorByteLimitRejections
        + " nativeTraps=" + this.nativeTraps
        + " nativeEntryQ=" + this.nativeEntryQueue.length
        + " nativeEntryHwm=" + this.nativeEntryHighWater
        + " nativeEntryDeferred=" + this.nativeEntryDeferred
        + " nativeEntryDelivered=" + this.nativeEntryDelivered
        + " nativeEntryCoalesced=" + this.nativeEntryCoalesced
        + " nativeEntryAbandoned=" + this.nativeEntryAbandoned
        + " nativeEntryAbandonCallbacks=" + this.nativeEntryAbandonCallbacks
        + " nativeEntryAbandonErrors=" + this.nativeEntryAbandonErrors
        + " nativeCompletionBytes=" + this.nativeCompletionQueuedBytes
        + " nativeCompletionBytesHwm=" + this.nativeCompletionHighWaterBytes
        + " nativeCompletionBackpressure="
            + this.nativeCompletionBackpressureRejections
        + " contextSleeps=" + this.contextSleeps.size
        + " contextSleepHwm=" + this.contextSleepHighWater
        + " contextSleepsScheduled=" + this.contextSleepsScheduled
        + " contextSleepsCancelled=" + this.contextSleepsCancelled
        + " contextSleepsDelivered=" + this.contextSleepsDelivered
        + " readyWakes=" + this.readyWakes.length
        + " readyWakesHwm=" + this.readyWakeHighWater
        + " deferredWakes=" + this.deferredWakes
        + " drainedWakes=" + this.drainedWakes
        + " strayWrites=" + this.strayWrites
        + " waits=" + this.waits.size
        + " waitsHwm=" + this.waitHighWater
        + " waitsBegun=" + this.waitsBegun
        + " waitsResolved=" + this.waitsResolved
        + " waitsAbandoned=" + this.waitsAbandoned
        + " earlyWaitResolves=" + this.earlyWaitResolves
        + " fiberStackParks=" + this.inplaceParksOnFiberStack;
    },
  };

  globalThis.__wxScheduler = AsyncifyScheduler;
  if (AsyncifyScheduler.ownerModule)
    AsyncifyScheduler.ownerModule["__wxScheduler"] = AsyncifyScheduler;

  // ======================================================================
  // S2 core install. Skip defensively if the predecessor shim is already
  // present. Two managers for one wake path corrupt transition state. The
  // injected build selects exactly one manager, so this branch is unreachable.
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
        if (!/index out of bounds|(?:^|RuntimeError:\s*)unreachable(?: executed)?(?:$|\n)|table index|indirect call signature|null function or function signature|memory access out of bounds/i.test(msg)) return;
        ++__dumps;
        try { console.error(__dumpState()); } catch (e) {}
      };
      window.addEventListener("error", function (e) {
        var error = e && e.error !== undefined && e.error !== null
          ? e.error : (e && e.message);
        __onTrap(error instanceof Error ? error.message : String(error || ""));
        AsyncifyScheduler._terminalizeNativeTrap(
          "uncaught native browser callback trapped", error);
      });
      window.addEventListener("unhandledrejection", function (e) {
        var reason = e && e.reason;
        __onTrap(reason instanceof Error ? reason.message : String(reason || ""));
        AsyncifyScheduler._terminalizeNativeTrap(
          "unhandled native promise rejection", reason);
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
    var __isRealUnwindCompletion = function () {
      var unwinding = Asyncify.State
        ? Asyncify.State.Unwinding : 1;
      return !!Asyncify.currData
        && Asyncify.state === unwinding
        && (!Asyncify.exportCallStack
            || Asyncify.exportCallStack.length === 0);
    };
    AsyncifyScheduler._scheduleWakeDrain = function () {
      this.readyWakeHighWater = Math.max(
        this.readyWakeHighWater, this.readyWakes.length);
      if (this._wakeDrainArmed) return;
      this._wakeDrainArmed = true;
      var self = this;
      setTimeout(function () {
        self._wakeDrainArmed = false;
        if (self.dead) return; // S6: parked stacks are gone with the app
        // Deliver from a CLEAN macrotask (export stack empty by construction).
        // A busy head is retained without a timer retry. A real unwind-
        // completion edge below gives it one new attempt.
        if (!__transitionFree() || self.readyWakes.length === 0) return;
        var w = self.readyWakes.shift();
        self.drainedWakes++;
        w.deliver(w.result);
        // One accepted rewind per task. If delivery completed synchronously,
        // a later task may take the next head. Otherwise the real transition
        // edge owns the rearm.
        if (self.readyWakes.length > 0 && __transitionFree())
          self._scheduleWakeDrain();
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
        try {
          return __originalHandleSleep(startAsync);
        } finally {
          // The Rewinding branch changes state back to Normal inside the
          // original helper.  This is its exact completion edge for ingress
          // which arrived re-entrantly during the rewind.
          if (AsyncifyScheduler.nativeEntryQueue.length > 0
              && AsyncifyScheduler._nativeTransitionFree())
            AsyncifyScheduler._armNativeEntryDrain();
        }
      }
      // In-place park cross-check: report every fresh park to the physical
      // registry. Begin() returns the owning context id (0 = main stack);
      // while recorded, fiber_enterable()/fiber_transfer refuse entering that
      // context. The fiberStackParks counter proves that a context-owned wait
      // used a context park instead of an in-place park. This is a leaf probe
      // into Wasm; state is 0 here, so no unwind is in flight yet.
      var parkOwnerCtx = 0;
      try {
        if (Module["_wxWasmSchedInplaceParkBegin"]) {
          parkOwnerCtx = Module["_wxWasmSchedInplaceParkBegin"]() | 0;
          if (parkOwnerCtx) {
            AsyncifyScheduler.inplaceParksOnFiberStack++;
            __rec("inplace-park-on-fiber-stack ctx=" + parkOwnerCtx
                  + " n=" + AsyncifyScheduler.inplaceParksOnFiberStack);
          }
        }
      } catch (e) {
        if (AsyncifyScheduler._terminalizeNativeTrap(
              "in-place park begin trapped", e)) throw e;
        // An optional diagnostic probe must not break a healthy park.
      }
      var sleepCtx = {
        capturedData: null,
        cleanedUp: false,
        parkOwnerCtx: parkOwnerCtx,
        rootOwned: (typeof Fibers === "undefined")
          || (!Fibers.__inFiberEntry
              && !(Asyncify.__wakingOwnerFiber || false)),
      };
      Asyncify.__pendingSleepContexts.push(sleepCtx);

      var cleanup = function () {
        if (sleepCtx.cleanedUp) return;
        sleepCtx.cleanedUp = true;
        if (sleepCtx.parkOwnerCtx) {
          try {
            if (Module["_wxWasmSchedInplaceParkEnd"]) {
              Module["_wxWasmSchedInplaceParkEnd"](sleepCtx.parkOwnerCtx);
            }
          } catch (e) {
            if (AsyncifyScheduler._terminalizeNativeTrap(
                  "in-place park end trapped", e)) throw e;
            // An optional diagnostic probe must not break a healthy wake.
          }
          sleepCtx.parkOwnerCtx = 0;
        }
        var idx = Asyncify.__pendingSleepContexts.indexOf(sleepCtx);
        if (idx !== -1) Asyncify.__pendingSleepContexts.splice(idx, 1);
      };

      try {
        return __originalHandleSleep(function (wakeUp) {
          // deliver(): the generated handleSleep wake path — restore this
          // sleep's buffer,
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
              if (!AsyncifyScheduler._terminalizeNativeTrap(
                    "Asyncify wake trapped", e)) {
                // Emscripten starts the rewind before it calls doRewind(). If
                // any other exception escapes this callback, the transition
                // can still be Rewinding with a live currData buffer. It is no
                // longer safe to classify that exception as a recoverable
                // application failure or to admit another native entry.
                AsyncifyScheduler._failScheduler(
                  "Asyncify wake escaped before transition completion: "
                    + String(e), true);
              }
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
            // from a clean macrotask when the slot frees. The predecessor
            // implementation could only report this window
            // (aliased-wake-live); the scheduler removes it.
            if (!__transitionFree()) {
              AsyncifyScheduler.deferredWakes++;
              __rec("defer-wake buf=" + (sleepCtx.capturedData || 0)
                    + " s=" + Asyncify.state);
              if (AsyncifyScheduler.readyWakes.length
                  >= AsyncifyScheduler.MAX_READY_WAKES) {
                AsyncifyScheduler._failScheduler(
                  "deferred Asyncify wake queue capacity exceeded", true);
                return;
              }
              AsyncifyScheduler.readyWakes.push({ deliver: deliver, result: result });
              AsyncifyScheduler._scheduleWakeDrain();
              return;
            }
            return deliver(result);
          });
        });
      } catch (e) {
        cleanup();
        if (AsyncifyScheduler._terminalizeNativeTrap(
              "Asyncify sleep transition trapped", e)) throw e;
        throw e;
      }
    };

    // Transition-completion signal: maybeStopUnwind is where an unwind
    // finishes (state → Normal) and the trampoline runs queued fiber
    // switches. After it settles, deferred wakes may proceed.
    var __originalMaybeStopUnwind = Asyncify.maybeStopUnwind.bind(Asyncify);
    Asyncify.maybeStopUnwind = function () {
      // Emscripten calls maybeStopUnwind() after EVERY instrumented export.
      // Only this pre-call predicate identifies an actual Unwinding→Normal
      // edge. Treating a leaf readiness probe as an edge would make the probe
      // re-arm itself forever while native state remains busy.
      var completedUnwind = __isRealUnwindCompletion();
      var ret = __originalMaybeStopUnwind();
      if (completedUnwind && AsyncifyScheduler.readyWakes.length > 0
          && __transitionFree())
        AsyncifyScheduler._scheduleWakeDrain();
      // This is the exact non-polling edge for a native-entry job whose leaf
      // probe observed a scheduler context still physically live. The head
      // was retained; completion of the transition gives it one new attempt.
      if (completedUnwind && AsyncifyScheduler.nativeEntryQueue.length > 0
          && __transitionFree())
        AsyncifyScheduler._armNativeEntryDrain();
      return ret;
    };

    Asyncify.__nestedHandleSleepInstalled = true; // compat: tools probe this
    console.log("[wx-scheduler] S2 core installed (deferred wakes + N1 accessor)");
  }

  // --- consume-once fiber rewind guard + trampoline heal ownership -------
  // The registry carries the in-place-park fact through
  // wxWasmSchedInplaceParkBegin/End. The generated fiber layer must still
  // refuse a proposed rewind which has no live suspension, or which targets
  // a body in an in-place park. Refusing only in C++ ghost-resumes the source;
  // removing this generated-layer check produced the measured second-stage
  // overshoot. This guard remains part of the physical contract while direct
  // swaps, star transfers, and in-place parks use distinct attribution state.
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
        if (AsyncifyScheduler._terminalizeNativeTrap(
              "fiber trampoline trapped", e)) throw e;
        throw e;
      } finally {
        // The generated trampoline owns its own finally which clears
        // trampolineRunning.  Signal the FIFO only after that has happened;
        // otherwise an ingress received during the trampoline has no future
        // level edge to wake it.
        if (AsyncifyScheduler.nativeEntryQueue.length > 0
            && AsyncifyScheduler._nativeTransitionFree())
          AsyncifyScheduler._armNativeEntryDrain();
      }
    };

    Fibers.__staleRewindGuardInstalled = true;
  }

  // Wrap the embind mutators once the runtime has registered them.
  if (typeof Module !== "undefined") {
    if (Module["calledRun"]) {
      AsyncifyScheduler._wrapMutators();
      AsyncifyScheduler._wrapOpenFile();
    } else {
      var __wxSchedPrevInit = Module["onRuntimeInitialized"];
      Module["onRuntimeInitialized"] = function () {
        // Install the gateway before application initialization can retain a
        // raw mutable export. Run discovery again afterwards in case that
        // callback registered an optional adapter of its own.
        AsyncifyScheduler._wrapMutators();
        AsyncifyScheduler._wrapOpenFile();
        if (typeof __wxSchedPrevInit === "function") __wxSchedPrevInit();
        AsyncifyScheduler._wrapMutators();
        AsyncifyScheduler._wrapOpenFile();
      };
    }
  }

  console.log("[wx-scheduler] scaffolding installed (S2, core live)");
}
// === End AsyncifyScheduler ===
