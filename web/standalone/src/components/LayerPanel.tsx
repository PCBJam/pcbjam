import * as React from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, X } from "lucide-react";
import { useDraggablePanel } from "@/components/useDraggablePanel";

/**
 * Floating layer panel (viewer-panels): the canvas-only replacement for the
 * wx Appearance pane that kicadSetChrome(false) hides. Reads/toggles per-layer
 * visibility and the active layer through the layer bridge (pcbnew builds
 * only — kicadLayersGetState/SetVisible/SetActive), updating event-driven from
 * the C++ `window.kicadCollab.onLayersState` push that follows every apply.
 *
 * Same draggable-panel conventions as the comments panel (comments-ux 0001 B):
 * header = drag handle, collapse-to-header, position/collapse persisted,
 * always-onscreen restore via useDraggablePanel.
 */

const PANEL_POS_KEY = "pcbjam:layers-panel-pos";
const PANEL_COLLAPSED_KEY = "pcbjam:layers-panel-collapsed";
const PANEL_W = 256; // w-64
const PANEL_HEADER_H = 36;

export interface LayerRow {
  id: number;
  name: string;
  canonical: string;
  copper: boolean;
  visible: boolean;
  color: string;
}

export interface LayersState {
  active: number;
  layers: LayerRow[];
}

export interface LayersModule {
  kicadLayersGetState(): string;
  kicadLayersSetVisible(id: number, visible: boolean): boolean | Promise<boolean>;
  kicadLayersSetActive(id: number): boolean | Promise<boolean>;
}

interface LayersWindow {
  kicadCollab?: { onLayersState?: (json: string) => void };
}

/** True when the loaded wasm exposes the layer bridge (pcbnew builds). */
export function hasLayersBridge(mod: unknown): mod is LayersModule {
  const m = mod as Partial<LayersModule> | undefined;
  return (
    typeof m?.kicadLayersGetState === "function" &&
    typeof m?.kicadLayersSetVisible === "function" &&
    typeof m?.kicadLayersSetActive === "function"
  );
}

export function parseLayersState(json: string): LayersState | null {
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== "object") return null;
    const o = v as { active?: unknown; layers?: unknown };
    if (typeof o.active !== "number" || !Array.isArray(o.layers)) return null;
    const layers: LayerRow[] = [];
    for (const l of o.layers) {
      const r = l as Partial<LayerRow> | null;
      if (!r || typeof r.id !== "number" || typeof r.name !== "string") continue;
      layers.push({
        id: r.id,
        name: r.name,
        canonical: typeof r.canonical === "string" ? r.canonical : r.name,
        copper: r.copper === true,
        visible: r.visible !== false,
        color: typeof r.color === "string" ? r.color : "",
      });
    }
    return { active: o.active, layers };
  } catch {
    return null;
  }
}

export function LayerPanel({ mod, onClose }: { mod: LayersModule; onClose: () => void }) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const drag = useDraggablePanel({
    storageKey: PANEL_POS_KEY,
    handleWidth: PANEL_W,
    handleHeight: PANEL_HEADER_H,
  });
  const [collapsed, setCollapsedState] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(PANEL_COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  const [state, setState] = React.useState<LayersState | null>(() =>
    parseLayersState(mod.kicadLayersGetState() || "null"),
  );

  // Event-driven refresh: the C++ side pushes the fresh state after every
  // apply (both setters run on the coroutine — a synchronous re-read right
  // after the call would still see old state). Spread-preserving install,
  // same etiquette as the presence bridge's handlers.
  React.useEffect(() => {
    const win = window as LayersWindow;
    win.kicadCollab = {
      ...win.kicadCollab,
      onLayersState: (json) => {
        const s = parseLayersState(json);
        if (s) setState(s);
      },
    };
    return () => {
      if (win.kicadCollab) delete win.kicadCollab.onLayersState;
    };
  }, []);

  const setVisible = (id: number, visible: boolean) => {
    // Optimistic flip for a snappy checkbox; the onLayersState push corrects.
    setState((s) =>
      s
        ? { ...s, layers: s.layers.map((l) => (l.id === id ? { ...l, visible } : l)) }
        : s,
    );
    void mod.kicadLayersSetVisible(id, visible);
  };

  const setActive = (id: number) => {
    setState((s) => (s ? { ...s, active: id } : s));
    void mod.kicadLayersSetActive(id);
  };

  // Default anchor: below the overlay-menu FAB (right-anchored, top 12 + 36 + gap).
  const style: React.CSSProperties = drag.pos
    ? { left: drag.pos.x, top: drag.pos.y }
    : { right: 12, top: 56 };

  return (
    <div
      ref={rootRef}
      data-testid="layers-panel"
      className="absolute z-40 flex w-64 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
      style={style}
    >
      {/* Header = drag handle. Interactive children stop pointerdown so they
          don't start a drag. */}
      <div
        data-testid="layers-panel-header"
        className="flex cursor-grab select-none items-center gap-2 px-3 py-2 text-xs font-semibold active:cursor-grabbing"
        style={{ touchAction: "none" }}
        title="Layers — drag to move"
        onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
        onPointerMove={(e) => void drag.onPointerMove(e)}
        onPointerUp={() => void drag.onPointerUp()}
      >
        <button
          data-testid="layers-panel-collapse"
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse to header"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span>Layers</span>
        <span className="ml-auto flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
          <button
            data-testid="layers-panel-close"
            title="Close"
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X size={14} />
          </button>
        </span>
      </div>

      {!collapsed && (
        <div data-testid="layers-panel-list" className="max-h-[60vh] overflow-y-auto pb-1">
          {!state && (
            <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              Layer state isn't available yet.
            </p>
          )}
          {state?.layers.map((l) => (
            <div
              key={l.id}
              data-testid="layer-row"
              data-layer-id={l.id}
              data-active={state.active === l.id || undefined}
              className={`flex w-full items-center gap-2 border-t border-black/5 px-3 py-1 text-xs dark:border-white/5 ${
                state.active === l.id ? "bg-sky-500/10 dark:bg-sky-400/10" : ""
              }`}
            >
              {/* Row body sets the ACTIVE layer (the wx Appearance pane's
                  click semantics); the eye toggles visibility. */}
              <button
                data-testid="layer-activate"
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-sky-600 dark:hover:text-sky-300"
                title={`Make ${l.name} the active layer`}
                onClick={() => setActive(l.id)}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-inset ring-black/20 dark:ring-white/25"
                  style={l.color ? { backgroundColor: l.color } : undefined}
                />
                <span className={`truncate ${state.active === l.id ? "font-semibold" : ""}`}>
                  {l.name}
                </span>
              </button>
              <button
                data-testid="layer-visibility"
                aria-pressed={l.visible}
                title={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                onClick={() => setVisible(l.id, !l.visible)}
                className={`rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10 ${
                  l.visible
                    ? "text-neutral-600 dark:text-white/70"
                    : "text-neutral-300 dark:text-white/25"
                }`}
              >
                {l.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
