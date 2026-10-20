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
 *   - then the layout the user chose on this device (`pcbjam-device-layout`,
 *     "desktop" | "mobile"; the mobile mode dialog and the session menu set
 *     it): a choice made once sticks across loads.
 *   - otherwise auto-detect: UA-CH `userAgentData.mobile`, or a coarse PRIMARY
 *     pointer with NO fine pointer anywhere — tablets count as mobile (Android
 *     tablets report `mobile: false`, iPads don't expose UA-CH; both need the
 *     touch shim). A coarse primary pointer alone is not enough: Windows
 *     touch laptops can report it while a trackpad or mouse is right there
 *     (`any-pointer: fine`), and they opened canvas-only. Same signals
 *     capabilities.ts warns on (detectsMobileDevice).
 */

/** The window surface isMobileMode reads — narrow, so tests can fake it. */
export interface MobileModeWindow {
  location: { search: string };
  navigator?: { userAgentData?: { mobile?: boolean } };
  matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export const DEVICE_LAYOUT_KEY = "pcbjam-device-layout";
export type DeviceLayout = "desktop" | "mobile";

/** The layout chosen on this device, or null (storage off = no choice). */
export function chosenDeviceLayout(
  win: MobileModeWindow = window as unknown as MobileModeWindow,
): DeviceLayout | null {
  try {
    const v = win.localStorage?.getItem(DEVICE_LAYOUT_KEY);
    return v === "desktop" || v === "mobile" ? v : null;
  } catch {
    return null;
  }
}

/** Remember (or forget, with null) the layout for this device. */
export function chooseDeviceLayout(
  layout: DeviceLayout | null,
  win: MobileModeWindow = window as unknown as MobileModeWindow,
): void {
  try {
    if (layout) win.localStorage?.setItem(DEVICE_LAYOUT_KEY, layout);
    else win.localStorage?.removeItem(DEVICE_LAYOUT_KEY);
  } catch {
    /* storage disabled: the choice holds for this load only (?mobile= still works) */
  }
}

/** Device detection alone: a phone, or a touch-only tablet. */
export function detectsMobileDevice(
  win: MobileModeWindow = window as unknown as MobileModeWindow,
): boolean {
  if (win.navigator?.userAgentData?.mobile === true) return true;

  const mm = win.matchMedia;
  if (typeof mm !== "function") return false;
  return mm("(pointer: coarse)").matches && !mm("(any-pointer: fine)").matches;
}

export function isMobileMode(
  // same narrow-cast pattern as capabilities.ts: userAgentData is not in lib.dom
  win: MobileModeWindow = window as unknown as MobileModeWindow,
): boolean {
  const param = new URLSearchParams(win.location.search).get("mobile");
  if (param === "0" || param === "false") return false;
  if (param === "1" || param === "true") return true;

  const chosen = chosenDeviceLayout(win);
  if (chosen) return chosen === "mobile";

  return detectsMobileDevice(win);
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
