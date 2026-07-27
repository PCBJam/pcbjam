/**
 * Chrome (editor UI) visibility — the Figma-like "hide UI" toggle state
 * (features/mobile).
 *
 * One module-global boolean every shell consumer shares: WasmTool applies it
 * to the wasm frame (kicadSetChrome), the floating button and the Cmd+\ /
 * Ctrl+\ hotkey flip it, and the shell overlays (version badge, source chip,
 * console toggle) key their visibility off it.
 *
 * Session semantics, like Figma: nothing is persisted — a reload restores the
 * device default (startsChromeHidden: small screens — phones, tablets, narrow
 * windows — → hidden, desktop → shown; `?mobile=` still forces it). Being
 * module-global the toggled state survives SPA
 * navigation (e.g. editor → Home keeps the badge hidden); tool switches are
 * full page loads, so in practice that only affects Home.
 */

import { useSyncExternalStore } from "react";
import { startsChromeHidden } from "./mobile-mode";

// Resolved lazily so merely importing the module never touches `window`
// (unit tests run in the node environment).
let hidden: boolean | null = null;
const listeners = new Set<() => void>();

export function getChromeHidden(): boolean {
  hidden ??= typeof window === "undefined" ? false : startsChromeHidden();
  return hidden;
}

export function setChromeHidden(value: boolean): void {
  if (value === getChromeHidden()) return;
  hidden = value;
  for (const listener of [...listeners]) listener();
}

export function toggleChromeHidden(): void {
  setChromeHidden(!getChromeHidden());
}

/** Returns the unsubscriber. */
export function subscribeChromeHidden(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChromeHidden(): boolean {
  return useSyncExternalStore(subscribeChromeHidden, getChromeHidden);
}

/** Test-only: back to the unresolved default, all subscribers dropped. */
export function resetChromeHiddenForTests(value: boolean | null = null): void {
  hidden = value;
  listeners.clear();
}

/**
 * The Figma "hide UI" shortcut: Cmd+\ (mac) / Ctrl+\. Free in KiCad — only
 * BARE `\` is bound (Decrease Via Size, pcbnew), no modifier+backslash
 * anywhere. Matches by key OR physical code so it works on layouts where `\`
 * moved (or the Backslash key produces something else). Rejects altKey
 * because AltGr-typed `\` (HU/DE layouts) reports ctrl+alt — typing a
 * backslash into a text field must not toggle the UI — and rejects repeats so
 * holding the chord doesn't strobe full AUI relayouts.
 */
export function isChromeToggleHotkey(e: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat: boolean;
}): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.repeat) return false;
  return e.key === "\\" || e.code === "Backslash" || e.code === "IntlBackslash";
}
