/**
 * Mouse-move watch. A person saw the crosshair stop following the mouse after their first click,
 * while clicks and wheel ticks still moved it: Firefox (an extension in that profile, it turned
 * out) stopped delivering mouse moves to the page until the window lost and regained focus, and
 * nothing in the editor could tell. A real mouse can't get somewhere new without moving, so a
 * press or wheel tick far from the last move, with no move since, is a "teleport". Three in a row
 * log one console line; more than {@link TOAST_TELEPORTS} within a minute show one toast.
 */

/** A press this far from the last move (CSS px) didn't get there by moving. */
export const TELEPORT_PX = 20;
/** Teleports in a row before the console line. */
export const LOG_STREAK = 3;
/** More teleports than this within {@link TOAST_WINDOW_MS}: the toast. */
export const TOAST_TELEPORTS = 10;
export const TOAST_WINDOW_MS = 60_000;

export interface TeleportVerdict {
  /** Log the console line now (once per page). */
  log: boolean;
  /** Show the toast now (once per page). */
  toast: boolean;
}

/** The counting, without the DOM: feed it moves, presses and focus changes. */
export class TeleportCounter {
  private last: { x: number; y: number } | null = null;
  private streak = 0;
  private recent: number[] = [];
  private logged = false;
  private toasted = false;

  /** The browser sent a move: the pointer is here, and the streak ends. */
  move(x: number, y: number): void {
    this.last = { x, y };
    this.streak = 0;
  }

  /** The window lost or got focus: where the pointer went meanwhile is unknown. */
  reset(): void {
    this.last = null;
    this.streak = 0;
  }

  /** A press or wheel tick at (x, y), at time `t` (ms). */
  press(x: number, y: number, t: number): TeleportVerdict {
    const from = this.last;
    this.last = { x, y };
    if (!from || Math.hypot(x - from.x, y - from.y) <= TELEPORT_PX) return { log: false, toast: false };

    this.streak++;
    this.recent = this.recent.filter((r) => t - r < TOAST_WINDOW_MS);
    this.recent.push(t);
    const log = !this.logged && this.streak >= LOG_STREAK;
    const toast = !this.toasted && this.recent.length > TOAST_TELEPORTS;
    if (log) this.logged = true;
    if (toast) this.toasted = true;
    return { log, toast };
  }
}

/** Start watching the page; `onToast` shows the toast. Returns the stop. */
export function startInputWatch(opts: { onToast: () => void }): () => void {
  const counter = new TeleportCounter();
  const moved = (e: MouseEvent) => counter.move(e.clientX, e.clientY);
  const pressed = (e: MouseEvent) => {
    // Our own synthetic events (the touch-gesture shim) aren't the browser's.
    if (!e.isTrusted || (e instanceof PointerEvent && e.pointerType !== "mouse")) return;
    const verdict = counter.press(e.clientX, e.clientY, e.timeStamp);
    if (verdict.log) {
      console.warn(
        `[input] the browser stopped sending mouse moves to this page: ${LOG_STREAK} clicks or wheel ticks in a row landed away from the last move. ` +
          "The crosshair won't follow the mouse. A browser extension can cause this; switching to another window and back resets it.",
      );
    }
    if (verdict.toast) opts.onToast();
  };
  // The window's own focus change only: in the capture phase every element's focus passes here
  // too, and a click focuses one right after its press.
  const reset = (e: Event) => {
    if (e.target === window) counter.reset();
  };
  const listeners: Array<[string, EventListener]> = [
    ["mousemove", moved as EventListener],
    ["pointermove", moved as EventListener],
    ["pointerdown", pressed as EventListener],
    ["wheel", pressed as EventListener],
    ["blur", reset],
    ["focus", reset],
  ];
  for (const [type, fn] of listeners) window.addEventListener(type, fn, { capture: true, passive: true });
  return () => {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, { capture: true });
  };
}
