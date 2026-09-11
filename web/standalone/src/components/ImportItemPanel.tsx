import * as React from "react";
import { ChevronDown, ChevronRight, FilePlus, X } from "lucide-react";
import type { Tool } from "@pcbjam/shared";
import { useDraggablePanel } from "@/components/useDraggablePanel";
import {
  applyEnvelope,
  buildFootprintImport,
  buildSymbolImport,
  glCanvasRect,
  kindForFile,
  placementAtCssPx,
  placementMm,
  readViewport,
  symbolNames,
  type CssRect,
  type ImportKind,
  type ImportModule,
} from "@/wasm/import-item";

/**
 * POC "plugin" sidebar (import-item): pick a `.kicad_sym` / `.kicad_mod` from
 * the local filesystem (file picker or drag-and-drop onto the panel) and add
 * it to the open canvas: "Add to canvas" arms a click catcher over the GAL
 * canvas and the next click is the drop point (Esc cancels; the viewport
 * centre is the fallback when no canvas rect is found). Placement goes
 * through the editor's collab apply bridge — see wasm/import-item.ts for
 * the contract and caveats.
 *
 * Same draggable-panel conventions as LayerPanel (header = drag handle,
 * collapse-to-header, position persisted).
 */

const PANEL_POS_KEY = "pcbjam:import-panel-pos";
const PANEL_W = 288; // w-72
const PANEL_HEADER_H = 36;

interface Picked {
  fileName: string;
  text: string;
  kind: ImportKind;
  /** Symbol libs can hold many symbols; the user picks one. */
  names: string[];
}

const kindForTool = (tool: Tool): ImportKind | null =>
  tool === "eeschema" ? "symbol" : tool === "pcbnew" ? "footprint" : null;

export function ImportItemPanel({
  mod,
  tool,
  onClose,
}: {
  mod: ImportModule;
  tool: Tool;
  onClose: () => void;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const drag = useDraggablePanel({
    storageKey: PANEL_POS_KEY,
    handleWidth: PANEL_W,
    handleHeight: PANEL_HEADER_H,
  });
  const [collapsed, setCollapsed] = React.useState(false);
  const [picked, setPicked] = React.useState<Picked | null>(null);
  const [symbol, setSymbol] = React.useState<string>("");
  const [dragOver, setDragOver] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  /** Armed click catcher: the GAL canvas rect it covers. */
  const [placing, setPlacing] = React.useState<CssRect | null>(null);

  const wanted = kindForTool(tool);

  const take = async (file: File) => {
    const kind = kindForFile(file.name);
    if (!kind) {
      setStatus({ kind: "err", text: `${file.name}: pick a .kicad_sym or .kicad_mod file.` });
      return;
    }
    const text = await file.text();
    const names = kind === "symbol" ? symbolNames(text) : [];
    if (kind === "symbol" && names.length === 0) {
      setStatus({ kind: "err", text: `${file.name}: no symbols found in this library.` });
      return;
    }
    setPicked({ fileName: file.name, text, kind, names });
    setSymbol(names[0] ?? "");
    setStatus(
      kind === wanted
        ? { kind: "info", text: `${file.name} ready — ${kind === "symbol" ? `${names.length} symbol(s)` : "footprint"}.` }
        : { kind: "err", text: `${file.name} is a ${kind}; this is ${tool}. Open the ${kind === "symbol" ? "schematic" : "board"} to place it.` },
    );
  };

  /** Build + apply the blob at (x, y) mm. */
  const placeAt = (at: { x: number; y: number }, how: string) => {
    if (!picked || picked.kind !== wanted) return;
    try {
      let sexpr: string;
      let label: string;
      if (picked.kind === "symbol") {
        const nick = picked.fileName.replace(/\.kicad_sym$/i, "");
        const r = buildSymbolImport(picked.text, symbol || undefined, nick, at.x, at.y);
        sexpr = r.sexpr;
        label = `${r.libId} as ${r.reference}`;
      } else {
        const r = buildFootprintImport(picked.text, at.x, at.y);
        sexpr = r.sexpr;
        label = r.name;
      }
      // The apply runs deferred on the editor's coroutine; a parse failure is
      // logged by the C++ side (`[collab] … parse`), not thrown here.
      void mod.kicadCollabApplyItems(applyEnvelope(sexpr));
      setStatus({ kind: "ok", text: `Added ${label} at ${at.x} mm, ${at.y} mm (${how}).` });
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  };

  /** "Add to canvas": arm the click catcher (or drop at the centre if the
   *  canvas can't be located). */
  const add = () => {
    if (!picked || picked.kind !== wanted) return;
    if (mod.kicadOpenFileBusy?.()) {
      setStatus({ kind: "err", text: "The editor is still loading — try again in a moment." });
      return;
    }
    const rect = glCanvasRect();
    if (!rect || !readViewport(mod)) {
      placeAt(placementMm(mod, picked.kind), "viewport centre");
      return;
    }
    setPlacing(rect);
    setStatus({ kind: "info", text: "Click on the canvas where you want it (Esc to cancel)." });
  };

  const onCatcherClick = (e: React.MouseEvent) => {
    if (!picked) return;
    // Re-read both at click time: the user may have panned/zoomed (wheel goes
    // through the catcher to the canvas) or resized since arming.
    const rect = glCanvasRect() ?? placing;
    const vp = readViewport(mod);
    setPlacing(null);
    if (!rect || !vp) {
      placeAt(placementMm(mod, picked.kind), "viewport centre");
      return;
    }
    placeAt(placementAtCssPx(vp, rect, { x: e.clientX, y: e.clientY }, picked.kind), "clicked point");
  };

  React.useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPlacing(null);
        setStatus({ kind: "info", text: "Placement cancelled." });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing]);

  const style: React.CSSProperties = drag.pos
    ? { left: drag.pos.x, top: drag.pos.y }
    : { right: 12, top: 100 };

  const iconBtn =
    "rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white";
  const canAdd = picked !== null && picked.kind === wanted;

  return (
    <>
      {/* Click catcher over the drawing area only (fixed: the panel's own
          offset parent is irrelevant). Wheel/pan still reach the canvas. */}
      {placing && (
        <div
          data-testid="import-click-catcher"
          className="fixed z-50 cursor-crosshair"
          style={{ left: placing.x, top: placing.y, width: placing.width, height: placing.height }}
          onClick={onCatcherClick}
        />
      )}
    <div
      ref={rootRef}
      data-testid="import-panel"
      className="absolute z-40 flex w-72 flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15"
      style={style}
    >
      <div
        data-testid="import-panel-header"
        className="flex cursor-grab select-none items-center gap-2 px-3 py-2 text-xs font-semibold active:cursor-grabbing"
        style={{ touchAction: "none" }}
        title="Import from file — drag to move"
        onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
        onPointerMove={(e) => void drag.onPointerMove(e)}
        onPointerUp={() => void drag.onPointerUp()}
      >
        <button
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse to header"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed(!collapsed)}
          className={iconBtn}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <FilePlus size={14} className="text-neutral-400 dark:text-white/50" />
        <span>Import from file</span>
        <span className="ml-auto" onPointerDown={(e) => e.stopPropagation()}>
          <button data-testid="import-panel-close" title="Close" onClick={onClose} className={iconBtn}>
            <X size={14} />
          </button>
        </span>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-2 px-3 pb-3 text-xs">
          <div
            data-testid="import-dropzone"
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-3 py-4 text-center ${
              dragOver
                ? "border-sky-500 bg-sky-500/10"
                : "border-neutral-300 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
            }`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void take(f);
            }}
          >
            <span className="font-medium">
              Drop a {wanted === "symbol" ? ".kicad_sym" : wanted === "footprint" ? ".kicad_mod" : ".kicad_sym / .kicad_mod"} here
            </span>
            <span className="text-neutral-500 dark:text-white/50">or click to choose a file</span>
            <input
              ref={inputRef}
              data-testid="import-file-input"
              type="file"
              accept=".kicad_sym,.kicad_mod"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void take(f);
                e.target.value = "";
              }}
            />
          </div>

          {picked && (
            <div className="flex flex-col gap-1.5">
              <div className="truncate" title={picked.fileName}>
                <span className="text-neutral-500 dark:text-white/50">File: </span>
                {picked.fileName}
              </div>
              {picked.kind === "symbol" && picked.names.length > 1 && (
                <label className="flex items-center gap-2">
                  <span className="text-neutral-500 dark:text-white/50">Symbol</span>
                  <select
                    data-testid="import-symbol-select"
                    className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1 py-0.5 dark:border-white/20 dark:bg-neutral-900"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                  >
                    {picked.names.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          <button
            data-testid="import-add"
            disabled={!canAdd || placing !== null}
            onClick={add}
            className="rounded-md bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {placing ? "Click on the canvas…" : "Add to canvas"}
          </button>

          {status && (
            <p
              data-testid="import-status"
              data-kind={status.kind}
              className={
                status.kind === "err"
                  ? "text-red-600 dark:text-red-400"
                  : status.kind === "ok"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-neutral-500 dark:text-white/50"
              }
            >
              {status.text}
            </p>
          )}
        </div>
      )}
    </div>
    </>
  );
}
