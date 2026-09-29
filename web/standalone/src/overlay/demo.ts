/**
 * Console / e2e handle for the overlay while no real owner exists yet
 * (overlay-system 0002 M1): `window.__pcbjamOverlay`. Exposed in dev builds,
 * or in any build when the page URL carries `?overlayDemo`. Not a public API —
 * plugins get their own, permissioned wrapper (0003).
 */
import { overlay } from "./api";
import { openTrustedPrompt } from "./trusted-prompts";
import { resolveTarget } from "./targets/resolve";

export interface OverlayDemoHandle {
  show: typeof overlay.show;
  clear: typeof overlay.clear;
  on: typeof overlay.on;
  getState: typeof overlay.getState;
  /** Resolve a target id once, for diagnostics and target checks. */
  resolve: typeof resolveTarget;
  /** Simulate a trusted prompt (pause test); returns the release function. */
  openTrustedPrompt: typeof openTrustedPrompt;
}

declare global {
  interface Window {
    __pcbjamOverlay?: OverlayDemoHandle;
  }
}

export function overlayDemoEnabled(search: string = window.location.search): boolean {
  return import.meta.env.DEV || new URLSearchParams(search).has("overlayDemo");
}

/** Install the handle; returns the uninstaller. */
export function installOverlayDemo(): () => void {
  if (!overlayDemoEnabled()) return () => {};
  window.__pcbjamOverlay = {
    show: overlay.show,
    clear: overlay.clear,
    on: overlay.on,
    getState: overlay.getState,
    resolve: resolveTarget,
    openTrustedPrompt,
  };
  return () => {
    delete window.__pcbjamOverlay;
  };
}
