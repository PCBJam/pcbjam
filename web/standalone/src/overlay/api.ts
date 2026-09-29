/**
 * The overlay's host-internal API and state store. One step on screen at a
 * time; `show` replaces whatever is up. Owners listen for button presses and
 * target changes through `on`. Rendering lives in OverlayHost; target
 * resolution in the tracker.
 */
import {
  ATTRIBUTION_MAX,
  TEXT_MAX,
  TITLE_MAX,
  type OverlayButton,
  type OverlayEvent,
  type OverlayEventType,
  type OverlayStep,
  type ResolvedTarget,
  type TargetState,
} from "./types";
import { subscribeTrustedPrompts, trustedPromptCount } from "./trusted-prompts";

export interface OverlayState {
  /** Increments per `show`; 0 = nothing shown yet. */
  id: number;
  step: OverlayStep | null;
  target: ResolvedTarget | null;
  targetState: TargetState;
  paused: boolean;
}

let state: OverlayState = { id: 0, step: null, target: null, targetState: "none", paused: false };
const subs = new Set<() => void>();
const listeners = new Map<OverlayEventType, Set<(e: OverlayEvent) => void>>();

function setState(patch: Partial<OverlayState>): void {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function emit(e: OverlayEvent): void {
  for (const cb of listeners.get(e.type) ?? []) {
    try {
      cb(e);
    } catch (err) {
      console.error("[overlay] listener failed:", err);
    }
  }
}

const cap = (s: string | undefined, n: number) =>
  s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Plain text only, length-capped; unknown buttons dropped, duplicates removed. */
export function sanitizeStep(step: OverlayStep): OverlayStep {
  const allowed: OverlayButton[] = ["back", "next", "skip"];
  const buttons = step.buttons ? allowed.filter((b) => step.buttons!.includes(b)) : undefined;
  const progress =
    step.progress &&
    Number.isInteger(step.progress.step) &&
    Number.isInteger(step.progress.of) &&
    step.progress.of > 0 &&
    step.progress.step >= 1 &&
    step.progress.step <= step.progress.of
      ? { step: step.progress.step, of: step.progress.of }
      : undefined;
  return {
    owner: step.owner,
    target: step.target || undefined,
    title: cap(step.title, TITLE_MAX),
    text: cap(step.text, TEXT_MAX) ?? "",
    placement: step.placement ?? "auto",
    spotlight: !!step.spotlight,
    pulse: !!step.pulse,
    buttons,
    progress,
    attribution: cap(step.attribution, ATTRIBUTION_MAX),
    lostText: cap(step.lostText, TEXT_MAX),
  };
}

export const overlay = {
  show(step: OverlayStep): { id: number } {
    const prev = state;
    if (prev.step) emit({ type: "cleared", id: prev.id, owner: prev.step.owner, reason: "replaced" });
    const id = prev.id + 1;
    const clean = sanitizeStep(step);
    setState({
      id,
      step: clean,
      target: null,
      targetState: clean.target ? "pending" : "none",
      paused: trustedPromptCount() > 0,
    });
    emit({ type: "shown", id, owner: clean.owner });
    return { id };
  },

  /** Clear the current step — only if `owner` matches (when given). */
  clear(owner?: string, reason: "owner" | "user" | "unmount" = "owner"): boolean {
    const { step, id } = state;
    if (!step || (owner !== undefined && step.owner !== owner)) return false;
    setState({ step: null, target: null, targetState: "none" });
    emit({ type: "cleared", id, owner: step.owner, reason });
    return true;
  },

  on<T extends OverlayEventType>(type: T, cb: (e: Extract<OverlayEvent, { type: T }>) => void): () => void {
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    const fn = cb as (e: OverlayEvent) => void;
    set.add(fn);
    return () => set!.delete(fn);
  },

  getState(): OverlayState {
    return state;
  },
};

/** Card button → owners. Close is the user's: it clears the step too. */
export function pressButton(button: OverlayButton | "close"): void {
  const { step, id } = state;
  if (!step) return;
  if (button === "close") {
    overlay.clear(undefined, "user");
    return;
  }
  emit({ type: "button", id, owner: step.owner, button });
}

/** Tracker → store. Emits found/lost on transitions only. */
export function setResolvedTarget(id: number, target: ResolvedTarget | null, targetState: TargetState): void {
  if (id !== state.id || !state.step) return;
  const prev = state.targetState;
  const same =
    prev === targetState &&
    state.target?.surface === target?.surface &&
    state.target?.rect.x === target?.rect.x &&
    state.target?.rect.y === target?.rect.y &&
    state.target?.rect.width === target?.rect.width &&
    state.target?.rect.height === target?.rect.height;
  if (same) return;
  setState({ target, targetState });
  if (prev !== "found" && targetState === "found") emit({ type: "targetFound", id, owner: state.step.owner });
  if (prev !== "lost" && targetState === "lost") emit({ type: "targetLost", id, owner: state.step.owner });
}

export function subscribeOverlay(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getOverlayState(): OverlayState {
  return state;
}

subscribeTrustedPrompts(() => {
  const paused = trustedPromptCount() > 0;
  if (paused === state.paused) return;
  setState({ paused });
  if (state.step) emit({ type: paused ? "paused" : "resumed", id: state.id, owner: state.step.owner });
});

/** Tests: drop the step and every listener. */
export function __resetOverlayForTests(): void {
  state = { id: 0, step: null, target: null, targetState: "none", paused: trustedPromptCount() > 0 };
  listeners.clear();
  for (const cb of subs) cb();
}
