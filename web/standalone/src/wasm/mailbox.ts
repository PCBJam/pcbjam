// App-side mailbox for mutating embind calls (docs/features/async/17 S1;
// classification: docs/features/async/18-embind-audit.md).
//
// Under PROXY_TO_PTHREAD the app's JS runs on the window while the wx dispatch
// interlock lives in the pthread worker, so this queue cannot key on the C-side
// interlock — it keys on the proxy-safe `kicadOpenFileBusy()` probe. Semantics:
// a mutator enqueued while an open is in flight is DEFERRED and DELIVERED after
// settle, in FIFO order, with its return value resolving the caller's promise —
// the doc-17 §3b drop→deliver flip, replacing the "entry silently no-ops
// against the gate" behavior at the call sites that adopt this wrapper.
//
// Deliberately NOT here (S4 territory): worker-side interlock precision (a
// mutator can still land while a NON-open chain is parked — those entries keep
// their own C-side guards until S4 moves queuing into the bindings), and any
// change to drift-detect's skip-if-fiber-busy logic (#10b semantics, its own
// deliberate contract).

interface BusyProbe {
  kicadOpenFileBusy?: () => boolean;
}

interface QueuedCall<T = unknown> {
  label: string;
  fn: () => T;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

const POLL_MS = 25;

export class WasmMailbox {
  private queue: QueuedCall[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private mod: BusyProbe;
  /** Delivered-call count, for tests and state dumps. */
  delivered = 0;

  constructor(mod: BusyProbe) {
    this.mod = mod;
  }

  private busy(): boolean {
    const probe = this.mod.kicadOpenFileBusy;
    // Legacy wasm without the probe: never defer (matches pre-mailbox behavior).
    if (typeof probe !== "function") return false;
    try {
      return probe.call(this.mod);
    } catch {
      // A probe that throws means the runtime is wedged; delivering would make
      // it worse. Treat as busy — the queue drains if it recovers.
      return true;
    }
  }

  /**
   * Enqueue a mutating embind call. Runs immediately (synchronously, before
   * this function returns the promise's settled state is still async) when
   * nothing is queued and the runtime is not busy — the common path costs one
   * probe read. Otherwise FIFO-defers until the open settles.
   */
  enqueue<T>(label: string, fn: () => T): Promise<T> {
    if (this.queue.length === 0 && !this.busy()) {
      this.delivered++;
      try {
        return Promise.resolve(fn());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, fn, resolve, reject } as QueuedCall);
      this.armPump();
    });
  }

  /** Pending (not yet delivered) calls. */
  pending(): number {
    return this.queue.length;
  }

  private armPump(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.drain(), POLL_MS);
  }

  private drain(): void {
    if (this.busy()) return;
    // Snapshot: a delivered call may enqueue more; those wait for the next
    // tick rather than extending this drain unboundedly.
    let budget = this.queue.length;
    while (budget-- > 0) {
      if (this.busy()) return; // a delivered call re-opened the busy window
      const call = this.queue.shift();
      if (!call) break;
      this.delivered++;
      try {
        call.resolve(call.fn());
      } catch (e) {
        call.reject(e);
      }
    }
    if (this.queue.length === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reject everything queued (teardown — e.g. the wasm died). */
  dispose(reason: unknown): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const call of this.queue.splice(0)) call.reject(reason);
  }
}
