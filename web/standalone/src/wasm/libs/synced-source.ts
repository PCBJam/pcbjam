import {
  fetchSyncStacks,
  PROJECT_HEADER,
  SCOPE_HEADER,
  SYNC_STACKS_BATCH_MAX,
  type SyncStackDescriptor,
  USER_HEADER,
} from "@pcbjam/shared";
import {
  peekNamespaces,
  SyncStack,
  type ChannelFactory,
  type LayerDescriptor,
  type LayerStore,
} from "@pcbjam/sync-client";
import {
  LIB_ITEM_UPDATED_EVENT,
  type LibInfo,
  type LibItemInfo,
  type LibItemUpdatedDetail,
  type LibsSource,
  type LibsSyncState,
} from "./source";
import {
  isRetryableOwnerBackpressure,
  isStaleOwnerJobError,
  isTerminalOwnerJobError,
  runGuardedOwnerExport,
  type GuardedOwnerExport,
} from "../owner-job";

interface LibsEditorModule {
  kicadLibsReload?(kind: string, nickname: string): Promise<void>;
  kicadLibsSymbolUsage?(lib: string, name: string): Promise<number>;
}

interface ReloadLane {
  info: LibInfo;
  generation: number;
  /** Exact pending names, until `namesOverflowed` becomes whole-kind dirty. */
  names: Set<string>;
  namesOverflowed: boolean;
  /** A quiet or max-latency timer fired; the pending level may now drain. */
  ready: boolean;
  running: boolean;
  debounce?: ReturnType<typeof setTimeout>;
  maxLatency?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  backpressureReported: boolean;
  paused: boolean;
}

const RELOAD_DEBOUNCE_MS = 400;
const RELOAD_MAX_LATENCY_MS = 2_000;
const RELOAD_BACKPRESSURE_RETRY_MS = 1_000;
/**
 * A reload always invalidates the entire kind/library. Names are retained only
 * for the optional placed-symbol notification. Keep that diagnostic side data
 * finite under an untrusted realtime name flood. Crossing this limit changes
 * the lane to `namesOverflowed` (whole-kind dirty) and discards the partial
 * list; a partial list must never be presented as every changed item.
 */
export const RELOAD_CHANGED_NAMES_MAX = 64;

/**
 * A one-lib `LibsSource` backed by the r2-idb-sync bridge
 * (docs/features/r2-idb-sync). On first use it resolves the lib's **layer stack**
 * from the backend (`POST /api/libs/:lib/sync-stack`), opens a `SyncStack`
 * (hydrating a per-lib IndexedDB cache once, then serving locally + realtime), and
 * serves the editor's list/get/save from it — replacing the per-item network
 * round-trips of `remoteLibsSource`.
 *
 * The adapter consumes an OPAQUE stack: it never knows which layer is the shared
 * read-only origin and which is the writable overlay (that's the backend's call).
 * Its only domain knowledge is the `"<kind>/<name>"` path scheme.
 */
export function syncedLibsSource(
  libId: string,
  opts: {
    apiBase: string;
    scope: string;
    user?: string;
    project?: string;
    log?: (msg: string) => void;
    /**
     * Already-resolved stack for this lib, from the scope-level batch resolve
     * (see syncedScopeLibsSource). When it answers, the per-lib POST is skipped
     * entirely — that request is the one a board load makes 156-200 times.
     * Returning undefined falls back to resolving this lib on its own.
     */
    stackFor?: (libId: string) => SyncStackDescriptor | null | undefined;
    /**
     * SyncStack realtime policy (see SyncStackOptions.realtime). The scope
     * source passes "shared-only" — a board session warming 150+ libs must not
     * hold a dedicated WebSocket per org/mirror-direct lib; the lib-editor
     * route keeps the default "all" so its ONE lib stays realtime.
     */
    realtime?: "all" | "shared-only";
    /** Test seams (default: global fetch / IDB stores / real WebSockets). */
    fetchImpl?: typeof fetch;
    storeFactory?: (namespace: string) => LayerStore;
    channelFactory?: ChannelFactory;
  },
): LibsSource {
  const log = opts.log ?? (() => {});
  let opened: Promise<{ stack: SyncStack; info: LibInfo }> | null = null;
  // Identifies the current open lifetime. A source can be disposed while its
  // stack is still resolving/opening; that old async result must close itself
  // instead of installing a subscription into the next lifetime.
  let openGeneration = 0;

  // One active owner ticket and one accumulated pending level per item kind.
  // The pending set is a bounded LEVEL signal, not one job per WebSocket
  // message. The quiet and max-latency timers are two triggers for that same
  // level, so sustained traffic cannot postpone its owner ticket forever.
  const reloadLanes = new Map<string, ReloadLane>();
  // A terminal owner failure retires native reload work for exactly the Wasm
  // Module that failed. Realtime synchronization remains useful: remote data
  // can continue to update IDB, but no later WebSocket message may resurrect a
  // ticket storm against an owner whose native integrity is lost. Replacing
  // Module starts a new native lifetime and permits a fresh lane.
  let terminalReloadModule: LibsEditorModule | undefined;

  /**
   * A REMOTE change landed in the stack (IDB is already fresh). Tell the
   * running editor to drop the lib's WASM plugin cache and re-sync its tree —
   * the deferred r2-idb-sync task-E wiring. `kicadLibsReload` is the embind
   * export (wasm/bindings/pcbjam_libs_reload.h); absent before the runtime
   * boots, in which case there is no stale cache to refresh yet. After the
   * reload, symbol changes are checked against the open document
   * (`kicadLibsSymbolUsage`) and announced via LIB_ITEM_UPDATED_EVENT so the
   * chrome can warn when a PLACED symbol changed under the user.
   */
  const laneIsCurrent = (kind: string, lane: ReloadLane): boolean =>
    lane.generation === openGeneration && reloadLanes.get(kind) === lane;

  const laneHasPending = (lane: ReloadLane): boolean =>
    lane.namesOverflowed || lane.names.size > 0;

  const clearSettleTimers = (lane: ReloadLane): void => {
    if (lane.debounce) clearTimeout(lane.debounce);
    if (lane.maxLatency) clearTimeout(lane.maxLatency);
    lane.debounce = undefined;
    lane.maxLatency = undefined;
  };

  const retireTerminalReloadModule = (
    mod: LibsEditorModule | undefined,
  ): void => {
    terminalReloadModule = mod;
    for (const lane of reloadLanes.values()) {
      clearSettleTimers(lane);
      if (lane.retry) clearTimeout(lane.retry);
      lane.retry = undefined;
      lane.names.clear();
      lane.namesOverflowed = false;
      lane.ready = false;
      lane.paused = true;
    }
    reloadLanes.clear();
  };

  /** Add an exact name, or collapse to the bounded whole-kind representation. */
  const addPendingName = (lane: ReloadLane, name: string): void => {
    if (lane.namesOverflowed || lane.names.has(name)) return;
    if (lane.names.size >= RELOAD_CHANGED_NAMES_MAX) {
      lane.names.clear();
      lane.namesOverflowed = true;
      return;
    }
    lane.names.add(name);
  };

  const markReloadReady = (kind: string, lane: ReloadLane): void => {
    if (!laneIsCurrent(kind, lane)) return;
    clearSettleTimers(lane);
    lane.ready = true;
    drainEditorReload(kind, lane);
  };

  const drainEditorReload = (kind: string, lane: ReloadLane): void => {
    if (
      !laneIsCurrent(kind, lane) ||
      lane.running ||
      lane.retry ||
      lane.paused ||
      !lane.ready ||
      !laneHasPending(lane)
    ) {
      return;
    }

    const mod = (globalThis as { Module?: LibsEditorModule }).Module;
    const reload = mod?.kicadLibsReload;
    if (typeof reload !== "function") {
      lane.names.clear();
      lane.namesOverflowed = false;
      lane.ready = false;
      clearSettleTimers(lane);
      reloadLanes.delete(kind);
      return;
    }

    const namesOverflowed = lane.namesOverflowed;
    const names = namesOverflowed ? [] : [...lane.names];
    lane.names.clear();
    lane.namesOverflowed = false;
    lane.ready = false;
    clearSettleTimers(lane);
    lane.running = true;
    const isCurrent = () => laneIsCurrent(kind, lane);
    log(`[synced] remote change → reload ${kind} lib "${lane.info.name}"`);

    const guardedReload = reload as GuardedOwnerExport<
      readonly [string, string],
      void
    >;
    void runGuardedOwnerExport(
      guardedReload,
      [kind, lane.info.name] as const,
      isCurrent,
    )
      .then(() => {
        if (namesOverflowed) {
          // The native operation above already reloaded the whole kind/lib.
          // Do not emit a partial name array under an event whose contract says
          // it contains every changed item.
          log(
            `[synced] more than ${RELOAD_CHANGED_NAMES_MAX} ${kind} names changed; ` +
              "per-item update notice omitted",
          );
          return;
        }
        return emitItemUpdated(lane.info, kind, names, mod, isCurrent);
      })
      .then(() => {
        lane.backpressureReported = false;
      })
      .catch((error: unknown) => {
        if (!isCurrent() || isStaleOwnerJobError(error)) return;
        if (namesOverflowed) {
          lane.names.clear();
          lane.namesOverflowed = true;
        } else {
          for (const name of names) addPendingName(lane, name);
        }
        lane.ready = true;

        if (isRetryableOwnerBackpressure(error)) {
          if (!lane.backpressureReported) {
            lane.backpressureReported = true;
            log(`[synced] owner queue full; delaying ${kind} reload`);
          }
          if (!lane.retry) {
            lane.retry = setTimeout(() => {
              lane.retry = undefined;
              drainEditorReload(kind, lane);
            }, RELOAD_BACKPRESSURE_RETRY_MS);
          }
          return;
        }

        if (isTerminalOwnerJobError(error)) {
          log(`[synced] editor reload retired: ${String(error)}`);
          retireTerminalReloadModule(mod);
          return;
        }

        log(`[synced] editor reload failed: ${String(error)}`);
        lane.paused = true;
      })
      .finally(() => {
        lane.running = false;
        if (!laneIsCurrent(kind, lane)) return;
        if (laneHasPending(lane)) drainEditorReload(kind, lane);
        else if (!lane.debounce && !lane.maxLatency && !lane.retry)
          reloadLanes.delete(kind);
      });
  };

  function scheduleEditorReload(info: LibInfo, path: string): void {
    const currentModule = (globalThis as { Module?: LibsEditorModule }).Module;
    if (terminalReloadModule === currentModule) return;
    if (terminalReloadModule && terminalReloadModule !== currentModule) {
      terminalReloadModule = undefined;
    }
    const kind = path.slice(0, Math.max(path.indexOf("/"), 0));
    if (kind !== "symbol" && kind !== "footprint") return;
    const name = path.slice(kind.length + 1);
    let lane = reloadLanes.get(kind);
    if (!lane || lane.generation !== openGeneration) {
      lane = {
        info,
        generation: openGeneration,
        names: new Set(),
        namesOverflowed: false,
        ready: false,
        running: false,
        backpressureReported: false,
        paused: false,
      };
      reloadLanes.set(kind, lane);
    }

    const wasPending = laneHasPending(lane);
    addPendingName(lane, name);
    lane.paused = false;
    // Once a pending level is ready, later messages join that same level; they
    // cannot make it unready and restart its age. If an owner ticket is active,
    // its `finally` drains this level as soon as that ticket retires.
    if (lane.ready) {
      drainEditorReload(kind, lane);
      return;
    }

    if (lane.debounce) clearTimeout(lane.debounce);
    const scheduledLane = lane;
    lane.debounce = setTimeout(() => {
      markReloadReady(kind, scheduledLane);
    }, RELOAD_DEBOUNCE_MS);
    // Set only for the first event in this pending level. Unlike the quiet
    // timer above, later events never move this deadline.
    if (!wasPending && !lane.maxLatency) {
      lane.maxLatency = setTimeout(() => {
        markReloadReady(kind, scheduledLane);
      }, RELOAD_MAX_LATENCY_MS);
    }
  }

  /** Announce the applied update, flagging names placed in the open document. */
  async function emitItemUpdated(
    info: LibInfo,
    kind: string,
    names: string[],
    mod: LibsEditorModule | undefined,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent() || typeof window === "undefined" || names.length === 0)
      return;
    const usage = mod?.kicadLibsSymbolUsage;
    const usedNames: string[] = [];
    if (kind === "symbol" && typeof usage === "function") {
      const guardedUsage = usage as GuardedOwnerExport<
        readonly [string, string],
        number
      >;
      for (const name of names) {
        try {
          const count = await runGuardedOwnerExport(
            guardedUsage,
            [info.name, name] as const,
            isCurrent,
          );
          if (count > 0) usedNames.push(name);
        } catch (error) {
          if (isCurrent())
            log(`[synced] editor symbol-usage read failed: ${String(error)}`);
        }
      }
    }
    if (!isCurrent()) return;
    const detail: LibItemUpdatedDetail = { lib: info.name, kind, names, usedNames };
    window.dispatchEvent(new CustomEvent(LIB_ITEM_UPDATED_EVENT, { detail }));
  }

  async function ensure(): Promise<{ stack: SyncStack; info: LibInfo }> {
    if (!opened) {
      const generation = ++openGeneration;
      opened = resolveAndOpen(libId, opts, log).then((r) => {
        if (generation !== openGeneration) {
          r.stack.close();
          throw new Error(`library source disposed while opening ${libId}`);
        }
        r.stack.subscribe((c) => {
          // Closing a realtime channel does not synchronously retract messages
          // already delivered by the transport. Do not let an old source
          // lifetime schedule editor work after dispose/reopen.
          if (generation !== openGeneration) return;
          // Local receipts already invalidate the plugin through the save
          // flow. Only authoritative remote changes require a WASM reload.
          if (c.origin === "local") return;
          scheduleEditorReload(r.info, c.path);
        });
        return r;
      });
    }
    return opened;
  }

  const pathOf = (kind: string, name: string) => `${kind}/${name}`;

  return {
    async listLibs(): Promise<LibInfo[]> {
      const { info } = await ensure();
      return [info];
    },
    async listItems(): Promise<LibItemInfo[]> {
      const { stack } = await ensure();
      return (await stack.list()).map((e) => splitPath(e.path));
    },
    async presync(opts): Promise<void> {
      // One lib: resolving + opening its stack warms the IDB cache.
      opts?.onProgress?.({ done: 0, total: 1, current: "library" });
      try {
        const { info } = await ensure();
        opts?.onProgress?.({ done: 1, total: 1, current: info.name });
      } catch {
        opts?.onProgress?.({ done: 1, total: 1, current: "library" });
      }
    },
    async getAllItems(): Promise<
      Array<{ kind: string; name: string; body: Uint8Array }>
    > {
      // Bulk merged read across the opaque layer stack (origin + mirror overlay),
      // top-wins — the mirror invariant readAll() preserves. One crossing, no
      // per-item gets. "Copy as-is": raw bytes (no TextDecoder) — see cdn-source.
      const { stack } = await ensure();
      return [...(await stack.readAll())].map(([path, bytes]) => {
        const { kind, name } = splitPath(path);
        return { kind, name, body: bytes };
      });
    },
    async getItemBody(_id, kind, name): Promise<string | null> {
      const { stack } = await ensure();
      const bytes = await stack.read(pathOf(kind, name));
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    async saveItemBody(_id, kind, name, body): Promise<boolean> {
      const { stack } = await ensure();
      const path = pathOf(kind, name);
      try {
        await stack.push(path, new TextEncoder().encode(body));
        return true;
      } catch (e) {
        log(`[synced] save failed for ${kind}/${name}: ${String(e)}`);
        return false;
      }
    },
    dispose(): void {
      openGeneration++;
      for (const lane of reloadLanes.values()) {
        clearSettleTimers(lane);
        if (lane.retry) clearTimeout(lane.retry);
        lane.names.clear();
        lane.namesOverflowed = false;
        lane.ready = false;
        lane.retry = undefined;
      }
      reloadLanes.clear();
      // Close the stack once its open settles (sockets + channel refcounts);
      // the IDB cache stays for the next session. A failed open has nothing
      // to close.
      opened?.then((r) => r.stack.close()).catch(() => {});
      opened = null;
    },
    async enableRealtime(): Promise<void> {
      // Names are the SCOPE source's concern (it fans out per lib); a one-lib
      // source just promotes its own stack.
      const { stack } = await ensure();
      stack.connectRealtime();
    },
  };
}

async function resolveAndOpen(
  libId: string,
  opts: {
    apiBase: string;
    scope: string;
    user?: string;
    project?: string;
    stackFor?: (libId: string) => SyncStackDescriptor | null | undefined;
    realtime?: "all" | "shared-only";
    fetchImpl?: typeof fetch;
    storeFactory?: (namespace: string) => LayerStore;
    channelFactory?: ChannelFactory;
  },
  log: (msg: string) => void,
): Promise<{ stack: SyncStack; info: LibInfo }> {
  const baseFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    [SCOPE_HEADER]: opts.scope,
    ...(opts.user ? { [USER_HEADER]: opts.user } : {}),
    ...(opts.project ? { [PROJECT_HEADER]: opts.project } : {}),
  };
  // Batch-resolved already? Then this lib costs no request at all. `null` is a
  // deliberate "the backend says this lib does not resolve" and must not be
  // retried per-lib; only `undefined` (not in the batch) falls through.
  const prefetched = opts.stackFor?.(libId);
  if (prefetched === null) throw new Error(`sync-stack resolve failed: unknown lib ${libId}`);
  let body: SyncStackDescriptor;
  if (prefetched) {
    body = prefetched;
    log(`[synced] resolved ${body.layers.length} layer(s) for lib ${libId} (batched)`);
  } else {
    const res = await baseFetch(
      `${opts.apiBase}/api/scopes/${encodeURIComponent(opts.scope)}/libs/${encodeURIComponent(libId)}/sync-stack`,
      // credentials: session-cookie auth, here and on every layer fetch below —
      // live layers are membership-gated by the API worker per request.
      { method: "POST", headers, credentials: "include" },
    );
    if (!res.ok) throw new Error(`sync-stack resolve failed: HTTP ${res.status}`);
    body = (await res.json()) as SyncStackDescriptor;
    log(`[synced] resolved ${body.layers.length} layer(s) for lib ${libId}`);
  }

  // The descriptors carry no bearer token — live-layer HTTP ops authenticate
  // with the session cookie, so the stack's fetch must send credentials. The
  // realtime WebSocket gets cookies automatically (same-site handshake).
  const credentialedFetch: typeof fetch = (input, init) =>
    baseFetch(input, { ...init, credentials: "include" });
  const stack = new SyncStack({
    layers: body.layers,
    fetchImpl: credentialedFetch,
    storeFactory: opts.storeFactory,
    channelFactory: opts.channelFactory,
    realtime: opts.realtime,
  });
  await stack.open();
  return {
    stack,
    info: { id: body.lib.id, name: body.lib.name, description: null },
  };
}

/** Decode a `"<kind>/<name>"` namespace path back into editor item terms. */
function splitPath(path: string): LibItemInfo {
  const i = path.indexOf("/");
  return i < 0
    ? { kind: path, name: "" }
    : { kind: path.slice(0, i), name: path.slice(i + 1) };
}

/**
 * The whole-scope synced source for PROJECT sessions: library LISTING (and
 * `createLib`) stay on the remote contract — the backend owns which libs a
 * scope/project sees — while every per-item read/write routes to a lazy
 * per-lib {@link syncedLibsSource} (one `SyncStack` per lib: IDB cache +
 * realtime + the subscribe→editor-reload bridge). This is what makes a peer's
 * lib edit reach an OPEN SCHEMATIC session (the per-lib source only covers the
 * `/libs/<id>` lib-editor pages).
 *
 * NOTE: writes follow the sync rooms (`sync/<ns>` R2), the v1 store that is
 * not yet unified with the items-API DB (docs/features/r2-idb-sync 0001 §5
 * "lazy materialization" deferred note) — same trade the lib-editor pages
 * already make.
 */
export function syncedScopeLibsSource(
  remote: LibsSource,
  opts: {
    apiBase: string;
    scope: string;
    user?: string;
    project?: string;
    log?: (msg: string) => void;
    fetchImpl?: typeof fetch;
    storeFactory?: (namespace: string) => LayerStore;
    channelFactory?: ChannelFactory;
  },
): LibsSource {
  const perLib = new Map<string, LibsSource>();
  // Source-local sequencing for overlapping batch resolves. Requests remain
  // concurrent; only their descriptor-cache commit is latest-wins per lib.
  let sourceGeneration = 0;
  let stackRequestSequence = 0;
  const latestStackRequest = new Map<string, number>();
  // Stacks resolved in bulk by `prefetchStacks`. A hit means the per-lib source
  // makes NO resolve request; `null` records "backend says unresolvable" so a
  // stale pin isn't retried one-by-one. Misses simply fall back per-lib, which
  // is also what happens against a backend predating the batch route.
  const batchedStacks = new Map<string, SyncStackDescriptor | null>();
  const forLib = (libId: string): LibsSource => {
    let src = perLib.get(libId);
    if (!src) {
      src = syncedLibsSource(libId, {
        ...opts,
        // Bulk context: only mux-keyed layers get realtime. During the
        // single-writer cutover, origin overlays also stay on their per-lib
        // rooms, so bulk-opened stacks remain HTTP-only until enableRealtime()
        // promotes the few libraries the document actually uses. This avoids
        // dozens of idle dedicated sockets without enabling the second room
        // topology as a concurrent writer.
        realtime: "shared-only",
        stackFor: (id) => (batchedStacks.has(id) ? batchedStacks.get(id) : undefined),
      });
      perLib.set(libId, src);
    }
    return src;
  };

  /**
   * Resolve every lib's stack up front, in a handful of paged requests instead
   * of one per lib. A board load resolves 156-200 libraries, and each per-lib
   * POST is a separate serverless invocation before any library CONTENT is
   * fetched — the dominant cost of the whole phase.
   *
   * Best-effort by design: any failure (older backend without the route, a
   * network blip) leaves the map empty and every lib resolves the old way, so
   * this can only ever remove requests, never break the load.
   */
  async function prefetchStacks(libs: LibInfo[]): Promise<void> {
    const missing = libs.map((l) => l.id).filter((id) => !batchedStacks.has(id));
    if (missing.length === 0) return;
    const generation = sourceGeneration;
    const sequence = ++stackRequestSequence;
    // Assign before the fetch. If two presync calls overlap, an older response
    // that arrives last cannot overwrite the newer stack descriptor.
    for (const id of missing) latestStackRequest.set(id, sequence);
    const headers: Record<string, string> = {
      [SCOPE_HEADER]: opts.scope,
      ...(opts.user ? { [USER_HEADER]: opts.user } : {}),
      ...(opts.project ? { [PROJECT_HEADER]: opts.project } : {}),
    };
    try {
      const resolved = await fetchSyncStacks({
        url: `${opts.apiBase}/api/scopes/${encodeURIComponent(opts.scope)}/libs/sync-stacks`,
        libIds: missing,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        headers,
      });
      if (generation !== sourceGeneration) return;
      for (const [id, stack] of resolved) {
        if (latestStackRequest.get(id) === sequence) batchedStacks.set(id, stack);
      }
      opts.log?.(
        `[synced] batch-resolved ${resolved.size} lib stack(s) in ` +
          `${Math.ceil(missing.length / SYNC_STACKS_BATCH_MAX)} request(s)`,
      );
    } catch (err) {
      opts.log?.(`[synced] batch resolve unavailable (${String(err)}) — falling back per-lib`);
    }
  }

  return {
    listLibs: (kind) => remote.listLibs(kind),
    createLib: remote.createLib?.bind(remote),
    getFpIndex: remote.getFpIndex?.bind(remote),
    async syncState(kind): Promise<LibsSyncState | null> {
      // Read-only warmth probe for the download-consent gate (standalone-
      // load-ux 0002): the backend's list envelope names each lib's primary
      // sync namespace (= its IDB cache key) + expected cold bytes, so warmth
      // is answerable from the local cache alone — no stack resolves, no
      // bundle fetches. A backend predating the `sync` field yields no
      // namespaces at all → null (unknown), never a fake all-cold answer.
      const libs = await remote.listLibs(kind);
      const withNs = libs.filter(
        (l): l is LibInfo & { sync: { namespace: string; bytes?: number | null } } =>
          !!l.sync?.namespace,
      );
      if (withNs.length === 0) return null;
      const peeked = await peekNamespaces(
        withNs.map((l) => l.sync.namespace),
        opts.storeFactory ? { storeFactory: opts.storeFactory } : undefined,
      );
      let warm = 0;
      let coldBytes = 0;
      // Libs with no namespace at all are cold-with-unknown-size by definition
      // (they can't be probed and carry no byte figure).
      let coldUnknown = libs.length - withNs.length;
      for (const l of withNs) {
        if (peeked.get(l.sync.namespace)) warm++;
        else if (typeof l.sync.bytes === "number") coldBytes += l.sync.bytes;
        else coldUnknown++;
      }
      const cold = libs.length - warm;
      return {
        total: libs.length,
        warm,
        coldBytes,
        // "Sizes known" = every cold lib had a byte figure. Cold libs WITHOUT
        // one (live org/mirror layers, unstamped versions) make the MB figure
        // an undercount, so degrade to the count-only wording instead.
        sizesKnown: cold > 0 ? coldUnknown === 0 : true,
      };
    },
    listItems: (libId) => forLib(libId).listItems(libId),
    getAllItems: (libId) => forLib(libId).getAllItems!(libId),
    getItemBody: (libId, kind, name) =>
      forLib(libId).getItemBody(libId, kind, name),
    saveItemBody: (libId, kind, name, body) =>
      forLib(libId).saveItemBody!(libId, kind, name, body),
    async presync(presyncOpts): Promise<void> {
      const generation = sourceGeneration;
      const libs = await remote.listLibs(presyncOpts?.kind);
      if (generation !== sourceGeneration) return;
      const total = libs.length;
      let done = 0;
      presyncOpts?.onProgress?.({ done, total, current: "libraries" });
      // One batched resolve for the whole set before the per-lib fan-out, so
      // the workers below open stacks without a request each.
      if (!presyncOpts?.signal?.aborted) await prefetchStacks(libs);
      if (generation !== sourceGeneration) return;
      const concurrency = presyncOpts?.concurrency ?? 8;
      const queue = [...libs];
      const worker = async (): Promise<void> => {
        for (let lib = queue.shift(); lib; lib = queue.shift()) {
          if (presyncOpts?.signal?.aborted || generation !== sourceGeneration) return;
          try {
            // Opening the stack (via any op) hydrates the lib's IDB cache.
            await forLib(lib.id).listItems(lib.id);
          } catch {
            // Best-effort: a lib that fails to presync still loads lazily.
          }
          done++;
          presyncOpts?.onProgress?.({ done, total, current: lib.name });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, total) }, worker),
      );
    },
    dispose(): void {
      sourceGeneration++;
      latestStackRequest.clear();
      for (const src of perLib.values()) src.dispose?.();
      perLib.clear();
    },
    async enableRealtime(libNames): Promise<void> {
      if (libNames.length === 0) return;
      const generation = sourceGeneration;
      // Nickname → lib id via the backend listing (one request; the wasm boot
      // has usually made the same call already). Names that don't resolve —
      // project-local table rows, stale nicknames — are simply not ours.
      const wanted = new Set(libNames);
      const libs = (await remote.listLibs()).filter((l) => wanted.has(l.name));
      if (generation !== sourceGeneration) return;
      opts.log?.(
        `[synced] realtime upgrade for ${libs.length}/${libNames.length} referenced lib(s)`,
      );
      await Promise.all(
        libs.map((l) =>
          forLib(l.id)
            .enableRealtime?.([])
            ?.catch((e) =>
              opts.log?.(`[synced] realtime upgrade failed for ${l.name}: ${String(e)}`),
            ),
        ),
      );
    },
  };
}
