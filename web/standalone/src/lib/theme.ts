import * as React from "react";

/**
 * Standalone light/dark theme (comments-ux 0002 F1), mirroring the platform's
 * module — same storage key, same `<html>.dark` single source of truth — plus
 * the `?theme=` hand-off: the platform appends the param to editor links (the
 * only cross-origin channel; no iframe/postMessage exists), the param wins and
 * re-persists on every navigation, then storage, then the OS preference.
 * index.html applies the same rule inline before first paint — keep the key
 * and precedence in sync with it.
 *
 * The KiCad canvas follows separately: boot seeding picks the color theme
 * (wasm/boot.ts), and the F4 bridge (`kicadSetColorTheme`) switches it live
 * when the loaded wasm exposes it (theme.ts notifies subscribers).
 */

const STORAGE_KEY = "pcbjam-theme";

export type Theme = "light" | "dark";

function themeParam(): Theme | null {
  try {
    const v = new URLSearchParams(window.location.search).get("theme");
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** The theme in effect: `?theme=` > stored choice > OS preference. */
export function currentTheme(): Theme {
  const param = themeParam();
  if (param) return param;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage disabled — fall through to the OS preference */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Reactive theme: tracks <html>.dark itself (the single source of truth all
 *  appliers — toggles, the no-flash boot script — write to). */
export function useThemeValue(): Theme {
  const subscribe = React.useCallback((onChange: () => void) => {
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return React.useSyncExternalStore(subscribe, () =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
}

/** Persist and apply (tailwind `darkMode: ["class"]` keys off <html>.dark). */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage disabled — still apply for this page view */
  }
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Apply the resolved theme at app start and persist a `?theme=` hand-off so
 *  it survives in-app navigation (the param stays in the URL regardless). */
export function initTheme(): void {
  const t = currentTheme();
  if (themeParam()) {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* private mode */
    }
  }
  document.documentElement.classList.toggle("dark", t === "dark");
}
