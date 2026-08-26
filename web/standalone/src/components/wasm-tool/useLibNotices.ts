// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import * as React from "react";
import {
  LIB_BUSY_EVENT,
  LIB_ERROR_EVENT,
  LIB_ITEM_UPDATED_EVENT,
  LIB_LOADING_EVENT,
  LIB_SET_CHANGED_EVENT,
  type LibBusyDetail,
  type LibErrorDetail,
  type LibItemUpdatedDetail,
  type LibLoadingDetail,
  type LibSetChangedDetail,
  type LibsSource,
} from "@/wasm/libs/source";
import { MODELS_LOADING_EVENT, type ModelsLoadingDetail } from "@/wasm/libs/models-bridge";
import { DOC_REVERTED_EVENT } from "@/wasm/collab/kicad-binding";
import { addAnnouncedLib } from "@/wasm/libs/runtime-add";
import { reloadFallbackMsg } from "./ui-helpers";

/** One library's placed items a peer updated (libs 0017 §2b). */
export interface StaleLibEntry {
  kind: string;
  lib: string;
  names: Set<string>;
}

export interface LibSetNotice {
  message: string;
  detail: LibSetChangedDetail;
  mode: "load" | "reload";
}

export interface LibLoadingState {
  kind: string;
  done: number;
  total: number;
}

/**
 * Every notice the running editor raises about its libraries and document —
 * the window events the libs bridge / collab binding dispatch, the transient
 * toasts they become (with their auto-dismiss timers), the persistent
 * "behind the library" state with its update-from-library action, and the
 * eager-load / 3D-model progress badges. Pure state + listeners; WasmTool
 * renders it through NoticeStack / SessionMenu / LibLoadingOverlay.
 */
export function useLibNotices(opts: {
  /** The one libs source instance the running editor uses (set by the boot
   *  effect) — the libset toast's action needs it to re-list and load. */
  getLibsSource: () => LibsSource | null;
}) {
  // A library item currently being fetched (open/save), for a transient spinner.
  const [libBusy, setLibBusy] = React.useState<string | null>(null);
  // Last lib error (e.g. a backend 404 on open), shown as a dismissible toast.
  const [libError, setLibError] = React.useState<string | null>(null);
  // A collaborator updated library items that are PLACED in the open document
  // (LIB_ITEM_UPDATED_EVENT) — placed copies keep the previous version, so warn.
  const [libUpdate, setLibUpdate] = React.useState<string | null>(null);
  // Persistent "behind the library" state (libs 0017 §2b): every PLACED item a
  // peer's lib edit touched, keyed `<kind>\u0000<lib>` → names. The toast above
  // is disposable; this survives until the user updates from the library
  // (2c) or dismisses it, and drives the FAB's amber triangle + the Document
  // section row. Symbols/footprints only — the kinds with a placed-usage
  // bridge (kicadLibsSymbolUsage / kicadLibsFootprintUsage).
  const [staleLibItems, setStaleLibItems] = React.useState<Map<string, StaleLibEntry>>(
    () => new Map(),
  );
  const [staleUpdating, setStaleUpdating] = React.useState(false);
  const staleKey = (kind: string, lib: string) => `${kind}\u0000${lib}`;
  const noteStale = React.useCallback((kind: string, lib: string, names: string[]) => {
    if (names.length === 0) return;
    setStaleLibItems((prev) => {
      const next = new Map(prev);
      const k = staleKey(kind, lib);
      const cur = next.get(k) ?? { kind, lib, names: new Set<string>() };
      const merged = new Set(cur.names);
      for (const n of names) merged.add(n);
      next.set(k, { kind, lib, names: merged });
      return next;
    });
  }, []);
  const clearStale = React.useCallback((key?: string) => {
    setStaleLibItems((prev) => {
      if (key === undefined) return new Map();
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);
  /** Update every placed instance of the stale items from the library (2c). */
  const updateStaleFromLibrary = React.useCallback(async () => {
    const mod = (window as {
      Module?: { kicadUpdateFromLibrary?: unknown; kicadLibsReload?: unknown };
    }).Module;
    const fn = mod?.kicadUpdateFromLibrary;
    const reload = mod?.kicadLibsReload;
    if (typeof fn !== "function") {
      setLibError("This editor build can't update placed items from the library — reload to refresh them.");
      return;
    }
    setStaleUpdating(true);
    try {
      for (const [key, entry] of staleLibItems) {
        // The bridge queues the edit on the frame's coroutine and answers
        // {queued:true}; the outcome arrives as a `pcbjam:lib-update-done`
        // window event (or {ok:false,error} synchronously).
        // libs 0019 F2: the remote edit only invalidated the caches — bring the
        // lib back to LOADED first (same coroutine queue, so it lands before
        // the exchange below).
        if (typeof reload === "function") {
          try {
            (reload as (kind: string, lib: string) => void)(entry.kind, entry.lib);
          } catch {
            /* the update below falls back to the lazy load */
          }
        }
        const done = new Promise<{ ok: boolean; updated?: number; missing?: string[]; error?: string }>((resolve) => {
          const onDone = (e: Event) => {
            window.removeEventListener("pcbjam:lib-update-done", onDone);
            resolve((e as CustomEvent<{ ok: boolean; updated?: number; missing?: string[] }>).detail);
          };
          window.addEventListener("pcbjam:lib-update-done", onDone);
          setTimeout(() => {
            window.removeEventListener("pcbjam:lib-update-done", onDone);
            resolve({ ok: false, error: "timed out" });
          }, 30_000);
        });
        let res: { ok?: boolean; queued?: boolean; error?: string } = {};
        try {
          res = JSON.parse(
            (fn as (kind: string, lib: string, namesJson: string) => string)(
              entry.kind,
              entry.lib,
              JSON.stringify([...entry.names]),
            ),
          ) as typeof res;
        } catch {
          res = { ok: false, error: "bridge call failed" };
        }
        const outcome = res.ok === false ? { ok: false, error: res.error } : await done;
        if (!outcome.ok) {
          setLibError(`Couldn't update from the library: ${outcome.error ?? "unknown error"}`);
          continue;
        }
        console.log(`[libs] updated ${outcome.updated ?? "?"} placed ${entry.kind}(s) from "${entry.lib}"`);
        // An open editor copy with local edits is left alone (0019 F3) — say so.
        if (outcome.missing && outcome.missing.length > 0) {
          setLibError(`Not updated: ${outcome.missing.join("; ")}`);
        }
        clearStale(key);
      }
    } finally {
      setStaleUpdating(false);
    }
  }, [staleLibItems, clearStale]);
  // The backend rolled this document back to its last valid state
  // (kicad-validity 0001 — DOC_REVERTED_EVENT from the collab binding).
  const [docReverted, setDocReverted] = React.useState<string | null>(null);
  // A peer changed the team's lib SET mid-session (LIB_SET_CHANGED_EVENT —
  // the scope room's `libset` broadcast). The lib table is frozen at boot, so
  // the toast's click action loads the new lib live (addAnnouncedLib), with a
  // reload fallback when the runtime bridge is missing.
  const [libSetNotice, setLibSetNotice] = React.useState<LibSetNotice | null>(null);
  // Eager whole-library idb→wasm load in flight (the ~tens-of-seconds fat-load on
  // first chooser/editor open). Drives a full-cover overlay so the freeze reads as
  // "loading, just slow" rather than a hang. Null when idle; `done/total` count the
  // per-lib fat-load crossings so the overlay can show a progress bar.
  const [libLoading, setLibLoading] = React.useState<LibLoadingState | null>(null);
  // Board 3D-model prefetch in flight (background; the viewer works without it —
  // anything still missing lazy-loads per model). Small badge, not an overlay.
  const [modelsSync, setModelsSync] = React.useState<string | null>(null);

  // Loading/error chrome for library item fetches (open/save), driven by events
  // the libs bridge dispatches (wasm/libs/source). The fetch is otherwise
  // invisible; a 404 would silently do nothing without this.
  React.useEffect(() => {
    let busyTimer: ReturnType<typeof setTimeout> | undefined;
    const onBusy = (e: Event) => {
      const d = (e as CustomEvent<LibBusyDetail>).detail;
      clearTimeout(busyTimer);
      if (d.busy) {
        // Debounce — only flag slow fetches, so fast ones don't flicker.
        busyTimer = setTimeout(() => setLibBusy(d.name || "library item"), 180);
      } else {
        setLibBusy(null);
      }
    };
    const onError = (e: Event) => {
      setLibError((e as CustomEvent<LibErrorDetail>).detail.message);
    };
    const onItemUpdated = (e: Event) => {
      const d = (e as CustomEvent<LibItemUpdatedDetail>).detail;
      // Only warn when the update touches something PLACED here — the library
      // tree already reflects updates to everything else. Both kinds have a
      // placed-usage bridge now (libs 0017 §2d added the footprint one).
      if (d.usedNames.length === 0) return;
      const label = d.kind === "footprint" ? "Footprint" : "Symbol";
      const names = d.usedNames.map((n) => `"${n}"`).join(", ");
      noteStale(d.kind, d.lib, d.usedNames);
      setLibUpdate(
        `${d.usedNames.length === 1 ? label : `${label}s`} ${names} in "${d.lib}" ` +
          `${d.usedNames.length === 1 ? "was" : "were"} updated by a collaborator — ` +
          `placed copies keep the previous version. Update them from the session menu.`,
      );
    };
    const onDocReverted = (e: Event) => {
      const d = (e as CustomEvent<{ reason?: string; at?: string }>).detail;
      setDocReverted(
        `This document was rolled back to its last valid state — invalid content ` +
          `was detected${d?.reason ? ` (${d.reason})` : ""}. Recent edits may have been undone.`,
      );
    };
    const onLibSet = (e: Event) => {
      const d = (e as CustomEvent<LibSetChangedDetail>).detail;
      // Only additions get a call to action — a removed lib's table row is
      // inert until the next boot and needs no interruption.
      if (d.op !== "add") return;
      setLibSetNotice({
        message: d.name
          ? `A collaborator added library "${d.name}" — click to load it into this session.`
          : `A collaborator added a new library — click to load it into this session.`,
        detail: d,
        mode: "load",
      });
    };
    window.addEventListener(LIB_BUSY_EVENT, onBusy);
    window.addEventListener(LIB_ERROR_EVENT, onError);
    window.addEventListener(LIB_ITEM_UPDATED_EVENT, onItemUpdated);
    window.addEventListener(LIB_SET_CHANGED_EVENT, onLibSet);
    window.addEventListener(DOC_REVERTED_EVENT, onDocReverted);
    return () => {
      clearTimeout(busyTimer);
      window.removeEventListener(LIB_BUSY_EVENT, onBusy);
      window.removeEventListener(LIB_ERROR_EVENT, onError);
      window.removeEventListener(LIB_ITEM_UPDATED_EVENT, onItemUpdated);
      window.removeEventListener(LIB_SET_CHANGED_EVENT, onLibSet);
      window.removeEventListener(DOC_REVERTED_EVENT, onDocReverted);
    };
  }, [noteStale]);

  // Auto-dismiss the lib error toast.
  React.useEffect(() => {
    if (!libError) return;
    const t = setTimeout(() => setLibError(null), 6000);
    return () => clearTimeout(t);
  }, [libError]);

  // Auto-dismiss the lib update toast (a touch longer — it carries a caveat).
  React.useEffect(() => {
    if (!libUpdate) return;
    const t = setTimeout(() => setLibUpdate(null), 10_000);
    return () => clearTimeout(t);
  }, [libUpdate]);

  // Auto-dismiss the lib-set toast (long — it carries a click action).
  React.useEffect(() => {
    if (!libSetNotice) return;
    const t = setTimeout(() => setLibSetNotice(null), 30_000);
    return () => clearTimeout(t);
  }, [libSetNotice]);

  // Auto-dismiss the doc-reverted toast (longest — the user should see it).
  React.useEffect(() => {
    if (!docReverted) return;
    const t = setTimeout(() => setDocReverted(null), 15_000);
    return () => clearTimeout(t);
  }, [docReverted]);

  // Full-library eager load overlay. The fat-load fires one loading:true/false
  // pair PER library (222 on the full set), and between them the C++ side parses
  // with the main thread blocked. Show immediately on `true`, and only hide after
  // a short quiet gap on `false` (reset by the next lib's `true`) — so the overlay
  // stays continuous across the whole run and drops shortly after the last lib,
  // instead of flickering 222 times.
  React.useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const onLoading = (e: Event) => {
      const d = (e as CustomEvent<LibLoadingDetail>).detail;
      clearTimeout(hideTimer);
      // Update the bar on every event (true and false) so the count reflects the
      // latest lib; arm the hide only when the run reports it's winding down.
      setLibLoading({ kind: d.kind || "library", done: d.done, total: d.total });
      if (!d.loading) {
        hideTimer = setTimeout(() => setLibLoading(null), 700);
      }
    };
    window.addEventListener(LIB_LOADING_EVENT, onLoading);
    return () => {
      clearTimeout(hideTimer);
      window.removeEventListener(LIB_LOADING_EVENT, onLoading);
    };
  }, []);

  // Board 3D-model prefetch progress (models-bridge prescan) — background badge.
  React.useEffect(() => {
    const onModels = (e: Event) => {
      const d = (e as CustomEvent<ModelsLoadingDetail>).detail;
      setModelsSync(
        d.loading ? `Fetching 3D models — ${d.done}/${d.total}` : null,
      );
    };
    window.addEventListener(MODELS_LOADING_EVENT, onModels);
    return () => window.removeEventListener(MODELS_LOADING_EVENT, onModels);
  }, []);

  const { getLibsSource } = opts;
  /** The libset toast's click: load the announced lib live, else offer a reload. */
  const onLibSetClick = React.useCallback(() => {
    const notice = libSetNotice;
    if (!notice) return;
    if (notice.mode === "reload") {
      window.location.reload();
      return;
    }
    const source = getLibsSource();
    if (!source) {
      setLibSetNotice({ ...notice, mode: "reload", message: reloadFallbackMsg(notice) });
      return;
    }
    setLibSetNotice(null);
    void addAnnouncedLib(source, notice.detail, (m) => console.log(m)).then((ok) => {
      if (!ok) {
        setLibSetNotice({ ...notice, mode: "reload", message: reloadFallbackMsg(notice) });
      }
    });
  }, [libSetNotice, getLibsSource]);

  const dismissLibError = React.useCallback(() => setLibError(null), []);
  const dismissLibUpdate = React.useCallback(() => setLibUpdate(null), []);
  const dismissDocReverted = React.useCallback(() => setDocReverted(null), []);

  return {
    libBusy,
    libError,
    dismissLibError,
    libUpdate,
    dismissLibUpdate,
    libSetNotice,
    onLibSetClick,
    docReverted,
    dismissDocReverted,
    libLoading,
    modelsSync,
    staleLibItems,
    staleUpdating,
    clearStale,
    updateStaleFromLibrary,
  };
}
