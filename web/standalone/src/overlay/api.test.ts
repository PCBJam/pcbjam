import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetOverlayForTests, overlay, pressButton, sanitizeStep, setResolvedTarget } from "./api";
import { openTrustedPrompt } from "./trusted-prompts";
import { TEXT_MAX, type OverlayEvent } from "./types";

const rect = { x: 1, y: 2, width: 3, height: 4 };

describe("overlay api", () => {
  let events: OverlayEvent[];
  beforeEach(() => {
    __resetOverlayForTests();
    events = [];
    for (const t of ["shown", "cleared", "button", "targetFound", "targetLost", "paused", "resumed"] as const) {
      overlay.on(t, (e) => events.push(e));
    }
  });
  afterEach(() => __resetOverlayForTests());

  it("sanitizes steps: caps text, drops unknown buttons, validates progress", () => {
    const s = sanitizeStep({
      owner: "t",
      text: "x".repeat(TEXT_MAX + 50),
      buttons: ["next", "close" as never, "back", "next"],
      progress: { step: 4, of: 3 },
    });
    expect(s.text.length).toBe(TEXT_MAX);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.buttons).toEqual(["back", "next"]);
    expect(s.progress).toBeUndefined();
    expect(s.placement).toBe("auto");
  });

  it("replaces the current step and reports it", () => {
    const a = overlay.show({ owner: "a", text: "one", target: "panel:x" });
    const b = overlay.show({ owner: "b", text: "two" });
    expect(b.id).toBe(a.id + 1);
    expect(events.map((e) => e.type)).toEqual(["shown", "cleared", "shown"]);
    expect(events[1]).toMatchObject({ owner: "a", reason: "replaced" });
    expect(overlay.getState().targetState).toBe("none");
  });

  it("clears only for the matching owner", () => {
    overlay.show({ owner: "a", text: "one" });
    expect(overlay.clear("b")).toBe(false);
    expect(overlay.clear("a")).toBe(true);
    expect(overlay.getState().step).toBeNull();
  });

  it("routes buttons to owners and treats close as the user's clear", () => {
    overlay.show({ owner: "a", text: "one", buttons: ["next"] });
    pressButton("next");
    pressButton("close");
    expect(events.slice(1).map((e) => e.type)).toEqual(["button", "cleared"]);
    expect(events[2]).toMatchObject({ reason: "user" });
  });

  it("emits found/lost on transitions only and ignores stale ids", () => {
    const { id } = overlay.show({ owner: "a", text: "one", target: "panel:x" });
    setResolvedTarget(id, { rect, surface: "ui" }, "found");
    setResolvedTarget(id, { rect, surface: "ui" }, "found");
    setResolvedTarget(id, null, "lost");
    setResolvedTarget(id - 1, { rect, surface: "ui" }, "found");
    expect(events.slice(1).map((e) => e.type)).toEqual(["targetFound", "targetLost"]);
  });

  it("pauses while a trusted prompt is open", () => {
    overlay.show({ owner: "a", text: "one" });
    const release = openTrustedPrompt();
    expect(overlay.getState().paused).toBe(true);
    release();
    release(); // idempotent
    expect(overlay.getState().paused).toBe(false);
    expect(events.slice(1).map((e) => e.type)).toEqual(["paused", "resumed"]);
  });

  it("starts paused when shown under an open prompt", () => {
    const release = openTrustedPrompt();
    overlay.show({ owner: "a", text: "one" });
    expect(overlay.getState().paused).toBe(true);
    release();
  });

  it("keeps a throwing listener from breaking the others", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    overlay.on("shown", () => {
      throw new Error("boom");
    });
    overlay.show({ owner: "a", text: "one" });
    expect(events.map((e) => e.type)).toEqual(["shown"]);
    spy.mockRestore();
  });
});
