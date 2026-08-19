/**
 * N5 — flood/fairness unit gates for the scheduler shim
 * (docs/features/async/17 §3d N5; the shim source is scripts/common/shims/
 * jspi-scheduler.js, loaded here against a fake runtime surface).
 *
 * Doc 06 §starvation: FIFO by default; a stimulus flood must neither reorder
 * deliveries nor starve them, and the time-boxed pump must not monopolize the
 * thread in one burst. These are unit gates — the e2e batteries cover the
 * same machinery under the real runtime. The S4 wait-registry gates below
 * cover the token-wait contract the C++ bridges rely on.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SHIM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/common/shims/jspi-scheduler.js",
);

type SchedulerShape = {
  mailbox: unknown[];
  mutatorQueue: unknown[];
  mutatorsDelivered: number;
  dead: boolean;
  terminal: boolean;
  canTouchNative(): boolean;
  runWaitCompletion(
    site: string,
    token: number,
    prepare: () => number,
    inertResult?: number,
  ): boolean;
  shutdown(reason: string): void;
  enqueueAfter(fn: number, arg: number, ms: number): void;
  _openBusy(): boolean;
  _armMutatorPump(): void;
  beginWait(kind: string): number;
  waitPromise(token: number): Promise<number>;
  waitEarlyResolved(token: number): number;
  takeWaitResult(token: number): number;
  resolveWait(token: number, result: number): boolean;
  resolveTopWait(kind: string, result: number): boolean;
  pendingWaits(kind: string): number;
  earlyWaitResolves: number;
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
  g.Module = {
    kicadOpenFileBusy: opts.busy,
    kicadCollabApplyItems: (x: unknown) => `applied:${String(x)}`,
  };
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(SHIM_PATH, "utf8"));
  const S = (globalThis as Record<string, unknown>).__wxScheduler as SchedulerShape;
  // Run the Module init hook (fake runtime: pretend init fired) — installs
  // the export/parker/mutator wraps; absent names are skipped.
  const M = g.Module as { onRuntimeInitialized?: () => void };
  M.onRuntimeInitialized?.();
  return S;
}

describe("N5: scheduler shim under flood", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("installs the scheduler exactly once", () => {
    const S = loadShim({ busy: () => false });
    expect(S).toBeTruthy();
    expect(globalThis.__wxSchedulerInstalled).toBe(true);
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

  it("mutators bypass the queue when idle and not open-busy", () => {
    const S = loadShim({ busy: () => false });
    const M = (globalThis as Record<string, unknown>).Module as {
      kicadCollabApplyItems: (x: number) => unknown;
    };
    // Sync fast path: the wrapped call returns the real value, unqueued.
    expect(M.kicadCollabApplyItems(7)).toBe("applied:7");
    expect(S.mutatorQueue.length).toBe(0);
    expect(S.mutatorsDelivered).toBe(1);
  });

  it("S6 shutdown: queued mutators reject, messages drop, pumps stop", async () => {
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
      expect(S.mailbox.length).toBe(1);
      expect(S.mutatorQueue.length).toBe(1);

      S.shutdown("test teardown");
      await exP;
      expect(S.mailbox.length).toBe(0);
      expect(S.mutatorQueue.length).toBe(0);
      expect(S.dead).toBe(true);

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

  // --- S4 wait registry (JSPI-era unit gates) ------------------------------

  it("early resolve is consumed by the late waiter (no lost wake)", async () => {
    const S = loadShim({ busy: () => false });
    const token = S.beginWait("modal");
    // Resolve BEFORE anyone awaits — the EndModal-during-Show() race.
    expect(S.resolveWait(token, 42)).toBe(true);
    expect(S.waitEarlyResolved(token)).toBe(1);
    expect(S.earlyWaitResolves).toBe(1);
    // The late waiter still gets the result, immediately.
    await expect(S.waitPromise(token)).resolves.toBe(42);
    // Consumed: a second take returns nothing.
    expect(S.takeWaitResult(token)).toBe(0);
  });

  it("resolveTopWait pops per-kind LIFO — innermost modal first", () => {
    const S = loadShim({ busy: () => false });
    const outer = S.beginWait("modal");
    const inner = S.beginWait("modal");
    const nested = S.beginWait("nested"); // different kind: untouched
    expect(S.pendingWaits("modal")).toBe(2);

    expect(S.resolveTopWait("modal", 7)).toBe(true);
    expect(S.waitEarlyResolved(inner), "inner resolved first").toBe(1);
    expect(S.waitEarlyResolved(outer)).toBe(0);
    expect(S.pendingWaits("modal")).toBe(1);
    expect(S.pendingWaits("nested")).toBe(1);

    expect(S.resolveTopWait("modal", 8)).toBe(true);
    expect(S.waitEarlyResolved(outer)).toBe(1);
    expect(S.resolveTopWait("modal", 9), "empty stack refuses").toBe(false);
    void nested;
  });

  it("double resolve is refused; unknown token is a defined no-op", async () => {
    const S = loadShim({ busy: () => false });
    const token = S.beginWait("sleep");
    expect(S.resolveWait(token, 1)).toBe(true);
    expect(S.resolveWait(token, 2), "second resolve refused").toBe(false);
    await expect(S.waitPromise(token)).resolves.toBe(1);
    expect(S.resolveWait(99999, 0)).toBe(false);
    await expect(S.waitPromise(99999), "unknown token resolves 0").resolves.toBe(0);
  });
});

describe("E-8: runWaitCompletion admission gate for worker completions", () => {
  it("runs prepare immediately and resolves the wait with its result", async () => {
    const S = loadShim({ busy: () => false });
    const token = S.beginWait("occ");
    let ran = false;
    expect(
      S.runWaitCompletion("test completion", token, () => {
        ran = true;
        return 42;
      }),
    ).toBe(true);
    expect(ran, "prepare runs immediately, never queued").toBe(true);
    await expect(S.waitPromise(token)).resolves.toBe(42);
  });

  it("drops a completion for a stale or already-resolved token, loudly", () => {
    const S = loadShim({ busy: () => false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const prepare = vi.fn(() => 1);
      expect(S.runWaitCompletion("late frame", 99999, prepare)).toBe(false);
      const token = S.beginWait("occ");
      S.resolveWait(token, 7);
      expect(S.runWaitCompletion("late frame", token, prepare)).toBe(false);
      expect(prepare, "stale completions never touch native").not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("a dead instance admits no native work and does not resolve the wait", () => {
    const S = loadShim({ busy: () => false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const token = S.beginWait("ngspice");
      S.shutdown("test");
      expect(S.canTouchNative()).toBe(false);
      const prepare = vi.fn(() => 1);
      expect(S.runWaitCompletion("post-shutdown", token, prepare)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(S.waitEarlyResolved(token), "wait deliberately not resolved").toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("a trap in prepare latches terminal and never resolves the wait", () => {
    const S = loadShim({ busy: () => false });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const token = S.beginWait("occ");
      expect(
        S.runWaitCompletion("trapping completion", token, () => {
          throw new WebAssembly.RuntimeError("memory access out of bounds");
        }),
      ).toBe(false);
      expect(S.terminal).toBe(true);
      expect(S.canTouchNative()).toBe(false);
      // Resolving would resume the parked frame INSIDE the trapped module.
      expect(S.waitEarlyResolved(token)).toBe(0);
      // Every later completion is inert…
      const prepare = vi.fn(() => 1);
      const token2Before = S.beginWait("occ");
      expect(token2Before, "beginWait refuses on a terminal instance").toBe(0);
      expect(S.runWaitCompletion("after trap", token, prepare)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it("classifies cross-realm trap strings as terminal too", () => {
    const S = loadShim({ busy: () => false });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const token = S.beginWait("occ");
      S.runWaitCompletion("cross-realm trap", token, () => {
        throw new Error("RuntimeError: unreachable");
      });
      expect(S.terminal).toBe(true);
      expect(S.waitEarlyResolved(token)).toBe(0);
    } finally {
      err.mockRestore();
    }
  });

  it("a plain JS bug fails the wait with inertResult instead of stranding it", async () => {
    const S = loadShim({ busy: () => false });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const token = S.beginWait("ngspice");
      expect(
        S.runWaitCompletion(
          "buggy completion",
          token,
          () => {
            throw new TypeError("res.lines is not iterable");
          },
          1,
        ),
      ).toBe(false);
      expect(S.terminal, "a JS bug is not a trap").toBe(false);
      await expect(S.waitPromise(token), "wait fails instead of stranding").resolves.toBe(1);
    } finally {
      err.mockRestore();
    }
  });

  it("beginWait refuses (token 0) on a dead instance", () => {
    const S = loadShim({ busy: () => false });
    S.shutdown("test");
    expect(S.beginWait("occ")).toBe(0);
  });
});
