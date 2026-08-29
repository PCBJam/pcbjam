import * as React from "react";
import {
  commentAuthorColors,
  FILELESS_TOOLS,
  fileToDoc,
  projectPath,
  syncLayoutToY,
  type Tool,
} from "@pcbjam/shared";
import { Download } from "lucide-react";
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
import { redirectTargetFor } from "@/lib/redirect";
import { loadSessionIdentity, seedSessionIdentity } from "@/lib/session-identity";
import { useThemeValue } from "@/lib/theme";
import { bootKicadTool } from "@/wasm/boot";
import {
  autoDownloadEnabled,
  isWasmDownloaded,
  markWasmDownloaded,
  resolveWasmMeta,
} from "@/wasm/wasm-assets";
import {
  type LibsSource,
} from "@/wasm/libs/source";

import { TOOL_FRAME } from "@/wasm/constants";
import {
  driveProjectIntoTool,
  readStagedFile,
  restageFile,
  usedLibNicknames,
  type ToolFile,
} from "@/wasm/kicad-runner";
import { startFilesWatch, type FilesWatchHandle } from "@/wasm/collab/files-watch";
import { dump as dumpTrace, mark } from "@/wasm/load-trace";
import { errorMessage, isTerminalError } from "@/wasm/terminal-error";
import { registerSaveHook, type SaveBlock, type SaveBytes } from "@/wasm/save-flow";
import type {
  KicadCollabHandle,
  KicadDocSession,
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
  createComments,
  hasCommentsBridge,
  type CommentsController,
  type ViewportState,
} from "@/wasm/collab/comments";
import { PresenceRoster } from "@/components/PresenceRoster";
import { CommentLayer } from "@/components/CommentLayer";
import { hasTunerBridge, PresenceTuner, type TunerModule } from "@/components/PresenceTuner";
import { hasLayersBridge, LayerPanel, type LayersModule } from "@/components/LayerPanel";
import { SelectionInspector } from "@/components/SelectionInspector";
import { bindLocalSelectionFeed } from "@/wasm/collab/local-selection";
import {
  type SheetCollabManager,
} from "@/wasm/collab/sheet-manager";
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
import { WasmErrorBoundary } from "@/components/wasm-tool/WasmErrorBoundary";
import { BootOverlay } from "@/components/wasm-tool/BootOverlay";
import { ConsolePanel } from "@/components/wasm-tool/ConsolePanel";
import { FatalOverlay } from "@/components/wasm-tool/FatalOverlay";
import { LibLoadingOverlay } from "@/components/wasm-tool/LibLoadingOverlay";
import { NoticeStack } from "@/components/wasm-tool/NoticeStack";
import { FollowBanner, SessionMenu } from "@/components/wasm-tool/SessionMenu";
import { useLibNotices } from "@/components/wasm-tool/useLibNotices";
import {
  gatherConsentInfo,
  type ConsentInfo,
} from "@/components/wasm-tool/DownloadConsent";
import {
  maybeConnectDocSession,
  maybeStartCollab,
  startSheetCollab,
  waitForWxUi,
} from "@/components/wasm-tool/collab-start";
import { installQuitHook } from "@/components/wasm-tool/quit-hook";
import { runDeferredModelPrescan } from "@/wasm/libs/models-bridge";
import { installToolNavigationHook } from "@/components/wasm-tool/tool-navigation";
import {
  chromeSetter,
  show3DOpener,
  COLLAB_TOOLS,
  INSPECTOR_OPEN_KEY,
  LAYERS_OPEN_KEY,
  LIB_KIND_FOR_TOOL,
} from "@/components/wasm-tool/ui-helpers";

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
  onStagedRevision,
  observedRevision,
  rememberObservedRevision,
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
   * Files staged from the project sync namespace bundle never pass through
   * `fetchBytes`; this reports their listing revision so the source can record
   * the CAS ancestry `saveBytes` must publish against (see DriveOptions).
   */
  onStagedRevision?: (relPath: string, revision: number) => void;
  /**
   * Files-route change hints (project-sync 0002): the latest server revision
   * this client observed for a path (its own PUT ack — the echo check) and
   * the recorder for revisions learned from a peer's hint. Absent ⇒ hints
   * still restage siblings but every hint stamped with our user is treated
   * as a peer's (no echo suppression).
   */
  observedRevision?: (relPath: string) => number | undefined;
  rememberObservedRevision?: (relPath: string, revision: number) => void;
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
  const filesWatchRef = React.useRef<FilesWatchHandle | null>(null);
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
  // The one libs source instance the running editor uses (set by the boot
  // effect) — the libset toast's action needs it to re-list and load.
  const activeLibsSourceRef = React.useRef<LibsSource | null>(null);
  // Every library / document notice (toasts, stale-lib state, load badges) —
  // state + listeners in useLibNotices, rendered by NoticeStack / SessionMenu
  // / LibLoadingOverlay below.
  const notices = useLibNotices({ getLibsSource: () => activeLibsSourceRef.current });
  // A save path entered the DURABLE blocked state (409 conflict / unknown
  // commit state — save-flow's absorbing blockedPaths). Rendered as a
  // persistent banner, never auto-dismissed: further Ctrl+S on the path is
  // silently absorbed, so without this surface the user would keep "saving"
  // into the void.
  const [saveBlocked, setSaveBlocked] = React.useState<SaveBlock | null>(null);
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
    filesWatchRef.current?.destroy();
    filesWatchRef.current = null;
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
    return () => {
      window.Worker = NativeWorker;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [append]);

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
          // Viewers can't write: skip the boot-time default-lib create (a
          // session-gated POST that 401s anonymously and used to blank the
          // lib tables — anonymous public-schematic open on staging).
          readOnly,
        });
        // Identity must be settled before the doc session / presence binds
        // below — effectively instant, it raced the multi-second wasm boot.
        await identityReady;
        // Register the save sink before the file opens: from here on, every
        // editor File→Save (MEMFS write) is routed onward through saveBytes.
        // Read-only sessions register neither upload nor the save-driven room
        // writers (onSaved onboarding, onSavedText layout sync) — saves, were
        // any reachable past the wasm lock, stay MEMFS-only.
        // Room-backed files (ydoc/live in the boot listing) never upload on
        // save in ydoc mode: the room owns their state (save-flow uploadPolicy).
        // A file created this session, or one whose room is first seeded now,
        // has no ydoc row yet and still uploads — that is the registration +
        // first fallback copy the backend file list needs.
        const roomBacked = new Set(
          docSource === "ydoc"
            ? files.filter((f) => f.hasYdoc || f.isLive).map((f) => f.path)
            : [],
        );
        const saveHookHandle = registerSaveHook(win, {
          slug,
          saveBytes: readOnly ? undefined : saveBytes,
          uploadPolicy: (relPath) => (roomBacked.has(relPath) ? "room" : "upload"),
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
                      syncLayoutToY(fileToDoc(text), collabDocRef.current, "layout-save");
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
          // Viewers fetch 3D bodies only if they open the viewer (session menu).
          deferModelPrescan: readOnly,
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
          onStagedRevision,
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
        // Files-route change hints (project-sync 0002 §3): peers' PUT-channel
        // writes (.kicad_pro after assign-footprints, uploads, job resaves)
        // restage into MEMFS; a hint for the open non-room target becomes a
        // reload/conflict notice. Rides the same gateway socket as presence.
        if ((tool === "pcbnew" || tool === "eeschema") && !readOnly && !collabOptOut) {
          void startFilesWatch({
            scopeId,
            projectId,
            provider: yjsProviderConfig(),
            targetPath,
            selfUser: presenceUser().id,
            knownPaths: files.map((f) => f.path),
            isRoomBacked: (p) => roomBacked.has(p),
            observedRevision: (p) => observedRevision?.(p),
            rememberObserved: (p, r) => rememberObservedRevision?.(p, r),
            fetchBytes,
            restage: (p, bytes) => restageFile(win, slug, p, bytes, append),
            onNewPath: (p) => {
              if (p.endsWith(".kicad_sch")) void sheetManagerRef.current?.onboard(p);
            },
            // A cold room replaced at rest (re-upload / resave install, 0004
            // §2.5): a parked sheet doc must not carry the old epoch.
            onRoomBackedChanged: (p) => sheetManagerRef.current?.invalidate(p),
            onTargetChanged: (c) => {
              const who = c.by ?? "a collaborator";
              setStatus(
                `${c.path} was updated by ${who} (rev ${c.revision}) — reload to see it; your next save will report a conflict`,
              );
            },
            onListingStale: () => append("[files] hint gap — project listing is stale until reload"),
            log: append,
          }).then((handle) => {
            if (!handle) return;
            if (disposedRef.current) handle.destroy();
            else filesWatchRef.current = handle;
          });
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
        // Read-only sessions carry no editable libs (the boot payload is
        // model3d-only for them) and may not open the team's scope room —
        // skip the socket rather than collect a 401.
        if (targetPath && source?.enableRealtime && !readOnly) {
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

  // kicadShow3DViewer — the session-menu 3D entry (read-only-viewer / hide-UI
  // have no wx View menu). Runs the deferred model prescan first so a viewer's
  // first open resolves its refs from MEMFS instead of one C++ ensure each.
  const show3DFn = React.useMemo(() => {
    if (!ready || tool !== "pcbnew") return null;
    const open = show3DOpener(window);
    if (!open) return null;
    return () => {
      void runDeferredModelPrescan()
        .catch((e) => append(`[3d] deferred prescan failed: ${String(e)}`))
        .then(() => {
          if (!open()) append("[3d] kicadShow3DViewer: no board frame");
        });
    };
  }, [ready, tool, append]);

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

      {!ready && (
        <BootOverlay
          status={status}
          consent={consent}
          onConsentAccept={() => consentResolveRef.current?.(true)}
          progress={progress}
          fileSync={fileSync}
          libSync={libSync}
          warmBoot={warmBoot}
          slow={slow}
        />
      )}

      {ready && notices.libLoading && <LibLoadingOverlay libLoading={notices.libLoading} />}

      {/* Transient post-boot status (e.g. file open). */}
      {ready && status && (
        <div className="pointer-events-none absolute left-3 top-3 z-20 rounded bg-black/70 px-3 py-2 font-mono text-xs text-white">
          {status}
        </div>
      )}

      {ready && followingTarget && (
        <FollowBanner target={followingTarget} onStop={() => followRef.current?.unfollow()} />
      )}

      {/* Session menu (0010): the draggable FAB + its sections. */}
      {ready && (
        <SessionMenu
          tool={tool}
          readOnly={readOnly}
          theme={theme}
          peers={peers}
          activeSheetPath={activeSheetPath}
          followingTarget={followingTarget}
          onFollow={(t) => {
            if (t) followRef.current?.follow(t);
            else followRef.current?.unfollow();
          }}
          sourceDescriptor={sourceDescriptor}
          staleLibItems={notices.staleLibItems}
          staleUpdating={notices.staleUpdating}
          onUpdateStale={() => void notices.updateStaleFromLibrary()}
          onDismissStale={() => notices.clearStale()}
          commentsUnread={commentsUnread}
          hasComments={commentsCtl !== null}
          setCommentsSlot={setCommentsSlot}
          effectiveChromeHidden={effectiveChromeHidden}
          hasLayers={layersMod !== null}
          layersOpen={layersOpen}
          setLayersOpen={setLayersOpen}
          inspectorOpen={inspectorOpen}
          setInspectorOpen={setInspectorOpen}
          canToggleChrome={setChromeFn !== null}
          chromeHidden={chromeHidden}
          onToggleChrome={() => toggleChromeHidden()}
          onShow3D={show3DFn}
        />
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

      <NoticeStack
        ready={ready}
        libSync={libSync}
        modelsSync={notices.modelsSync}
        libBusy={notices.libBusy}
        saveBlocked={saveBlocked}
        libError={notices.libError}
        onDismissLibError={notices.dismissLibError}
        libUpdate={notices.libUpdate}
        onDismissLibUpdate={notices.dismissLibUpdate}
        libSetNotice={notices.libSetNotice}
        onLibSetClick={notices.onLibSetClick}
        docReverted={notices.docReverted}
        onDismissDocReverted={notices.dismissDocReverted}
      />

      </WasmErrorBoundary>

      {fatal && <FatalOverlay message={fatal} />}

      {/* The log console (z-40, above boot + fatal overlays) — forced visible
          on a fatal even with chrome hidden: the log is the only account of
          WHY a load failed. */}
      {(!effectiveChromeHidden || fatal) && (
        <ConsolePanel ref={consolePanelRef} logs={logs} open={showLog} setOpen={setShowLog} append={append} />
      )}
    </div>
  );
}

/** "~173 MB" — coarse on purpose; these are quotes, not meters. */