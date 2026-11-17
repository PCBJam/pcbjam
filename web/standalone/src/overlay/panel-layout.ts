import * as React from "react";
import { glCanvasRect } from "@/wasm/canvas-coords";
import { nameToolbar, snapMove, snapResize, type Guide, type Rect, type SnapTarget, type Snapped } from "./panel-snap";

/**
 * The floating panels' shared layout state (overlay-system 0007): whether panels snap, whether
 * the layout is locked, and the guide lines of the drag in progress. Both drag hooks
 * (useDraggablePanel, usePluginPanelLayout) read it; the session menu toggles it.
 *
 * A panel takes part by carrying `data-snap-panel` on its root: the others snap to it.
 */

const SNAP_KEY = "pcbjam:panels-snap";
const LOCK_KEY = "pcbjam:panels-locked";

function stored(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

interface LayoutState {
  snap: boolean;
  locked: boolean;
  guides: Guide[];
}

let state: LayoutState = { snap: stored(SNAP_KEY, true), locked: stored(LOCK_KEY, false), guides: [] };
const listeners = new Set<() => void>();

function set(next: Partial<LayoutState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const panelLayout = {
  get: () => state,
  subscribe,
  setSnap(snap: boolean) {
    try { localStorage.setItem(SNAP_KEY, snap ? "1" : "0"); } catch { /* the choice lasts this session */ }
    set({ snap });
  },
  setLocked(locked: boolean) {
    try { localStorage.setItem(LOCK_KEY, locked ? "1" : "0"); } catch { /* the choice lasts this session */ }
    set({ locked, guides: [] });
  },
  clearGuides() {
    if (state.guides.length) set({ guides: [] });
  },
};

export function usePanelLayout(): LayoutState {
  return React.useSyncExternalStore(subscribe, () => state);
}

const toRect = (r: { left: number; top: number; width: number; height: number }): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const shown = (r: Rect) => r.w > 0 && r.h > 0;

function panelName(el: Element): string {
  return el.getAttribute("aria-label") ?? el.getAttribute("data-testid")?.replace(/-/g, " ") ?? "a panel";
}

/**
 * What a panel may snap to: the other panels, and the editor's drawing area, toolbars, status
 * bar and menu bar while they are on screen. The toolbars come from the wx window registry
 * (canvas-relative rects), named by where they sit against the drawing area.
 */
export function snapTargets(self: Element | null): SnapTarget[] {
  const out: SnapTarget[] = [];
  for (const el of document.querySelectorAll("[data-snap-panel]")) {
    if (el === self || self?.contains(el) || el.contains(self)) continue;
    const r = toRect(el.getBoundingClientRect());
    if (shown(r)) out.push({ rect: r, name: panelName(el), kind: "panel" });
  }
  const gl = glCanvasRect();
  const canvas = gl ? { x: gl.x, y: gl.y, w: gl.width, h: gl.height } : null;
  if (canvas && shown(canvas)) out.push({ rect: canvas, name: "the drawing area", kind: "area" });
  const reg = window.wxElementRegistry;
  const origin = document.getElementById("canvas")?.getBoundingClientRect();
  if (reg && origin) {
    for (const w of reg.findAll({ visible: true })) {
      const bar = /AuiToolBar/.test(w.typeName) ? "toolbar" : /StatusBar/.test(w.typeName) ? "status" : null;
      if (!bar) continue;
      const r = { x: origin.left + w.screenX, y: origin.top + w.screenY, w: w.width, h: w.height };
      if (!shown(r)) continue;
      out.push({ rect: r, name: bar === "status" ? "the status bar" : nameToolbar(r, canvas), kind: "bar" });
    }
  }
  const menu = document.querySelector('[data-wx-menu-bar="1"]');
  if (menu) {
    const r = toRect(menu.getBoundingClientRect());
    if (shown(r)) out.push({ rect: r, name: "the menu bar", kind: "bar" });
  }
  return out;
}

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

/**
 * A drag's next rect, snapped to `targets` (from {@link snapTargets} when the drag began) when
 * snapping is on and Alt is not held; shows its guides.
 */
export function snapPanelMove(r: Rect, targets: SnapTarget[], altKey: boolean): Snapped {
  if (!state.snap || altKey) {
    panelLayout.clearGuides();
    return { ...r, guides: [], why: [] };
  }
  const s = snapMove(r, targets, viewport());
  set({ guides: s.guides });
  return s;
}

/** {@link snapPanelMove} for a resize from a bottom corner. */
export function snapPanelResize(r: Rect, side: "left" | "right", targets: SnapTarget[], altKey: boolean): Snapped {
  if (!state.snap || altKey) {
    panelLayout.clearGuides();
    return { ...r, guides: [], why: [] };
  }
  const s = snapResize(r, side, targets, viewport());
  set({ guides: s.guides });
  return s;
}
