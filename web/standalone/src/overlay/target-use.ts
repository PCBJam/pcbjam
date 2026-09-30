import type { EditorEvent } from "./editor-events";
import type { OverlayStep } from "./types";
import type { CssRect } from "@/wasm/canvas-coords";

/**
 * "The user has used the target" — the spotlight dim and the pulsing ring only
 * point at where to click. Once the user clicked inside the target (a toolbar
 * tool, a menu, a button) or ran the target tool's action (its hotkey), they
 * are working — on the canvas, in a dialog — and a grey page over that work
 * reads as "disabled". The host drops both for the rest of the step.
 */

/** Identity of a shown step: a new request (another title/text/target) dims again. */
export function stepUseKey(step: Pick<OverlayStep, "owner" | "target" | "title" | "text">): string {
  return `${step.owner}|${step.target ?? ""}|${step.title ?? ""}|${step.text}`;
}

/** `tool:<action>` → the action name its button (or hotkey) runs; null for other targets. */
export function targetActionName(target: string | undefined): string | null {
  const m = target ? /^tool:(.+)$/.exec(target) : null;
  return m ? m[1]! : null;
}

export function pointInRect(x: number, y: number, r: CssRect): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/** True when this editor event is the target tool's action running. */
export function isTargetAction(e: EditorEvent, target: string | undefined): boolean {
  const action = targetActionName(target);
  return !!action && e.type === "action" && e.name === action;
}
