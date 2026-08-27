import type { Tool } from "@pcbjam/shared";
import {
  KICAD_CONFIG_DIR,
  MODELS_3D_ENV_VARS,
  MODELS_3D_ROOT,
  RESOURCE_PATH,
  TOOL_ARGV0,
  TOOL_BUNDLE,
  TOOL_LIB_KIND,
  TOOL_NEEDS_CONFIG_SEED,
  type Bundle,
} from "./constants";
import { installModel3dHandler } from "./libs/models-bridge";
import type { Model3dSource } from "./libs/models-source";
import { installNgspiceService } from "./ngspice-service";
import { installOccService } from "./occ-service";
import {
  buildFpLibTable,
  buildSymLibTable,
  installLibsProvider,
  type LibInfo,
  type LibsSource,
} from "./libs/source";
import { libUri, PCBJAM_LIB_MOUNT } from "./libs/uri";
import { installTouchGestures } from "./touch-gestures";
import { currentTheme } from "@/lib/theme";
import pcbjamDarkTheme from "./themes/pcbjam-dark.json";

/** The default user lib boot ensures exists, so there's a writable save target. */
const DEFAULT_USER_LIB_NAME = "My Symbols";

/**
 * True when any per-kind lib list already contains a writable lib — "user" on
 * the example backend / local sources, "org" on the private platform (a scope's
 * own writable lib; renamed from "user" in the team-libs rework). Missing "org"
 * here made boot re-create "My Symbols" on every load, which the backend 409'd.
 */
export function hasWritableLib(lists: Iterable<LibInfo[]>): boolean {
  return [...lists].some((libs) =>
    libs.some((l) => l.type === "user" || l.type === "org"),
  );
}

/**
 * Boot a KiCad tool directly in the main React document — no iframe.
 *
 * This is a faithful port of the proven harness HTML (tests/apps/kicad/<tool>.html):
 * it builds the same global `Module` config, runs the same preRun steps (create
 * canvas, write images.tar.gz, seed config), then injects `wx.js`, `wx-dom.js`,
 * and `<tool>.js`. The KiCad WASM build is NON-modularized, so it reads a global
 * `var Module` and publishes `FS`/`wxElementRegistry` onto `window` — exactly the
 * surface the iframe approach used, only now in the top-level window.
 *
 * Running in the main document (rather than at /wasm/...) works without touching
 * the build because `locateFile` is overridden to resolve `<base>/<file>`, so
 * the .wasm and other assets are fetched from the asset dir regardless of the
 * SPA route the user is on. Pthread child workers spawn from `_scriptName`
 * (the glue's own absolute URL, captured when `<tool>.js` executes), so a
 * same-origin asset base just works. KNOWN GAP: a cross-origin (CDN) base
 * cannot spawn the pthread workers — `new Worker(<cross-origin URL>)` is a
 * SecurityError, and emscripten 6 ignores `mainScriptUrlOrBlob` — see
 * docs/features/async/23-jspi-runtime.md.
 *
 * Single-instance: the build owns process-global state (one `Module`, one wasm
 * memory) so only ONE tool can run per page load. A second boot — switching
 * tools, or a stray double-mount — is rejected; switching tools requires a full
 * page navigation (which gives a fresh global scope, same as loading a new HTML).
 */
export interface BootOptions {
  tool: Tool;
  /** Asset base (no trailing slash) where wx.js / <tool>.{js,wasm} / images.tar.gz live. */
  base: string;
  /** Full-screen element that will host the Emscripten <canvas>. */
  container: HTMLElement;
  log: (msg: string) => void;
  onStatus: (text: string) => void;
  /** OOM recovery hook (feature 0002): emscripten `abort()` routes here so a
   *  soft OOM can respawn a fresh tab. Optional — boot works without it. */
  onAbort?: (what: string) => void;
  /** Download progress for the (large) `.wasm`, so the loading overlay can show a
   *  real bar. `total` is 0 when the server sends no usable Content-Length (or it
   *  disagrees with the decoded stream under gzip/br) — then show bytes, not a %. */
  onProgress?: (loaded: number, total: number) => void;
  /** RAW (decoded) `.wasm` byte count from the release manifest (schema 2), when
   *  known. The progress stream counts DECODED bytes, so this — unlike a
   *  compressed Content-Length — is the correct bar total. */
  expectedWasmBytes?: number | null;
  /** The download-completion marker was this bundle's — a previous load finished
   *  downloading it, so the fetch should ride the HTTP cache. Only flips the
   *  status label ("Loading" vs "Downloading"); the mechanics are identical. */
  warmStart?: boolean;
  /** The `.wasm` finished downloading AND instantiated — the moment the
   *  download-completion marker is safe to record (a truncated/failed stream
   *  never gets here). */
  onWasmInstantiated?: () => void;
  /** Library source backing `window.kicadLibs`. Null/omitted disables libs
   *  (empty lib-tables are seeded). Its libs become sym-lib-table and/or
   *  fp-lib-table rows depending on the tool (see `libKinds` in doBoot). */
  libsSource?: LibsSource | null;
  /** Hold provider enumerates for a kind until this resolves — the lib editors
   *  pass their presync-settled promise so the boot-time whole-set hydrate
   *  reads a warm IndexedDB instead of cold-fetching one lib at a time inside
   *  the serialized bridge crossings. See `LibsProviderOptions.enumerateGate`.
   *  Never gates boot's own `listLibs` table seeding (a direct source call). */
  enumerateGate?: (kind: string) => Promise<void>;
  /** 3D model source (lazy, per-board). Null/omitted ⇒ the viewer renders the
   *  bare board only, exactly as before models existed. */
  modelsSource?: Model3dSource | null;
  /** Editor frame to open when the bundle serves more than one (e.g. `"fpedit"`
   *  so the pcbnew bundle opens the Footprint Editor). Passed through as
   *  `--frame=<token>` in `Module.arguments`; parsed in single_top.cpp. Omitted
   *  ⇒ the bundle's build-time default frame. See `TOOL_FRAME` in constants.ts. */
  frame?: string;
  /** Mobile device (features/mobile): install the touch-gesture shim
   *  (pinch-zoom / one-finger pan / tap-select) on the input canvas. Gestures
   *  only — chrome visibility is owned by the shell's chrome-visibility store
   *  (WasmTool applies it via kicadSetChrome). */
  mobile?: boolean;
}

let booted: { tool: Tool; promise: Promise<void> } | null = null;

/**
 * Inject and start the tool's WASM into `window`. Resolves once the glue scripts
 * are loaded (runtime init continues asynchronously afterwards — callers that
 * need the filesystem should wait on `window.FS`, as driveProjectIntoTool does).
 */
export function bootKicadTool(opts: BootOptions): Promise<void> {
  if (booted) {
    if (booted.tool === opts.tool) return booted.promise;
    return Promise.reject(
      new Error(
        `KiCad "${booted.tool}" is already running in this page; its WASM runtime ` +
          `is process-global and cannot be torn down. Reload the page to open ` +
          `"${opts.tool}".`,
      ),
    );
  }
  const promise = doBoot(opts);
  booted = { tool: opts.tool, promise };
  return promise;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    // currentScript.src (absolute) is what Emscripten captures as `_scriptName`
    // and uses to derive the script dir + the pthread worker URL.
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load script: ${src}`));
    document.body.appendChild(s);
  });
}

/**
 * The pthread worker-script substitute consumed by
 * {@link installPthreadWorkerRedirect} (formerly the dormant
 * `mainScriptUrlOrBlob` plumbing — emscripten 6 dropped that option, closing
 * the doc-23 §7 KNOWN GAP required this instead): a SAME-ORIGIN `blob:`
 * worker that `importScripts()` the cross-origin glue.
 * `new Worker(<cross-origin URL>)` is a SecurityError, but a `blob:` URL
 * inherits the page origin (legal), and a classic worker's `importScripts` MAY
 * load a cross-origin script when the CDN sends
 * `Cross-Origin-Resource-Policy: cross-origin` (needed because the page is
 * COEP `require-corp`). The `.wasm`/`images.tar.gz` fetches just need
 * `ACAO` + `CORP` on the CDN. See docs/features/demo-deploy/0001-*.
 */
/**
 * C++ diagnostics that must reach the BROWSER console, not just the in-page log.
 *
 * Module.print normally feeds only the in-page buffer (capped at 800 lines, and
 * echoed to the console only under ?trace=). That is right for ordinary wasm
 * chatter, but wrong for these: production crash reports reach us as saved
 * browser-console dumps, so a diagnostic that never leaves the page is invisible
 * in the one artifact we actually receive — and it can be evicted from the
 * capped buffer by a long load before anyone reads it.
 *
 * Deliberately narrow. Both emitters are rate-limited in C++ and silent on a
 * healthy load (see wxwidgets src/wasm/{evtloop,timer}.cpp), so this cannot
 * become noise.
 */
function isWasmDiagnostic(line: string): boolean {
  return line.startsWith("[wx-dispatch]") || line.startsWith("[wx-timer]");
}

export function pthreadWorkerScript(
  base: string,
  bundle: Bundle,
  traceMask?: string | null,
): string | Blob {
  const abs = new URL(`${base}/${bundle}.js`, window.location.href);
  // ?trace=<mask>: seed `self.__KICAD_TRACE__` in EVERY pthread worker's scope
  // before it importScripts the glue. With PROXY_TO_PTHREAD the C main()/UI (and
  // thus TRACE_MANAGER) run on a pthread, so the trace env must be set in the
  // worker realm, not just the page's Module.ENV. The glue's ENV-merge shim
  // reads __KICAD_TRACE__ into ENV -> environ -> getenv("KICAD_TRACE").
  if (traceMask) {
    return new Blob(
      [
        `self.__KICAD_TRACE__=${JSON.stringify(traceMask)};`,
        `importScripts(${JSON.stringify(abs.href)});`,
      ],
      { type: "text/javascript" },
    );
  }
  if (abs.origin === window.location.origin) return `${base}/${bundle}.js`;
  return new Blob([`importScripts(${JSON.stringify(abs.href)});`], {
    type: "text/javascript",
  });
}

let workerRedirectInstalled = false;

/** Test-only: clear the install latch (one boot per page in production). */
export function resetWorkerRedirectForTest(): void {
  workerRedirectInstalled = false;
}

/**
 * Cross-origin (CDN) pthread spawn fix — closes the doc-23 §7 KNOWN GAP that
 * broke the editor wherever the wasm is CDN-served (staging/prod platform):
 * emscripten 6 spawns every pthread worker from `_scriptName` (the glue's
 * absolute URL, captured at script execution) and offers no override, and
 * `new Worker(<cross-origin URL>)` is a SecurityError — observed as the tool
 * dying right after instantiation with zero pthreads spawned.
 *
 * The runtime gives us no hook, so take the one seam that exists: wrap
 * `window.Worker` and redirect EXACTLY the glue-URL construction to the
 * same-origin substitute from {@link pthreadWorkerScript}. Everything else
 * (ngspice/occ service workers, third-party code) passes through untouched.
 * Also the only way `?trace=` reaches pthread realms (the blob seeds
 * `__KICAD_TRACE__` before importScripts), so it installs for the trace case
 * even same-origin. One boot per page (see `booted`), so never uninstalled.
 */
export function installPthreadWorkerRedirect(
  base: string,
  bundle: Bundle,
  traceMask?: string | null,
): void {
  const glueHref = new URL(`${base}/${bundle}.js`, window.location.href).href;
  const crossOrigin = new URL(glueHref).origin !== window.location.origin;
  if ((!crossOrigin && !traceMask) || workerRedirectInstalled) return;
  workerRedirectInstalled = true;
  const script = pthreadWorkerScript(base, bundle, traceMask);
  const substitute =
    typeof script === "string" ? script : URL.createObjectURL(script);
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, {
    construct(target, args: [string | URL, WorkerOptions?]) {
      let href: string;
      try {
        href = new URL(String(args[0]), window.location.href).href;
      } catch {
        href = String(args[0]);
      }
      return new target(href === glueHref ? substitute : args[0], args[1]);
    },
  });
}

/**
 * Fetch the tool's `.wasm` ourselves so we can report download progress (the big,
 * slow asset — 175–338 MB). Emscripten otherwise fetches it internally with no
 * hook. We wrap the body in a byte-counting stream and return a fresh `Response`,
 * so `WebAssembly.instantiateStreaming` still compiles AS IT DOWNLOADS — no full
 * buffer, no extra peak memory (which would risk the very OOM we recover from).
 *
 * `Content-Length` is the COMPRESSED size when the CDN gzip/br-encodes the wasm,
 * while the stream yields DECODED bytes — so `loaded` can exceed `total`. The
 * caller treats `total` as unknown in that case and shows MB rather than a %.
 * A manifest-provided `expectedBytes` (the RAW size, schema 2) wins over
 * Content-Length: it's in the same units the stream counts.
 *
 * `onDone` fires when the LAST byte has arrived (the compile tail is still
 * running inside instantiateStreaming) — the boot flips the status to
 * "Compiling…" there so the post-download freeze reads truthfully.
 */
/** How much of the wasm head gets hashed for the provenance line. */
const WASM_HASH_PREFIX_BYTES = 128 * 1024;

async function fetchWasmWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  expectedBytes?: number | null,
  onDone?: () => void,
  onProvenance?: (line: string) => void,
): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  if (!res.body || !onProgress) return res;
  const total = expectedBytes || Number(res.headers.get("content-length")) || 0;
  // Provenance: identify the bytes we ACTUALLY instantiate, so a saved log
  // proves which build was under test (crash-hunt sessions have burned real
  // time on "was that even the new wasm?"). The CDN ETag is free; the SHA-256
  // of the first 128 KiB is computed from the same chunks the counter already
  // sees — no second download, no full buffering. Prefix + length identifies
  // a build as well as a full hash here (the CDN publishes content-addressed
  // immutable version dirs).
  const etag = res.headers.get("etag") ?? "none";
  const prefix = new Uint8Array(WASM_HASH_PREFIX_BYTES);
  let prefixFill = 0;
  let provenanceSent = false;
  const emitProvenance = (streamedBytes: number) => {
    if (provenanceSent || !onProvenance) return;
    provenanceSent = true;
    void crypto.subtle
      .digest("SHA-256", prefix.subarray(0, prefixFill))
      .then((d) => {
        const hex = [...new Uint8Array(d).slice(0, 12)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        onProvenance(
          `[build] wasm ${url.split("/").slice(-3).join("/")} etag=${etag} ` +
            `head128k-sha256=${hex} streamed=${streamedBytes}B`,
        );
      })
      .catch(() => onProvenance(`[build] wasm ${url} etag=${etag} (hash unavailable)`));
  };
  let loaded = 0;
  const reader = res.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        emitProvenance(loaded); // short files: prefix may be < 128 KiB
        onDone?.();
        controller.close();
        return;
      }
      loaded += value.byteLength;
      if (prefixFill < WASM_HASH_PREFIX_BYTES) {
        const take = Math.min(value.byteLength, WASM_HASH_PREFIX_BYTES - prefixFill);
        prefix.set(value.subarray(0, take), prefixFill);
        prefixFill += take;
        // Emit as soon as the prefix is complete: the identity line must land
        // in the log EARLY, so it exists even when the load dies later.
        if (prefixFill >= WASM_HASH_PREFIX_BYTES) emitProvenance(total || loaded);
      }
      onProgress(loaded, total);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  // Preserve content-type (application/wasm) so instantiateStreaming accepts it.
  return new Response(stream, { headers: res.headers });
}

async function doBoot(opts: BootOptions): Promise<void> {
  const {
    tool,
    base,
    container,
    log,
    onStatus,
    onAbort,
    onProgress,
    expectedWasmBytes,
    warmStart,
    onWasmInstantiated,
    libsSource,
    modelsSource,
    enumerateGate,
  } = opts;
  // Truthful fetch label: a warm start (download-completion marker present)
  // reads from the HTTP cache, so "Downloading" would be a lie — and vice versa.
  const fetchLabel = warmStart ? "Loading the editor…" : "Downloading the editor…";
  // The deployed bundle backing this tool. footprint_editor/symbol_editor share
  // the pcbnew/eeschema engine, so their `.wasm`/`.js`/pthread-worker files are the
  // parent's; `tool` still drives identity (thisProgram), config-seed and lib-kind.
  const bundle = TOOL_BUNDLE[tool];
  const w = window as ToolWindow;

  // The wasm reads the top-level frame geometry from a GLOBAL `mainWindow`
  // (mainWindow.offsetWidth/offsetHeight/offsetTop — see <tool>.js). The harness
  // HTML defines it as `var mainWindow = document.getElementById('main-window')`;
  // we must do the same or the wasm falls back to a hardcoded 1280x720 frame that
  // mismatches the viewport, breaking the whole AUI layout (toolbars/panels).
  (w as unknown as { mainWindow: HTMLElement }).mainWindow = container;

  // Dev/diagnostics: ?trace=<KICAD_TRACE mask> turns on a KiCad trace channel for
  // this boot (e.g. ?trace=KI_TRACE_SYM_CHOOSER for symbol-chooser timing). Set on
  // the page's Module.ENV (main thread). Under PROXY_TO_PTHREAD the app/UI thread
  // is a pthread, but `environ_get` on a pthread proxies to the MAIN thread — so
  // the main thread's ENV is what `getenv("KICAD_TRACE")` reads. The build's
  // patch-env-shim.mjs makes the glue merge Module.ENV into that ENV (emscripten's
  // glue otherwise ignores Module.ENV); the per-worker seed below is a harmless
  // belt-and-suspenders. See docs/features/libs/0013.
  const traceMask = new URLSearchParams(window.location.search).get("trace");

  // libs: install the provider (must exist before any plugin call can suspend
  // on it) and generate the sym-lib-table from the source's libs — both before
  // the wasm boots (the table is seeded in preRun below). No source → empty
  // table, libs disabled.
  let symLibTable = "(sym_lib_table\n  (version 7)\n)\n";
  let fpLibTable = "(fp_lib_table\n  (version 7)\n)\n";
  // Every lib gets an empty placeholder FILE at its URI (not just the mount dir):
  // the editor save path stat()s the lib file after a successful save
  // (symbol: SetSymModificationTime; footprint: setFPWatcher -> GetModificationTime),
  // which errors on a non-existent path. The bytes are virtual (served via
  // window.kicadLibs); this file only satisfies incidental fs checks.
  let libPlaceholderUris: string[] = [];
  // Which lib tables to seed. The merged kicad_editor bundle serves all four
  // editors AND cross-face features — the symbol chooser's footprint selector/
  // preview reach FACE_PCB from a schematic session — so it gets BOTH tables
  // regardless of frame. Library loading is lazy (enumerate is a no-op; bodies
  // load on demand), so the extra table costs nothing until a feature reads it.
  // Single-engine tools keep their one kind (TOOL_LIB_KIND).
  const libKind = TOOL_LIB_KIND[tool];
  const libKinds: ReadonlyArray<"symbol" | "footprint"> =
    bundle === "kicad_editor" ? ["symbol", "footprint"] : libKind ? [libKind] : [];

  // OCC service (STEP export + STEP/IGES model parsing): install whenever the
  // merged editor bundle boots — a PCB frame can open from ANY session (e.g.
  // eeschema → cross-face into pcbnew), and the install is a synchronous global
  // set; the worker itself is only fetched lazily on first use.
  if (bundle === "kicad_editor") {
    installOccService(log);
    // ngspice service (eeschema simulator): same lazy pattern — synchronous
    // provider install here, worker fetched on first Inspect → Simulator.
    installNgspiceService(log);
  }

  if (libsSource && libKinds.length) {
    installLibsProvider(libsSource, log, { enumerateGate });
    // 3D models ride the same provider (kind "model3d"): the C++ ensure fallback
    // and the board prescan both resolve through this source.
    if (modelsSource) {
      installModel3dHandler(modelsSource, log);
      log("[3d] model source installed");
    }
    try {
      // One list per kind (origins are filtered to that kind; user libs are
      // kind-agnostic containers and appear in every list).
      const listsByKind = new Map<"symbol" | "footprint", LibInfo[]>();
      for (const k of libKinds) listsByKind.set(k, await libsSource.listLibs(k));
      // Ensure the owner has at least one writable lib to save items into.
      // A writable lib holds either kind, so the created lib joins every table.
      if (libsSource.createLib && !hasWritableLib(listsByKind.values())) {
        const created = await libsSource.createLib(DEFAULT_USER_LIB_NAME);
        if (created) {
          for (const libs of listsByKind.values()) libs.push(created);
          log(`[libs] created default user lib "${created.name}"`);
        }
      }
      const symList = listsByKind.get("symbol");
      const fpList = listsByKind.get("footprint");
      if (symList) {
        symLibTable = buildSymLibTable(symList);
        log(`[libs] seeded ${symList.length} lib(s) into sym-lib-table`);
      }
      if (fpList) {
        fpLibTable = buildFpLibTable(fpList);
        log(`[libs] seeded ${fpList.length} lib(s) into fp-lib-table`);
      }
      libPlaceholderUris = [
        ...new Set(
          [...listsByKind.values()].flat().map((l) => libUri(l.id)),
        ),
      ];
    } catch (e) {
      log(`[libs] listLibs failed, seeding empty table: ${String(e)}`);
    }
  }

  onStatus(fetchLabel);

  // Prefetch images.tar.gz in parallel with the (much larger) wasm download —
  // exactly as the harness does. writeResources (in preRun) writes it once ready.
  let resourceData: Uint8Array | null = null;
  void fetch(`${base}/images.tar.gz`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      resourceData = new Uint8Array(buf);
      log(`[boot] prefetched images.tar.gz (${resourceData.length} bytes)`);
    })
    .catch((err) => log(`[boot] images.tar.gz prefetch failed: ${String(err)}`));

  // Use the GLOBAL `FS` (window.FS), exactly as the harness HTML does. This build
  // does NOT export `Module.FS` (touching it aborts: "'FS' was not exported"), but
  // the non-modularized glue declares `var FS` at global scope, so window.FS is
  // live from script-eval time — before preRun runs.
  const moduleFS = (): EmscriptenFS => {
    const FS = w.FS;
    if (!FS) throw new Error("global FS not available in preRun");
    return FS;
  };

  // preRun: create the canvas the tool renders into and mount it in our container.
  const createCanvas = () => {
    const canvas = w.document.createElement("canvas");
    canvas.id = "canvas";
    canvas.style.display = "none";
    // wx.js owns the backing-store size via setWindowRect(); we set only CSS size.
    const width = w.innerWidth;
    const height = w.innerHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.oncontextmenu = (e) => e.preventDefault();
    canvas.addEventListener(
      "webglcontextlost",
      (e) => {
        onStatus("WebGL context lost — reload the page.");
        e.preventDefault();
      },
      false,
    );
    container.appendChild(canvas);
    (w.Module as { canvas: HTMLCanvasElement }).canvas = canvas;
    if (opts.mobile) {
      // Mobile gestures (features/mobile). Installed HERE (preRun) on purpose:
      // the shim's listeners must be registered before the wasm app's own touch
      // callbacks so it can suppress the wx single-finger→LEFT-drag mapping.
      installTouchGestures(canvas);
      log("[boot] mobile: touch gestures installed");
    }
    log(`[boot] canvas created ${width}x${height}`);
  };

  // preRun: write the compiled-in KICAD_DATA resources (icons, etc.).
  const writeResources = () => {
    const FS = moduleFS();
    FS.mkdirTree(RESOURCE_PATH);
    if (resourceData) {
      FS.writeFile(`${RESOURCE_PATH}/images.tar.gz`, resourceData);
      log(`[boot] wrote images.tar.gz to ${RESOURCE_PATH}`);
    } else {
      log("[boot] images.tar.gz not ready at preRun (wasm beat the fetch)");
    }
  };

  // preRun (seeding tools only): suppress the first-run setup wizard — its modal
  // loop is unsupported on our ephemeral MEMFS (nothing it writes would survive
  // a reload, and the wizard would re-run every boot). Make all settings
  // providers report NeedsUserInput()==false — the wizard's "use defaults" path.
  const seedKicadConfig = () => {
    const FS = moduleFS();
    FS.mkdirTree(KICAD_CONFIG_DIR);
    // libs: the mount point that pcbjam lib URIs (/mnt/pcbjam/<lib>) live under.
    // A real dir so any incidental existence/backup check on the URI passes; the
    // lib contents themselves are served virtually via window.kicadLibs.
    FS.mkdirTree(PCBJAM_LIB_MOUNT);
    // Empty placeholder file per lib so the editor's post-save file-times stat
    // succeeds (the real bytes are served via window.kicadLibs).
    for (const uri of libPlaceholderUris) {
      if (!FS.analyzePath(uri).exists) FS.writeFile(uri, "");
    }
    const writeIfAbsent = (path: string, contents: string) => {
      if (FS.analyzePath(path).exists) return;
      FS.writeFile(path, contents);
      log(`[boot] seeded ${path}`);
    };
    // 3D models: the MEMFS root the prescan/ensure paths write into, plus the
    // env vars (every vintage) that make KiCad's resolver look there.
    FS.mkdirTree(MODELS_3D_ROOT);
    writeIfAbsent(
      `${KICAD_CONFIG_DIR}/kicad_common.json`,
      JSON.stringify(
        {
          do_not_show_again: {
            update_check_prompt: true,
            data_collection_prompt: true,
          },
          environment: {
            vars: Object.fromEntries(
              MODELS_3D_ENV_VARS.map((v) => [v, MODELS_3D_ROOT]),
            ),
          },
        },
        null,
        2,
      ),
    );
    // libs: rows generated in doBoot from the lib source; the PCBJAM / PCBJAM_FP
    // plugins resolve each via window.kicadLibs.
    writeIfAbsent(`${KICAD_CONFIG_DIR}/sym-lib-table`, symLibTable);
    writeIfAbsent(`${KICAD_CONFIG_DIR}/fp-lib-table`, fpLibTable);
    writeIfAbsent(
      `${KICAD_CONFIG_DIR}/design-block-lib-table`,
      "(design_block_lib_table\n  (version 7)\n)\n",
    );

    // Theme (comments-ux 0002 F2): the dark color theme is seeded ALWAYS (so
    // the F4 live switch is a settings-only operation); the per-app settings
    // pick the boot theme. Only the schematic set is overridden — KiCad's
    // board canvas is dark by default, and `_builtin_default` keeps it.
    FS.mkdirTree(`${KICAD_CONFIG_DIR}/colors`);
    writeIfAbsent(
      `${KICAD_CONFIG_DIR}/colors/pcbjam-dark.json`,
      JSON.stringify(pcbjamDarkTheme, null, 2),
    );
    if (currentTheme() === "dark") {
      const appearance = JSON.stringify(
        { appearance: { color_theme: "pcbjam-dark" } },
        null,
        2,
      );
      // writeIfAbsent by design: a same-session relaunch after the user
      // switched themes in-app (F4 persists into these files) must win.
      writeIfAbsent(`${KICAD_CONFIG_DIR}/eeschema.json`, appearance);
      writeIfAbsent(`${KICAD_CONFIG_DIR}/pcbnew.json`, appearance);
    }
  };

  const preRun = [createCanvas, writeResources];
  if (TOOL_NEEDS_CONFIG_SEED[tool]) preRun.push(seedKicadConfig);

  w.Module = {
    thisProgram: TOOL_ARGV0[tool], // argv[0] for KiCad's DEBUG check
    // PCBJAM_DARK_CHROME is a getenv fallback for the wx chrome appearance
    // (wxwidgets src/wasm/settings.cpp) — the authoritative seed is the
    // kicadSetDarkChrome call in onRuntimeInitialized below, which runs on
    // the browser main thread BEFORE main() spawns on the KiCad pthread
    // (pthreads build environ from their own worker's ENV, so this ENV may
    // never reach them).
    ENV: {
      ...(traceMask ? { KICAD_TRACE: traceMask } : {}),
      ...(currentTheme() === "dark" ? { PCBJAM_DARK_CHROME: "1" } : {}),
    },
    // Runtime frame selection: emscripten feeds these to main() as argv[1..], which
    // single_top.cpp parses ("--frame=<token>") to open the requested editor frame
    // from a shared bundle. Set in the Module literal so it's present before the
    // glue's run()/callMain fires. Empty ⇒ the bundle's build-time default frame.
    arguments: opts.frame ? [`--frame=${opts.frame}`] : [],
    preRun,
    postRun: [],
    print: (...args: unknown[]) => {
      const m = args.join(" ");
      log(`[out] ${m}`);
      // With ?trace=, also echo to the JS console (the in-page log buffer is
      // capped at 800 lines and would truncate a full-set trace run).
      if (traceMask || isWasmDiagnostic(m)) console.log(m);
    },
    printErr: (...args: unknown[]) => {
      const m = args.join(" ");
      log(`[err] ${m}`);
      if (traceMask || isWasmDiagnostic(m)) console.warn(m);
    },
    setStatus: (text: string) => {
      if (text) onStatus(text);
    },
    // OOM recovery (feature 0002): emscripten calls onAbort on abort() — commonly
    // how an out-of-memory surfaces. Forward it so the watcher can respawn.
    onAbort: (what: unknown) => {
      const msg = what === undefined ? "" : String(what);
      log(`[boot] abort: ${msg}`);
      // Authoritative trap notification: latch the scheduler's terminal gate
      // so no parked frame resumes into the aborted instance (E-8/E-14).
      // Safe w.r.t. recovery — oom-watch recovers via a full page reload,
      // never an in-realm module replacement.
      (globalThis as {
        __wxScheduler?: { terminalize?: (site: string, e?: unknown) => void };
      }).__wxScheduler?.terminalize?.("emscripten abort", msg);
      onAbort?.(msg);
    },
    monitorRunDependencies: () => {},
    onRuntimeInitialized: () => {
      log("[boot] runtime initialized");
      // Seed the wx chrome appearance BEFORE main() spawns on the KiCad
      // pthread (comments-ux 0002 F4) — this runs on the browser main
      // thread, and the flag lives in shared wasm memory. Older bundles
      // without the binding just skip it.
      const mod = w.Module as { kicadSetDarkChrome?: (dark: boolean) => void };
      mod.kicadSetDarkChrome?.(currentTheme() === "dark");
      const canvas = (w.Module as { canvas?: HTMLCanvasElement }).canvas;
      if (canvas) canvas.style.display = "block";
      // The runtime is up; main() is booting the wx UI next (the open-flow's
      // own "Opening…" statuses take over from there).
      onStatus("Starting the editor…");
    },
    // Resolve wasm + pthread worker against the asset base, not the SPA route.
    locateFile: (path: string) => `${base}/${path}`,
    // Own the wasm fetch so we can report download progress (see helper). Streams
    // straight into the compiler; passing `module` to the callback lets emscripten
    // share it with the pthread workers (this hook fires on the main thread only).
    instantiateWasm: (
      imports: WebAssembly.Imports,
      success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ): Record<string, never> => {
      void (async () => {
        try {
          onStatus(fetchLabel);
          const resp = await fetchWasmWithProgress(
            `${base}/${bundle}.wasm`,
            onProgress,
            expectedWasmBytes,
            // Last byte in — only the compile tail is left running.
            () => onStatus("Compiling…"),
            // Provenance line into the in-app log (and the fatal ring via the
            // append mirror): which wasm bytes were actually under test.
            (line) => log(line),
          );
          const ct = resp.headers.get("content-type") ?? "";
          if (ct.includes("application/wasm") && WebAssembly.instantiateStreaming) {
            const { instance, module } = await WebAssembly.instantiateStreaming(
              resp,
              imports,
            );
            success(instance, module);
          } else {
            // Fallback (no streaming, or a server that mislabels the MIME type):
            // buffer then compile. Costs peak memory but always works.
            const bytes = await resp.arrayBuffer();
            onStatus("Compiling…");
            const { instance, module } = await WebAssembly.instantiate(bytes, imports);
            success(instance, module);
          }
          // Download + compile both succeeded — safe to record "downloaded"
          // (a truncated stream would have thrown above).
          onWasmInstantiated?.();
          onStatus("Starting KiCad…");
        } catch (e) {
          log(`[boot] wasm instantiate failed: ${String(e)}`);
          onStatus(`Error: ${String(e)}`);
        }
      })();
      return {}; // signal async instantiation (we call `success` ourselves)
    },
  };

  // Load order mirrors the harness HTML (tests/apps/kicad/<tool>.html):
  //   wx.js     — defines globals the wasm imports (getConfigEntryLength, …) and
  //               the wxElementRegistry the open-flow drives.
  //   wx-dom.js — the DOM-port shim that defines window.wxDomCreateControl and the
  //               other DOM widget hooks the wasm invokes via EM_ASM. Without it the
  //               tool aborts at startup with "wxDomCreateControl is not defined".
  //   <tool>.js — the tool glue, whose execution captures currentScript.src as
  //               Emscripten's _scriptName.
  // BEFORE the glue executes: pthread workers must spawn from a same-origin
  // script when `base` is the cross-origin CDN (and carry the trace env).
  installPthreadWorkerRedirect(base, bundle, traceMask);
  await loadScript(`${base}/wx.js`);
  await loadScript(`${base}/wx-dom.js`);
  await loadScript(`${base}/${bundle}.js`);
  log(`[boot] injected wx.js + wx-dom.js + ${bundle}.js (base=${base})`);
  // App-side provenance: the hashed chunk name pins the exact frontend build
  // the same way the wasm line pins the runtime (import.meta.url resolves to
  // this code's own bundled chunk).
  log(
    `[build] app=${new URL(import.meta.url).pathname.split("/").pop() ?? "?"} ` +
      `base=${base} ua=${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "")}`,
  );
}
