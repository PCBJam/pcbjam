import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestOwnerProjection } from "./latest-owner-projection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("createLatestOwnerProjection", () => {
  it("keeps one active ticket and one recomputed latest level", async () => {
    let authoritative = 0;
    const tickets: Array<ReturnType<typeof deferred<void>> & { value: number }> = [];
    const applied: number[] = [];
    const projection = createLatestOwnerProjection({
      label: "test projection",
      snapshot: () => authoritative,
      submit: (value) => {
        const ticket = { ...deferred<void>(), value };
        tickets.push(ticket);
        return ticket.promise.then(() => applied.push(value));
      },
    });

    projection.request();
    expect(tickets.map((ticket) => ticket.value)).toEqual([0]);

    for (let i = 1; i <= 1_000; i++) {
      authoritative = i;
      projection.request();
    }
    expect(tickets).toHaveLength(1);

    tickets.shift()!.resolve();
    await vi.waitFor(() => expect(tickets).toHaveLength(1));
    expect(tickets[0]!.value).toBe(1_000);
    tickets.shift()!.resolve();
    await vi.waitFor(() => expect(applied).toEqual([0, 1_000]));
  });

  it("uses one fixed-rate retry while shared owner capacity is full", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const projection = createLatestOwnerProjection({
      label: "test projection",
      snapshot: () => "latest",
      submit: async () => {
        calls++;
        if (calls < 3) {
          throw Object.assign(new Error("full"), {
            code: "WX_MUTATOR_BACKPRESSURE",
            reason: "jobs",
            estimatedBytes: 12,
            maxBytes: 100,
          });
        }
      },
    });

    projection.request();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    for (let i = 0; i < 1_000; i++) projection.request();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates an admitted-but-not-started ticket on stop", async () => {
    let guard: (() => boolean) | undefined;
    const ticket = deferred<void>();
    const projection = createLatestOwnerProjection({
      label: "test projection",
      snapshot: () => "old",
      submit: (_value, isCurrent) => {
        guard = isCurrent;
        return ticket.promise;
      },
    });

    projection.request();
    expect(guard?.()).toBe(true);
    projection.stop();
    expect(guard?.()).toBe(false);
    ticket.resolve();
    await ticket.promise;
  });

  it.each(["synchronous", "asynchronous"] as const)(
    "absorbs a %s terminal failure across a later request storm",
    async (delivery) => {
      vi.useFakeTimers();
      const terminal = Object.assign(
        new Error("[wx-scheduler] shutdown: application is dead"),
        { code: "WX_NATIVE_ENTRY_ABANDONED" },
      );
      const report = vi.fn();
      let calls = 0;
      let firstGuard: (() => boolean) | undefined;
      const projection = createLatestOwnerProjection({
        label: "terminal projection",
        snapshot: () => "current",
        submit: (_value, isCurrent) => {
          calls++;
          firstGuard ??= isCurrent;
          if (delivery === "synchronous") throw terminal;
          return Promise.reject(terminal);
        },
        report,
      });

      projection.request();
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(firstGuard?.()).toBe(false);

      for (let i = 0; i < 1_000; i++) projection.request();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(calls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(report).toHaveBeenCalledTimes(1);

      // The latch belongs to this projection/resource lifetime, not a global
      // singleton. A newly constructed native lifetime can submit normally.
      let replacementCalls = 0;
      const replacement = createLatestOwnerProjection({
        label: "replacement projection",
        snapshot: () => "replacement",
        submit: async () => {
          replacementCalls++;
        },
      });
      replacement.request();
      await Promise.resolve();
      await Promise.resolve();
      expect(replacementCalls).toBe(1);
    },
  );
});
