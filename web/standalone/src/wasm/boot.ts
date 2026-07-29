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
 * Boot a KiCad tool directly in the main React document — no iframe.
 *
 * This is a faithful port of the proven harness HTML (tests/apps/kicad/<tool>.html):
 * it builds the same global `Module` config, runs the same preRun steps (create
 * canvas, write images.tar.gz, seed config), then injects `wx.js`, `wx-dom.js`,
 * and `<tool>.js`. The KiCad WASM build is NON-modularized, so it reads a global
 * `var Module` and publishes `FS`/`wxElementRegistry` onto `window` — exactly the
 * surface the iframe approach used, only now in the top-level window.
 *
 * Two browser facts make running in the main document (rather than at /wasm/...)
 * work without touching the build:
 *   - `locateFile` is overridden to resolve `<base>/<file>`, so the .wasm and the
 *     pthread worker script are fetched from the asset dir regardless of the
 *     SPA route the user is on.
 *   - `mainScriptUrlOrBlob` pins the pthread worker to `<base>/<tool>.js`. For a
 *     same-origin base that's the URL directly; for a cross-origin CDN base it's
 *     a same-origin blob shim that importScripts the glue (see
 *     `pthreadWorkerScript` — `new Worker(<cross-origin URL>)` is illegal).
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
 * The pthread worker "script" passed as `Module.mainScriptUrlOrBlob`. KiCad's
 * pthreads spawn CLASSIC workers via `new Worker(...)` (see `<tool>.js`
 * `allocateUnusedWorker`):
 *   - SAME-ORIGIN base → the plain URL string (the proven local/dev path).
 *   - CROSS-ORIGIN base (the CDN) → a SAME-ORIGIN `blob:` worker that
 *     `importScripts()` the cross-origin glue. `new Worker(<cross-origin URL>)`
 *     is a SecurityError, but a `blob:` URL inherits the page origin (legal),
 *     and a classic worker's `importScripts` MAY load a cross-origin script when
 *     the CDN sends `Cross-Origin-Resource-Policy: cross-origin` (needed because
 *     the page is COEP `require-corp`). The `.wasm`/`images.tar.gz` fetches just
 *     need `ACAO` + `CORP` on the CDN. See docs/features/demo-deploy/0001-*.
 */
function pthreadWorkerScript(
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
async function fetchWasmWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  expectedBytes?: number | null,
  onDone?: () => void,
): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  if (!res.body || !onProgress) return res;
  const total = expectedBytes || Number(res.headers.get("content-length")) || 0;
  let loaded = 0;
  const reader = res.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        onDone?.();
        controller.close();
        return;
      }
      loaded += value.byteLength;
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
    installLibsProvider(libsSource, log);
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
      // Ensure the owner has at least one writable user lib to save items into.
      // A user lib holds either kind, so the created lib joins every table.
      const hasUserLib = [...listsByKind.values()].some((libs) =>
        libs.some((l) => l.type === "user"),
      );
      if (libsSource.createLib && !hasUserLib) {
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

  // preRun (seeding tools only): suppress the first-run setup wizard, whose modal
  // loop crashes Asyncify in our ephemeral MEMFS. Make all settings providers
  // report NeedsUserInput()==false — the wizard's "use defaults" path.
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
      if (traceMask) console.log(m);
    },
    printErr: (...args: unknown[]) => {
      const m = args.join(" ");
      log(`[err] ${m}`);
      if (traceMask) console.warn(m);
    },
    setStatus: (text: string) => {
      if (text) onStatus(text);
    },
    // OOM recovery (feature 0002): emscripten calls onAbort on abort() — commonly
    // how an out-of-memory surfaces. Forward it so the watcher can respawn.
    onAbort: (what: unknown) => {
      const msg = what === undefined ? "" : String(what);
      log(`[boot] abort: ${msg}`);
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
    // Pin the pthread worker script. Same-origin → direct URL; cross-origin CDN
    // → a same-origin blob shim that importScripts the glue (see helper above).
    mainScriptUrlOrBlob: pthreadWorkerScript(base, bundle, traceMask),
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
  await loadScript(`${base}/wx.js`);
  await loadScript(`${base}/wx-dom.js`);
  await loadScript(`${base}/${bundle}.js`);
  log(`[boot] injected wx.js + wx-dom.js + ${bundle}.js (base=${base})`);
}
