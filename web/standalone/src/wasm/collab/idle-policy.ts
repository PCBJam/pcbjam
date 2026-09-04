/**
 * Hidden-tab policy (do-observability 0001 §B): a tab nobody is looking at
 * should look idle to peers, and after a long absence it should hold no
 * connection at all.
 *
 * Timeline after `visibilitychange` → hidden:
 *   awayAfterMs    → `away`    (presence publishes `away: true`, one frame)
 *   suspendAfterMs → `suspend` (the gateway socket closes; no reconnect)
 * and on visible: `back` (away cleared) / `resume` (socket re-dialed) as
 * applicable.
 *
 * Timers use `Date.now()` deltas, not tick counts: hidden-tab timers are
 * throttled (Chrome: ≥ 1/min after 5 min), so a `setTimeout` may fire late
 * — never early — and the elapsed check decides.
 *
 * One monitor per document (module singleton); subscribers get the current
 * phase on subscribe so late joiners (a room warmed while hidden) agree.
 * Thresholds can be overridden through `window.PCBJAM_IDLE_POLICY` — the
 * e2e smoke uses that to compress the timeline.
 */

export type IdlePhase = "active" | "away" | "suspended";

export interface IdlePolicyOpts {
  awayAfterMs: number;
  suspendAfterMs: number;
}

export const DEFAULT_IDLE_POLICY: IdlePolicyOpts = {
  awayAfterMs: 60_000,
  suspendAfterMs: 15 * 60_000,
};

/** The subset of `document` the monitor needs (tests pass a fake). */
export interface VisibilitySource {
  readonly visibilityState: "visible" | "hidden" | string;
  addEventListener(type: "visibilitychange", cb: () => void): void;
  removeEventListener(type: "visibilitychange", cb: () => void): void;
}

export interface IdleMonitor {
  phase(): IdlePhase;
  /** Fires on every phase change; also called immediately with the current phase. */
  subscribe(cb: (phase: IdlePhase) => void): () => void;
  destroy(): void;
}

export function createIdleMonitor(
  source: VisibilitySource,
  opts: Partial<IdlePolicyOpts> = {},
  now: () => number = () => Date.now(),
): IdleMonitor {
  const policy: IdlePolicyOpts = { ...DEFAULT_IDLE_POLICY, ...opts };
  let phase: IdlePhase = "active";
  let hiddenAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs = new Set<(phase: IdlePhase) => void>();

  const setPhase = (next: IdlePhase): void => {
    if (next === phase) return;
    phase = next;
    for (const cb of subs) cb(next);
  };

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  // Re-arm for the next threshold; fires late under throttling, decides by
  // elapsed time, and re-arms itself if it woke early (it never should).
  const schedule = (): void => {
    clearTimer();
    if (hiddenAt === null) return;
    const elapsed = now() - hiddenAt;
    const next =
      phase === "active"
        ? policy.awayAfterMs
        : phase === "away"
          ? policy.suspendAfterMs
          : null;
    if (next === null) return;
    timer = setTimeout(() => {
      timer = undefined;
      check();
    }, Math.max(0, next - elapsed));
  };

  const check = (): void => {
    if (hiddenAt === null) return;
    const elapsed = now() - hiddenAt;
    if (elapsed >= policy.suspendAfterMs) setPhase("suspended");
    else if (elapsed >= policy.awayAfterMs) setPhase("away");
    schedule();
  };

  const onVisibility = (): void => {
    if (source.visibilityState === "hidden") {
      if (hiddenAt === null) hiddenAt = now();
      check();
      return;
    }
    hiddenAt = null;
    clearTimer();
    setPhase("active");
  };

  source.addEventListener("visibilitychange", onVisibility);
  if (source.visibilityState === "hidden") onVisibility();

  return {
    phase: () => phase,
    subscribe(cb) {
      subs.add(cb);
      cb(phase);
      return () => subs.delete(cb);
    },
    destroy() {
      clearTimer();
      subs.clear();
      source.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

// --- the page singleton ------------------------------------------------------

type PolicyWindow = Window & {
  PCBJAM_IDLE_POLICY?: Partial<IdlePolicyOpts>;
  PCBJAM_IDLE_MONITOR?: IdleMonitor;
};

let singleton: IdleMonitor | null = null;

/** The document-wide monitor; a no-op stand-in outside a browser. */
export function idleMonitor(): IdleMonitor {
  if (singleton) return singleton;
  if (typeof document === "undefined" || typeof window === "undefined") {
    singleton = {
      phase: () => "active",
      subscribe(cb) {
        cb("active");
        return () => {};
      },
      destroy() {},
    };
    return singleton;
  }
  const override = (window as PolicyWindow).PCBJAM_IDLE_POLICY;
  singleton = createIdleMonitor(document, override ?? {});
  // Diagnostics handle (the smoke spec reads the phase through it).
  (window as PolicyWindow).PCBJAM_IDLE_MONITOR = singleton;
  return singleton;
}

/** Test hook: drop the singleton so the next call rebuilds it. */
export function resetIdleMonitorForTests(): void {
  singleton?.destroy();
  singleton = null;
}
