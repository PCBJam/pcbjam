/**
 * `savePartAndPlace` — the editor side of a remote provider's "add this part"
 * (docs/features/plugins/0015-remote-provider-part-save-contract.md).
 *
 * The part goes into ONE private team library per scope, named after the
 * provider's domain (`eda_cn`), and the symbol is then placed through the
 * verified native placement path. Order of effects and what survives a failure:
 *
 *   validate both bodies in the Worker (nothing written on failure)
 *   → push symbol, then footprint, into the live lib source   (LIB_WRITE_FAILED; not rolled back)
 *   → index both in the DB for the management browser       (best effort)
 *   → tell the running editor: invalidate a mounted lib, or mount a new one
 *   → place (eeschema only)                                    (PLACEMENT_UNAVAILABLE; writes stay)
 *
 * Why the live source and not the item PUT route: the hosted editor runs the
 * synced libs source, where an org lib's items live in a live sync room the
 * editor and every peer read; the PUT route indexes the DB only. In the plain
 * `remote` source the two are the same write, and the DB pass is skipped.
 */
import {
  buildSymbolClipboard,
  providerLibName,
  resolveSymbolDefinition,
  withFootprintProperty,
  wrapSymbolLib,
  PROJECT_HEADER,
  SCOPE_HEADER,
  USER_HEADER,
  type Form,
} from "@pcbjam/shared";
import { API_BASE_URL, userSlug, USER_OVERRIDE_ALLOWED } from "@/lib/config";
import { client } from "@/lib/contract-client";
import { sessionIdentity } from "@/lib/session-identity";
import { placeClipboard, validateInWorker } from "@/plugins/placement";
import { getActiveEditor, type ActiveEditor } from "@/wasm/active-editor";
import { remoteLibsSource } from "@/wasm/libs/remote-source";
import { addAnnouncedLib } from "@/wasm/libs/runtime-add";
import type { LibInfo, LibsSource } from "@/wasm/libs/source";

export interface PartPack {
  /** Provider's origin, e.g. "https://www.eda.cn" — the lib name is derived from it, never sent by the provider. */
  providerOrigin: string;
  /** Manifest id of the remote-provider package, for logs/attribution only. */
  providerId: string;
  partId: string;
  displayName: string;
  /** Exactly the bytes the proxy verified, utf-8 s-expr text. */
  symbol?: { name: string; bytes: Uint8Array };
  footprint?: { name: string; bytes: Uint8Array };
  /** Accepted so the RPC side need not strip them; IGNORED in phase 1. */
  model3d?: { name: string; bytes: Uint8Array; contentType: string };
  spice?: { name: string; bytes: Uint8Array };
}

export interface SavePartOptions {
  /** Place the symbol in the open schematic after saving. Only meaningful in eeschema. */
  place: boolean;
  signal: AbortSignal;
  /**
   * Called once, with the result minus `placement`, as soon as the part is stored — before
   * the placement waits for the user's canvas click — so the provider can be answered early.
   * A throw from it is logged and ignored.
   */
  onSaved?: (result: SavePartResult) => void;
}

export interface SavePartResult {
  libId: string;
  libNickname: string;
  symbolLibId?: string;
  footprintLibId?: string;
  placement?: "placed" | "cancelled";
  skipped: Array<"model3d" | "spice">;
}

export type SavePartCode =
  | "NOT_SIGNED_IN"
  | "NO_TEAM_WRITE"
  | "INVALID_SYMBOL"
  | "INVALID_FOOTPRINT"
  | "TOO_LARGE"
  | "PLACEMENT_UNAVAILABLE"
  | "LIB_WRITE_FAILED";

export class SavePartError extends Error {
  constructor(public readonly code: SavePartCode, message: string) {
    super(message);
    this.name = "SavePartError";
  }
}

/** Everything with an effect outside this module, so the logic is testable without a browser. */
export interface SavePartDeps {
  editor(): ActiveEditor | null;
  identity(): { slug: string } | null;
  createLib(scope: string, name: string): Promise<{ status: number; body?: { id: string; name: string } }>;
  /** A FRESH listing (not the boot-frozen one): `name` is the mounted nickname. */
  listLibs(scope: string, projectId: string): Promise<LibInfo[]>;
  putItem(scope: string, projectId: string, libId: string, kind: string, name: string, body: string): Promise<{ ok: boolean; status: number }>;
  validate: typeof validateInWorker;
  place: typeof placeClipboard;
  addLib: typeof addAnnouncedLib;
  module(): { kicadLibsInvalidate?: (kind: string, nickname: string) => void } | undefined;
  libsMode(): "synced" | "other";
  uuid(): string;
  log(message: string): void;
}

export const SYMBOL_MAX_BYTES = 512 * 1024;
export const FOOTPRINT_MAX_BYTES = 8 * 1024 * 1024;

/** Libs this session mounted at runtime: the boot listing will never know them. */
const mountedThisSession = new Set<string>();
/** Test seam: forget runtime-mounted libs between cases. */
export function resetSavePartState(): void {
  mountedThisSession.clear();
}

function defaultDeps(): SavePartDeps {
  return {
    editor: getActiveEditor,
    // The identity every lib write already travels under: the session user, or in dev/e2e
    // builds the `?user=` override. The server is the authority in `required` auth mode.
    identity: () => {
      const session = sessionIdentity();
      if (session) return session;
      if (USER_OVERRIDE_ALLOWED && new URLSearchParams(window.location.search).has("user")) return { slug: userSlug() };
      return null;
    },
    createLib: async (scope, name) => {
      const res = await client.createLib({ params: { scope }, body: { name } });
      return res.status === 201 ? { status: 201, body: { id: res.body.id, name: res.body.name } } : { status: res.status };
    },
    listLibs: (scope, projectId) => remoteLibsSource(API_BASE_URL, scope, userSlug(), projectId).listLibs(),
    putItem: async (scope, projectId, libId, kind, name, body) => {
      const enc = encodeURIComponent;
      const res = await fetch(`${API_BASE_URL}/api/scopes/${enc(scope)}/libs/${enc(libId)}/items/${enc(kind)}/${enc(name)}`, {
        method: "PUT",
        headers: { [SCOPE_HEADER]: scope, [USER_HEADER]: userSlug(), [PROJECT_HEADER]: projectId, "Content-Type": "text/plain; charset=utf-8" },
        body,
        credentials: "include",
      });
      return { ok: res.ok, status: res.status };
    },
    validate: validateInWorker,
    place: placeClipboard,
    addLib: addAnnouncedLib,
    module: () => (globalThis as { Module?: SavePartDeps extends { module(): infer M } ? NonNullable<M> : never }).Module,
    libsMode: () => (import.meta.env.VITE_LIBS_SOURCE === "synced" ? "synced" : "other"),
    uuid: () => crypto.randomUUID(),
    log: (message) => console.info(message),
  };
}

export function savePartAndPlace(pack: PartPack, opts: SavePartOptions): Promise<SavePartResult> {
  return savePart(pack, opts, defaultDeps());
}

function decode(bytes: Uint8Array, code: "INVALID_SYMBOL" | "INVALID_FOOTPRINT"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SavePartError(code, "The part's file is not valid text");
  }
}

/** Find-or-create the scope's lib for this provider; returns its id and MOUNTED nickname. */
export async function ensureProviderLib(deps: SavePartDeps, scope: string, projectId: string, name: string): Promise<{ id: string; nickname: string; created: boolean }> {
  const created = await deps.createLib(scope, name);
  if (created.status === 403) throw new SavePartError("NO_TEAM_WRITE", "You cannot add libraries to this team");
  if (created.status !== 201 && created.status !== 409) throw new Error("Could not create the team library");
  // The create response carries the raw name only; the mounted nickname (which may carry a
  // collision suffix) comes from a listing.
  const libs = await deps.listLibs(scope, projectId);
  const lib = created.status === 201
    ? libs.find((l) => l.id === created.body!.id)
    : libs.find((l) => l.name === name) ?? libs.find((l) => l.name.startsWith(name + "--"));
  if (!lib) throw new Error("Could not find the team library after creating it");
  return { id: lib.id, nickname: lib.name, created: created.status === 201 };
}

export async function savePart(pack: PartPack, opts: SavePartOptions, deps: SavePartDeps): Promise<SavePartResult> {
  const { signal } = opts;
  const editor = deps.editor();
  if (!editor?.source) throw new SavePartError("PLACEMENT_UNAVAILABLE", "Open a project in the editor first");
  const source: LibsSource = editor.source;
  if (!deps.identity()) throw new SavePartError("NOT_SIGNED_IN", "Sign in to save parts to your team library");
  if (!pack.symbol && !pack.footprint) throw new SavePartError("INVALID_SYMBOL", "The part has neither a symbol nor a footprint");
  if (pack.symbol && pack.symbol.bytes.byteLength > SYMBOL_MAX_BYTES) throw new SavePartError("TOO_LARGE", "The symbol is larger than 512 KiB");
  if (pack.footprint && pack.footprint.bytes.byteLength > FOOTPRINT_MAX_BYTES) throw new SavePartError("TOO_LARGE", "The footprint is larger than 8 MiB");
  const symbolText = pack.symbol ? decode(pack.symbol.bytes, "INVALID_SYMBOL") : null;
  const footprintText = pack.footprint ? decode(pack.footprint.bytes, "INVALID_FOOTPRINT") : null;
  const libName = providerLibName(pack.providerOrigin);
  signal.throwIfAborted();

  // Build and validate everything BEFORE the library exists or anything is written, so a
  // refused part leaves no empty library behind. The nickname is the derived name; a
  // mount-time collision suffix (rare) is applied after the lib is known, and re-validated.
  let resolved: Form | null = null;
  if (symbolText && pack.symbol) {
    try {
      resolved = resolveSymbolDefinition(symbolText, pack.symbol.name);
    } catch (error) {
      throw new SavePartError("INVALID_SYMBOL", error instanceof Error ? error.message : "Invalid symbol");
    }
  }
  const buildSymbol = (nickname: string) => {
    if (!resolved || !pack.symbol) return { def: null, clipboard: null };
    const def = pack.footprint ? withFootprintProperty(resolved, nickname + ":" + pack.footprint.name) : resolved;
    return { def, clipboard: buildSymbolClipboard(def, nickname, pack.symbol.name, deps.uuid()) };
  };
  const validateSymbol = async (clip: { sexpr: string } | null) => {
    if (!clip) return;
    try {
      await deps.validate({ text: clip.sexpr, tool: "eeschema" }, signal);
    } catch (error) {
      throw new SavePartError("INVALID_SYMBOL", error instanceof Error ? error.message : "Invalid symbol");
    }
  };
  let { def, clipboard } = buildSymbol(libName);
  signal.throwIfAborted();
  await validateSymbol(clipboard);
  let footprintBody: string | null = null;
  if (footprintText && pack.footprint) {
    try {
      footprintBody = (await deps.validate({ text: footprintText, tool: "pcbnew", kind: "footprint", name: pack.footprint.name }, signal, 5000)).text;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid footprint";
      throw new SavePartError(/too large/i.test(message) ? "TOO_LARGE" : "INVALID_FOOTPRINT", message);
    }
  }
  signal.throwIfAborted();

  const lib = await ensureProviderLib(deps, editor.scope, editor.projectId, libName);
  const footprintLibId = pack.footprint ? lib.nickname + ":" + pack.footprint.name : undefined;
  if (lib.nickname !== libName) {
    ({ def, clipboard } = buildSymbol(lib.nickname));
    await validateSymbol(clipboard);
  }
  signal.throwIfAborted();

  // Writes: the live source first (what the editor reads), symbol before footprint.
  const written: Array<{ kind: "symbol" | "footprint"; name: string; body: string }> = [];
  if (def && pack.symbol) written.push({ kind: "symbol", name: pack.symbol.name, body: wrapSymbolLib(def) });
  if (footprintBody && pack.footprint) written.push({ kind: "footprint", name: pack.footprint.name, body: footprintBody });
  for (const item of written) {
    let ok = false;
    try {
      ok = (await source.saveItemBody?.(lib.id, item.kind, item.name, item.body)) === true;
    } catch (error) {
      deps.log(`[save-part] ${item.kind} write failed: ${String(error)}`);
    }
    if (!ok) throw new SavePartError("LIB_WRITE_FAILED", "Could not write to the team library. Check your team access and retry.");
  }
  // The DB row is the management browser's index; the room stays the editor's truth.
  if (deps.libsMode() === "synced") {
    for (const item of written) {
      try {
        const res = await deps.putItem(editor.scope, editor.projectId, lib.id, item.kind, item.name, item.body);
        if (!res.ok) deps.log(`[save-part] DB index for ${item.kind} ${item.name} answered ${res.status}`);
      } catch (error) {
        deps.log(`[save-part] DB index for ${item.kind} ${item.name} failed: ${String(error)}`);
      }
    }
  }

  // Tell the running editor. A lib created this session is unknown to the boot-frozen
  // listing, so addAnnouncedLib gets a one-lib view of what we just learned.
  const mounted = !lib.created && !mountedThisSession.has(lib.id) ? await isMounted(source, lib.id) : mountedThisSession.has(lib.id);
  if (mounted) {
    const mod = deps.module();
    for (const item of written) {
      try {
        mod?.kicadLibsInvalidate?.(item.kind, lib.nickname);
      } catch (error) {
        deps.log(`[save-part] invalidate ${item.kind} failed: ${String(error)}`);
      }
    }
  } else {
    const info: LibInfo = { id: lib.id, name: lib.nickname, type: "org" };
    const shim = { listLibs: async () => [info] } as unknown as LibsSource;
    const added = await deps.addLib(shim, { op: "add", libId: lib.id, name: lib.nickname }, deps.log);
    if (added) mountedThisSession.add(lib.id);
    else deps.log("[save-part] the new library could not be mounted live; it will be there after a reload");
  }

  const result: SavePartResult = {
    libId: lib.id,
    libNickname: lib.nickname,
    ...(pack.symbol ? { symbolLibId: lib.nickname + ":" + pack.symbol.name } : {}),
    ...(footprintLibId ? { footprintLibId } : {}),
    skipped: [...(pack.model3d ? ["model3d" as const] : []), ...(pack.spice ? ["spice" as const] : [])],
  };
  try {
    opts.onSaved?.({ ...result, skipped: [...result.skipped] });
  } catch (error) {
    deps.log(`[save-part] onSaved threw: ${String(error)}`);
  }
  if (opts.place && clipboard && editor.tool === "eeschema") {
    signal.throwIfAborted();
    try {
      result.placement = (await deps.place(clipboard.sexpr, "eeschema", signal)).status;
    } catch (error) {
      throw new SavePartError("PLACEMENT_UNAVAILABLE", error instanceof Error ? error.message : "Placement is unavailable");
    }
  }
  return result;
}

async function isMounted(source: LibsSource, libId: string): Promise<boolean> {
  try {
    const libs = await source.listLibs();
    return libs.some((l) => l.id === libId);
  } catch {
    return false;
  }
}
