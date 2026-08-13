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

function canTouchToolNative(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __wxNativeIntegrityUnknown?: boolean;
    __wxScheduler?: {
      dead?: boolean;
      canTouchNative?: () => boolean;
    };
  };
  if (runtime.__wxNativeIntegrityUnknown) return false;
  const scheduler = runtime.__wxScheduler;
  if (!scheduler) return true; // pure/unit use and pre-scheduler boot staging
  return typeof scheduler.canTouchNative === "function"
    ? scheduler.canTouchNative()
    : !scheduler.dead;
}

type NativeEntryScheduler = {
  canTouchNative?: () => boolean;
  enqueueNativeCompletion?: (
    site: string,
    estimatedBytes: number,
    run: () => void,
    onAbandon?: (error: Error) => void,
  ) => boolean;
};

/**
 * A model body whose asynchronous source work is complete, but whose MEMFS
 * publication has not run yet. The KiCad bridge consumes this object in the
 * same native edge which completes its exact wait. JavaScript-only prescan and
 * export callers consume it through the ordinary physical-entry FIFO.
 */
export interface PreparedModel3d {
  readonly __pcbjamPreparedModel3d: true;
  /** Bytes retained by this object until one native lane applies it. */
  readonly retainedBytes: number;
  /** Synchronous, generation-checked MEMFS apply. Must run in a native lane. */
  apply(): string | null;
}

type PreparedModel3dInternal = PreparedModel3d & {
  isCurrent(): boolean;
};

/**
 * Run one completed asynchronous FS operation at the physical native-entry
 * boundary. Source/IDB/network work stays outside. This is deliberately not an
 * Ordinary semantic-owner ticket: a model fetch can be a dependency of the
 * currently parked modal owner, so putting its completion behind that owner
 * would deadlock it.
 */
function runToolNativeEntry<T>(
  site: string,
  estimatedBytes: number,
  run: () => T,
  isCurrent?: () => boolean,
): Promise<T> {
  const scheduler = (
    globalThis as typeof globalThis & { __wxScheduler?: NativeEntryScheduler }
  ).__wxScheduler;

  const assertCurrent = (): void => {
    if (isCurrent && !isCurrent()) {
      throw Object.assign(new Error(`[3d] stale native entry: ${site}`), {
        code: "WX_NATIVE_ENTRY_STALE",
      });
    }
  };
  const invoke = (): T => {
    assertCurrent();
    return run();
  };

  // Unit tests, converter-like diets, and boot staging have no competing
  // runtime entry. Preserve their direct behavior.
  if (!scheduler) {
    try {
      return Promise.resolve(invoke());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  if (typeof scheduler.enqueueNativeCompletion !== "function") {
    return Promise.reject(
      new Error(`[3d] native-entry scheduler unavailable: ${site}`),
    );
  }

  try {
    if (scheduler.canTouchNative && !scheduler.canTouchNative()) {
      return Promise.reject(new Error(`[3d] native runtime unavailable: ${site}`));
    }
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    const accepted = scheduler.enqueueNativeCompletion!(
      site,
      estimatedBytes,
      () => {
        try {
          if (scheduler.canTouchNative && !scheduler.canTouchNative()) {
            reject(new Error(`[3d] native runtime unavailable: ${site}`));
            return;
          }
          // A superseded module/source is a normal cancellation. It must be
          // inert, not an exception escaping from the physical-entry callback.
          assertCurrent();
        } catch (error) {
          reject(error);
          return;
        }
        try {
          resolve(run());
        } catch (error) {
          // Settle observers, but let the scheduler see an FS/Wasm failure so
          // its native-trap containment can close the damaged runtime.
          reject(error);
          throw error;
        }
      },
      // This callback is deliberately JS-only. Scheduler shutdown may mean
      // that Wasm, MEMFS, and proxy contexts are already unsafe. Rejecting the
      // observer releases the per-ref in-flight record without re-entering the
      // native module.
      (error) => reject(error),
    );

    if (!accepted) reject(new Error(`[3d] native entry rejected: ${site}`));
  });
}

let installedSource: Model3dSource | null = null;
let installedLog: (msg: string) => void = () => {};
let installedGeneration = 0;
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
/**
 * In-flight source reads, coalesced independently of native application.
 */
const preparing = new Map<string, Promise<PreparedModel3dInternal | null>>();
/**
 * Completed source reads retained until their first native apply. This closes
 * the gap between a prescan finishing its fetch and its physical apply being
 * admitted: an exact K3 waiter can reuse the body without awaiting that queued
 * apply (which may be gated by the exact waiter itself).
 */
const prepared = new Map<string, PreparedModel3dInternal>();
/** In-flight physical applies, coalesced for prescan and OCC callers only. */
const ensuring = new Map<string, Promise<string | null>>();

/** Wire the model source used by the provider dispatch + prescan. */
export function installModel3dHandler(
  source: Model3dSource,
  log: (msg: string) => void,
): void {
  installedGeneration++;
  installedSource = source;
  installedLog = log;
  // Module instances do not share MEMFS. Never let a new runtime inherit a
  // materialized path or in-flight apply from the previous installation.
  materialized.clear();
  preparing.clear();
  prepared.clear();
  ensuring.clear();
}

/** Fetch one model body and write it under MODELS_3D_ROOT. Resolves to the
 *  absolute MEMFS path when present, null when the source can't serve it. */
export async function ensureModelInMemfs(ref: string): Promise<string | null> {
  if (!canTouchToolNative()) return null;
  const source = installedSource;
  if (!source) return null;
  const generation = installedGeneration;
  const cached = materialized.get(ref);
  if (cached !== undefined) return cached;
  let p = ensuring.get(ref);
  if (!p) {
    p = doEnsure(ref, source, generation).finally(() => {
      if (ensuring.get(ref) === p) ensuring.delete(ref);
    });
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

interface PreparedCandidate {
  candidate: string;
  target: string;
  body: Uint8Array | null;
}

function makePreparedModel(
  ref: string,
  source: Model3dSource,
  generation: number,
  candidates: PreparedCandidate[],
): PreparedModel3dInternal {
  const isCurrent = () =>
    generation === installedGeneration &&
    source === installedSource &&
    canTouchToolNative();

  let result!: PreparedModel3dInternal;
  result = {
    __pcbjamPreparedModel3d: true,
    retainedBytes: candidates.reduce(
      (total, candidate) => total + (candidate.body?.byteLength ?? 0),
      0,
    ),
    isCurrent,
    apply: () => {
      if (!isCurrent()) return null;

      try {
        const cached = materialized.get(ref);
        if (cached !== undefined) return cached;

        const fs = toolFS();
        if (!fs) return null;

        for (const { candidate, target, body } of candidates) {
          // A concurrently prepared alias may already have published the same
          // fallback target. Recheck inside the admitted synchronous apply.
          if (fs.analyzePath(target).exists) {
            materialized.set(ref, target);
            return target;
          }
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
      } finally {
        // Every later consumer can converge through `materialized`; do not
        // retain the fetched payload after the first synchronous apply.
        candidates.length = 0;
        if (prepared.get(ref) === result) prepared.delete(ref);
      }
    },
  };
  return result;
}

/**
 * Complete only the source/IDB/network half of model delivery. No MEMFS or
 * Wasm state is touched here. Concurrent callers for one ref share this work,
 * but publication is deliberately owned by each caller's appropriate lane.
 */
export function prepareModelInMemfs(
  ref: string,
): Promise<PreparedModel3dInternal | null> {
  const source = installedSource;
  if (!source || !canTouchToolNative()) return Promise.resolve(null);
  const generation = installedGeneration;

  const cached = materialized.get(ref);
  if (cached !== undefined) {
    return Promise.resolve(makePreparedModel(ref, source, generation, []));
  }

  const ready = prepared.get(ref);
  if (ready) return Promise.resolve(ready);

  const inFlight = preparing.get(ref);
  if (inFlight) return inFlight;

  let preparation!: Promise<PreparedModel3dInternal | null>;
  preparation = (async () => {
    const candidates: PreparedCandidate[] = [];

    for (const candidate of refCandidates(ref)) {
      if (
        generation !== installedGeneration ||
        source !== installedSource ||
        !canTouchToolNative()
      ) {
        return null;
      }

      const body = await source.getModelBody(candidate);

      if (
        generation !== installedGeneration ||
        source !== installedSource ||
        !canTouchToolNative()
      ) {
        return null;
      }

      candidates.push({
        candidate,
        target: `${MODELS_3D_ROOT}/${candidate}`,
        body,
      });
      // The first available format wins. Earlier null candidates remain in the
      // plan so apply can still recognize a target another ref wrote meanwhile.
      if (body) break;
    }

    const result = makePreparedModel(ref, source, generation, candidates);
    if (result.isCurrent()) prepared.set(ref, result);
    return result;
  })().finally(() => {
    if (preparing.get(ref) === preparation) preparing.delete(ref);
  });
  preparing.set(ref, preparation);
  return preparation;
}

async function doEnsure(
  ref: string,
  source: Model3dSource,
  generation: number,
): Promise<string | null> {
  if (!canTouchToolNative()) return null;
  if (!toolFS()) return null;
  if (generation !== installedGeneration || source !== installedSource) return null;

  // Preparation can be shared with the exact K3 bridge. Only this JS caller
  // waits for physical admission; K3 consumes the same prepared fetch directly
  // in runWaitCompletion and can never wait behind this queued apply.
  const prepared = await prepareModelInMemfs(ref);
  if (!prepared) return null;
  return runToolNativeEntry(
    `3D-model MEMFS apply: ${ref}`,
    prepared.retainedBytes,
    () => prepared.apply(),
    prepared.isCurrent,
  );
}

/**
 * Provider dispatch for `kind === "model3d"` (called by installLibsProvider's
 * request before any lib-id parsing — the C++ bridge passes an empty lib; the
 * ref itself carries the library). The result is a prepared synchronous apply,
 * not a materialized path. The C++
 * exact-token and worker-proxy bridges consume it in their own final native
 * completion so no waiter depends on a physical entry queued behind itself.
 */
export async function handleModel3dRequest(
  op: string,
  arg: string,
): Promise<PreparedModel3d | null> {
  if (op !== "ensure") return null;
  const rel = normalizeModelRef(arg);
  if (!rel) return null;
  try {
    return await prepareModelInMemfs(rel);
  } catch (e) {
    installedLog(`[3d] prepare failed for ${arg}: ${String(e)}`);
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
 * deliberately a pure source/IDB/network path: the OCC worker has a different
 * MEMFS, so materializing and reading the bytes through the editor's native
 * heap only adds a stale native-completion tail after an export-prefetch
 * timeout. The returned paths carry the fetched file's real fallback
 * extension and are deduplicated. Best-effort missing models are skipped (the
 * exporter reports them missing). An abort stops selection immediately and
 * makes every already-started source result inert before it is retained.
 */
export async function collectBoardModelFiles(
  boardText: string,
  concurrency = 6,
  signal?: AbortSignal,
): Promise<BoardModelFile[]> {
  if (!installedSource) return [];
  const source = installedSource;
  const generation = installedGeneration;
  const isCurrent = () =>
    generation === installedGeneration &&
    source === installedSource &&
    canTouchToolNative();
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
