/**
 * Keeps the shown step's target resolved while — and only while — a step
 * with a target is on screen: one requestAnimationFrame loop that
 * re-resolves when something that can move the target changed (registry
 * versions, viewport version, window size, `#canvas` origin), every frame for
 * DOM targets, and at least every SAFETY_MS regardless.
 *
 * A target that disappears keeps its last rect for LOST_GRACE_MS before the
 * step reports `lost`: a toolbar repaint unregisters all of its tools and
 * re-registers them (auibar.cpp), which must not flicker the card.
 */
import { getViewportVersion, subscribeViewport } from "@/wasm/viewport-store";
import { getOverlayState, setResolvedTarget, subscribeOverlay } from "./api";
import { parseTarget } from "./targets/parse";
import { resolveParsed, targetDependsOn } from "./targets/resolve";
import type { ResolvedTarget, TargetState } from "./types";

export const LOST_GRACE_MS = 500;
const SAFETY_MS = 250;

/** The found/pending/lost state machine, separated from the DOM for tests. */
export class TargetTracker {
  private lastSeenAt: number | null = null;
  private last: ResolvedTarget | null = null;

  constructor(private readonly startedAt: number) {}

  update(now: number, resolved: ResolvedTarget | null): { target: ResolvedTarget | null; state: TargetState } {
    if (resolved) {
      this.lastSeenAt = now;
      this.last = resolved;
      return { target: resolved, state: "found" };
    }
    const since = this.lastSeenAt ?? this.startedAt;
    if (now - since < LOST_GRACE_MS) {
      return { target: this.last, state: this.last ? "found" : "pending" };
    }
    this.last = null;
    return { target: null, state: "lost" };
  }
}

function signature(deps: ReturnType<typeof targetDependsOn>): string {
  const parts: (string | number)[] = [window.innerWidth, window.innerHeight];
  if (deps.registry) {
    const reg = window.wxElementRegistry;
    const origin = document.getElementById("canvas")?.getBoundingClientRect();
    parts.push(reg?.version ?? 0, reg?.renderedVersion ?? 0, origin?.left ?? 0, origin?.top ?? 0);
  }
  if (deps.viewport) parts.push(getViewportVersion());
  return parts.join("|");
}

/**
 * Wire the tracker to the overlay store. Returns a disposer. Idle (no step,
 * or a step without a target) costs nothing: no frame loop, no viewport poll.
 */
export function startOverlayTracking(): () => void {
  let raf = 0;
  let loopFor = -1;
  let offViewport: (() => void) | null = null;

  const stopLoop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    loopFor = -1;
    offViewport?.();
    offViewport = null;
  };

  const startLoop = (id: number, target: string) => {
    stopLoop();
    loopFor = id;
    const parsed = parseTarget(target);
    const tracker = new TargetTracker(performance.now());
    if (!parsed) {
      setResolvedTarget(id, null, "lost");
      return;
    }
    const deps = targetDependsOn(parsed);
    if (deps.viewport) offViewport = subscribeViewport(() => {});
    let lastSig = "";
    let lastResolveAt = -Infinity;

    const frame = (now: number) => {
      if (loopFor !== id) return;
      const sig = signature(deps);
      const cur = getOverlayState();
      const settling = cur.targetState !== "found" || cur.target === null;
      if (deps.dom || sig !== lastSig || settling || now - lastResolveAt >= SAFETY_MS) {
        lastSig = sig;
        lastResolveAt = now;
        let resolved: ResolvedTarget | null = null;
        try {
          resolved = resolveParsed(parsed);
        } catch (err) {
          console.error("[overlay] resolve failed:", err);
        }
        const r = tracker.update(now, resolved);
        setResolvedTarget(id, r.target, r.state);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };

  const sync = () => {
    const { id, step } = getOverlayState();
    if (!step?.target) {
      if (loopFor !== -1) stopLoop();
      return;
    }
    if (loopFor !== id) startLoop(id, step.target);
  };

  const off = subscribeOverlay(sync);
  sync();
  return () => {
    off();
    stopLoop();
  };
}
