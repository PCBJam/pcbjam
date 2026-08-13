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
 * module (own emscripten instance, pthreads, `-sASYNCIFY=0`) boots in a
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

export interface NgspiceServiceWatchdogs {
  /** Maximum time from the first request until a new generation announces `ready`. */
  bootTimeoutMs?: number;
  /** Maximum time for any one request in a ready generation to answer. */
  responseTimeoutMs?: number;
}

// These are last-resort failure bounds, not normal scheduling deadlines.
// SPICE startup and foreground simulations can be expensive on slow devices,
// so production defaults deliberately leave a large margin.
export const NGSPICE_BOOT_TIMEOUT_MS = 2 * 60_000;
export const NGSPICE_RESPONSE_TIMEOUT_MS = 30 * 60_000;

export function installNgspiceService(
  log: (msg: string) => void,
  watchdogs: NgspiceServiceWatchdogs = {},
): void {
  if (globalThis.ngspiceService) return;

  const bootTimeoutMs =
    watchdogs.bootTimeoutMs ?? NGSPICE_BOOT_TIMEOUT_MS;
  const responseTimeoutMs =
    watchdogs.responseTimeoutMs ?? NGSPICE_RESPONSE_TIMEOUT_MS;

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
    resolve: (res: NgspiceResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }

  let nextId = 1;
  let nextGeneration = 1;
  const pending = new Map<number, PendingRequest>();
  let workerSlot: WorkerSlot | null = null;

  // Events can arrive before the client stub installs __ngspiceOnEvent
  // (the handler comes with the first editor-side ngSpice_Init).
  interface QueuedEventFrame {
    generation: number;
    evt: NgspiceEvent;
    sequence: number;
    bytes: number;
  }
  const MAX_QUEUED_EVENT_FRAMES = 64;
  const MAX_QUEUED_EVENT_BYTES = 8 * 1024 * 1024;
  const evtQueue: QueuedEventFrame[] = [];
  let evtQueueBytes = 0;
  const ackEvent = (slot: WorkerSlot, frame: QueuedEventFrame): boolean => {
    if (slot.failed || workerSlot !== slot || !slot.worker) return false;
    try {
      slot.worker.postMessage({
        eventAck: { sequence: frame.sequence, bytes: frame.bytes },
      });
      return true;
    } catch (error) {
      retireWorker(slot, `ngspice_service event acknowledgment failed: ${String(error)}`);
      return false;
    }
  };
  const dispatchEvt = (
    slot: WorkerSlot,
    evt: NgspiceEvent,
    sequence: number,
    bytes: number,
  ) => {
    if (slot.failed || workerSlot !== slot) return;
    if (!Number.isSafeInteger(sequence) || sequence < 1
        || !Number.isSafeInteger(bytes) || bytes < 1
        || bytes > MAX_QUEUED_EVENT_BYTES) {
      retireWorker(slot, "ngspice_service sent invalid event-frame credit");
      return;
    }
    const frame = { generation: slot.generation, evt, sequence, bytes };
    const handler = globalThis.__ngspiceOnEvent;
    if (handler) {
      while (evtQueue.length) {
        const queued = evtQueue.shift()!;
        evtQueueBytes -= queued.bytes;
        if (queued.generation !== slot.generation) continue;
        handler(queued.evt);
        if (!ackEvent(slot, queued)) return;
      }
      handler(evt);
      ackEvent(slot, frame);
    } else {
      if (evtQueue.length >= MAX_QUEUED_EVENT_FRAMES
          || evtQueueBytes > MAX_QUEUED_EVENT_BYTES - bytes) {
        retireWorker(slot, "ngspice_service event-frame queue exceeded credit");
        return;
      }
      evtQueue.push(frame);
      evtQueueBytes += bytes;
    }
  };

  const failPending = (generation: number, why: string): void => {
    for (const [id, request] of pending) {
      if (request.generation !== generation) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve({ error: why });
    }
  };

  const retireWorker = (slot: WorkerSlot, why: string): void => {
    if (slot.failed) return;
    slot.failed = true;
    if (slot.bootTimer !== undefined) {
      clearTimeout(slot.bootTimer);
      slot.bootTimer = undefined;
    }
    slot.removeBootListener?.();
    slot.removeBootListener = undefined;
    failPending(slot.generation, why);
    for (let i = evtQueue.length - 1; i >= 0; --i) {
      if (evtQueue[i]!.generation === slot.generation) {
        evtQueueBytes -= evtQueue[i]!.bytes;
        evtQueue.splice(i, 1);
      }
    }
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
    reject?.(new Error(why));
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
          const why =
            `ngspice_service boot timed out after ${bootTimeoutMs} ms`;
          log(`[ngspice] ${why} — resetting service`);
          retireWorker(slot, why);
        }, bootTimeoutMs);
      });

      const boot = (async () => {
        const base = await resolveWasmBase("ngspice_service");
        if (slot.failed || workerSlot !== slot) {
          throw new Error(
            "ngspice_service worker retired during delivery resolution",
          );
        }
        const glue = new URL(`${base}/ngspice_service.js`, window.location.href).href;
        log(`[ngspice] booting ngspice_service from ${base}`);

        slot.workerUrl = URL.createObjectURL(
          new Blob(ngspiceWorkerBlobParts(glue), { type: "text/javascript" }),
        );
        const worker = new Worker(slot.workerUrl);
        slot.worker = worker;

        worker.onmessage = (e) => {
          if (slot.failed || workerSlot !== slot) return;
          const data = e.data ?? {};
          if (data.fatal) {
            failWorker(`event stream failure: ${String(data.fatal)}`);
            return;
          }
          if (data.evt) {
            dispatchEvt(
              slot,
              data.evt as NgspiceEvent,
              data.eventSequence,
              data.eventBytes,
            );
            return;
          }
          if (typeof data.id !== "number") return;
          const request = pending.get(data.id);
          if (request?.generation === slot.generation) {
            pending.delete(data.id);
            clearTimeout(request.timer);
            request.resolve(data.res as NgspiceResponse);
          }
        };

        // A dead worker (hard ngspice fault) must not strand the editor
        // suspended in an EM_ASYNC_JS bridge: fail everything in flight and
        // make the next request boot a fresh worker.
        const failWorker = (detail: string) => {
          const why = `ngspice_service crashed: ${detail}`;
          log(`[ngspice] worker error: ${detail} — resetting service`);
          retireWorker(slot, why);
        };
        worker.onerror = (e) => failWorker(e.message || "worker error");
        worker.onmessageerror = () => failWorker("message decode failed");

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
              const why = `ngspice_service boot failed: ${String(e.data.bootError)}`;
              retireWorker(slot, why);
            }
          };
          worker.addEventListener("message", onFirst);
          slot.removeBootListener = () =>
            worker.removeEventListener("message", onFirst);
        });

        if (slot.failed || workerSlot !== slot) {
          throw new Error("ngspice_service worker retired during boot");
        }
        log("[ngspice] ngspice_service ready");
        return slot;
      })();

      slot.ready = Promise.race([boot, bootDeadline]).catch((e) => {
        // A late failure from a retired generation must not clear a replacement
        // which a re-entrant caller has already started.
        retireWorker(slot, `ngspice_service unavailable: ${String(e)}`);
        throw e;
      });
    }
    return workerSlot.ready;
  };

  const post = (slot: WorkerSlot, req: NgspiceRequest): Promise<NgspiceResponse> => {
    const worker = slot.worker;
    if (!worker || slot.failed || workerSlot !== slot) {
      return Promise.resolve({ error: "ngspice_service worker is unavailable" });
    }
    const id = nextId++;
    return new Promise<NgspiceResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.get(id)?.generation !== slot.generation) return;
        const why =
          `ngspice_service response timed out after ${responseTimeoutMs} ms`;
        log(`[ngspice] ${why} — resetting service`);
        retireWorker(slot, why);
      }, responseTimeoutMs);
      pending.set(id, { generation: slot.generation, resolve, timer });
      try {
        worker.postMessage({ id, req });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ error: `ngspice_service request failed: ${String(error)}` });
      }
    });
  };

  const request = async (req: NgspiceRequest): Promise<NgspiceResponse> => {
    let slot: WorkerSlot;
    try {
      slot = await ensureWorker();
    } catch (e) {
      return { error: `ngspice_service unavailable: ${e}` };
    }
    return post(slot, req);
  };

  globalThis.ngspiceService = { request };
  log("[ngspice] ngspice_service provider installed (lazy)");
}
