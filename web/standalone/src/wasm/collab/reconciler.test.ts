import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createReconciler } from "./reconciler";
import type { CollabBridge, CollabDelta, CollabItem } from "./types";

class FakeBridge implements CollabBridge {
  readonly store = new Map<string, CollabItem>();
  applyAttempts = 0;
  rejectNextApply = false;
  private emit: ((json: string) => void) | undefined;

  constructor(items: CollabItem[] = []) {
    for (const item of items) this.store.set(item.id, { ...item });
  }

  snapshot(): string {
    return JSON.stringify({
      added: [...this.store.values()],
      changed: [],
      removed: [],
    } satisfies CollabDelta);
  }

  apply(json: string): void | Promise<void> {
    this.applyAttempts++;
    if (this.rejectNextApply) {
      this.rejectNextApply = false;
      return Promise.reject(new Error("deterministic projection failure"));
    }
    this.applyNow(json);
  }

  onDelta(cb: (json: string) => void): void {
    this.emit = cb;
  }

  local(delta: CollabDelta): void {
    const json = JSON.stringify(delta);
    this.applyNow(json);
    this.emit?.(json);
  }

  protected applyNow(json: string): void {
    const delta = JSON.parse(json) as CollabDelta;
    for (const item of [...delta.added, ...delta.changed]) {
      this.store.set(item.id, { ...item });
    }
    for (const id of delta.removed) this.store.delete(id);
  }
}

function pair(): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (update: Uint8Array) => Y.applyUpdate(b, update, "relay"));
  b.on("update", (update: Uint8Array) => Y.applyUpdate(a, update, "relay"));
  return { a, b };
}

const ITEM: CollabItem = { id: "item-1", type: "segment", value: 1 };

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function backpressureError(): Error {
  return Object.assign(new Error("owner queue full"), {
    code: "WX_MUTATOR_BACKPRESSURE",
    reason: "jobs",
    estimatedBytes: 16,
    maxBytes: 1024,
  });
}

afterEach(() => vi.useRealTimers());

describe("createReconciler asynchronous projection", () => {
  it("awaits seed and catches a remote update that arrives during adopt", async () => {
    const { a, b } = pair();
    const source = new FakeBridge([ITEM]);
    await createReconciler(a, source).seed();

    let releaseApply!: () => void;
    let markApplyEntered!: () => void;
    const applyEntered = new Promise<void>((resolve) => {
      markApplyEntered = resolve;
    });
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const target = new FakeBridge();
    const originalApply = target.apply.bind(target);
    let first = true;
    target.apply = async (json: string) => {
      if (first) {
        first = false;
        markApplyEntered();
        await applyGate;
      }
      await originalApply(json);
    };

    const seed = createReconciler(b, target).seed();
    let settled = false;
    void seed.finally(() => {
      settled = true;
    });
    await applyEntered;
    expect(settled).toBe(false);

    a.getMap<Y.Map<unknown>>("items").get(ITEM.id)!.set("value", 2);
    releaseApply();
    await seed;

    expect(target.store.get(ITEM.id)?.value).toBe(2);
    expect(target.applyAttempts).toBeGreaterThanOrEqual(2);
  });

  it("repairs a rejected live delta from the authoritative Y.Doc", async () => {
    const { a, b } = pair();
    const source = new FakeBridge([ITEM]);
    const target = new FakeBridge();
    await createReconciler(a, source).seed();
    await createReconciler(b, target).seed();
    const attemptsAfterSeed = target.applyAttempts;
    target.rejectNextApply = true;

    a.getMap<Y.Map<unknown>>("items").get(ITEM.id)!.set("value", 3);

    await vi.waitFor(() => expect(target.store.get(ITEM.id)?.value).toBe(3));
    expect(target.applyAttempts - attemptsAfterSeed).toBeGreaterThanOrEqual(2);
  });

  it("coalesces a remote transaction storm while native projection is parked", async () => {
    const { a, b } = pair();
    const source = new FakeBridge([ITEM]);
    const target = new FakeBridge();
    await createReconciler(a, source).seed();
    await createReconciler(b, target).seed();
    const attemptsAfterSeed = target.applyAttempts;

    let releaseApply!: () => void;
    let markApplyEntered!: () => void;
    const applyEntered = new Promise<void>((resolve) => {
      markApplyEntered = resolve;
    });
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const originalApply = target.apply.bind(target);
    let parkNextApply = true;
    target.apply = async (json: string) => {
      if (parkNextApply) {
        parkNextApply = false;
        markApplyEntered();
        await applyGate;
      }
      await originalApply(json);
    };

    const sourceItem = a.getMap<Y.Map<unknown>>("items").get(ITEM.id)!;
    sourceItem.set("value", 2);
    await applyEntered;
    for (let value = 3; value <= 1_002; value++) {
      sourceItem.set("value", value);
    }
    releaseApply();

    await vi.waitFor(() => expect(target.store.get(ITEM.id)?.value).toBe(1_002));
    // The parked incremental apply plus one authoritative catch-up is bounded;
    // no closure is retained for each of the 1,000 later transactions.
    expect(target.applyAttempts - attemptsAfterSeed).toBeLessThanOrEqual(3);
  });

  it("retries owner backpressure but stops permanently after scheduler shutdown", async () => {
    const { a, b } = pair();
    const source = new FakeBridge([ITEM]);
    const target = new FakeBridge();
    await createReconciler(a, source).seed();
    const binding = createReconciler(b, target);
    await binding.seed();
    vi.useFakeTimers();

    const originalApply = target.apply.bind(target);
    let full = true;
    target.apply = (json) => {
      if (full) {
        target.applyAttempts++;
        return Promise.reject(backpressureError());
      }
      return originalApply(json);
    };
    const attemptsAfterSeed = target.applyAttempts;
    const sourceItem = a.getMap<Y.Map<unknown>>("items").get(ITEM.id)!;
    sourceItem.set("value", 4);
    await flushMicrotasks();

    expect(target.applyAttempts - attemptsAfterSeed).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    full = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(target.store.get(ITEM.id)?.value).toBe(4);

    const shutdown = new Error("[wx-scheduler] shutdown: application is dead");
    target.apply = () => {
      target.applyAttempts++;
      return Promise.reject(shutdown);
    };
    sourceItem.set("value", 5);
    await flushMicrotasks();
    const attemptsAfterShutdown = target.applyAttempts;
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    sourceItem.set("value", 6);
    await flushMicrotasks();
    expect(target.applyAttempts).toBe(attemptsAfterShutdown);
    binding.destroy();
  });

  it("opens a finite circuit for an unknown permanent projection failure", async () => {
    const { a, b } = pair();
    const source = new FakeBridge([ITEM]);
    const target = new FakeBridge();
    await createReconciler(a, source).seed();
    const binding = createReconciler(b, target);
    await binding.seed();
    vi.useFakeTimers();

    target.apply = () => {
      target.applyAttempts++;
      return Promise.reject(new Error("permanent projection failure"));
    };
    const sourceItem = a.getMap<Y.Map<unknown>>("items").get(ITEM.id)!;
    sourceItem.set("value", 7);
    await flushMicrotasks();
    await vi.runAllTimersAsync();

    const attemptsAtOpenCircuit = target.applyAttempts;
    expect(attemptsAtOpenCircuit).toBeLessThan(20);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(target.applyAttempts).toBe(attemptsAtOpenCircuit);

    // A genuinely newer source transaction gets one new bounded retry series.
    sourceItem.set("value", 8);
    await flushMicrotasks();
    expect(target.applyAttempts).toBeGreaterThan(attemptsAtOpenCircuit);
    expect(vi.getTimerCount()).toBe(1);
    binding.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
