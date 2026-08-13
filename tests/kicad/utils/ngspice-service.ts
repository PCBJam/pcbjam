import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';

/**
 * Install a REAL `globalThis.ngspiceService` provider into a harness page —
 * the same worker-backed ngspice_service boot the standalone app does
 * (web/standalone/src/wasm/ngspice-service.ts), minus the CDN manifest
 * resolution: the harness serves ngspice_service.{js,wasm} same-origin next
 * to the tool page (tests/scripts/setup-kicad-wasm.sh copies them from
 * output/).
 *
 * The worker-side wrapper is the SHARED source of truth
 * (web/standalone/src/wasm/ngspice-worker.js — the standalone imports it via
 * vite `?raw`; the harness reads it off disk and injects it verbatim), so the
 * boot logic cannot drift between app and tests.
 *
 * Additions for assertability:
 *  - every `{ evt }` frame is appended to window.__ngspiceEvents
 *    ({ kind, lines?, finished?, status?, t: ms-since-install }) BEFORE being
 *    forwarded to globalThis.__ngspiceOnEvent (the editor client stub's
 *    dispatcher, when integrated) — specs assert live streaming by comparing
 *    event timestamps against run boundaries;
 *  - request/response summaries are appended to window.__ngspiceLog. Each
 *    carries the sequence assigned when the request was issued. The test hook
 *    offers a scan-then-subscribe receipt so a response cannot land in the
 *    gap between an array scan and listener installation;
 *  - Worker generations own their Blob URL, boot deadline, response deadlines,
 *    pending calls, and queued events. Retirement settles and cleans only that
 *    exact generation;
 *  - the native simulator publishes its run generation only after the final
 *    plot, operating-point, and canvas refresh calls. The harness stores an
 *    atomic scan-then-subscribe receipt for that applied generation.
 *
 * The worker fetches ngspice_service.js lazily on the FIRST request — specs
 * assert the lazy-load boundary by watching network requests.
 */

const NGSPICE_WORKER_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..',
        'web', 'standalone', 'src', 'wasm', 'ngspice-worker.js'),
    'utf8');

export interface NgspiceHarnessWatchdogs {
    bootTimeoutMs?: number;
    responseTimeoutMs?: number;
}

export async function installNgspiceServiceStub(
    page: Page,
    watchdogs: NgspiceHarnessWatchdogs = {},
): Promise<void> {
    const validDeadline = (value: number | undefined, fallback: number, name: string): number => {
        const deadline = value ?? fallback;
        if (!Number.isSafeInteger(deadline) || deadline < 1)
            throw new Error(`${name} must be a positive safe integer`);
        return deadline;
    };
    const bootTimeoutMs = validDeadline(watchdogs.bootTimeoutMs, 2 * 60_000, 'bootTimeoutMs');
    const responseTimeoutMs = validDeadline(
        watchdogs.responseTimeoutMs,
        30 * 60_000,
        'responseTimeoutMs',
    );

    await page.addInitScript((options: {
        workerSrc: string;
        bootTimeoutMs: number;
        responseTimeoutMs: number;
    }) => {
        if ((globalThis as any).ngspiceService) return;

        const { workerSrc, bootTimeoutMs, responseTimeoutMs } = options;

        const t0 = Date.now();
        (window as any).__ngspiceEvents = [];
        (window as any).__ngspiceLog = [];

        interface WorkerSlot {
            generation: number;
            worker?: Worker;
            workerUrl?: string;
            failed: boolean;
            ready: Promise<WorkerSlot>;
            bootTimer?: ReturnType<typeof setTimeout>;
            rejectBoot?: (reason?: unknown) => void;
            removeBootListener?: () => void;
            /** The exact lifecycle transition used by Worker.onmessageerror. */
            failDecode: () => void;
        }
        interface PendingRequest {
            generation: number;
            resolve: (res: any) => void;
            timer: ReturnType<typeof setTimeout>;
        }
        interface RequestSummary {
            sequence: number;
            kind: string;
            cmd?: string;
            name?: string;
            ret?: number;
            error?: string;
            length?: number;
            t: number;
        }
        interface RequestCriteria {
            kind?: string;
            name?: string;
            minimumLength?: number;
        }
        interface RequestWaiter {
            after: number;
            criteria: RequestCriteria;
            resolve: (summary: RequestSummary) => void;
            reject: (reason?: unknown) => void;
            timer: ReturnType<typeof setTimeout>;
        }
        interface AppliedGenerationReceipt {
            generation: number;
            t: number;
        }
        interface AppliedGenerationWaiter {
            after: number;
            resolve: (receipt: AppliedGenerationReceipt) => void;
            reject: (reason?: unknown) => void;
            timer: ReturnType<typeof setTimeout>;
        }
        interface CancellableReceipt<T> extends Promise<T> {
            cancel: (reason?: string) => void;
        }

        const RECEIPT_TIMEOUT_MS = 2 * 60_000;
        const MAX_RECEIPT_TIMEOUT_MS = 5 * 60_000;
        const MAX_RECEIPT_WAITERS = 128;

        let workerSlot: WorkerSlot | null = null;
        let nextGeneration = 1;
        const pending = new Map<number, PendingRequest>();
        let nextId = 1;
        let maxPending = 0;
        let bootMessageErrorArmed = false;
        let runtimeMessageErrorThreshold: number | null = null;
        const retiredGenerations: number[] = [];
        let nextRequestSequence = 1;
        const requestWaiters = new Set<RequestWaiter>();
        const appliedGenerations: AppliedGenerationReceipt[] = [];
        const appliedGenerationWaiters = new Set<AppliedGenerationWaiter>();
        let disposed = false;

        const validateReceiptTimeout = (timeoutMs: number): string | undefined => {
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
                || timeoutMs > MAX_RECEIPT_TIMEOUT_MS) {
                return `receipt timeout must be an integer from 1 to ${MAX_RECEIPT_TIMEOUT_MS} ms`;
            }
            return undefined;
        };

        const cancellable = <T>(
            promise: Promise<T>,
            cancel: (reason?: string) => void,
        ): CancellableReceipt<T> => {
            const receipt = promise as CancellableReceipt<T>;
            Object.defineProperty(receipt, 'cancel', { value: cancel });
            return receipt;
        };

        const requestMatches = (
            summary: RequestSummary,
            after: number,
            criteria: RequestCriteria,
        ): boolean => summary.sequence > after
            && summary.error === undefined
            && (criteria.kind === undefined || summary.kind === criteria.kind)
            && (criteria.name === undefined || summary.name === criteria.name)
            && (criteria.minimumLength === undefined
                || (summary.length ?? -1) >= criteria.minimumLength);

        const rejectRequestWaiter = (waiter: RequestWaiter, reason: Error): void => {
            if (!requestWaiters.delete(waiter)) return;
            clearTimeout(waiter.timer);
            waiter.reject(reason);
        };

        const publishRequestReceipt = (summary: RequestSummary) => {
            (window as any).__ngspiceLog.push(summary);
            for (const waiter of [...requestWaiters]) {
                if (!requestMatches(summary, waiter.after, waiter.criteria)) continue;
                requestWaiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(summary);
            }
        };

        const waitForRequestAfter = (
            after: number,
            criteria: RequestCriteria,
            timeoutMs = RECEIPT_TIMEOUT_MS,
        ): CancellableReceipt<RequestSummary> => {
            const rejected = (message: string) => cancellable(
                Promise.reject(new Error(message)),
                () => undefined,
            );
            if (disposed) return rejected('ngspice receipt service was disposed');
            if (!Number.isSafeInteger(after) || after < 0)
                return rejected('request checkpoint must be a non-negative integer');
            if (!criteria || typeof criteria !== 'object')
                return rejected('request receipt criteria must be an object');
            if (criteria.minimumLength !== undefined
                && (!Number.isSafeInteger(criteria.minimumLength)
                    || criteria.minimumLength < 0)) {
                return rejected('minimumLength must be a non-negative integer');
            }
            const timeoutError = validateReceiptTimeout(timeoutMs);
            if (timeoutError) return rejected(timeoutError);
            const log = (window as any).__ngspiceLog as RequestSummary[];
            const existing = log.find((entry) =>
                requestMatches(entry, after, criteria));
            if (existing) return cancellable(Promise.resolve(existing), () => undefined);
            if (requestWaiters.size >= MAX_RECEIPT_WAITERS)
                return rejected('ngspice request receipt waiter capacity exceeded');

            let waiter!: RequestWaiter;
            const promise = new Promise<RequestSummary>((resolve, reject) => {
                waiter = {
                    after,
                    criteria: { ...criteria },
                    resolve,
                    reject,
                    timer: setTimeout(() => rejectRequestWaiter(
                        waiter,
                        new Error(`ngspice request receipt timed out after ${timeoutMs} ms`),
                    ), timeoutMs),
                };
                requestWaiters.add(waiter);
            });
            return cancellable(promise, (reason = 'canceled') => rejectRequestWaiter(
                waiter,
                new Error(`ngspice request receipt ${reason}`),
            ));
        };

        const rejectAppliedGenerationWaiter = (
            waiter: AppliedGenerationWaiter,
            reason: Error,
        ): void => {
            if (!appliedGenerationWaiters.delete(waiter)) return;
            clearTimeout(waiter.timer);
            waiter.reject(reason);
        };

        const waitForAppliedGenerationAfter = (
            after: number,
            timeoutMs = RECEIPT_TIMEOUT_MS,
        ): CancellableReceipt<AppliedGenerationReceipt> => {
            const rejected = (message: string) => cancellable(
                Promise.reject(new Error(message)),
                () => undefined,
            );
            if (disposed) return rejected('ngspice receipt service was disposed');
            if (!Number.isSafeInteger(after) || after < 0)
                return rejected('applied generation checkpoint must be a non-negative integer');
            const timeoutError = validateReceiptTimeout(timeoutMs);
            if (timeoutError) return rejected(timeoutError);
            const existing = appliedGenerations.find((entry) => entry.generation > after);
            if (existing) return cancellable(Promise.resolve(existing), () => undefined);
            if (appliedGenerationWaiters.size >= MAX_RECEIPT_WAITERS)
                return rejected('ngspice applied-generation waiter capacity exceeded');

            let waiter!: AppliedGenerationWaiter;
            const promise = new Promise<AppliedGenerationReceipt>((resolve, reject) => {
                waiter = {
                    after,
                    resolve,
                    reject,
                    timer: setTimeout(() => rejectAppliedGenerationWaiter(
                        waiter,
                        new Error(`ngspice applied generation timed out after ${timeoutMs} ms`),
                    ), timeoutMs),
                };
                appliedGenerationWaiters.add(waiter);
            });
            return cancellable(promise, (reason = 'canceled') => rejectAppliedGenerationWaiter(
                waiter,
                new Error(`ngspice applied-generation receipt ${reason}`),
            ));
        };

        const previousAppliedHook = (globalThis as any).__pcbjamNgspiceFinalRefreshApplied;
        const publishAppliedGeneration = (generation: number): void => {
            if (disposed) return;
            if (!Number.isSafeInteger(generation) || generation < 1) {
                console.error(`[TEST-NGSPICE] ignored invalid applied generation ${generation}`);
                return;
            }
            const previousGeneration = appliedGenerations.length
                ? appliedGenerations[appliedGenerations.length - 1]!.generation
                : 0;
            if (generation <= previousGeneration) {
                console.error(`[TEST-NGSPICE] ignored stale applied generation ${generation}`);
                return;
            }
            const receipt = { generation, t: Date.now() - t0 };
            appliedGenerations.push(receipt);
            for (const waiter of [...appliedGenerationWaiters]) {
                if (generation <= waiter.after) continue;
                appliedGenerationWaiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(receipt);
            }
            if (typeof previousAppliedHook === 'function') previousAppliedHook(generation);
        };
        (globalThis as any).__pcbjamNgspiceFinalRefreshApplied = publishAppliedGeneration;

        interface QueuedEventFrame {
            generation: number;
            evt: any;
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
                retireWorker(
                    slot,
                    `ngspice_service event acknowledgment failed: ${String(error)}`,
                );
                return false;
            }
        };
        const dispatchEvt = (
            slot: WorkerSlot,
            evt: any,
            sequence: number,
            bytes: number,
        ) => {
            if (slot.failed || workerSlot !== slot) return;
            if (!Number.isSafeInteger(sequence) || sequence < 1
                || !Number.isSafeInteger(bytes) || bytes < 1
                || bytes > MAX_QUEUED_EVENT_BYTES) {
                retireWorker(slot, 'ngspice_service sent invalid event-frame credit');
                return;
            }
            const frame = { generation: slot.generation, evt, sequence, bytes };
            (window as any).__ngspiceEvents.push({ ...evt, t: Date.now() - t0 });
            const handler = (globalThis as any).__ngspiceOnEvent;
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
                    retireWorker(slot, 'ngspice_service event-frame queue exceeded credit');
                    return;
                }
                evtQueue.push(frame);
                evtQueueBytes += bytes;
            }
        };

        const failPending = (generation: number, why: string) => {
            for (const [id, request] of pending) {
                if (request.generation !== generation) continue;
                pending.delete(id);
                clearTimeout(request.timer);
                request.resolve({ error: why });
            }
        };

        const retireWorker = (slot: WorkerSlot, why: string) => {
            if (slot.failed) return;
            slot.failed = true;
            retiredGenerations.push(slot.generation);
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
            try { slot.worker?.terminate(); } catch { /* already gone */ }
            if (slot.workerUrl) {
                try { URL.revokeObjectURL(slot.workerUrl); } catch { /* cleanup only */ }
                slot.workerUrl = undefined;
            }
            const reject = slot.rejectBoot;
            slot.rejectBoot = undefined;
            reject?.(new Error(why));
        };

        const ensureWorker = (): Promise<WorkerSlot> => {
            if (disposed) return Promise.reject(new Error('ngspice service was disposed'));
            if (!workerSlot) {
                const slot = {
                    generation: nextGeneration++,
                    failed: false,
                } as WorkerSlot;
                workerSlot = slot;

                const bootDeadline = new Promise<never>((_resolve, reject) => {
                    slot.rejectBoot = reject;
                    slot.bootTimer = setTimeout(() => {
                        if (slot.failed || workerSlot !== slot) return;
                        const why = `ngspice_service boot timed out after ${bootTimeoutMs} ms`;
                        console.log(`[TEST-NGSPICE] ${why} — resetting service`);
                        retireWorker(slot, why);
                    }, bootTimeoutMs);
                });

                const boot = (async () => {
                    const glue = new URL('ngspice_service.js', window.location.href).href;
                    console.log(`[TEST-NGSPICE] booting ngspice_service from ${glue}`);
                    slot.workerUrl = URL.createObjectURL(new Blob(
                        [`self.NGSPICE_GLUE_URL = ${JSON.stringify(glue)};\n`, workerSrc],
                        { type: 'text/javascript' }));
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
                                data.evt,
                                data.eventSequence,
                                data.eventBytes,
                            );
                            return;
                        }
                        if (typeof data.id !== 'number') return;
                        const request = pending.get(data.id);
                        if (request?.generation === slot.generation) {
                            pending.delete(data.id);
                            clearTimeout(request.timer);
                            request.resolve(data.res);
                        }
                    };
                    const failWorker = (detail: string) => {
                        const why = `ngspice_service crashed: ${detail}`;
                        console.log(`[TEST-NGSPICE] worker error: ${detail} — resetting service`);
                        retireWorker(slot, why);
                    };
                    worker.onerror = (e) => failWorker(e.message || 'worker error');
                    slot.failDecode = () => failWorker('message decode failed');
                    worker.onmessageerror = slot.failDecode;
                    if (bootMessageErrorArmed) {
                        bootMessageErrorArmed = false;
                        // Synthetic dispatch on Worker is engine-dependent.
                        // Call the same transition as the real event handler
                        // after rejectBoot is installed below.
                        queueMicrotask(() => slot.failDecode());
                    }
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
                        worker.addEventListener('message', onFirst);
                        slot.removeBootListener = () => worker.removeEventListener('message', onFirst);
                    });

                    if (slot.failed || workerSlot !== slot) {
                        throw new Error('ngspice_service worker retired during boot');
                    }
                    console.log('[TEST-NGSPICE] ngspice_service ready');
                    return slot;
                })();
                slot.ready = Promise.race([boot, bootDeadline]).catch((e) => {
                    retireWorker(slot, `ngspice_service unavailable: ${String(e)}`);
                    throw e;
                });
            }
            return workerSlot.ready;
        };

        const post = (slot: WorkerSlot, req: any): Promise<any> => {
            const worker = slot.worker;
            if (!worker || slot.failed || workerSlot !== slot) {
                return Promise.resolve({ error: 'ngspice_service worker is unavailable' });
            }
            const id = nextId++;
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    if (pending.get(id)?.generation !== slot.generation) return;
                    const why = `ngspice_service response timed out after ${responseTimeoutMs} ms`;
                    console.log(`[TEST-NGSPICE] ${why} — resetting service`);
                    retireWorker(slot, why);
                }, responseTimeoutMs);
                pending.set(id, { generation: slot.generation, resolve, timer });
                let generationPending = 0;
                for (const request of pending.values()) {
                    if (request.generation === slot.generation) generationPending++;
                }
                maxPending = Math.max(maxPending, generationPending);
                try {
                    worker.postMessage({ id, req });
                    if (runtimeMessageErrorThreshold !== null
                        && generationPending >= runtimeMessageErrorThreshold) {
                        runtimeMessageErrorThreshold = null;
                        slot.failDecode();
                    }
                } catch (error) {
                    pending.delete(id);
                    clearTimeout(timer);
                    resolve({ error: `ngspice_service request failed: ${String(error)}` });
                }
            });
        };

        const request = async (req: any) => {
            // Assign at issue time, before worker boot or posting. A late
            // response from a request issued before a new simulation's
            // checkpoint can therefore never satisfy that simulation.
            if (disposed) return { error: 'ngspice service was disposed' };
            const requestSequence = nextRequestSequence++;
            let slot: WorkerSlot;
            try {
                slot = await ensureWorker();
            } catch (e) {
                const res = { error: `ngspice_service unavailable: ${e}` };
                publishRequestReceipt({
                    sequence: requestSequence,
                    kind: String(req.kind),
                    cmd: req.cmd,
                    name: req.name,
                    error: res.error,
                    t: Date.now() - t0,
                });
                return res;
            }
            const res: any = await post(slot, req);
            publishRequestReceipt({
                sequence: requestSequence,
                kind: req.kind,
                cmd: req.cmd,
                name: req.name,
                ret: res?.ret,
                error: res?.error,
                length: res?.length,
                t: Date.now() - t0,
            });
            return res;
        };

        const dispose = (): void => {
            if (disposed) return;
            disposed = true;
            if (workerSlot) retireWorker(workerSlot, 'ngspice service was disposed');
            for (const waiter of [...requestWaiters]) {
                rejectRequestWaiter(waiter, new Error('ngspice request receipt canceled by teardown'));
            }
            for (const waiter of [...appliedGenerationWaiters]) {
                rejectAppliedGenerationWaiter(
                    waiter,
                    new Error('ngspice applied-generation receipt canceled by teardown'),
                );
            }
            if ((globalThis as any).__pcbjamNgspiceFinalRefreshApplied
                === publishAppliedGeneration) {
                (globalThis as any).__pcbjamNgspiceFinalRefreshApplied = previousAppliedHook;
            }
        };

        (globalThis as any).__ngspiceServiceTestHooks = {
            requestCheckpoint() {
                return nextRequestSequence - 1;
            },
            waitForRequestAfter,
            appliedGenerationCheckpoint() {
                return appliedGenerations.length
                    ? appliedGenerations[appliedGenerations.length - 1]!.generation
                    : 0;
            },
            waitForAppliedGenerationAfter,
            dispose,
            messageErrorDuringNextBoot() {
                bootMessageErrorArmed = true;
            },
            messageErrorWhenPendingAtLeast(count: number) {
                if (!Number.isSafeInteger(count) || count < 1)
                    throw new Error('pending threshold must be a positive safe integer');
                runtimeMessageErrorThreshold = count;
            },
            snapshot() {
                return {
                    activeGeneration: workerSlot?.generation ?? null,
                    pending: pending.size,
                    maxPending,
                    retiredGenerations: [...retiredGenerations],
                    bootFaultArmed: bootMessageErrorArmed,
                    runtimeFaultArmed: runtimeMessageErrorThreshold !== null,
                    lastRequestSequence: nextRequestSequence - 1,
                    requestReceiptWaiters: requestWaiters.size,
                    appliedGenerations: appliedGenerations.map((entry) => entry.generation),
                    appliedGenerationWaiters: appliedGenerationWaiters.size,
                    disposed,
                };
            },
        };

        (globalThis as any).ngspiceService = { request };
        window.addEventListener('pagehide', dispose, { once: true });
    }, { workerSrc: NGSPICE_WORKER_SRC, bootTimeoutMs, responseTimeoutMs });
}
