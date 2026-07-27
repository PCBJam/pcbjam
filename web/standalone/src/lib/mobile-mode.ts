/**
 * Mobile-mode resolution (features/mobile).
 *
 * In mobile mode the editor runs canvas-only: the web shell hides its overlays
 * (version badge, source chip, console toggle), boot installs the touch-gesture
 * shim, and the wasm hides the editor chrome (kicadSetChrome). One shared
 * signal so every consumer agrees:
 *
 *   - `?mobile=1` / `?mobile=0` (also true/false) override everything — the
 *     deterministic switch for tests and for users on unusual devices.
 *   - otherwise auto-detect: UA-CH `userAgentData.mobile`, or a coarse PRIMARY
 *     pointer at any width — tablets count as mobile (Android tablets report
 *     `mobile: false`, iPads don't expose UA-CH; both need the touch shim).
 *     Touch laptops keep a fine primary pointer (trackpad), so they stay
 *     desktop. Same signals capabilities.ts warns on.
 */

/** The window surface isMobileMode reads — narrow, so tests can fake it. */
export interface MobileModeWindow {
  location: { search: string };
  navigator?: { userAgentData?: { mobile?: boolean } };
  matchMedia?: ((query: string) => { matches: boolean }) | undefined;
}

export function isMobileMode(
  // same narrow-cast pattern as capabilities.ts: userAgentData is not in lib.dom
  win: MobileModeWindow = window as unknown as MobileModeWindow,
): boolean {
  const param = new URLSearchParams(win.location.search).get("mobile");
  if (param === "0" || param === "false") return false;
  if (param === "1" || param === "true") return true;

  if (win.navigator?.userAgentData?.mobile === true) return true;

  const mm = win.matchMedia;
  if (typeof mm !== "function") return false;
  return mm("(pointer: coarse)").matches;
}

/**
 * Should the editor chrome START hidden ("headless")? Everything isMobileMode
 * covers (phones + tablets), plus a narrow viewport with any pointer — a small
 * desktop window starts headless too, since the chrome doesn't fit. `?mobile=0`
 * still forces shown. Start state only — the floating button / Cmd+\ toggle it
 * live (chrome-visibility).
 */
export function startsChromeHidden(
  win: MobileModeWindow = window as unknown as MobileModeWindow,
): boolean {
  const param = new URLSearchParams(win.location.search).get("mobile");
  if (param === "0" || param === "false") return false;

  if (isMobileMode(win)) return true;

  const mm = win.matchMedia;
  if (typeof mm !== "function") return false;
  return mm("(max-width: 900px)").matches;
}
