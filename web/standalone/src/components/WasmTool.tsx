import * as React from "react";
import {
  collabRoomId,
  docToFile,
  commentAuthorColors,
  EXTENSION_TOOL,
  FILELESS_TOOLS,
  fileToDoc,
  projectPath,
  projectToolPath,
  toolSchema,
  ydocHasState,
  syncLayoutToY,
  yToDoc,
  type KicadDoc,
  type Tool,
} from "@pcbjam/shared";
import { ChevronDown, ChevronUp, Crosshair, Download, Eye, EyeOff, Layers, Loader2, Moon, PanelsTopLeft, Sun } from "lucide-react";
import {
  API_BASE_URL,
  APP_URL,
  commentAuthor,
  currentScope,
  libsSourceConfig,
  modelsSourceConfig,
  presenceUser,
  PRESENCE_TUNER_ENABLED,
  yjsProviderConfig,
  type DocSource,
} from "@/lib/config";
import { defaultFileName, newFileTemplate, withExtension } from "@/lib/new-file";
import { redirectTargetFor } from "@/lib/redirect";
import { loadSessionIdentity, seedSessionIdentity } from "@/lib/session-identity";
import { setTheme, useThemeValue } from "@/lib/theme";
import { bootKicadTool } from "@/wasm/boot";
import {
  autoDownloadEnabled,
  fetchWasmStoredSize,
  hasAnyWasmDownload,
  isWasmDownloaded,
  markWasmDownloaded,
  resolveWasmMeta,
  setAutoDownloadEnabled,
  type WasmMeta,
} from "@/wasm/wasm-assets";
import {
  LIB_BUSY_EVENT,
  LIB_ERROR_EVENT,
  LIB_ITEM_UPDATED_EVENT,
  LIB_LOADING_EVENT,
  LIB_SET_CHANGED_EVENT,
  type LibBusyDetail,
  type LibErrorDetail,
  type LibItemUpdatedDetail,
  type LibLoadingDetail,
  type LibSetChangedDetail,
  type LibsSource,
  type LibsSyncState,
} from "@/wasm/libs/source";
import { addAnnouncedLib } from "@/wasm/libs/runtime-add";

/** The libset toast's message once live-loading failed and reload is the offer. */
function reloadFallbackMsg(notice: { detail: LibSetChangedDetail }): string {
  const label = notice.detail.name ? `"${notice.detail.name}"` : "the new library";
  return `Couldn't load ${label} into the running session — click to reload the editor.`;
}
import {
  MODELS_LOADING_EVENT,
  type ModelsLoadingDetail,
} from "@/wasm/libs/models-bridge";
import { memfsFilePath, memfsProjectDir, TOOL_BUNDLE, TOOL_FRAME } from "@/wasm/constants";
import {
  driveProjectIntoTool,
  readStagedFile,
  usedLibNicknames,
  type ToolFile,
} from "@/wasm/kicad-runner";
import { resolveSheetHierarchy } from "@/wasm/collab/sheet-hierarchy";
import { dump as dumpTrace, mark } from "@/wasm/load-trace";
import { errorMessage, isTerminalError } from "@/wasm/terminal-error";
import { registerSaveHook, type SaveBlock, type SaveBytes } from "@/wasm/save-flow";
import type {
  KicadCollabHandle,
  KicadDocSession,
  KicadItemsWindow,
  YjsProvider,
} from "@/wasm/collab";
import {
  createPresence,
  type PresenceHandle,
  type PresencePeer,
} from "@/wasm/collab/presence";
import {
  bindKicadPresence,
  hasPresenceBridge,
  type PresenceKicadModule,
  type PresenceKicadWindow,
} from "@/wasm/collab/presence-kicad";
import {
  createFollow,
  type FollowHandle,
  type FollowTarget,
} from "@/wasm/collab/follow-user";
import { startCrossAppPresence, type CrossAppHandle } from "@/wasm/collab/cross-app";
import {
  startSiblingRestage,
  type SiblingRestageHandle,
} from "@/wasm/collab/sibling-restage";
import {
  DOC_REVERTED_EVENT,
  NATIVE_PROJECTION_FAILED_EVENT,
  type NativeProjectionFailure,
} from "@/wasm/collab/kicad-binding";
import {
  createComments,
  hasCommentsBridge,
  type CommentsController,
  type ViewportState,
} from "@/wasm/collab/comments";
import { PresenceRoster } from "@/components/PresenceRoster";
import { CommentLayer } from "@/components/CommentLayer";
import {
  OverlayMenu,
  OverlayMenuSection,
  overlayRowClass,
} from "@/components/OverlayMenu";
import { hasTunerBridge, PresenceTuner, type TunerModule } from "@/components/PresenceTuner";
import { hasLayersBridge, LayerPanel, type LayersModule } from "@/components/LayerPanel";
import { SelectionInspector } from "@/components/SelectionInspector";
import { bindLocalSelectionFeed } from "@/wasm/collab/local-selection";
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
import type * as Y from "yjs";
import { createOomWatch, respawnInNewTab } from "@/recovery/oom-watch";
import { MemoryExhaustedDialog } from "@/recovery/MemoryExhaustedDialog";
import type { SourceDescriptor } from "@/lib/project-source-shared";
import { SourceChip } from "@/components/SourceChip";
import { isMobileMode } from "@/lib/mobile-mode";
import {
  isChromeToggleHotkey,
  toggleChromeHidden,
  useChromeHidden,
} from "@/lib/chrome-visibility";
import { recordFatalLog, showFatalScreen } from "@/wasm/fatal-screen";

// Tools with the v2 items bridge (kicadCollabSnapshotItems/ApplyItems embind exports).
const COLLAB_TOOLS = new Set<Tool>(["pl_editor", "eeschema", "pcbnew"]);

// Chrome (editor UI) toggle: only the merged kicad_editor bundle exports
// kicadSetChrome (gerbview/calculator/pl_editor don't) — everything about the
// toggle is feature-gated on the export being there.
function chromeSetter(win: Window): ((show: boolean) => boolean) | null {
  const fn = (win as { Module?: { kicadSetChrome?: unknown } }).Module
    ?.kicadSetChrome;
  return typeof fn === "function" ? (fn as (show: boolean) => boolean) : null;
}

// Viewer panels (viewer-panels): floating layer selector + selection
// inspector open-state persistence, mirroring the comments panel's keys.
const LAYERS_OPEN_KEY = "pcbjam:layers-panel-open";
const INSPECTOR_OPEN_KEY = "pcbjam:inspector-panel-open";

// Tooltip only — the matcher accepts both chords on any platform.
const CHROME_HOTKEY_LABEL =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
    ? "⌘\\"
    : "Ctrl+\\";

// Which library item kind each tool browses — drives the load-screen pre-sync
// (warm the right bundles into IDB while the wasm downloads). Tools that don't
// browse a library are omitted (no pre-sync).
const LIB_KIND_FOR_TOOL: Partial<Record<Tool, "symbol" | "footprint">> = {
  symbol_editor: "symbol",
  eeschema: "symbol",
  footprint_editor: "footprint",
  pcbnew: "footprint",
};

/** What the download-consent dialog quotes (standalone-load-ux 0001). */
interface ConsentInfo {
  /** Over-the-wire (COMPRESSED) bytes for the editor bundle — null when the CDN
   *  carries no size info and HEAD yielded none ("large download" wording then).
   *  Quoted as "compressed" in the dialog: the load screen's progress bar counts
   *  RAW decoded bytes, which are several times this. */
  toolBytes: number | null;
  /** Raw (decoded) wasm bytes — the same total the progress bar counts, quoted
   *  next to `toolBytes` so the two figures can't read as a contradiction. Null
   *  when the manifest prices nothing (HEAD fallback knows the wire size only). */
  toolRawBytes: number | null;
  /** A previous version of this bundle was downloaded → word it as an update. */
  update: boolean;
  /** The lib kind this tool pre-syncs — warmed in parallel with the wasm
   *  download (the boot fan-out; see startLibPresync). Editors with a project
   *  file open without waiting on it; the lib editors wait (enumerate gate). */
  libNowKind: "symbol" | "footprint" | null;
  libNow: LibsSyncState | null;
  /** The other kind a merged-bundle session can pull lazily ("only if used"). */
  libLaterKind: "symbol" | "footprint" | null;
  libLater: LibsSyncState | null;
}

/**
 * Gather the consent dialog's figures. Everything is best-effort: only small
 * JSON/HEAD requests run here (never a bundle or the wasm), and any missing
 * piece degrades to vaguer wording rather than blocking the dialog.
 */
async function gatherConsentInfo(
  meta: WasmMeta,
  source: LibsSource | null,
  tool: Tool,
): Promise<ConsentInfo> {
  let toolBytes = meta.sizes?.totalStored ?? null;
  if (toolBytes === null) {
    toolBytes = await fetchWasmStoredSize(meta.base, meta.bundle);
  }
  const libNowKind = LIB_KIND_FOR_TOOL[tool] ?? null;
  // The merged kicad_editor bundle seeds BOTH lib tables — the other kind loads
  // lazily per-lib when a cross-face feature reaches it (see boot.ts libKinds).
  const libLaterKind =
    TOOL_BUNDLE[tool] === "kicad_editor" && libNowKind
      ? libNowKind === "symbol"
        ? ("footprint" as const)
        : ("symbol" as const)
      : null;
  const state = async (
    kind: "symbol" | "footprint" | null,
  ): Promise<LibsSyncState | null> => {
    if (!kind || !source?.syncState) return null;
    try {
      return await source.syncState(kind);
    } catch {
      return null;
    }
  };
  return {
    toolBytes,
    // Only the manifest prices the DECODED wasm (wasm-assets WasmBundleSizes);
    // the HEAD fallback above sees the compressed body alone.
    toolRawBytes: meta.sizes?.wasm ?? null,
    update: hasAnyWasmDownload(meta.bundle),
    libNowKind,
    libNow: await state(libNowKind),
    libLaterKind,
    libLater: await state(libLaterKind),
  };
}
const LEGACY_EXTENSION_TOOL: Record<string, Tool> = {
  ".sch": "eeschema",
  ".brd": "pcbnew",
};

let activeToolNavigationHook:
  | ((toolName: string, fileName: string) => boolean)
  | undefined;

const toolNavigationDispatcher = (toolName: string, fileName: string) =>
  activeToolNavigationHook?.(toolName, fileName) ?? false;

function ensureToolNavigationDispatcher(win: ToolWindow): boolean {
  if (win.kicadWebOpenTool === toolNavigationDispatcher) return true;

  try {
    Object.defineProperty(win, "kicadWebOpenTool", {
      configurable: true,
      value: toolNavigationDispatcher,
    });
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  ensureToolNavigationDispatcher(window as ToolWindow);
}

function normalizeToolName(rawName: string): Tool | null {
  const basename = rawName.replace(/\\/g, "/").split("/").pop() ?? rawName;
  const withoutExe = basename.replace(/\.exe$/i, "");
  const toolName = withoutExe === "pcb_calculator" ? "calculator" : withoutExe;
  const parsed = toolSchema.safeParse(toolName);
  return parsed.success ? parsed.data : null;
}

function relativeProjectPath(slug: string, path: string): string | undefined {
  if (!path) return undefined;

  const normalized = path.replace(/\\/g, "/");
  const prefix = `${memfsProjectDir(slug)}/`;

  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);

  const marker = `/projects/${slug}/`;
  const markerIndex = normalized.indexOf(marker);

  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);

  return normalized.startsWith("/") ? undefined : normalized;
}

function fileStem(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

function fileTool(path: string): Tool | undefined {
  const lower = path.toLowerCase();

  for (const [extension, mappedTool] of Object.entries({
    ...EXTENSION_TOOL,
    ...LEGACY_EXTENSION_TOOL,
  })) {
    if (lower.endsWith(extension)) return mappedTool;
  }

  return undefined;
}

function chooseToolFile(
  files: ToolFile[],
  nextTool: Tool,
  requestedPath?: string,
  currentPath?: string,
): string | undefined {
  if (requestedPath && files.some((file) => file.path === requestedPath)) {
    return requestedPath;
  }

  const candidates = files.filter((file) => fileTool(file.path) === nextTool);
  const preferredStem = requestedPath
    ? fileStem(requestedPath)
    : currentPath
      ? fileStem(currentPath)
      : undefined;

  if (preferredStem) {
    const matchingStem = candidates.find(
      (file) => fileStem(file.path) === preferredStem,
    );
    if (matchingStem) return matchingStem.path;
  }

  return candidates[0]?.path;
}

function installToolNavigationHook(
  win: ToolWindow,
  opts: {
    slug: string;
    files: ToolFile[];
    targetPath?: string;
    /** Persist a new file into the project (see the WasmTool prop). Absent ⇒
     *  this session can't create one, and a missing target stays a no-op. */
    createFile?: (relPath: string, bytes: Uint8Array) => Promise<void>;
    log: (m: string) => void;
  },
): () => void {
  // One create at a time: a double-fired menu item must not upload twice.
  // Cleared only on failure — success navigates the page away.
  let pendingCreate: string | null = null;

  const hook = (rawToolName: string, rawFileName: string): boolean => {
    const nextTool = normalizeToolName(rawToolName);

    if (!nextTool) {
      opts.log(`[nav] unsupported KiCad tool: ${rawToolName}`);
      return false;
    }

    const requestedPath = relativeProjectPath(opts.slug, rawFileName);
    const nextPath = FILELESS_TOOLS.has(nextTool)
      ? undefined
      : chooseToolFile(opts.files, nextTool, requestedPath, opts.targetPath);

    if (!FILELESS_TOOLS.has(nextTool) && !nextPath) {
      // Native KiCad's "Switch to PCB Editor" with no board opens pcbnew on a
      // NEW empty board at the derived path — mirror it by creating the
      // templated counterpart in the project (the shape NewFileDialog writes)
      // and navigating to it. Only sessions that can persist pass `createFile`
      // (ToolPage); viewers and scratch/local-folder sessions keep the quiet
      // no-op. C++ calls this hook synchronously (EM_ASM_INT) and ignores the
      // result beyond a log line, so the create+navigate runs async and we
      // answer true optimistically once it's kicked off.
      const createFile = opts.createFile;
      if (!createFile) {
        opts.log(`[nav] no project file found for ${nextTool}: ${rawFileName}`);
        return false;
      }
      if (pendingCreate) {
        opts.log(`[nav] create already pending: ${pendingCreate}`);
        return true;
      }
      const relPath =
        requestedPath ??
        (opts.targetPath
          ? withExtension(nextTool, fileStem(opts.targetPath))
          : defaultFileName(nextTool));
      const url =
        projectPath(currentScope(), opts.slug, relPath) + win.location.search;
      pendingCreate = relPath;
      void (async () => {
        try {
          const bytes = new TextEncoder().encode(
            newFileTemplate(nextTool, crypto.randomUUID()),
          );
          await createFile(relPath, bytes);
          opts.log(`[nav] created missing ${nextTool} file ${relPath} -> ${url}`);
          markDeliberateNavigation();
          win.location.assign(url);
        } catch (e) {
          pendingCreate = null;
          opts.log(
            `[nav] create failed for ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })();
      return true;
    }

    // Scope/kind/name grammar: a fileless tool boots at `…/-/:tool`; a file route
    // carries the path (its tool is inferred). Scope = the current URL's scope.
    const scope = currentScope();
    const url =
      (FILELESS_TOOLS.has(nextTool)
        ? projectToolPath(scope, opts.slug, nextTool)
        : projectPath(scope, opts.slug, nextPath)) + win.location.search;

    opts.log(`[nav] ${rawToolName} ${rawFileName || "(no file)"} -> ${url}`);
    markDeliberateNavigation();
    win.location.assign(url);
    return true;
  };

  if (!ensureToolNavigationDispatcher(win)) {
    opts.log("[nav] unable to install KiCad tool navigation hook");
  }

  activeToolNavigationHook = hook;

  return () => {
    if (activeToolNavigationHook === hook) activeToolNavigationHook = undefined;
  };
}

// The wx wasm port calls window.wxAppTopWindowClosed() when the app's MAIN
// frame is destroyed (wxwidgets src/wasm/toplevel.cpp) — i.e. on a real
// File→Quit / window close. A close vetoed by the unsaved-changes prompt never
// destroys the frame, so it never fires. The port also closes the frame while
// the page itself unloads (app.cpp UnloadCallback), so the dispatcher latches
// off as soon as any unload/navigation is under way.

let activeQuitHook: (() => void) | undefined;
let quitHandled = false;

/**
 * Latch the quit dispatcher off ahead of a deliberate in-app navigation (the
 * tool-switch hook's location.assign). The wx port's UnloadCallback runs on
 * BEFOREUNLOAD — i.e. the instant the navigation starts, while this document
 * keeps running until the next one commits — and closes the top frame, which
 * fires wxAppTopWindowClosed. Without the latch the quit hook then navigates
 * to the exit URL over the in-flight navigation (the pagehide latch below is
 * too late: pagehide only fires at commit time). One-shot per document, same
 * as the pagehide latch — this page is on its way out.
 */
function markDeliberateNavigation() {
  quitHandled = true;
}

const quitDispatcher = () => {
  if (quitHandled) return;
  quitHandled = true;
  // The wasm side only calls this when the app's top window is genuinely
  // destroyed. When that happens unexpectedly (2026-08-03: a guarded-off
  // settle-window dispatch cascaded into a silent frame close), the stack is
  // the only artifact that says WHO closed it — keep it in every log.
  console.warn("[quit] wxAppTopWindowClosed invoked — top window destroyed", new Error("quit-origin").stack);
  activeQuitHook?.();
};

function ensureQuitDispatcher(win: ToolWindow): boolean {
  if (win.wxAppTopWindowClosed === quitDispatcher) return true;

  try {
    Object.defineProperty(win, "wxAppTopWindowClosed", {
      configurable: true,
      value: quitDispatcher,
    });
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  ensureQuitDispatcher(window as ToolWindow);
  // Latch off for a BROWSER-initiated unload: reload (F5), Back, closing the
  // tab, typing a URL. markDeliberateNavigation covers only our own in-app
  // navigations, and the pagehide latch below fires at commit time — too late.
  // The wx port's UnloadCallback runs on beforeunload and closes the top frame,
  // which fires wxAppTopWindowClosed; unlatched, the quit hook then navigated to
  // the project overview OVER the in-flight reload, so every refresh of an
  // editor URL bounced to the management app instead of reloading.
  //
  // Registered at MODULE scope, which runs on import — before the wasm boots and
  // installs its own beforeunload handler. Listeners fire in registration order,
  // so this latch is always set before UnloadCallback can close the frame.
  //
  // Tradeoff: if a beforeunload prompt is shown and the user chooses to stay,
  // the latch stays set and a later File→Quit won't navigate on its own. That
  // is strictly better than the alternative — a page that cannot be refreshed —
  // and the user can still navigate manually.
  window.addEventListener(
    "beforeunload",
    () => {
      quitHandled = true;
    },
    { capture: true },
  );
}

function installQuitHook(
  win: ToolWindow,
  opts: { exitUrl: string; log: (m: string) => void },
): () => void {
  const hook = () => {
    // Quit always navigates to the exit URL (project overview / home). Never
    // history.back(): every in-app entry AND every tool switch is a hard
    // location.assign(), so after a schematic ⇄ pcb switch the previous
    // history entry is another editor — unwinding history strands the user
    // there instead of leaving the editor.
    //
    // Defer the navigation out of the wasm callback: this fires from inside the
    // frame's C++ destructor (via EM_ASM), and the teardown keeps
    // running after we return. A cross-document location.assign() started here is
    // aborted by that continuing teardown — so hand it to a fresh task once the
    // wasm stack has unwound.
    setTimeout(() => {
      opts.log(`[quit] editor closed — going to ${opts.exitUrl}`);
      win.location.assign(opts.exitUrl);
    }, 0);
  };

  if (!ensureQuitDispatcher(win)) {
    opts.log("[quit] unable to install quit hook");
  }
  activeQuitHook = hook;

  // Once the page is unloading for any reason, the hook must never navigate.
  const markUnloading = () => {
    quitHandled = true;
  };
  win.addEventListener("pagehide", markUnloading);

  // A bfcache restore (Forward after quitting) would resurrect a page whose wx
  // frame was already destroyed — force a clean re-boot instead.
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) win.location.reload();
  };
  win.addEventListener("pageshow", onPageShow);

  return () => {
    if (activeQuitHook === hook) activeQuitHook = undefined;
    win.removeEventListener("pagehide", markUnloading);
    win.removeEventListener("pageshow", onPageShow);
  };
}

/**
 * Read the opened file back from MEMFS (what the editor actually loaded) and
 * parse it into the full `KicadDoc` (ysync 0007 `fileToDoc`). Used to seed the
 * Y.Doc LOSSLESSLY when this client opens an empty room (ysync 0005): the doc
 * then carries meta + layout + items, so the file is recoverable from the Y.Doc
 * alone. Falls back to undefined (→ editor-snapshot seed, items only) when the
 * file is absent or doesn't parse as a KiCad s-expr document.
 */
function seedDocFromMemfs(
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
async function maybeConnectDocSession(
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
async function maybeStartCollab(
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
async function startSheetCollab(
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
async function waitForWxUi(win: ToolWindow, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((win.wxElementRegistry?.findAll({}).length ?? 0) > 3) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Keeps a poisoned wasm runtime from taking the React tree down with it.
 *
 * The v0.1.21 prod crash logs showed the actual white-screen mechanism: after
 * a wasm trap, some child's EFFECT calls into the dead runtime (an embind
 * entry via a react-query subscription), the throw lands in React's commit,
 * and React unmounts the whole root — destroying the fatal overlay AND the
 * console panel, the two things built to report exactly this. The boundary
 * absorbs descendant render/effect throws: it reports up (the parent promotes
 * its fatal screen, which lives OUTSIDE this boundary) and renders nothing in
 * place of the dead subtree. WasmTool's own state — logs included — survives.
 */
class WasmErrorBoundary extends React.Component<
  { onFatal: (msg: string) => void; children: React.ReactNode },
  { dead: boolean }
> {
  state = { dead: false };

  static getDerivedStateFromError() {
    return { dead: true };
  }

  componentDidCatch(err: unknown) {
    this.props.onFatal(err instanceof Error ? err.message : String(err));
  }

  render() {
    return this.state.dead ? null : this.props.children;
  }
}

/**
 * Boots a KiCad tool directly in this React document (no iframe): builds the
 * Emscripten `Module` config, injects the proven harness scripts (wx.js +
 * <tool>.js, the same artifacts the e2e tests use) into the page, then syncs the
 * project tree into MEMFS and drives File→Open. See src/wasm/boot.ts for why the
 * runtime is single-instance per page load.
 */
export function WasmTool({
  tool,
  slug,
  scopeId,
  projectId,
  files,
  targetPath,
  fetchBytes,
  saveBytes,
  createFile,
  docSource,
  assetBaseUrl,
  libsSource,
  sourceDescriptor,
  readOnly = false,
  boot = null,
}: {
  tool: Tool;
  slug: string;
  /** Owning team's stable id (`"local"` when scope-less) — first room-id segment. */
  scopeId: string;
  /** Stable project id — used to key the collab room (see @pcbjam/shared). */
  projectId: string;
  files: ToolFile[];
  targetPath?: string;
  /** Where this project lives (local / remote-ro / remote-rw) — shown as a chip
   *  so the user knows whether/how Save persists. Omitted ⇒ no chip. */
  sourceDescriptor?: SourceDescriptor;
  /**
   * Override the library source the editor browses. Omitted ⇒ the configured
   * default (`libsSourceConfig`). Used to open a single library scoped to itself
   * — a specific backend lib, or a local `.kicad_sym`/`.kicad_mod` file.
   */
  libsSource?: LibsSource | null;
  /**
   * The composed boot payload (load-path-rework 0001 §6), when the page's ONE
   * boot round-trip answered: seeds identity, the lib listing + stack
   * resolves, and the project sync digest. Null ⇒ each consumer uses its
   * individual endpoint — the pre-boot behavior.
   */
  boot?: import("@/lib/boot-payload").BootPayload | null;
  /** Fetch one project-relative file's bytes (contract loader or local folder). */
  fetchBytes: (relPath: string) => Promise<Uint8Array>;
  /**
   * Persist one file the user saved in the editor (File→Save writes MEMFS, then
   * the wasm fires window.kicadCollab.onSave → this). API upload for backend
   * projects, disk write-back/download for local folders; omit to keep saves
   * MEMFS-only (e.g. Y.Doc-backed sessions).
   */
  saveBytes?: SaveBytes;
  /**
   * Create a new file in the project (tool-switch auto-create: eeschema's
   * "Switch to PCB Editor" when no board exists yet). Persisted BEFORE the
   * hook navigates, so the next ToolPage load finds it. Omit for sessions
   * that can't persist a new project file (read-only viewers, scratch and
   * local-folder sessions) — a missing switch target then stays a logged
   * no-op.
   */
  createFile?: (relPath: string, bytes: Uint8Array) => Promise<void>;
  /**
   * Where this project's DOCUMENT lives (see lib/config docSourceConfig):
   * "ydoc" materializes the target file from its collab room when the room has
   * state, with `fetchBytes` as the first-open fallback that seeds it. Defaults
   * to "api" (plain fetch + open). Local-folder sessions don't pass this.
   */
  docSource?: DocSource;
  /** Override the resolved WASM asset base (used verbatim, e.g. e2e fixtures).
   *  Default: resolveWasmBase(tool) — the CDN manifest folder, or flat /wasm. */
  assetBaseUrl?: string;
  /**
   * Read-only viewer session (read-only-viewer; see lib/read-only-mode): chrome
   * force-hidden with the toggle disabled, no presence/comments/drift, the
   * collab binding never seeds or pushes local edits, and the wasm frame is
   * locked via kicadSetReadOnly (zoom/pan only) — failing CLOSED when the
   * bundle lacks the export. Pair with an omitted `saveBytes`.
   */
  readOnly?: boolean;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const startedRef = React.useRef(false);
  // Mobile device (features/mobile): boot installs the touch-gesture shim.
  // Chrome/overlay visibility is the separate runtime toggle below.
  const mobileUi = React.useMemo(() => isMobileMode(), []);
  // Figma-like "hide UI" toggle: small screens (phones, tablets, narrow
  // windows — startsChromeHidden) default to hidden, the floating button /
  // Cmd+\ flips it live; shell overlays key off this, and the layout
  // effect below applies it to the wasm frame.
  const chromeHidden = useChromeHidden();
  // Read-only sessions force-hide the chrome without touching the module-global
  // toggle state (SPA-navigating away keeps normal behavior elsewhere).
  const effectiveChromeHidden = readOnly || chromeHidden;
  const driftRef = React.useRef<{ stop(): void } | null>(null);
  const presenceRef = React.useRef<PresenceHandle | null>(null);
  const presenceBridgeRef = React.useRef<{ destroy(): void } | null>(null);
  // Follow-user (0008): mirror a peer's viewport until local input breaks it.
  const followRef = React.useRef<FollowHandle | null>(null);
  // Project-wide presence room (0006): joined once per session, survives
  // eeschema sheet rebinds — the bridge re-reads it on every startPresence.
  const crossAppRef = React.useRef<CrossAppHandle | null>(null);
  const siblingRestageRef = React.useRef<SiblingRestageHandle | null>(null);
  // Set at the boot effect's cleanup; deferred starters bail on it (the
  // sibling-restage idle stagger can fire after unmount).
  const disposedRef = React.useRef(false);
  const sheetManagerRef = React.useRef<SheetCollabManager | null>(null);
  // The single-room collab doc (pcbnew/pl_editor), for the layout save-sync
  // (miss 08B); eeschema routes per sheet through the manager instead.
  const collabDocRef = React.useRef<import("yjs").Doc | null>(null);
  // Its owning handle, so unmount tears the room socket + doc down — eeschema's
  // equivalent lives inside sheetManagerRef.
  const collabHandleRef = React.useRef<KicadCollabHandle | null>(null);
  const [status, setStatus] = React.useState("Loading tool…");
  const [logs, setLogs] = React.useState<string[]>([]);
  const [showLog, setShowLog] = React.useState(false);
  const consolePanelRef = React.useRef<HTMLDivElement>(null);
  const [oomExhausted, setOomExhausted] = React.useState(false);
  // Terminal failure, rendered INDEPENDENTLY of `ready`. The boot overlay only
  // exists while `!ready`, so anything that killed the runtime after the editor
  // came up (a wasm abort/trap, a failed staging fetch surfacing late) used to
  // leave a blank page with no explanation at all — the "white screen of death".
  const [fatal, setFatal] = React.useState<string | null>(null);
  // Editor lifecycle for the loading chrome: false until the tool has booted +
  // opened (covers the big WASM-compile freeze with a full-screen overlay).
  const [ready, setReady] = React.useState(false);
  // Download progress for the (large) wasm, and a "this is taking too long" flag
  // the overlay raises after a while so a stuck load doesn't read as a silent hang.
  const [progress, setProgress] = React.useState<{
    loaded: number;
    total: number;
  } | null>(null);
  const [slow, setSlow] = React.useState(false);
  // Download-consent gate (standalone-load-ux 0001): non-null while the boot
  // waits on the user's OK before pulling the (large) cold wasm + lib bundles.
  const [consent, setConsent] = React.useState<ConsentInfo | null>(null);
  const consentResolveRef = React.useRef<((ok: boolean) => void) | null>(null);
  // This bundle+version finished downloading before (completion marker) — the
  // load overlay says "from cache" instead of the first-download excuse.
  const [warmBoot, setWarmBoot] = React.useState(false);
  // A library item currently being fetched (open/save), for a transient spinner.
  const [libBusy, setLibBusy] = React.useState<string | null>(null);
  // Load-screen pre-sync progress: warming the project's lib bundles into IDB in
  // parallel with the wasm download. Null when idle/done. Counts only (no
  // "current lib") — the fetches run several-at-a-time, so there is no single
  // current one, and a fixed label keeps the line still while it ticks.
  const [libSync, setLibSync] = React.useState<{
    kind: string;
    done: number;
    total: number;
  } | null>(null);
  // Project-file staging progress (fetch + MEMFS write, overlapping the wasm
  // download) for the boot overlay's "Project files" line. Null when idle/done.
  const [fileSync, setFileSync] = React.useState<{
    done: number;
    total: number;
  } | null>(null);
  // Last lib error (e.g. a backend 404 on open), shown as a dismissible toast.
  const [libError, setLibError] = React.useState<string | null>(null);
  // A collaborator updated library items that are PLACED in the open document
  // (LIB_ITEM_UPDATED_EVENT) — placed copies keep the previous version, so warn.
  const [libUpdate, setLibUpdate] = React.useState<string | null>(null);
  // The backend rolled this document back to its last valid state
  // (kicad-validity 0001 — DOC_REVERTED_EVENT from the collab binding).
  const [docReverted, setDocReverted] = React.useState<string | null>(null);
  // A peer changed the team's lib SET mid-session (LIB_SET_CHANGED_EVENT —
  // the scope room's `libset` broadcast). The lib table is frozen at boot, so
  // the toast's click action loads the new lib live (addAnnouncedLib), with a
  // reload fallback when the runtime bridge is missing.
  const [libSetNotice, setLibSetNotice] = React.useState<{
    message: string;
    detail: LibSetChangedDetail;
    mode: "load" | "reload";
  } | null>(null);
  // The one libs source instance the running editor uses (set by the boot
  // effect) — the libset toast's action needs it to re-list and load.
  const activeLibsSourceRef = React.useRef<LibsSource | null>(null);
  // A save path entered the DURABLE blocked state (409 conflict / unknown
  // commit state — save-flow's absorbing blockedPaths). Rendered as a
  // persistent banner, never auto-dismissed: further Ctrl+S on the path is
  // silently absorbed, so without this surface the user would keep "saving"
  // into the void.
  const [saveBlocked, setSaveBlocked] = React.useState<SaveBlock | null>(null);
  // Eager whole-library idb→wasm load in flight (the ~tens-of-seconds fat-load on
  // first chooser/editor open). Drives a full-cover overlay so the freeze reads as
  // "loading, just slow" rather than a hang. Null when idle; `done/total` count the
  // per-lib fat-load crossings so the overlay can show a progress bar.
  const [libLoading, setLibLoading] = React.useState<{
    kind: string;
    done: number;
    total: number;
  } | null>(null);
  // Board 3D-model prefetch in flight (background; the viewer works without it —
  // anything still missing lazy-loads per model). Small badge, not an overlay.
  const [modelsSync, setModelsSync] = React.useState<string | null>(null);
  // The OTHER users in this document's collab room (awareness roster) — drives
  // the PresenceRoster chip next to SourceChip. Empty when collab is off, the
  // provider has no awareness (kind "none"), or nobody else is here.
  const [peers, setPeers] = React.useState<PresencePeer[]>([]);
  // eeschema: the sheet THIS client is bound to — the roster dims peers whose
  // skeleton state says they're on a different sheet (collab-presence 0003).
  const [activeSheetPath, setActiveSheetPath] = React.useState<string | undefined>();
  // Follow-user (0008): the followed roster client, for the ring + banner.
  const [followingTarget, setFollowingTarget] = React.useState<FollowTarget | null>(null);
  // Comments (0005): the bound doc's controller + the live viewport transform
  // the DOM layer maps world→CSS with. Both rebind with the collab session
  // (per sheet in eeschema).
  const [commentsCtl, setCommentsCtl] = React.useState<CommentsController | null>(null);
  // The overlay menu's comments section (0010): a ref-callback slot the
  // CommentLayer portals its bar/panel into; null while the menu is closed.
  const [commentsSlot, setCommentsSlot] = React.useState<HTMLDivElement | null>(null);
  const [viewportState, setViewportState] = React.useState<ViewportState | null>(null);
  const commentsRef = React.useRef<CommentsController | null>(null);
  // Viewer panels (viewer-panels): the SelectionInspector's data doc — the
  // bound collab doc (pcbnew: the board room; eeschema: the ACTIVE sheet's
  // room, re-pointed on navigation). Null without a doc room (?collab=0).
  const [panelDoc, setPanelDoc] = React.useState<Y.Doc | null>(null);
  // Read-only sessions never bind presence, so the inspector's selection
  // store is fed by this minimal local handler (+ the C++ input hooks).
  const localSelectionRef = React.useRef<{ destroy(): void } | null>(null);
  // Read-only sessions boot with BOTH panels open as collapsed headers
  // (viewer-panels): discoverable without a trip through the menu; a stored
  // per-browser choice wins over the default.
  const [layersOpen, setLayersOpenState] = React.useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(LAYERS_OPEN_KEY);
      if (stored !== null) return stored === "1";
    } catch {
      /* private mode */
    }
    return readOnly === true;
  });
  const setLayersOpen = React.useCallback((v: boolean) => {
    setLayersOpenState(v);
    try {
      localStorage.setItem(LAYERS_OPEN_KEY, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, []);
  const [inspectorOpen, setInspectorOpenState] = React.useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(INSPECTOR_OPEN_KEY);
      if (stored !== null) return stored === "1";
    } catch {
      /* private mode */
    }
    return readOnly === true;
  });
  const setInspectorOpen = React.useCallback((v: boolean) => {
    setInspectorOpenState(v);
    try {
      localStorage.setItem(INSPECTOR_OPEN_KEY, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, []);
  // A doc session that connected but has not been ADOPTED by an owner yet
  // (collab handle / sheet manager). Owned here so a boot failure, an
  // open-never-settled degrade, or unmount can destroy it instead of leaking
  // the socket + doc (findings C-1).
  const pendingDocSessionRef = React.useRef<KicadDocSession | null>(null);
  // Tear down every collab surface that dispatches into the wasm on ws/doc
  // events. Shared by the unmount cleanup AND the terminal-error promote
  // (findings C-7): after a terminal wasm death, a still-connected room kept
  // delivering awareness/doc updates and each one re-entered the dead
  // instance — an unbounded ticket storm underneath the fatal overlay.
  const teardownCollab = React.useCallback(() => {
    localSelectionRef.current?.destroy();
    localSelectionRef.current = null;
    setPanelDoc(null);
    commentsRef.current?.destroy();
    commentsRef.current = null;
    followRef.current?.destroy();
    followRef.current = null;
    presenceBridgeRef.current?.destroy();
    presenceBridgeRef.current = null;
    presenceRef.current?.destroy();
    presenceRef.current = null;
    crossAppRef.current?.destroy();
    crossAppRef.current = null;
    siblingRestageRef.current?.destroy();
    siblingRestageRef.current = null;
    driftRef.current?.stop();
    driftRef.current = null;
    // Tears down every warm room's provider/doc (the only place providers are
    // destroyed — switching sheets keeps them connected) and clears drift via
    // onActiveChange(null).
    sheetManagerRef.current?.destroy();
    sheetManagerRef.current = null;
    // The single-room (pcbnew/pl_editor) counterpart: binding + provider +
    // doc. Without this the board room's socket survived navigation.
    collabHandleRef.current?.destroy();
    collabHandleRef.current = null;
    collabDocRef.current = null;
    const pending = pendingDocSessionRef.current;
    pendingDocSessionRef.current = null;
    if (pending) {
      try {
        pending.provider.destroy();
        pending.doc.destroy();
      } catch {
        /* teardown is best-effort */
      }
    }
  }, []);
  // Unread-comments rollup for the FAB badge (comments-ux 0001 C).
  const [commentsUnread, setCommentsUnread] = React.useState({ threads: 0, mentioned: false });
  const onCommentsUnread = React.useCallback(
    (threads: number, mentioned: boolean) => setCommentsUnread({ threads, mentioned }),
    [],
  );
  // Live canvas theme (comments-ux 0002 F4): shell toggles drive the GAL color
  // theme through the bridge when the loaded wasm exposes it; older builds
  // just keep their boot-seeded theme.
  const theme = useThemeValue();
  React.useEffect(() => {
    if (!ready) return;
    const mod = (window as { Module?: { kicadSetColorTheme?: (name: string) => void } }).Module;
    mod?.kicadSetColorTheme?.(theme === "dark" ? "pcbjam-dark" : "_builtin_default");
  }, [theme, ready]);
  // Dev-time presence style tuner (VITE_PRESENCE_TUNER=1) — set once the wasm
  // exposes the style bridge, mounts the floating panel.
  const [tunerMod, setTunerMod] = React.useState<TunerModule | null>(null);

  // wx's window-level keydown handler forwards Ctrl/Cmd+C to the wasm app and
  // preventDefaults it, so the browser's native "copy selection" never runs —
  // log text could be selected but not copied. When the selection lives in the
  // console panel, intercept the chord in the CAPTURE phase (ahead of wx's
  // bubble-phase listener) and stop propagation; the default copy still fires.
  // A canvas mousedown would normally collapse a selection, but wx
  // preventDefaults that too — mirror it, or a stale log selection would keep
  // stealing the editor's own Ctrl+C.
  React.useEffect(() => {
    const selectionInConsole = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
      return consolePanelRef.current?.contains(sel.anchorNode) ?? false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && selectionInConsole())
        e.stopPropagation();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof HTMLCanvasElement && selectionInConsole())
        window.getSelection()?.removeAllRanges();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  const append = React.useCallback((msg: string) => {
    // Mirror into the React-independent fatal-screen ring: if React ever
    // unmounts itself on a crash, the DOM floor still has the full log.
    recordFatalLog(msg);
    setLogs((prev) => [...prev.slice(-800), msg]);
  }, []);

  // Loading/error chrome for library item fetches (open/save), driven by events
  // the libs bridge dispatches (wasm/libs/source). The fetch is otherwise
  // invisible; a 404 would silently do nothing without this.
  React.useEffect(() => {
    let busyTimer: ReturnType<typeof setTimeout> | undefined;
    const onBusy = (e: Event) => {
      const d = (e as CustomEvent<LibBusyDetail>).detail;
      clearTimeout(busyTimer);
      if (d.busy) {
        // Debounce — only flag slow fetches, so fast ones don't flicker.
        busyTimer = setTimeout(() => setLibBusy(d.name || "library item"), 180);
      } else {
        setLibBusy(null);
      }
    };
    const onError = (e: Event) => {
      setLibError((e as CustomEvent<LibErrorDetail>).detail.message);
    };
    const onItemUpdated = (e: Event) => {
      const d = (e as CustomEvent<LibItemUpdatedDetail>).detail;
      // Footprints have no placed-usage bridge (kicadLibsSymbolUsage is
      // symbol-only), so every applied peer edit is announced — silently
      // refreshing the lib under the user was the worse failure mode.
      if (d.kind === "footprint") {
        if (d.names.length === 0) return;
        const names = d.names.map((n) => `"${n}"`).join(", ");
        setLibUpdate(
          `${d.names.length === 1 ? "Footprint" : "Footprints"} ${names} in "${d.lib}" ` +
            `${d.names.length === 1 ? "was" : "were"} updated by a collaborator — ` +
            `placed copies keep the previous version until updated from the library.`,
        );
        return;
      }
      // Only warn when the update touches something PLACED here — the library
      // tree already reflects updates to everything else.
      if (d.usedNames.length === 0) return;
      const names = d.usedNames.map((n) => `"${n}"`).join(", ");
      setLibUpdate(
        `${d.usedNames.length === 1 ? "Symbol" : "Symbols"} ${names} in "${d.lib}" ` +
          `${d.usedNames.length === 1 ? "was" : "were"} updated by a collaborator — ` +
          `placed copies keep the previous version until updated from the library.`,
      );
    };
    const onDocReverted = (e: Event) => {
      const d = (e as CustomEvent<{ reason?: string; at?: string }>).detail;
      setDocReverted(
        `This document was rolled back to its last valid state — invalid content ` +
          `was detected${d?.reason ? ` (${d.reason})` : ""}. Recent edits may have been undone.`,
      );
    };
    const onLibSet = (e: Event) => {
      const d = (e as CustomEvent<LibSetChangedDetail>).detail;
      // Only additions get a call to action — a removed lib's table row is
      // inert until the next boot and needs no interruption.
      if (d.op !== "add") return;
      setLibSetNotice({
        message: d.name
          ? `A collaborator added library "${d.name}" — click to load it into this session.`
          : `A collaborator added a new library — click to load it into this session.`,
        detail: d,
        mode: "load",
      });
    };
    window.addEventListener(LIB_BUSY_EVENT, onBusy);
    window.addEventListener(LIB_ERROR_EVENT, onError);
    window.addEventListener(LIB_ITEM_UPDATED_EVENT, onItemUpdated);
    window.addEventListener(LIB_SET_CHANGED_EVENT, onLibSet);
    window.addEventListener(DOC_REVERTED_EVENT, onDocReverted);
    return () => {
      clearTimeout(busyTimer);
      window.removeEventListener(LIB_BUSY_EVENT, onBusy);
      window.removeEventListener(LIB_ERROR_EVENT, onError);
      window.removeEventListener(LIB_ITEM_UPDATED_EVENT, onItemUpdated);
      window.removeEventListener(LIB_SET_CHANGED_EVENT, onLibSet);
      window.removeEventListener(DOC_REVERTED_EVENT, onDocReverted);
    };
  }, []);

  // Auto-dismiss the lib error toast.
  React.useEffect(() => {
    if (!libError) return;
    const t = setTimeout(() => setLibError(null), 6000);
    return () => clearTimeout(t);
  }, [libError]);

  // Auto-dismiss the lib update toast (a touch longer — it carries a caveat).
  React.useEffect(() => {
    if (!libUpdate) return;
    const t = setTimeout(() => setLibUpdate(null), 10_000);
    return () => clearTimeout(t);
  }, [libUpdate]);

  // Auto-dismiss the lib-set toast (long — it carries a click action).
  React.useEffect(() => {
    if (!libSetNotice) return;
    const t = setTimeout(() => setLibSetNotice(null), 30_000);
    return () => clearTimeout(t);
  }, [libSetNotice]);

  // Auto-dismiss the doc-reverted toast (longest — the user should see it).
  React.useEffect(() => {
    if (!docReverted) return;
    const t = setTimeout(() => setDocReverted(null), 15_000);
    return () => clearTimeout(t);
  }, [docReverted]);

  // Full-library eager load overlay. The fat-load fires one loading:true/false
  // pair PER library (222 on the full set), and between them the C++ side parses
  // with the main thread blocked. Show immediately on `true`, and only hide after
  // a short quiet gap on `false` (reset by the next lib's `true`) — so the overlay
  // stays continuous across the whole run and drops shortly after the last lib,
  // instead of flickering 222 times.
  React.useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const onLoading = (e: Event) => {
      const d = (e as CustomEvent<LibLoadingDetail>).detail;
      clearTimeout(hideTimer);
      // Update the bar on every event (true and false) so the count reflects the
      // latest lib; arm the hide only when the run reports it's winding down.
      setLibLoading({ kind: d.kind || "library", done: d.done, total: d.total });
      if (!d.loading) {
        hideTimer = setTimeout(() => setLibLoading(null), 700);
      }
    };
    window.addEventListener(LIB_LOADING_EVENT, onLoading);
    return () => {
      clearTimeout(hideTimer);
      window.removeEventListener(LIB_LOADING_EVENT, onLoading);
    };
  }, []);

  // Board 3D-model prefetch progress (models-bridge prescan) — background badge.
  React.useEffect(() => {
    const onModels = (e: Event) => {
      const d = (e as CustomEvent<ModelsLoadingDetail>).detail;
      setModelsSync(
        d.loading ? `Fetching 3D models — ${d.done}/${d.total}` : null,
      );
    };
    window.addEventListener(MODELS_LOADING_EVENT, onModels);
    return () => window.removeEventListener(MODELS_LOADING_EVENT, onModels);
  }, []);

  // "Taking too long": once the tool has been loading for a while without
  // becoming ready, surface a hint (slow link / something may be wrong) + a
  // reload, so a stalled boot doesn't look like a frozen blank screen. Paused
  // while the consent dialog is up — waiting on the user isn't "slow".
  React.useEffect(() => {
    if (ready || consent) return;
    const t = setTimeout(() => setSlow(true), 60_000);
    return () => clearTimeout(t);
  }, [ready, consent]);

  // Runtime death AFTER the boot succeeded. A wasm trap ("indirect call
  // signature mismatch", "table index is out of bounds") or an abort() arrives
  // as a window error / unhandled rejection long after `ready` flipped, with the
  // boot overlay already gone — so without this the page just goes blank. Only
  // genuinely terminal signatures promote to the fatal overlay; ordinary app
  // errors must not hijack a working editor.
  React.useEffect(() => {
    // The predicate lives in wasm/terminal-error.ts (unit-tested there) and is
    // shared with the error reporter, so the overlay and Better Stack can never
    // disagree about what "terminal" means.
    //
    // It checks the error's TYPE first — every trap in this family is a
    // `WebAssembly.RuntimeError` whatever the engine calls it — with the message
    // patterns kept only as a fallback for the paths that lose the Error object
    // (a worker ErrorEvent crosses the realm boundary with `error: null`).
    //
    // That ends the per-engine spelling chase this check kept losing. Matching
    // the message alone had three live holes: `RuntimeError` was listed but
    // never appears IN `.message`; Chrome's bare "unreachable" and "null
    // function" (the v0.1.20 prod log) matched nothing; and narrowing
    // "table index is out of bounds" to `\bindex out of bounds` for Firefox's
    // spelling silently stopped matching Chrome's. The type check covers all
    // of them, and the fallback pattern is now a superset of the old one.
    // Promote to the fatal screen AND pop the console open: the log panel is
    // the only account of what was loading, so a fatal must never leave it
    // collapsed behind a mystery blue screen.
    const promote = (kind: string, msg: string) => {
      append(`[fatal] ${kind}: ${msg}`);
      append(dumpTrace());
      // The scheduler flight recorder: event ring + wait/activation state at
      // death — the targeting data for suspension-machinery traps
      // (__wxWaitDump, jspi-scheduler.js).
      const dumper = (
        window as Window & {
          __wxWaitDump?: () => unknown;
        }
      );
      const rec = dumper.__wxWaitDump?.();
      if (rec) append(JSON.stringify(rec));
      // Stop the ticket storm (findings C-7): every ws-driven collab ingress
      // (remote applies, presence push, comment pins, follow fit, drift saves)
      // re-armed on the next event and re-entered the DEAD instance behind
      // the overlay. Terminal means the native lifetime is over — unhook it.
      teardownCollab();
      setFatal(msg);
      setShowLog(true);
      // Arm the React-independent floor too: it stays invisible while our
      // overlay is up, and takes over the instant React dies.
      showFatalScreen(msg);
    };
    const onError = (e: ErrorEvent) => {
      const msg = errorMessage(e.error, e.message);
      if (!isTerminalError(e.error, msg)) return;
      promote("window error", msg);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = errorMessage(e.reason);
      if (!isTerminalError(e.reason, msg)) return;
      promote("unhandled rejection", msg);
    };
    const onProjectionFailure = (e: Event) => {
      const failure = (e as CustomEvent<NativeProjectionFailure>).detail;
      const recovery =
        failure?.recovery === "repair-yjs-before-recreate"
          ? "The authoritative collaboration state must be corrected before reloading; " +
            "reloading this malformed room alone cannot recover the editor."
          : failure?.recovery === "upgrade-client"
            ? "Update the application before recreating the editor from this room."
            : "Reload to recreate the editor from authoritative Yjs state.";
      promote(
        "native projection",
        `${failure?.message ?? "native projection entered an unknown state"} ${recovery}`,
      );
    };
    // With PROXY_TO_PTHREAD, main()/wx/timers — and therefore every wasm
    // trap in this family — throw INSIDE a pthread worker. A worker's uncaught
    // error fires an ErrorEvent on the Worker OBJECT, never on `window`, so the
    // two listeners below can't see the very traps this overlay exists for
    // (v0.1.19 prod: three "Uncaught RuntimeError"s, overlay never promoted).
    // Wrap the constructor attach-only: the glue spawns all pthread workers
    // from this realm, so every one gets an error tap.
    const NativeWorker = window.Worker;
    const onWorkerError = (e: ErrorEvent) => {
      const msg = errorMessage(e.error, e.message);
      if (!isTerminalError(e.error, msg)) return;
      promote("worker error", msg);
    };
    const PatchedWorker = function (
      this: unknown,
      ...args: ConstructorParameters<typeof Worker>
    ) {
      const w = new NativeWorker(...args);
      w.addEventListener("error", onWorkerError);
      return w;
    } as unknown as typeof Worker;
    PatchedWorker.prototype = NativeWorker.prototype;
    window.Worker = PatchedWorker;
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener(NATIVE_PROJECTION_FAILED_EVENT, onProjectionFailure);
    return () => {
      window.Worker = NativeWorker;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener(NATIVE_PROJECTION_FAILED_EVENT, onProjectionFailure);
    };
  }, [append, teardownCollab]);

  React.useEffect(() => {
    const win = window as ToolWindow;
    const removeNavigationHook = installToolNavigationHook(win, {
      slug,
      files,
      targetPath,
      createFile,
      log: append,
    });

    // File→Quit leaves the editor for the project overview — lib editors
    // (/:scope/libs/:name) have none, so they exit home instead. Both are
    // non-editor surfaces: on a backed deploy (APP_URL set) they belong to the
    // management app, so quit goes straight there (one hop instead of letting
    // App.tsx's 0006 redirect bounce it).
    const segments = win.location.pathname.split("/").filter(Boolean);
    const exitPath =
      segments[1] === "libs" ? "/" : projectPath(currentScope(), slug);
    const removeQuitHook = installQuitHook(win, {
      exitUrl: redirectTargetFor(APP_URL, exitPath) ?? exitPath,
      log: append,
    });

    return () => {
      removeNavigationHook();
      removeQuitHook();
    };
  }, [slug, files, targetPath, createFile, append]);

  React.useEffect(() => {
    // Guard re-entry: the WASM runtime is process-global and must boot exactly
    // once (see boot.ts). StrictMode is disabled app-wide for the same reason.
    if (startedRef.current) return;
    startedRef.current = true;

    const container = containerRef.current;
    if (!container) {
      setStatus("Error: tool container not mounted");
      return;
    }

    // Fresh mount (or StrictMode re-run): re-arm the deferred starters.
    disposedRef.current = false;

    const win = window as ToolWindow;

    // OOM recovery (feature 0002): watch for soft aborts + a stale hard-kill
    // sentinel, respawning a fresh tab (capped). If the chain is already
    // exhausted, skip boot and show the terminal dialog.
    const oom = createOomWatch({
      channelKey: `${slug}:${targetPath ?? tool}`,
      showExhaustedDialog: () => setOomExhausted(true),
      log: append,
    });
    const { proceed } = oom.start();
    if (!proceed) return;

    // (Re)bind presence to a collab room's awareness (collab-presence 0001):
    // publish this user's identity and mirror the peers into the roster chip.
    // pcbnew/pl_editor bind once; eeschema rebinds per active sheet, so the
    // roster shows who is on the SAME sheet (room = sheet).
    const startPresence = (
      provider: YjsProvider | undefined,
      sheetPath?: string,
      doc?: import("yjs").Doc,
    ) => {
      // Invisible observer (read-only-viewer): never bind presence — no roster,
      // no cursor/selection emit, no awareness state (peers stays empty).
      if (readOnly) return;
      followRef.current?.destroy();
      followRef.current = null;
      setFollowingTarget(null);
      presenceBridgeRef.current?.destroy();
      presenceBridgeRef.current = null;
      presenceRef.current?.destroy();
      presenceRef.current = null;
      const awareness = provider?.awareness;
      if (!awareness) {
        setPeers([]);
        return;
      }
      const presence = createPresence({
        awareness,
        user: presenceUser(),
        tool,
        sheetPath,
        // Round-robin colors seeded by the doc's comment authors (0009 C):
        // claims avoid their slots, an author rejoining adopts their own.
        ...(doc ? { seedColors: () => commentAuthorColors(doc) } : {}),
      });
      presenceRef.current = presence;
      presence.subscribe(setPeers);
      setPeers(presence.peers());
      setActiveSheetPath(sheetPath);
      // Canvas presence (0002 pcbnew / 0003 eeschema): cursor + selection emit
      // and the remote VIEW_OVERLAY render. The bridge gate skips tools without
      // the exports and wasm builds predating them.
      if ((tool === "pcbnew" || tool === "eeschema") && hasPresenceBridge(win.Module)) {
        // Follow-user (0008): available when the wasm exports FitViewport.
        const fitFn = (win.Module as PresenceKicadModule).kicadCollabFitViewport;
        if (fitFn) {
          const follow = createFollow({
            presence,
            fit: (cx, cy, halfW, halfH) => fitFn.call(win.Module, cx, cy, halfW, halfH),
            ownSheetPath: () => sheetPath,
          });
          follow.subscribe(setFollowingTarget);
          followRef.current = follow;
        }
        presenceBridgeRef.current = bindKicadPresence({
          mod: win.Module,
          win: win as unknown as PresenceKicadWindow,
          presence,
          // Cross-app selection (0006): the project presence room, if joined.
          crossApp: crossAppRef.current ?? undefined,
          // Live world↔screen transform for the DOM comment layer (0005) +
          // the follow controller's echo/break detection (0008).
          onViewport: (vp) => {
            setViewportState(vp);
            followRef.current?.noteLocalViewport(vp);
          },
        });
      }
    };

    // (Re)bind the comments controller to the collab doc (collab-presence 0005):
    // GAL pin dots + the DOM layer's thread data. Follows the same lifecycle as
    // presence — eeschema rebinds per active sheet.
    const startComments = (doc: import("yjs").Doc | undefined) => {
      // Comments are hidden entirely for read-only viewers (read-only-viewer):
      // no pins, no panel, no thread reads — commentsCtl stays null.
      if (readOnly) return;
      commentsRef.current?.destroy();
      commentsRef.current = null;
      setCommentsCtl(null);
      if (!doc || (tool !== "pcbnew" && tool !== "eeschema") || !hasCommentsBridge(win.Module)) {
        return;
      }
      const ctl = createComments({
        doc,
        mod: win.Module,
        user: commentAuthor(),
        tool,
        // Author colors follow the live nth-in-room assignment when the
        // author is present; offline authors fall back to the name hash.
        colorFor: (id) => presenceRef.current?.colorOf(id),
      });
      commentsRef.current = ctl;
      setCommentsCtl(ctl);
      // Test/debug handle (mirrors window.kicadCollab): lets the e2e reset
      // persisted threads deterministically without driving the whole UI.
      (win as { __pcbjamComments?: CommentsController }).__pcbjamComments = ctl;
      if (PRESENCE_TUNER_ENABLED && hasTunerBridge(win.Module)) {
        setTunerMod(win.Module);
      }
      // Seed the transform (pushes only happen on input events after this).
      try {
        const vp = JSON.parse(win.Module.kicadCollabGetViewport() || "null");
        if (vp && vp.w > 0) setViewportState(vp);
      } catch {
        /* frame not up yet — the first input push seeds it */
      }
    };

    // Cmd/Ctrl+S belongs to the editor: preventDefault suppresses ONLY the
    // browser's "save page" dialog (observed in Firefox) — the keydown still
    // propagates to the wx canvas handler, which performs the actual save.
    const swallowBrowserSave = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
      }
    };
    win.addEventListener("keydown", swallowBrowserSave, true);

    // Cmd/Ctrl+\ (Figma's hide-UI chord) is ours alone: unlike Cmd+S it must
    // NOT reach the wx layer, so also stop propagation — capture on window
    // fires before wx's bubble-phase window listeners (wasm/app.cpp).
    const chromeHotkey = (e: KeyboardEvent) => {
      if (readOnly) return; // viewers can't reveal the chrome (read-only-viewer)
      if (!isChromeToggleHotkey(e)) return;
      if (!chromeSetter(win)) return; // bundle without the export
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleChromeHidden();
    };
    win.addEventListener("keydown", chromeHotkey, true);

    // The background lib pre-sync outlives the boot IIFE (it keeps warming IDB
    // long after the editor is interactive), so unmount has to be able to stop
    // it: `presync` checks this signal between libs. Declared out here — the
    // cleanup below closes over it — and never rejected, so aborting mid-sync
    // leaks nothing and throws nothing.
    const presyncAbort = new AbortController();
    // The save sink is a global slot (D-9): keep its teardown edge so a
    // remount can't leave the dead mount uploading + publishing status.
    let unregisterSaveHook: (() => void) | null = null;
    // The libs source THIS boot created (vs. one injected via props, which the
    // caller owns) — cleanup disposes it so its SyncStack sockets don't outlive
    // the editor.
    let ownedLibsSource: LibsSource | null = null;

    void (async () => {
      try {
        // Real identity (collab-presence 0009 A): resolve the session user in
        // parallel with the WASM download; awaited after boot, before anything
        // binds presence/comments, so presenceUser()/userSlug() speak for the
        // authenticated user (anonymous/example backends resolve to null and
        // the pre-auth slug fallback stays). A boot payload already carries
        // the /api/me shape — seeding it makes this a resolved no-op flight.
        if (boot?.me) seedSessionIdentity(boot.me);
        const identityReady = loadSessionIdentity(API_BASE_URL);
        // Resolve the per-tool asset base at runtime (CDN manifest → versioned
        // folder, or the flat local /wasm in dev). See wasm/wasm-assets.ts.
        const meta = await resolveWasmMeta(tool, assetBaseUrl);
        const base = meta.base;
        // One source instance, shared by the wasm provider AND the pre-sync below
        // (libsSourceConfig builds a fresh one each call — their SyncStack caches
        // must be the same object for the warm-up to benefit the editor). A boot
        // payload pre-seeds its lib listing + stack resolves (zero lib HTTP).
        const source =
          libsSource !== undefined
            ? libsSource
            : libsSourceConfig(
                projectId,
                boot ? { libs: boot.libs, stacks: boot.stacks } : undefined,
              );
        if (libsSource === undefined) ownedLibsSource = source;
        activeLibsSourceRef.current = source;
        // Download-consent gate (standalone-load-ux 0001): before pulling the
        // (large) cold wasm + lib bundles, say how many MB and wait for the OK.
        // Runs only on versioned CDN deploys (`meta.ver` — flat dev roots and
        // e2e assetBaseUrl overrides have no version and skip it), when this
        // exact bundle+version hasn't finished downloading before, and the user
        // hasn't opted into silent downloads. Only small JSON/HEAD requests
        // happen before consent.
        const warm = isWasmDownloaded(meta.bundle, meta.ver);
        setWarmBoot(warm);
        if (meta.ver && !warm && !autoDownloadEnabled()) {
          const info = await gatherConsentInfo(meta, source, tool);
          const ok = await new Promise<boolean>((resolve) => {
            consentResolveRef.current = resolve;
            setConsent(info);
          });
          consentResolveRef.current = null;
          setConsent(null);
          if (!ok) return; // unmounted while waiting — never start the download
        }
        // Boot fan-out (load-fanout): everything that doesn't need the wasm
        // starts NOW, in parallel with the (large) wasm download.
        //
        // - Lib presync: warms the per-lib IDB bundles. It briefly lived AFTER
        //   the project open (2a47103) because opening a board took minutes —
        //   but the real problem was ordering (libs awaited before the project
        //   files, which fetched serially), not bandwidth: the ~155 lib
        //   requests are latency-bound, and the files now stage 8-wide the
        //   moment FS is up. So the presync overlaps the whole download again.
        // - Doc-room connect: the collab websocket is up BEFORE the project
        //   files are fetched, so a file changed while we load still reaches
        //   this client (the room materializes the target; sheet/sibling rooms
        //   bind after open, as before).
        // - Project files: driveProjectIntoTool below starts fetching as soon
        //   as the glue scripts have evaluated — the non-modularized glue runs
        //   FS.staticInit() at script-eval, so MEMFS staging overlaps the wasm
        //   download/compile rather than following it.
        const libKind = LIB_KIND_FOR_TOOL[tool];
        // Best-effort and NEVER rejects: `presyncSettled` resolves when the
        // warm-up finished, failed, or was aborted (immediately when the source
        // has none). A lib that fails to presync still loads lazily later, and
        // the SyncStack dedups — a lib the wasm reaches mid-presync just awaits
        // the same in-flight fetch. The signal stops the walk on unmount; the
        // setLibSync guards keep a late progress callback from re-lighting the
        // indicator of a torn-down session.
        const startLibPresync = (): Promise<void> => {
          if (!source?.presync || !libKind) return Promise.resolve();
          return source
            .presync({
              kind: libKind,
              signal: presyncAbort.signal,
              onProgress: ({ done, total }) => {
                if (presyncAbort.signal.aborted) return;
                setLibSync(done >= total ? null : { kind: libKind, done, total });
              },
            })
            .then(() => setLibSync(null))
            .catch((e) => {
              append(`[presync] ${String(e)}`);
              setLibSync(null);
            });
        };
        const presyncSettled = startLibPresync();
        void presyncSettled.then(() => append(mark("presync:settled")));
        // Lib editors (fileless): their frame eagerly enumerates EVERY lib of
        // its kind at boot, one mutex-serialized bridge crossing at a time
        // (g_pcbjamProxyMutex in the plugins) — a cold lib would network-fetch
        // inside its serial crossing. Hold enumerates until the 8-wide presync
        // settles so the crossings read warm IDB. pcbnew/eeschema are NOT
        // gated: their choosers open on demand, and a mid-session park with no
        // overlay would read as a hang.
        const enumerateGate =
          FILELESS_TOOLS.has(tool) && libKind
            ? (kind: string) =>
                kind === libKind ? presyncSettled : Promise.resolve()
            : undefined;
        // ?collab=0 is a FULL kill-switch as of 2026-08-02: it now also skips
        // the doc-room join below, so the target file falls back to the plain
        // fetch path instead of ydoc materialization. Before, it only gated
        // the attach — which made the flag useless as a crash-hunt bisection
        // lever (the 8/2 "collab=0" prod test still materialized from the
        // room and even attached).
        const collabOptOut =
          new URLSearchParams(win.location.search).get("collab") === "0" ||
          new URLSearchParams(win.location.search).get("collab") === "false";
        // Connect the doc's collab room in parallel with the wasm download (it
        // needs identity, not the wasm). Errors are captured and rethrown at
        // the await below — rejecting here would surface as an unhandled
        // rejection while the download is still running.
        const docSessionReady: Promise<
          | { session?: KicadDocSession; targetBytes?: Uint8Array }
          | { error: unknown }
        > = (async () => {
          if (collabOptOut) {
            append("[collab] ?collab=0 — doc room skipped, file loads from plain fetch");
            return {};
          }
          try {
            await identityReady;
            return await maybeConnectDocSession(win, {
              docSource,
              tool,
              scopeId,
              projectId,
              targetPath,
              signal: presyncAbort.signal,
              log: append,
            });
          } catch (error) {
            return { error };
          }
        })();
        // Project presence room, same fan-out slot as the doc room: it needs
        // identity and a socket, NOT the wasm, so the websocket handshake
        // happens while the wasm still downloads instead of queueing behind a
        // multi-second board load (which also starves the handshake — Firefox
        // drops it as "interrupted while the page was loading"). Only the
        // wasm-bound half (bindKicadPresence) waits for the open to settle.
        // Never rejects: presence is best-effort, exactly as before.
        // Read-only viewers skip the room entirely — the server rejects their
        // connection anyway (presence requires write).
        const crossAppReady: Promise<CrossAppHandle | undefined> =
          (tool === "pcbnew" || tool === "eeschema") && !collabOptOut && !readOnly
            ? (async () => {
                try {
                  await identityReady;
                  return await startCrossAppPresence({
                    scopeId,
                    projectId,
                    provider: yjsProviderConfig(),
                    user: presenceUser(),
                    tool,
                    // Announce the open document (the active sheet for
                    // eeschema, re-published on navigation below) — peers'
                    // sibling-restage scopes its sockets to announced files.
                    docPath: targetPath,
                  });
                } catch (err) {
                  append(`[collab] cross-app presence connect failed: ${String(err)}`);
                  return undefined;
                }
              })()
            : Promise.resolve(undefined);
        // Take ownership the moment it lands — a boot that dies before the
        // handoff below would otherwise leave this socket open, since unmount
        // only tears down what reached crossAppRef.
        void crossAppReady.then((h) => {
          if (!h) return;
          if (presyncAbort.signal.aborted) h.destroy(); // unmounted mid-connect
          else crossAppRef.current = h;
        });
        await bootKicadTool({
          tool,
          base,
          container,
          log: append,
          onStatus: setStatus,
          onAbort: oom.onAbort,
          onProgress: (loaded, total) => setProgress({ loaded, total }),
          // Truthful loading states (standalone-load-ux 0001): the manifest's
          // raw wasm size fixes the progress total under br/gzip; the marker
          // flips the label to "Loading" (HTTP cache) vs "Downloading"; the
          // completion marker is recorded once download + compile succeeded.
          expectedWasmBytes: meta.sizes?.wasm ?? null,
          warmStart: warm,
          onWasmInstantiated: () => markWasmDownloaded(meta.bundle, meta.ver),
          libsSource: source,
          enumerateGate,
          // 3D models: lazy per-board source (null unless a model backing is
          // configured) — feeds the board prescan + the viewer's ensure
          // fallback. Registry mode reuses the boot payload's lib listing +
          // stack resolves (zero extra model requests on a preloaded boot).
          modelsSource: modelsSourceConfig(
            boot ? { libs: boot.libs, stacks: boot.stacks } : undefined,
          ),
          // footprint_editor/symbol_editor load the pcbnew/eeschema bundle; the
          // frame token tells its single_top launcher which editor frame to open.
          frame: TOOL_FRAME[tool],
          mobile: mobileUi,
        });
        // Identity must be settled before the doc session / presence binds
        // below — effectively instant, it raced the multi-second wasm boot.
        await identityReady;
        // Register the save sink before the file opens: from here on, every
        // editor File→Save (MEMFS write) is routed onward through saveBytes.
        // Read-only sessions register neither upload nor the save-driven room
        // writers (onSaved onboarding, onSavedText layout sync) — saves, were
        // any reachable past the wasm lock, stay MEMFS-only.
        const saveHookHandle = registerSaveHook(win, {
          slug,
          saveBytes: readOnly ? undefined : saveBytes,
          log: append,
          onStatus: setStatus,
          ...(readOnly
            ? {}
            : {
                // Durable per-path block (409 conflict / unknown commit
                // state): surface it as the persistent save-blocked banner.
                onBlocked: (block: SaveBlock) => setSaveBlocked(block),
                // A sheet created mid-session ("Add Sheet") saves to a new .kicad_sch path the
                // page-load file list can't contain — warm its collab room so it stays in sync.
                onSaved: (relPath: string) => {
                  if (relPath.endsWith(".kicad_sch"))
                    void sheetManagerRef.current?.onboard(relPath);
                },
                // Non-item document state (title block, paper, setup…) only reaches the
                // room at seed time; reconcile it from every save (miss 08B).
                onSavedText: (relPath: string, text: string) => {
                  if (sheetManagerRef.current) {
                    sheetManagerRef.current.syncLayoutFromSave(relPath, text);
                    return;
                  }
                  if (collabDocRef.current && relPath === targetPath) {
                    try {
                      const savedDoc = fileToDoc(text);
                      const binding = collabHandleRef.current?.binding;
                      if (binding) binding.syncLayoutFromNative(savedDoc);
                      else syncLayoutToY(savedDoc, collabDocRef.current, "layout-save");
                    } catch (err) {
                      append(`[save] layout sync failed: ${String(err)}`);
                    }
                  }
                },
              }),
        });
        unregisterSaveHook = () => saveHookHandle.stop();
        // The room connect started in the fan-out above — settle it before
        // staging so the target file materializes from the doc when it has one.
        const docResult = await docSessionReady;
        if ("error" in docResult) throw docResult.error;
        const { session, targetBytes } = docResult;
        // The session is connected but ownerless until a collab handle or the
        // sheet manager adopts it below — register it so every failure exit
        // (boot throw, open-never-settled, degrade, unmount) destroys it
        // instead of leaking the socket + doc (findings C-1).
        pendingDocSessionRef.current = session ?? null;
        const openResult = await driveProjectIntoTool(win, {
          tool,
          slug,
          files,
          targetPath,
          // ydoc source with a populated room: the target file's bytes come
          // from the doc; everything else (sibling files) still fetches.
          fetchBytes:
            targetBytes && targetPath
              ? (relPath) =>
                  relPath === targetPath ? Promise.resolve(targetBytes) : fetchBytes(relPath)
              : fetchBytes,
          // Plain files stage via the project sync namespace — one bundle GET
          // cold, a manifest diff warm (0001 §4 full). Backend projects only:
          // the gallery/local sources have no sync routes and no CAS rows.
          projectSync:
            sourceDescriptor?.kind === "remote-rw" && scopeId !== "local"
              ? {
                  apiBase: API_BASE_URL,
                  scope: currentScope(),
                  scopeId,
                  projectId,
                  // Boot's fresh digest: a warm match stages with ZERO HTTP.
                  digest: boot?.projectSync.digest,
                }
              : null,
          log: append,
          onStatus: setStatus,
          onFileProgress: (done, total) =>
            setFileSync(done >= total ? null : { done, total }),
        });
        // Read-only viewer (read-only-viewer): lock the wasm frame BEFORE the
        // boot overlay drops — the file is open, so the frame exists; poll the
        // export like the chrome toggle does. Fails CLOSED (boot error overlay):
        // a viewer must never get a writable-feeling frame. gerbview/calculator
        // bundles have no lock export and nothing project-mutating to lock —
        // they proceed (saves are already MEMFS-only above).
        if (readOnly) {
          const setRo = (
            win.Module as
              | { kicadSetReadOnly?: (v: boolean) => boolean | Promise<boolean> }
              | undefined
          )?.kicadSetReadOnly;
          if (typeof setRo === "function") {
            // The scheduler's mutator lane returns the boolean synchronously
            // when the wasm side is idle, and a Promise for the SAME call when
            // it queued behind a live open — await covers both. (The old
            // poll-until-literal-true loop could spin forever under JSPI: a
            // queued call re-enqueues on every retry and never compares true.)
            const applied = await Promise.race([
              Promise.resolve(setRo(true)),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("read-only lock did not apply")),
                  30_000,
                ),
              ),
            ]);
            if (applied !== true) {
              throw new Error("read-only lock did not apply");
            }
            append("[readonly] wasm frame locked (kicadSetReadOnly)");
          } else if (tool !== "gerbview" && tool !== "calculator") {
            throw new Error(
              "read-only mode is not supported by this build (kicadSetReadOnly missing)",
            );
          }
        }
        // Everything below drives BARE embind entries that walk the loaded
        // model (collab snapshot/adopt, presence bind, drift). Deferred until
        // the open chain settled (openResult) — calling them while the
        // kicadOpenFile activation is still parked mid-load walks a
        // half-built model and traps ("indirect call signature mismatch").
        const attachCollabAndPresence = async () => {
        // Drift detection: while a sheet is collaboratively edited, periodically (every N
        // edits + at session end) compare the WASM serialization to the Y.Doc and report
        // divergence. Gated on a real collab session; re-targeted per active sheet below.
        const { startDriftDetection } = await import("@/wasm/collab/drift-detect");

        // Cross-app selection (0006): join the project-wide presence room BEFORE
        // the per-file collab starts, so the first startPresence bind already
        // routes xsel. Honors the same ?collab=0 opt-out as the room collab.
        // Cross-app presence: the ROOM was joined back in the boot fan-out
        // (pure network + Y.Doc, no wasm) — only the handoff to the wasm-bound
        // presence below has to wait for the open. Settle it here.
        const crossAppHandle = (await crossAppReady) ?? null;
        if (disposedRef.current) {
          // Unmounted while awaiting — cleanup already ran; adopting now would
          // leak a live socket behind a dead component (findings C-1).
          crossAppHandle?.destroy();
          return;
        }
        crossAppRef.current = crossAppHandle;
        // Test/debug handle (mirrors __pcbjamComments): lets the e2e assert
        // the project-room peer view without driving pixels.
        (win as { __pcbjamCrossApp?: CrossAppHandle | null }).__pcbjamCrossApp =
          crossAppRef.current;

        if (tool === "eeschema") {
          // Multi-room (subschema) collab: every .kicad_sch is its own warm room; the
          // active sheet is bound, navigation re-routes it (C++ onSheetChanged hook).
          sheetManagerRef.current =
            (await startSheetCollab(win, {
              slug,
              scopeId,
              projectId,
              targetPath,
              files,
              session,
              saveBytes: readOnly ? undefined : saveBytes,
              editorMatchesDoc: !!targetBytes,
              readOnly,
              // Re-point drift detection + presence at whichever sheet is bound.
              onActiveChange: (activeRoom) => {
                driftRef.current?.stop();
                driftRef.current = null;
                // Re-announce the actively-edited sheet in the project room —
                // peers' sibling-restage tracks it (a pcbnew tab only mirrors
                // sheets someone actually has open).
                crossAppRef.current?.setDocPath(activeRoom?.sheetPath);
                startPresence(activeRoom?.provider, activeRoom?.sheetPath, activeRoom?.doc);
                startComments(activeRoom?.doc);
                setPanelDoc(activeRoom?.doc ?? null);
                if (activeRoom && !readOnly) {
                  driftRef.current = startDriftDetection({
                    doc: activeRoom.doc,
                    mod: win.Module,
                    win,
                    tool,
                    slug,
                    targetPath: activeRoom.sheetPath,
                    log: append,
                  });
                }
              },
              log: append,
              onStatus: setStatus,
            })) ?? null;
          if (sheetManagerRef.current) {
            // The manager's room pool now owns the entry session (destroy()
            // tears it down with every other warm room).
            pendingDocSessionRef.current = null;
          }
          if (disposedRef.current) {
            // Late handoff after unmount (findings C-1): cleanup already ran.
            sheetManagerRef.current?.destroy();
            sheetManagerRef.current = null;
            return;
          }
        } else {
          const collabHandle = await maybeStartCollab(win, {
            tool,
            slug,
            scopeId,
            projectId,
            targetPath,
            collabSession: session,
            editorMatchesDoc: !!targetBytes,
            readOnly,
            log: append,
            onStatus: setStatus,
          });
          if (collabHandle) {
            // The handle owns the session now (destroy() covers binding +
            // provider + doc).
            pendingDocSessionRef.current = null;
          }
          if (disposedRef.current) {
            // Late handoff after unmount (findings C-1): cleanup already ran.
            collabHandle?.destroy();
            return;
          }
          collabHandleRef.current = collabHandle ?? null;
          collabDocRef.current = collabHandle?.doc ?? null;
          startPresence(collabHandle?.provider, undefined, collabHandle?.doc);
          startComments(collabHandle?.doc);
          setPanelDoc(collabHandle?.doc ?? null);
          // Live sibling mirror (project-sync 0001 bug 3): keep the schematic
          // files a PCB session syncs from fresh in MEMFS, instead of the
          // one-shot boot snapshot. Same opt-out as the room collab; read-only
          // viewers skip it (they can't run the sync anyway).
          //
          // STAGGERED out of the settle window (2026-08-02, the ladder
          // result): warm sibling-heavy projects crash at exactly this moment
          // (V1/V4 fail 2/2 warm, V2/V3 without siblings never do), and the
          // scheduler flight recorder places the fatal interleave inside the
          // settle-time wake windows. The restage's room connects + restage
          // fetches were the only sibling-specific traffic contending with
          // those windows. Nothing here is needed for first paint — the boot
          // snapshot staged every sibling seconds ago — so it starts when the
          // main thread is idle (or after 5s, whichever first), well clear of
          // the settle storm. Unmount-safety: the ref may be populated after
          // unmount, so the cleanup check runs inside the callback too.
          if (tool === "pcbnew" && collabHandle && !readOnly) {
            const startRestageIdle = () => {
              if (disposedRef.current) return;
              void startSiblingRestage({
                win,
                slug,
                scopeId,
                projectId,
                files,
                targetPath,
                // Presence-scoped: connect a sheet's room only while a peer
                // announces it open (zero sibling sockets when alone). Absent
                // (provider "none" / connect failed) ⇒ eager fallback.
                presence: crossAppRef.current ?? undefined,
                provider: yjsProviderConfig(),
                log: append,
              }).then((handle) => {
                if (disposedRef.current) {
                  handle?.destroy();
                  return;
                }
                siblingRestageRef.current = handle;
              });
            };
            type IdleWindow = Window & {
              requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
            };
            const w = window as IdleWindow;
            if (typeof w.requestIdleCallback === "function") {
              w.requestIdleCallback(startRestageIdle, { timeout: 5000 });
            } else {
              window.setTimeout(startRestageIdle, 3000);
            }
          }
          if (collabHandle && targetPath && COLLAB_TOOLS.has(tool) && !readOnly) {
            driftRef.current = startDriftDetection({
              doc: collabHandle.doc,
              mod: win.Module,
              win,
              tool,
              slug,
              targetPath,
              log: append,
            });
          }
        }
        // Viewer selection feed (viewer-panels): read-only sessions never
        // bind presence (no room, no awareness), so the SelectionInspector's
        // store is fed by a minimal onSelection handler + the C++ canvas
        // input hooks. Edit sessions get the same store fed from
        // bindKicadPresence's handler instead.
        if (readOnly && (tool === "pcbnew" || tool === "eeschema")) {
          localSelectionRef.current = bindLocalSelectionFeed({
            mod: win.Module,
            win: win as unknown as PresenceKicadWindow,
          });
        }
        };
        // Degrading without an adoption must not strand the pre-connected doc
        // session (findings C-1: the open-never-settled path was the most
        // reproducible leak — a live socket + doc with no owner, forever).
        const releasePendingDocSession = (why: string) => {
          const pending = pendingDocSessionRef.current;
          if (!pending) return;
          pendingDocSessionRef.current = null;
          try {
            pending.provider.destroy();
            pending.doc.destroy();
          } catch {
            /* best-effort */
          }
          append(`[collab] released unadopted doc session (${why})`);
        };
        if (openResult === "failed") {
          // The load never settled (or a legacy-wasm open timed out): entering
          // the wasm now would race the parked open chain. Boot on without
          // collab/presence — the board stays viewable, saves still route.
          append("[collab] file open never settled — collab/presence disabled for this session");
          releasePendingDocSession("open never settled");
        } else {
          try {
            await attachCollabAndPresence();
          } catch (err) {
            // Version-skew refusal must still surface as the boot error.
            if ((err as { name?: string } | undefined)?.name === "SexprVersionError") throw err;
            // Degrade, don't die: a residual wasm trap here (reentrancy during
            // some other parked chain) used to fail the whole boot.
            append(`[collab] attach failed — continuing without collab: ${String(err)}`);
            releasePendingDocSession("attach failed");
          }
          // A no-op attach (bridge missing / non-collab tool) adopts nothing.
          releasePendingDocSession("not adopted");
        }
        // Deferred-realtime upgrade: the scope libs source opens its stacks
        // channel-less (no socket per org lib), so promote the libs the OPEN
        // DOCUMENT references — a peer editing a PLACED symbol must still
        // reach this session live (lib-update toast); everything else syncs
        // on the next load. Fire-and-forget: boot never waits on sockets.
        if (targetPath && source?.enableRealtime) {
          const staged = readStagedFile(win, slug, targetPath);
          const nicks = staged
            ? usedLibNicknames(new TextDecoder().decode(staged))
            : [];
          append(
            `[libs] doc references ${nicks.length} lib nickname(s)` +
              (staged ? "" : " (target not staged?)"),
          );
          if (nicks.length) {
            void source
              .enableRealtime(nicks)
              .catch((e) => append(`[libs] realtime upgrade: ${String(e)}`));
          }
        }
        // Lib editors: the enumerate gate holds their whole-set hydrate until
        // the presync settles — wait for it here too, so the boot overlay (with
        // its ticking lib line) stays up instead of revealing an empty tree.
        if (enumerateGate) await presyncSettled;
        // Tool booted + project opened. Wait for the wx UI to actually build
        // before dropping the overlay, so we don't reveal a still-blank editor.
        // First paint reached. Past this point the GAL is initialized, so the
        // refresh-timer self-rearm loop — the precondition for the production
        // load trap — is over. A crash report that contains this mark rules
        // that mechanism out; one that stops before it does not.
        await waitForWxUi(win);
        append(mark("ui:ready"));
        setStatus("");
        setReady(true);
      } catch (err) {
        append(`[fatal] ${String(err)}`);
        append(dumpTrace());
        setStatus(`Error: ${String(err)}`);
        setFatal(String(err));
        // A boot that died between the doc-room connect and its adoption
        // (open failure, read-only lock, version skew) must not strand the
        // live session behind the error overlay (findings C-1).
        const pending = pendingDocSessionRef.current;
        pendingDocSessionRef.current = null;
        if (pending) {
          try {
            pending.provider.destroy();
            pending.doc.destroy();
          } catch {
            /* best-effort */
          }
        }
      }
    })();

    return () => {
      // Deferred starters (the sibling-restage idle stagger) check this
      // before creating anything after unmount.
      disposedRef.current = true;
      // A consent dialog pending at unmount resolves false — the boot IIFE
      // bails without ever starting the download.
      consentResolveRef.current?.(false);
      consentResolveRef.current = null;
      // Stop the background lib warm-up: presync checks the signal between libs,
      // so in-flight bundle fetches finish (their IDB writes are still useful for
      // the next mount) and no further ones start.
      presyncAbort.abort();
      win.removeEventListener("keydown", swallowBrowserSave, true);
      win.removeEventListener("keydown", chromeHotkey, true);
      // The global save sink must not outlive this mount (D-9).
      unregisterSaveHook?.();
      unregisterSaveHook = null;
      // Every collab surface + any not-yet-adopted doc session (C-1/C-7).
      teardownCollab();
      // Close the lib SyncStacks this boot opened (mirror mux + any dedicated
      // sockets); IDB caches stay. Injected sources belong to the caller.
      ownedLibsSource?.dispose?.();
      ownedLibsSource = null;
      oom.stop();
    };
    // Boot is one-shot per mount; deps intentionally exclude files/targetPath so
    // they don't retrigger a (rejected) second boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, slug, assetBaseUrl, append]);

  // kicadSetChrome, once the editor is up (null on bundles without it).
  const setChromeFn = React.useMemo(
    () => (ready ? chromeSetter(window) : null),
    [ready],
  );

  // Layer bridge (viewer-panels), pcbnew sessions only — the merged bundle
  // exports the names for every frame, but they no-op on a non-PCB frame.
  const layersMod = React.useMemo<LayersModule | null>(() => {
    if (!ready || tool !== "pcbnew") return null;
    const mod = (window as { Module?: unknown }).Module;
    return hasLayersBridge(mod) ? mod : null;
  }, [ready, tool]);

  // Apply the chrome-visibility state to the wasm frame. A LAYOUT effect with
  // a synchronous first attempt: `ready` unmounts the opaque boot overlay in
  // this same commit, and a passive effect would let one frame of full chrome
  // paint on mobile. appliedRef skips the initial "shown" apply — never
  // relayout a frame this component never hid.
  const appliedRef = React.useRef<boolean | null>(null);
  React.useLayoutEffect(() => {
    if (!setChromeFn) return;
    if (appliedRef.current === effectiveChromeHidden) return;
    if (appliedRef.current === null && !effectiveChromeHidden) return;

    const apply = () => {
      try {
        return setChromeFn(!effectiveChromeHidden) === true;
      } catch (err) {
        append(`[chrome] kicadSetChrome failed: ${String(err)}`);
        return true; // don't retry a throwing binding
      }
    };
    if (apply()) {
      appliedRef.current = effectiveChromeHidden;
      return;
    }
    // The editor frame can lag `ready` (waitForWxUi falls through after 25 s)
    // — retry briefly rather than dropping the toggle.
    const t0 = Date.now();
    const tick = window.setInterval(() => {
      if (apply()) {
        appliedRef.current = effectiveChromeHidden;
        window.clearInterval(tick);
      } else if (Date.now() - t0 > 30_000) {
        window.clearInterval(tick);
      }
    }, 300);
    return () => window.clearInterval(tick);
  }, [setChromeFn, effectiveChromeHidden, append]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#1a1a2e]">
      {/*
        wx.js addresses the DOM by id: #main-window is its top-level (id=0)
        window — it owns #canvas (created in boot's preRun) — and #window-container
        parents every child window. Both ids must exist before the runtime boots,
        mirroring the harness HTML (tests/apps/kicad/<tool>.html).
      */}
      <div ref={containerRef} id="main-window" className="absolute inset-0 h-full w-full" />
      <div id="window-container" />

      {/* Everything that can throw into React's commit lives INSIDE the
          boundary; the fatal screen and the console panel live OUTSIDE it, so
          a runtime death can no longer white-screen the very UI that reports
          it (see WasmErrorBoundary). */}
      <WasmErrorBoundary
        onFatal={(msg) => {
          append(`[fatal] react tree died: ${msg}`);
          append(dumpTrace());
          setFatal(msg);
          setShowLog(true);
          showFatalScreen(msg);
        }}
      >
      {oomExhausted && (
        <MemoryExhaustedDialog
          onOpenNewTab={() => respawnInNewTab()}
          onReload={() => window.location.reload()}
        />
      )}

      {/* Boot overlay — covers the big WASM download/compile freeze until the
          tool has booted + opened. */}
      {!ready && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#1a1a2e] text-white">
          {status.startsWith("Error") ? (
            <>
              <p className="max-w-md px-6 text-center font-mono text-sm text-red-300">
                {status}
              </p>
              <button
                className="rounded border border-white/30 px-3 py-1 text-xs hover:bg-white/10"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            </>
          ) : consent ? (
            <DownloadConsent
              info={consent}
              onAccept={(always) => {
                if (always) setAutoDownloadEnabled(true);
                consentResolveRef.current?.(true);
              }}
            />
          ) : (
            <>
              <Loader2 className="animate-spin" size={32} />
              <p className="font-mono text-sm text-white/80">
                {status || "Loading…"}
              </p>
              <DownloadProgress progress={progress} />
              {/* The parallel fan-out's other progress: project files staging
                  into MEMFS, and the lib warm-up. The lib line says "checking"
                  on purpose — the walk visits every lib but downloads only new
                  or changed ones, so a bare 15/155 next to the consent dialog's
                  MB figures would read as 155 big downloads. */}
              {fileSync && fileSync.total > 0 && (
                <p className="whitespace-pre font-mono text-xs text-white/50">
                  Project files — {String(fileSync.done).padStart(String(fileSync.total).length, " ")}/{fileSync.total}
                </p>
              )}
              {libSync && (
                <p className="whitespace-pre font-mono text-xs text-white/50">
                  {libSyncLabel(libSync)}
                </p>
              )}
              <p className="font-mono text-xs text-white/40">
                {warmBoot
                  ? "Loading from your browser's cache — no download needed."
                  : "Downloading the editor — it's cached for future visits."}
              </p>
              {slow && (
                <>
                  <p className="max-w-sm px-6 text-center font-mono text-xs text-amber-300/90">
                    This is taking longer than usual — a slow connection, or
                    something may be wrong. You can keep waiting, or reload.
                  </p>
                  <button
                    className="rounded border border-white/30 px-3 py-1 text-xs hover:bg-white/10"
                    onClick={() => window.location.reload()}
                  >
                    Reload
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Eager library load overlay — the first chooser/editor open hydrates the
          whole library set from IDB into wasm (tens of seconds on the full CDN
          set) with the main thread blocked. Cover the (frozen) editor so it reads
          as "loading, just slow" rather than a hang. Shown post-boot; before
          `ready` the boot overlay already covers it. */}
      {ready && libLoading && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#1a1a2e]/95 text-white">
          <Loader2 className="animate-spin" size={32} />
          <p className="font-mono text-sm text-white/80">
            {libLoading.kind === "library"
              ? "Loading libraries…"
              : `Loading ${libLoading.kind} libraries…`}
          </p>
          {libLoading.total > 0 && (
            <div className="w-64 max-w-[70vw]">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-[width] duration-200 ease-out"
                  style={{
                    width: `${Math.min(100, Math.round((libLoading.done / libLoading.total) * 100))}%`,
                  }}
                />
              </div>
              {/* Space-pad `done` to `total`'s width so the centered line
                  doesn't shift as the count gains a digit. */}
              <p className="mt-1 whitespace-pre text-center font-mono text-[11px] text-white/50">
                {String(Math.min(libLoading.done, libLoading.total)).padStart(
                  String(libLoading.total).length,
                  " ",
                )}{" "}
                / {libLoading.total} libraries
              </p>
            </div>
          )}
          <p className="max-w-sm px-6 text-center font-mono text-xs text-white/40">
            Moving the library set into the editor. The first open can take a
            moment — it's cached after this.
          </p>
        </div>
      )}

      {/* Transient post-boot status (e.g. file open). */}
      {ready && status && (
        <div className="pointer-events-none absolute left-3 top-3 z-20 rounded bg-black/70 px-3 py-2 font-mono text-xs text-white">
          {status}
        </div>
      )}

      {/* Follow-user (0008): who we're following + how to stop. Esc also works
          because any canvas key input breaks the follow via noteLocalViewport
          only when the viewport moves — this banner is the explicit out. */}
      {ready && followingTarget && (
        <div
          data-testid="follow-banner"
          className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs text-white shadow-sm ring-1 ring-inset ring-white/20"
        >
          <span>
            Following <span className="font-semibold">{followingTarget.name}</span> — move to stop
          </span>
          <button
            type="button"
            className="rounded-full bg-white/15 px-2 py-0.5 font-medium hover:bg-white/25"
            onClick={() => followRef.current?.unfollow()}
          >
            Stop
          </button>
        </div>
      )}

      {/* Overlay menu (0010): the single draggable circular icon replacing the
          old top-right row. Its badge is the peer count; the panel stacks the
          session sections — roster, source chip, view-only pill, follow row,
          comments (portal slot filled by CommentLayer), chrome toggle. It is
          the one control that stays up in canvas-only (chrome-hidden) mode. */}
      {ready && (
        <OverlayMenu
          badge={peers.length}
          unread={commentsUnread.threads}
          unreadMention={commentsUnread.mentioned}
        >
          {/* PEOPLE — who else is here, and whose view you're locked to. The
              follow state lives on each person's own row (PresenceRoster), so
              there is no separate "Following…" banner to keep in sync. */}
          {peers.length > 0 && (
            <OverlayMenuSection label="People">
              <PresenceRoster
                peers={peers}
                activeSheetPath={activeSheetPath}
                following={followingTarget}
                onFollow={(t) => {
                  if (t) followRef.current?.follow(t);
                  else followRef.current?.unfollow();
                }}
              />
            </OverlayMenuSection>
          )}

          {/* DOCUMENT — where this file came from and whether you may edit it.
              SourceChip is shared with the light project pages, so instead of
              restyling it we ask for its `muted` tone: colour drops to a dot,
              and the chip sits in a normal row like everything else. */}
          {(sourceDescriptor || readOnly) && (
            <OverlayMenuSection label="Document">
              {sourceDescriptor && (
                <div className={`${overlayRowClass} cursor-default`}>
                  <SourceChip descriptor={sourceDescriptor} tone="muted" />
                </div>
              )}
              {readOnly && (
                <div
                  data-testid="view-only-pill"
                  className={`${overlayRowClass} cursor-default`}
                >
                  <EyeOff size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
                  <span>View only</span>
                  <span className="ml-auto text-[10px] text-neutral-400 dark:text-white/40">
                    read-only
                  </span>
                </div>
              )}
            </OverlayMenuSection>
          )}

          {commentsCtl && (
            <OverlayMenuSection label="Comments">
              <div
                data-testid="overlay-menu-comments"
                ref={setCommentsSlot}
                className="flex w-full flex-col items-start gap-2"
              />
            </OverlayMenuSection>
          )}

          <OverlayMenuSection label="View">
            {/* Viewer panels (viewer-panels): canvas-only stand-ins for the
                chrome-hidden wx panes — available to viewers and to editors
                in hide-UI mode alike. */}
            {effectiveChromeHidden && layersMod && (
              <button
                data-testid="layers-panel-toggle"
                aria-pressed={layersOpen}
                className={overlayRowClass}
                title="Board layers — visibility and active layer"
                onClick={() => setLayersOpen(!layersOpen)}
              >
                <Layers size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
                <span>{layersOpen ? "Hide layers" : "Layers"}</span>
              </button>
            )}
            {effectiveChromeHidden && (tool === "pcbnew" || tool === "eeschema") && (
              <button
                data-testid="inspector-panel-toggle"
                aria-pressed={inspectorOpen}
                className={overlayRowClass}
                title="Properties of the selected items"
                onClick={() => setInspectorOpen(!inspectorOpen)}
              >
                <Crosshair size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
                <span>{inspectorOpen ? "Hide inspector" : "Inspector"}</span>
              </button>
            )}
            {setChromeFn !== null && !readOnly && (
              <button
                data-testid="chrome-toggle"
                aria-pressed={chromeHidden}
                className={overlayRowClass}
                title={`${chromeHidden ? "Show" : "Hide"} UI (${CHROME_HOTKEY_LABEL})`}
                onClick={() => toggleChromeHidden()}
              >
                {chromeHidden ? (
                  <PanelsTopLeft size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
                ) : (
                  <EyeOff size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
                )}
                <span>{chromeHidden ? "Show UI" : "Hide UI"}</span>
                <kbd className="ml-auto rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-white/10 dark:text-white/50">
                  {CHROME_HOTKEY_LABEL}
                </kbd>
              </button>
            )}
            {/* Light/dark toggle (comments-ux 0002): flips the shell theme;
                the F4 effect above re-themes the GAL canvas through the
                bridge. Available to viewers too — theming isn't editing. */}
            <button
              data-testid="overlay-theme-toggle"
              aria-pressed={theme === "dark"}
              className={overlayRowClass}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <Sun size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
              ) : (
                <Moon size={14} className="shrink-0 text-neutral-400 dark:text-white/50" />
              )}
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
          </OverlayMenuSection>
        </OverlayMenu>
      )}

      {/* Figma-like comments (0005): GAL pin dots + this DOM layer (hit targets,
          thread popovers, comment mode, panel). The bar + list panel render
          into the overlay menu's comments slot (0010). */}
      {ready && commentsCtl && (
        <CommentLayer
          controller={commentsCtl}
          viewport={viewportState}
          currentUser={presenceUser().id}
          menuSlot={commentsSlot}
          onUnreadChange={onCommentsUnread}
          mentionPeers={peers.map((p) => ({
            slug: p.user.id,
            name: p.user.name || p.user.id,
          }))}
        />
      )}

      {/* Viewer panels (viewer-panels): floating layer selector + selection
          inspector for canvas-only sessions — the React stand-ins for the wx
          Appearance/Properties panes that kicadSetChrome(false) hides. */}
      {ready && effectiveChromeHidden && layersOpen && layersMod && (
        <LayerPanel
          mod={layersMod}
          defaultCollapsed={readOnly}
          onClose={() => setLayersOpen(false)}
        />
      )}
      {ready &&
        effectiveChromeHidden &&
        inspectorOpen &&
        (tool === "pcbnew" || tool === "eeschema") && (
          <SelectionInspector
            doc={panelDoc}
            defaultCollapsed={readOnly}
            onClose={() => setInspectorOpen(false)}
          />
        )}

      {/* DEV: presence style tuner (VITE_PRESENCE_TUNER=1). */}
      {ready && tunerMod && <PresenceTuner mod={tunerMod} tool={tool} />}

      {/* Lib pre-sync warming IDB after the editor opened (big set) — the ONLY
          surface for it now that the warm-up starts post-open: a small unobtrusive
          indicator so the user knows browsing is still filling in behind them,
          never something they are waiting on. */}
      {ready && libSync && (
        <div className="pointer-events-none absolute bottom-9 left-3 z-20 flex items-center gap-2 rounded bg-black/80 px-3 py-1.5 font-mono text-xs text-emerald-200">
          <Loader2 className="animate-spin" size={14} />{" "}
          <span className="whitespace-pre">{libSyncLabel(libSync)}</span>
        </div>
      )}

      {/* Board 3D models still prefetching into the cache (background). */}
      {ready && modelsSync && (
        <div className="pointer-events-none absolute bottom-[4.25rem] left-3 z-20 flex items-center gap-2 rounded bg-black/80 px-3 py-1.5 text-xs text-sky-200">
          <Loader2 className="animate-spin" size={14} /> {modelsSync}
        </div>
      )}

      {/* A library item is being fetched (open/save). */}
      {ready && libBusy && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded bg-black/80 px-3 py-1.5 text-xs text-white">
          <Loader2 className="animate-spin" size={14} /> Loading {libBusy}…
        </div>
      )}

      {/* A save path is durably BLOCKED (CAS conflict / unknown commit state) —
          persistent full-width banner, no auto-dismiss: subsequent Ctrl+S on
          the path is absorbed by the save lane, so this must stay visible. */}
      {saveBlocked && (
        <div
          data-testid="save-blocked-banner"
          className="absolute inset-x-0 top-0 z-40 bg-red-900/95 px-4 py-2 text-center text-xs font-medium text-red-100 shadow-lg"
        >
          {saveBlocked.message}
        </div>
      )}

      {/* Top-center toast column: simultaneous notices stack instead of
          overlapping (they all used to render at the same absolute spot). */}
      <div className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 flex-col items-center gap-2">

      {/* Library error (e.g. a backend 404 on open) — auto-dismisses. */}
      {libError && (
        <button
          className="max-w-md rounded bg-red-950/95 px-3 py-2 text-center text-xs text-red-100 shadow-lg ring-1 ring-red-500/40"
          onClick={() => setLibError(null)}
          title="Dismiss"
        >
          {libError}
        </button>
      )}

      {/* A collaborator updated a symbol PLACED in this document — auto-dismisses. */}
      {libUpdate && (
        <button
          data-testid="lib-update-toast"
          className="max-w-md rounded bg-amber-950/95 px-3 py-2 text-center text-xs text-amber-100 shadow-lg ring-1 ring-amber-500/40"
          onClick={() => setLibUpdate(null)}
          title="Dismiss"
        >
          {libUpdate}
        </button>
      )}

      {/* A peer changed the team's lib set — click loads the new lib live
          (kicadLibsAddEntry bridge), falling back to a reload offer. */}
      {libSetNotice && (
        <button
          data-testid="lib-set-toast"
          className="max-w-md rounded bg-sky-950/95 px-3 py-2 text-center text-xs text-sky-100 shadow-lg ring-1 ring-sky-500/40"
          onClick={() => {
            const notice = libSetNotice;
            if (notice.mode === "reload") {
              window.location.reload();
              return;
            }
            const source = activeLibsSourceRef.current;
            if (!source) {
              setLibSetNotice({ ...notice, mode: "reload", message: reloadFallbackMsg(notice) });
              return;
            }
            setLibSetNotice(null);
            void addAnnouncedLib(source, notice.detail, (m) => console.log(m)).then(
              (ok) => {
                if (!ok) {
                  setLibSetNotice({
                    ...notice,
                    mode: "reload",
                    message: reloadFallbackMsg(notice),
                  });
                }
              },
            );
          }}
          title={libSetNotice.mode === "reload" ? "Reload" : "Load the new library"}
        >
          {libSetNotice.message}
        </button>
      )}

      {/* Backend rolled this doc back to the last valid state (kicad-validity). */}
      {docReverted && (
        <button
          data-testid="doc-reverted-toast"
          className="max-w-md rounded bg-orange-950/95 px-3 py-2 text-center text-xs text-orange-100 shadow-lg ring-1 ring-orange-500/40"
          onClick={() => setDocReverted(null)}
          title="Dismiss"
        >
          {docReverted}
        </button>
      )}

      </div>

      </WasmErrorBoundary>

      {/* Terminal failure — z-35, ABOVE the boot overlay but below the console
          panel, OUTSIDE the error boundary, and independent of `ready`: a
          post-boot runtime death gets a proper blue screen instead of a blank
          page, with the console panel forced open beneath it. */}
      {fatal && (
        <div
          data-testid="fatal-overlay"
          className="absolute inset-0 z-[35] flex flex-col items-center justify-center gap-3 bg-[#1a1a2e] text-white"
        >
          <p className="font-mono text-4xl text-white/90">:(</p>
          <p className="font-mono text-sm text-white">
            This editor instance stopped to protect the document.
          </p>
          <p className="max-w-lg px-6 text-center font-mono text-xs text-blue-100/90">
            {fatal}
          </p>
          <p className="max-w-md px-6 text-center font-mono text-xs text-blue-200/60">
            The console below records what was loading when this happened —
            reload to create a fresh editor from the shared document.
          </p>
          <div className="flex gap-2">
            <button
              className="rounded border border-white/40 px-3 py-1 text-xs hover:bg-white/10"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      )}

      {/* z-40 (above the z-30 boot overlay and the z-35 fatal overlay): when a
          load fails, the log this panel holds is the only account of WHY, so it
          must never end up underneath the thing reporting the failure. Forced
          visible on a fatal even with chrome hidden, for the same reason. */}
      {(!effectiveChromeHidden || fatal) && (
        /* Closed: a content-width tab pinned bottom-left (no right-0), so the
           version badge and the app's bottom edge stay visible/clickable.
           Open: the full-width footer panel. */
        <div
          ref={consolePanelRef}
          className={
            showLog ? "absolute bottom-0 left-0 right-0 z-40" : "absolute bottom-0 left-0 z-40"
          }
        >
          {showLog ? (
            <>
              <div className="flex items-center bg-black/70">
                <button
                  className="flex items-center gap-1 px-3 py-1 font-mono text-xs text-white"
                  onClick={() => setShowLog(false)}
                >
                  <ChevronDown size={14} /> console ({logs.length})
                </button>
                <button
                  className="ml-auto px-3 py-1 font-mono text-xs text-white/70 hover:text-white"
                  onClick={() => {
                    void navigator.clipboard.writeText(logs.join("\n")).then(
                      () => append("[console] copied to clipboard"),
                      () => append("[console] clipboard copy failed"),
                    );
                  }}
                >
                  copy
                </button>
              </div>
              <pre className="max-h-64 select-text cursor-text overflow-auto bg-black/85 p-3 font-mono text-[11px] leading-tight text-green-300">
                {logs.join("\n")}
              </pre>
            </>
          ) : (
            <button
              className="flex items-center gap-1 bg-black/70 px-3 py-1 font-mono text-xs text-white"
              onClick={() => setShowLog(true)}
            >
              <ChevronUp size={14} /> console ({logs.length})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "~173 MB" — coarse on purpose; these are quotes, not meters. */
function approxMB(bytes: number): string {
  const mb = bytes / 1e6;
  return `~${mb >= 10 ? Math.round(mb) : Math.max(0.1, mb).toFixed(1)} MB`;
}

/** "1 library" / "155 libraries". */
function libCount(n: number): string {
  return `${n} librar${n === 1 ? "y" : "ies"}`;
}

/**
 * One consent row's size figure — MB only; the COUNTS live in the row's detail
 * line (libNowDetail/libLaterDetail), because "download" and "check" cover
 * different sets of libs and one number can't stand for both.
 */
function libStateLabel(s: LibsSyncState | null): string | null {
  if (!s || s.total === 0) return null;
  if (s.warm >= s.total) return "already cached";
  // sizesKnown false ⇒ some cold libs carry no published size, so coldBytes is a
  // FLOOR, never the total: say "at least", and quote nothing at all when not a
  // single cold lib was priced.
  if (!s.sizesKnown) {
    return s.coldBytes > 0 ? `at least ${approxMB(s.coldBytes)}` : null;
  }
  return approxMB(s.coldBytes);
}

/**
 * Detail line for the kind this editor PRE-SYNCS at boot. Two different numbers
 * matter here and quoting either alone reads as a lie: only the libs that aren't
 * cached yet download their contents ("1 library"), but the pre-sync walks EVERY
 * library of the kind to see whether it changed — and that walk is what the
 * "Syncing footprint libraries — 99/155" bar counts. A null state (source can't
 * tell) keeps the old count-free wording.
 */
function libNowDetail(s: LibsSyncState | null): string {
  const base = "this editor browses them";
  // No warmth answer at all: say only what stays true regardless of counts —
  // the warm-up runs alongside the editor download and finishes in the
  // background, so "downloaded now" would overpromise as well as vague.
  if (!s || s.total === 0) return `${base} — fetched in the background`;
  const cold = s.total - s.warm;
  if (cold === 0) {
    return `${base} — ${libCount(s.total)} already here, just checked for updates`;
  }
  if (s.warm === 0) return `${base} — downloads ${libCount(s.total)}`;
  return `${base} — downloads ${libCount(cold)}, checks all ${s.total} for updates`;
}

/**
 * Detail line for the OTHER kind of a merged-bundle session: never walked at
 * boot (no pre-sync, no update check) — each lib is fetched lazily the first
 * time a cross-face feature reaches it.
 */
function libLaterDetail(s: LibsSyncState | null): string {
  const base = "downloaded later, only if you use them";
  if (!s || s.total === 0) return base;
  const cold = s.total - s.warm;
  if (cold === 0) return `${libCount(s.total)} already here — nothing to download`;
  return `${base} (${libCount(cold)} not here yet)`;
}

/**
 * The editor bundle's figure. `toolBytes` is the OVER-THE-WIRE (compressed)
 * size, while the load screen's progress bar counts RAW decoded bytes — quoting
 * the first bare is what made "~32 MB" look like a lie next to a ~150 MB bar.
 * Show both whenever the manifest prices them; the HEAD fallback knows only the
 * wire size, so it says just that.
 */
function toolFigure(info: ConsentInfo): React.ReactNode {
  if (info.toolBytes === null) return "large (hundreds of MB)";
  const wire = `${approxMB(info.toolBytes)} compressed`;
  if (info.toolRawBytes === null) return wire;
  return (
    <>
      {wire}
      <br />
      <span className="text-white/50">
        {approxMB(info.toolRawBytes)} uncompressed
      </span>
    </>
  );
}

/**
 * The download-consent card (standalone-load-ux 0001): what's about to be
 * pulled onto this device — the editor bundle now, the tool's lib kind now,
 * the other kind later on demand — and an OK that actually gates the fetches.
 */
function DownloadConsent({
  info,
  onAccept,
}: {
  info: ConsentInfo;
  onAccept: (always: boolean) => void;
}) {
  const [always, setAlways] = React.useState(false);
  const kindTitle = (k: "symbol" | "footprint") =>
    k === "symbol" ? "Symbol libraries" : "Footprint libraries";
  const row = (
    title: string,
    detail: string,
    figure: React.ReactNode,
    testid: string,
  ) => (
    <li
      data-testid={testid}
      className="flex items-baseline gap-3 border-t border-white/10 py-2 first:border-t-0"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white/90">{title}</p>
        <p className="text-xs text-white/50">{detail}</p>
      </div>
      {figure && (
        <span className="whitespace-nowrap text-right font-mono text-xs leading-snug text-white/70">
          {figure}
        </span>
      )}
    </li>
  );
  return (
    <div
      data-testid="download-consent"
      className="flex w-full max-w-md flex-col items-center gap-4 px-6"
    >
      <Download size={32} className="text-white/70" />
      <h2 className="text-base font-semibold">
        {info.update ? "Editor update available" : "One-time download needed"}
      </h2>
      <p className="text-center text-sm text-white/70">
        PCBJam runs KiCad fully in your browser.{" "}
        {info.update
          ? "This release ships a new editor build, so it needs downloading again — it's cached after that."
          : "Opening this tool downloads it once — repeat visits load from your browser's cache."}
      </p>
      <ul className="w-full rounded-lg bg-white/5 px-4 py-1">
        {row(
          "Editor engine",
          "the KiCad build, downloaded now",
          toolFigure(info),
          "consent-row-tool",
        )}
        {info.libNowKind &&
          row(
            kindTitle(info.libNowKind),
            libNowDetail(info.libNow),
            libStateLabel(info.libNow),
            "consent-row-now",
          )}
        {info.libLaterKind &&
          row(
            kindTitle(info.libLaterKind),
            libLaterDetail(info.libLater),
            libStateLabel(info.libLater),
            "consent-row-later",
          )}
      </ul>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-white/60">
        <input
          type="checkbox"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
          className="accent-white/80"
        />
        Always download without asking
      </label>
      <button
        data-testid="consent-accept"
        className="rounded bg-white/90 px-4 py-1.5 text-sm font-medium text-[#1a1a2e] hover:bg-white"
        onClick={() => onAccept(always)}
      >
        Download &amp; open
      </button>
    </div>
  );
}

/**
 * Fixed-width lib pre-sync line, e.g. "Checking symbol libraries —  42/208".
 * "Checking", not "downloading": the walk visits every lib of the kind but
 * downloads only the new/changed ones — a bare counter read as 155 downloads
 * (standalone-load-ux follow-up). The prefix is constant and `done` is
 * space-padded to `total`'s digit count, so the text stays still while the
 * counter ticks (render it in a font-mono + whitespace-pre element so the pad
 * spaces hold their width).
 */
function libSyncLabel(s: { kind: string; done: number; total: number }): string {
  const total = String(s.total);
  const done = String(Math.min(s.done, s.total)).padStart(total.length, " ");
  return `Checking ${s.kind} libraries — ${done}/${total}`;
}

/**
 * WASM download progress for the boot overlay. A determinate bar when the server
 * sent a Content-Length the decoded stream agrees with; otherwise just MB so far
 * (gzip/br makes Content-Length the COMPRESSED size, so `loaded` can pass it).
 */
function DownloadProgress({
  progress,
}: {
  progress: { loaded: number; total: number } | null;
}) {
  if (!progress) return null;
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  const determinate = progress.total > 0 && progress.loaded <= progress.total;
  const pct = determinate
    ? Math.round((progress.loaded / progress.total) * 100)
    : 0;
  return (
    <div className="w-64 max-w-[80vw]">
      {determinate ? (
        <>
          <div className="h-1.5 w-full overflow-hidden rounded bg-white/15">
            <div
              className="h-full rounded bg-white/70 transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-center font-mono text-xs text-white/50">
            {mb(progress.loaded)} / {mb(progress.total)} ({pct}%)
          </p>
        </>
      ) : (
        <p className="text-center font-mono text-xs text-white/50">
          {mb(progress.loaded)} downloaded…
        </p>
      )}
    </div>
  );
}
