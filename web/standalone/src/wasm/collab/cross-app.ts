import * as Y from "yjs";
import {
  presenceRoomId,
  presenceStateSchema,
  type PresenceState,
  type PresenceUser,
} from "@pcbjam/shared";
import { connectProvider, type ProviderConfig, type YjsProvider } from "./provider";
import { claimedPresenceColor } from "./presence";
import { clog } from "./debug";

function cleanupCrossApp(label: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch (err) {
    // Teardown is terminal and best-effort, but every acquired resource must
    // still get its own cleanup attempt when an earlier library destructor
    // throws.
    clog(`cross-app: ${label} cleanup failed —`, String(err));
  }
}

function destroyProviderAndDoc(provider: YjsProvider, doc: Y.Doc): void {
  cleanupCrossApp("provider", () => provider.destroy());
  cleanupCrossApp("document", () => doc.destroy());
}

/**
 * Project-wide presence room (collab-presence 0006): one awareness-only room
 * per PROJECT, joined by every collab-capable editor alongside its per-file
 * room(s). Per-file rooms keep owning same-document presence (cursors, roster,
 * selection outlines); this room exists ONLY so cross-app features can see
 * peers in the project's OTHER documents — an eeschema tab learning what a
 * pcbnew tab has selected, and vice versa.
 *
 * The local client publishes a full `PresenceState` (cursor always null —
 * world coordinates are meaningless across documents) and updates only its
 * `selection`/`selectionPaths`, so traffic is selection-rate, not cursor-rate.
 * The Y.Doc is a required transport sidecar that stays empty; backends skip
 * persisting `~presence` rooms.
 */

export interface CrossAppPeer {
  clientId: number;
  state: PresenceState;
}

export interface CrossAppHandle {
  /** Publish this tab's selection (uuids + pcbnew footprint paths). */
  setSelection(uuids: string[], paths?: string[]): void;
  /**
   * Publish which document this tab is actively editing (project-relative
   * path; the active sheet for eeschema, re-announced on sheet navigation).
   * Sibling-restage peers use it to connect a sheet's room only while someone
   * actually has it open.
   */
  setDocPath(path: string | undefined): void;
  /**
   * Peers in a DIFFERENT tool, one entry per awareness client. Unlike the
   * room roster this INCLUDES the own user's other tabs — one person with
   * the schematic and the board open gets classic cross-probing.
   */
  peers(): CrossAppPeer[];
  /** Fires on every awareness change in the project room. Returns unsubscribe. */
  subscribe(cb: () => void): () => void;
  destroy(): void;
}

export async function startCrossAppPresence(opts: {
  scopeId: string;
  projectId: string;
  provider: ProviderConfig;
  user: PresenceUser;
  tool: string;
  /** Owning editor lifetime for a lazy provider import/constructor. */
  signal?: AbortSignal;
  /** Initial doc this tab edits (see CrossAppHandle.setDocPath). */
  docPath?: string;
}): Promise<CrossAppHandle | undefined> {
  if (opts.provider.kind === "none") return undefined;

  const room = presenceRoomId(opts.scopeId, opts.projectId);
  const doc = new Y.Doc();
  let provider: YjsProvider;
  try {
    provider = await connectProvider(doc, opts.provider, {
      room,
      signal: opts.signal,
    });
  } catch (err) {
    clog("cross-app: provider connect failed —", String(err));
    cleanupCrossApp("unconnected document", () => doc.destroy());
    return undefined;
  }

  const awareness = provider.awareness;
  if (!awareness) {
    destroyProviderAndDoc(provider, doc);
    return undefined;
  }

  let selection: string[] = [];
  let selectionPaths: string[] | undefined;
  let docPath = opts.docPath;

  const publish = () => {
    const state: PresenceState = {
      // Reuse the bound room's claimed color so one user is one color
      // everywhere (same rule as the eeschema skeleton states).
      user: { ...opts.user, color: claimedPresenceColor(opts.user.id) ?? opts.user.color },
      tool: opts.tool,
      cursor: null,
      selection,
      ...(selectionPaths?.length ? { selectionPaths } : {}),
      // The actively-edited document, so peers can scope work (e.g. sibling
      // restage sockets) to sheets that are ACTUALLY open somewhere.
      ...(docPath ? { sheetPath: docPath } : {}),
      updatedAt: Date.now(),
    };
    awareness.setLocalState(state);
  };

  const subscribers = new Set<() => void>();
  const onChange = () => {
    for (const cb of subscribers) cb();
  };

  // Fast removal on tab close (same rationale as presence.ts).
  const onPageHide = () => awareness.setLocalState(null);
  let awarenessListenerAttached = false;
  let pageHideAttached = false;
  try {
    publish();
    awareness.on("change", onChange);
    awarenessListenerAttached = true;
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", onPageHide);
      pageHideAttached = true;
    }
  } catch (err) {
    if (pageHideAttached) {
      cleanupCrossApp("pagehide listener", () =>
        window.removeEventListener("pagehide", onPageHide),
      );
    }
    if (awarenessListenerAttached) {
      cleanupCrossApp("awareness listener", () =>
        awareness.off("change", onChange),
      );
    }
    cleanupCrossApp("local awareness", () => awareness.setLocalState(null));
    destroyProviderAndDoc(provider, doc);
    throw err;
  }
  clog("cross-app: joined project presence room", room, "as", opts.tool);

  let destroyed = false;
  return {
    setSelection(uuids, paths) {
      if (destroyed) return;
      selection = uuids;
      selectionPaths = paths;
      publish();
    },
    setDocPath(path) {
      if (destroyed) return;
      if (path === docPath) return;
      docPath = path;
      publish();
    },
    peers() {
      if (destroyed) return [];
      const out: CrossAppPeer[] = [];
      for (const [clientId, raw] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const parsed = presenceStateSchema.safeParse(raw);
        if (!parsed.success) continue;
        // Same-tool peers are the per-file rooms' business (and may not even
        // share a document with us) — cross-app only maps across editors.
        if (parsed.data.tool === opts.tool) continue;
        out.push({ clientId, state: parsed.data });
      }
      return out.sort((a, b) => a.clientId - b.clientId);
    },
    subscribe(cb) {
      if (destroyed) return () => {};
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (pageHideAttached && typeof window !== "undefined") {
        pageHideAttached = false;
        cleanupCrossApp("pagehide listener", () =>
          window.removeEventListener("pagehide", onPageHide),
        );
      }
      if (awarenessListenerAttached) {
        awarenessListenerAttached = false;
        cleanupCrossApp("awareness listener", () =>
          awareness.off("change", onChange),
        );
      }
      subscribers.clear();
      cleanupCrossApp("local awareness", () => awareness.setLocalState(null));
      destroyProviderAndDoc(provider, doc);
    },
  };
}
