import { asyncMap } from "@/lib/async-map";
import { handleModel3dRequest } from "./models-bridge";
import { libIdFromUri, libUri } from "./uri";

/**
 * The data a `LibsSource` provides. A source abstracts WHERE library data comes
 * from (a remote backend over the shared contract, a static public snapshot, a
 * local folder); the WASM-facing provider below is the same regardless.
 */
export interface LibInfo {
  /** Opaque id used in the lib-table URI (/mnt/pcbjam/<id>). */
  id: string;
  /** Display nickname for the sym-lib-table row. */
  name: string;
  description?: string | null;
  /** 'origin' | 'mirror' | 'user' | 'org' — drives "ensure a writable lib
   *  exists" at boot. 'org' is the private platform's name for a scope's own
   *  writable lib (renamed from 'user' in the team-libs rework); the example
   *  backend and local sources still say 'user'. */
  type?: string;
  /** Item count, when the source knows it cheaply (manifest/backend) — shown as a
   *  badge in the home-page library list. Omitted ⇒ no badge. */
  itemCount?: number;
  /** The lib's r2-idb-sync cache identity from the backend (wire `libSchema.sync`,
   *  standalone-load-ux 0002): the primary sync layer's namespace (= the local
   *  IDB cache key a cold open hydrates) + expected cold-download bytes (null =
   *  unknown). Powers {@link LibsSource.syncState} on the synced source without
   *  resolving N stacks. Omitted by sources without a client-side sync cache. */
  sync?: { namespace: string; bytes?: number | null } | null;
}

export interface LibItemInfo {
  kind: string; // 'symbol' | 'footprint' | 'model3d'
  name: string;
}

/** Per-lib progress for {@link LibsSource.presync} (drives the load screen). */
export interface LibPresyncProgress {
  done: number;
  total: number;
  /** Display name of the lib currently being synced (one of the in-flight set). */
  current: string;
}

/** What {@link LibsSource.syncState} reports (drives the consent dialog). */
export interface LibsSyncState {
  /** Libs of the requested kind this source serves. */
  total: number;
  /** How many of them are already cached locally. */
  warm: number;
  /** Bytes still to download to warm the rest (publish-time bundle sizes). */
  coldBytes: number;
  /** False when the CDN carries no size info (old tag) — coldBytes is then 0
   *  and meaningless even though cold libs exist. */
  sizesKnown: boolean;
}

export interface LibsSource {
  /**
   * Libraries to expose to the editor (one lib-table row each). `kind` (the
   * current tool's item kind, "symbol" | "footprint") filters origins to those
   * holding that kind; user libs are kind-agnostic containers, always listed.
   * Omitted ⇒ all libs.
   */
  listLibs(kind?: string): Promise<LibInfo[]>;
  /** Items in a library (by lib id). */
  listItems(libId: string): Promise<LibItemInfo[]>;
  /**
   * One self-contained item body (a complete `kicad_symbol_lib` s-expr), or
   * null if absent. `kind` is 'symbol' for now.
   */
  getItemBody(libId: string, kind: string, name: string): Promise<string | null>;
  /**
   * ALL items in a library with their bodies, in one shot — the "fat list" that
   * lets the WASM plugin hydrate a whole library in a single bridge crossing
   * instead of N per-item `get`s (see docs/features/libs/0011). Optional: sources
   * that can't bulk-read omit it and the provider falls back to listItems + N
   * getItemBody (the old slow path, kept working for the example backend).
   */
  getAllItems?(
    libId: string,
  ): Promise<Array<{ kind: string; name: string; body: Uint8Array }>>;
  /**
   * Pre-warm this source's per-lib caches (IndexedDB bundles) WITHOUT touching the
   * WASM runtime, so the editor's first enumerate reads a warm cache instead of
   * freezing on N cold bundle fetches. Call it AFTER the wasm bundle and the
   * project's own files are in — with a scope of ~155 libs this is hundreds of
   * fetches, and running it any earlier just starves the downloads the user is
   * actually blocked on. Best-effort: a lib that fails to presync is skipped (it still loads
   * lazily later); the SyncStack dedups, so a lib the wasm reaches mid-presync
   * just awaits the same in-flight fetch. `onProgress` reports per-lib so the load
   * screen can name what's syncing. Optional: sources without a client-side cache
   * (per-item remote) omit it.
   */
  presync?(opts?: {
    /** Limit to libs holding this item kind ("symbol" | "footprint"). */
    kind?: string;
    /** Max concurrent bundle fetches (default 8). */
    concurrency?: number;
    onProgress?: (p: LibPresyncProgress) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * How warm this source's local cache is for `kind`, WITHOUT downloading
   * anything (a read-only probe — presync's dry-run counterpart). Feeds the
   * download-consent dialog (standalone-load-ux 0001): `coldBytes` sums the
   * publish-time bundle sizes of the not-yet-cached libs (0 for libs whose size
   * the source doesn't know — `sizesKnown` says whether sizes were available at
   * all). Resolves null when the source can't tell (e.g. a backend that doesn't
   * expose cache identities) — the dialog then shows the row without figures.
   * Optional: sources without a client-side cache omit it.
   */
  syncState?(kind?: string): Promise<LibsSyncState | null>;
  /**
   * Persist one item body into a writable (user) lib. Optional: read-only
   * sources omit it (a save into a non-writable source resolves false).
   * `body` is a complete fork-native `kicad_symbol_lib` s-expr.
   */
  saveItemBody?(
    libId: string,
    kind: string,
    name: string,
    body: string,
  ): Promise<boolean>;
  /**
   * Create a user library (returns its `LibInfo`, or null if unsupported / on
   * conflict). Used by boot to ensure the owner has a writable target.
   */
  createLib?(name: string): Promise<LibInfo | null>;
  /**
   * The publish-time footprint index as raw JSON text:
   *   { schema, tag, libs: { "<libId>": [["<name>", <uniquePadCount>], …] } }
   * One small artifact covering EVERY footprint lib, so the editor's symbol-
   * chooser footprint selector can pin-count/wildcard-filter the full set
   * without fat-loading a single body (kicad `filterFootprints`, pcbnew.cpp).
   * Optional: sources without a published index omit it (or resolve null) and
   * the C++ side falls back to the per-lib lazy load.
   */
  getFpIndex?(): Promise<string | null>;
  /**
   * Release every live resource this source holds — realtime sockets, open
   * SyncStacks — keeping the persistent caches (IDB) intact for the next
   * session. Called on editor unmount for sources the editor itself created.
   * Optional: stateless sources omit it.
   */
  dispose?(): void;
}

/**
 * The function the WASM lib plugins call via the JS bridge. Both the symbol
 * plugin (`SCH_IO_PCBJAM_LIB`) and the footprint plugin (`PCB_IO_PCBJAM_FP`)
 * call the same hook; `kind` (4th arg) discriminates the item kind. The symbol
 * plugin omits it (passes 3 args) so it defaults to "symbol" — keeping the
 * existing eeschema binary correct with no rebuild.
 */
export type KicadLibsRequest = (
  op: string,
  lib: string,
  arg: string,
  kind?: string,
  // "bodies" returns a framed Uint8Array (raw item bytes, copied as-is across the
  // bridge); every other op returns a string (or null).
) => Promise<string | Uint8Array | null>;

declare global {
  interface Window {
    kicadLibs?: { request: KicadLibsRequest };
  }
}

/**
 * Events the libs bridge dispatches on `window` so the editor chrome (WasmTool)
 * can show a loading state for the otherwise-invisible item fetch, and surface an
 * error when a body can't be loaded (e.g. a backend 404). Decoupled via events so
 * `wasm/libs` stays UI-agnostic.
 */
export const LIB_BUSY_EVENT = "pcbjam:lib-busy";
export const LIB_ERROR_EVENT = "pcbjam:lib-error";
/**
 * Fired around the bulk "fat list" crossing (`list`/`bodies`) — the eager
 * idb→wasm library load that can take tens of seconds on the full CDN set. Unlike
 * LIB_BUSY (per-item open/save), this brackets the whole-library hydrate so the
 * editor chrome can show a "loading libraries, just slow" overlay instead of a
 * silent freeze. One `loading:true` per lib as its crossing starts, `loading:false`
 * as the bytes are handed to the bridge; the consumer coalesces the per-lib run.
 */
export const LIB_LOADING_EVENT = "pcbjam:lib-loading";
/**
 * Fired after a REMOTE (peer) lib edit has been applied to the running editor
 * (the synced source's subscribe → `kicadLibsReload` bridge): names the updated
 * items and which of them are placed in the open document (`usedNames`, via
 * `kicadLibsSymbolUsage`) — so the chrome can warn "a symbol you are using was
 * updated" (placed copies keep the previous version until updated explicitly).
 */
export const LIB_ITEM_UPDATED_EVENT = "pcbjam:lib-item-updated";

export interface LibBusyDetail {
  busy: boolean;
  op: string;
  kind: string;
  name: string;
}
export interface LibErrorDetail {
  message: string;
}
export interface LibLoadingDetail {
  loading: boolean;
  kind: string;
  /** Libraries whose fat-load has started this burst (1-based, increasing). */
  done: number;
  /** Total libs of this kind to load (from listLibs), or 0 if unknown. */
  total: number;
}
export interface LibItemUpdatedDetail {
  /** Display name of the library (its lib-table nickname). */
  lib: string;
  kind: string;
  /** Every item updated in this burst. */
  names: string[];
  /** The subset placed in the open document (empty ⇒ informational only). */
  usedNames: string[];
}

function emitLibBusy(detail: LibBusyDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LIB_BUSY_EVENT, { detail }));
}
function emitLibLoading(detail: LibLoadingDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LIB_LOADING_EVENT, { detail }));
}
function emitLibError(message: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(LIB_ERROR_EVENT, { detail: { message } }),
  );
}

/** Optional artificial latency (`?libdelay=1500`) to exercise the bridge. */
function artificialDelayMs(): number {
  const raw = new URLSearchParams(window.location.search).get("libdelay");
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Slow-path "fat list" for sources without a bulk `getAllItems` (the example
 * backend / per-item remote): just listItems + one getItemBody each. Same N
 * round-trips as before — but it keeps the single WASM-side code path (the plugin
 * always asks for bodies once) working against every source. The per-item gets
 * run 8 at a time (they're independent HTTP round-trips); order is preserved.
 */
async function fallbackGetAllItems(
  source: LibsSource,
  libId: string,
): Promise<Array<{ kind: string; name: string; body: Uint8Array }>> {
  const items = await source.listItems(libId);
  const enc = new TextEncoder();
  const bodies = await asyncMap(
    items,
    (it) => source.getItemBody(libId, it.kind, it.name).catch(() => null),
    8,
  );
  return items.flatMap((it, i) => {
    const body = bodies[i];
    return body != null
      ? [{ kind: it.kind, name: it.name, body: enc.encode(body) }]
      : [];
  });
}

/** Escape a string for a KiCad s-expr quoted token. */
function sexprEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build sym-lib-table content (KiCad v7) with one PCBJAM row per lib. */
export function buildSymLibTable(libsList: LibInfo[]): string {
  const rows = libsList.map((l) => {
    const descr = l.description ? sexprEscape(l.description) : "";
    return `  (lib (name "${sexprEscape(l.name)}")(type "PCBJAM")(uri "${libUri(
      l.id,
    )}")(options "")(descr "${descr}"))`;
  });
  return `(sym_lib_table\n  (version 7)\n${rows.join("\n")}${
    rows.length ? "\n" : ""
  })\n`;
}

/**
 * Build fp-lib-table content (KiCad v7) with one PCBJAM_FP row per lib. The
 * footprint editor selects the plugin from this row's `type` field (via
 * PCB_IO_MGR::EnumFromStr), so it MUST be "PCBJAM_FP" to match the registered
 * plugin name. Same /mnt/pcbjam/<id> URI as symbols (the same lib id can appear
 * in both tables — user libs are kind-agnostic containers).
 */
export function buildFpLibTable(libsList: LibInfo[]): string {
  const rows = libsList.map((l) => {
    const descr = l.description ? sexprEscape(l.description) : "";
    return `  (lib (name "${sexprEscape(
      l.name,
    )}")(type "PCBJAM_FP")(uri "${libUri(
      l.id,
    )}")(options "")(descr "${descr}"))`;
  });
  return `(fp_lib_table\n  (version 7)\n${rows.join("\n")}${
    rows.length ? "\n" : ""
  })\n`;
}

/**
 * Install `window.kicadLibs` backed by a `LibsSource`. Both lib plugins call
 * `request(op, "/mnt/pcbjam/<id>", arg, kind)` (kind defaults to "symbol" so the
 * symbol plugin's 3-arg calls still work):
 *   "list"  -> JSON {"symbols":[...]} | {"footprints":[...]}  (names of that kind)
 *   "get"   -> the item body s-expr     (arg = item name; null if absent)
 *   "save"  -> "ok" / null              (arg = JSON {"name":..,"body":..})
 *   "index" -> the publish-time footprint index JSON (source-global; lib arg
 *              ignored) / null when the source has none — see getFpIndex.
 */
export interface LibsProviderOptions {
  /**
   * Hold every enumerate ("list", including the fat "bodies" variant — a plain
   * name list also opens the lib's sync stack, i.e. cold-fetches its bundle)
   * for the given kind until the returned promise resolves. The lib editors
   * pass their presync-settled promise: their frame eagerly enumerates EVERY
   * lib of its kind at boot, one mutex-serialized bridge crossing at a time
   * (see g_pcbjamProxyMutex in the plugins), so a cold lib would network-fetch
   * inside its serial crossing — the gate lets the 8-wide parallel presync
   * warm IndexedDB first and the crossings become local read + parse.
   * MUST always resolve (the presync is best-effort and never rejects);
   * "get"/"save"/"index" are user-triggered and never gated.
   */
  enumerateGate?: (kind: string) => Promise<void>;
}

export function installLibsProvider(
  source: LibsSource,
  log: (msg: string) => void,
  opts?: LibsProviderOptions,
): void {
  if (window.kicadLibs) return;
  const delay = artificialDelayMs();

  // Per-burst fat-load progress. The plugin fat-loads every library of a kind
  // one bridge crossing at a time, so counting `bodies` requests gives real
  // per-lib progress; `total` comes from listLibs(kind) (cached). A trailing
  // timer resets the counter once a burst goes quiet, so a later open starts
  // fresh (mirrors the overlay's own hide debounce).
  let fatDone = 0;
  let fatTotal = 0;
  let fatResetTimer: ReturnType<typeof setTimeout> | undefined;

  const request: KicadLibsRequest = async (op, lib, arg, kind = "symbol") => {
    // 3D models are addressed by ref, not lib-table URI (the C++ ensure bridge
    // passes an empty lib) — dispatch before the lib-id parse would null it out.
    if (kind === "model3d") {
      log(`[libs] request op=${op} kind=model3d arg=${arg}`);
      return handleModel3dRequest(op, arg);
    }
    // The footprint index is source-global (not per-lib) — dispatch before the
    // lib-id parse, which would reject the bare mount URI the C++ side passes.
    if (op === "index") {
      log(`[libs] request op=index kind=${kind}`);
      return kind === "footprint" && source.getFpIndex
        ? await source.getFpIndex()
        : null;
    }
    const id = libIdFromUri(lib);
    log(`[libs] request op=${op} kind=${kind} lib=${lib} (id=${id}) arg=${arg}`);
    if (!id) return null;
    if (delay) await sleep(delay);

    // "get"/"save" are user-triggered (open/save an item) and otherwise give no
    // visible feedback — broadcast busy + errors so the editor can show them.
    const userFacing = op === "get" || op === "save";
    if (userFacing) emitLibBusy({ busy: true, op, kind, name: arg });
    try {
      switch (op) {
        case "list": {
          // Enumerate gate (load-fanout): park this crossing (Asyncify) until
          // the caller's precondition — typically the presync — has settled.
          if (opts?.enumerateGate) await opts.enumerateGate(kind);
          // Each plugin parses its own key: footprints / symbols.
          const key = kind === "footprint" ? "footprints" : "symbols";
          // "bodies" (arg) = the fat list: every item's body in one crossing, so
          // the plugin pre-fills its cache and never per-item `get`s. Falls back
          // to listItems + N getItemBody for sources without bulk read.
          if (arg === "bodies") {
            // Bracket the whole-library hydrate so the editor can overlay a
            // "loading libraries (slow, not hung)" state over the otherwise
            // silent multi-second freeze. `true` before the (async) IDB read so
            // the overlay can paint while the C++ side is Asyncify-suspended;
            // `false` once the bytes are framed and about to cross the bridge.
            clearTimeout(fatResetTimer);
            if (fatTotal === 0) {
              // First lib of the burst — learn the total for the progress bar.
              try {
                fatTotal = (await source.listLibs(kind)).length;
              } catch {
                fatTotal = 0;
              }
            }
            fatDone++;
            emitLibLoading({ loading: true, kind, done: fatDone, total: fatTotal });
            try {
              const all = source.getAllItems
                ? await source.getAllItems(id)
                : await fallbackGetAllItems(source, id);
              const items = all.filter((i) => i.kind === kind);
              // "Copy as-is" framing: a one-line JSON header (names + UTF-8 byte
              // lengths), a newline, then every body's RAW bytes concatenated — no
              // JSON escaping. The C++ bridge memcpy's this straight into the wasm
              // heap; the plugin parses the small header and slices the bodies, so
              // none of the (hundreds of MB of) s-expr gets un-escaped.
              const header = JSON.stringify({
                [key]: items.map((i) => ({ name: i.name, len: i.body.length })),
              });
              const headerBytes = new TextEncoder().encode(header + "\n");
              const total =
                headerBytes.length +
                items.reduce((n, i) => n + i.body.length, 0);
              const out = new Uint8Array(total);
              out.set(headerBytes, 0);
              let off = headerBytes.length;
              for (const i of items) {
                out.set(i.body, off);
                off += i.body.length;
              }
              return out;
            } finally {
              emitLibLoading({
                loading: false,
                kind,
                done: fatDone,
                total: fatTotal,
              });
              // Reset the per-burst counter once the run goes quiet, so the next
              // open starts from zero (the WASM drives these back-to-back).
              fatResetTimer = setTimeout(() => {
                fatDone = 0;
                fatTotal = 0;
              }, 1500);
            }
          }
          const items = await source.listItems(id);
          const names = items
            .filter((i) => i.kind === kind)
            .map((i) => i.name);
          return JSON.stringify({ [key]: names });
        }
        case "get": {
          const body = await source.getItemBody(id, kind, arg);
          if (body === null) {
            emitLibError(
              `Couldn't open "${arg}" — the backend has no body for it (404).`,
            );
          }
          return body;
        }
        case "save": {
          let parsed: { name?: string; body?: string };
          try {
            parsed = JSON.parse(arg) as { name?: string; body?: string };
          } catch {
            log(`[libs] save: bad JSON arg`);
            return null;
          }
          if (!parsed.name || !parsed.body) return null;
          if (!source.saveItemBody) {
            log(`[libs] save: source has no write support (lib=${id})`);
            return null;
          }
          const ok = await source.saveItemBody(
            id,
            kind,
            parsed.name,
            parsed.body,
          );
          if (!ok) emitLibError(`Couldn't save "${parsed.name}".`);
          return ok ? "ok" : null;
        }
        default:
          return null;
      }
    } catch (e) {
      log(`[libs] request failed: ${String(e)}`);
      if (userFacing) emitLibError(`Failed to ${op} "${arg}".`);
      return null;
    } finally {
      if (userFacing) emitLibBusy({ busy: false, op, kind, name: arg });
    }
  };

  window.kicadLibs = { request };
  log("[libs] provider installed");
}
