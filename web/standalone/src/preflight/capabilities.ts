/**
 * Device-capability preflight ("potato check") — feature 0001.
 *
 * A pure, unit-testable probe of the browser/device against what the KiCad WASM
 * editor actually requires. It does NOT block anything by itself; it returns a
 * report that `PreflightGate` turns into a blocking dialog (fatal) or an advisory
 * banner (warnings). The four `fatal` checks are the genuinely-cannot-run ones
 * (no SharedArrayBuffer / WASM / threads / WebGL2 — all load-bearing facts in
 * boot.ts and vite.config.ts); everything else is a soft `warn`.
 *
 * Every issue carries a stable `code` so warnings can be correlated with real OOM
 * reports later (feature 0003) and so a "don't show again" choice can be keyed to
 * the exact set of issues seen.
 */

export interface CapabilityIssue {
  /** Stable identifier for analytics + dismissal keys (e.g. "no-sab"). */
  code: string;
  title: string;
  detail: string;
}

export interface CapabilityReport {
  /** Cannot run at all (blocking dialog, with a "Try anyway" override). */
  fatal: CapabilityIssue[];
  /** May run but risky (dismissible advisory banner). */
  warnings: CapabilityIssue[];
  /** Raw measured values, for warning copy + telemetry/debug. */
  info: Record<string, unknown>;
}

/**
 * Tunable thresholds in one place so they can be adjusted without touching the
 * probe logic. `deviceMemory` is capped at 8 and coarse by spec — treat as a hint.
 */
export const THRESHOLDS = {
  /** GB; `navigator.deviceMemory` below this warns. */
  minDeviceMemoryGb: 4,
  /** Bytes; Chromium `performance.memory.jsHeapSizeLimit` below this warns. */
  minHeapLimitBytes: 2 * 1024 ** 3,
  /** `navigator.hardwareConcurrency` below this warns. */
  minCores: 4,
  /** Device pixels (`screen.width * devicePixelRatio`) below this warns. */
  minScreenWidthPx: 1024,
} as const;

// `navigator`/`performance` carry non-standard, browser-specific fields we read
// only when present. Narrow casts keep the probe honest without `any`.
interface DeviceNavigator {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  userAgent?: string;
  userAgentData?: { mobile?: boolean };
}
interface MemoryPerformance {
  memory?: { jsHeapSizeLimit?: number };
}

function getNavigator(): DeviceNavigator | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : (navigator as unknown as DeviceNavigator);
}

/**
 * Probe WebGL2 once: returns whether a context can be created and, if so, the
 * unmasked renderer string (handy for the warning copy + OOM correlation).
 * Returns `supported: null` when no canvas API is available to test with (e.g.
 * a non-DOM test env) — the caller must NOT treat "couldn't test" as fatal.
 */
function probeWebgl2(): { supported: boolean | null; renderer?: string } {
  let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(1, 1);
    } else if (typeof document !== "undefined") {
      canvas = document.createElement("canvas");
    }
  } catch {
    /* fall through to "untestable" */
  }
  if (!canvas) return { supported: null };

  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  } catch {
    return { supported: false };
  }
  if (!gl) return { supported: false };

  let renderer: string | undefined;
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) {
      renderer = gl.getParameter(
        (ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL,
      ) as string;
    }
  } catch {
    /* renderer is best-effort */
  }
  return { supported: true, renderer };
}

/** Inspect the current environment; never throws. */
export function probeCapabilities(): CapabilityReport {
  const fatal: CapabilityIssue[] = [];
  const warnings: CapabilityIssue[] = [];
  const info: Record<string, unknown> = {};

  const nav = getNavigator();
  info.userAgent = nav?.userAgent;

  // --- fatal: SharedArrayBuffer + cross-origin isolation ---------------------
  // No SAB ⇒ KiCad's pthreads cannot exist (vite sets COOP/COEP precisely to
  // enable it). `crossOriginIsolated` is the reliable truth; prefer it over UA.
  const hasSAB = typeof SharedArrayBuffer !== "undefined";
  const isolated =
    typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : undefined;
  info.sharedArrayBuffer = hasSAB;
  info.crossOriginIsolated = isolated;
  if (!hasSAB || isolated === false) {
    fatal.push({
      code: "no-sab",
      title: "Shared memory is unavailable",
      detail:
        "The editor needs SharedArrayBuffer with cross-origin isolation. " +
        "This usually means a desktop Chrome or Edge browser is required; " +
        "Safari and iOS lack the threading support KiCad relies on.",
    });
  }

  // --- fatal: WebAssembly ----------------------------------------------------
  const hasWasm = typeof WebAssembly === "object";
  info.webAssembly = hasWasm;
  if (!hasWasm) {
    fatal.push({
      code: "no-wasm",
      title: "WebAssembly is not supported",
      detail: "This browser cannot run WebAssembly, which the editor is built on.",
    });
  }

  // --- fatal: threads (Workers + Atomics) ------------------------------------
  // Only meaningful when SAB exists; otherwise no-sab already explains it.
  const hasThreads =
    typeof Worker !== "undefined" && typeof Atomics !== "undefined";
  info.threads = hasThreads;
  if (hasSAB && !hasThreads) {
    fatal.push({
      code: "no-threads",
      title: "Threads are unavailable",
      detail:
        "Web Workers and Atomics are required for KiCad's threaded runtime.",
    });
  }

  // --- fatal: WebGL2 ---------------------------------------------------------
  const gl = probeWebgl2();
  info.webgl2 = gl.supported;
  info.glRenderer = gl.renderer;
  if (gl.supported === false) {
    fatal.push({
      code: "no-webgl2",
      title: "WebGL2 is unavailable",
      detail:
        "The editor renders through WebGL2. Enable hardware acceleration, " +
        "or try a different browser.",
    });
  }

  // --- warn: low device memory ----------------------------------------------
  const deviceMemory = nav?.deviceMemory;
  info.deviceMemory = deviceMemory;
  if (typeof deviceMemory === "number" && deviceMemory < THRESHOLDS.minDeviceMemoryGb) {
    warnings.push({
      code: "low-memory",
      title: "Limited memory",
      detail:
        `This device reports about ${deviceMemory} GB of RAM. The editor is ` +
        "memory-hungry and may run out of memory on large boards.",
    });
  }

  // --- warn: low JS heap limit (Chromium only) -------------------------------
  const perf =
    typeof performance === "undefined"
      ? undefined
      : (performance as unknown as MemoryPerformance);
  const heapLimit = perf?.memory?.jsHeapSizeLimit;
  info.jsHeapSizeLimit = heapLimit;
  if (typeof heapLimit === "number" && heapLimit < THRESHOLDS.minHeapLimitBytes) {
    warnings.push({
      code: "low-heap",
      title: "Small memory budget",
      detail:
        "The browser's JavaScript heap limit is low, so large designs may run " +
        "out of memory.",
    });
  }

  // --- warn: few cores -------------------------------------------------------
  const cores = nav?.hardwareConcurrency;
  info.hardwareConcurrency = cores;
  if (typeof cores === "number" && cores < THRESHOLDS.minCores) {
    warnings.push({
      code: "few-cores",
      title: "Few CPU cores",
      detail:
        `This device reports ${cores} logical core(s); the editor may feel slow.`,
    });
  }

  // --- warn: mobile ----------------------------------------------------------
  const uaMobile = nav?.userAgentData?.mobile;
  // Coarse PRIMARY pointer at any width = phone or tablet (touch laptops keep
  // a fine primary pointer) — mirrors lib/mobile-mode isMobileMode.
  const coarsePointer =
    typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse)").matches;
  const isMobile = uaMobile === true || coarsePointer;
  info.mobile = isMobile;
  if (isMobile) {
    warnings.push({
      code: "mobile",
      title: "Mobile device detected",
      detail:
        "The editor is designed for desktop. A mouse and a larger screen are " +
        "strongly recommended.",
    });
  }

  // --- warn: small screen ----------------------------------------------------
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const screenWidthPx =
    typeof screen === "undefined" ? undefined : screen.width * dpr;
  info.screenWidthPx = screenWidthPx;
  if (
    typeof screenWidthPx === "number" &&
    screenWidthPx < THRESHOLDS.minScreenWidthPx
  ) {
    warnings.push({
      code: "small-screen",
      title: "Small screen",
      detail: "The editor's panels and toolbars need more screen space to be usable.",
    });
  }

  return { fatal, warnings, info };
}
