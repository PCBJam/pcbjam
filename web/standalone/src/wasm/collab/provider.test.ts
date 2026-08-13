import { describe, expect, it, vi } from "vitest";
import { createSyncWaiter } from "./provider";

describe("createSyncWaiter", () => {
  it("cleans a subscription which reports sync synchronously", async () => {
    const cleanup = vi.fn();
    const waiter = createSyncWaiter(
      () => false,
      (onSynced) => {
        onSynced();
        return cleanup;
      },
    );

    await waiter.wait();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects a throwing subscription and removes its abort listener", async () => {
    const signal = new AbortController();
    const add = vi.spyOn(signal.signal, "addEventListener");
    const remove = vi.spyOn(signal.signal, "removeEventListener");
    const failure = new Error("subscribe failed");
    const waiter = createSyncWaiter(
      () => false,
      () => {
        throw failure;
      },
    );

    await expect(waiter.wait({ signal: signal.signal })).rejects.toBe(failure);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("detaches the exact wait on abort and destroy", async () => {
    const unsubscribe = vi.fn();
    const waiter = createSyncWaiter(() => false, () => unsubscribe);
    const abort = new AbortController();
    const waiting = waiter.wait({ signal: abort.signal });

    abort.abort(new DOMException("retired", "AbortError"));
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const second = waiter.wait();
    waiter.destroy();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("clears a settle timer when the wait is aborted", async () => {
    vi.useFakeTimers();
    const waiter = createSyncWaiter(
      () => false,
      (onSynced) => {
        const timer = setTimeout(onSynced, 300);
        return () => clearTimeout(timer);
      },
    );
    const abort = new AbortController();
    const waiting = waiter.wait({ signal: abort.signal });
    expect(vi.getTimerCount()).toBe(1);
    abort.abort(new DOMException("retired", "AbortError"));
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
