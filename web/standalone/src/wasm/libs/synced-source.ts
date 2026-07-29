import { PROJECT_HEADER, SCOPE_HEADER, USER_HEADER } from "@pcbjam/shared";
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
      const { stack } = await ensure();
      const path = pathOf(kind, name);
      // A successful push fires exactly one change event (the WS self-echo is
      // hash-deduped inside the layer), and the stack delivers it AFTER an
      // async merged read — so the flag must outlive this call; the subscriber
      // consumes it. A failed push fires none: clear the flag ourselves.
      selfPushed.add(path);
      try {
        await stack.push(path, new TextEncoder().encode(body));
        return true;
      } catch (e) {
        selfPushed.delete(path);
        log(`[synced] save failed for ${kind}/${name}: ${String(e)}`);
        return false;
      }
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
  const res = await baseFetch(
    `${opts.apiBase}/api/scopes/${encodeURIComponent(opts.scope)}/libs/${encodeURIComponent(libId)}/sync-stack`,
    // credentials: session-cookie auth, here and on every layer fetch below —
    // live layers are membership-gated by the API worker per request.
    { method: "POST", headers, credentials: "include" },
  );
  if (!res.ok) throw new Error(`sync-stack resolve failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    lib: { id: string; name: string };
    layers: LayerDescriptor[];
  };
  log(`[synced] resolved ${body.layers.length} layer(s) for lib ${libId}`);

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
  const forLib = (libId: string): LibsSource => {
    let src = perLib.get(libId);
    if (!src) {
      src = syncedLibsSource(libId, opts);
      perLib.set(libId, src);
    }
    return src;
  };

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
      const libs = await remote.listLibs(presyncOpts?.kind);
      const total = libs.length;
      let done = 0;
      presyncOpts?.onProgress?.({ done, total, current: "libraries" });
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
  };
}
