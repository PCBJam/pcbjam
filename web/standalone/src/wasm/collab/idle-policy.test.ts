import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleMonitor, type IdlePhase, type VisibilitySource } from "./idle-policy";

/** A scriptable `document.visibilityState`. */
class FakeVisibility implements VisibilitySource {
  visibilityState: "visible" | "hidden" = "visible";
  private listeners = new Set<() => void>();
  addEventListener(_t: "visibilitychange", cb: () => void): void {
    this.listeners.add(cb);
  }
  removeEventListener(_t: "visibilitychange", cb: () => void): void {
    this.listeners.delete(cb);
  }
  set(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    for (const cb of this.listeners) cb();
  }
}

describe("idle monitor (do-observability 0001 §B)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hidden → away after awayAfterMs → suspended after suspendAfterMs; visible → active", () => {
    const vis = new FakeVisibility();
    const mon = createIdleMonitor(vis, { awayAfterMs: 1_000, suspendAfterMs: 5_000 });
    const phases: IdlePhase[] = [];
    mon.subscribe((p) => phases.push(p));
    expect(phases).toEqual(["active"]); // current phase on subscribe

    vis.set("hidden");
    vi.advanceTimersByTime(999);
    expect(mon.phase()).toBe("active");
    vi.advanceTimersByTime(1);
    expect(mon.phase()).toBe("away");
    vi.advanceTimersByTime(3_999);
    expect(mon.phase()).toBe("away");
    vi.advanceTimersByTime(1);
    expect(mon.phase()).toBe("suspended");

    vis.set("visible");
    expect(mon.phase()).toBe("active");
    expect(phases).toEqual(["active", "away", "suspended", "active"]);
    mon.destroy();
  });

  it("a short hide/show round trip changes nothing", () => {
    const vis = new FakeVisibility();
    const mon = createIdleMonitor(vis, { awayAfterMs: 1_000, suspendAfterMs: 5_000 });
    const phases: IdlePhase[] = [];
    mon.subscribe((p) => phases.push(p));
    vis.set("hidden");
    vi.advanceTimersByTime(500);
    vis.set("visible");
    vi.advanceTimersByTime(10_000);
    expect(phases).toEqual(["active"]);
    expect(vi.getTimerCount()).toBe(0);
    mon.destroy();
  });

  it("decides by elapsed time, so a throttled (late) timer jumps straight to suspended", () => {
    const vis = new FakeVisibility();
    let now = 0;
    const mon = createIdleMonitor(vis, { awayAfterMs: 1_000, suspendAfterMs: 5_000 }, () => now);
    const phases: IdlePhase[] = [];
    mon.subscribe((p) => phases.push(p));
    vis.set("hidden");
    // The tab was throttled: the first timer fires after 6 s of wall time.
    now = 6_000;
    vi.advanceTimersByTime(1_000);
    expect(phases).toEqual(["active", "suspended"]);
    mon.destroy();
  });

  it("starts in the right phase when created on an already-hidden document", () => {
    const vis = new FakeVisibility();
    vis.visibilityState = "hidden";
    const mon = createIdleMonitor(vis, { awayAfterMs: 1_000, suspendAfterMs: 5_000 });
    expect(mon.phase()).toBe("active");
    vi.advanceTimersByTime(1_000);
    expect(mon.phase()).toBe("away");
    mon.destroy();
  });

  it("destroy detaches the listener and timers", () => {
    const vis = new FakeVisibility();
    const mon = createIdleMonitor(vis, { awayAfterMs: 1_000, suspendAfterMs: 5_000 });
    vis.set("hidden");
    mon.destroy();
    vi.advanceTimersByTime(10_000);
    expect(mon.phase()).toBe("active");
    expect(vi.getTimerCount()).toBe(0);
  });
});
