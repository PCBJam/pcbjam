import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createThread, setThreadAnchor } from "@pcbjam/shared";
import { createComments, type CommentPinsModule } from "./comments";

// repro for W-1 (findings group W / security audit v3 #11): the pins bridge
// must never hand the wasm a `null` coordinate. JSON.stringify turns
// Infinity/NaN into null; the C++ consumer (collab_presence_core.h setPins,
// nlohmann `.value("x", 0.0)`) throws type_error.302 on a PRESENT null — the
// throw crosses embind as a JS exception at the pushPins call site (boot path
// = attachCollabAndPresence, live path = the throttled timer).
function stubMod(): CommentPinsModule & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    kicadCollabSetPins(json) {
      calls.push(json);
      // Mirror the C++ behaviour: a present null coordinate throws.
      const parsed = JSON.parse(json) as { pins: Array<{ x: unknown; y: unknown }> };
      for (const p of parsed.pins) {
        if (typeof p.x !== "number" || typeof p.y !== "number") {
          throw new Error("type_error.302 type must be number, but is null");
        }
      }
    },
    kicadCollabSetViewport() {},
    kicadCollabGetViewport: () => JSON.stringify({ scale: 1, cx: 0, cy: 0, w: 100, h: 100 }),
  };
}

describe("W-1 comment pins bridge with non-finite anchors", () => {
  it("boot push does not throw and never serializes null coordinates", () => {
    const doc = new Y.Doc();
    const good = createThread(doc, { anchor: { pos: { x: 10, y: 20 } }, author: "a", body: "ok", now: 1 });
    const bad = createThread(doc, { anchor: { pos: { x: 1, y: 1 } }, author: "b", body: "bad", now: 2 });
    // NOTE: NaN is already rejected by z.number() (thread dropped whole); Infinity
    // passes z.number() — that is the live hole.
    setThreadAnchor(doc, bad, { pos: { x: Infinity, y: -Infinity } });

    const mod = stubMod();
    let ctl: ReturnType<typeof createComments> | undefined;
    expect(() => {
      ctl = createComments({ doc, mod, user: { id: "me" }, tool: "pcbnew" });
    }).not.toThrow();

    expect(mod.calls.length).toBeGreaterThan(0);
    const last = JSON.parse(mod.calls.at(-1)!) as { pins: Array<{ id: string; x: number; y: number }> };
    // The healthy thread still gets its pin; the poisoned one is dropped (or
    // clamped) — either way no null reaches the wasm.
    expect(last.pins.some((p) => p.id === good)).toBe(true);
    for (const p of last.pins) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
    ctl?.destroy();
  });

  it("live push (poison arrives after bind) does not throw out of the timer", async () => {
    const doc = new Y.Doc();
    const t = createThread(doc, { anchor: { pos: { x: 10, y: 20 } }, author: "a", body: "ok", now: 1 });
    const mod = stubMod();
    const ctl = createComments({ doc, mod, user: { id: "me" }, tool: "pcbnew" });
    const before = mod.calls.length;

    const unhandled: unknown[] = [];
    const onErr = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", onErr);
    try {
      setThreadAnchor(doc, t, { pos: { x: Infinity, y: 0 } });
      await new Promise((r) => setTimeout(r, 80)); // > PUSH_THROTTLE_MS
    } finally {
      process.off("uncaughtException", onErr);
    }
    expect(unhandled).toEqual([]);
    expect(mod.calls.length).toBeGreaterThan(before);
    ctl.destroy();
  });
});
