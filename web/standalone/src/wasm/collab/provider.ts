import type * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { connectBroadcastChannel } from "./broadcast-transport";
import { connectAwarenessBroadcast } from "./awareness-bc";

/**
 * A Y.Doc transport, normalized across backends. The reconciler/seed logic only
 * needs to know when the initial state has arrived (`whenSynced`) and how to
 * tear down (`destroy`); everything else is provider-specific.
 *
 * Providers are network libraries (MIT/ISC) linked by the GPL editor — fine, and
 * the closed PartyKit server is reached only over WSS (no linking).
 */
export interface YjsProvider {
  /**
   * Resolves once the doc holds the authoritative initial state: for network
   * providers when the server has synced; for BroadcastChannel after a short
   * settle window (a peer tab may have answered). The seed-vs-adopt decision
   * runs after this.
   */
  whenSynced(opts?: { signal?: AbortSignal }): Promise<void>;
  destroy(): void;
  /**
   * The room's Yjs awareness sidecar (presence: roster/cursor/selection —
   * collab-presence 0001). Network providers surface their own instance (the
   * server relays it); the BroadcastChannel provider ferries one over a
   * sibling channel. Absent for `none` — presence UI then renders nothing.
   */
  awareness?: Awareness;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("The provider synchronization wait was aborted", "AbortError");
}

/**
 * One destroy-aware wait surface shared by all provider implementations.
 * `subscribe` must return the exact listener/timer cleanup for this wait.
 */
export function createSyncWaiter(
  isSynced: () => boolean,
  subscribe: (onSynced: () => void) => () => void,
): {
  wait(opts?: { signal?: AbortSignal }): Promise<void>;
  destroy(): void;
} {
  let destroyed = false;
  const rejectPending = new Set<(reason: unknown) => void>();

  return {
    wait({ signal } = {}) {
      if (destroyed) {
        return Promise.reject(
          new DOMException("The provider was destroyed before synchronization", "AbortError"),
        );
      }
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (isSynced()) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};

        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          signal?.removeEventListener("abort", onAbort);
          rejectPending.delete(onDestroy);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onAbort = () => finish(abortReason(signal!));
        const onDestroy = (reason: unknown) => finish(reason);
        const onSynced = () => finish();

        rejectPending.add(onDestroy);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const cleanup = subscribe(onSynced);
          if (settled) cleanup();
          else unsubscribe = cleanup;
        } catch (error) {
          finish(error);
          return;
        }

        // Close the small races between the checks above and listener install.
        if (destroyed) {
          onDestroy(
            new DOMException("The provider was destroyed before synchronization", "AbortError"),
          );
        } else if (signal?.aborted) {
          onAbort();
        } else if (isSynced()) {
          onSynced();
        }
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const reason = new DOMException(
        "The provider was destroyed before synchronization",
        "AbortError",
      );
      for (const rejectWait of [...rejectPending]) rejectWait(reason);
      rejectPending.clear();
    },
  };
}

export type ProviderKind =
  | "none"
  | "broadcastchannel"
  | "partykit"
  | "hocuspocus";

export interface ProviderConfig {
  kind: ProviderKind;
  /** Host/URL for network providers (partykit, hocuspocus). */
  endpoint?: string;
  /** Connection params (e.g. `{ token }`); see @pcbjam/shared `collabConnectParams`. */
  params?: { token?: string };
  /** BroadcastChannel only: how long to wait for a peer tab before seeding. */
  settleMs?: number;
}

// The closed sync server (apps/sync) binds the room DO as `BoardRoom`;
// partyserver routes it under the kebab-cased party name.
const PARTYKIT_PARTY = "board-room";

function requireEndpoint(config: ProviderConfig): string {
  if (!config.endpoint) {
    throw new Error(
      `collab provider "${config.kind}" requires an endpoint (VITE_YJS_ENDPOINT)`,
    );
  }
  return config.endpoint;
}

function noopProvider(): YjsProvider {
  return { whenSynced: () => Promise.resolve(), destroy: () => {} };
}

function broadcastChannelProvider(
  doc: Y.Doc,
  room: string,
  settleMs: number,
): YjsProvider {
  const transport = connectBroadcastChannel(doc, room);
  // Presence sidecar over its own channel — the doc transport stays untouched.
  const awareness = new Awareness(doc);
  const awarenessRelay = connectAwarenessBroadcast(awareness, `${room}:awareness`);
  const sync = createSyncWaiter(
    () => false,
    (onSynced) => {
      const timer = setTimeout(onSynced, settleMs);
      return () => clearTimeout(timer);
    },
  );
  return {
    // No server to sync with — keep the original seed-once heuristic: give a
    // peer tab a moment to answer the state query before deciding seed/adopt.
    whenSynced: sync.wait,
    destroy: () => {
      sync.destroy();
      awarenessRelay.destroy();
      awareness.destroy();
      transport.destroy();
    },
    awareness,
  };
}

async function partyKitProvider(
  doc: Y.Doc,
  endpoint: string,
  room: string,
  params: ProviderConfig["params"],
  signal?: AbortSignal,
): Promise<YjsProvider> {
  const { default: YProvider } = await import("y-partyserver/provider");
  if (signal?.aborted) throw abortReason(signal);
  // The provider splices the room into the WS URL verbatim, so it must travel
  // as ONE percent-encoded path segment — otherwise a docPath containing
  // `/`, ` `, `#`, `%` or `?` truncates or corrupts the room name. The sync
  // worker decodes it once at its edge; the decoded string is the canonical
  // room/DO name everywhere.
  const provider = new YProvider(endpoint, encodeURIComponent(room), doc, {
    party: PARTYKIT_PARTY,
    connect: true,
    params,
    // Default maxBackoffTime is 2.5s — a room that's down would re-dial (and
    // re-run the server's authorize round trip) every 2.5s forever, per room.
    maxBackoffTime: 30_000,
  });
  const sync = createSyncWaiter(
    () => provider.synced,
    (onSynced) => {
      const onSync = (state: boolean) => {
        if (state) onSynced();
      };
      provider.on("sync", onSync);
      return () => provider.off("sync", onSync);
    },
  );
  return {
    whenSynced: sync.wait,
    destroy: () => {
      sync.destroy();
      provider.destroy();
    },
    // y-partyserver's provider carries its own awareness; the BoardRoom DO
    // (YServer) relays awareness messages as part of the protocol.
    awareness: provider.awareness,
  };
}

async function hocuspocusProvider(
  doc: Y.Doc,
  endpoint: string,
  room: string,
  params: ProviderConfig["params"],
  signal?: AbortSignal,
): Promise<YjsProvider> {
  const { HocuspocusProvider } = await import("@hocuspocus/provider");
  if (signal?.aborted) throw abortReason(signal);
  const provider = new HocuspocusProvider({
    url: endpoint,
    name: room,
    document: doc,
    ...(params?.token ? { token: params.token } : {}),
  });
  const sync = createSyncWaiter(
    () => provider.synced,
    (onSynced) => {
      provider.on("synced", onSynced);
      return () => provider.off("synced", onSynced);
    },
  );
  return {
    whenSynced: sync.wait,
    destroy: () => {
      sync.destroy();
      provider.destroy();
    },
    awareness: provider.awareness ?? undefined,
  };
}

/**
 * Connect a Y.Doc to the env-selected provider. Network libraries are imported
 * lazily so a deployment only ships the one it uses.
 */
export async function connectProvider(
  doc: Y.Doc,
  config: ProviderConfig,
  opts: { room: string; signal?: AbortSignal },
): Promise<YjsProvider> {
  if (opts.signal?.aborted) throw abortReason(opts.signal);
  switch (config.kind) {
    case "broadcastchannel":
      return broadcastChannelProvider(doc, opts.room, config.settleMs ?? 300);
    case "partykit":
      return partyKitProvider(
        doc,
        requireEndpoint(config),
        opts.room,
        config.params,
        opts.signal,
      );
    case "hocuspocus":
      return hocuspocusProvider(
        doc,
        requireEndpoint(config),
        opts.room,
        config.params,
        opts.signal,
      );
    case "none":
      return noopProvider();
    default: {
      const _exhaustive: never = config.kind;
      return _exhaustive ?? noopProvider();
    }
  }
}
