/**
 * N5 — flood/fairness unit gates for the scheduler shim
 * (docs/features/async/17 §3d N5; the shim source is scripts/common/shims/
 * asyncify-scheduler.js, loaded here against a fake runtime surface).
 *
 * Doc 06 §starvation: FIFO by default; a stimulus flood must neither reorder
 * deliveries nor starve them, and the time-boxed pump must not monopolize the
 * thread in one burst. These are unit gates — the e2e batteries cover the
 * same machinery under the real runtime.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SHIM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/common/shims/asyncify-scheduler.js",
);

type SchedulerShape = {
  mailbox: unknown[];
  mutatorQueue: unknown[];
  mutatorsDelivered: number;
  readyWakes: { deliver: (r: unknown) => void; result: unknown }[];
  deferredWakes: number;
  drainedWakes: number;
  strayWrites: number;
  dead: boolean;
  shutdown(reason: string): void;
  enqueueAfter(fn: number, arg: number, ms: number): void;
  _openBusy(): boolean;
  _armMutatorPump(): void;
  _scheduleWakeDrain(): void;
  state(): string;
};

declare global {
  // eslint-disable-next-line no-var
  var __wxScheduler: SchedulerShape | undefined;
  // eslint-disable-next-line no-var
  var __wxSchedulerInstalled: boolean | undefined;
}

function loadShim(opts: { busy: () => boolean }) {
  // Fresh globals per load — the shim's install guard is per-context.
  delete (globalThis as Record<string, unknown>).__wxSchedulerInstalled;
  delete (globalThis as Record<string, unknown>).__wxScheduler;
  const g = globalThis as Record<string, unknown>;
  g.Asyncify = {
    state: 0,
    exportCallStack: [],
    currData: null,
    handleSleep: function (startAsync: (wake: (r: unknown) => void) => void) {
      startAsync(() => undefined);
    },
    allocateData: () => 0,
    maybeStopUnwind: () => undefined,
  };
  g.Module = {
    kicadOpenFileBusy: opts.busy,
    kicadCollabApplyItems: (x: unknown) => `applied:${String(x)}`,
  };
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(SHIM_PATH, "utf8"));
  const S = (globalThis as Record<string, unknown>).__wxScheduler as SchedulerShape;
  // Run the Module init hook (fake runtime: pretend init fired).
  const M = g.Module as { onRuntimeInitialized?: () => void };
  M.onRuntimeInitialized?.();
  return S;
}

describe("N5: scheduler shim under flood", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("500-call mutator flood delivers strictly FIFO with zero drops", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const S = loadShim({ busy: () => busy });
      const M = (globalThis as Record<string, unknown>).Module as {
        kicadCollabApplyItems: (x: number) => Promise<string> | string;
      };
      const N = 500;
      const results: Promise<string>[] = [];
      for (let i = 0; i < N; i++) {
        results.push(Promise.resolve(M.kicadCollabApplyItems(i)));
      }
      expect(S.mutatorQueue.length).toBe(N);

      busy = false;
      // Drive fake time until the queue drains (the pump self-rearms at 16ms).
      for (let guard = 0; guard < 5000 && S.mutatorQueue.length > 0; guard++) {
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(S.mutatorQueue.length, "flood fully drained (no starvation)").toBe(0);

      const values = await Promise.all(results);
      // Strict FIFO: promise i resolved with its own payload, in order.
      for (let i = 0; i < N; i++) expect(values[i]).toBe(`applied:${i}`);
      expect(S.mutatorsDelivered).toBe(N);
    } finally {
      vi.useRealTimers();
    }
  });

  it("time-boxed pump yields between chunks — a flood cannot monopolize one task", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const S = loadShim({ busy: () => busy });
      const M = (globalThis as Record<string, unknown>).Module as {
        kicadCollabApplyItems: (x: number) => unknown;
      };
      // Each delivery burns ~1ms of fake "work" — with an 8ms box, one tick
      // must deliver only a handful, not all 100.
      const realNow = performance.now.bind(performance);
      let clock = 0;
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
        clock += 1; // every now() call advances 1ms: ~8 deliveries per box
        return clock;
      });
      for (let i = 0; i < 100; i++) void M.kicadCollabApplyItems(i);
      busy = false;
      await vi.advanceTimersByTimeAsync(16); // exactly one pump tick
      const afterOneTick = 100 - S.mutatorQueue.length;
      expect(afterOneTick, "one tick delivered something").toBeGreaterThan(0);
      expect(afterOneTick, "one tick did NOT deliver the whole flood").toBeLessThan(100);
      nowSpy.mockRestore();
      void realNow;
      // And the remainder still drains (no starvation after the box closes).
      for (let guard = 0; guard < 200 && S.mutatorQueue.length > 0; guard++) {
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(S.mutatorQueue.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("S6 shutdown: queued mutators reject, messages and wakes drop, pumps stop", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const S = loadShim({ busy: () => busy });
      const M = (globalThis as Record<string, unknown>).Module as {
        kicadCollabApplyItems: (x: number) => Promise<string> | string;
      };
      const p = Promise.resolve(M.kicadCollabApplyItems(1));
      const exP = expect(p).rejects.toThrow("shutdown");
      S.enqueueAfter(1234, 0, 5);
      await vi.advanceTimersByTimeAsync(6); // message lands in the mailbox
      S.readyWakes.push({ deliver: () => undefined, result: 0 });
      expect(S.mailbox.length).toBe(1);
      expect(S.mutatorQueue.length).toBe(1);

      S.shutdown("test teardown");
      await exP;
      expect(S.mailbox.length).toBe(0);
      expect(S.mutatorQueue.length).toBe(0);
      expect(S.readyWakes.length).toBe(0);
      expect(S.dead).toBe(true);
      expect(S.state()).toContain("DEAD");

      // Post-shutdown enqueues are dropped, and idempotent shutdown is safe.
      S.enqueueAfter(1234, 0, 1);
      await vi.advanceTimersByTimeAsync(5);
      expect(S.mailbox.length).toBe(0);
      S.shutdown("again");
      busy = false;
      await vi.advanceTimersByTimeAsync(100); // pumps must stay stopped
      expect(S.mutatorsDelivered).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deferred wakes drain strictly FIFO", async () => {
    vi.useFakeTimers();
    try {
      const S = loadShim({ busy: () => false });
      const order: number[] = [];
      // Queue 50 deferred wakes directly (the runtime path queues these when
      // a wake arrives mid-transition); the drain must preserve order.
      for (let i = 0; i < 50; i++) {
        S.readyWakes.push({ deliver: (r) => order.push(r as number), result: i });
      }
      S._scheduleWakeDrain();
      await vi.advanceTimersByTimeAsync(50);
      expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
      expect(S.readyWakes.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
