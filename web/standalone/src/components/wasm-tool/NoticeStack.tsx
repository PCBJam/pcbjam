// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import { Loader2 } from "lucide-react";
import type { SaveBlock } from "@/wasm/save-flow";
import { libSyncLabel } from "./DownloadConsent";
import type { CrossProbeNotice } from "./cross-probe";
import type { LibSetNotice } from "./useLibNotices";
import type { SharedTabsNotice } from "@/recovery/useTabCensus";
import { toast, type ExternalToast } from "@pcbjam/ui";
import * as React from "react";

/** The open document was deleted / moved by a collaborator's file op
 *  (project-page 0003): nothing typed from here on can be saved. */
export interface FileGoneNotice {
  path: string;
  by: string | null;
  /** Set for a move: editor URL of the file's new home. */
  movedTo?: { path: string; href: string };
}

/**
 * Every transient notice the running editor shows over the canvas: the
 * bottom-left progress badges (lib pre-sync, 3D models), the busy pill, the
 * durable save-blocked banner and the toasts (lib error, placed-item update,
 * lib-set change, doc revert, cross-probe, shared tabs; Sonner, from the
 * Toaster at the app root). State + timers live in useLibNotices; this is the
 * render.
 */
export function NoticeStack({
  ready,
  libSync,
  modelsSync,
  libBusy,
  saveBlocked,
  fileGone,
  libError,
  onDismissLibError,
  libUpdate,
  onDismissLibUpdate,
  libSetNotice,
  onLibSetClick,
  onDismissLibSet,
  docReverted,
  onDismissDocReverted,
  crossProbeNotice,
  onDismissCrossProbeNotice,
  sharedTabs,
  onDismissSharedTabs,
}: {
  ready: boolean;
  libSync: { kind: string; done: number; total: number } | null;
  modelsSync: string | null;
  libBusy: string | null;
  saveBlocked: SaveBlock | null;
  fileGone?: FileGoneNotice | null;
  libError: string | null;
  onDismissLibError: () => void;
  libUpdate: string | null;
  onDismissLibUpdate: () => void;
  libSetNotice: LibSetNotice | null;
  onLibSetClick: () => void;
  onDismissLibSet?: () => void;
  docReverted: string | null;
  onDismissDocReverted: () => void;
  crossProbeNotice?: CrossProbeNotice | null;
  onDismissCrossProbeNotice?: () => void;
  /** Firefox: other editor tabs share this tab's process memory (0009). */
  sharedTabs?: SharedTabsNotice | null;
  onDismissSharedTabs?: () => void;
}) {
  // Library error (e.g. a backend 404 on open) — auto-dismisses.
  useNoticeToast("lib-error", libError, (message, o) => toast.error(message, { ...o, testId: "lib-error-toast" }), onDismissLibError);
  // A collaborator updated a symbol PLACED in this document — auto-dismisses.
  useNoticeToast("lib-update", libUpdate, (message, o) => toast.warning(message, { ...o, testId: "lib-update-toast" }), onDismissLibUpdate);
  // A peer changed the team's lib set — the action loads the new lib live
  // (kicadLibsAddEntry bridge), falling back to a reload offer.
  useNoticeToast(
    "lib-set",
    libSetNotice,
    (notice, o) =>
      toast.info(notice.message, {
        ...o,
        testId: "lib-set-toast",
        action: {
          label: notice.mode === "reload" ? "Reload" : "Load library",
          // The click turns the notice into a reload offer when live loading fails, so the
          // toast stays up; the notice's state decides when it goes.
          onClick: (event) => {
            event.preventDefault();
            onLibSetClick();
          },
        },
      }),
    onDismissLibSet,
  );
  // Backend rolled this doc back to the last valid state (kicad-validity).
  useNoticeToast("doc-reverted", docReverted, (message, o) => toast.warning(message, { ...o, testId: "doc-reverted-toast" }), onDismissDocReverted);
  useNoticeToast(
    "cross-probe",
    crossProbeNotice,
    (notice, o) =>
      toast(notice.text, {
        ...o,
        testId: "cross-probe-toast",
        action: notice.action && {
          label: notice.action.label,
          onClick: (event) => {
            event.preventDefault();
            notice.action?.run();
            onDismissCrossProbeNotice?.();
          },
        },
      }),
    onDismissCrossProbeNotice,
  );
  // Firefox: other editor tabs share this tab's process memory (0009) — stays until closed.
  useNoticeToast(
    "shared-tabs",
    sharedTabs,
    (notice, o) =>
      toast.warning(
        `${
          notice.tabs.length === 1
            ? "You have 1 other PCBJam editor open"
            : `You have ${notice.tabs.length} other PCBJam editors open`
        } (${notice.tabs.map((t) => t.title || t.url).join(", ")}). Firefox runs them in one process with one memory budget, so a large design may run out of memory. Close the ones you don't need.`,
        { ...o, testId: "shared-tabs-toast" },
      ),
    onDismissSharedTabs,
  );

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

      {/* The open file no longer exists under this name — persistent, above
          the save-blocked banner: it explains every symptom that follows. */}
      {fileGone && (
        <div
          data-testid="file-gone-banner"
          className="absolute inset-x-0 top-0 z-50 bg-red-900/95 px-4 py-2 text-center text-xs font-medium text-red-100 shadow-lg"
        >
          {fileGone.movedTo ? (
            <>
              {fileGone.path} was moved to {fileGone.movedTo.path} by {fileGone.by ?? "a collaborator"}.{" "}
              <a data-testid="file-gone-open" className="underline" href={fileGone.movedTo.href}>
                Open it there
              </a>{" "}
              — edits made here are no longer saved.
            </>
          ) : (
            <>
              {fileGone.path} was deleted by {fileGone.by ?? "a collaborator"} — edits made here are no
              longer saved.
            </>
          )}
        </div>
      )}
    </>
  );
}

let toastSerial = 0;

/**
 * Mirrors one notice into a toast. The notice's owner (useLibNotices, the tab census) keeps its
 * state and auto-dismiss timer, so the toast never closes on its own: it shows while the notice
 * is set, updates in place when the notice changes, and goes when it clears. Closing the toast
 * (its ×, or a swipe) clears the notice through `onDismiss`.
 */
function useNoticeToast<T>(
  key: string,
  notice: T | null | undefined,
  show: (notice: T, options: ExternalToast) => void,
  onDismiss?: () => void,
) {
  const latest = React.useRef({ show, onDismiss });
  latest.current = { show, onDismiss };
  // A fresh id each time the notice appears, so a toast still animating out can neither swallow
  // the next one nor, when its own close lands late, clear it.
  const idRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (notice == null) {
      if (idRef.current) toast.dismiss(idRef.current);
      idRef.current = null;
      return;
    }
    const id = (idRef.current ??= `${key}-${++toastSerial}`);
    latest.current.show(notice, {
      id,
      duration: Infinity,
      closeButton: true,
      onDismiss: (t) => {
        if (t.id === idRef.current) latest.current.onDismiss?.();
      },
    });
  }, [key, notice]);
  React.useEffect(
    () => () => {
      if (idRef.current) toast.dismiss(idRef.current);
    },
    [],
  );
}
