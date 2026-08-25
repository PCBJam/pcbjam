// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import { Loader2 } from "lucide-react";
import type { SaveBlock } from "@/wasm/save-flow";
import { libSyncLabel } from "./DownloadConsent";
import type { LibSetNotice } from "./useLibNotices";

/**
 * Every transient notice the running editor shows over the canvas: the
 * bottom-left progress badges (lib pre-sync, 3D models), the busy pill, the
 * durable save-blocked banner and the top-center toast column (lib error,
 * placed-item update, lib-set change, doc revert). State + timers live in
 * useLibNotices; this is the render.
 */
export function NoticeStack({
  ready,
  libSync,
  modelsSync,
  libBusy,
  saveBlocked,
  libError,
  onDismissLibError,
  libUpdate,
  onDismissLibUpdate,
  libSetNotice,
  onLibSetClick,
  docReverted,
  onDismissDocReverted,
}: {
  ready: boolean;
  libSync: { kind: string; done: number; total: number } | null;
  modelsSync: string | null;
  libBusy: string | null;
  saveBlocked: SaveBlock | null;
  libError: string | null;
  onDismissLibError: () => void;
  libUpdate: string | null;
  onDismissLibUpdate: () => void;
  libSetNotice: LibSetNotice | null;
  onLibSetClick: () => void;
  docReverted: string | null;
  onDismissDocReverted: () => void;
}) {
  return (
    <>
      {/* Lib pre-sync warming IDB after the editor opened (big set) — the ONLY
          surface for it now that the warm-up starts post-open: a small unobtrusive
          indicator so the user knows browsing is still filling in behind them,
          never something they are waiting on. */}
      {ready && libSync && (
        <div className="pointer-events-none absolute bottom-9 left-3 z-20 flex items-center gap-2 rounded bg-black/80 px-3 py-1.5 font-mono text-xs text-emerald-200">
          <Loader2 className="animate-spin" size={14} />{" "}
          <span className="whitespace-pre">{libSyncLabel(libSync)}</span>
        </div>
      )}

      {/* Board 3D models still prefetching into the cache (background). */}
      {ready && modelsSync && (
        <div className="pointer-events-none absolute bottom-[4.25rem] left-3 z-20 flex items-center gap-2 rounded bg-black/80 px-3 py-1.5 text-xs text-sky-200">
          <Loader2 className="animate-spin" size={14} /> {modelsSync}
        </div>
      )}

      {/* A library item is being fetched (open/save). */}
      {ready && libBusy && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded bg-black/80 px-3 py-1.5 text-xs text-white">
          <Loader2 className="animate-spin" size={14} /> Loading {libBusy}…
        </div>
      )}

      {/* A save path is durably BLOCKED (CAS conflict / unknown commit state) —
          persistent full-width banner, no auto-dismiss: subsequent Ctrl+S on
          the path is absorbed by the save lane, so this must stay visible. */}
      {saveBlocked && (
        <div
          data-testid="save-blocked-banner"
          className="absolute inset-x-0 top-0 z-40 bg-red-900/95 px-4 py-2 text-center text-xs font-medium text-red-100 shadow-lg"
        >
          {saveBlocked.message}
        </div>
      )}

      {/* Top-center toast column: simultaneous notices stack instead of
          overlapping (they all used to render at the same absolute spot). */}
      <div className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
        {/* Library error (e.g. a backend 404 on open) — auto-dismisses. */}
        {libError && (
          <button
            className="max-w-md rounded bg-red-950/95 px-3 py-2 text-center text-xs text-red-100 shadow-lg ring-1 ring-red-500/40"
            onClick={onDismissLibError}
            title="Dismiss"
          >
            {libError}
          </button>
        )}

        {/* A collaborator updated a symbol PLACED in this document — auto-dismisses. */}
        {libUpdate && (
          <button
            data-testid="lib-update-toast"
            className="max-w-md rounded bg-amber-950/95 px-3 py-2 text-center text-xs text-amber-100 shadow-lg ring-1 ring-amber-500/40"
            onClick={onDismissLibUpdate}
            title="Dismiss"
          >
            {libUpdate}
          </button>
        )}

        {/* A peer changed the team's lib set — click loads the new lib live
            (kicadLibsAddEntry bridge), falling back to a reload offer. */}
        {libSetNotice && (
          <button
            data-testid="lib-set-toast"
            className="max-w-md rounded bg-sky-950/95 px-3 py-2 text-center text-xs text-sky-100 shadow-lg ring-1 ring-sky-500/40"
            onClick={onLibSetClick}
            title={libSetNotice.mode === "reload" ? "Reload" : "Load the new library"}
          >
            {libSetNotice.message}
          </button>
        )}

        {/* Backend rolled this doc back to the last valid state (kicad-validity). */}
        {docReverted && (
          <button
            data-testid="doc-reverted-toast"
            className="max-w-md rounded bg-orange-950/95 px-3 py-2 text-center text-xs text-orange-100 shadow-lg ring-1 ring-orange-500/40"
            onClick={onDismissDocReverted}
            title="Dismiss"
          >
            {docReverted}
          </button>
        )}
      </div>
    </>
  );
}
