// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import type { Tool } from "@pcbjam/shared";
import type { LibSetChangedDetail } from "@/wasm/libs/source";

/** The libset toast's message once live-loading failed and reload is the offer. */
export function reloadFallbackMsg(notice: { detail: LibSetChangedDetail }): string {
  const label = notice.detail.name ? `"${notice.detail.name}"` : "the new library";
  return `Couldn't load ${label} into the running session — click to reload the editor.`;
}

// Tools with the v2 items bridge (kicadCollabSnapshotItems/ApplyItems embind exports).
export const COLLAB_TOOLS = new Set<Tool>(["pl_editor", "eeschema", "pcbnew"]);

// Chrome (editor UI) toggle: only the merged kicad_editor bundle exports
// kicadSetChrome (gerbview/calculator/pl_editor don't) — everything about the
// toggle is feature-gated on the export being there.
export function chromeSetter(win: Window): ((show: boolean) => boolean) | null {
  const fn = (win as { Module?: { kicadSetChrome?: unknown } }).Module
    ?.kicadSetChrome;
  return typeof fn === "function" ? (fn as (show: boolean) => boolean) : null;
}

/** kicadShow3DViewer (pcbnew bundle): opens the 3D viewer from the session
 *  menu — the one way to reach it when the wx chrome is hidden (read-only
 *  viewer / hide-UI). Null on bundles without it. */
export function show3DOpener(win: Window): (() => boolean) | null {
  const fn = (win as { Module?: { kicadShow3DViewer?: unknown } }).Module
    ?.kicadShow3DViewer;
  return typeof fn === "function" ? (fn as () => boolean) : null;
}

// Viewer panels (viewer-panels): floating layer selector + selection
// inspector open-state persistence, mirroring the comments panel's keys.
export const LAYERS_OPEN_KEY = "pcbjam:layers-panel-open";
export const SHEETS_OPEN_KEY = "pcbjam:sheet-panel-open";
export const INSPECTOR_OPEN_KEY = "pcbjam:inspector-panel-open";

// Tooltip only — the matcher accepts both chords on any platform.
export const CHROME_HOTKEY_LABEL =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
    ? "⌘\\"
    : "Ctrl+\\";

// Which library item kind each tool browses — drives the load-screen pre-sync
// (warm the right bundles into IDB while the wasm downloads). Tools that don't
// browse a library are omitted (no pre-sync).
export const LIB_KIND_FOR_TOOL: Partial<Record<Tool, "symbol" | "footprint">> = {
  symbol_editor: "symbol",
  eeschema: "symbol",
  footprint_editor: "footprint",
  pcbnew: "footprint",
};

