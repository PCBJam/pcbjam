import { collabRoomId, FILES_DOC_PATH, type GatewayFileChange } from "@pcbjam/shared";
import * as Y from "yjs";
import { connectProvider, type ProviderConfig, type YjsProvider } from "./provider";

/**
 * Files-route change watch (project-sync 0002 §3): subscribes the project's
 * `~files` gateway channel and turns each `files` hint into INVALIDATION —
 * never a write into an open document:
 *
 *  - Tier 0 (always): observed-revision bookkeeping + own-echo suppression,
 *    `onListingStale` on a seq gap (reconnect / oversized batch).
 *  - Tier 1: a changed path that is neither the open target nor room-backed
 *    (`.kicad_pro`, netlists, a peer's new sheet) is re-fetched and restaged
 *    into MEMFS after a short debounce — the next "Update PCB from
 *    Schematic" / project-settings read sees the peer's version.
 *  - Tier 2: the open target itself changed on the PUT channel (a file with
 *    no room): `onTargetChanged` — the host shows a reload/conflict notice;
 *    the CAS lane keeps guarding the next save.
 *
 * Room-backed paths (listing hasYdoc/isLive) are ignored for EDITOR-origin
 * hints: the room is the truth there and already carries its own
 * `touched`/frames. An `upload`/`job` hint on a room-backed path is an
 * at-rest replacement of a cold doc (load-path-rework 0004 §2.5 — a
 * re-upload, or the resave job installing its ydoc): it IS restaged, and
 * `onRoomBackedChanged` lets the eeschema sheet pool drop a parked doc that
 * would otherwise carry the old epoch into its next activation.
 */

export const FILES_RESTAGE_DEBOUNCE_MS = 400;

export interface FilesWatchHandle {
  destroy(): void;
}

/** The slice of the gateway facade this consumes (structural; tests fake it). */
export interface FilesHintSource {
  onFiles(cb: (seq: number, changes: GatewayFileChange[]) => void): void;
  destroy(): void;
}

export interface FilesWatchOptions {
  scopeId: string;
  projectId: string;
  provider: ProviderConfig;
  /** The open document (Tier 2 routing). */
  targetPath?: string;
  /** This session's user slug — hints stamped `by` us are echo candidates. */
  selfUser?: string;
  /** Listing-derived: room-owned paths are never restaged from the row. */
  isRoomBacked: (relPath: string) => boolean;
  /** Latest revision this client observed for a path (its own PUT ack). */
  observedRevision: (relPath: string) => number | undefined;
  rememberObserved: (relPath: string, revision: number) => void;
  /** Fresh bytes for a sibling (goes through the project source: the cache
   *  validator no longer matches, so this is a real GET + base-revision record). */
  fetchBytes: (relPath: string) => Promise<Uint8Array>;
  /** MEMFS write of a sibling (kicad-runner restageFile). */
  restage: (relPath: string, bytes: Uint8Array) => void;
  /** A path not in the boot listing appeared (a peer's "Add Sheet"). */
  onNewPath?: (relPath: string) => void;
  /** A room-backed path was replaced at rest by an upload/job (0004 §2.5). */
  onRoomBackedChanged?: (relPath: string) => void;
  onTargetChanged?: (change: GatewayFileChange) => void;
  onListingStale?: () => void;
  log: (m: string) => void;
  /** Test seam: replace the gateway connect. */
  connect?: () => Promise<FilesHintSource>;
  /** Test seam. */
  debounceMs?: number;
}

/** Pure hint router — exported for tests; `startFilesWatch` wires it to the gateway. */
export function createFilesHintRouter(opts: FilesWatchOptions) {
  const knownPaths = new Set<string>();
  let lastSeq: number | null = null;
  let destroyed = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const debounceMs = opts.debounceMs ?? FILES_RESTAGE_DEBOUNCE_MS;

  const restageLater = (relPath: string): void => {
    const prev = timers.get(relPath);
    if (prev) clearTimeout(prev);
    timers.set(
      relPath,
      setTimeout(() => {
        timers.delete(relPath);
        if (destroyed) return;
        void opts
          .fetchBytes(relPath)
          .then((bytes) => {
            if (destroyed) return;
            opts.restage(relPath, bytes);
            opts.log(`[files] restaged ${relPath} from a peer's write`);
          })
          .catch((err) => opts.log(`[files] restage failed for ${relPath}: ${String(err)}`));
      }, debounceMs),
    );
  };

  const handle = (seq: number, changes: GatewayFileChange[]): void => {
    if (destroyed) return;
    if (lastSeq !== null && seq !== lastSeq + 1) {
      opts.log(`[files] hint seq gap (${lastSeq} → ${seq}) — listing is stale`);
      opts.onListingStale?.();
    }
    lastSeq = seq;
    for (const change of changes) {
      // Own echo: our PUT ack already recorded exactly this revision.
      if (
        opts.selfUser &&
        change.by === opts.selfUser &&
        opts.observedRevision(change.path) === change.revision
      ) {
        continue;
      }
      opts.rememberObserved(change.path, change.revision);
      if (opts.isRoomBacked(change.path)) {
        // The room owns editor writes; an at-rest replacement is different.
        if (change.origin === "editor" || change.deleted) continue;
        if (change.path === opts.targetPath) {
          opts.onTargetChanged?.(change);
          continue;
        }
        opts.onRoomBackedChanged?.(change.path);
      }
      if (change.path === opts.targetPath) {
        opts.onTargetChanged?.(change);
        continue;
      }
      if (change.deleted) {
        // v1: MEMFS keeps the last copy; the next boot drops it.
        opts.log(`[files] ${change.path} deleted by ${change.by ?? "a job"} — kept in MEMFS until reload`);
        continue;
      }
      if (!knownPaths.has(change.path)) {
        knownPaths.add(change.path);
        opts.onNewPath?.(change.path);
      }
      restageLater(change.path);
    }
  };

  return {
    handle,
    seedKnown(paths: Iterable<string>) {
      for (const p of paths) knownPaths.add(p);
    },
    destroy() {
      destroyed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

export async function startFilesWatch(
  opts: FilesWatchOptions & { knownPaths: Iterable<string> },
): Promise<FilesWatchHandle | undefined> {
  if (opts.provider.kind !== "partykit" && !opts.connect) return undefined; // gateway only
  const router = createFilesHintRouter(opts);
  router.seedKnown(opts.knownPaths);
  let source: FilesHintSource;
  try {
    source = opts.connect ? await opts.connect() : await connectGateway(opts);
  } catch (err) {
    opts.log(`[files] watch connect failed: ${String(err)}`);
    router.destroy();
    return undefined;
  }
  source.onFiles(router.handle);
  opts.log("[files] watching project file changes");
  return {
    destroy() {
      router.destroy();
      source.destroy();
    },
  };
}

async function connectGateway(opts: FilesWatchOptions): Promise<FilesHintSource> {
  const doc = new Y.Doc();
  const provider: YjsProvider = await connectProvider(doc, opts.provider, {
    room: collabRoomId(opts.scopeId, opts.projectId, FILES_DOC_PATH),
    passive: true,
  });
  const facade = provider as YjsProvider & Partial<FilesHintSource>;
  if (typeof facade.onFiles !== "function") {
    provider.destroy();
    doc.destroy();
    throw new Error("provider has no files channel");
  }
  return {
    onFiles: (cb) => facade.onFiles!(cb),
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}
