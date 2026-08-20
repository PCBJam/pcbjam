import {
  fetchSyncStacks,
  PROJECT_HEADER,
  SCOPE_HEADER,
  SYNC_STACKS_BATCH_MAX,
  type SyncStackDescriptor,
  USER_HEADER,
} from "@pcbjam/shared";
import {
  onSyncRoomFrame,
  peekNamespaces,
  SyncRoomMovedError,
  SyncStack,
  type ChannelFactory,
  type LayerDescriptor,
  type LayerStore,
} from "@pcbjam/sync-client";
import {
  LIB_ITEM_UPDATED_EVENT,
  LIB_SET_CHANGED_EVENT,
  type LibInfo,
  type LibItemInfo,
  type LibItemUpdatedDetail,
  type LibSetChangedDetail,
  type LibsSource,
  type LibsSyncState,
} from "./source";

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
     * The room refused a write with the cutover 409 (SyncRoomMovedError): the
     * cached batch-resolved descriptor is stale. The scope source drops it here
     * so the retry's re-resolve hits the backend for a fresh one.
     */
    onStackMoved?: (libId: string) => void;
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

  // Paths with a local save in flight: the stack echoes our own push as a
  // change event, but the plugin already invalidated its cache on save — a
  // reload would just re-fat-load the lib for nothing (and race the save flow).
  const selfPushed = new Set<string>();
  // Trailing per-kind debounce: a burst of remote changes (a peer saving
  // several items, a reconnect resync diff) becomes ONE reload per kind.
  const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Item names accumulated per kind while the debounce runs — drives the
  // post-reload "is this symbol placed here?" check + the update event.
  const pendingNames = new Map<string, Set<string>>();

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
  function scheduleEditorReload(info: LibInfo, path: string): void {
    const kind = path.slice(0, Math.max(path.indexOf("/"), 0));
    if (kind !== "symbol" && kind !== "footprint") return;
    const name = path.slice(kind.length + 1);
    (pendingNames.get(kind) ?? pendingNames.set(kind, new Set()).get(kind)!).add(
      name,
    );
    clearTimeout(reloadTimers.get(kind));
    reloadTimers.set(
      kind,
      setTimeout(() => {
        reloadTimers.delete(kind);
        const names = [...(pendingNames.get(kind) ?? [])];
        pendingNames.delete(kind);
        const mod = (globalThis as { Module?: Record<string, unknown> }).Module;
        const reload = mod?.kicadLibsReload;
        if (typeof reload !== "function") return;
        log(`[synced] remote change → reload ${kind} lib "${info.name}"`);
        try {
          (reload as (kind: string, nickname: string) => void)(kind, info.name);
        } catch (e) {
          log(`[synced] editor reload failed: ${String(e)}`);
          return;
        }
        emitItemUpdated(info, kind, names, mod);
      }, 400),
    );
  }

  /** Announce the applied update, flagging names placed in the open document. */
  function emitItemUpdated(
    info: LibInfo,
    kind: string,
    names: string[],
    mod: Record<string, unknown> | undefined,
  ): void {
    if (typeof window === "undefined" || names.length === 0) return;
    const usage = mod?.kicadLibsSymbolUsage;
    const usedNames =
      kind === "symbol" && typeof usage === "function"
        ? names.filter((n) => {
            try {
              return (
                (usage as (lib: string, name: string) => number)(info.name, n) >
                0
              );
            } catch {
              return false;
            }
          })
        : [];
    const detail: LibItemUpdatedDetail = { lib: info.name, kind, names, usedNames };
    window.dispatchEvent(new CustomEvent(LIB_ITEM_UPDATED_EVENT, { detail }));
  }

  async function ensure(): Promise<{ stack: SyncStack; info: LibInfo }> {
    if (!opened) {
      opened = resolveAndOpen(libId, opts, log).then((r) => {
        r.stack.subscribe((c) => {
          // Consume our own save's echo (exactly one change event per push);
          // everything else is a peer's edit.
          if (selfPushed.delete(c.path)) return;
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
      const path = pathOf(kind, name);
      const bytes = new TextEncoder().encode(body);
      // Two attempts at most: the second only after a cutover 409 told us the
      // room moved — the stack is re-resolved and the write retried against
      // the room the fresh descriptor names (load-path-rework 0002 §3.3).
      for (let attempt = 0; ; attempt++) {
        const { stack } = await ensure();
        // A successful push fires exactly one change event (the WS self-echo
        // is hash-deduped inside the layer), and the stack delivers it AFTER
        // an async merged read — so the flag must outlive this call; the
        // subscriber consumes it. A failed push fires none: clear it ourselves.
        selfPushed.add(path);
        try {
          await stack.push(path, bytes);
          return true;
        } catch (e) {
          selfPushed.delete(path);
          if (e instanceof SyncRoomMovedError && attempt === 0) {
            log(`[synced] room moved for lib ${libId} — re-resolving stack`);
            opts.onStackMoved?.(libId);
            const stale = opened;
            opened = null;
            stale?.then((r) => r.stack.close()).catch(() => {});
            continue;
          }
          log(`[synced] save failed for ${kind}/${name}: ${String(e)}`);
          return false;
        }
      }
    },
    dispose(): void {
      for (const t of reloadTimers.values()) clearTimeout(t);
      reloadTimers.clear();
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
/** A lib DTO handed over from the boot payload (structural — the wire shape
 *  of `GET /libs`, which the boot endpoint embeds unfiltered). */
export interface PreloadedLibDto {
  id: string;
  name: string;
  /** Collision-safe MOUNT nickname the backend assigned (see libSchema) —
   *  preferred over `name` for everything KiCad-facing. */
  nickname?: string;
  description?: string | null;
  type: string;
  itemCount?: number;
  /** Per-kind item counts — the client-side equivalent of the server's
   *  `libHasKind` filter for `listLibs(kind)`. */
  kindCounts?: Record<string, number>;
  sync?: { namespace: string; bytes: number | null } | null;
}

export function syncedScopeLibsSource(
  remote: LibsSource,
  opts: {
    apiBase: string;
    scope: string;
    user?: string;
    project?: string;
    log?: (msg: string) => void;
    /**
     * The boot payload's lib listing + batch-resolved stacks (load-path-rework
     * 0001 §6): `listLibs` answers locally (kind-filtered the same way the
     * server would) and the stack prefetch is already satisfied — a boot with
     * this present makes ZERO lib listing/resolve requests. Absent ⇒ the
     * individual endpoints, exactly as before.
     */
    preloaded?: {
      libs: PreloadedLibDto[];
      stacks: Record<string, SyncStackDescriptor | null>;
    };
    fetchImpl?: typeof fetch;
    storeFactory?: (namespace: string) => LayerStore;
    channelFactory?: ChannelFactory;
  },
): LibsSource {
  const perLib = new Map<string, LibsSource>();

  // Room-level `libset` frames (a peer created an org lib / changed pins —
  // the scope room's announce broadcast): surface them to the chrome as
  // LIB_SET_CHANGED_EVENT so it can offer "load the new library" without a
  // reload. The session only ever dials its own team's scope room, so no
  // URL filtering is needed; frames are advisory (the action re-lists).
  const offRoomFrames = onSyncRoomFrame((_roomUrl, msg) => {
    if (msg.t !== "libset" || typeof window === "undefined") return;
    const detail: LibSetChangedDetail = {
      op: msg.op,
      libId: msg.libId,
      name: msg.name,
    };
    opts.log?.(`[synced] lib set changed: ${msg.op} ${msg.name ?? msg.libId}`);
    window.dispatchEvent(new CustomEvent(LIB_SET_CHANGED_EVENT, { detail }));
  });

  // Stacks resolved in bulk by `prefetchStacks`. A hit means the per-lib source
  // makes NO resolve request; `null` records "backend says unresolvable" so a
  // stale pin isn't retried one-by-one. Misses simply fall back per-lib, which
  // is also what happens against a backend predating the batch route.
  const batchedStacks = new Map<string, SyncStackDescriptor | null>();
  if (opts.preloaded) {
    for (const [id, stack] of Object.entries(opts.preloaded.stacks)) {
      batchedStacks.set(id, stack);
    }
  }
  const preloadedLibs = (kind?: string): LibInfo[] =>
    (opts.preloaded?.libs ?? [])
      .filter(
        (l) =>
          !kind ||
          // Same rule the server applies: org libs and mirrors are
          // kind-agnostic containers; origins/pins need >=1 item of the kind.
          l.type === "org" ||
          l.type === "mirror" ||
          (l.kindCounts?.[kind] ?? 0) > 0,
      )
      .map((l) => ({
        id: l.id,
        // Same boundary rule as remote-source.listLibs: the backend's
        // collision-safe mount nickname IS the lib's name from here on.
        name: l.nickname ?? l.name,
        description: l.description ?? null,
        type: l.type,
        itemCount: l.itemCount,
        sync: l.sync ?? null,
      }));
  const forLib = (libId: string): LibsSource => {
    let src = perLib.get(libId);
    if (!src) {
      src = syncedLibsSource(libId, {
        ...opts,
        // Bulk context: only mux-keyed layers (the one shared mirror room
        // socket) get realtime. Without this, every org/mirror-direct lib in
        // the scope dials a dedicated WebSocket — a board load held 60+ idle
        // sockets, each pinning a DO and costing an authorize per reconnect.
        // Trade-off: peer edits to those libs reach this session on the next
        // load (or lazy sync) instead of live; origin libs keep live updates
        // via the muxed team mirror channel.
        realtime: "shared-only",
        stackFor: (id) => (batchedStacks.has(id) ? batchedStacks.get(id) : undefined),
        onStackMoved: (id) => batchedStacks.delete(id),
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
      for (const [id, stack] of resolved) batchedStacks.set(id, stack);
      opts.log?.(
        `[synced] batch-resolved ${resolved.size} lib stack(s) in ` +
          `${Math.ceil(missing.length / SYNC_STACKS_BATCH_MAX)} request(s)`,
      );
    } catch (err) {
      opts.log?.(`[synced] batch resolve unavailable (${String(err)}) — falling back per-lib`);
    }
  }

  // Every internal listing goes through the preload too — syncState, presync
  // and the realtime name-mapping otherwise each re-fetch the listing the
  // boot payload already carried.
  const listLibsPreferred = (kind?: string): Promise<LibInfo[]> =>
    opts.preloaded ? Promise.resolve(preloadedLibs(kind)) : remote.listLibs(kind);

  return {
    listLibs: (kind) => listLibsPreferred(kind),
    createLib: remote.createLib?.bind(remote),
    getFpIndex: remote.getFpIndex?.bind(remote),
    async syncState(kind): Promise<LibsSyncState | null> {
      // Read-only warmth probe for the download-consent gate (standalone-
      // load-ux 0002): the backend's list envelope names each lib's primary
      // sync namespace (= its IDB cache key) + expected cold bytes, so warmth
      // is answerable from the local cache alone — no stack resolves, no
      // bundle fetches. A backend predating the `sync` field yields no
      // namespaces at all → null (unknown), never a fake all-cold answer.
      const libs = await listLibsPreferred(kind);
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
      const libs = await listLibsPreferred(presyncOpts?.kind);
      const total = libs.length;
      let done = 0;
      presyncOpts?.onProgress?.({ done, total, current: "libraries" });
      // One batched resolve for the whole set before the per-lib fan-out, so
      // the workers below open stacks without a request each.
      if (!presyncOpts?.signal?.aborted) await prefetchStacks(libs);
      const concurrency = presyncOpts?.concurrency ?? 8;
      const queue = [...libs];
      const worker = async (): Promise<void> => {
        for (let lib = queue.shift(); lib; lib = queue.shift()) {
          if (presyncOpts?.signal?.aborted) return;
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
      offRoomFrames();
      for (const src of perLib.values()) src.dispose?.();
      perLib.clear();
    },
    async enableRealtime(libNames): Promise<void> {
      if (libNames.length === 0) return;
      // Nickname → lib id via the backend listing (one request; the wasm boot
      // has usually made the same call already). Names that don't resolve —
      // project-local table rows, stale nicknames — are simply not ours.
      const wanted = new Set(libNames);
      const libs = (await listLibsPreferred()).filter((l) => wanted.has(l.name));
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
