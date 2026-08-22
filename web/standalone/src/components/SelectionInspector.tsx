import * as React from "react";
import type * as Y from "yjs";
import {
  kicadItemsMap,
  kicadLayout,
  yToItemUnchecked,
  Y_KDOC_STATE,
  type KicadItem,
} from "@pcbjam/shared";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useDraggablePanel } from "@/components/useDraggablePanel";
import {
  getLocalSelection,
  subscribeLocalSelection,
} from "@/wasm/collab/local-selection";
import { netNameResolver, summarizeItem, type ItemSummary } from "@/lib/item-summary";

/**
 * Floating selection inspector (viewer-panels): read-only properties of the
 * items currently selected on the canvas — reference/value, position,
 * footprint/symbol link, layer, nets… Selection arrives through the local
 * selection store (the C++ onSelection emit); item data comes from the collab
 * Y.Doc's kdoc_items map, so the panel needs no wasm reads and stays live
 * under remote edits.
 *
 * Same draggable-panel conventions as the comments panel (comments-ux 0001 B).
 */

const PANEL_POS_KEY = "pcbjam:inspector-panel-pos";
const PANEL_COLLAPSED_KEY = "pcbjam:inspector-panel-collapsed";
const PANEL_W = 288; // w-72
const PANEL_HEADER_H = 36;

/** Cap the rendered selection — a select-all on a big board must not build
 *  thousands of row lists. */
const MAX_ITEMS = 20;

export function SelectionInspector({
  doc,
  defaultCollapsed,
  onClose,
}: {
  /** The bound collab doc (pcbnew: the board room; eeschema: the ACTIVE
   *  sheet's room). Null when no doc room is bound (?collab=0) — the panel
   *  then shows selection counts only. */
  doc: Y.Doc | null;
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

  const selection = React.useSyncExternalStore(subscribeLocalSelection, getLocalSelection);

  // Re-summarize when a remote edit touches the item map (the panel shows
  // live values, not select-time snapshots). A plain version counter — the
  // memo below re-reads the Y state.
  const [itemsVersion, setItemsVersion] = React.useState(0);
  React.useEffect(() => {
    if (!doc) return;
    const items = kicadItemsMap(doc);
    const state = doc.getMap(Y_KDOC_STATE);
    const bump = () => setItemsVersion((v) => v + 1);
    items.observeDeep(bump);
    // v3 may replace the complete active subtree after concurrent first-seed
    // arbitration. The root observer follows both that swap and all subsequent
    // changes inside the winning subtree.
    state.observeDeep(bump);
    return () => {
      items.unobserveDeep(bump);
      state.unobserveDeep(bump);
    };
  }, [doc]);

  const summaries: ItemSummary[] = React.useMemo(() => {
    if (!doc) return [];
    const items = kicadItemsMap(doc);
    const itemOf = (uuid: string): KicadItem | undefined => {
      const ym = items.get(uuid);
      if (!ym) return undefined;
      try {
        return yToItemUnchecked(ym);
      } catch {
        return undefined;
      }
    };
    const netName = netNameResolver(kicadLayout(doc));
    return selection.uuids.slice(0, MAX_ITEMS).flatMap((uuid) => {
      const item = itemOf(uuid);
      return item ? [summarizeItem({ uuid, item, itemOf, netName })] : [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selection, itemsVersion]);

  const count = selection.uuids.length;

  // Default anchor: TOP-LEFT (the layer panel owns the top-right stack under
  // the overlay-menu FAB). Clear of the transient status chip (left-3 top-3,
  // pointer-events-none anyway).
  const style: React.CSSProperties = drag.pos
    ? { left: drag.pos.x, top: drag.pos.y }
    : { left: 12, top: 12 };

  return (
    <div
      ref={rootRef}
      data-testid="inspector-panel"
      className="absolute z-40 flex w-72 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
      style={style}
    >
      {/* Header = drag handle. Interactive children stop pointerdown so they
          don't start a drag. */}
      <div
        data-testid="inspector-panel-header"
        className="flex cursor-grab select-none items-center gap-2 px-3 py-2 text-xs font-semibold active:cursor-grabbing"
        style={{ touchAction: "none" }}
        title="Inspector — drag to move"
        onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
        onPointerMove={(e) => void drag.onPointerMove(e)}
        onPointerUp={() => void drag.onPointerUp()}
      >
        <button
          data-testid="inspector-panel-collapse"
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse to header"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span>
          Inspector
          {count > 0 && (
            <span className="ml-1 font-normal text-neutral-400 dark:text-white/40">
              ({count})
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
          <button
            data-testid="inspector-panel-close"
            title="Close"
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X size={14} />
          </button>
        </span>
      </div>

      {!collapsed && (
        <div data-testid="inspector-panel-list" className="max-h-[60vh] overflow-y-auto pb-1">
          {count === 0 && (
            <p data-testid="inspector-empty" className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              Click an item on the canvas to inspect it.
            </p>
          )}
          {count > 0 && summaries.length === 0 && (
            <p className="px-3 pb-3 text-xs text-neutral-500 dark:text-white/50">
              {count} item{count === 1 ? "" : "s"} selected.
            </p>
          )}
          {summaries.map((s) => (
            <div
              key={s.uuid}
              data-testid="inspector-item"
              data-item-type={s.type}
              className="border-t border-black/5 px-3 py-2 dark:border-white/5"
            >
              <div className="truncate text-xs font-semibold" title={s.title}>
                {s.title}
              </div>
              {s.rows.map((r, i) => (
                <div key={i} className="mt-0.5 flex items-baseline gap-2 text-[11px]">
                  <span className="w-20 shrink-0 text-neutral-400 dark:text-white/40">
                    {r.label}
                  </span>
                  <span className="min-w-0 break-words text-neutral-800 dark:text-white/85">
                    {r.value}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {count > MAX_ITEMS && (
            <p className="border-t border-black/5 px-3 py-2 text-[11px] text-neutral-400 dark:border-white/5 dark:text-white/40">
              +{count - MAX_ITEMS} more selected
            </p>
          )}
        </div>
      )}
    </div>
  );
}
