import { MEMFS_PROJECTS_DIR, memfsProjectDir } from "./constants";

/** Transport-independent result of one persistence attempt. */
export type SaveOutcome =
  | { kind: "committed" }
  | { kind: "not-committed"; message?: string }
  | { kind: "conflict"; message?: string }
  | { kind: "unknown"; message?: string };

export const SAVE_COMMITTED = Object.freeze({ kind: "committed" } as const);

/** A path whose in-memory ancestry is no longer safe to publish. */
export interface SaveBlock {
  relPath: string;
  kind: "conflict" | "unknown";
  message: string;
}

/**
 * Persist one saved file's bytes outside MEMFS. The counterpart of
 * `fetchBytes` on the load side: each page decides the destination —
 * API upload (backend projects), local-disk write-back / download (local
 * folders). Absent ⇒ saves stay MEMFS-only (e.g. Y.Doc-backed sessions,
 * where the provider already persists the document).
 */
export type SaveBytes = (
  relPath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
) => Promise<SaveOutcome>;

/** Active plus latest save snapshots retained by one registered hook. */
export const MAX_RETAINED_SAVE_BYTES = 64 * 1024 * 1024;
/** One active lane per distinct path; each lane retains at most two snapshots. */
export const MAX_SAVE_PATHS = 256;

interface SaveSnapshot {
  bytes: Uint8Array;
  generation: number;
}

interface SaveLane {
  active?: SaveSnapshot;
  pending?: SaveSnapshot;
  activeController?: AbortController;
}

function normalizeSaveOutcome(outcome: unknown, relPath: string): SaveOutcome {
  if (typeof outcome === "object" && outcome !== null && "kind" in outcome) {
    const candidate = outcome as { kind?: unknown; message?: unknown };
    if (
      candidate.kind === "committed" ||
      candidate.kind === "not-committed" ||
      candidate.kind === "conflict" ||
      candidate.kind === "unknown"
    ) {
      return typeof candidate.message === "string"
        ? { kind: candidate.kind, message: candidate.message }
        : { kind: candidate.kind };
    }
  }
  return {
    kind: "unknown",
    message: `Save state unknown: ${relPath} — reload or save a copy`,
  };
}

export interface SaveHookWindow {
  FS?: EmscriptenFS;
  kicadCollab?: { onSave?: (absPath: string) => void };
}

export interface SaveHookHandle {
  /**
   * Retire this exact hook lifetime.
   *
   * Aborts every active transport, releases every queued latest snapshot and
   * removes this hook only when it still owns the global callback slot.
   */
  stop(): void;
}

/**
 * Register the C++ → JS save notification sink (`window.kicadCollab.onSave`).
 * The kicad fork fires it from each tool's save chokepoint (SaveDrawingSheetFile /
 * saveSchematicFile / SavePcbFile) AFTER the bytes hit MEMFS, so the handler just
 * reads them back and routes them to `saveBytes`. eeschema may fire once per
 * sheet file in a multi-sheet save — each call is one complete file.
 */
export function registerSaveHook(
  win: SaveHookWindow,
  opts: {
    slug: string;
    saveBytes?: SaveBytes;
    log: (msg: string) => void;
    onStatus: (text: string) => void;
    /**
     * Fired with every saved project-relative path BEFORE persistence (so it runs even
     * when `saveBytes` is absent, e.g. Y.Doc-backed sessions). The hierarchical-sheet
     * collab manager uses it to discover + warm a sheet file created mid-session
     * ("Add Sheet"), which the page-load file list can't contain.
     */
    onSaved?: (relPath: string) => void;
    /**
     * Like `onSaved` but with the saved file's TEXT (read back from MEMFS).
     * The collab layout save-sync (miss 08B) uses it to reconcile non-item
     * document state (title block, paper, setup…) into the room doc.
     */
    onSavedText?: (relPath: string, text: string) => void;
    /** Test/host override. Admission fails before copying above this total. */
    maxRetainedBytes?: number;
    /** Test/host override for concurrently active distinct paths. */
    maxPaths?: number;
    /** Durable per-path safety block; only hook retirement clears it. */
    onBlocked?: (block: SaveBlock) => void;
  },
): SaveHookHandle {
  const maxRetainedBytes = opts.maxRetainedBytes ?? MAX_RETAINED_SAVE_BYTES;
  const maxPaths = opts.maxPaths ?? MAX_SAVE_PATHS;
  if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 0) {
    throw new RangeError(`maxRetainedBytes must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(maxPaths) || maxPaths < 1) {
    throw new RangeError(`maxPaths must be a positive safe integer`);
  }
  const projectPrefix = `${memfsProjectDir(opts.slug)}/`;
  // The editor's default "projects" home (KiCad's GetDefaultUserProjectsPath) — one
  // level above this project's own folder. A blank editor's Save-As lands HERE, not in
  // the project subfolder, so we also accept a bare file saved directly in it: the page
  // holds exactly one project in MEMFS, so such a file belongs to it. (Files under the
  // project's own folder still take the first branch, with their full relative path.)
  const projectsHome = `${MEMFS_PROJECTS_DIR}/`;
  // Each file has one active write and one replaceable latest snapshot. This
  // keeps call order without retaining every intermediate Ctrl+S payload.
  const persistenceLanes = new Map<string, SaveLane>();
  const blockedPaths = new Map<string, SaveBlock>();
  let retainedBytes = 0;
  // The status surface is global. Only the newest save notification may
  // publish an asynchronous result or clear a newer result.
  let statusGeneration = 0;
  let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** Saved MEMFS path → project-relative path, or null if it's outside the project. */
  const toRelPath = (absPath: string): string | null => {
    if (absPath.startsWith(projectPrefix)) return absPath.slice(projectPrefix.length);
    if (absPath.startsWith(projectsHome)) {
      const rest = absPath.slice(projectsHome.length);
      if (rest && !rest.includes("/")) return rest; // a bare file in the projects home
    }
    return null;
  };

  const releaseSnapshot = (snapshot: SaveSnapshot | undefined): void => {
    if (!snapshot) return;
    retainedBytes -= snapshot.bytes.byteLength;
  };

  const reportCapacityFailure = (
    relPath: string,
    generation: number,
    reason: "paths" | "bytes",
    bytes: number,
  ): void => {
    const detail =
      reason === "paths"
        ? `${maxPaths} active paths`
        : `${retainedBytes + bytes} > ${maxRetainedBytes} retained bytes`;
    opts.log(`[save] FAILED to queue ${relPath}: save queue capacity (${detail})`);
    if (generation === statusGeneration) {
      opts.onStatus(`Save failed: ${relPath} — save queue is full`);
    }
  };

  const retireUncommittedLane = (
    relPath: string,
    lane: SaveLane,
    snapshot: SaveSnapshot,
    controller: AbortController,
  ): number => {
    const terminalGeneration = lane.pending?.generation ?? snapshot.generation;
    releaseSnapshot(lane.pending);
    lane.pending = undefined;
    releaseSnapshot(snapshot);
    lane.active = undefined;
    if (lane.activeController === controller) lane.activeController = undefined;
    persistenceLanes.delete(relPath);
    return terminalGeneration;
  };

  const startPersistence = (relPath: string, lane: SaveLane): void => {
    const snapshot = lane.active;
    if (!snapshot) return;
    const controller = new AbortController();
    lane.activeController = controller;

    let persistence: Promise<SaveOutcome>;
    try {
      persistence = Promise.resolve(
        opts.saveBytes!(relPath, snapshot.bytes, controller.signal),
      );
    } catch (error) {
      persistence = Promise.reject(error);
    }

    void persistence
      .then(
        (rawOutcome) => {
          if (stopped) return;
          const outcome = normalizeSaveOutcome(rawOutcome, relPath);
          if (outcome.kind !== "committed") {
            const terminalGeneration = retireUncommittedLane(
              relPath,
              lane,
              snapshot,
              controller,
            );

            if (outcome.kind === "conflict" || outcome.kind === "unknown") {
              const block: SaveBlock = {
                relPath,
                kind: outcome.kind,
                message:
                  outcome.message ??
                  (outcome.kind === "conflict"
                    ? `Save conflict: ${relPath} — reload or merge, or save a copy`
                    : `Save state unknown: ${relPath} — reload or save a copy`),
              };
              blockedPaths.set(relPath, block);
              opts.log(`[save] BLOCKED ${relPath}: ${block.message}`);
              opts.onBlocked?.(block);
              if (terminalGeneration === statusGeneration) {
                opts.onStatus(block.message);
              }
            } else if (terminalGeneration === statusGeneration) {
              opts.onStatus(
                outcome.message ?? `Save failed: ${relPath} — see console`,
              );
            }
            return;
          }
          opts.log(
            `[save] ${relPath} persisted (${snapshot.bytes.length} bytes)`,
          );
          if (snapshot.generation !== statusGeneration) return;
          opts.onStatus(`Saved ${relPath} ✓`);
          statusClearTimer = setTimeout(() => {
            statusClearTimer = undefined;
            if (snapshot.generation === statusGeneration) opts.onStatus("");
          }, 2500);
        },
        (error) => {
          if (stopped) return;
          opts.log(`[save] FAILED to persist ${relPath}: ${String(error)}`);
          // An unexpected throw has unknown commit state. It is equivalent to
          // an explicit unknown outcome and permanently blocks this path.
          const terminalGeneration = retireUncommittedLane(
            relPath,
            lane,
            snapshot,
            controller,
          );
          const block: SaveBlock = {
            relPath,
            kind: "unknown",
            message: `Save state unknown: ${relPath} — reload or save a copy`,
          };
          blockedPaths.set(relPath, block);
          opts.onBlocked?.(block);
          if (terminalGeneration === statusGeneration) {
            opts.onStatus(block.message);
          }
        },
      )
      .finally(() => {
        if (stopped) return;
        if (lane.active !== snapshot) return;
        if (lane.activeController === controller) lane.activeController = undefined;
        releaseSnapshot(snapshot);
        // Rejections retire the lane in the handler above and return at the
        // guard. Only a positively acknowledged save may promote its latest
        // captured successor.
        lane.active = lane.pending;
        lane.pending = undefined;
        if (lane.active) startPersistence(relPath, lane);
        else persistenceLanes.delete(relPath);
      });
  };

  const onSave = (absPath: string) => {
    if (stopped) return;
    const relPath = toRelPath(absPath);
    if (relPath === null) {
      opts.log(`[save] ignoring save outside project dir: ${absPath}`);
      return;
    }

    opts.onSaved?.(relPath);

    if (opts.onSavedText) {
      try {
        const data = win.FS?.readFile(absPath);
        if (data instanceof Uint8Array) {
          opts.onSavedText(relPath, new TextDecoder().decode(data));
        }
      } catch (err) {
        opts.log(`[save] onSavedText read failed for ${relPath}: ${String(err)}`);
      }
    }

    // The callbacks above still observe native saves for collab/layout state,
    // but a poisoned file ancestry cannot publish bytes in this hook lifetime.
    if (blockedPaths.has(relPath)) return;

    if (!opts.saveBytes) {
      opts.log(`[save] ${relPath} saved in MEMFS (no external save target)`);
      return;
    }

    const generation = ++statusGeneration;
    if (statusClearTimer) {
      clearTimeout(statusClearTimer);
      statusClearTimer = undefined;
    }

    let data: Uint8Array;
    try {
      data = win.FS?.readFile(absPath) as Uint8Array;
      if (!(data instanceof Uint8Array)) throw new Error("FS.readFile returned no bytes");
    } catch (err) {
      opts.log(`[save] FAILED to read ${absPath} back from MEMFS: ${String(err)}`);
      if (generation === statusGeneration) opts.onStatus(`Save failed: ${relPath}`);
      return;
    }

    opts.onStatus(`Saving ${relPath}…`);
    let lane = persistenceLanes.get(relPath);
    if (!lane && persistenceLanes.size >= maxPaths) {
      reportCapacityFailure(relPath, generation, "paths", data.byteLength);
      return;
    }

    // A newer notification makes the old pending snapshot obsolete even when
    // the new payload cannot be admitted. Never persist an intermediate state
    // after reporting that the latest save failed admission.
    if (lane?.pending) {
      releaseSnapshot(lane.pending);
      lane.pending = undefined;
    }
    if (data.byteLength > maxRetainedBytes - retainedBytes) {
      reportCapacityFailure(relPath, generation, "bytes", data.byteLength);
      return;
    }

    // Copy only after capacity admission. FS adapters may return a mutable view
    // which a later native save reuses.
    let snapshot: SaveSnapshot;
    try {
      snapshot = { bytes: data.slice(), generation };
    } catch (error) {
      opts.log(`[save] FAILED to snapshot ${relPath}: ${String(error)}`);
      if (generation === statusGeneration) {
        opts.onStatus(`Save failed: ${relPath} — not enough memory`);
      }
      return;
    }
    retainedBytes += snapshot.bytes.byteLength;
    if (!lane) {
      lane = { active: snapshot };
      persistenceLanes.set(relPath, lane);
      startPersistence(relPath, lane);
    } else if (!lane.active) {
      lane.active = snapshot;
      startPersistence(relPath, lane);
    } else {
      lane.pending = snapshot;
    }
  };

  // Spread-merge like moduleItemsBridge does, so sibling hooks (onItems/onDelta)
  // registered before or after survive.
  win.kicadCollab = { ...win.kicadCollab, onSave };

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      // Invalidate every asynchronous completion before releasing state. An
      // already-started SaveBytes Promise still owns its immutable argument,
      // but it cannot publish status or advance to the queued snapshot.
      statusGeneration++;
      if (statusClearTimer) clearTimeout(statusClearTimer);
      statusClearTimer = undefined;

      for (const lane of persistenceLanes.values()) {
        lane.activeController?.abort();
        lane.activeController = undefined;
        lane.active = undefined;
        lane.pending = undefined;
      }
      persistenceLanes.clear();
      retainedBytes = 0;

      // A newer registration may have replaced the global slot. Never remove
      // another lifetime's hook when this older handle retires late.
      if (win.kicadCollab?.onSave === onSave) {
        delete win.kicadCollab.onSave;
      }
    },
  };
}
