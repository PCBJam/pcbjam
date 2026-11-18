import * as React from "react";
import { glCanvasRect } from "@/wasm/canvas-coords";
import { panelDock } from "./panel-dock";
import {
  anchoredAt,
  arrangeColumns,
  nameToolbar,
  snapMove,
  snapResize,
  SNAP_GAP,
  type Anchor,
  type Guide,
  type Rect,
  type SnapTarget,
  type Snapped,
} from "./panel-snap";

/**
 * The floating panels' shared layout (overlay-system 0007): whether panels snap, which panels
 * are pinned, the editor parts each panel is anchored to, and the guide lines of the drag in
 * progress. Both drag hooks (useDraggablePanel,
 * usePluginPanelLayout) register their panel here and drag through {@link startPanelDrag}.
 *
 * A panel takes part by carrying `data-snap-panel="<its id>"` on its root.
 */

const SNAP_KEY = "pcbjam:panels-snap";
const PINS_KEY = "pcbjam:panels-pinned";
const ANCHORS_KEY = "pcbjam:panel-anchors";

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* the choice lasts this session */
  }
}

type Anchors = { x?: Anchor; y?: Anchor };

interface LayoutState {
  snap: boolean;
  pinned: ReadonlySet<string>;
  guides: Guide[];
}

let state: LayoutState = {
  snap: read(SNAP_KEY, true),
  pinned: new Set(read<string[]>(PINS_KEY, [])),
  guides: [],
};
let anchors: Record<string, Anchors> = read(ANCHORS_KEY, {});
const listeners = new Set<() => void>();

function set(next: Partial<LayoutState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePanelLayout(): LayoutState {
  return React.useSyncExternalStore(subscribe, () => state);
}

// --- the panels ----------------------------------------------------------------------------

/** What the store may do to a panel: find it, move its top-left (page px) and save that. */
export interface PanelHandle {
  id: string;
  /** Arrange leaves it out (the session menu's button: not a panel). */
  arrange?: false;
  moveTo(x: number, y: number): void;
  /** Persist where it is now (as its own drag end does). */
  commit(): void;
}

const handles = new Map<string, PanelHandle>();

/** Register a panel for stacks, anchors and Arrange; returns the unregister. */
export function registerPanel(handle: PanelHandle): () => void {
  handles.set(handle.id, handle);
  ensureWatch();
  return () => {
    if (handles.get(handle.id) === handle) handles.delete(handle.id);
  };
}

const elementOf = (id: string): Element | null => document.querySelector(`[data-snap-panel="${CSS.escape(id)}"]`);
const toRect = (r: { left: number; top: number; width: number; height: number }): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const shown = (r: Rect) => r.w > 0 && r.h > 0;
const rectOf = (id: string): Rect | null => {
  const el = elementOf(id);
  const r = el ? toRect(el.getBoundingClientRect()) : null;
  return r && shown(r) ? r : null;
};

export const panelLayout = {
  get: () => state,
  subscribe,
  setSnap(snap: boolean) {
    write(SNAP_KEY, snap);
    set({ snap });
  },
  togglePin(id: string) {
    const pinned = new Set(state.pinned);
    if (!pinned.delete(id)) pinned.add(id);
    setPinned(pinned);
  },
  /** The floating panels on screen that a pin or Arrange applies to (not the session menu's button). */
  panels: () => [...handles.values()].filter((h) => h.arrange !== false && floating(h.id) && rectOf(h.id)).map((h) => h.id),
  /**
   * Pin every panel on screen, or unpin them all when they all are. In place of a lock: a
   * pinned panel shows its pin, and the pin undoes it, where a forgotten lock left panels
   * that wouldn't move and nothing on them that said why.
   */
  pinAll(pin: boolean) {
    const pinned = new Set(state.pinned);
    for (const id of panelLayout.panels()) {
      if (pin) pinned.add(id);
      else pinned.delete(id);
    }
    setPinned(pinned);
  },
  /** Whether Arrange would move any panel (it moves none when they are already lined up). */
  arrangeMoves: () => arrangePlan().some((p) => Math.abs(p.at.x - p.r.x) > 0.5 || Math.abs(p.at.y - p.r.y) > 0.5),
  clearGuides() {
    if (state.guides.length) set({ guides: [] });
  },
  /** Tile the unpinned panels into columns from the drawing area's right edge (or the window's). */
  arrange,
};

/** Not docked to a side (overlay-system 0008): a docked panel is placed by its side, not here. */
const floating = (id: string) => !panelDock.sideOf(id);

function setPinned(pinned: Set<string>) {
  write(PINS_KEY, [...pinned]);
  set({ pinned });
}

// --- what a panel snaps to ------------------------------------------------------------------

function panelName(el: Element): string {
  return el.getAttribute("aria-label") ?? el.getAttribute("data-testid")?.replace(/-/g, " ") ?? "a panel";
}

/**
 * What a panel may snap to: the other panels (minus `skip`), and the editor's drawing area,
 * toolbars, docked panes (Appearance, Selection Filter…), status bar and menu bar while they are
 * on screen. The toolbars and panes come from the wx window registry (canvas-relative rects):
 * toolbars named by where they sit against the drawing area, panes by their caption.
 */
export function snapTargets(skip: ReadonlySet<Element> = new Set()): SnapTarget[] {
  const out: SnapTarget[] = [];
  for (const el of document.querySelectorAll("[data-snap-panel]")) {
    if ([...skip].some((s) => s === el || s.contains(el) || el.contains(s))) continue;
    const r = toRect(el.getBoundingClientRect());
    if (shown(r)) out.push({ rect: r, name: panelName(el), kind: "panel", key: `panel:${el.getAttribute("data-snap-panel")}` });
  }
  const gl = glCanvasRect();
  const canvas = gl ? { x: gl.x, y: gl.y, w: gl.width, h: gl.height } : null;
  if (canvas && shown(canvas)) out.push({ rect: canvas, name: "the drawing area", kind: "area", key: "area:canvas" });
  const reg = window.wxElementRegistry;
  const origin = document.getElementById("canvas")?.getBoundingClientRect();
  if (reg && origin) {
    const page = (w: { screenX: number; screenY: number; width: number; height: number }): Rect => ({
      x: origin.left + w.screenX,
      y: origin.top + w.screenY,
      w: w.width,
      h: w.height,
    });
    const seen = new Map<string, number>();
    const bars = reg
      .findAll({ visible: true })
      .filter((w) => /AuiToolBar|StatusBar/.test(w.typeName))
      .sort((a, b) => a.screenY - b.screenY || a.screenX - b.screenX);
    for (const w of bars) {
      const r = page(w);
      if (!shown(r)) continue;
      const name = /StatusBar/.test(w.typeName) ? "the status bar" : nameToolbar(r, canvas);
      const n = seen.get(name) ?? 0;
      seen.set(name, n + 1);
      out.push({ rect: r, name, kind: "bar", key: `bar:${name}:${n}` });
    }
    // A docked pane: its caption and its content, both painted by the AUI manager.
    const panes = new Map<string, Rect>();
    for (const p of reg.findAllRendered?.({}) ?? []) {
      if (p.elementType !== "auipart" || !p.label || p.width <= 0 || p.height <= 0) continue;
      const r = page(p);
      const was = panes.get(p.label);
      panes.set(
        p.label,
        was
          ? { x: Math.min(was.x, r.x), y: Math.min(was.y, r.y), w: Math.max(was.x + was.w, r.x + r.w) - Math.min(was.x, r.x), h: Math.max(was.y + was.h, r.y + r.h) - Math.min(was.y, r.y) }
          : r,
      );
    }
    for (const [label, r] of panes) out.push({ rect: r, name: `the ${label} pane`, kind: "bar", key: `pane:${label}` });
  }
  const menu = document.querySelector('[data-wx-menu-bar="1"]');
  if (menu) {
    const r = toRect(menu.getBoundingClientRect());
    if (shown(r)) out.push({ rect: r, name: "the menu bar", kind: "bar", key: "bar:menu" });
  }
  return out;
}

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

/** The panels sitting flush under `id` (a gap apart, overlapping it), and theirs: its stack. */
function stackUnder(id: string, seen = new Set([id])): string[] {
  const top = rectOf(id);
  if (!top) return [];
  const out: string[] = [];
  for (const other of handles.keys()) {
    if (seen.has(other) || state.pinned.has(other) || !floating(other)) continue;
    const r = rectOf(other);
    if (!r) continue;
    if (Math.abs(r.y - (top.y + top.h + SNAP_GAP)) <= 2 && r.x < top.x + top.w && top.x < r.x + r.w) {
      seen.add(other);
      out.push(other, ...stackUnder(other, seen));
    }
  }
  return out;
}

// --- a drag ------------------------------------------------------------------------------------

/** One drag or resize of a panel, from {@link startPanelDrag}. */
export interface PanelDrag {
  /** The panel moved to `r` (page px): snapped, its stack carried along, unless Alt is held. */
  move(r: Rect, altKey: boolean): Snapped;
  /** The panel resized to `r` from a bottom corner: the moving edges snap. */
  resize(r: Rect, side: "left" | "right", altKey: boolean): Snapped;
  /** The gesture ended; `moved`: it was a drag, not a click. */
  end(moved: boolean): void;
}

let dragging = 0;

/**
 * Start a drag of panel `id`; null when the panel is pinned or docked (then a
 * press on the handle stays a click). The targets and the stack are read when it starts moving.
 */
export function startPanelDrag(id: string): PanelDrag | null {
  if (state.pinned.has(id) || !floating(id)) return null;
  let targets: SnapTarget[] | null = null;
  let stack: Array<{ id: string; x: number; y: number }> = [];
  let start: Rect | null = null;
  let last: Snapped | null = null;
  let carried = false;
  const begin = () => {
    if (targets) return;
    dragging++;
    start = rectOf(id);
    stack = stackUnder(id).flatMap((m) => {
      const r = rectOf(m);
      return r ? [{ id: m, x: r.x, y: r.y }] : [];
    });
    const skip = new Set([id, ...stack.map((m) => m.id)].map(elementOf).filter((e): e is Element => !!e));
    targets = snapTargets(skip);
  };
  const plain = (r: Rect): Snapped => ({ ...r, guides: [], why: [], anchors: {} });
  return {
    move(r, altKey) {
      begin();
      const s = !state.snap || altKey ? plain(r) : snapMove(r, targets!, viewport());
      set({ guides: s.guides });
      last = s;
      // Alt pulls the panel out of its stack: the others go back where they were.
      carried = !altKey && stack.length > 0;
      const dx = start ? s.x - start.x : 0;
      const dy = start ? s.y - start.y : 0;
      for (const m of stack) handles.get(m.id)?.moveTo(carried ? m.x + dx : m.x, carried ? m.y + dy : m.y);
      return s;
    },
    resize(r, side, altKey) {
      begin();
      const s = !state.snap || altKey ? plain(r) : snapResize(r, side, targets!, viewport());
      set({ guides: s.guides });
      last = s;
      return s;
    },
    end(moved) {
      if (targets) dragging--;
      set({ guides: [] });
      if (!moved || !last) return;
      setAnchors(id, last.anchors);
      for (const m of stack) {
        handles.get(m.id)?.commit();
        if (carried) setAnchors(m.id, {});
      }
    },
  };
}

function setAnchors(id: string, a: Anchors) {
  if (a.x || a.y) anchors[id] = a;
  else delete anchors[id];
  write(ANCHORS_KEY, anchors);
  ensureWatch();
}

// --- following the editor's layout -----------------------------------------------------------

/** What changes when the editor's layout does: the window, the wx windows, where the canvas sits. */
function layoutSignature(): string {
  const reg = window.wxElementRegistry;
  const origin = document.getElementById("canvas")?.getBoundingClientRect();
  return [window.innerWidth, window.innerHeight, reg?.version ?? 0, reg?.renderedVersion ?? 0, origin?.left ?? 0, origin?.top ?? 0].join("|");
}

let watch: ReturnType<typeof setInterval> | null = null;
let seenLayout = "";

/** Poll the layout while any registered panel is anchored; cheap, and only then. */
function ensureWatch() {
  const needed = [...handles.keys()].some((id) => anchors[id]);
  if (needed && !watch) {
    seenLayout = layoutSignature();
    watch = setInterval(() => {
      const now = layoutSignature();
      if (now === seenLayout || dragging) return;
      seenLayout = now;
      // After the hooks' own resize handling has rendered.
      requestAnimationFrame(followLayout);
    }, 300);
  } else if (!needed && watch) {
    clearInterval(watch);
    watch = null;
  }
}

/**
 * Move each anchored panel back against what it was anchored to, and its stack with it (on the
 * axes a stacked panel isn't anchored on itself). All moves are worked out from the rects as
 * they are, then applied: the DOM catches up only after the hooks render.
 */
export function followLayout() {
  const targets = snapTargets();
  const view = viewport();
  const next = new Map<string, { x: number; y: number }>();
  const at = (id: string) => next.get(id) ?? rectOf(id);
  for (const [id, a] of Object.entries(anchors)) {
    const r = handles.has(id) && floating(id) ? rectOf(id) : null;
    if (!r) continue;
    // Where this pass already put it (as another panel's stack), on the axis it isn't anchored on.
    const cur = at(id)!;
    const x = (a.x && anchoredAt(a.x, "x", r.w, targets, view)) ?? cur.x;
    const y = below(id, x, (a.y && anchoredAt(a.y, "y", r.h, targets, view)) ?? cur.y, r);
    const dx = x - cur.x;
    const dy = y - cur.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    next.set(id, { x, y });
    for (const m of stackUnder(id)) {
      const cur = at(m);
      if (!cur) continue;
      next.set(m, { x: anchors[m]?.x ? cur.x : cur.x + dx, y: anchors[m]?.y ? cur.y : cur.y + dy });
    }
  }
  for (const [id, p] of next) {
    handles.get(id)?.moveTo(p.x, p.y);
    handles.get(id)?.commit();
  }
}

/**
 * `y`, or just below the session menu's button (a handle Arrange leaves out) when the panel at
 * (x, y) would cover it: with KiCad's UI hidden, the drawing area reaches that corner.
 */
function below(id: string, x: number, y: number, r: Rect): number {
  if (handles.get(id)?.arrange === false) return y;
  let out = y;
  for (const h of handles.values()) {
    if (h.arrange !== false) continue;
    const o = rectOf(h.id);
    if (o && x < o.x + o.w && o.x < x + r.w && out < o.y + o.h && o.y < out + r.h) out = o.y + o.h + SNAP_GAP;
  }
  return out;
}

// --- arrange -----------------------------------------------------------------------------------

/** Where Arrange puts each unpinned panel, with where it is now. */
function arrangePlan() {
  const list = [...handles.keys()]
    .filter((id) => !state.pinned.has(id) && floating(id) && handles.get(id)?.arrange !== false)
    .flatMap((id) => {
      const r = rectOf(id);
      return r ? [{ id, r }] : [];
    })
    .sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
  const gl = glCanvasRect();
  const region = gl && gl.width > 0 ? { x: gl.x, y: gl.y, w: gl.width, h: gl.height } : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const key = gl && gl.width > 0 ? "area:canvas" : "window";
  const at = arrangeColumns(list.map((p) => p.r), region);
  return list.map((p, i) => ({ ...p, at: at[i]!, key }));
}

/** How long the panels glide to where Arrange put them, so the move is seen. */
const ARRANGE_GLIDE_MS = 220;

function arrange() {
  const plan = arrangePlan();
  plan.forEach((p, i) => {
    const h = handles.get(p.id)!;
    glide(p.id);
    h.moveTo(p.at.x, p.at.y);
    h.commit();
    // The first column holds to the region's right edge, each column's top panel to its top;
    // the panels under them follow as their stacks.
    const firstColumn = Math.abs(p.at.x + p.r.w - (plan[0]!.at.x + plan[0]!.r.w)) < 0.5;
    const top = i === 0 || p.at.y < plan[i - 1]!.at.y;
    setAnchors(p.id, {
      ...(firstColumn ? { x: { key: p.key, ref: "end" as const, offset: -SNAP_GAP, edge: "end" as const } } : {}),
      ...(top ? { y: { key: p.key, ref: "start" as const, offset: SNAP_GAP, edge: "start" as const } } : {}),
    });
  });
  // Once the panels have landed (following reads their rects): clear of the session menu's
  // button, as following does.
  setTimeout(followLayout, ARRANGE_GLIDE_MS + 30);
}

/** Let a panel's next move animate (its left/top), then drop the transition so drags stay direct. */
function glide(id: string) {
  const el = elementOf(id) as HTMLElement | null;
  if (!el) return;
  const was = el.style.transition;
  el.style.transition = `left ${ARRANGE_GLIDE_MS}ms ease-out, top ${ARRANGE_GLIDE_MS}ms ease-out`;
  setTimeout(() => {
    el.style.transition = was;
  }, ARRANGE_GLIDE_MS + 300);
}
