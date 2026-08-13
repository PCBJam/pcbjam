/**
 * Deterministic unit gates for the injected Asyncify scheduler shim.
 *
 * The fake native transport models wxWasmEmbindSubmit: it accepts one opaque
 * job id and delivers it only when the test's semantic owner allows Ordinary
 * work. Runtime E2E tests cover the real C++ coordinator and dispatch fibers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SHIM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/common/shims/asyncify-scheduler.js",
);

type SchedulerShape = {
  ownerModule: FakeModule;
  MUTATOR_NAMES: string[];
  mailbox: unknown[];
  MAX_MAILBOX_JOBS: number;
  mailboxReserved: number;
  mailboxTimers: Set<unknown>;
  mailboxReservations: Map<number, unknown>;
  mailboxCanceled: number;
  mailboxBackpressureRejections: number;
  mailboxHighWater: number;
  mutatorQueue: number[];
  mutatorInFlight: number;
  mutatorsSubmitted: number;
  mutatorsDelivered: number;
  mutatorsWrapped: number;
  MAX_MUTATOR_JOBS: number;
  MAX_MUTATOR_PAYLOAD_BYTES: number;
  mutatorQueuedBytes: number;
  mutatorHighWaterJobs: number;
  mutatorHighWaterBytes: number;
  mutatorBackpressureRejections: number;
  mutatorJobLimitRejections: number;
  mutatorByteLimitRejections: number;
  nativeTraps: number;
  _isNativeTrap(error: unknown): boolean;
  nativeEntryQueue: Array<{
    key: string | null;
    site: string;
    run: (() => void) | null;
    completionBytes: number;
    onAbandon: ((error: Error) => void) | null;
  }>;
  MAX_NATIVE_COMPLETION_BYTES: number;
  nativeCompletionQueuedBytes: number;
  nativeCompletionHighWaterBytes: number;
  nativeCompletionBackpressureRejections: number;
  nativeEntryHighWater: number;
  nativeEntryDeferred: number;
  nativeEntryDelivered: number;
  nativeEntryCoalesced: number;
  nativeEntryAbandoned: number;
  nativeEntryAbandonCallbacks: number;
  nativeEntryAbandonErrors: number;
  ingressReceiptSeq: number;
  ingressReceipts: Map<number, IngressReceipt>;
  pendingIngressReceipts: Set<number>;
  ingressReceiptDeferred: number;
  ingressReceiptDelivered: number;
  contextSleeps: Map<number, unknown>;
  MAX_CONTEXT_SLEEPS: number;
  contextSleepHighWater: number;
  contextSleepsScheduled: number;
  contextSleepsCancelled: number;
  contextSleepsDelivered: number;
  waits: Map<number, unknown>;
  MAX_WAITS: number;
  waitHighWater: number;
  waitsAbandoned: number;
  readyWakes: { deliver: (r: unknown) => void; result: unknown }[];
  MAX_READY_WAKES: number;
  readyWakeHighWater: number;
  deferredWakes: number;
  drainedWakes: number;
  dead: boolean;
  authorize<T>(fn: () => T): T;
  canTouchNative(): boolean;
  runNativeCompletion<T>(site: string, fn: () => T): T | undefined;
  runWaitCompletion(site: string, token: number, prepare: () => number): boolean;
  runNativeIngressReceipt<T>(site: string, fn: (token: number) => T): T | false;
  publishIngressLeaseSnapshot(snapshot: Partial<IngressReceipt> & {
    available: boolean;
    hasLease: boolean;
  }): boolean;
  takeIngressReceipt(token: number): IngressReceipt | null;
  enqueueNativeEntry(
    key: string | null,
    site: string,
    run: () => void,
    onAbandon?: (error: Error) => void,
  ): boolean;
  enqueueNativeCompletion(
    site: string,
    estimatedBytes: number,
    run: () => void,
    onAbandon?: (error: Error) => void,
  ): boolean;
  _armNativeEntryDrain(): void;
  scheduleContextSleep(context: number, token: number, delay: number): boolean;
  cancelContextSleep(context: number, token: number): boolean;
  releaseFiberGuard(fiber: number): void;
  executionBarrier(label?: string): Promise<void>;
  deliverMutator(id: number): number;
  completeMutator(id: number, nativeFailure?: string): number;
  shutdown(reason: string): void;
  enqueueAfter(
    fn: number,
    arg: number,
    ms: number,
    workClass?: number,
    targetScope?: number,
    targetGeneration?: number,
    discard?: number,
    coalesce?: number,
    leaseIdLow?: number,
    leaseIdHigh?: number,
    leaseParentLow?: number,
    leaseParentHigh?: number,
    leaseGenerationLow?: number,
    leaseGenerationHigh?: number,
  ): number;
  cancelMailbox(reservationToken: number): boolean;
  _scheduleWakeDrain(): void;
  _wrapMutators(): void;
  _wrapOpenFile(): void;
  beginWait(kind: string): number;
  waitPromise(token: number): Promise<number>;
  noteContextWait(token: number): boolean;
  resolveWait(token: number, result: number): boolean;
  pendingWaits(kind: string): number;
  state(): string;
};

type IngressReceipt = {
  sequence: number;
  snapshotAvailable: boolean;
  deferredBehindEarlier: boolean;
  hasLease: boolean;
  targetScope: number;
  targetGeneration: number;
  leaseIdLow: number;
  leaseIdHigh: number;
  leaseParentLow: number;
  leaseParentHigh: number;
  leaseGenerationLow: number;
  leaseGenerationHigh: number;
};

type FakeModule = {
  _wxWasmEmbindSubmit(id: number): number;
  _wxWasmNativeEntryReady(): number;
  _wxWasmSchedResolveContextWait?(token: number, result: number): number;
  _pcbjam_context_sleep_wake?(context: number, token: number): number;
  kicadCollabApplyItems(x: number): Promise<string> | string;
  kicadCollabSetRemote?(x: string): Promise<string> | string;
  kicadCollabSnapshotItems?(): Promise<string> | string;
  kicadCollabGetPos?(uuid: string): Promise<string> | string;
  kicadCollabGetViewport?(): Promise<string> | string;
  kicadCollabGetSelection?(): Promise<string> | string;
  kicadCollabGetSelectionFull?(): Promise<string> | string;
  kicadCollabTestGetCrossMapped?(): Promise<string> | string;
  kicadCollabTestGetLocked?(): Promise<string> | string;
  kicadCollabTestListItems?(limit: number): Promise<string> | string;
  kicadCollabTestDemoSet?(): Promise<string> | string;
  kicadCollabTestItemBlob?(uuid: string): Promise<string> | string;
  kicadCollabTestUndoDepth?(): Promise<number> | number;
  kicadLibsReload?(kind: string, nickname: string): Promise<void> | void;
  kicadLibsSymbolUsage?(nickname: string, name: string): Promise<number> | number;
  kicadSetChrome?(show: boolean): Promise<boolean> | boolean;
  kicadSetDarkChrome?(dark: boolean): boolean;
  kicadSaveBoard?(path: string): Promise<void> | void;
  kicadOpenFile?(path: string): Promise<boolean> | boolean;
  kicadOpenFileStart?(token: number, path: string): boolean;
  kicadOpenFiles?(pathsJson: string): Promise<boolean> | boolean;
  kicadOpenFilesStart?(token: number, pathsJson: string): boolean;
  fetchLibrary?(name: string): Promise<string>;
  wxDiscardDomBrowserLifetime?(): void;
  wxDiscardDomEventSnapshots?(): void;
  wxDiscardFileDropBatches?(): void;
  wxDiscardBitmapResources?(): void;
  wxDiscardGLPatchTimer?(): void;
  onRuntimeInitialized?: () => void;
};

declare global {
  // eslint-disable-next-line no-var
  var __wxScheduler: SchedulerShape | undefined;
  // eslint-disable-next-line no-var
  var __wxSchedulerInstalled: boolean | undefined;
}

interface Harness {
  scheduler: SchedulerShape;
  module: FakeModule;
  submitted: number[];
}

type GlobalTrapEvent = {
  error?: unknown;
  message?: string;
  reason?: unknown;
};

type GlobalTrapWindow = {
  __wxAsyncifyDump?: () => string;
  addEventListener(
    type: string,
    listener: (event: GlobalTrapEvent) => void,
  ): void;
};

function makeGlobalTrapWindow(): {
  window: GlobalTrapWindow;
  emit(type: "error" | "unhandledrejection", event: GlobalTrapEvent): void;
} {
  const listeners = new Map<
    string,
    Array<(event: GlobalTrapEvent) => void>
  >();
  return {
    window: {
      addEventListener(type, listener) {
        const existing = listeners.get(type) ?? [];
        existing.push(listener);
        listeners.set(type, existing);
      },
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function loadShim(opts?: {
  submit?: (id: number) => number;
  apply?: (x: number) => Promise<string> | string;
  extraModule?: Partial<FakeModule>;
  trapWindow?: GlobalTrapWindow;
  sleepWake?: (result: unknown) => void;
  fibers?: Record<string, unknown>;
}): Harness {
  delete (globalThis as Record<string, unknown>).__wxSchedulerInstalled;
  delete (globalThis as Record<string, unknown>).__wxScheduler;
  delete (globalThis as Record<string, unknown>).__wxWasmFailed;
  delete (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown;
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.Fibers;
  if (opts?.trapWindow) g.window = opts.trapWindow;
  if (opts?.fibers) g.Fibers = opts.fibers;
  const submitted: number[] = [];
  const asyncify = {
    State: { Normal: 0, Unwinding: 1, Rewinding: 2, Disabled: 3 },
    state: 0,
    exportCallStack: [] as string[],
    currData: null as unknown,
    handleSleep: (startAsync: (wake: (r: unknown) => void) => void) =>
      startAsync((result: unknown) => opts?.sleepWake?.(result)),
    allocateData: () => 0,
    maybeStopUnwind: (): undefined => undefined,
  };
  // Model the state change made by Emscripten's original implementation.
  // The shim wraps this method after it evaluates.
  asyncify.maybeStopUnwind = (): undefined => {
    if (
      asyncify.currData &&
      asyncify.state === asyncify.State.Unwinding &&
      asyncify.exportCallStack.length === 0
    ) {
      asyncify.state = asyncify.State.Normal;
    }
    return undefined;
  };
  g.Asyncify = asyncify;

  const module: FakeModule = {
    _wxWasmNativeEntryReady: () => 1,
    _wxWasmEmbindSubmit: (id) => {
      submitted.push(id);
      if (opts?.submit) return opts.submit(id);
      setTimeout(() => {
        const scheduler = globalThis.__wxScheduler;
        if (scheduler?.deliverMutator(id)) scheduler.completeMutator(id);
      }, 1);
      return 1;
    },
    kicadCollabApplyItems: opts?.apply ?? ((x) => `applied:${x}`),
    ...opts?.extraModule,
  };
  g.Module = module;

  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(SHIM_PATH, "utf8"));
  const scheduler = globalThis.__wxScheduler as SchedulerShape;
  module.onRuntimeInitialized?.();
  return { scheduler, module, submitted };
}

async function drainMutators(scheduler: SchedulerShape): Promise<void> {
  for (let guard = 0; guard < 5000 && scheduler.mutatorQueue.length > 0; guard++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(scheduler.mutatorQueue, "gateway drained without starvation").toHaveLength(0);
}

describe("scheduler Embind owner gateway", () => {
  beforeEach(() => vi.useRealTimers());

  it("binds the arbiter to the exact Module which installed it", () => {
    const h = loadShim();
    expect(h.scheduler.ownerModule).toBe(h.module);
    expect((h.module as FakeModule & { __wxScheduler?: SchedulerShape }).__wxScheduler)
      .toBe(h.scheduler);
  });

  it("defers a state writer while the semantic owner is parked", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const h = loadShim({
        submit: () => 1,
        apply: (x) => {
          calls++;
          return `applied:${x}`;
        },
      });
      const result = h.module.kicadCollabApplyItems(7);

      await vi.advanceTimersByTimeAsync(0);
      expect(h.submitted).toHaveLength(1);
      expect(calls).toBe(0);
      expect(h.scheduler.mutatorInFlight).toBe(h.submitted[0]);

      // Models the release-edge wx tick admitting this Ordinary job.
      expect(h.scheduler.deliverMutator(h.submitted[0]!)).toBe(1);
      let settled = false;
      void Promise.resolve(result).finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled, "delivery is not native completion").toBe(false);

      expect(h.scheduler.completeMutator(h.submitted[0]!)).toBe(1);
      await expect(result).resolves.toBe("applied:7");
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs an execution barrier as a zero-byte owner job and settles only at exact native retirement", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({ submit: () => 1 });
      const barrier = h.scheduler.executionBarrier("board open");

      expect(h.scheduler.mutatorQueue).toHaveLength(1);
      expect(h.scheduler.mutatorQueuedBytes, "a barrier retains no payload").toBe(0);
      expect(h.scheduler.mutatorHighWaterBytes).toBe(0);

      await vi.advanceTimersByTimeAsync(0);
      const id = h.submitted[0]!;
      expect(id).toBeGreaterThan(0);
      expect(h.scheduler.deliverMutator(id)).toBe(1);

      let settled = false;
      void barrier.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled, "JavaScript delivery is not owner retirement").toBe(false);
      expect(h.scheduler.mutatorInFlight).toBe(id);

      expect(h.scheduler.completeMutator(id)).toBe(1);
      await expect(barrier).resolves.toBeUndefined();
      expect(settled).toBe(true);
      expect(h.scheduler.mutatorInFlight).toBe(0);
      expect(h.scheduler.mutatorQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps execution barriers in mutator FIFO order and applies the same job backpressure", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const h = loadShim({
        submit: () => 1,
        apply: (value) => {
          calls.push(value);
          return `applied:${value}`;
        },
      });
      const before = h.module.kicadCollabApplyItems(1);
      const barrier = h.scheduler.executionBarrier("between mutations");
      const after = h.module.kicadCollabApplyItems(2);

      await vi.advanceTimersByTimeAsync(0);
      expect(h.submitted).toHaveLength(1);
      expect(h.scheduler.deliverMutator(h.submitted[0]!)).toBe(1);
      expect(h.scheduler.completeMutator(h.submitted[0]!)).toBe(1);
      await expect(before).resolves.toBe("applied:1");

      await vi.advanceTimersByTimeAsync(0);
      expect(h.submitted).toHaveLength(2);
      expect(h.scheduler.deliverMutator(h.submitted[1]!)).toBe(1);
      expect(calls).toEqual([1]);
      expect(h.scheduler.completeMutator(h.submitted[1]!)).toBe(1);
      await expect(barrier).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(0);
      expect(h.submitted).toHaveLength(3);
      expect(h.scheduler.deliverMutator(h.submitted[2]!)).toBe(1);
      expect(h.scheduler.completeMutator(h.submitted[2]!)).toBe(1);
      await expect(after).resolves.toBe("applied:2");
      expect(calls).toEqual([1, 2]);

      const bounded = loadShim({ submit: () => 1 });
      bounded.scheduler.MAX_MUTATOR_JOBS = 1;
      const held = bounded.module.kicadCollabApplyItems(3);
      const heldRejected = expect(held).rejects.toThrow("shutdown");
      await expect(bounded.scheduler.executionBarrier("overflow")).rejects.toMatchObject({
        code: "WX_MUTATOR_BACKPRESSURE",
        reason: "jobs",
        maxJobs: 1,
        pendingJobs: 1,
      });
      expect(bounded.scheduler.mutatorBackpressureRejections).toBe(1);
      expect(bounded.scheduler.mutatorJobLimitRejections).toBe(1);
      bounded.scheduler.shutdown("barrier capacity cleanup");
      await heldRejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects execution barriers on shutdown and when the native owner transport is absent", async () => {
    vi.useFakeTimers();
    try {
      const stopped = loadShim();
      stopped.scheduler.shutdown("barrier shutdown test");
      await expect(stopped.scheduler.executionBarrier("late")).rejects.toThrow(
        "shutdown: application is dead",
      );
      expect(stopped.scheduler.mutatorQueue).toHaveLength(0);

      const unavailable = loadShim({ submit: () => 1 });
      delete (unavailable.module as Partial<FakeModule>)._wxWasmEmbindSubmit;
      const barrier = unavailable.scheduler.executionBarrier("no transport");
      const rejected = expect(barrier).rejects.toThrow(
        "wxWasmEmbindSubmit export is missing",
      );
      await vi.advanceTimersByTimeAsync(0);
      await rejected;
      expect(unavailable.scheduler.mutatorsDelivered).toBe(0);
      expect(unavailable.scheduler.mutatorQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a 500-call flood strictly FIFO with one native job in flight", async () => {
    vi.useFakeTimers();
    try {
      const order: number[] = [];
      const h = loadShim({ apply: (x) => { order.push(x); return `applied:${x}`; } });
      const results = Array.from({ length: 500 }, (_, i) =>
        Promise.resolve(h.module.kicadCollabApplyItems(i)),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(h.submitted).toHaveLength(1);
      await drainMutators(h.scheduler);
      await expect(Promise.all(results)).resolves.toEqual(
        Array.from({ length: 500 }, (_, i) => `applied:${i}`),
      );
      expect(order).toEqual(Array.from({ length: 500 }, (_, i) => i));
      expect(h.scheduler.mutatorsSubmitted).toBe(500);
      expect(h.scheduler.mutatorsDelivered).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects before the 10,001st job and accepts again after exact settlement", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({ submit: () => 1 });
      expect(h.scheduler.MAX_MUTATOR_JOBS).toBe(10_000);
      const queued = Array.from(
        { length: h.scheduler.MAX_MUTATOR_JOBS },
        (_, i) => Promise.resolve(h.module.kicadCollabApplyItems(i)).catch(() => undefined),
      );
      expect(h.scheduler.mutatorQueue).toHaveLength(10_000);

      const overflow = h.module.kicadCollabApplyItems(10_000);
      await expect(overflow).rejects.toMatchObject({
        code: "WX_MUTATOR_BACKPRESSURE",
        reason: "jobs",
        maxJobs: 10_000,
        pendingJobs: 10_000,
      });
      expect(h.scheduler.mutatorQueue).toHaveLength(10_000);
      expect(h.scheduler.mutatorBackpressureRejections).toBe(1);
      expect(h.scheduler.mutatorJobLimitRejections).toBe(1);
      expect(h.scheduler.mutatorHighWaterJobs).toBe(10_000);

      await vi.advanceTimersByTimeAsync(0);
      const firstId = h.submitted[0]!;
      expect(h.scheduler.deliverMutator(firstId)).toBe(1);
      expect(h.scheduler.completeMutator(firstId)).toBe(1);
      await Promise.resolve();

      const replacement = Promise.resolve(
        h.module.kicadCollabApplyItems(10_001),
      ).catch(() => undefined);
      expect(h.scheduler.mutatorQueue).toHaveLength(10_000);
      expect(h.scheduler.mutatorBackpressureRejections).toBe(1);

      h.scheduler.shutdown("capacity test cleanup");
      await Promise.all([...queued, replacement]);
      expect(h.scheduler.mutatorQueuedBytes).toBe(0);
      expect(h.scheduler.mutatorQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds retained payload at 16 MiB and remains usable after rejection", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({
        extraModule: {
          kicadCollabSetRemote: () => "applied",
        },
      });
      expect(h.scheduler.MAX_MUTATOR_PAYLOAD_BYTES).toBe(16 * 1024 * 1024);
      const exactLimit = "x".repeat(h.scheduler.MAX_MUTATOR_PAYLOAD_BYTES / 2);
      const accepted = h.module.kicadCollabSetRemote!(exactLimit);
      expect(h.scheduler.mutatorQueuedBytes).toBe(
        h.scheduler.MAX_MUTATOR_PAYLOAD_BYTES,
      );

      const overflow = h.module.kicadCollabSetRemote!("y");
      await expect(overflow).rejects.toMatchObject({
        code: "WX_MUTATOR_BACKPRESSURE",
        reason: "bytes",
        maxBytes: 16 * 1024 * 1024,
        pendingBytes: 16 * 1024 * 1024,
        estimatedBytes: 2,
      });
      expect(h.scheduler.mutatorBackpressureRejections).toBe(1);
      expect(h.scheduler.mutatorByteLimitRejections).toBe(1);
      expect(h.scheduler.mutatorHighWaterBytes).toBe(16 * 1024 * 1024);

      await drainMutators(h.scheduler);
      await expect(accepted).resolves.toBe("applied");
      expect(h.scheduler.mutatorQueuedBytes).toBe(0);

      const replacement = h.module.kicadCollabSetRemote!("small");
      await drainMutators(h.scheduler);
      await expect(replacement).resolves.toBe("applied");
      expect(h.scheduler.mutatorQueuedBytes).toBe(0);
      expect(h.scheduler.mutatorBackpressureRejections).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects mutable reference payloads before they enter the owned queue", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({
        extraModule: {
          kicadCollabSetRemote: () => "applied",
        },
      });
      const submit = h.module.kicadCollabSetRemote as unknown as (
        payload: unknown,
      ) => Promise<string>;

      await expect(submit({ mutable: true })).rejects.toMatchObject({
        code: "WX_MUTATOR_BACKPRESSURE",
        reason: "bytes",
        estimatedBytes: h.scheduler.MAX_MUTATOR_PAYLOAD_BYTES + 1,
      });
      expect(h.scheduler.mutatorQueue).toHaveLength(0);
      expect(h.submitted).toHaveLength(0);

      const replacement = submit(JSON.stringify({ mutable: false }));
      await drainMutators(h.scheduler);
      await expect(replacement).resolves.toBe("applied");
      expect(h.scheduler.mutatorQueuedBytes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a throwing job once and continues with the next FIFO job", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({
        apply: (x) => {
          if (x === 1) throw new Error("bad payload");
          return `applied:${x}`;
        },
      });
      const bad = h.module.kicadCollabApplyItems(1);
      const good = h.module.kicadCollabApplyItems(2);
      const rejection = expect(bad).rejects.toThrow("bad payload");
      await drainMutators(h.scheduler);
      await rejection;
      await expect(good).resolves.toBe("applied:2");
      expect(h.scheduler.mutatorsDelivered).toBe(2);
      expect(h.scheduler.dead).toBe(false);
      expect(h.scheduler.nativeTraps).toBe(0);
      expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminally shuts down and rethrows a native trap during delivery", async () => {
    vi.useFakeTimers();
    try {
      const trap = new WebAssembly.RuntimeError("memory access out of bounds");
      let calls = 0;
      const h = loadShim({
        submit: () => 1,
        apply: () => {
          calls++;
          throw trap;
        },
      });
      const rejectPopupLeases = vi.fn(() => {
        expect(
          (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown,
          "popup cleanup must see the instance as unsafe before shutdown",
        ).toBe(true);
      });
      (h.module as FakeModule & {
        wxRejectContextMenuLeases: () => void;
      }).wxRejectContextMenuLeases = rejectPopupLeases;
      const first = h.module.kicadCollabApplyItems(1);
      const second = h.module.kicadCollabApplyItems(2);
      const firstRejected = expect(first).rejects.toThrow("shutdown");
      const secondRejected = expect(second).rejects.toThrow("shutdown");

      await vi.advanceTimersByTimeAsync(0);
      const id = h.submitted[0]!;
      expect(() => h.scheduler.deliverMutator(id)).toThrow(trap);

      await firstRejected;
      await secondRejected;
      expect(calls).toBe(1);
      expect(h.scheduler.dead).toBe(true);
      expect(h.scheduler.nativeTraps).toBe(1);
      expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
      expect(rejectPopupLeases).toHaveBeenCalledOnce();
      expect(h.scheduler.completeMutator(id), "no native tail after a trap").toBe(0);
      expect(h.scheduler.mutatorQueue).toHaveLength(0);
      expect(h.submitted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognizes Chromium's plain unreachable trap after wrapper attribution is lost", () => {
    const h = loadShim();
    expect(h.scheduler._isNativeTrap(new Error("unreachable"))).toBe(true);
    expect(h.scheduler._isNativeTrap("RuntimeError: unreachable")).toBe(true);
    expect(h.scheduler._isNativeTrap(new Error("service temporarily unreachable"))).toBe(false);
    expect(h.scheduler._isNativeTrap(new Error("ordinary application failure"))).toBe(false);
  });

  it("terminally shuts down and rethrows a trap from native submission", async () => {
    vi.useFakeTimers();
    try {
      const trap = new WebAssembly.RuntimeError("unreachable");
      const h = loadShim({ submit: () => { throw trap; } });
      const first = h.module.kicadCollabApplyItems(1);
      const second = h.module.kicadCollabApplyItems(2);
      const firstRejected = expect(first).rejects.toThrow("shutdown");
      const secondRejected = expect(second).rejects.toThrow("shutdown");

      await expect(vi.advanceTimersByTimeAsync(0)).rejects.toBe(trap);
      await firstRejected;
      await secondRejected;
      expect(h.scheduler.dead).toBe(true);
      expect(h.scheduler.nativeTraps).toBe(1);
      expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
      expect(h.scheduler.mutatorQueue).toHaveLength(0);
      expect(h.submitted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-stops if raw owner delivery returns a thenable", async () => {
    vi.useFakeTimers();
    try {
      const rawThenable = Promise.resolve("unsafe-async-result");
      const h = loadShim({
        submit: () => 1,
        apply: () => rawThenable,
      });

      const first = h.module.kicadCollabApplyItems(1);
      const second = h.module.kicadCollabApplyItems(2);
      const firstRejected = expect(first).rejects.toThrow("shutdown");
      const secondRejected = expect(second).rejects.toThrow("shutdown");
      await vi.advanceTimersByTimeAsync(0);
      const id = h.submitted[0]!;

      expect(h.scheduler.deliverMutator(id)).toBe(0);
      await firstRejected;
      await secondRejected;
      expect(h.scheduler.dead).toBe(true);
      expect(
        (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown,
      ).toBe(true);
      expect(h.scheduler.completeMutator(id)).toBe(0);
      expect(h.submitted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not settle or submit the next command before native owner retirement", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const h = loadShim({
        submit: (id) => {
          setTimeout(() => h.scheduler.deliverMutator(id), 1);
          return 1;
        },
        apply: (x) => {
          calls.push(x);
          return `applied:${x}`;
        },
      });

      const first = h.module.kicadCollabApplyItems(1);
      const second = h.module.kicadCollabApplyItems(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(calls).toEqual([1]);
      expect(h.submitted).toHaveLength(1);
      expect(h.scheduler.mutatorQueue).toHaveLength(2);

      h.scheduler.completeMutator(h.submitted[0]!);
      await expect(first).resolves.toBe("applied:1");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.submitted).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1);
      h.scheduler.completeMutator(h.submitted[1]!);
      await expect(second).resolves.toBe("applied:2");
      expect(calls).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the ticket when an affiliated native fiber reports failure", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({ submit: () => 1 });
      const result = h.module.kicadCollabApplyItems(1);
      await vi.advanceTimersByTimeAsync(0);
      const id = h.submitted[0]!;

      expect(h.scheduler.deliverMutator(id)).toBe(1);
      expect(h.scheduler.completeMutator(id, "commit failed")).toBe(1);
      await expect(result).rejects.toMatchObject({
        code: "WX_NATIVE_OWNER_FAILED",
        message: expect.stringContaining("commit failed"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown rejects queued and submitted jobs; a late native delivery is inert", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const h = loadShim({ submit: () => 1, apply: () => { calls++; return "late"; } });
      const first = h.module.kicadCollabApplyItems(1);
      const second = h.module.kicadCollabApplyItems(2);
      const firstRejected = expect(first).rejects.toThrow("shutdown");
      const secondRejected = expect(second).rejects.toThrow("shutdown");
      await vi.advanceTimersByTimeAsync(0);
      const staleId = h.submitted[0]!;

      h.scheduler.shutdown("test teardown");
      await firstRejected;
      await secondRejected;
      expect(h.scheduler.deliverMutator(staleId)).toBe(0);
      expect(calls).toBe(0);
      expect(h.scheduler.mutatorQueue).toHaveLength(0);
      expect(h.scheduler.mutatorQueuedBytes).toBe(0);
      expect(h.scheduler.state()).toContain("DEAD");
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes a submitted resource-affine job inert when its generation expires", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let current = true;
      const h = loadShim({
        submit: () => 1,
        apply: () => {
          calls++;
          return "should-not-run";
        },
      });
      const guarded = (
        h.module.kicadCollabApplyItems as typeof h.module.kicadCollabApplyItems & {
          __wxGuardedCall(
            args: unknown[],
            isCurrent: () => boolean,
          ): Promise<string>;
        }
      ).__wxGuardedCall;
      const result = guarded([7], () => current);

      await vi.advanceTimersByTimeAsync(0);
      const id = h.submitted[0]!;
      expect(id).toBeGreaterThan(0);
      current = false;

      expect(h.scheduler.deliverMutator(id)).toBe(1);
      expect(h.scheduler.completeMutator(id)).toBe(1);
      await expect(result).rejects.toMatchObject({ code: "WX_MUTATOR_STALE" });
      expect(calls).toBe(0);
      expect(h.scheduler.mutatorQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wrap its own gateway again during repeated export discovery", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim();
      const wrapped = h.module.kicadCollabApplyItems;
      const wrappedCount = h.scheduler.mutatorsWrapped;

      h.scheduler._wrapMutators();
      expect(h.module.kicadCollabApplyItems).toBe(wrapped);
      expect(h.scheduler.mutatorsWrapped).toBe(wrappedCount);

      const result = h.module.kicadCollabApplyItems(9);
      await drainMutators(h.scheduler);
      await expect(result).resolves.toBe("applied:9");
      expect(h.scheduler.mutatorsDelivered).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs wrappers before application runtime initialization can retain raw exports", () => {
    let retained: FakeModule["kicadCollabApplyItems"] | undefined;
    let sawWrapped = false;
    const h = loadShim({
      extraModule: {
        onRuntimeInitialized: () => {
          const live = (globalThis as unknown as { Module: FakeModule }).Module
            .kicadCollabApplyItems as FakeModule["kicadCollabApplyItems"] & {
              __wxMutatorWrapped?: boolean;
            };
          retained = live;
          sawWrapped = live.__wxMutatorWrapped === true;
        },
      },
    });

    expect(sawWrapped).toBe(true);
    expect(retained).toBe(h.module.kicadCollabApplyItems);
  });

  it("routes former synchronous APIs through the same owner gateway", async () => {
    vi.useFakeTimers();
    const h = loadShim({
      extraModule: {
        kicadCollabSnapshotItems: () => '{"added":[]}',
        kicadCollabGetPos: (uuid) => uuid,
        kicadCollabGetViewport: () => '{"cx":0}',
        kicadCollabGetSelection: () => "[]",
        kicadCollabGetSelectionFull: () => '{"uuids":[]}',
        kicadCollabTestGetCrossMapped: () => "[]",
        kicadCollabTestGetLocked: () => "[]",
        kicadCollabTestListItems: () => "[]",
        kicadCollabTestDemoSet: () => '{"groups":[]}',
        kicadCollabTestItemBlob: (uuid) => `blob:${uuid}`,
        kicadCollabTestUndoDepth: () => 2,
        kicadLibsReload: () => undefined,
        kicadLibsSymbolUsage: (_nickname, name) => (name === "R" ? 1 : 0),
        kicadSetChrome: (show) => show,
        kicadSetDarkChrome: (dark) => dark,
        kicadSaveBoard: () => undefined,
      },
    });
    const snapshot = h.module.kicadCollabSnapshotItems?.();
    const pos = h.module.kicadCollabGetPos?.("u1");
    const viewport = h.module.kicadCollabGetViewport?.();
    const selection = h.module.kicadCollabGetSelection?.();
    const fullSelection = h.module.kicadCollabGetSelectionFull?.();
    const crossMapped = h.module.kicadCollabTestGetCrossMapped?.();
    const locked = h.module.kicadCollabTestGetLocked?.();
    const listed = h.module.kicadCollabTestListItems?.(3);
    const demo = h.module.kicadCollabTestDemoSet?.();
    const blob = h.module.kicadCollabTestItemBlob?.("u1");
    const undoDepth = h.module.kicadCollabTestUndoDepth?.();
    const reload = h.module.kicadLibsReload?.("symbol", "Device");
    const usage = h.module.kicadLibsSymbolUsage?.("Device", "R");
    const chrome = h.module.kicadSetChrome?.(true);
    const save = h.module.kicadSaveBoard?.("/tmp/a.kicad_pcb");
    const startupTheme = h.module.kicadSetDarkChrome?.(true);
    await drainMutators(h.scheduler);
    await expect(snapshot).resolves.toBe('{"added":[]}');
    await expect(pos).resolves.toBe("u1");
    await expect(viewport).resolves.toBe('{"cx":0}');
    await expect(selection).resolves.toBe("[]");
    await expect(fullSelection).resolves.toBe('{"uuids":[]}');
    await expect(crossMapped).resolves.toBe("[]");
    await expect(locked).resolves.toBe("[]");
    await expect(listed).resolves.toBe("[]");
    await expect(demo).resolves.toBe('{"groups":[]}');
    await expect(blob).resolves.toBe("blob:u1");
    await expect(undoDepth).resolves.toBe(2);
    await expect(reload).resolves.toBeUndefined();
    await expect(usage).resolves.toBe(1);
    await expect(chrome).resolves.toBe(true);
    await expect(save).resolves.toBeUndefined();
    expect(startupTheme).toBe(true);
    expect(h.scheduler.mutatorsDelivered).toBe(15);
    vi.useRealTimers();
  });

  it("does not exempt exported local-edit test hooks from ownership", () => {
    const h = loadShim();
    const localEditHooks = [
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
    ];

    expect(h.scheduler.MUTATOR_NAMES).toEqual(
      expect.arrayContaining(localEditHooks),
    );
    expect(h.scheduler.MUTATOR_NAMES).not.toContain("kicadTestArmTimerPark");
    expect(h.scheduler.MUTATOR_NAMES).not.toContain("kicadTestFiberParkStart");
  });

  it("does not wrap or serialize independent network/service requests", async () => {
    vi.useFakeTimers();
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const h = loadShim({
        submit: () => 1, // keep a state writer parked in native admission
        extraModule: {
          kicadOpenFile: () => {
            throw new Error("raw open must be replaced by the owner wrapper");
          },
          kicadOpenFileStart: () => true, // leave an owned open parked too
          fetchLibrary: async (name) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 10));
            inFlight--;
            return name;
          },
        },
      });
      const stateWrite = h.module.kicadCollabApplyItems(1);
      const open = h.module.kicadOpenFile?.("/project/a.kicad_pcb");
      const a = h.module.fetchLibrary?.("A");
      const b = h.module.fetchLibrary?.("B");
      await vi.advanceTimersByTimeAsync(10);
      await expect(Promise.all([a, b])).resolves.toEqual(["A", "B"]);
      expect(maxInFlight).toBe(2);
      const stateRejected = expect(stateWrite).rejects.toThrow("shutdown");
      const openRejected = expect(open).rejects.toMatchObject({
        code: "WX_OPEN_OWNER_FAILED",
      });
      h.scheduler.shutdown("test cleanup");
      await stateRejected;
      await openRejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduler owned-open wrappers", () => {
  beforeEach(() => vi.useRealTimers());

  it("routes both single-file and multi-file opens through distinct exact-tail tokens", async () => {
    const starts: Array<{ kind: "single" | "multi"; token: number; payload: string }> = [];
    let rawCalls = 0;
    const h = loadShim({
      extraModule: {
        kicadOpenFile: () => {
          rawCalls++;
          return false;
        },
        kicadOpenFileStart: (token, path) => {
          starts.push({ kind: "single", token, payload: path });
          return true;
        },
        kicadOpenFiles: () => {
          rawCalls++;
          return false;
        },
        kicadOpenFilesStart: (token, pathsJson) => {
          starts.push({ kind: "multi", token, payload: pathsJson });
          return true;
        },
      },
    });

    const single = h.module.kicadOpenFile!("/project/a.kicad_pcb");
    const multi = h.module.kicadOpenFiles!('["/project/a.gbr","/project/a.drl"]');
    expect(rawCalls, "the direct suspending exports are never entered").toBe(0);
    expect(starts.map(({ kind, payload }) => ({ kind, payload }))).toEqual([
      { kind: "single", payload: "/project/a.kicad_pcb" },
      { kind: "multi", payload: '["/project/a.gbr","/project/a.drl"]' },
    ]);
    expect(starts[0]!.token).not.toBe(starts[1]!.token);
    expect(h.scheduler.waitHighWater).toBe(2);

    let multiSettled = false;
    void Promise.resolve(multi).finally(() => {
      multiSettled = true;
    });
    expect(h.scheduler.resolveWait(starts[0]!.token, 1)).toBe(true);
    await expect(single).resolves.toBe(true);
    await Promise.resolve();
    expect(multiSettled, "one owner tail cannot complete another open").toBe(false);

    expect(h.scheduler.resolveWait(starts[1]!.token, 0)).toBe(true);
    await expect(multi).resolves.toBe(false);
    expect(h.scheduler.pendingWaits("open")).toBe(0);
  });

  it("preserves FIFO and one-owner-at-a-time behavior of the native open lane", async () => {
    vi.useFakeTimers();
    try {
      type NativeOpen = { token: number; label: string };
      const queued: NativeOpen[] = [];
      const order: string[] = [];
      let active = 0;
      let maxActive = 0;
      let pumpArmed = false;
      const arm = () => {
        if (pumpArmed || active || queued.length === 0) return;
        pumpArmed = true;
        setTimeout(() => {
          pumpArmed = false;
          const next = queued.shift()!;
          active++;
          maxActive = Math.max(maxActive, active);
          order.push(next.label);
          setTimeout(() => {
            h.scheduler.resolveWait(next.token, 1);
            active--;
            arm();
          }, 2);
        }, 0);
      };
      const enqueue = (token: number, label: string) => {
        queued.push({ token, label });
        arm();
        return true;
      };
      const h = loadShim({
        extraModule: {
          kicadOpenFile: () => false,
          kicadOpenFileStart: (token, path) => enqueue(token, `single:${path}`),
          kicadOpenFiles: () => false,
          kicadOpenFilesStart: (token, paths) => enqueue(token, `multi:${paths}`),
        },
      });

      const first = h.module.kicadOpenFile!("a");
      const second = h.module.kicadOpenFiles!("[b,c]");
      const third = h.module.kicadOpenFile!("d");
      await vi.advanceTimersByTimeAsync(20);

      await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true]);
      expect(order).toEqual(["single:a", "multi:[b,c]", "single:d"]);
      expect(maxActive).toBe(1);
      expect(h.scheduler.pendingWaits("open")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects refused and throwing starters without leaking an open wait", async () => {
    const submitError = new Error("starter threw");
    const h = loadShim({
      extraModule: {
        kicadOpenFile: () => false,
        kicadOpenFileStart: () => false,
        kicadOpenFiles: () => false,
        kicadOpenFilesStart: () => {
          throw submitError;
        },
      },
    });

    await expect(h.module.kicadOpenFile!("a")).rejects.toMatchObject({
      code: "WX_OPEN_SUBMIT_REJECTED",
      message: expect.stringContaining("kicadOpenFileStart"),
    });
    await expect(h.module.kicadOpenFiles!("[a]")).rejects.toBe(submitError);
    expect(h.scheduler.pendingWaits("open")).toBe(0);
  });

  it("rejects submission even if a legacy starter pre-resolves its token", async () => {
    let h: ReturnType<typeof loadShim>;
    h = loadShim({
      extraModule: {
        kicadOpenFile: () => false,
        kicadOpenFileStart: (token) => {
          h.scheduler.resolveWait(token, 0);
          return false;
        },
      },
    });

    await expect(h.module.kicadOpenFile!("a")).rejects.toMatchObject({
      code: "WX_OPEN_SUBMIT_REJECTED",
    });
    expect(h.scheduler.pendingWaits("open")).toBe(0);
  });

  it("rejects a late open without entering native code after shutdown", async () => {
    let starts = 0;
    const h = loadShim({
      extraModule: {
        kicadOpenFile: () => false,
        kicadOpenFileStart: () => {
          starts++;
          return true;
        },
      },
    });

    h.scheduler.shutdown("open lane closed");
    await expect(h.module.kicadOpenFile!("a")).rejects.toMatchObject({
      code: "WX_OPEN_NATIVE_UNAVAILABLE",
    });
    expect(starts).toBe(0);
    expect(h.scheduler.pendingWaits("open")).toBe(0);
  });

  it("preserves the exact shutdown rejection when submit fails synchronously", async () => {
    let h: ReturnType<typeof loadShim>;
    h = loadShim({
      extraModule: {
        kicadOpenFile: () => false,
        kicadOpenFileStart: () => {
          h.scheduler.shutdown("submit fail-stop");
          return false;
        },
      },
    });

    await expect(h.module.kicadOpenFile!("a")).rejects.toMatchObject({
      code: "WX_OPEN_OWNER_FAILED",
      message: expect.stringContaining("submit fail-stop"),
    });
    expect(h.scheduler.pendingWaits("open")).toBe(0);
  });

  it("terminally shuts down and rethrows a native trap from an open starter", () => {
    const trap = new WebAssembly.RuntimeError("indirect call signature mismatch");
    const h = loadShim({
      extraModule: {
        kicadOpenFile: () => false,
        kicadOpenFileStart: () => { throw trap; },
      },
    });

    expect(() => h.module.kicadOpenFile!("a")).toThrow(trap);
    expect(h.scheduler.dead).toBe(true);
    expect(h.scheduler.nativeTraps).toBe(1);
    expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
    expect(h.scheduler.pendingWaits("open")).toBe(0);
  });

  it("rejects a pending open on fail-stop and ignores its late native tail", async () => {
    let token = 0;
    const h = loadShim({
      extraModule: {
        kicadOpenFile: () => false,
        kicadOpenFileStart: (nextToken) => {
          token = nextToken;
          return true;
        },
      },
    });
    const result = h.module.kicadOpenFile!("a");
    const rejected = expect(result).rejects.toMatchObject({
      code: "WX_OPEN_OWNER_FAILED",
      message: expect.stringContaining("fatal owner failure"),
    });

    h.scheduler.shutdown("fatal owner failure");
    await rejected;
    expect(h.scheduler.resolveWait(token, 1)).toBe(false);
    expect(h.scheduler.pendingWaits("open")).toBe(0);
  });
});

describe("scheduler global native-trap containment", () => {
  it("defers pure-JS ingress payload cleanup until exact native discards can run", async () => {
    const discardDomLifetime = vi.fn();
    const discardDom = vi.fn();
    const discardDrops = vi.fn();
    const discardBitmaps = vi.fn();
    const discardGLTimer = vi.fn();
    const h = loadShim({
      extraModule: {
        wxDiscardDomBrowserLifetime: discardDomLifetime,
        wxDiscardDomEventSnapshots: discardDom,
        wxDiscardFileDropBatches: discardDrops,
        wxDiscardBitmapResources: discardBitmaps,
        wxDiscardGLPatchTimer: discardGLTimer,
      },
    });

    h.scheduler.shutdown("ingress cleanup test");
    expect(discardDomLifetime).not.toHaveBeenCalled();
    expect(discardDom).not.toHaveBeenCalled();
    expect(discardDrops).not.toHaveBeenCalled();
    expect(discardBitmaps).not.toHaveBeenCalled();
    expect(discardGLTimer).not.toHaveBeenCalled();

    const replacementDiscards = {
      wxDiscardDomBrowserLifetime: vi.fn(),
      wxDiscardDomEventSnapshots: vi.fn(),
      wxDiscardFileDropBatches: vi.fn(),
      wxDiscardBitmapResources: vi.fn(),
      wxDiscardGLPatchTimer: vi.fn(),
    };
    (globalThis as unknown as { Module: FakeModule }).Module = {
      ...h.module,
      ...replacementDiscards,
    };

    await Promise.resolve();
    expect(discardDomLifetime).toHaveBeenCalledOnce();
    expect(discardDom).toHaveBeenCalledOnce();
    expect(discardDrops).toHaveBeenCalledOnce();
    expect(discardBitmaps).toHaveBeenCalledOnce();
    expect(discardGLTimer).toHaveBeenCalledOnce();
    expect(replacementDiscards.wxDiscardDomBrowserLifetime).not.toHaveBeenCalled();
    expect(replacementDiscards.wxDiscardDomEventSnapshots).not.toHaveBeenCalled();
    expect(replacementDiscards.wxDiscardFileDropBatches).not.toHaveBeenCalled();
    expect(replacementDiscards.wxDiscardBitmapResources).not.toHaveBeenCalled();
    expect(replacementDiscards.wxDiscardGLPatchTimer).not.toHaveBeenCalled();
  });

  it("closes the shared late-completion gate on shutdown or integrity loss", () => {
    const h = loadShim();
    expect(h.scheduler.canTouchNative()).toBe(true);

    (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown = true;
    expect(h.scheduler.canTouchNative()).toBe(false);

    delete (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown;
    expect(h.scheduler.canTouchNative()).toBe(true);
    h.scheduler.shutdown("late-completion gate test");
    expect(h.scheduler.canTouchNative()).toBe(false);
    expect(h.scheduler.resolveWait(123, 1)).toBe(false);
    expect(h.scheduler.beginWait("late")).toBe(0);
  });

  it("detaches generated Emscripten browser ingress without re-entering native", () => {
    const removeAllEventListeners = vi.fn();
    (globalThis as Record<string, unknown>).JSEvents = {
      removeAllEventListeners,
    };
    try {
      const h = loadShim();
      h.scheduler.shutdown("detach native browser ingress");
      expect(removeAllEventListeners).toHaveBeenCalledOnce();
    } finally {
      delete (globalThis as Record<string, unknown>).JSEvents;
    }
  });

  it("terminalizes inside a native completion before a catch can retry", () => {
    const h = loadShim();
    const trap = new WebAssembly.RuntimeError("memory access out of bounds");
    let nativeCalls = 0;

    expect(() =>
      h.scheduler.runNativeCompletion("test completion", () => {
        nativeCalls++;
        throw trap;
      }),
    ).toThrow(trap);
    expect(h.scheduler.dead).toBe(true);

    // Models the failure fallback in a Promise catch: it uses the same gate.
    expect(
      h.scheduler.runNativeCompletion("fallback", () => {
        nativeCalls++;
      }),
    ).toBeUndefined();
    expect(nativeCalls).toBe(1);
  });

  it("prepares exact wait output before publishing its result", () => {
    const h = loadShim();
    const token = h.scheduler.beginWait("provider");
    const order: string[] = [];

    expect(
      h.scheduler.runWaitCompletion("provider completion", token, () => {
        order.push("prepared");
        return 73;
      }),
    ).toBe(true);

    const entry = h.scheduler.waits.get(token) as
      | { resolved?: boolean; result?: number }
      | undefined;
    expect(order).toEqual(["prepared"]);
    expect(entry).toMatchObject({ resolved: true, result: 73 });
    expect(h.scheduler.dead).toBe(false);
  });

  it("accepts zero as a valid exact-wait failure result", async () => {
    const h = loadShim();
    const token = h.scheduler.beginWait("provider");

    expect(
      h.scheduler.runWaitCompletion("provider allocation failure", token, () => 0),
    ).toBe(true);
    expect(h.scheduler.dead).toBe(false);
    expect(h.scheduler.nativeTraps).toBe(0);
    await expect(h.scheduler.waitPromise(token)).resolves.toBe(0);
    expect(h.scheduler.waits.size).toBe(0);
  });

  it.each([
    {
      label: "ordinary JavaScript error",
      failure: new Error("provider result preparation failed"),
    },
    {
      label: "FS-like ErrnoError",
      failure: Object.assign(new Error("MEMFS write failed"), {
        name: "ErrnoError",
        errno: 28,
      }),
    },
  ])("fail-stops when $label escapes exact-wait preparation", ({ failure }) => {
    const h = loadShim();
    const token = h.scheduler.beginWait("provider");
    let prepareCalls = 0;

    expect(() =>
      h.scheduler.runWaitCompletion("provider completion", token, () => {
        prepareCalls++;
        throw failure;
      }),
    ).toThrow(failure);

    expect(prepareCalls).toBe(1);
    expect(h.scheduler.dead).toBe(true);
    expect(h.scheduler.pendingWaits("provider")).toBe(0);
    expect(h.scheduler.waits.size).toBe(0);
    expect(h.scheduler.waitsAbandoned).toBe(1);
    expect(h.scheduler.nativeTraps).toBe(0);
    expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
    expect(
      (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown,
    ).toBeUndefined();

    // The Promise rejection arm used by exact providers can attempt a
    // fallback completion. A terminal edge must reject that replay before it
    // touches native state or runs preparation a second time.
    expect(
      h.scheduler.runWaitCompletion("provider fallback", token, () => {
        prepareCalls++;
        return 0;
      }),
    ).toBe(false);
    expect(prepareCalls).toBe(1);
  });

  it("terminalizes an exact-wait native trap once and rejects replay", () => {
    const h = loadShim();
    const token = h.scheduler.beginWait("provider");
    const trap = new WebAssembly.RuntimeError("memory access out of bounds");
    let prepareCalls = 0;

    expect(() =>
      h.scheduler.runWaitCompletion("provider completion", token, () => {
        prepareCalls++;
        throw trap;
      }),
    ).toThrow(trap);

    expect(h.scheduler.dead).toBe(true);
    expect(h.scheduler.nativeTraps).toBe(1);
    expect(h.scheduler.waits.size).toBe(0);
    expect(h.scheduler.waitsAbandoned).toBe(1);
    expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
    expect(
      (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown,
    ).toBe(true);

    expect(
      h.scheduler.runWaitCompletion("provider fallback", token, () => {
        prepareCalls++;
        return 0;
      }),
    ).toBe(false);
    expect(prepareCalls).toBe(1);
    expect(h.scheduler.nativeTraps).toBe(1);
  });

  it("fail-stops when exact-wait publication throws", () => {
    const h = loadShim();
    const token = h.scheduler.beginWait("provider");
    const publishError = new Error("wait registry publication failed");
    let prepareCalls = 0;
    let publishCalls = 0;
    h.scheduler.resolveWait = () => {
      publishCalls++;
      throw publishError;
    };

    expect(() =>
      h.scheduler.runWaitCompletion("provider completion", token, () => {
        prepareCalls++;
        return 17;
      }),
    ).toThrow(publishError);

    expect(prepareCalls).toBe(1);
    expect(publishCalls).toBe(1);
    expect(h.scheduler.dead).toBe(true);
    expect(h.scheduler.pendingWaits("provider")).toBe(0);
    expect(h.scheduler.waits.size).toBe(0);
    expect(h.scheduler.waitsAbandoned).toBe(1);
    expect(h.scheduler.nativeTraps).toBe(0);
    expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
    expect(
      (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown,
    ).toBeUndefined();

    expect(
      h.scheduler.runWaitCompletion("provider fallback", token, () => {
        prepareCalls++;
        return 0;
      }),
    ).toBe(false);
    expect(prepareCalls).toBe(1);
    expect(publishCalls).toBe(1);
  });

  it("fail-stops when a live completion has lost its exact wait token", () => {
    const h = loadShim();
    let prepared = 0;

    expect(
      h.scheduler.runWaitCompletion("orphan completion", 404, () => {
        prepared++;
        return 9;
      }),
    ).toBe(false);
    expect(prepared).toBe(1);
    expect(h.scheduler.dead).toBe(true);
    expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
  });

  it("terminalizes an uncaught browser-callback trap exactly once", () => {
    const browser = makeGlobalTrapWindow();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = loadShim({ trapWindow: browser.window });
      const trap = new WebAssembly.RuntimeError("memory access out of bounds");

      browser.emit("error", { error: trap, message: trap.message });
      expect(h.scheduler.dead).toBe(true);
      expect(h.scheduler.nativeTraps).toBe(1);
      expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
      expect(
        (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown,
      ).toBe(true);

      // Browsers can surface one rejected callback through more than one
      // reporting path. Fail-stop is a state transition, not a counter per
      // ErrorEvent.
      browser.emit("error", { error: trap, message: trap.message });
      browser.emit("unhandledrejection", { reason: trap });
      expect(h.scheduler.nativeTraps).toBe(1);
    } finally {
      errorSpy.mockRestore();
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("terminalizes an unhandled native promise rejection", () => {
    const browser = makeGlobalTrapWindow();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = loadShim({ trapWindow: browser.window });
      const trap = new WebAssembly.RuntimeError("unreachable");

      browser.emit("unhandledrejection", { reason: trap });
      expect(h.scheduler.dead).toBe(true);
      expect(h.scheduler.nativeTraps).toBe(1);
      expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
    } finally {
      errorSpy.mockRestore();
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("does not fail-stop for ordinary application errors", () => {
    const browser = makeGlobalTrapWindow();
    try {
      const h = loadShim({ trapWindow: browser.window });

      browser.emit("error", { error: new Error("bad user payload") });
      browser.emit("unhandledrejection", { reason: new Error("fetch failed") });
      expect(h.scheduler.dead).toBe(false);
      expect(h.scheduler.nativeTraps).toBe(0);
      expect(
        (globalThis as Record<string, unknown>).__wxWasmFailed,
      ).toBeUndefined();
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});

describe("scheduler physical native-entry arbiter", () => {
  it("stages ingress while a logical context transition is asynchronously parked", () => {
    let receipts = 0;
    const h = loadShim();

    expect(
      h.scheduler.runNativeIngressReceipt("parked-owner DOM event", (token) => {
        // The E2E reducer supplies the real state: native libcontext
        // transition==true while JS Asyncify.state==Normal. The receipt lane
        // must test its actual physical gates directly, not call and ignore
        // the general fresh-entry readiness probe.
        expect(h.scheduler.takeIngressReceipt(token)?.sequence).toBe(token);
        receipts++;
        return 1;
      }),
    ).toBe(1);
    expect(receipts).toBe(1);
    expect(h.scheduler.dead).toBe(false);
  });

  it.each([
    ["Asyncify unwind", 1, false],
    ["Asyncify rewind", 2, false],
    ["fiber trampoline", 0, true],
  ])("retains ingress during %s and stages it once at a safe boundary", async (
    _label,
    state,
    trampoline,
  ) => {
    vi.useFakeTimers();
    try {
      const fibers = trampoline ? { trampolineRunning: true } : undefined;
      const h = loadShim({ fibers });
      const runtime = (globalThis as unknown as {
        Asyncify: { state: number };
      }).Asyncify;
      runtime.state = state;
      let receipts = 0;

      expect(
        h.scheduler.runNativeIngressReceipt("deferred DOM event", (token) => {
          expect(h.scheduler.takeIngressReceipt(token)?.sequence).toBe(token);
          receipts++;
          return 1;
        }),
      ).toBe(1);
      expect(receipts).toBe(0);
      expect(h.scheduler.dead).toBe(false);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(1);

      // Model the corresponding transition-completion signal.  Dedicated
      // tests below exercise the real unwind edge; the runtime wrappers also
      // signal rewind and trampoline completion.
      runtime.state = 0;
      if (fibers) fibers.trampolineRunning = false;
      h.scheduler._armNativeEntryDrain();
      await vi.advanceTimersByTimeAsync(0);

      expect(receipts).toBe(1);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(0);
      expect(h.scheduler.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms a deferred ingress on the actual unwind-completion edge", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim();
      const runtime = (globalThis as unknown as {
        Asyncify: {
          state: number;
          currData: unknown;
          exportCallStack: string[];
          maybeStopUnwind(): unknown;
        };
      }).Asyncify;
      runtime.state = 1;
      h.scheduler.authorize(() => {
        runtime.currData = 1234;
      });
      runtime.exportCallStack.length = 0;
      let receipts = 0;

      expect(h.scheduler.runNativeIngressReceipt("toolbar click", (token) => {
        expect(h.scheduler.takeIngressReceipt(token)?.sequence).toBe(token);
        receipts++;
        return 1;
      })).toBe(1);
      expect(receipts).toBe(0);

      runtime.maybeStopUnwind();
      await vi.advanceTimersByTimeAsync(0);

      expect(receipts).toBe(1);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(0);
      expect(h.scheduler.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a later safe receipt behind an older transition-deferred receipt", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim();
      const runtime = (globalThis as unknown as {
        Asyncify: { state: number };
      }).Asyncify;
      const order: Array<{
        name: string;
        value: string;
        receipt: IngressReceipt;
      }> = [];

      runtime.state = 1;
      expect(h.scheduler.runNativeIngressReceipt("A-down", (token) => {
        order.push({
          name: "A-down",
          value: "first",
          receipt: h.scheduler.takeIngressReceipt(token)!,
        });
        return 1;
      })).toBe(1);

      // Asyncify can become Normal before the already-armed task which owns A
      // runs. B must join that same receipt FIFO instead of entering inline.
      runtime.state = 0;
      expect(h.scheduler.runNativeIngressReceipt("B-up", (token) => {
        order.push({
          name: "B-up",
          value: "second",
          receipt: h.scheduler.takeIngressReceipt(token)!,
        });
        return 1;
      })).toBe(1);
      expect(order).toEqual([]);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(2);

      await vi.advanceTimersToNextTimerAsync();
      expect(order.map((entry) => entry.name)).toEqual(["A-down"]);
      await vi.advanceTimersToNextTimerAsync();
      expect(order.map((entry) => entry.name)).toEqual(["A-down", "B-up"]);
      expect(order.map((entry) => [entry.name, entry.value])).toEqual([
        ["A-down", "first"],
        ["B-up", "second"],
      ]);
      expect(order.map((entry) => entry.receipt.sequence)).toEqual([1, 2]);
      expect(order.map((entry) => entry.receipt.deferredBehindEarlier))
        .toEqual([false, true]);
      expect(h.scheduler.ingressReceipts.size).toBe(0);
      expect(h.scheduler.pendingIngressReceipts.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins L1 provenance before defer and never rebinds it to L2", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim();
      const runtime = (globalThis as unknown as {
        Asyncify: { state: number };
      }).Asyncify;
      const base = {
        available: true,
        hasLease: true,
        targetScope: 0x5100,
        targetGeneration: 17,
        leaseIdHigh: 0,
        leaseParentLow: 7,
        leaseParentHigh: 0,
        leaseGenerationHigh: 0,
      };
      expect(h.scheduler.publishIngressLeaseSnapshot({
        ...base, leaseIdLow: 11, leaseGenerationLow: 101,
      })).toBe(true);

      runtime.state = 1;
      let captured: IngressReceipt | null = null;
      expect(h.scheduler.runNativeIngressReceipt("L1 input", (token) => {
        captured = h.scheduler.takeIngressReceipt(token);
        return 1;
      })).toBe(1);

      // L1 closes and the same target scope opens L2 before delivery.
      expect(h.scheduler.publishIngressLeaseSnapshot({
        ...base, leaseIdLow: 12, leaseGenerationLow: 102,
      })).toBe(true);
      runtime.state = 0;
      h.scheduler._armNativeEntryDrain();
      await vi.advanceTimersToNextTimerAsync();

      expect(captured).toMatchObject({
        hasLease: true,
        targetScope: 0x5100,
        targetGeneration: 17,
        leaseIdLow: 11,
        leaseGenerationLow: 101,
      });
      expect(captured).not.toMatchObject({
        leaseIdLow: 12,
        leaseGenerationLow: 102,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies an unavailable lease snapshot as ordinary with no lease", () => {
    const h = loadShim();
    expect(h.scheduler.publishIngressLeaseSnapshot({
      available: false,
      hasLease: true,
      targetScope: 0x5100,
      targetGeneration: 17,
      leaseIdLow: 11,
      leaseGenerationLow: 101,
    })).toBe(false);

    let captured: IngressReceipt | null = null;
    expect(h.scheduler.runNativeIngressReceipt("unavailable snapshot", (token) => {
      captured = h.scheduler.takeIngressReceipt(token);
      return 1;
    })).toBe(1);
    expect(captured).toMatchObject({
      snapshotAvailable: false,
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
  });

  it("retains a busy head without polling and resumes on the transition edge", async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      let probes = 0;
      let runs = 0;
      const h = loadShim({
        extraModule: {
          _wxWasmNativeEntryReady: () => {
            try {
              probes++;
              return ready ? 1 : 0;
            } finally {
              // Real Emscripten wrappers call this after every Wasm export.
              // A refused leaf probe must not mistake its own wrapper-finally
              // for an unwind-completion edge and arm another timer.
              const runtime = (globalThis as unknown as {
                Asyncify: { maybeStopUnwind(): unknown };
              }).Asyncify;
              runtime.maybeStopUnwind();
            }
          },
        },
      });

      expect(h.scheduler.enqueueNativeEntry(
        "main-loop", "first frame", () => { runs++; },
      )).toBe(true);
      expect(h.scheduler.enqueueNativeEntry(
        "main-loop", "duplicate frame", () => { runs++; },
      )).toBe(true);

      await vi.advanceTimersByTimeAsync(0);
      expect(probes).toBe(1);
      expect(runs).toBe(0);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(1);
      expect(h.scheduler.nativeEntryDeferred).toBe(1);
      expect(h.scheduler.nativeEntryCoalesced).toBe(1);

      // A failed probe does not start a retry timer.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probes).toBe(1);

      ready = true;
      const asyncify = (globalThis as unknown as {
        Asyncify: {
          state: number;
          currData: unknown;
          exportCallStack: string[];
          maybeStopUnwind(): unknown;
        };
      }).Asyncify;
      // Model the real transition edge. A normal-state maybeStopUnwind call
      // (such as the leaf probe's wrapper) is deliberately insufficient.
      h.scheduler.authorize(() => {
        asyncify.currData = 1234;
      });
      asyncify.state = 1;
      asyncify.exportCallStack.length = 0;
      asyncify.maybeStopUnwind();
      await vi.advanceTimersByTimeAsync(0);

      expect(probes).toBe(2);
      expect(runs).toBe(1);
      expect(h.scheduler.nativeEntryDelivered).toBe(1);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers exact entries FIFO, one accepted entry per task", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim();
      const order: number[] = [];
      for (let i = 0; i < 3; i++) {
        expect(h.scheduler.enqueueNativeEntry(
          null, `exact-${i}`, () => order.push(i),
        )).toBe(true);
      }

      await vi.advanceTimersToNextTimerAsync();
      expect(order).toEqual([0]);
      await vi.advanceTimersToNextTimerAsync();
      expect(order).toEqual([0, 1]);
      await vi.advanceTimersToNextTimerAsync();
      expect(order).toEqual([0, 1, 2]);
      expect(h.scheduler.nativeEntryHighWater).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds queued completion payloads and releases each reservation before its callback", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim();
      const observedBytes: number[] = [];

      expect(h.scheduler.enqueueNativeCompletion(
        "first provider completion",
        12,
        () => observedBytes.push(h.scheduler.nativeCompletionQueuedBytes),
      )).toBe(true);
      expect(h.scheduler.enqueueNativeCompletion(
        "second provider completion",
        20,
        () => observedBytes.push(h.scheduler.nativeCompletionQueuedBytes),
      )).toBe(true);
      expect(h.scheduler.nativeCompletionQueuedBytes).toBe(32);
      expect(h.scheduler.nativeCompletionHighWaterBytes).toBe(32);

      await vi.advanceTimersToNextTimerAsync();
      expect(observedBytes).toEqual([20]);
      expect(h.scheduler.nativeCompletionQueuedBytes).toBe(20);

      await vi.advanceTimersToNextTimerAsync();
      expect(observedBytes).toEqual([20, 0]);
      expect(h.scheduler.nativeCompletionQueuedBytes).toBe(0);
      expect(h.scheduler.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons accepted JS observers on shutdown without re-entering native closures", async () => {
    vi.useFakeTimers();
    try {
      let exactRuns = 0;
      let completionRuns = 0;
      let proxyRuns = 0;
      let contextWakeRuns = 0;
      const abandoned: Array<{
        error: Error & { code?: string; site?: string };
        dead: boolean;
        queued: number;
        bytes: number;
      }> = [];
      const h = loadShim({
        extraModule: {
          _wxWasmSchedResolveContextWait: () => {
            contextWakeRuns++;
            return 1;
          },
        },
      });
      const observeAbandon = (error: Error) => {
        abandoned.push({
          error: error as Error & { code?: string; site?: string },
          dead: h.scheduler.dead,
          queued: h.scheduler.nativeEntryQueue.length,
          bytes: h.scheduler.nativeCompletionQueuedBytes,
        });
      };

      expect(h.scheduler.enqueueNativeEntry(
        null,
        "Promise-backed exact entry",
        () => { exactRuns++; },
        observeAbandon,
      )).toBe(true);
      expect(h.scheduler.enqueueNativeCompletion(
        "Promise-backed completion",
        37,
        () => { completionRuns++; },
        observeAbandon,
      )).toBe(true);
      // A native proxy completion has no safe JS finalizer. In particular,
      // shutdown must not call emscripten_proxy_finish through this closure.
      expect(h.scheduler.enqueueNativeCompletion(
        "native proxy completion",
        11,
        () => { proxyRuns++; },
      )).toBe(true);

      const waitToken = h.scheduler.beginWait("modal");
      expect(h.scheduler.noteContextWait(waitToken)).toBe(true);
      expect(h.scheduler.resolveWait(waitToken, 9)).toBe(true);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(4);
      expect(h.scheduler.nativeCompletionQueuedBytes).toBe(48);
      expect(h.scheduler.waits.size).toBe(1);

      h.scheduler.shutdown("terminal native failure");

      expect(h.scheduler.nativeEntryQueue).toHaveLength(0);
      expect(h.scheduler.nativeCompletionQueuedBytes).toBe(0);
      expect(h.scheduler.waits.size).toBe(0);
      expect(h.scheduler.nativeEntryAbandoned).toBe(4);
      expect(h.scheduler.nativeEntryAbandonCallbacks).toBe(2);
      expect(h.scheduler.nativeEntryAbandonErrors).toBe(0);
      expect(h.scheduler.waitsAbandoned).toBe(1);
      expect(abandoned.map(({ error }) => ({
        code: error.code,
        site: error.site,
      }))).toEqual([
        {
          code: "WX_NATIVE_ENTRY_ABANDONED",
          site: "Promise-backed exact entry",
        },
        {
          code: "WX_NATIVE_ENTRY_ABANDONED",
          site: "Promise-backed completion",
        },
      ]);
      expect(abandoned.every(({ dead, queued, bytes }) =>
        dead && queued === 0 && bytes === 0,
      )).toBe(true);

      await vi.runAllTimersAsync();
      expect({ exactRuns, completionRuns, proxyRuns, contextWakeRuns }).toEqual({
        exactRuns: 0,
        completionRuns: 0,
        proxyRuns: 0,
        contextWakeRuns: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not abandon an exact entry after normal delivery consumed it", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      let abandons = 0;
      const h = loadShim();
      expect(h.scheduler.enqueueNativeEntry(
        null,
        "normally delivered exact entry",
        () => { runs++; },
        () => { abandons++; },
      )).toBe(true);

      await vi.advanceTimersToNextTimerAsync();
      expect(runs).toBe(1);
      h.scheduler.shutdown("normal teardown");
      expect(abandons).toBe(0);
      expect(h.scheduler.nativeEntryAbandoned).toBe(0);
      expect(h.scheduler.nativeEntryAbandonCallbacks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-stops instead of stranding an exact waiter when completion bytes overflow", () => {
    const h = loadShim();
    expect(h.scheduler.MAX_NATIVE_COMPLETION_BYTES).toBe(64 * 1024 * 1024);
    expect(h.scheduler.enqueueNativeCompletion(
      "held provider completion",
      h.scheduler.MAX_NATIVE_COMPLETION_BYTES,
      () => {},
    )).toBe(true);
    expect(h.scheduler.nativeCompletionQueuedBytes).toBe(
      h.scheduler.MAX_NATIVE_COMPLETION_BYTES,
    );

    expect(h.scheduler.enqueueNativeCompletion(
      "overflow provider completion",
      1,
      () => {},
    )).toBe(false);
    expect(h.scheduler.nativeCompletionBackpressureRejections).toBe(1);
    expect(h.scheduler.dead).toBe(true);
    expect(h.scheduler.nativeEntryQueue).toHaveLength(0);
    expect(h.scheduler.nativeCompletionQueuedBytes).toBe(0);
  });

  it("never replays an accepted entry that starts a suspension", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim();
      let runs = 0;
      const asyncify = (globalThis as unknown as {
        Asyncify: { state: number; maybeStopUnwind(): unknown };
      }).Asyncify;

      h.scheduler.enqueueNativeEntry(null, "suspending export", () => {
        runs++;
        // Model the shallow return observed while this accepted export starts
        // an Asyncify unwind. Admission was already consumed before the call.
        asyncify.state = 1;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toBe(1);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(0);

      asyncify.state = 0;
      asyncify.maybeStopUnwind();
      await vi.advanceTimersByTimeAsync(100);
      expect(runs).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a level key before callback code can signal the next level", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim();
      let runs = 0;
      const signal = () => {
        h.scheduler.enqueueNativeEntry("main-loop", "frame level", () => {
          runs++;
          if (runs === 1) signal();
        });
      };

      signal();
      await vi.advanceTimersToNextTimerAsync();
      expect(runs).toBe(1);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(1);
      await vi.advanceTimersToNextTimerAsync();
      expect(runs).toBe(2);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a context sleep before its timer becomes due", async () => {
    vi.useFakeTimers();
    try {
      let wakes = 0;
      const h = loadShim({
        extraModule: {
          _pcbjam_context_sleep_wake: () => { wakes++; return 1; },
        },
      });

      expect(h.scheduler.scheduleContextSleep(41, 101, 100)).toBe(true);
      expect(h.scheduler.contextSleeps.size).toBe(1);
      expect(h.scheduler.cancelContextSleep(41, 101)).toBe(true);
      expect(h.scheduler.contextSleeps.size).toBe(0);
      expect(h.scheduler.contextSleepsCancelled).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(wakes).toBe(0);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(0);
      expect(h.scheduler.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes a due context sleep while its exact native entry is waiting", async () => {
    vi.useFakeTimers();
    try {
      let wakes = 0;
      const h = loadShim({
        extraModule: {
          _wxWasmNativeEntryReady: () => 0,
          _pcbjam_context_sleep_wake: () => { wakes++; return 1; },
        },
      });

      expect(h.scheduler.scheduleContextSleep(42, 102, 5)).toBe(true);
      await vi.advanceTimersByTimeAsync(6);
      expect(h.scheduler.contextSleeps.size).toBe(1);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(1);

      expect(h.scheduler.cancelContextSleep(42, 102)).toBe(true);
      expect(h.scheduler.contextSleeps.size).toBe(0);
      expect(h.scheduler.nativeEntryQueue).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(wakes).toBe(0);
      expect(h.scheduler.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes a context-sleep lease before its exact native wake", async () => {
    vi.useFakeTimers();
    try {
      const woke: number[] = [];
      const h = loadShim({
        extraModule: {
          _pcbjam_context_sleep_wake: (context, token) => {
            expect(h.scheduler.contextSleeps.has(context)).toBe(false);
            expect(token).toBe(103);
            woke.push(context);
            return 1;
          },
        },
      });

      expect(h.scheduler.scheduleContextSleep(43, 103, 5)).toBe(true);
      await vi.advanceTimersByTimeAsync(6);
      await vi.runOnlyPendingTimersAsync();

      expect(woke).toEqual([43]);
      expect(h.scheduler.contextSleeps.size).toBe(0);
      expect(h.scheduler.contextSleepsDelivered).toBe(1);
      expect(h.scheduler.contextSleepHighWater).toBe(1);
      expect(h.scheduler.cancelContextSleep(43, 103)).toBe(false);
      expect(h.scheduler.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminally rejects cancellation with the wrong context-sleep token", () => {
    const h = loadShim();
    expect(h.scheduler.scheduleContextSleep(44, 104, 100)).toBe(true);
    expect(h.scheduler.cancelContextSleep(44, 999)).toBe(false);
    expect(h.scheduler.dead).toBe(true);
    expect(h.scheduler.contextSleeps.size).toBe(0);
  });

  it("retires every raw-pointer fiber guard entry before address reuse", () => {
    const fiber = 0x12340;
    const fibers = {
      finishContextSwitch: () => undefined,
      trampoline: () => undefined,
      trampolineRunning: false,
      __rootFiber: fiber,
    } as Record<string, unknown>;
    const h = loadShim({ fibers });
    const guarded = fibers as {
      __validSuspensions: Set<number>;
      __internallyParked: Set<number>;
      __parkSleepBuf: Map<number, number>;
      __rootFiber?: number;
    };

    guarded.__validSuspensions.add(fiber);
    guarded.__internallyParked.add(fiber);
    guarded.__parkSleepBuf.set(fiber, 0xfeed);
    h.scheduler.releaseFiberGuard(fiber);

    expect(guarded.__validSuspensions.has(fiber)).toBe(false);
    expect(guarded.__internallyParked.has(fiber)).toBe(false);
    expect(guarded.__parkSleepBuf.has(fiber)).toBe(false);
    expect(guarded.__rootFiber).toBeUndefined();

    // The allocator may now reuse the address. It starts with no inherited
    // suspension, which is the only safe first-entry classification.
    expect(guarded.__validSuspensions.has(fiber)).toBe(false);
    delete (globalThis as Record<string, unknown>).Fibers;
  });
});

describe("scheduler wake and lifetime queues", () => {
  it("fail-stops when a non-sentinel error escapes an Asyncify wake", () => {
    const escaped = new Error("native handler failed during rewind");
    let wake: ((result: unknown) => void) | undefined;
    const h = loadShim({
      sleepWake: () => {
        // Emscripten enters Rewinding before doRewind(), whose exception is
        // rethrown through the wake callback when no async export Promise owns
        // it. The saved transition cannot safely remain available for reuse.
        (globalThis as unknown as {
          Asyncify: { state: number };
        }).Asyncify.state = 2;
        throw escaped;
      },
    });
    const asyncify = (globalThis as unknown as {
      Asyncify: {
        handleSleep(start: (resume: (result: unknown) => void) => void): unknown;
      };
    }).Asyncify;

    asyncify.handleSleep((resume) => { wake = resume; });
    expect(wake).toBeTypeOf("function");
    expect(() => wake?.(7)).toThrow(escaped);
    expect(h.scheduler.dead).toBe(true);
    expect(h.scheduler.nativeTraps).toBe(0);
    expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
    expect(
      (globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown,
    ).toBe(true);
  });

  it("rejects an exact context wake refused by native state", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({
        extraModule: {
          _wxWasmSchedResolveContextWait: () => 0,
        },
      });
      const token = h.scheduler.beginWait("modal");
      h.scheduler.noteContextWait(token);

      // Resolution accepts the exact payload into the physical-entry FIFO.
      // Native refusal is observed only when the clean entry is delivered.
      expect(h.scheduler.resolveWait(token, 7)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.scheduler.dead).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the wait registry and never wraps exact wait tokens", () => {
    const h = loadShim();
    h.scheduler.MAX_WAITS = 1;
    expect(h.scheduler.beginWait("first")).toBe(1);
    expect(h.scheduler.beginWait("overflow")).toBe(0);
    expect(h.scheduler.dead).toBe(true);

    const exhausted = loadShim();
    (exhausted.scheduler as SchedulerShape & { waitSeq: number }).waitSeq =
      0x7fffffff;
    expect(exhausted.scheduler.beginWait("wrapped")).toBe(0);
    expect(exhausted.scheduler.dead).toBe(true);
  });

  it("rejects and fail-stops a live wait whose exact token was lost", async () => {
    const h = loadShim();

    await expect(h.scheduler.waitPromise(404)).rejects.toThrow(
      "waitPromise lost exact token 404",
    );
    expect(h.scheduler.dead).toBe(true);
    expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);

    await expect(h.scheduler.waitPromise(404)).rejects.toThrow(
      "wait requested after scheduler shutdown",
    );
  });

  it("terminally shuts down instead of swallowing a context-wake trap", async () => {
    vi.useFakeTimers();
    try {
      const trap = new WebAssembly.RuntimeError("unreachable");
      let nativeCalls = 0;
      const h = loadShim({
        extraModule: {
          _wxWasmSchedResolveContextWait: () => {
            nativeCalls++;
            throw trap;
          },
        },
      });
      const token = h.scheduler.beginWait("modal");
      h.scheduler.noteContextWait(token);

      expect(h.scheduler.resolveWait(token, 7)).toBe(true);
      await expect(vi.advanceTimersByTimeAsync(0)).rejects.toBe(trap);
      expect(nativeCalls).toBe(1);
      expect(h.scheduler.dead).toBe(true);
      expect(h.scheduler.nativeTraps).toBe(1);
      expect((globalThis as Record<string, unknown>).__wxWasmFailed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("transports opaque native lease provenance without interpreting it", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({
        // Keep the mailbox record observable instead of delivering its tick.
        extraModule: { _wxWasmNativeEntryReady: () => 0 },
      });
      h.scheduler.enqueueAfter(
        1234,
        55,
        5,
        4,
        0xab,
        7,
        99,
        2,
        0x89abcdef,
        0x12345678,
        0x76543210,
        0xfedcba98,
        0x0badf00d,
        0xc001d00d,
      );
      await vi.advanceTimersByTimeAsync(6);

      expect(h.scheduler.mailbox).toEqual([
        expect.objectContaining({
          fn: 1234,
          arg: 55,
          workClass: 4,
          targetScope: 0xab,
          targetGeneration: 7,
          discard: 99,
          coalesce: 2,
          leaseIdLow: 0x89abcdef,
          leaseIdHigh: 0x12345678,
          leaseParentLow: 0x76543210,
          leaseParentHigh: 0xfedcba98,
          leaseGenerationLow: 0x0badf00d,
          leaseGenerationHigh: 0xc001d00d,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops mailbox work after shutdown", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({
        // Retain the mailbox level in the physical-entry FIFO. This test is
        // about shutdown disposal, not native mailbox transport.
        extraModule: { _wxWasmNativeEntryReady: () => 0 },
      });
      h.scheduler.enqueueAfter(1234, 0, 5);
      h.scheduler.enqueueAfter(5678, 0, 10_000);
      await vi.advanceTimersByTimeAsync(6);
      expect(h.scheduler.mailbox).toHaveLength(1);
      expect(h.scheduler.mailboxTimers.size).toBe(1);
      expect(h.scheduler.mailboxHighWater).toBe(2);
      h.scheduler.shutdown("test teardown");
      expect(h.scheduler.mailboxTimers.size).toBe(0);
      h.scheduler.enqueueAfter(1234, 0, 1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.scheduler.mailbox).toHaveLength(0);
      expect(h.scheduler.mailboxHighWater).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an exact long-delay mailbox reservation", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({
        extraModule: { _wxWasmNativeEntryReady: () => 0 },
      });
      const token = h.scheduler.enqueueAfter(1234, 77, 60 * 60 * 1000);
      expect(token).toBeGreaterThan(0);
      expect(h.scheduler.mailboxReserved).toBe(1);
      expect(h.scheduler.mailboxReservations.size).toBe(1);
      expect(h.scheduler.mailboxTimers.size).toBe(1);

      expect(h.scheduler.cancelMailbox(token)).toBe(true);
      expect(h.scheduler.cancelMailbox(token)).toBe(false);
      expect(h.scheduler.mailboxReserved).toBe(0);
      expect(h.scheduler.mailboxReservations.size).toBe(0);
      expect(h.scheduler.mailboxTimers.size).toBe(0);
      expect(h.scheduler.mailboxCanceled).toBe(1);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
      expect(h.scheduler.mailbox).toHaveLength(0);
      expect(h.scheduler.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an expired mailbox record before native admission", async () => {
    vi.useFakeTimers();
    try {
      const h = loadShim({
        // The timeout expires, but the physical native-entry gate remains
        // closed, leaving the exact due record cancellable in the mailbox.
        extraModule: { _wxWasmNativeEntryReady: () => 0 },
      });
      const token = h.scheduler.enqueueAfter(4321, 88, 5);
      await vi.advanceTimersByTimeAsync(6);
      expect(h.scheduler.mailbox).toHaveLength(1);
      expect(h.scheduler.mailboxReserved).toBe(1);
      expect(h.scheduler.mailboxTimers.size).toBe(0);

      expect(h.scheduler.cancelMailbox(token)).toBe(true);
      expect(h.scheduler.mailbox).toHaveLength(0);
      expect(h.scheduler.mailboxReserved).toBe(0);
      expect(h.scheduler.mailboxReservations.size).toBe(0);
      expect(h.scheduler.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds delayed and due mailbox payloads with one reservation limit", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const h = loadShim({
        // Model a long native park: due records cannot cross the native-entry
        // readiness leaf, but they still consume their original reservation.
        extraModule: { _wxWasmNativeEntryReady: () => 0 },
      });
      h.scheduler.MAX_MAILBOX_JOBS = 2;

      h.scheduler.enqueueAfter(1001, 11, 5);
      h.scheduler.enqueueAfter(1002, 22, 5);
      expect(h.scheduler.mailboxReserved).toBe(2);
      expect(h.scheduler.mailboxHighWater).toBe(2);

      await vi.advanceTimersByTimeAsync(6);
      expect(h.scheduler.mailbox).toHaveLength(2);
      expect(h.scheduler.mailboxReserved).toBe(2);

      // The third native payload cannot be retained. Capacity exhaustion is
      // terminal, while the zero reservation identity lets the C++ caller
      // discard the just-refused payload instead of leaking it.
      h.scheduler.enqueueAfter(1003, 33, 1000);
      expect(h.scheduler.dead).toBe(true);
      expect(h.scheduler.mailboxBackpressureRejections).toBe(1);
      expect(h.scheduler.mailbox).toHaveLength(0);
      expect(h.scheduler.mailboxReserved).toBe(0);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("drains deferred wakes strictly FIFO", async () => {
    vi.useFakeTimers();
    try {
      const order: number[] = [];
      const h = loadShim({ sleepWake: (result) => order.push(result as number) });
      const asyncify = (globalThis as unknown as {
        Asyncify: {
          state: number;
          currData: unknown;
          exportCallStack: string[];
          handleSleep(start: (wake: (result: unknown) => void) => void): unknown;
          maybeStopUnwind(): unknown;
        };
      }).Asyncify;
      const wakes: Array<(result: unknown) => void> = [];

      for (let i = 0; i < 50; i++) {
        asyncify.handleSleep((wake) => wakes.push(wake));
      }

      // Force the transition-busy branch through the real wrapped
      // handleSleep wake path. No raw native entry is needed to test this JS
      // scheduler law.
      asyncify.state = 1;
      wakes.forEach((wake, index) => wake(index));
      expect(h.scheduler.deferredWakes).toBe(50);
      expect(h.scheduler.drainedWakes).toBe(0);
      expect(h.scheduler.readyWakes).toHaveLength(50);

      // The first clean task observes the busy transition and retains the
      // head. It must not poll after that refused attempt.
      await vi.advanceTimersByTimeAsync(0);
      expect(h.scheduler.drainedWakes).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.scheduler.drainedWakes).toBe(0);

      // Only a real Unwinding→Normal edge can restart the retained drain.
      h.scheduler.authorize(() => {
        asyncify.currData = 5678;
      });
      asyncify.exportCallStack.length = 0;
      asyncify.maybeStopUnwind();
      await vi.advanceTimersByTimeAsync(50);
      expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
      expect(h.scheduler.readyWakeHighWater).toBe(50);
      expect(h.scheduler.drainedWakes).toBe(50);
      expect(h.scheduler.readyWakes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-stops instead of retaining an unbounded deferred-wake queue", () => {
    const h = loadShim();
    h.scheduler.MAX_READY_WAKES = 2;
    const asyncify = (globalThis as unknown as {
      Asyncify: {
        state: number;
        handleSleep(start: (wake: (result: unknown) => void) => void): unknown;
      };
    }).Asyncify;
    const wakes: Array<(result: unknown) => void> = [];

    for (let i = 0; i < 3; i++)
      asyncify.handleSleep((wake) => wakes.push(wake));

    asyncify.state = 1;
    wakes.forEach((wake, index) => wake(index));

    expect(h.scheduler.dead).toBe(true);
    expect(h.scheduler.readyWakeHighWater).toBeLessThanOrEqual(2);
    expect(h.scheduler.readyWakes).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).__wxNativeIntegrityUnknown).toBe(true);
  });
});
