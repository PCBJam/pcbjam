import * as React from "react";
import { ChevronDown, ChevronRight, FileText, X } from "lucide-react";
import { useDraggablePanel } from "@/components/useDraggablePanel";

/**
 * Floating sheet navigator (sheet-panel): the canvas-only stand-in for the
 * docked wx HIERARCHY_PANE that kicadSetChrome(false) hides. Lists the loaded
 * schematic hierarchy — every sheet INSTANCE, page-number ordered, indented by
 * depth, like the wx pane — and navigates through the sheet bridge
 * (eeschema builds only — kicadSheetsGetTree / kicadSheetsEnter), updating
 * event-driven from the C++ `window.kicadCollab.onSheetsState` push that
 * follows every navigation (ours, or a wx-driven one: double-clicking a sheet
 * symbol, the toolbar arrows).
 *
 * Same draggable-panel conventions as the layer panel (viewer-panels):
 * header = drag handle, collapse-to-header, position/collapse persisted,
 * always-onscreen restore via useDraggablePanel.
 */

const PANEL_POS_KEY = "pcbjam:sheet-panel-pos";
const PANEL_COLLAPSED_KEY = "pcbjam:sheet-panel-collapsed";
const PANEL_W = 256; // w-64
const PANEL_HEADER_H = 36;

export interface SheetRow {
  /** KIID path of this sheet INSTANCE — the navigation key. */
  path: string;
  /** KIID path of the enclosing instance; "" for the root. */
  parent: string;
  name: string;
  /** Absolute MEMFS path of the sheet's .kicad_sch. */
  file: string;
  page: string;
  depth: number;
}

export interface SheetsState {
  current: string;
  sheets: SheetRow[];
}

export interface SheetsModule {
  kicadSheetsGetTree(): string;
  kicadSheetsEnter(path: string): boolean | Promise<boolean>;
}

interface SheetsWindow {
  kicadCollab?: { onSheetsState?: (json: string) => void };
}

/** True when the loaded wasm exposes the sheet bridge (eeschema builds). */
export function hasSheetsBridge(mod: unknown): mod is SheetsModule {
  const m = mod as Partial<SheetsModule> | undefined;
  return (
    typeof m?.kicadSheetsGetTree === "function" &&
    typeof m?.kicadSheetsEnter === "function"
  );
}

export function parseSheetsState(json: string): SheetsState | null {
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== "object") return null;
    const o = v as { current?: unknown; sheets?: unknown };
    if (typeof o.current !== "string" || !Array.isArray(o.sheets)) return null;
    const sheets: SheetRow[] = [];
    for (const s of o.sheets) {
      const r = s as Partial<SheetRow> | null;
      if (!r || typeof r.path !== "string") continue;
      sheets.push({
        path: r.path,
        parent: typeof r.parent === "string" ? r.parent : "",
        name: typeof r.name === "string" ? r.name : "",
        file: typeof r.file === "string" ? r.file : "",
        page: typeof r.page === "string" ? r.page : "",
        depth: typeof r.depth === "number" && r.depth >= 0 ? r.depth : 0,
      });
    }
    return { current: o.current, sheets };
  } catch {
    return null;
  }
}

/** Basename of a MEMFS/relative path, for the row tooltip. */
function fileLabel(file: string): string {
  const i = file.lastIndexOf("/");
  return i >= 0 ? file.slice(i + 1) : file;
}

export function SheetPanel({
  mod,
  defaultCollapsed,
  onClose,
}: {
  mod: SheetsModule;
  /** Boot state when no per-browser choice is stored (read-only sessions
   *  start as a collapsed header — viewer-panels). */
  defaultCollapsed?: boolean;
  onClose: () => void;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const drag = useDraggablePanel({
    storageKey: PANEL_POS_KEY,
    handleWidth: PANEL_W,
    handleHeight: PANEL_HEADER_H,
  });
  const [collapsed, setCollapsedState] = React.useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(PANEL_COLLAPSED_KEY);
      if (stored !== null) return stored === "1";
    } catch {
      /* private mode */
    }
    return defaultCollapsed === true;
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(PANEL_COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  const [state, setState] = React.useState<SheetsState | null>(() =>
    parseSheetsState(mod.kicadSheetsGetTree() || "null"),
  );

  // Event-driven refresh: the C++ side pushes the fresh state after every
  // navigation (the switch runs on the coroutine — a synchronous re-read
  // right after the call would still see the old sheet). Spread-preserving
  // install, same etiquette as the layer/presence bridges.
  React.useEffect(() => {
    const win = window as SheetsWindow;
    win.kicadCollab = {
      ...win.kicadCollab,
      onSheetsState: (json) => {
        const s = parseSheetsState(json);
        if (s) setState(s);
      },
    };
    // Re-read on mount: the panel can open after a wx-driven navigation
    // that happened while no listener was installed.
    const s = parseSheetsState(mod.kicadSheetsGetTree() || "null");
    if (s) setState(s);
    return () => {
      if (win.kicadCollab) delete win.kicadCollab.onSheetsState;
    };
  }, [mod]);

  const enter = (path: string) => {
    // Optimistic highlight for a snappy click; the onSheetsState push corrects.
    setState((s) => (s ? { ...s, current: path } : s));
    void mod.kicadSheetsEnter(path);
  };

  // Default anchor: below the layer panel's slot (right column) — a schematic
  // session has no layer panel, so this sits where that would.
  const style: React.CSSProperties = drag.pos
    ? { left: drag.pos.x, top: drag.pos.y }
    : { right: 12, top: 56 };

  const single = (state?.sheets.length ?? 0) <= 1;

  return (
    <div
      ref={rootRef}
      data-testid="sheet-panel"
      className="absolute z-40 flex w-64 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
      style={style}
    >
      {/* Header = drag handle. Interactive children stop pointerdown so they
          don't start a drag. */}
      <div
        data-testid="sheet-panel-header"
        className="flex cursor-grab select-none items-center gap-2 px-3 py-2 text-xs font-semibold active:cursor-grabbing"
        style={{ touchAction: "none" }}
        title="Sheets — drag to move"
        onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
        onPointerMove={(e) => void drag.onPointerMove(e)}
        onPointerUp={() => void drag.onPointerUp()}
      >
        <button
          data-testid="sheet-panel-collapse"
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse to header"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span>Sheets</span>
        {state && state.sheets.length > 1 && (
          <span className="text-[10px] font-normal text-neutral-400 dark:text-white/40">
            {state.sheets.length}
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
          <button
            data-testid="sheet-panel-close"
            title="Close"
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X size={14} />
          </button>
        </span>
      </div>

      {!collapsed && (
        <div data-testid="sheet-panel-list" className="max-h-[60vh] overflow-y-auto pb-1">
          {!state && (
            <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              Sheet hierarchy isn't available yet.
            </p>
          )}
          {state && single && (
            <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              This schematic has no sub-sheets.
            </p>
          )}
          {state?.sheets.map((s) => {
            const active = state.current === s.path;
            return (
              <button
                key={s.path}
                data-testid="sheet-row"
                data-sheet-path={s.path}
                data-active={active || undefined}
                aria-current={active ? "page" : undefined}
                title={`${fileLabel(s.file)} — page ${s.page}`}
                onClick={() => enter(s.path)}
                className={`flex w-full items-center gap-2 border-t border-black/5 px-3 py-1 text-left text-xs hover:text-sky-600 dark:border-white/5 dark:hover:text-sky-300 ${
                  active ? "bg-sky-500/10 dark:bg-sky-400/10" : ""
                }`}
                style={{ paddingLeft: 12 + Math.min(s.depth, 8) * 12 }}
              >
                <FileText
                  size={13}
                  className={`shrink-0 ${
                    active ? "text-sky-600 dark:text-sky-300" : "text-neutral-400 dark:text-white/40"
                  }`}
                />
                <span className={`min-w-0 flex-1 truncate ${active ? "font-semibold" : ""}`}>
                  {s.name || fileLabel(s.file)}
                </span>
                <span className="shrink-0 tabular-nums text-[10px] text-neutral-400 dark:text-white/40">
                  {s.page}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
