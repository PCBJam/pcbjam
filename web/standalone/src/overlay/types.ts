/**
 * Overlay system (overlay-system 0001/0002): host-owned coachmarks, spotlight
 * and step cards over the editor. Owners (the internal demo today, plugins
 * later) describe a step; the host resolves the target, positions and draws.
 * Nothing here renders owner-supplied markup: title/text are plain strings.
 */
import type { CssRect } from "@/wasm/canvas-coords";

export type OverlayButton = "back" | "next" | "skip";
export type Placement = "auto" | "top" | "bottom" | "left" | "right";

export interface OverlayStep {
  /** Who owns the step: 'demo', 'builtin:<id>', later 'plugin:<id>'. */
  owner: string;
  /** Target id (see targets/parse.ts). Omitted → an unanchored card. */
  target?: string;
  title?: string;
  text: string;
  placement?: Placement;
  /** Dim everything but the target (UI targets only; ignored on the canvas). */
  spotlight?: boolean;
  /** Animated ring around the target. */
  pulse?: boolean;
  /** Host-drawn navigation buttons. Close (×) is always present. */
  buttons?: OverlayButton[];
  progress?: { step: number; of: number };
  /** Host-drawn "from …" label, e.g. a plugin's name. */
  attribution?: string;
  /** Card text while the target is not on screen. */
  lostText?: string;
  /** A short host-drawn celebration when the step shows (Celebration.tsx). */
  celebrate?: "rainbow";
}

export const TITLE_MAX = 80;
export const TEXT_MAX = 600;
export const ATTRIBUTION_MAX = 60;

/** A resolved target in page CSS px. */
export interface ResolvedTarget {
  rect: CssRect;
  /** 'canvas' targets never get the spotlight dim (it would hide the work). */
  surface: "ui" | "canvas";
}

/** found: on screen · pending: not seen yet · lost: gone past the grace period. */
export type TargetState = "none" | "pending" | "found" | "lost";

export type OverlayEvent =
  | { type: "shown"; id: number; owner: string }
  | { type: "cleared"; id: number; owner: string; reason: "owner" | "user" | "replaced" | "unmount" }
  | { type: "button"; id: number; owner: string; button: OverlayButton }
  | { type: "targetFound"; id: number; owner: string }
  | { type: "targetLost"; id: number; owner: string }
  | { type: "paused"; id: number; owner: string }
  | { type: "resumed"; id: number; owner: string };

export type OverlayEventType = OverlayEvent["type"];
