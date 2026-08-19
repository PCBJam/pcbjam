import { MODELS_3D_ROOT } from "../constants";
import type { Model3dSource } from "./models-source";

/**
 * Glue between 3D model delivery and the running KiCad WASM tool:
 *
 *  - `installModel3dHandler` backs the provider's `kind === "model3d"` requests
 *    (the C++ lazy fallback in S3D_CACHE::load → PCBJAM_3D::EnsureModelFile asks
 *    "ensure" for a ref the prescan missed).
 *  - `prescanBoardModels` scans a board's `(model "…")` refs up front and
 *    prefetches those bodies (R2 → IDB → MEMFS) so the 3D viewer's first open
 *    resolves everything locally.
 *
 * Both paths converge on `ensureModelInMemfs`: fetch the body via the
 * `Model3dSource` (IDB-cached, sparse) and write it under `MODELS_3D_ROOT` —
 * where boot points every `KICAD*_3DMODEL_DIR` env var, so KiCad's stock
 * resolver finds the file with no C++ resolution changes.
 */

/** Progress of a board-model prefetch burst (drives the 3D loading overlay). */
export const MODELS_LOADING_EVENT = "pcbjam:models-loading";

export interface ModelsLoadingDetail {
  loading: boolean;
  done: number;
  total: number;
}

function emitModelsLoading(detail: ModelsLoadingDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MODELS_LOADING_EVENT, { detail }));
}

/**
 * Normalize a footprint model reference to the source's relative form —
 * "${KICAD*_3DMODEL_DIR}/<lib>.3dshapes/<name>.<ext>" (any vintage, `${}` or
 * `$()`) → "<lib>.3dshapes/<name>.<ext>". Bare relative refs pass through;
 * absolute paths / ${KIPRJMOD} / kicad_embed:// are not ours → null. Mirrors
 * pcbjamNormalizeModelRef in kicad/3d-viewer/3d_cache/pcbjam_model_fetch.cpp.
 */
export function normalizeModelRef(raw: string): string | null {
  const ref = raw.trim();
  if (!ref) return null;
  if (ref.startsWith("${") || ref.startsWith("$(")) {
    const closing = ref[1] === "{" ? "}" : ")";
    const end = ref.indexOf(closing);
    if (end < 0) return null;
    const v = ref.slice(2, end);
    // Any vintage of the model-dir var, plus the pre-v6 legacy alias.
    if (!v.includes("3DMODEL_DIR") && v !== "KISYS3DMOD") return null;
    return ref.slice(end + 1).replace(/^[/\\]+/, "") || null;
  }
  if (ref.startsWith("/") || ref.includes("://")) return null;
  return ref;
}

/** Every `(model "…")` ref in a KiCad board/footprint s-expr, normalized. */
export function scanModelRefs(sexprText: string): string[] {
  const refs = new Set<string>();
  const re = /\(\s*model\s+"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(sexprText); m; m = re.exec(sexprText)) {
    const raw = m[1]!.replace(/\\(.)/g, "$1");
    const rel = normalizeModelRef(raw);
    if (rel) refs.add(rel);
  }
  return [...refs];
}

type ModelFS = Pick<
  EmscriptenFS,
  "mkdirTree" | "writeFile" | "analyzePath" | "readFile"
>;

function toolFS(): ModelFS | null {
  const fs = (window as ToolWindow).FS;
  return fs && typeof fs.writeFile === "function" ? (fs as ModelFS) : null;
}

let installedSource: Model3dSource | null = null;
let installedLog: (msg: string) => void = () => {};
/**
 * Refs materialized in MEMFS this session → the ABSOLUTE path actually written.
 * The written path can differ in extension from the ref: a `.wrl` ref with no
 * `.wrl` body is served by the `.step` fallback and written under `.step` (see
 * refCandidates). We must memoize — and return — the REAL path. Returning the
 * ref's own `.wrl` path (a value the ref implies but was never written) points
 * KiCad at a missing file, surfacing as "Failed to retrieve file times for
 * '…​.wrl'". Bodies are immutable, so the mapping never goes stale.
 */
const materialized = new Map<string, string>();
/** In-flight ensures, coalesced per ref (prescan and the C++ fallback race). */
const ensuring = new Map<string, Promise<string | null>>();

/** Wire the model source used by the provider dispatch + prescan. */
export function installModel3dHandler(
  source: Model3dSource,
  log: (msg: string) => void,
): void {
  installedSource = source;
  installedLog = log;
}

/** Fetch one model body and write it under MODELS_3D_ROOT. Resolves to the
 *  absolute MEMFS path when present, null when the source can't serve it. */
export async function ensureModelInMemfs(ref: string): Promise<string | null> {
  const cached = materialized.get(ref);
  if (cached !== undefined) return cached;
  let p = ensuring.get(ref);
  if (!p) {
    p = doEnsure(ref).finally(() => ensuring.delete(ref));
    ensuring.set(ref, p);
  }
  return p;
}

/**
 * Format fallback: kicad-packages3D dropped `.wrl` at the 10.x generation
 * (STEP-only), but boards authored with KiCad ≤9 still reference `.wrl`. Try
 * the exact ref, then the same stem in the surviving formats. The substituted
 * file is written (and returned) under ITS OWN extension — the returned path's
 * extension is what picks the parsing plugin, so a `.wrl` ask served by a
 * `.step` body dispatches to oce, not vrml. No C++ involvement.
 */
const FALLBACK_EXTS: Record<string, string[]> = {
  ".wrl": [".step", ".stp"],
  ".wrz": [".step", ".stp"],
  ".step": [".wrl"],
  ".stp": [".wrl"],
};

function refCandidates(ref: string): string[] {
  const dot = ref.lastIndexOf(".");
  if (dot < 0) return [ref];
  const ext = ref.slice(dot).toLowerCase();
  const stem = ref.slice(0, dot);
  return [ref, ...(FALLBACK_EXTS[ext] ?? []).map((e) => `${stem}${e}`)];
}

async function doEnsure(ref: string): Promise<string | null> {
  const source = installedSource;
  const fs = toolFS();
  if (!source || !fs) return null;

  // Try the exact ref, then the format-fallback candidates. The ACTUAL written
  // path (which may differ in extension from the ref — a `.wrl` served by a
  // `.step` body) is memoized and returned, so a later ensure for the same ref
  // hands KiCad the file that exists, not the ref's own (never-written) path.
  for (const candidate of refCandidates(ref)) {
    const target = `${MODELS_3D_ROOT}/${candidate}`;
    // Already on disk (a prior ensure — this ref or another — wrote this body).
    if (fs.analyzePath(target).exists) {
      materialized.set(ref, target);
      return target;
    }
    const body = await source.getModelBody(candidate);
    if (!body) continue;
    fs.mkdirTree(target.slice(0, target.lastIndexOf("/")));
    fs.writeFile(target, body);
    materialized.set(ref, target);
    installedLog(
      `[3d] materialized ${candidate}${candidate === ref ? "" : ` (for ${ref})`} (${body.length} bytes)`,
    );
    return target;
  }
  return null;
}

/**
 * Provider dispatch for `kind === "model3d"` (called by installLibsProvider's
 * request before any lib-id parsing — the C++ bridge passes an empty lib; the
 * ref itself carries the library). Answers with the ABSOLUTE MEMFS path of the
 * materialized file — S3D_CACHE loads that path directly, so model delivery
 * never depends on env-var expansion inside the wasm runtime.
 */
export async function handleModel3dRequest(
  op: string,
  arg: string,
): Promise<string | null> {
  if (op !== "ensure") return null;
  const rel = normalizeModelRef(arg);
  if (!rel) return null;
  try {
    return await ensureModelInMemfs(rel);
  } catch (e) {
    installedLog(`[3d] ensure failed for ${arg}: ${String(e)}`);
    return null;
  }
}

/** One board model body ready to ship to the occ_service export worker. */
export interface BoardModelFile {
  /** Lib-relative staged path ("<lib>.3dshapes/<name>.<ext>", REAL extension). */
  path: string;
  bytes: Uint8Array;
}

/**
 * Fetch every lib model a board references for an occ_service export. This is
 * deliberately a pure source/IDB/network path (E-4): the OCC worker has a
 * different MEMFS, so materializing and reading the bytes through the editor's
 * native heap only adds a stale native-completion tail after an
 * export-prefetch timeout. The returned paths carry the fetched file's real
 * fallback extension and are deduplicated. Best-effort: missing models are
 * skipped (the exporter reports them missing). An abort stops selection
 * immediately and makes every already-started source result inert before it
 * is retained. Returns [] when 3D model delivery is not configured.
 */
export async function collectBoardModelFiles(
  boardText: string,
  concurrency = 6,
  signal?: AbortSignal,
): Promise<BoardModelFile[]> {
  if (!installedSource) return [];
  const source = installedSource;
  const isCurrent = () => source === installedSource;
  const throwIfAborted = (): void => {
    if (!signal?.aborted) return;
    throw signal.reason ?? new DOMException("Model collection aborted", "AbortError");
  };
  throwIfAborted();
  const refs = scanModelRefs(boardText);
  if (!refs.length) return [];

  const out: BoardModelFile[] = [];
  const seen = new Set<string>();
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted();
      if (!isCurrent() || idx >= refs.length) return;
      const ref = refs[idx++]!;
      for (const candidate of refCandidates(ref)) {
        let body: Uint8Array | null = null;
        try {
          body = await source.getModelBody(candidate);
        } catch {
          // Best-effort: try the next format. The exporter reports a miss if
          // no candidate exists.
        }
        throwIfAborted();
        if (!isCurrent()) return;
        if (!body) continue;

        if (!seen.has(candidate)) {
          seen.add(candidate);
          // The OCC worker receives this buffer as a transferable. Keep its
          // ownership independent from any source/cache view.
          out.push({ path: candidate, bytes: new Uint8Array(body) });
        }
        break;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, Math.trunc(concurrency)), refs.length) },
      () => worker(),
    ),
  );
  throwIfAborted();
  installedLog(`[3d] export prefetch: ${out.length}/${refs.length} board model(s)`);
  return out;
}

/** Board text whose prescan was deferred (read-only sessions): run on the
 *  first 3D open via {@link runDeferredModelPrescan}. */
let deferredBoardText: string | null = null;

/**
 * Read-only viewers download nothing 3D until they actually open the viewer:
 * park the board text instead of prescanning it at project open. The last
 * board staged wins (one board per session).
 */
export function deferBoardModelPrescan(boardText: string): void {
  deferredBoardText = boardText;
}

/** Run the parked prescan (no-op when nothing was deferred or it already ran).
 *  Resolves when the models are in MEMFS, so a caller can open the 3D viewer
 *  right after and have it resolve refs locally (the per-model C++ ensure
 *  still covers any miss). */
export async function runDeferredModelPrescan(): Promise<void> {
  const text = deferredBoardText;
  if (text === null) return;
  deferredBoardText = null;
  await prescanBoardModels(text);
}

/**
 * Prefetch every model a board references (fire-and-forget from the project
 * sync). Bodies land in IDB + MEMFS before the user opens the 3D viewer in the
 * common case; anything still missing falls back to the per-model C++ ensure.
 */
export async function prescanBoardModels(
  boardText: string,
  concurrency = 6,
): Promise<void> {
  if (!installedSource) return;
  deferredBoardText = null;
  const refs = scanModelRefs(boardText);
  if (!refs.length) return;

  const total = refs.length;
  let done = 0;
  emitModelsLoading({ loading: true, done, total });
  installedLog(`[3d] prescan: ${total} model ref(s) on board`);
  const started = performance.now();

  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < refs.length) {
      const ref = refs[idx++]!;
      try {
        await ensureModelInMemfs(ref);
      } catch {
        // best-effort: the C++ lazy path (or a later prescan) retries
      }
      emitModelsLoading({ loading: ++done < total, done, total });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );
  installedLog(
    `[3d] prescan: ${done}/${total} in ${Math.round(performance.now() - started)}ms`,
  );
}
