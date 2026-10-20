import { describe, expect, it } from "vitest";
import { chooseDeviceLayout, isMobileMode, startsChromeHidden, type MobileModeWindow } from "./mobile-mode";

/**
 * Mobile-mode resolution (features/mobile): the explicit `?mobile=` URL param
 * always wins, then the layout chosen on this device; otherwise device
 * detection (UA-CH mobile flag, or a coarse primary pointer with no fine
 * pointer anywhere — touch-only tablets are mobile, touch laptops are not; the
 * same signals capabilities.ts warns on).
 */

function fakeWin(opts: {
  search?: string;
  uaMobile?: boolean;
  /** primary pointer is coarse */
  coarse?: boolean;
  /** some pointer is fine (mouse, trackpad); default: !coarse */
  anyFine?: boolean;
  narrow?: boolean;
  noMatchMedia?: boolean;
  stored?: Record<string, string>;
}): MobileModeWindow {
  const store = { ...(opts.stored ?? {}) };
  return {
    location: { search: opts.search ?? "" },
    navigator: { userAgentData: opts.uaMobile === undefined ? undefined : { mobile: opts.uaMobile } },
    matchMedia: opts.noMatchMedia
      ? undefined
      : (query: string) => ({
          matches: query.includes("any-pointer: fine")
            ? (opts.anyFine ?? !(opts.coarse ?? false))
            : query.includes("pointer: coarse")
              ? (opts.coarse ?? false)
              : (opts.narrow ?? false),
        }),
    localStorage: {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => {
        store[k] = v;
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
  };
}

describe("isMobileMode", () => {
  it("?mobile=1 forces mobile mode on a desktop device", () => {
    expect(isMobileMode(fakeWin({ search: "?mobile=1" }))).toBe(true);
    expect(isMobileMode(fakeWin({ search: "?foo=bar&mobile=true" }))).toBe(true);
  });

  it("?mobile=0 forces desktop mode on a mobile device", () => {
    expect(
      isMobileMode(fakeWin({ search: "?mobile=0", uaMobile: true, coarse: true, narrow: true })),
    ).toBe(false);
    expect(isMobileMode(fakeWin({ search: "?mobile=false", uaMobile: true }))).toBe(false);
  });

  it("auto-detects via userAgentData.mobile", () => {
    expect(isMobileMode(fakeWin({ uaMobile: true }))).toBe(true);
    expect(isMobileMode(fakeWin({ uaMobile: false }))).toBe(false);
  });

  it("auto-detects a touch-only device (coarse primary pointer, no fine pointer), at any width", () => {
    expect(isMobileMode(fakeWin({ coarse: true, narrow: true }))).toBe(true);
    // a WIDE coarse-primary device is a tablet in landscape — mobile too
    expect(isMobileMode(fakeWin({ coarse: true, narrow: false }))).toBe(true);
    // a narrow window with a fine pointer is just a small desktop window
    expect(isMobileMode(fakeWin({ coarse: false, narrow: true }))).toBe(false);
  });

  it("a touch laptop (coarse primary pointer, trackpad or mouse present) stays desktop", () => {
    expect(isMobileMode(fakeWin({ coarse: true, anyFine: true }))).toBe(false);
  });

  it("the layout chosen on this device wins over detection; ?mobile= wins over both", () => {
    expect(isMobileMode(fakeWin({ coarse: true, stored: { "pcbjam-device-layout": "desktop" } }))).toBe(false);
    expect(isMobileMode(fakeWin({ uaMobile: true, stored: { "pcbjam-device-layout": "desktop" } }))).toBe(false);
    expect(isMobileMode(fakeWin({ stored: { "pcbjam-device-layout": "mobile" } }))).toBe(true);
    expect(isMobileMode(fakeWin({ search: "?mobile=1", stored: { "pcbjam-device-layout": "desktop" } }))).toBe(true);
    // choosing and forgetting goes through the same storage key
    const w = fakeWin({ coarse: true });
    chooseDeviceLayout("desktop", w);
    expect(isMobileMode(w)).toBe(false);
    chooseDeviceLayout(null, w);
    expect(isMobileMode(w)).toBe(true);
  });

  it("defaults to desktop when nothing is detectable", () => {
    expect(isMobileMode(fakeWin({}))).toBe(false);
    expect(isMobileMode(fakeWin({ noMatchMedia: true }))).toBe(false);
  });
});

/**
 * Chrome start-hidden resolution: everything isMobileMode covers (phones +
 * tablets), plus narrow viewports with any pointer; `?mobile=` still overrides
 * both ways.
 */
describe("startsChromeHidden", () => {
  it("?mobile= overrides both ways", () => {
    expect(startsChromeHidden(fakeWin({ search: "?mobile=1" }))).toBe(true);
    expect(
      startsChromeHidden(fakeWin({ search: "?mobile=0", uaMobile: true, coarse: true, narrow: true })),
    ).toBe(false);
  });

  it("phones start hidden (UA-CH mobile)", () => {
    expect(startsChromeHidden(fakeWin({ uaMobile: true }))).toBe(true);
  });

  it("tablets start hidden: coarse primary pointer even when WIDE (iPad landscape)", () => {
    expect(startsChromeHidden(fakeWin({ uaMobile: false, coarse: true, narrow: false }))).toBe(true);
  });

  it("narrow viewports start hidden even with a fine pointer (small window)", () => {
    expect(startsChromeHidden(fakeWin({ coarse: false, narrow: true }))).toBe(true);
  });

  it("wide fine-pointer desktops start shown", () => {
    expect(startsChromeHidden(fakeWin({ coarse: false, narrow: false }))).toBe(false);
    expect(startsChromeHidden(fakeWin({}))).toBe(false);
    expect(startsChromeHidden(fakeWin({ noMatchMedia: true }))).toBe(false);
  });
});
