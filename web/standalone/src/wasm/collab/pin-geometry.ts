/**
 * Bubble-pin geometry (comments-ux 0001 A) — the TS mirror of the STYLE
 * values in pcbjam/wasm/bindings/collab_presence_style.h. GAL draws the
 * bubble; the DOM hit target, highlight and popover must sit on the drawn
 * body, so both sides need the same numbers.
 *
 * The radius is LIVE, not a constant: the PresenceTuner can re-style the GAL
 * pins at runtime (`kicadCollabSetStyle`), and the DOM must follow — it
 * pushes the current `pinRadiusPx` here, and CommentLayer subscribes. The
 * default matches the shipped C++ STYLE default; if the tuner-picked ship
 * value changes, change BOTH defaults together.
 *
 * Shape (figma-style): a round body whose bottom-left corner is squared off;
 * the SHARP CORNER is the anchored world point, so the body center sits at
 * anchor + (r, -r) in screen coords (y down).
 */

export const DEFAULT_PIN_RADIUS_PX = 9;

let radiusPx = DEFAULT_PIN_RADIUS_PX;
const listeners = new Set<() => void>();

/** Current bubble radius in canvas device px (GAL screen px). */
export function pinRadiusPx(): number {
  return radiusPx;
}

/** Follow a live GAL re-style (PresenceTuner). No-ops on bogus/same values. */
export function setPinRadiusPx(r: number): void {
  if (!Number.isFinite(r) || r <= 0 || r === radiusPx) return;
  radiusPx = r;
  for (const l of listeners) l();
}

/** Subscribe to radius changes (React: useSyncExternalStore-compatible). */
export function subscribePinRadius(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Offset from the anchor (sharp corner) to the bubble body center, in canvas
 * device px with CSS axis orientation (y grows downward) — multiply by the
 * canvas CSS ratio before positioning DOM.
 */
export function bubbleCenterOffsetPx(): { dx: number; dy: number } {
  return { dx: radiusPx, dy: -radiusPx };
}
