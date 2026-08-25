// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import {
  collabRoomId,
  docToFile,
  fileToDoc,
  ydocHasState,
  yToDoc,
  type KicadDoc,
  type Tool,
} from "@pcbjam/shared";
import { presenceUser, yjsProviderConfig, type DocSource } from "@/lib/config";
import { memfsFilePath } from "@/wasm/constants";
import { readStagedFile, type ToolFile } from "@/wasm/kicad-runner";
import { resolveSheetHierarchy } from "@/wasm/collab/sheet-hierarchy";
import type { SaveBytes } from "@/wasm/save-flow";
import type { KicadCollabHandle, KicadDocSession, KicadItemsWindow } from "@/wasm/collab";
import {
  createSheetCollabManager,
  registerSheetChangedHook,
  registerSheetCreatedHook,
  type ActiveSheet,
  type SheetChangedWindow,
  type SheetCollabManager,
  type SheetCreatedWindow,
} from "@/wasm/collab/sheet-manager";
import { clog, cwarn } from "@/wasm/collab/debug";
import { relativeProjectPath } from "./tool-navigation";
import { COLLAB_TOOLS } from "./ui-helpers";

/**
 * Read the opened file back from MEMFS (what the editor actually loaded) and
 * parse it into the full `KicadDoc` (ysync 0007 `fileToDoc`). Used to seed the
 * Y.Doc LOSSLESSLY when this client opens an empty room (ysync 0005): the doc
 * then carries meta + layout + items, so the file is recoverable from the Y.Doc
 * alone. Falls back to undefined (→ editor-snapshot seed, items only) when the
 * file is absent or doesn't parse as a KiCad s-expr document.
 */
export function seedDocFromMemfs(
  win: ToolWindow,
  slug: string,
  targetPath?: string,
): KicadDoc | undefined {
  if (!targetPath) return undefined;
  try {
    const text = win.FS?.readFile(memfsFilePath(slug, targetPath), { encoding: "utf8" });
    if (typeof text !== "string") return undefined;
    return fileToDoc(text);
  } catch (err) {
    cwarn("seed: fileToDoc failed — falling back to editor-snapshot seed", err);
    return undefined;
  }
}

/**
 * The `docSource: "ydoc"` pre-step (config/env-selected — same /p/ URLs as "api"
 * mode): connect the document's collab room BEFORE the file opens and, when the
 * room already holds the doc, materialize the file from it (docToFile) so the
 * editor opens the doc's state instead of the API's copy. An empty room (first
 * ever open) falls back to the API fetch — the seed() that follows file-seeds
 * the room from it. Returns the session for `maybeStartCollab` to attach to.
 */
export async function maybeConnectDocSession(
  win: ToolWindow,
  opts: {
    docSource?: DocSource;
    tool: Tool;
    scopeId: string;
    projectId: string;
    targetPath?: string;
    /** Unmount abort — cancels the connect and destroys partials (C-1/C-3). */
    signal?: AbortSignal;
    log: (m: string) => void;
  },
): Promise<{ session?: KicadDocSession; targetBytes?: Uint8Array }> {
  if (opts.docSource !== "ydoc") return {};
  if (!opts.targetPath || !COLLAB_TOOLS.has(opts.tool)) return {};

  const { connectKicadDoc } = await import("@/wasm/collab");
  const room = collabRoomId(opts.scopeId, opts.projectId, opts.targetPath);
  const session = await connectKicadDoc({
    provider: yjsProviderConfig(),
    room,
    signal: opts.signal,
  });

  // Use the full doc state (meta + layout + items), NOT just item count: a
  // populated drawing sheet (pl_editor `.kicad_wks`) has zero uuid items, so an
  // items-only check makes a joining tab refetch the stale file instead of
  // materializing the shared doc's current state.
  if (!ydocHasState(session.doc)) {
    opts.log(`[ydoc] room ${room} is empty — falling back to the API fetch (will file-seed)`);
    return { session };
  }
  try {
    const text = docToFile(yToDoc(session.doc));
    opts.log(`[ydoc] materialized ${opts.targetPath} from room ${room} (${text.length} chars)`);
    return { session, targetBytes: new TextEncoder().encode(text) };
  } catch (err) {
    cwarn("ydoc: materialize failed — falling back to the API fetch", err);
    return { session };
  }
}

/**
 * Collaborative editing (ysync 0008, Slot-model items wire), ON BY DEFAULT for any
 * tool that has the collab bridge. Open the same project URL in two tabs to edit
 * together: the channel is keyed to project+file, so both tabs share one Y.Doc over
 * BroadcastChannel. Editor edits (add/move items) fire the tool's change hook → the
 * bridge → the peer tab.
 *
 * Opt OUT with `?collab=0` (or `collab=false`). Tools without a bridge are skipped anyway.
 */
export async function maybeStartCollab(
  win: ToolWindow,
  opts: {
    tool: Tool;
    slug: string;
    scopeId: string;
    projectId: string;
    targetPath?: string;
    collabSession?: KicadDocSession;
    /** The opened file was materialized from collabSession's doc (ydoc source). */
    editorMatchesDoc?: boolean;
    /** Read-only viewer (read-only-viewer): see `bindKicadCollab`. */
    readOnly?: boolean;
    log: (m: string) => void;
    onStatus: (t: string) => void;
  },
): Promise<KicadCollabHandle | undefined> {
  const collabParam = new URLSearchParams(win.location.search).get("collab");
  const mod = win.Module;
  clog("maybeStartCollab gate:", {
    collabParam,
    tool: opts.tool,
    hasModule: !!mod,
    hasSnapshotItems: typeof mod?.kicadCollabSnapshotItems,
    hasApplyItems: typeof mod?.kicadCollabApplyItems,
    url: win.location.href,
  });

  // On by default; only an explicit opt-out disables it. A pre-connected doc
  // session (Y.Doc-load path) ignores the opt-out: the doc IS the data source,
  // so detaching would silently drop every edit.
  if (!opts.collabSession && (collabParam === "0" || collabParam === "false")) {
    clog("disabled (?collab=0) — skipping");
    return undefined;
  }
  if (!COLLAB_TOOLS.has(opts.tool)) {
    clog(`tool ${opts.tool} has no collab bridge — skipping`);
    return undefined;
  }
  if (typeof mod?.kicadCollabSnapshotItems !== "function") {
    cwarn(
      "BRIDGE NOT PRESENT: Module.kicadCollabSnapshotItems is",
      typeof mod?.kicadCollabSnapshotItems,
      `— the loaded ${opts.tool}.wasm predates the v2 items bridge (ysync 0008 Stage C). Rebuild + \`npm run setup:kicad\` and restart the dev server.`,
    );
    return undefined;
  }

  const { startKicadCollab, attachKicadCollab } = await import("@/wasm/collab");
  const seedDoc = seedDocFromMemfs(win, opts.slug, opts.targetPath);

  if (opts.collabSession) {
    // docSource "ydoc": the provider is already connected. When the editor
    // opened the file materialized from this very doc, attach + baseline only;
    // when the room was empty (API fallback), seed() file-seeds it as usual.
    clog("attaching to pre-connected doc session; editorMatchesDoc:", !!opts.editorMatchesDoc);
    const handle = attachKicadCollab(mod, win as unknown as KicadItemsWindow, opts.collabSession, {
      seedDoc,
      editorMatchesDoc: opts.editorMatchesDoc,
      readOnly: opts.readOnly,
    });
    opts.log(`[collab] attached to Y.Doc session`);
    opts.onStatus("Collab: connected");
    clog("connected ✓");
    return handle;
  }

  const provider = yjsProviderConfig();
  // One room per (project, document). Two tabs of the same build compute the
  // same id, so cross-tab BroadcastChannel still works; network providers use it
  // verbatim to namespace + persist (see @pcbjam/shared collabRoomId).
  const room = collabRoomId(opts.scopeId, opts.projectId, opts.targetPath ?? opts.tool);
  clog("starting collab", provider.kind, "room", room, "seedDoc:", !!seedDoc);
  const handle = await startKicadCollab(mod, win as unknown as KicadItemsWindow, {
    provider,
    room,
    seedDoc,
    readOnly: opts.readOnly,
  });
  opts.log(`[collab] ${provider.kind} connected on ${room}`);
  opts.onStatus("Collab: connected");
  clog("connected ✓");
  return handle;
}

/**
 * Hierarchical-sheet (subschema) collaborative editing for eeschema: every `.kicad_sch`
 * in the design is its own WARM collab room (provider kept open for the session), and the
 * editor's single active-screen binding is re-routed between them on sheet navigation (the
 * C++ `onSheetChanged` hook). Supersedes the single-room `maybeStartCollab` for eeschema;
 * background sheets stay synced at the data layer, the active sheet is bound to the editor.
 *
 * Opt OUT with `?collab=0`; a pre-connected ydoc session ignores the opt-out (the doc IS
 * the data source). Returns undefined when collab is off or the wasm predates the Phase-0
 * items+sheet bridge.
 */
export async function startSheetCollab(
  win: ToolWindow,
  opts: {
    slug: string;
    scopeId: string;
    projectId: string;
    targetPath?: string;
    files: ToolFile[];
    /** ydoc mode: the entry sheet's pre-connected room (from maybeConnectDocSession). */
    session?: KicadDocSession;
    /** The entry file was materialized from `session`'s doc (baseline-only first seed). */
    editorMatchesDoc?: boolean;
    onActiveChange: (active: ActiveSheet | null) => void;
    /** Upload sink (project-backed sessions) — used to register a just-created subsheet. */
    saveBytes?: SaveBytes;
    /** Read-only viewer (read-only-viewer): see `createSheetCollabManager`. */
    readOnly?: boolean;
    log: (m: string) => void;
    onStatus: (t: string) => void;
  },
): Promise<SheetCollabManager | undefined> {
  const collabParam = new URLSearchParams(win.location.search).get("collab");
  const mod = win.Module;

  if (!opts.session && (collabParam === "0" || collabParam === "false")) {
    clog("[sheet] collab disabled (?collab=0) — skipping");
    return undefined;
  }
  if (typeof mod?.kicadCollabSnapshotItems !== "function") {
    cwarn(
      "[sheet] BRIDGE NOT PRESENT: Module.kicadCollabSnapshotItems is",
      typeof mod?.kicadCollabSnapshotItems,
      "— the loaded eeschema.wasm predates the items+sheet bridge (subschema Phase 0). Rebuild + `npm run setup:kicad` and restart the dev server.",
    );
    return undefined;
  }

  const manager = createSheetCollabManager({
    mod,
    win: win as unknown as KicadItemsWindow,
    scopeId: opts.scopeId,
    projectId: opts.projectId,
    provider: yjsProviderConfig(),
    seedDocForPath: (sheet) => seedDocFromMemfs(win, opts.slug, sheet),
    onActiveChange: opts.onActiveChange,
    // Parked rooms carry a skeleton presence ("this user is on sheet X") so
    // any sheet's roster shows the whole schematic's crew (0003). Read-only
    // viewers publish none (invisible observer) — skeletons are broadcasts.
    presenceUser: opts.readOnly ? undefined : presenceUser(),
    readOnly: opts.readOnly,
    log: opts.log,
    initial:
      opts.session && opts.targetPath
        ? {
            sheetPath: opts.targetPath,
            session: opts.session,
            editorMatchesDoc: !!opts.editorMatchesDoc,
          }
        : undefined,
  });

  // Warm ONLY the opened hierarchy (root + transitive Sheetfile references),
  // not every schematic in the project: a repo-as-project upload can hold
  // dozens of unrelated boards' schematics that the wasm never loads — no
  // in-memory copy, no divergence risk, no room needed (sheet-hierarchy.ts).
  // A root we can't scope (fileless boot, unreadable staging) falls back to
  // all project sheets — over-warming costs sockets, under-warming would cost
  // collab. In-editor "Add Sheet" children are warmed by the created hook.
  const allSheets = opts.files
    .filter((f) => f.path.endsWith(".kicad_sch"))
    .map((f) => f.path);
  const sheetPaths =
    opts.targetPath?.endsWith(".kicad_sch") && allSheets.includes(opts.targetPath)
      ? resolveSheetHierarchy(
          opts.targetPath,
          (p) => {
            const bytes = readStagedFile(win, opts.slug, p);
            return bytes ? new TextDecoder().decode(bytes) : null;
          },
          allSheets,
        )
      : allSheets;

  // C++ navigation → rebind the active room to the now-shown sheet.
  registerSheetChangedHook(win as unknown as SheetChangedWindow, (abs) => {
    const rel = relativeProjectPath(opts.slug, abs);
    // switchTo rejects on TERMINAL failures only (SexprVersionError — C-5);
    // transient failures retry internally. A skewed sheet mid-session can't
    // fail the whole boot anymore, so log it and leave the sheet unbound.
    if (rel) {
      manager.switchTo(rel).catch((err: unknown) => {
        opts.log(
          `[sheet] ${rel} needs a newer app version — collab disabled for this sheet: ${String(err)}`,
        );
        opts.onStatus("Collab: version skew on this sheet");
      });
    }
  });

  // C++ sheet creation ("Add Sheet") → the child .kicad_sch was just written to MEMFS by
  // the hook; register it with the backend + warm its room, so a subsheet placed but never
  // entered or saved still persists (the file-list snapshot can't contain it).
  registerSheetCreatedHook(win as unknown as SheetCreatedWindow, (abs) => {
    const rel = relativeProjectPath(opts.slug, abs);
    if (rel && rel.endsWith(".kicad_sch")) {
      persistCreatedSheet(win, opts.slug, rel, opts.saveBytes, manager, opts.log);
    }
  });

  // Warm every schematic file in the project so later sheet switches are instant.
  void manager.connectAll(sheetPaths);

  if (opts.targetPath) {
    try {
      await manager.switchTo(opts.targetPath);
    } catch (err) {
      // switchTo only rejects on TERMINAL failures (SexprVersionError — C-5).
      // The manager already owns the entry session + every warmed room; tear
      // it down before surfacing, or the boot error leaks the pool (C-1).
      manager.destroy();
      throw err;
    }
  }
  opts.log(`[sheet] multi-room collab active (${sheetPaths.length} sheet(s) warmed)`);
  opts.onStatus("Collab: connected");
  return manager;
}

/**
 * A subsheet was just created in-editor — the C++ `onSheetCreated` hook has already written
 * the child .kicad_sch to MEMFS. Register it with the backend (so it survives reload and
 * reaches peers) and warm its collab room. Covers a subsheet that's placed but never entered
 * or saved, which the page-load file list can't contain.
 */
function persistCreatedSheet(
  win: ToolWindow,
  slug: string,
  relPath: string,
  saveBytes: SaveBytes | undefined,
  manager: SheetCollabManager,
  log: (m: string) => void,
): void {
  void manager.onboard(relPath);
  if (!saveBytes) return;
  try {
    const bytes = win.FS?.readFile(memfsFilePath(slug, relPath));
    if (!(bytes instanceof Uint8Array)) return;
    void saveBytes(relPath, bytes)
      .then((outcome) => {
        if (outcome.kind === "committed") {
          log(`[sheet] registered created subsheet ${relPath} (${bytes.length} bytes)`);
        } else {
          cwarn(
            `[sheet] upload of created subsheet ${relPath} did not commit`,
            outcome,
          );
        }
      })
      .catch((err) => cwarn(`[sheet] upload of created subsheet ${relPath} failed`, err));
  } catch (err) {
    cwarn(`[sheet] read of created subsheet ${relPath} failed`, err);
  }
}

/**
 * Wait until the wxWidgets UI has actually built some elements — it populates a
 * frame or two AFTER the boot sequence resolves, so dropping the loading overlay
 * on boot-resolve flashes a blank editor. Polls `wxElementRegistry` (the same
 * "UI built" signal the e2e suite uses) and falls through after a timeout so a
 * tool with a minimal UI can never hang the overlay.
 */
export async function waitForWxUi(win: ToolWindow, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((win.wxElementRegistry?.findAll({}).length ?? 0) > 3) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

