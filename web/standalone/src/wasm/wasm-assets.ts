import type { Tool } from "@pcbjam/shared";
import { WASM_MANIFEST_FILE, WASM_ROOT } from "@/lib/config";
import { TOOL_BUNDLE, type Bundle } from "./constants";

/**
 * Resolve the per-tool WASM asset base at runtime from the CDN release manifest.
 *
 * The CDN stores each tool in a content-addressed, immutable, self-contained
 * folder `WASM_ROOT/<tool>/<ver>/` (`<tool>.wasm`, `<tool>.js`, `wx.js`,
 * `wx-dom.js`, `images.tar.gz`). A per-release `manifest-<appTag>.json` maps
 * `tool -> ver`; we fetch it ONCE per page load (uncached, so a manifest edit —
 * e.g. rolling a bad tool back to an older folder — takes effect on the next
 * load with no app rebuild). See docs/features/demo-deploy/0001-*.
 *
 * No manifest configured (dev / same-origin) ⇒ the flat `WASM_ROOT` layout.
 *
 * schema 2 manifests also carry per-bundle `sizes` (standalone-load-ux 0001):
 * `wasm` = RAW/decoded bytes (matches the boot progress stream's counting),
 * `wasmStored`/`totalStored` = over-the-wire bytes (post br/gzip) — what the
 * download consent dialog quotes. Both optional: schema-1 manifests and tools
 * published before schema 2 carry none/partials.
 */
export interface WasmBundleSizes {
  /** Raw (decoded) `.wasm` bytes — the progress bar's true total. */
  wasm?: number;
  /** Over-the-wire `.wasm` bytes (compressed). */
  wasmStored?: number;
  /** Over-the-wire bytes for the whole bundle (wasm + glue + resources). */
  totalStored?: number;
}

export interface WasmManifest {
  schema: number;
  tag: string;
  tools: Record<string, string>;
  sizes?: Record<string, WasmBundleSizes>;
}

let manifestPromise: Promise<WasmManifest> | null = null;

function loadManifest(): Promise<WasmManifest> {
  return (manifestPromise ??= (async () => {
    const url = `${WASM_ROOT}/${WASM_MANIFEST_FILE}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`WASM manifest ${res.status}: ${url}`);
    return (await res.json()) as WasmManifest;
  })());
}

/**
 * Everything the boot + the download-consent gate need to know about a tool's
 * deployed bundle:
 *   - `base`: asset base (no trailing slash) for `bootKicadTool({ base })`.
 *   - `bundle`: the deployed bundle backing the tool (see TOOL_BUNDLE).
 *   - `ver`: the bundle's content-addressed version — null in the flat/override
 *     layouts, where there's no versioning (and the gate doesn't run).
 *   - `sizes`: byte counts when the manifest carries them (schema 2), else null.
 */
export interface WasmMeta {
  base: string;
  bundle: Bundle;
  ver: string | null;
  sizes: WasmBundleSizes | null;
}

/** A tool may be served by a shared bundle (all four editors → kicad_editor);
 *  a caller may also name a bundle directly (occ_service). */
function bundleOf(tool: Tool | Bundle): Bundle {
  return (TOOL_BUNDLE as Partial<Record<string, Bundle>>)[tool] ?? (tool as Bundle);
}

export async function resolveWasmMeta(
  tool: Tool | Bundle,
  override?: string,
): Promise<WasmMeta> {
  const bundle = bundleOf(tool);
  if (override) {
    return { base: override.replace(/\/+$/, ""), bundle, ver: null, sizes: null };
  }
  if (!WASM_MANIFEST_FILE) {
    return { base: WASM_ROOT, bundle, ver: null, sizes: null }; // flat (dev)
  }
  const manifest = await loadManifest();
  const ver = manifest.tools?.[bundle];
  if (!ver) {
    throw new Error(`no WASM version for "${bundle}" in ${WASM_MANIFEST_FILE}`);
  }
  return {
    base: `${WASM_ROOT}/${bundle}/${ver}`,
    bundle,
    ver,
    sizes: manifest.sizes?.[bundle] ?? null,
  };
}

/**
 * Asset base (no trailing slash) for `bootKicadTool({ base })`.
 *   - `override` (e.g. an e2e fixture) wins, used verbatim.
 *   - no manifest ⇒ flat `WASM_ROOT`.
 *   - manifest ⇒ `WASM_ROOT/<tool>/<ver>` from `manifest-<appTag>.json`.
 */
export async function resolveWasmBase(
  tool: Tool | Bundle,
  override?: string,
): Promise<string> {
  return (await resolveWasmMeta(tool, override)).base;
}

/* --------------------------------------------- download-completion marker -- */

// "Have we downloaded this exact bundle before?" The wasm has no explicit cache
// — a plain fetch rides the browser HTTP cache, which is unqueryable cross-
// origin — so completed downloads are recorded here, keyed by the content-
// addressed bundle/version (a release bump changes the key, so a new version
// honestly reads as not-downloaded). If the HTTP cache was evicted anyway, the
// only cost is a fast-labeled load that shows a real progress bar.
const MARKER_PREFIX = "pcbjam:wasm-downloaded:";

function markerKey(bundle: string, ver: string): string {
  return `${MARKER_PREFIX}${bundle}/${ver}`;
}

export function isWasmDownloaded(bundle: string, ver: string | null): boolean {
  if (!ver) return false;
  try {
    return localStorage.getItem(markerKey(bundle, ver)) !== null;
  } catch {
    return false; // storage blocked ⇒ treat as cold (the safe direction)
  }
}

export function markWasmDownloaded(bundle: string, ver: string | null): void {
  if (!ver) return;
  try {
    // One marker per bundle: drop superseded versions' markers (their HTTP
    // cache entries are dead weight anyway once a new version is in use).
    for (const key of staleMarkerKeys(bundle, ver)) localStorage.removeItem(key);
    localStorage.setItem(
      markerKey(bundle, ver),
      JSON.stringify({ at: new Date().toISOString() }),
    );
  } catch {
    /* storage blocked — next load just re-consents */
  }
}

function staleMarkerKeys(bundle: string, keepVer: string): string[] {
  const prefix = `${MARKER_PREFIX}${bundle}/`;
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix) && key !== markerKey(bundle, keepVer)) {
      stale.push(key);
    }
  }
  return stale;
}

/** A PREVIOUS version of this bundle was downloaded — the consent dialog words
 *  the download as an update rather than a first-time setup. */
export function hasAnyWasmDownload(bundle: string): boolean {
  try {
    const prefix = `${MARKER_PREFIX}${bundle}/`;
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith(prefix)) return true;
    }
  } catch {
    /* storage blocked */
  }
  return false;
}

/** Over-the-wire `.wasm` size via HEAD, for manifests without `sizes` (schema
 *  1 / pre-schema-2 tools). Best-effort: null when the CDN rejects HEAD or
 *  sends no usable Content-Length. */
export async function fetchWasmStoredSize(
  base: string,
  bundle: string,
): Promise<number | null> {
  try {
    const r = await fetch(`${base}/${bundle}.wasm`, { method: "HEAD" });
    if (!r.ok) return null;
    const n = Number(r.headers.get("content-length"));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------ auto-download preference -- */

// "Always download without asking" (the consent dialog's checkbox): a device-
// wide opt out of the gate — new versions then download silently, as before
// the gate existed.
const AUTO_DOWNLOAD_KEY = "pcbjam:wasm-autodownload";

export function autoDownloadEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_DOWNLOAD_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoDownloadEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO_DOWNLOAD_KEY, "1");
    else localStorage.removeItem(AUTO_DOWNLOAD_KEY);
  } catch {
    /* storage blocked */
  }
}
