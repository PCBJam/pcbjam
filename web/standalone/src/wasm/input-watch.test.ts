import { describe, expect, it } from "vitest";
import { LOG_STREAK, TELEPORT_PX, TOAST_TELEPORTS, TOAST_WINDOW_MS, TeleportCounter } from "./input-watch";

/** Presses that each land 100 px right of the one before, `every` ms apart. */
function teleports(c: TeleportCounter, n: number, start = 0, every = 1000) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(c.press(100 * (i + 1), 0, start + i * every));
  return out;
}

describe("teleport counter", () => {
  it("a press where the pointer moved to is no teleport", () => {
    const c = new TeleportCounter();
    for (let i = 0; i < 20; i++) {
      c.move(i * 100, 50);
      expect(c.press(i * 100 + TELEPORT_PX, 50, i)).toEqual({ log: false, toast: false });
    }
  });

  it("logs once after a streak of presses away from the last move", () => {
    const c = new TeleportCounter();
    c.move(0, 0);
    const v = teleports(c, LOG_STREAK + 3);
    expect(v.map((x) => x.log)).toEqual([false, false, true, false, false, false]);
  });

  it("a move between presses ends the streak", () => {
    const c = new TeleportCounter();
    c.move(0, 0);
    teleports(c, LOG_STREAK - 1);
    c.move(5000, 0);
    expect(teleports(c, LOG_STREAK - 1, 10_000).some((x) => x.log)).toBe(false);
  });

  it("toasts once, after more than the limit within a minute", () => {
    const c = new TeleportCounter();
    c.move(0, 0);
    const v = teleports(c, TOAST_TELEPORTS + 5, 0, 1000);
    expect(v.findIndex((x) => x.toast)).toBe(TOAST_TELEPORTS); // the 11th
    expect(v.filter((x) => x.toast)).toHaveLength(1);
  });

  it("no toast when the teleports are spread over more than the window", () => {
    const c = new TeleportCounter();
    c.move(0, 0);
    const every = TOAST_WINDOW_MS / TOAST_TELEPORTS + 1;
    expect(teleports(c, TOAST_TELEPORTS * 3, 0, every).some((x) => x.toast)).toBe(false);
  });

  it("the first press after a window focus change is no teleport", () => {
    const c = new TeleportCounter();
    c.move(0, 0);
    c.reset();
    expect(c.press(900, 900, 0)).toEqual({ log: false, toast: false });
    expect(teleports(c, LOG_STREAK, 1)[LOG_STREAK - 1]!.log).toBe(true);
  });
});
