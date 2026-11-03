/**
 * libs 0031: the page half of "copy instead of override". A part of a library
 * the user can't write (a KiCad library, a frozen override, another team's
 * public library) is copied into the team's default library and edited there.
 * KiCad calls `window.pcbjamPartCopy` from wasm/bindings/part_copy_symbol.h and
 * part_copy_footprint.h:
 *
 *  - `notice(kind, lib, name)`: the read-only banner's text and its copy button
 *    (synchronous; members of the team get the button).
 *  - `copy(kind, lib, name)`: the banner button. The server copies the part
 *    (libs 0021's transfer, models and datasheets included), then the copy's
 *    library reloads in the editor and the copy opens.
 *  - `save(request)`: Save / Save All reached parts of a read-only library. The
 *    modal lists every part and where it goes; on Save the edited parts are
 *    written into the team library, the editor reloads it, and KiCad reverts
 *    the originals and opens the copy that was on screen.
 *
 * Placed parts are never switched: the design keeps the original until the
 * user runs Change Symbols / changes the Footprint field.
 */
import { PROJECT_HEADER, SCOPE_HEADER, USER_HEADER } from "@pcbjam/shared";
import { toast } from "@pcbjam/ui";
import { API_BASE_URL, userSlug } from "@/lib/config";
import { getActiveEditor, type ActiveEditor } from "@/wasm/active-editor";
import { addAnnouncedLib } from "@/wasm/libs/runtime-add";
import type { LibInfo, LibsSource } from "@/wasm/libs/source";
import { askPartCopySave } from "./part-copy-prompt";

export type PartKind = "symbol" | "footprint";

export interface CopyTarget {
  /** Null in a preview when the team's default library doesn't exist yet. */
  libId: string | null;
  /** Its lib-table nickname in the editor. */
  lib: string;
  /** The copy's name there. */
  name: string;
  created: boolean;
}

/** What KiCad's save gate sends: every part the save writes. */
export interface SaveRequest {
  kind: PartKind;
  saveAll: boolean;
  rows: Array<{ lib: string; name: string; readOnly: boolean; body?: string }>;
}

/** One row of the save modal. */
export interface SaveModalRow {
  lib: string;
  name: string;
  readOnly: boolean;
  /** Read-only rows: where the copy goes; `earlier` = it replaces an earlier copy. */
  target?: CopyTarget & { earlier: boolean };
  /** Read-only rows that can't be copied, and why. */
  error?: string;
}

export interface SaveModalRequest {
  kind: PartKind;
  rows: SaveModalRow[];
}

export interface CopiedRow {
  lib: string;
  name: string;
  targetLib: string;
  targetName: string;
  /** False when the copy's library isn't in this session (a one-library editor). */
  open: boolean;
}

export type SaveAnswer = { action: "cancel" } | { action: "save"; copied: CopiedRow[] };

export interface BannerNotice {
  message: string;
  button?: string;
}

export interface PartCopyNotify {
  /** Same id = the same toast, updated. */
  id: string;
  state: "progress" | "done" | "error";
  message: string;
  /** A link that opens in a new tab (a one-library editor can't show the copy). */
  link?: { label: string; href: string };
}

/** Everything with an effect outside this module, so the flows are testable without a browser. */
export interface PartCopyDeps {
  editor(): ActiveEditor | null;
  /** The editor shows one library only (opened from the library browser). */
  libScoped(): boolean;
  fetch(path: string, init: { method: string; body?: unknown }, editor: ActiveEditor): Promise<{ status: number; body: unknown }>;
  module(): Record<string, unknown> | undefined;
  addLib: typeof addAnnouncedLib;
  confirmSave(request: SaveModalRequest): Promise<boolean>;
  notify(n: PartCopyNotify): void;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

interface TargetInfo {
  canCopy: boolean;
  libId: string | null;
  lib: string;
}

const enc = encodeURIComponent;
const TOOL_OF: Record<PartKind, string> = { symbol: "symbol_editor", footprint: "footprint_editor" };
/** How long a finished copy may take to reach this page's view of its library. */
const LISTED_TIMEOUT_MS = 20_000;
const POLL_MS = 400;
/** A copy waits behind another one into the same library at most this often. */
const BUSY_RETRIES = 3;

class PartCopyError extends Error {}

export function createPartCopyBridge(deps: PartCopyDeps) {
  let target: TargetInfo | null = null;
  /** Lib-table nickname → library, for the synchronous banner text. */
  const libsByName = new Map<string, LibInfo>();
  /**
   * `kind:libId` of the libraries this bridge added to the running editor. The
   * source's listing is the one from boot and never shows them, so without this
   * a second copy into a library made this session would add it again.
   */
  const addedLibs = new Set<string>();

  /** Load what the banner needs; the banner works without it (button shown, generic text). */
  async function prime(): Promise<void> {
    const ed = deps.editor();
    if (!ed?.source) return;
    try {
      const res = await deps.fetch(`/api/scopes/${enc(ed.scope)}/part-copy-target`, { method: "GET" }, ed);
      if (res.status === 200) target = res.body as TargetInfo;
    } catch (e) {
      deps.log(`[part-copy] target lookup failed: ${String(e)}`);
    }
    try {
      for (const lib of await ed.source.listLibs()) libsByName.set(lib.name, lib);
    } catch (e) {
      deps.log(`[part-copy] library list failed: ${String(e)}`);
    }
  }

  function teamLibName(ed: ActiveEditor): string {
    return target?.lib ?? ed.scope;
  }

  function notice(kind: PartKind, lib: string, _name: string): BannerNotice | null {
    const ed = deps.editor();
    if (!ed?.source || ed.scope === "local") return null;
    const owner = libsByName.get(lib)?.type;
    const message =
      owner === "origin"
        ? `${lib} is read-only for you (it belongs to KiCad).`
        : owner === "mirror"
          ? `${lib} is read-only: overrides of KiCad parts can't be changed any more.`
          : owner === "org"
            ? `${lib} is read-only for you (it belongs to another team).`
            : `${lib} is read-only for you.`;
    if (target && !target.canCopy) return { message: `${message} Only members of ${ed.scope} can copy ${kind}s into its libraries.` };
    return { message, button: `Copy to "${teamLibName(ed)}" library` };
  }

  function copy(kind: PartKind, lib: string, name: string): void {
    void runCopy(kind, lib, name).catch((e) => deps.log(`[part-copy] copy failed: ${String(e)}`));
  }

  async function runCopy(kind: PartKind, lib: string, name: string): Promise<void> {
    const ed = deps.editor();
    if (!ed?.source) return;
    const id = `part-copy:${kind}:${lib}:${name}`;
    deps.notify({ id, state: "progress", message: `Copying ${lib}:${name} to "${teamLibName(ed)}"…` });
    try {
      const source = await libIdOf(ed, lib);
      let res = await copyRequest(ed, source, { kind, name });
      for (let i = 0; res.status === 409 && busyOperation(res.body) && i < BUSY_RETRIES; i++) {
        await waitOperation(ed, source, busyOperation(res.body)!);
        res = await copyRequest(ed, source, { kind, name });
      }
      const out = expectOk(res) as { state: string; target: CopyTarget & { libId: string }; operation?: { id: string } };
      if (out.state === "copying" && out.operation) await waitOperation(ed, out.target.libId, out.operation.id);

      const libScoped = deps.libScoped();
      if (libScoped) {
        deps.notify({
          id,
          state: "done",
          message: `Copied to "${out.target.lib}" as ${out.target.name}.`,
          link: { label: "Open", href: libEditorHref(ed, out.target.libId, kind) },
        });
        return;
      }
      await showInEditor(ed, kind, out.target, [out.target.name]);
      const open = deps.module()?.[kind === "symbol" ? "kicadSymbolEditorOpenCopy" : "kicadFootprintEditorOpenCopy"];
      if (typeof open === "function") (open as (...a: string[]) => boolean)(lib, name, out.target.lib, out.target.name);
      deps.notify({ id, state: "done", message: copiedMessage(kind, lib, name, out.target, out.state === "existing") });
    } catch (e) {
      deps.notify({ id, state: "error", message: `Couldn't copy ${lib}:${name}: ${errorText(e)}` });
    }
  }

  async function save(request: SaveRequest): Promise<SaveAnswer | null> {
    const ed = deps.editor();
    if (!ed?.source) return null;
    const kind = request.kind;
    const rows: SaveModalRow[] = [];
    for (const row of request.rows) {
      if (!row.readOnly) {
        rows.push({ lib: row.lib, name: row.name, readOnly: false });
        continue;
      }
      try {
        const res = await copyRequest(ed, await libIdOf(ed, row.lib), { kind, name: row.name, preview: true });
        const out = expectOk(res) as { target: CopyTarget; earlier?: boolean };
        rows.push({ lib: row.lib, name: row.name, readOnly: true, target: { ...out.target, earlier: out.earlier === true } });
      } catch (e) {
        rows.push({ lib: row.lib, name: row.name, readOnly: true, error: errorText(e) });
      }
    }
    if (!(await deps.confirmSave({ kind, rows }))) return { action: "cancel" };

    const libScoped = deps.libScoped();
    const copied: Array<CopiedRow & { libId: string }> = [];
    const id = `part-copy:save:${kind}`;
    for (const row of request.rows) {
      if (!row.readOnly || row.body === undefined) continue;
      deps.notify({ id, state: "progress", message: `Copying ${row.lib}:${row.name} to "${teamLibName(ed)}"…` });
      try {
        const source = await libIdOf(ed, row.lib);
        let res = await copyRequest(ed, source, { kind, name: row.name, body: row.body });
        for (let i = 0; res.status === 409 && busyOperation(res.body) && i < BUSY_RETRIES; i++) {
          await waitOperation(ed, source, busyOperation(res.body)!);
          res = await copyRequest(ed, source, { kind, name: row.name, body: row.body });
        }
        const out = expectOk(res) as { target: CopyTarget & { libId: string } };
        copied.push({ lib: row.lib, name: row.name, targetLib: out.target.lib, targetName: out.target.name, libId: out.target.libId, open: !libScoped });
      } catch (e) {
        deps.notify({ id: `${id}:${row.lib}:${row.name}`, state: "error", message: `Couldn't copy ${row.lib}:${row.name}: ${errorText(e)}` });
      }
    }

    if (copied.length) {
      const first = copied[0]!;
      if (libScoped) {
        deps.notify({
          id,
          state: "done",
          message: `Saved to "${first.targetLib}": ${copied.map((c) => c.targetName).join(", ")}.`,
          link: { label: "Open", href: libEditorHref(ed, first.libId, kind) },
        });
      } else {
        // Before answering KiCad: the copies' libraries must reload ahead of
        // the copy KiCad opens next (both run on the editor's queue, in order).
        const byLib = new Map<string, { target: CopyTarget & { libId: string }; names: string[] }>();
        for (const c of copied) {
          const entry = byLib.get(c.libId) ?? { target: { libId: c.libId, lib: c.targetLib, name: c.targetName, created: false }, names: [] };
          entry.names.push(c.targetName);
          byLib.set(c.libId, entry);
        }
        for (const { target: t, names } of byLib.values()) await showInEditor(ed, kind, t, names);
        deps.notify({
          id,
          state: "done",
          message: `Saved ${copied.length === 1 ? `${first.lib}:${first.name} as a copy` : `${copied.length} copies`} in "${first.targetLib}". ${switchHint(kind)}`,
        });
      }
    } else {
      deps.notify({ id, state: "error", message: "Nothing was saved." });
    }
    return { action: "save", copied: copied.map(({ libId: _libId, ...c }) => c) };
  }

  /** The library's id from its lib-table nickname. */
  async function libIdOf(ed: ActiveEditor, lib: string): Promise<string> {
    const known = libsByName.get(lib);
    if (known) return known.id;
    for (const l of await ed.source!.listLibs()) libsByName.set(l.name, l);
    const found = libsByName.get(lib);
    if (!found) throw new PartCopyError(`library ${lib} isn't available here`);
    return found.id;
  }

  function copyRequest(ed: ActiveEditor, libId: string, body: Record<string, unknown>) {
    return deps.fetch(`/api/scopes/${enc(ed.scope)}/libs/${enc(libId)}/items/copy-to-team`, { method: "POST", body }, ed);
  }

  async function waitOperation(ed: ActiveEditor, libId: string, operationId: string): Promise<void> {
    for (;;) {
      const res = await deps.fetch(`/api/scopes/${enc(ed.scope)}/libs/${enc(libId)}/items/transfer/${enc(operationId)}`, { method: "GET" }, ed);
      const op = (expectOk(res) as { operation: { status: string; error: string | null } }).operation;
      if (op.status === "succeeded") return;
      if (op.status === "failed") throw new PartCopyError(op.error ?? "the copy failed");
      await deps.sleep(POLL_MS);
    }
  }

  /**
   * Make the editor see the new parts: a library this session doesn't have yet
   * is added (to the table of this kind only); one it has reloads once the
   * parts' bodies can be read here. The listing alone isn't enough: it can come
   * from the library's index while the body reaches the page's copy of the
   * library a moment later, and KiCad opens the copy by reading its body (the
   * plugin's `get`).
   */
  async function showInEditor(ed: ActiveEditor, kind: PartKind, t: CopyTarget & { libId: string }, names: string[]): Promise<void> {
    const source = ed.source!;
    const key = `${kind}:${t.libId}`;
    const listed =
      addedLibs.has(key) || (await source.listLibs(kind).then((libs) => libs.some((l) => l.id === t.libId), () => false));
    if (!listed) {
      const info: LibInfo = { id: t.libId, name: t.lib, type: "org" };
      const shim = { listLibs: async (k?: string) => (k === kind ? [info] : []) } as unknown as LibsSource;
      if (await deps.addLib(shim, { op: "add", libId: t.libId, name: t.lib }, deps.log)) addedLibs.add(key);
      else deps.log(`[part-copy] ${t.lib} could not be added to the session`);
      libsByName.set(t.lib, info);
      return;
    }
    const want = new Set(names);
    for (let waited = 0; waited < LISTED_TIMEOUT_MS; waited += POLL_MS) {
      for (const name of [...want]) {
        if (await source.getItemBody(t.libId, kind, name).catch(() => null)) want.delete(name);
      }
      if (want.size === 0) break;
      await deps.sleep(POLL_MS);
    }
    if (want.size) deps.log(`[part-copy] ${[...want].join(", ")} not in ${t.lib} yet; reloading it anyway`);
    const invalidate = deps.module()?.kicadLibsInvalidate;
    if (typeof invalidate === "function") (invalidate as (kind: string, nickname: string) => void)(kind, t.lib);
  }

  return { prime, notice, copy, save };
}

export type PartCopyBridge = ReturnType<typeof createPartCopyBridge>;

function busyOperation(body: unknown): string | null {
  const b = body as { code?: string; operationId?: string } | null;
  return b?.code === "library-busy" && typeof b.operationId === "string" ? b.operationId : null;
}

function expectOk(res: { status: number; body: unknown }): unknown {
  if (res.status === 200 || res.status === 202) return res.body;
  const message = (res.body as { message?: string } | null)?.message;
  if (res.status === 403) throw new PartCopyError(message ?? "you can't copy parts into this team's libraries");
  throw new PartCopyError(message ?? `the server answered ${res.status}`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function switchHint(kind: PartKind): string {
  return kind === "symbol"
    ? "Placed symbols keep using the originals; switch them with Change Symbols."
    : "Placed footprints keep using the originals; switch them in the schematic's Footprint field.";
}

function copiedMessage(kind: PartKind, lib: string, name: string, t: CopyTarget, existing: boolean): string {
  const where = `"${t.lib}"${t.name !== name ? ` as ${t.name}` : ""}`;
  return existing
    ? `Opened your earlier copy of ${lib}:${name} in ${where}.`
    : `Copied ${lib}:${name} to ${where}. ${switchHint(kind)}`;
}

function libEditorHref(ed: ActiveEditor, libId: string, kind: PartKind): string {
  return `/${enc(ed.scope)}/libs/${enc(libId)}?tool=${TOOL_OF[kind]}`;
}

function defaultDeps(opts: { libScoped: boolean }): PartCopyDeps {
  return {
    editor: getActiveEditor,
    libScoped: () => opts.libScoped,
    fetch: async (path, init, ed) => {
      const res = await fetch(`${API_BASE_URL}${path}`, {
        method: init.method,
        headers: {
          [SCOPE_HEADER]: ed.scope,
          [USER_HEADER]: userSlug(),
          ...(ed.projectId && ed.projectId !== "local" ? { [PROJECT_HEADER]: ed.projectId } : {}),
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        credentials: "include",
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    module: () => (globalThis as { Module?: Record<string, unknown> }).Module,
    addLib: addAnnouncedLib,
    confirmSave: askPartCopySave,
    notify: (n) => {
      const options = {
        id: n.id,
        ...(n.link ? { action: { label: n.link.label, onClick: () => window.open(n.link!.href, "_blank", "noopener") } } : {}),
      };
      if (n.state === "progress") toast.loading(n.message, options);
      else if (n.state === "done") toast.success(n.message, { ...options, duration: n.link ? 15_000 : 6_000 });
      else toast.error(n.message, { ...options, duration: 10_000 });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.info(message),
  };
}

/** Install the bridge for the running editor; the returned function removes it. */
export function installPartCopyBridge(opts: { libScoped: boolean }, deps: PartCopyDeps = defaultDeps(opts)): () => void {
  const bridge = createPartCopyBridge(deps);
  const win = globalThis as { pcbjamPartCopy?: PartCopyBridge };
  win.pcbjamPartCopy = bridge;
  void bridge.prime();
  return () => {
    if (win.pcbjamPartCopy === bridge) delete win.pcbjamPartCopy;
  };
}
