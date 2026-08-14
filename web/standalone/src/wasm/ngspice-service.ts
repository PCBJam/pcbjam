// The worker-side wrapper as text (vite ?raw): one shared source of truth,
// also injected by the e2e harness stub (tests/kicad/utils/ngspice-service.ts).
import ngspiceWorkerSource from "./ngspice-worker.js?raw";
import { resolveWasmBase } from "./wasm-assets";

/**
 * `globalThis.ngspiceService` — the lazy ngspice simulation service provider
 * (docs/features/ngspice-split/; the SPICE analog of occ-service.ts).
 *
 * kicad_editor.wasm carries no ngspice: eeschema's NGSPICE class binds to the
 * sharedspice client stub (wasm/stubs/sharedspice_client.cpp), whose
 * EM_ASYNC_JS bridges suspend the editor and land here. The ngspice_service
 * module (own emscripten instance, pthreads, no suspension backend) boots in a
 * dedicated Worker on the FIRST request — a session that never opens the
 * simulator never fetches it.
 *
 * Requests mirror the sharedspice API 1:1 (init/circ/command/get_vec_info/
 * cur_plot/all_plots/all_vecs/running/cm_input_path). The worker additionally
 * streams `{ evt }` frames (batched SendChar/SendStat lines, BGThreadRunning
 * transitions, ControlledExit) which are handed to
 * `globalThis.__ngspiceOnEvent` — installed by the client stub at first init;
 * frames arriving earlier are queued.
 *
 * A worker death (hard ngspice crash — wasm has no SIGSEGV recovery) settles
 * every in-flight request with { error } and resets the boot promise: KiCad's
 * normal error path (`m_error` → `NGSPICE::validate()` → re-init) then
 * transparently boots a FRESH worker. That worker-restart isolation is the
 * whole reason the simulator lives out-of-process.
 */

export interface NgspiceEvent {
  kind: "char" | "stat" | "bg" | "exit";
  lines?: string[];
  finished?: boolean;
  status?: number;
  immediate?: boolean;
  quit?: boolean;
}

export type NgspiceRequest =
  | { kind: "init" }
  | { kind: "circ"; lines: string[]; files?: { path: string; text: string }[] }
  | { kind: "command"; cmd: string }
  | { kind: "get_vec_info"; name: string }
  | { kind: "cur_plot" }
  | { kind: "all_plots" }
  | { kind: "all_vecs"; plot: string }
  | { kind: "running" }
  | { kind: "cm_input_path"; path: string };

// Response shape depends on the request kind; `error` is set on any failure
// (including worker death).
export interface NgspiceResponse {
  ret?: number;
  found?: boolean;
  vname?: string;
  vtype?: number;
  flags?: number;
  length?: number;
  real?: Float64Array | null;
  comp?: Float64Array | null;
  name?: string;
  names?: string[];
  running?: boolean;
  ok?: boolean;
  error?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var ngspiceService:
    | { request(req: NgspiceRequest): Promise<NgspiceResponse> }
    | undefined;
  // eslint-disable-next-line no-var
  var __ngspiceOnEvent: ((evt: NgspiceEvent) => void) | undefined;
}

/** Worker blob parts: prelude with the glue URL + the shared wrapper source. */
export function ngspiceWorkerBlobParts(glueHref: string): string[] {
  return [
    `self.NGSPICE_GLUE_URL = ${JSON.stringify(glueHref)};\n`,
    ngspiceWorkerSource,
  ];
}

export function installNgspiceService(log: (msg: string) => void): void {
  if (globalThis.ngspiceService) return;

  let nextId = 1;
  const pending = new Map<number, (res: NgspiceResponse) => void>();
  let workerP: Promise<Worker> | null = null;

  // Events can arrive before the client stub installs __ngspiceOnEvent
  // (the handler comes with the first editor-side ngSpice_Init).
  const evtQueue: NgspiceEvent[] = [];
  const dispatchEvt = (evt: NgspiceEvent) => {
    const handler = globalThis.__ngspiceOnEvent;
    if (handler) {
      while (evtQueue.length) handler(evtQueue.shift()!);
      handler(evt);
    } else {
      evtQueue.push(evt);
    }
  };

  const failAllPending = (why: string) => {
    for (const [, resolve] of pending) resolve({ error: why });
    pending.clear();
  };

  const ensureWorker = (): Promise<Worker> => {
    if (!workerP) {
      workerP = (async () => {
        const base = await resolveWasmBase("ngspice_service");
        const glue = new URL(`${base}/ngspice_service.js`, window.location.href).href;
        log(`[ngspice] booting ngspice_service from ${base}`);

        const worker = new Worker(
          URL.createObjectURL(
            new Blob(ngspiceWorkerBlobParts(glue), { type: "text/javascript" }),
          ),
        );

        worker.onmessage = (e) => {
          const data = e.data ?? {};
          if (data.evt) {
            dispatchEvt(data.evt as NgspiceEvent);
            return;
          }
          if (typeof data.id !== "number") return;
          const resolve = pending.get(data.id);
          if (resolve) {
            pending.delete(data.id);
            resolve(data.res as NgspiceResponse);
          }
        };

        // A dead worker (hard ngspice fault) must not strand the editor
        // suspended in an EM_ASYNC_JS bridge: fail everything in flight and
        // make the next request boot a fresh worker.
        worker.onerror = (e) => {
          log(`[ngspice] worker error: ${e.message} — resetting service`);
          failAllPending(`ngspice_service crashed: ${e.message}`);
          workerP = null;
          try {
            worker.terminate();
          } catch {
            /* already gone */
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
        });

        log("[ngspice] ngspice_service ready");
        return worker;
      })().catch((e) => {
        workerP = null; // a failed boot must stay retryable
        throw e;
      });
    }
    return workerP;
  };

  const request = async (req: NgspiceRequest): Promise<NgspiceResponse> => {
    let worker: Worker;
    try {
      worker = await ensureWorker();
    } catch (e) {
      return { error: `ngspice_service unavailable: ${e}` };
    }

    const id = nextId++;
    return new Promise<NgspiceResponse>((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, req });
    });
  };

  globalThis.ngspiceService = { request };
  log("[ngspice] ngspice_service provider installed (lazy)");
}
