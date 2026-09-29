/**
 * Console / e2e handle for the overlay while no real owner exists yet
 * (overlay-system 0002 M1): `window.__pcbjamOverlay`. Exposed in dev builds,
 * or in any build when the page URL carries `?overlayDemo`. Not a public API —
 * plugins get their own, permissioned wrapper (0003).
 */
import { overlay } from "./api";
import { onEditorEvent, openDialog } from "./editor-events";
import { openTrustedPrompt } from "./trusted-prompts";
import { resolveTarget } from "./targets/resolve";
import { addResistorTour } from "./tours/add-resistor";
import { readTourStatus, startTour, type Tour, type TourRunner } from "./tours/runner";

/** Internal demo tours, by `?overlayDemo=<id>`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOURS: Record<string, () => Tour<any>> = {
  "add-resistor": () => addResistorTour(),
};

export interface OverlayDemoHandle {
  show: typeof overlay.show;
  clear: typeof overlay.clear;
  on: typeof overlay.on;
  getState: typeof overlay.getState;
  /** Resolve a target id once, for diagnostics and target checks. */
  resolve: typeof resolveTarget;
  /** Simulate a trusted prompt (pause test); returns the release function. */
  openTrustedPrompt: typeof openTrustedPrompt;
  /** Engine events (actions, dialogs) as the overlay sees them. */
  onEditorEvent: typeof onEditorEvent;
  openDialog: typeof openDialog;
  /** The running demo tour, if any. */
  tour: TourRunner | null;
}

declare global {
  interface Window {
    __pcbjamOverlay?: OverlayDemoHandle;
  }
}

export function overlayDemoEnabled(search: string = window.location.search): boolean {
  return import.meta.env.DEV || new URLSearchParams(search).has("overlayDemo");
}

/**
 * The demo tour to run in `tool`: named by `?overlayDemo=<id>`, or one still
 * "active" in this tab (a tour survives the editor-switch page navigation).
 */
export function demoTourFor(tool: string, search: string = window.location.search): string | null {
  const asked = new URLSearchParams(search).get("overlayDemo");
  const ids = asked && TOURS[asked] ? [asked] : Object.keys(TOURS).filter((id) => readTourStatus(id) === "active");
  for (const id of ids) {
    if (TOURS[id]!().editor === tool) return id;
  }
  return null;
}

/** Install the handle (and start a demo tour for `tool`); returns the uninstaller. */
export function installOverlayDemo(tool: string): () => void {
  const tourId = demoTourFor(tool);
  const tour = tourId ? startTour(TOURS[tourId]!()) : null;
  if (!overlayDemoEnabled()) return () => tour?.stop();
  window.__pcbjamOverlay = {
    show: overlay.show,
    clear: overlay.clear,
    on: overlay.on,
    getState: overlay.getState,
    resolve: resolveTarget,
    openTrustedPrompt,
    onEditorEvent,
    openDialog,
    tour,
  };
  return () => {
    tour?.stop();
    delete window.__pcbjamOverlay;
  };
}
