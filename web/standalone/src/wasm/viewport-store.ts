import type { ViewportState } from "./collab/comments";

/**
 * The GAL viewport transform as a fan-out store (the local-selection pattern),
 * for DOM layers that follow the canvas outside the comment layer — the
 * overlay system's canvas targets (overlay-system 0002 M0).
 *
 * Two feeds:
 *   - push: the presence bridge's `onViewport` (collab/edit sessions) calls
 *     `publishViewport`. `window.kicadCollab.onViewport` has ONE slot, owned by
 *     presence — this store never installs its own handler.
 *   - pull: sessions without the bridge (solo, read-only) get no pushes, so
 *     while anyone is subscribed and no push arrived recently, a poller reads
 *     `Module.kicadCollabGetViewport()`. No subscribers → no timer.
 */

const POLL_MS = 100;
/** A push this recent means the presence feed is live; skip the pull. */
const PUSH_FRESH_MS = 1000;

let current: ViewportState | null = null;
let version = 0;
let lastPushAt = -Infinity;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

type ViewportSource = () => string | null | undefined;

const engineSource: ViewportSource = () => {
  const mod = (globalThis as { Module?: { kicadCollabGetViewport?: () => string } }).Module;
  return mod?.kicadCollabGetViewport?.();
};
let source: ViewportSource = engineSource;

function sameViewport(a: ViewportState | null, b: ViewportState): boolean {
  return !!a && a.cx === b.cx && a.cy === b.cy && a.scale === b.scale && a.w === b.w && a.h === b.h;
}

function set(vp: ViewportState): void {
  if (sameViewport(current, vp)) return;
  current = vp;
  version++;
  for (const cb of subs) cb();
}

/** Parse a `kicadCollabGetViewport` JSON string; null when absent or invalid. */
export function parseViewport(raw: string | null | undefined): ViewportState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ViewportState> | null;
    if (!v) return null;
    const { cx, cy, scale, w, h } = v;
    if (![cx, cy, scale, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if ((w as number) <= 0 || (h as number) <= 0 || (scale as number) <= 0) return null;
    return { cx: cx!, cy: cy!, scale: scale!, w: w!, h: h! };
  } catch {
    return null;
  }
}

/** Push feed (presence `onViewport`, the comments seed). */
export function publishViewport(vp: ViewportState, now: number = Date.now()): void {
  lastPushAt = now;
  set(vp);
}

/** One pull from the engine, unless the push feed is fresh. */
export function pullViewport(now: number = Date.now()): void {
  if (now - lastPushAt < PUSH_FRESH_MS) return;
  let raw: string | null | undefined;
  try {
    raw = source();
  } catch {
    return; // frame not up yet / engine busy — the next tick retries
  }
  const vp = parseViewport(raw);
  if (vp) set(vp);
}

/** `useSyncExternalStore` pair. */
export function subscribeViewport(cb: () => void): () => void {
  subs.add(cb);
  if (!timer) {
    pullViewport();
    timer = setInterval(() => pullViewport(), POLL_MS);
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function getViewport(): ViewportState | null {
  return current;
}

/** Bumped on every change — cheap dirty check for rAF loops. */
export function getViewportVersion(): number {
  return version;
}

/** Tests: replace the engine read (null restores it) and reset the store. */
export function __setViewportSourceForTests(fn: ViewportSource | null): void {
  source = fn ?? engineSource;
  current = null;
  version = 0;
  lastPushAt = -Infinity;
}
