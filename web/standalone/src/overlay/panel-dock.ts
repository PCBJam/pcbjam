import * as React from "react";

/**
 * Docked panels (overlay-system 0008): a floating panel can dock to the window's left or right
 * side, where it takes the whole height and the editor shrinks to make room. Panels docked to
 * the same side share it as tabs. Docking only moves the panel's box: its element stays where
 * it is in the page, so a plugin's iframe keeps running.
 *
 * The editor's box (WasmTool's `data-wx-viewport`) is the window minus the docked widths; wx
 * sizes its main window from that box, and a window 'resize' tells it to look again.
 */

export type DockSide = "left" | "right";

interface SideState {
  width: number;
  /** Docked panels, in tab order (ids, as in data-snap-panel). */
  tabs: string[];
  active: string | null;
}

interface DockState {
  left: SideState;
  right: SideState;
  /** Tab names, from each panel when it docked. */
  titles: Record<string, string>;
  /** Panels on screen now: a side shows only those (a closed panel keeps its place). */
  mounted: ReadonlySet<string>;
}

const DOCK_KEY = "pcbjam:panel-dock";
export const DOCK_DEFAULT_W = 360;
export const DOCK_MIN_W = 260;
/** The tab strip's height, shown when two or more panels share a side. */
export const DOCK_TABS_H = 32;

const emptySide = (): SideState => ({ width: DOCK_DEFAULT_W, tabs: [], active: null });

function restore(): DockState {
  const base: DockState = { left: emptySide(), right: emptySide(), titles: {}, mounted: new Set() };
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_KEY) ?? "null") as Partial<DockState> | null;
    for (const side of ["left", "right"] as const) {
      const s = v?.[side];
      if (s && Array.isArray(s.tabs) && Number.isFinite(s.width))
        base[side] = { width: s.width, tabs: s.tabs.filter((t) => typeof t === "string"), active: typeof s.active === "string" ? s.active : null };
    }
    if (v?.titles && typeof v.titles === "object") base.titles = v.titles;
  } catch {
    /* unreadable: nothing docked */
  }
  return base;
}

let state = restore();
const listeners = new Set<() => void>();

function set(next: Partial<DockState>, save = true) {
  state = { ...state, ...next };
  if (save) {
    try {
      const { left, right, titles } = state;
      localStorage.setItem(DOCK_KEY, JSON.stringify({ left, right, titles }));
    } catch {
      /* the docking lasts this session */
    }
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The tabs a side shows: its docked panels that are on screen. */
const shownTabs = (s: SideState) => s.tabs.filter((t) => state.mounted.has(t));
/** The side's width, 0 with nothing shown; never more than half the window. */
const widthOf = (side: DockSide) =>
  shownTabs(state[side]).length ? Math.min(state[side].width, Math.max(DOCK_MIN_W, Math.round(window.innerWidth / 2))) : 0;
const activeOf = (side: DockSide) => {
  const tabs = shownTabs(state[side]);
  return tabs.includes(state[side].active ?? "") ? state[side].active : (tabs[0] ?? null);
};

export const panelDock = {
  get: () => state,
  subscribe,
  sideOf(id: string): DockSide | null {
    return state.left.tabs.includes(id) ? "left" : state.right.tabs.includes(id) ? "right" : null;
  },
  width: widthOf,
  /** The side's shown tabs, with their names, and the one in front. */
  tabs(side: DockSide) {
    return { ids: shownTabs(state[side]), active: activeOf(side), titles: state.titles };
  },
  /** A panel is on screen (its hook mounted); returns the unmount. */
  mount(id: string): () => void {
    if (!state.mounted.has(id)) set({ mounted: new Set([...state.mounted, id]) }, false);
    return () => {
      const mounted = new Set(state.mounted);
      mounted.delete(id);
      set({ mounted }, false);
    };
  },
  dock(id: string, side: DockSide, title: string) {
    const strip = (s: SideState) => ({ ...s, tabs: s.tabs.filter((t) => t !== id) });
    const left = strip(state.left);
    const right = strip(state.right);
    const into = side === "left" ? left : right;
    into.tabs = [...into.tabs, id];
    into.active = id;
    set({ left, right, titles: { ...state.titles, [id]: title } });
  },
  undock(id: string) {
    const strip = (s: SideState) => ({ ...s, tabs: s.tabs.filter((t) => t !== id), active: s.active === id ? null : s.active });
    set({ left: strip(state.left), right: strip(state.right) });
  },
  activate(side: DockSide, id: string) {
    set({ [side]: { ...state[side], active: id } });
  },
  setWidth(side: DockSide, width: number) {
    const max = Math.max(DOCK_MIN_W, Math.round(window.innerWidth / 2));
    set({ [side]: { ...state[side], width: Math.round(Math.min(Math.max(width, DOCK_MIN_W), max)) } });
  },
};

export function usePanelDock(): DockState {
  return React.useSyncExternalStore(subscribe, () => state);
}

/**
 * A panel's box while it is docked (page px, for its `style`), or null while it floats. A tab
 * behind another is hidden but stays mounted. The hook also marks the panel as on screen.
 */
export function useDockedStyle(id: string): React.CSSProperties | null {
  React.useEffect(() => panelDock.mount(id), [id]);
  usePanelDock();
  // The window's size feeds the clamp in widthOf.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const side = panelDock.sideOf(id);
  if (!side) return null;
  const width = widthOf(side);
  const { ids, active } = panelDock.tabs(side);
  const top = ids.length > 1 ? DOCK_TABS_H : 0;
  return {
    left: side === "left" ? 0 : window.innerWidth - width,
    top,
    width,
    height: window.innerHeight - top,
    maxHeight: "none",
    borderRadius: 0,
    display: active === id ? undefined : "none",
  };
}
