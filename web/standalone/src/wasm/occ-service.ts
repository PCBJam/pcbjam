import { downloadBytes } from "@/lib/download";
import { collectBoardModelFiles, type BoardModelFile } from "./libs/models-bridge";
// The worker-side wrapper as text (vite ?raw): one shared source of truth,
// also injected by the e2e harness stub (tests/kicad/utils/occ-service.ts).
import occWorkerSource from "./occ-worker.js?raw";
import { resolveWasmBase } from "./wasm-assets";

/**
 * `globalThis.occService` — the lazy OpenCASCADE 3D service provider.
 *
 * pcbnew.wasm carries no OCC (docs/features/occ-split/): its two OCC-backed
 * paths suspend via EM_ASYNC_JS bridges (wasm/stubs/{exporter_step,oce_plugin}_stub.cpp)
 * and land here:
 *   { kind: "export",    board, jobJson, fileName } → STEP/GLB/… export; the
 *     resulting bytes are delivered straight to the browser download path and
 *     only { ok, report } goes back to the editor.
 *   { kind: "loadModel", bytes, ext } → STEP/IGES parse + tessellation; returns
 *     the SCENEGRAPH serialized in KiCad's binary cache format, which the
 *     C++ stub rebuilds with S3D::ReadCache.
 *
 * The occ_service module (own emscripten instance, `-sASYNCIFY=0`) boots in a
 * dedicated Worker on the FIRST request — a pcbnew session that never exports
 * and never views STEP models never fetches it. Same cross-origin worker rules
 * as the pthread workers (boot.ts): a same-origin blob wrapper importScripts
 * the (possibly CDN) glue; the module's own pthread children reuse the trick
 * via mainScriptUrlOrBlob.
 */

interface OccExportRequest {
  kind: "export";
  board: Uint8Array;
  jobJson: string;
  fileName: string;
  /** Board lib model bodies, prefetched here (R2/IDB) and staged worker-side
   *  under its MEMFS model root — the export worker has no delivery of its own. */
  models?: BoardModelFile[];
}

interface OccLoadModelRequest {
  kind: "loadModel";
  bytes: Uint8Array;
  ext: string;
}

export type OccRequest = OccExportRequest | OccLoadModelRequest;

export interface OccResponse {
  ok: boolean;
  report?: string;
  fileName?: string;
  bytes?: Uint8Array;
}

declare global {
  // eslint-disable-next-line no-var
  var occService: { request(req: OccRequest): Promise<OccResponse> } | undefined;
}

/**
 * Assemble the worker blob: a one-line prelude carrying the glue URL, then the
 * shared wrapper source (occ-worker.js), which reads `self.OCC_GLUE_URL`.
 */
export function occWorkerBlobParts(glueHref: string): string[] {
  return [
    `self.OCC_GLUE_URL = ${JSON.stringify(glueHref)};\n`,
    occWorkerSource,
  ];
}

export interface OccServiceWatchdogs {
  /** Maximum time to wait for optional board-model prefetch before exporting without it. */
  modelPrefetchTimeoutMs?: number;
  /** Maximum time from the first request until a new generation announces `ready`. */
  bootTimeoutMs?: number;
  /** Maximum time for any one request in a ready generation to answer. */
  responseTimeoutMs?: number;
}

// These are last-resort failure bounds, not normal scheduling deadlines.
// OCC startup, model parsing, and board export can all be expensive on slow
// devices, so production defaults deliberately leave a large margin.
export const OCC_BOOT_TIMEOUT_MS = 2 * 60_000;
export const OCC_RESPONSE_TIMEOUT_MS = 30 * 60_000;
export const OCC_MODEL_PREFETCH_TIMEOUT_MS = 30_000;

export function installOccService(
  log: (msg: string) => void,
  watchdogs: OccServiceWatchdogs = {},
): void {
  if (globalThis.occService) return;

  const modelPrefetchTimeoutMs =
    watchdogs.modelPrefetchTimeoutMs ?? OCC_MODEL_PREFETCH_TIMEOUT_MS;
  const bootTimeoutMs = watchdogs.bootTimeoutMs ?? OCC_BOOT_TIMEOUT_MS;
  const responseTimeoutMs =
    watchdogs.responseTimeoutMs ?? OCC_RESPONSE_TIMEOUT_MS;

  interface WorkerSlot {
    generation: number;
    worker?: Worker;
    workerUrl?: string;
    failed: boolean;
    ready: Promise<WorkerSlot>;
    bootTimer?: ReturnType<typeof setTimeout>;
    rejectBoot?: (reason?: unknown) => void;
    removeBootListener?: () => void;
  }

  interface PendingRequest {
    generation: number;
    resolve: (res: OccResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }

  let nextId = 1;
  let nextGeneration = 1;
  const pending = new Map<number, PendingRequest>();
  let workerSlot: WorkerSlot | null = null;

  const failPending = (generation: number, report: string): void => {
    for (const [id, request] of pending) {
      if (request.generation !== generation) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve({ ok: false, report });
    }
  };

  const retireWorker = (slot: WorkerSlot, report: string): void => {
    if (slot.failed) return;
    slot.failed = true;
    if (slot.bootTimer !== undefined) {
      clearTimeout(slot.bootTimer);
      slot.bootTimer = undefined;
    }
    slot.removeBootListener?.();
    slot.removeBootListener = undefined;
    failPending(slot.generation, report);
    if (workerSlot === slot) workerSlot = null;
    try {
      slot.worker?.terminate();
    } catch {
      /* already gone */
    }
    if (slot.workerUrl) {
      try {
        URL.revokeObjectURL(slot.workerUrl);
      } catch {
        /* URL cleanup must not prevent exact wait settlement */
      }
      slot.workerUrl = undefined;
    }
    const reject = slot.rejectBoot;
    slot.rejectBoot = undefined;
    reject?.(new Error(report));
  };

  const ensureWorker = (): Promise<WorkerSlot> => {
    if (!workerSlot) {
      const slot = {
        generation: nextGeneration++,
        failed: false,
      } as WorkerSlot;
      // Publish the generation before its async boot reaches the first await.
      // This also lets every continuation test exact slot ownership directly.
      workerSlot = slot;

      // The editor is parked for this entire operation, including delivery
      // discovery. Start the generation deadline before resolveWasmBase(): a
      // hung manifest/CDN lookup must settle the exact wait just like a Worker
      // which never announces ready.
      const bootDeadline = new Promise<never>((_resolve, reject) => {
        slot.rejectBoot = reject;
        slot.bootTimer = setTimeout(() => {
          if (slot.failed || workerSlot !== slot) return;
          const report =
            `occ_service boot timed out after ${bootTimeoutMs} ms`;
          log(`[occ] ${report} — resetting service`);
          retireWorker(slot, report);
        }, bootTimeoutMs);
      });

      const boot = (async () => {
        // occ_service is a Bundle (a published delivery artifact), not a Tool —
        // resolveWasmBase accepts either and looks the bundle up directly.
        const base = await resolveWasmBase("occ_service");
        if (slot.failed || workerSlot !== slot) {
          throw new Error("occ_service worker retired during delivery resolution");
        }
        const glue = new URL(`${base}/occ_service.js`, window.location.href).href;
        log(`[occ] booting occ_service from ${base}`);

        slot.workerUrl = URL.createObjectURL(
          new Blob(occWorkerBlobParts(glue), { type: "text/javascript" }),
        );
        const worker = new Worker(slot.workerUrl);
        slot.worker = worker;

        // A hard OCC/Wasm fault must complete every exact editor wait which
        // depends on this worker. The next request gets a fresh generation;
        // callbacks from this retired worker cannot resolve its requests.
        worker.onerror = (e) => {
          const report = `occ_service crashed: ${e.message || "worker error"}`;
          log(`[occ] worker error: ${e.message || "worker error"} — resetting service`);
          retireWorker(slot, report);
        };
        worker.onmessageerror = () => {
          const report = "occ_service transport failed: message decode failed";
          log("[occ] worker message decode failed — resetting service");
          retireWorker(slot, report);
        };

        worker.onmessage = (e) => {
          if (slot.failed || workerSlot !== slot) return;
          const { id, res } = e.data ?? {};
          if (typeof id !== "number") return;
          const request = pending.get(id);
          if (request?.generation === slot.generation) {
            pending.delete(id);
            clearTimeout(request.timer);
            request.resolve(res as OccResponse);
          }
        };

        await new Promise<void>((resolve) => {
          const onFirst = (e: MessageEvent) => {
            if (e.data?.ready) {
              if (slot.bootTimer !== undefined) {
                clearTimeout(slot.bootTimer);
                slot.bootTimer = undefined;
              }
              slot.removeBootListener?.();
              slot.removeBootListener = undefined;
              slot.rejectBoot = undefined;
              resolve();
            } else if (e.data?.bootError) {
              const report = `occ_service boot failed: ${String(e.data.bootError)}`;
              retireWorker(slot, report);
            }
          };
          worker.addEventListener("message", onFirst);
          slot.removeBootListener = () =>
            worker.removeEventListener("message", onFirst);
        });

        if (slot.failed || workerSlot !== slot) {
          throw new Error("occ_service worker retired during boot");
        }
        log("[occ] occ_service ready");
        return slot;
      })();

      slot.ready = Promise.race([boot, bootDeadline]).catch((e) => {
        // Do not let a late failure from an old generation clear a replacement
        // which a re-entrant caller has already started.
        retireWorker(slot, `occ_service unavailable: ${String(e)}`);
        throw e;
      });
    }
    return workerSlot.ready;
  };

  const post = (slot: WorkerSlot, req: OccRequest): Promise<OccResponse> => {
    const worker = slot.worker;
    if (!worker || slot.failed || workerSlot !== slot) {
      return Promise.resolve({ ok: false, report: "occ_service worker is unavailable" });
    }
    const id = nextId++;
    const transfer: Transferable[] =
      req.kind === "export"
        ? [req.board.buffer, ...(req.models ?? []).map((m) => m.bytes.buffer)]
        : [req.bytes.buffer];
    return new Promise<OccResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.get(id)?.generation !== slot.generation) return;
        const report =
          `occ_service response timed out after ${responseTimeoutMs} ms`;
        log(`[occ] ${report} — resetting service`);
        retireWorker(slot, report);
      }, responseTimeoutMs);
      pending.set(id, { generation: slot.generation, resolve, timer });
      try {
        worker.postMessage({ id, req }, transfer);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, report: `occ_service request failed: ${String(error)}` });
      }
    });
  };

  const prefetchBoardModels = async (
    board: Uint8Array,
  ): Promise<BoardModelFile[]> => {
    type Outcome =
      | { kind: "ready"; models: BoardModelFile[] }
      | { kind: "failed"; error: unknown }
      | { kind: "timeout" };

    // collectBoardModelFiles keeps its own bounded network parallelism and does
    // no editor-native work. The controller owns this exact optional
    // collection: a timeout stops it from selecting more models and makes its
    // already-started source results inert.
    const controller = new AbortController();
    const collected: Promise<Outcome> = collectBoardModelFiles(
      new TextDecoder().decode(board),
      6,
      controller.signal,
    ).then(
      (models) => ({ kind: "ready", models }),
      (error) => ({ kind: "failed", error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Outcome>((resolve) => {
      timer = setTimeout(
        () => {
          // Settle the timeout outcome before abort rejection can enqueue its
          // Promise reaction, so logs and public behavior stay deterministic.
          resolve({ kind: "timeout" });
          controller.abort(
            new DOMException("OCC model prefetch timed out", "TimeoutError"),
          );
        },
        modelPrefetchTimeoutMs,
      );
    });
    const outcome = await Promise.race([collected, deadline]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome.kind === "ready") return outcome.models;
    if (!controller.signal.aborted) {
      controller.abort(
        new DOMException("OCC model prefetch retired", "AbortError"),
      );
    }
    if (outcome.kind === "failed") {
      log(`[occ] model prefetch failed (exporting without models): ${outcome.error}`);
    } else {
      log(
        `[occ] model prefetch timed out after ${modelPrefetchTimeoutMs} ms ` +
          "(exporting without models)",
      );
    }
    return [];
  };

  const request = async (req: OccRequest): Promise<OccResponse> => {
    let prepared: OccRequest;
    if (req.kind === "export") {
      // Capture the caller-owned request fields before the first await and
      // build a private dispatch object. A late optional prefetch can then
      // neither mutate the caller's object nor change an already-sent payload.
      const board = req.board;
      const jobJson = req.jobJson;
      const fileName = req.fileName;
      // Ship the board's lib model bodies with the request: the worker's
      // EXPORTER_STEP resolves them from its own MEMFS (delivery gap doc:
      // docs/features/3d-models/0007). Best-effort — an export without
      // models still succeeds, each miss reported by the exporter.
      const models = await prefetchBoardModels(board);
      if (models.length)
        log(`[occ] shipping ${models.length} board model(s) with the export`);
      prepared = { kind: "export", board, jobJson, fileName, models };
    } else {
      prepared = { kind: "loadModel", bytes: req.bytes, ext: req.ext };
    }

    let slot: WorkerSlot;
    try {
      slot = await ensureWorker();
    } catch (e) {
      return { ok: false, report: `occ_service unavailable: ${e}` };
    }

    const res = await post(slot, prepared);

    if (prepared.kind === "export") {
      // Deliver the export straight to the user; the editor gets status only
      // (the bytes never enter pcbnew's heap).
      if (res.ok && res.bytes?.length) {
        // The dialog can hand over an extension-only name (".step" — its
        // default filename field is empty in the browser); Chromium mangles a
        // bare dotfile download to "step.txt", so give it a real stem while
        // keeping the format extension the user picked.
        const raw = prepared.fileName || res.fileName || "";
        const name = !raw || raw.startsWith(".") ? `export${raw || ".step"}` : raw;
        downloadBytes(name, res.bytes);
        log(`[occ] export downloaded: ${name} (${res.bytes.length} bytes)`);
      }
      return { ok: res.ok, report: res.report, fileName: res.fileName };
    }

    return res;
  };

  globalThis.occService = { request };
  log("[occ] occ_service provider installed (lazy)");
}
