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
 * The occ_service module (own emscripten instance, no suspension backend) boots in a
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

export function installOccService(log: (msg: string) => void): void {
  if (globalThis.occService) return;

  let nextId = 1;
  const pending = new Map<number, (res: OccResponse) => void>();
  let workerP: Promise<Worker> | null = null;

  const ensureWorker = (): Promise<Worker> => {
    if (!workerP) {
      workerP = (async () => {
        // occ_service is a Bundle (a published delivery artifact), not a Tool —
        // resolveWasmBase accepts either and looks the bundle up directly.
        const base = await resolveWasmBase("occ_service");
        const glue = new URL(`${base}/occ_service.js`, window.location.href).href;
        log(`[occ] booting occ_service from ${base}`);

        const worker = new Worker(
          URL.createObjectURL(
            new Blob(occWorkerBlobParts(glue), { type: "text/javascript" }),
          ),
        );

        worker.onmessage = (e) => {
          const { id, res } = e.data ?? {};
          if (typeof id !== "number") return;
          const resolve = pending.get(id);
          if (resolve) {
            pending.delete(id);
            resolve(res as OccResponse);
          }
        };

        await new Promise<void>((resolve, reject) => {
          const onFirst = (e: MessageEvent) => {
            if (e.data?.ready) {
              worker.removeEventListener("message", onFirst);
              resolve();
            } else if (e.data?.bootError) {
              reject(new Error(e.data.bootError));
            }
          };
          worker.addEventListener("message", onFirst);
          worker.onerror = (e) => reject(new Error(`occ_service worker: ${e.message}`));
        });

        log("[occ] occ_service ready");
        return worker;
      })().catch((e) => {
        workerP = null; // a failed boot must stay retryable
        throw e;
      });
    }
    return workerP;
  };

  const post = (worker: Worker, req: OccRequest): Promise<OccResponse> => {
    const id = nextId++;
    const transfer: Transferable[] =
      req.kind === "export"
        ? [req.board.buffer, ...(req.models ?? []).map((m) => m.bytes.buffer)]
        : [req.bytes.buffer];
    return new Promise<OccResponse>((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, req }, transfer);
    });
  };

  const request = async (req: OccRequest): Promise<OccResponse> => {
    if (req.kind === "export") {
      // Ship the board's lib model bodies with the request: the worker's
      // EXPORTER_STEP resolves them from its own MEMFS (delivery gap doc:
      // docs/features/3d-models/0007). Best-effort — an export without
      // models still succeeds, each miss reported by the exporter.
      try {
        req.models = await collectBoardModelFiles(
          new TextDecoder().decode(req.board),
        );
        if (req.models.length)
          log(`[occ] shipping ${req.models.length} board model(s) with the export`);
      } catch (e) {
        log(`[occ] model prefetch failed (exporting without models): ${e}`);
        req.models = [];
      }
    }

    let worker: Worker;
    try {
      worker = await ensureWorker();
    } catch (e) {
      return { ok: false, report: `occ_service unavailable: ${e}` };
    }

    const res = await post(worker, req);

    if (req.kind === "export") {
      // Deliver the export straight to the user; the editor gets status only
      // (the bytes never enter pcbnew's heap).
      if (res.ok && res.bytes?.length) {
        // The dialog can hand over an extension-only name (".step" — its
        // default filename field is empty in the browser); Chromium mangles a
        // bare dotfile download to "step.txt", so give it a real stem while
        // keeping the format extension the user picked.
        const raw = req.fileName || res.fileName || "";
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
