import * as React from "react";
import { ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import type * as Y from "yjs";
import { useDraggablePanel } from "@/components/useDraggablePanel";
import { Button, Tip } from "@pcbjam/ui";
import { overlayIconClass } from "@/components/OverlayMenu";
import {
  simPartRows,
  type SimPartRow,
  type SimPartsReader,
  type SimPartState,
  type SimSymbolsModule,
} from "@/wasm/sim-parts";

/**
 * Floating "Simulation parts" list (live simulation, first version): one line
 * per symbol of the open schematic, every sheet, saying what the simulation
 * library has for it: a live part, a suggestion, switched off, or no library
 * part. Read-only: nothing here changes the schematic.
 *
 * The rows come from wasm/sim-parts.ts (the editor's `kicadSimSymbols` read
 * matched against the published library). The list is read when the panel
 * opens, on the refresh button, and a moment after every change of the bound
 * collab doc (the active sheet's room), so it follows edits without a wasm
 * push of its own.
 *
 * Same draggable-panel conventions as the sheet and layer panels: header =
 * drag handle, collapse-to-header, position/collapse persisted.
 */

const PANEL_POS_KEY = "pcbjam:sim-parts-panel-pos";
const PANEL_COLLAPSED_KEY = "pcbjam:sim-parts-panel-collapsed";
const PANEL_W = 384; // w-96
const PANEL_HEADER_H = 36;
/** How long the doc has to stay quiet before the list is read again. */
const REFRESH_QUIET_MS = 400;

type View =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; version: string; rows: SimPartRow[] };

const STATE_CLASS: Record<SimPartState, string> = {
  live: "text-emerald-600 dark:text-emerald-300",
  suggested: "text-amber-600 dark:text-amber-300",
  choice: "text-amber-600 dark:text-amber-300",
  error: "text-red-600 dark:text-red-300",
  off: "text-neutral-400 dark:text-white/40",
  "own-model": "text-sky-600 dark:text-sky-300",
  kicad: "text-neutral-500 dark:text-white/60",
  none: "text-neutral-400 dark:text-white/40",
  excluded: "text-neutral-400 dark:text-white/40",
};

export function SimPartsPanel({
  mod,
  reader,
  doc,
  onClose,
}: {
  mod: SimSymbolsModule;
  reader: SimPartsReader;
  /** The bound collab doc; its changes refresh the list. Null (?collab=0) ⇒ the refresh button only. */
  doc: Y.Doc | null;
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
      return localStorage.getItem(PANEL_COLLAPSED_KEY) === "1";
    } catch {
      return false; // private mode
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

  const [view, setView] = React.useState<View>({ status: "loading" });
  const [busy, setBusy] = React.useState(false);
  // Only the newest read may answer: a slow first read must not overwrite a later one.
  const latest = React.useRef(0);

  const refresh = React.useCallback(() => {
    const turn = ++latest.current;
    setBusy(true);
    reader.read(mod).then(
      (parts) => {
        if (turn !== latest.current) return;
        setView({ status: "ready", version: parts.library.version, rows: simPartRows(parts) });
        setBusy(false);
      },
      (err: unknown) => {
        if (turn !== latest.current) return;
        setView({ status: "error", message: err instanceof Error ? err.message : String(err) });
        setBusy(false);
      },
    );
  }, [mod, reader]);

  React.useEffect(() => {
    refresh();
    return () => {
      latest.current++; // a read still under way answers nobody
    };
  }, [refresh]);

  // Follow edits: a remote change reaches the doc before the editor applied
  // it, so wait until the doc has been quiet for a moment, then read.
  React.useEffect(() => {
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_QUIET_MS);
    };
    doc.on("update", onUpdate);
    return () => {
      doc.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [doc, refresh]);

  const style: React.CSSProperties = drag.pos
    ? { left: drag.pos.x, top: drag.pos.y }
    : { left: 12, top: 56 };

  const rows = view.status === "ready" ? view.rows : [];
  const live = rows.filter((r) => r.state === "live").length;

  return (
    <div
      ref={rootRef}
      data-testid="sim-parts-panel"
      data-status={view.status}
      className="absolute z-40 flex w-96 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
      style={style}
    >
      {/* Header = drag handle. Interactive children stop pointerdown so they
          don't start a drag. */}
      <Tip content="Simulation parts - drag to move">
        <div
          data-testid="sim-parts-panel-header"
          className="flex cursor-grab select-none items-center gap-2 px-3 py-2 text-xs font-semibold active:cursor-grabbing"
          style={{ touchAction: "none" }}
          onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
          onPointerMove={(e) => void drag.onPointerMove(e)}
          onPointerUp={() => void drag.onPointerUp()}
        >
          <Tip content={collapsed ? "Expand" : "Collapse to header"}>
            <Button
              data-testid="sim-parts-panel-collapse"
              aria-expanded={!collapsed}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setCollapsed(!collapsed)}
              variant="plain"
              size="icon-xs"
              className={overlayIconClass}
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </Button>
          </Tip>
          <span>Simulation parts</span>
          {view.status === "ready" && (
            <span data-testid="sim-parts-live-count" className="text-[10px] font-normal text-neutral-400 dark:text-white/40">
              {live} live
            </span>
          )}
          <span className="ml-auto flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
            <Tip content="Read the schematic again">
              <Button
                data-testid="sim-parts-panel-refresh"
                onClick={refresh}
                disabled={busy}
                variant="plain"
                size="icon-xs"
                className={overlayIconClass}
              >
                <RefreshCw size={13} className={busy ? "animate-spin" : undefined} />
              </Button>
            </Tip>
            <Tip content="Close">
              <Button
                data-testid="sim-parts-panel-close"
                onClick={onClose}
                variant="plain"
                size="icon-xs"
                className={overlayIconClass}
              >
                <X size={14} />
              </Button>
            </Tip>
          </span>
        </div>
      </Tip>

      {!collapsed && (
        <div data-testid="sim-parts-panel-list" className="max-h-[60vh] overflow-y-auto pb-1">
          {view.status === "loading" && (
            <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              Reading the simulation library...
            </p>
          )}
          {view.status === "error" && (
            <p data-testid="sim-parts-panel-error" className="px-3 pb-3 text-xs text-red-600 dark:text-red-300">
              The parts could not be listed: {view.message}
            </p>
          )}
          {view.status === "ready" && rows.length === 0 && (
            <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              This schematic has no symbols yet.
            </p>
          )}
          {rows.map((r) => (
            <Tip content={r.sheet === "/" ? r.note : `${r.note} Sheet ${r.sheet}`} key={r.key}>
              <div
                data-testid="sim-part-row"
                data-ref={r.ref}
                data-state={r.state}
                className="flex items-baseline gap-2 border-t border-black/5 px-3 py-1 text-xs dark:border-white/5"
              >
                <span className="w-12 shrink-0 truncate font-semibold">{r.ref}</span>
                <span className="w-24 shrink-0 truncate text-neutral-500 dark:text-white/60">{r.value}</span>
                <span data-testid="sim-part-row-part" className="min-w-0 flex-1 truncate">{r.part}</span>
                <span className={`shrink-0 text-[11px] ${STATE_CLASS[r.state]}`}>{r.label}</span>
              </div>
            </Tip>
          ))}
          {view.status === "ready" && (
            <p
              data-testid="sim-parts-library-version"
              className="border-t border-black/5 px-3 pt-1.5 text-[10px] text-neutral-400 dark:border-white/5 dark:text-white/40"
            >
              Library {view.version}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
