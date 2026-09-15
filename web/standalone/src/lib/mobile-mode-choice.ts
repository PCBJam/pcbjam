/**
 * Mobile session-mode choice (mobile 0002).
 *
 * On a phone or tablet (isMobileMode) a WRITER is asked, before the editor
 * boots, whether they want the full editor or one of the lighter locked
 * sessions — "view only" (pure viewer) or "comment only" (frame locked,
 * comments still allowed). The answer travels in the URL (`?mode=`, see
 * read-only-mode.ts), so a reload keeps it and the resolvers stay the single
 * source of truth; "remember on this device" additionally stores it here so
 * the next open applies it without asking.
 *
 * Non-writers are never asked: the server already narrowed their session.
 */

import type { ProjectAccess } from "@pcbjam/shared";
import { canChooseMode, type SessionMode } from "./read-only-mode";

export const MOBILE_MODE_KEY = "pcbjam-mobile-mode";

/** The storage surface — narrow, so tests can fake it. */
export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): ModeStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage disabled (private mode) — ask every time
  }
}

export function rememberedMobileMode(store: ModeStorage | null = storage()): SessionMode | null {
  try {
    const v = store?.getItem(MOBILE_MODE_KEY);
    return v === "view" || v === "comment" || v === "edit" ? v : null;
  } catch {
    return null;
  }
}

export function rememberMobileMode(
  mode: SessionMode | null,
  store: ModeStorage | null = storage(),
): void {
  try {
    if (mode) store?.setItem(MOBILE_MODE_KEY, mode);
    else store?.removeItem(MOBILE_MODE_KEY);
  } catch {
    /* storage disabled — the URL still carries the choice for this load */
  }
}

/** What the gate should do for this load. */
export type GateDecision =
  | { kind: "pass" } // not applicable: desktop, non-writer, or the URL already answered
  | { kind: "apply"; mode: SessionMode } // a remembered choice — put it in the URL, no dialog
  | { kind: "ask" };

export function mobileModeGateDecision(input: {
  mobile: boolean;
  access: ProjectAccess | undefined;
  requested: SessionMode | null;
  remembered: SessionMode | null;
}): GateDecision {
  if (input.requested !== null) return { kind: "pass" };
  if (!input.mobile) return { kind: "pass" };
  if (!canChooseMode(input.access)) return { kind: "pass" };
  if (input.remembered) return { kind: "apply", mode: input.remembered };
  return { kind: "ask" };
}
