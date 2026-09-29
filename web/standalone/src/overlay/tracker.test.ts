import { describe, expect, it } from "vitest";
import { LOST_GRACE_MS, TargetTracker } from "./tracker";

const hit = { rect: { x: 0, y: 0, width: 10, height: 10 }, surface: "ui" as const };

describe("TargetTracker", () => {
  it("is pending until the grace period passes, then lost", () => {
    const t = new TargetTracker(1000);
    expect(t.update(1100, null).state).toBe("pending");
    expect(t.update(1000 + LOST_GRACE_MS, null).state).toBe("lost");
  });

  it("keeps the last rect through a short disappearance (toolbar repaint)", () => {
    const t = new TargetTracker(0);
    expect(t.update(10, hit)).toEqual({ target: hit, state: "found" });
    expect(t.update(20, null)).toEqual({ target: hit, state: "found" });
    expect(t.update(10 + LOST_GRACE_MS, null)).toEqual({ target: null, state: "lost" });
  });

  it("recovers after being lost", () => {
    const t = new TargetTracker(0);
    t.update(LOST_GRACE_MS * 2, null);
    expect(t.update(LOST_GRACE_MS * 3, hit).state).toBe("found");
  });
});
