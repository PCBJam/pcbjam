import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChromeVisibilityProjection,
  type ChromeSetter,
} from "./chrome-visibility-owner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("createChromeVisibilityProjection", () => {
  it("corrects an admitted hide after the latest intent returns to shown", async () => {
    const tickets: Array<ReturnType<typeof deferred<boolean>>> = [];
    const shows: boolean[] = [];
    const setChrome: ChromeSetter = (show) => {
      shows.push(show);
      const ticket = deferred<boolean>();
      tickets.push(ticket);
      return ticket.promise;
    };
    const projection = createChromeVisibilityProjection({ setChrome });

    projection.setHidden(true);
    projection.setHidden(false);
    expect(shows).toEqual([false]);

    // The old accepted ticket really hid the frame. Its completion must not
    // mark the newer "shown" intent as complete; one corrective ticket follows.
    tickets[0]!.resolve(true);
    await flushMicrotasks();
    expect(shows).toEqual([false, true]);

    tickets[1]!.resolve(true);
    await tickets[1]!.promise;
    projection.stop();
  });

  it("invalidates queued work and does not continue after stop", async () => {
    const ticket = deferred<boolean>();
    let admissionGuard: (() => boolean) | undefined;
    const setChrome = (() => ticket.promise) as ChromeSetter;
    setChrome.__wxGuardedCall = (_args, isCurrent) => {
      admissionGuard = isCurrent;
      return ticket.promise;
    };
    const projection = createChromeVisibilityProjection({ setChrome });

    projection.setHidden(true);
    expect(admissionGuard?.()).toBe(true);
    projection.stop();
    expect(admissionGuard?.()).toBe(false);

    ticket.resolve(true);
    await ticket.promise;
    await Promise.resolve();
    expect(admissionGuard?.()).toBe(false);
  });

  it("cancels its sole frame-readiness retry on stop", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const setChrome: ChromeSetter = async () => {
      calls++;
      return false;
    };
    const projection = createChromeVisibilityProjection({ setChrome });

    projection.setHidden(true);
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    projection.stop();
    expect(vi.getTimerCount()).toBe(0);
    await flushMicrotasks();
    expect(calls).toBe(1);
  });
});
