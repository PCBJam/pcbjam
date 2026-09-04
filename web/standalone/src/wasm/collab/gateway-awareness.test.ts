import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { createGatewayAwareness } from "./gateway-awareness";

/**
 * do-observability 0001 §A: the gateway awareness must be SILENT while idle.
 * Stock y-protocols renews the local state every ~15 s and emits `update`
 * for it — one frame per renewal, one Durable Object wake per frame.
 */

describe("createGatewayAwareness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never renews the local state on a timer", () => {
    // (No stock-Awareness control here: lib0 binds `Date.now` at import, so
    // fake timers cannot drive the stock renew clock. Its 15 s renewal is
    // documented in y-protocols/awareness.js and measured by the smoke spec.)
    let now = 1_000_000;
    const quiet = createGatewayAwareness(new Y.Doc(), { now: () => now });
    let updates = 0;
    quiet.on("update", () => updates++);
    quiet.setLocalState({ user: "a" });
    expect(updates).toBe(1);
    for (let i = 0; i < 40; i++) {
      now += 3_000;
      vi.advanceTimersByTime(3_000);
    }
    expect(updates).toBe(1);
    expect(quiet.getLocalState()).toEqual({ user: "a" });
    quiet.destroy();
  });

  it("a real local change still emits exactly one update", () => {
    const aw = createGatewayAwareness(new Y.Doc());
    const events: unknown[] = [];
    aw.on("update", (e: unknown) => events.push(e));
    aw.setLocalState({ cursor: 1 });
    aw.setLocalState({ cursor: 2 });
    aw.setLocalState(null);
    expect(events).toHaveLength(3);
    aw.destroy();
  });

  it("keeps remote states past the stock 30 s timeout, drops them after the safety expiry", () => {
    const peer = new Awareness(new Y.Doc());
    peer.setLocalState({ user: "peer" });
    const aw = createGatewayAwareness(new Y.Doc(), { expiryMs: 10 * 60_000, sweepMs: 30_000 });
    applyAwarenessUpdate(aw, encodeAwarenessUpdate(peer, [peer.clientID]), "remote");
    expect(aw.getStates().has(peer.clientID)).toBe(true);

    vi.advanceTimersByTime(5 * 60_000);
    expect(aw.getStates().has(peer.clientID)).toBe(true);

    const removed: number[][] = [];
    aw.on("update", ({ removed: r }: { removed: number[] }) => removed.push(r));
    vi.advanceTimersByTime(5 * 60_000 + 30_000);
    expect(aw.getStates().has(peer.clientID)).toBe(false);
    expect(removed.flat()).toEqual([peer.clientID]);

    peer.destroy();
    aw.destroy();
  });

  it("destroy() clears the replacement sweep", () => {
    const aw = createGatewayAwareness(new Y.Doc(), { sweepMs: 1_000 });
    aw.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
