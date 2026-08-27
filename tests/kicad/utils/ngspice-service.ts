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
        interface AppliedGenerationReceipt {
            generation: number;
            t: number;
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
        let dieOnNextBgRunArmed = false;
        let corruptNextGetVecArmed = false;
        const retiredGenerations: number[] = [];
        let nextRequestSequence = 1;
        const appliedGenerations: AppliedGenerationReceipt[] = [];
        let disposed = false;

        const validateReceiptTimeout = (timeoutMs: number): string | undefined => {
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
                || timeoutMs > MAX_RECEIPT_TIMEOUT_MS) {
                return `receipt timeout must be an integer from 1 to ${MAX_RECEIPT_TIMEOUT_MS} ms`;
            }
            return undefined;
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

        interface ReceiptWaiter<TReceipt, TCriteria> {
            after: number;
            criteria: TCriteria;
            resolve: (receipt: TReceipt) => void;
            reject: (reason?: unknown) => void;
            timer: ReturnType<typeof setTimeout>;
        }

        /**
         * One scan-then-subscribe receipt channel (shared by the request and
         * applied-generation receipts, which differ only in their match
         * predicate, existing-receipt scan, and error strings): scan the
         * already-published receipts first, otherwise subscribe a bounded,
         * timed waiter — so a receipt cannot land in the gap between an array
         * scan and listener installation.
         */
        const makeReceiptChannel = <TReceipt, TCriteria>(channel: {
            validate: (after: number, criteria: TCriteria) => string | undefined;
            /** Defensive copy of the criteria, taken only after validation. */
            snapshotCriteria?: (criteria: TCriteria) => TCriteria;
            scanExisting: (after: number, criteria: TCriteria) => TReceipt | undefined;
            matches: (receipt: TReceipt, after: number, criteria: TCriteria) => boolean;
            capacityError: string;
            timeoutError: (timeoutMs: number) => string;
        }) => {
            const waiters = new Set<ReceiptWaiter<TReceipt, TCriteria>>();
            const rejectWaiter = (
                waiter: ReceiptWaiter<TReceipt, TCriteria>,
                reason: Error,
            ): void => {
                if (!waiters.delete(waiter)) return;
                clearTimeout(waiter.timer);
                waiter.reject(reason);
            };
            return {
                wait(after: number, criteria: TCriteria, timeoutMs: number): Promise<TReceipt> {
                    if (disposed)
                        return Promise.reject(new Error('ngspice receipt service was disposed'));
                    const invalid = channel.validate(after, criteria)
                        ?? validateReceiptTimeout(timeoutMs);
                    if (invalid) return Promise.reject(new Error(invalid));
                    const existing = channel.scanExisting(after, criteria);
                    if (existing) return Promise.resolve(existing);
                    if (waiters.size >= MAX_RECEIPT_WAITERS)
                        return Promise.reject(new Error(channel.capacityError));
                    const held = channel.snapshotCriteria
                        ? channel.snapshotCriteria(criteria) : criteria;
                    return new Promise<TReceipt>((resolve, reject) => {
                        const waiter: ReceiptWaiter<TReceipt, TCriteria> = {
                            after,
                            criteria: held,
                            resolve,
                            reject,
                            timer: setTimeout(() => rejectWaiter(
                                waiter,
                                new Error(channel.timeoutError(timeoutMs)),
                            ), timeoutMs),
                        };
                        waiters.add(waiter);
                    });
                },
                publish(receipt: TReceipt): void {
                    for (const waiter of [...waiters]) {
                        if (!channel.matches(receipt, waiter.after, waiter.criteria)) continue;
                        waiters.delete(waiter);
                        clearTimeout(waiter.timer);
                        waiter.resolve(receipt);
                    }
                },
                drain(reason: string): void {
                    for (const waiter of [...waiters]) rejectWaiter(waiter, new Error(reason));
                },
                size: () => waiters.size,
            };
        };

        const requestReceipts = makeReceiptChannel<RequestSummary, RequestCriteria>({
            validate: (after, criteria) => {
                if (!Number.isSafeInteger(after) || after < 0)
                    return 'request checkpoint must be a non-negative integer';
                if (!criteria || typeof criteria !== 'object')
                    return 'request receipt criteria must be an object';
                if (criteria.minimumLength !== undefined
                    && (!Number.isSafeInteger(criteria.minimumLength)
                        || criteria.minimumLength < 0)) {
                    return 'minimumLength must be a non-negative integer';
                }
                return undefined;
            },
            snapshotCriteria: (criteria) => ({ ...criteria }),
            scanExisting: (after, criteria) => ((window as any).__ngspiceLog as RequestSummary[])
                .find((entry) => requestMatches(entry, after, criteria)),
            matches: requestMatches,
            capacityError: 'ngspice request receipt waiter capacity exceeded',
            timeoutError: (timeoutMs) =>
                `ngspice request receipt timed out after ${timeoutMs} ms`,
        });

        const appliedReceipts = makeReceiptChannel<AppliedGenerationReceipt, undefined>({
            validate: (after) => (!Number.isSafeInteger(after) || after < 0)
                ? 'applied generation checkpoint must be a non-negative integer'
                : undefined,
            scanExisting: (after) => appliedGenerations.find((entry) => entry.generation > after),
            matches: (receipt, after) => receipt.generation > after,
            capacityError: 'ngspice applied-generation waiter capacity exceeded',
            timeoutError: (timeoutMs) =>
                `ngspice applied generation timed out after ${timeoutMs} ms`,
        });

        const publishRequestReceipt = (summary: RequestSummary) => {
            (window as any).__ngspiceLog.push(summary);
            requestReceipts.publish(summary);
        };

        const waitForRequestAfter = (
            after: number,
            criteria: RequestCriteria,
            timeoutMs = RECEIPT_TIMEOUT_MS,
        ): Promise<RequestSummary> => requestReceipts.wait(after, criteria, timeoutMs);

        const waitForAppliedGenerationAfter = (
            after: number,
            timeoutMs = RECEIPT_TIMEOUT_MS,
        ): Promise<AppliedGenerationReceipt> => appliedReceipts.wait(after, undefined, timeoutMs);

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
            appliedReceipts.publish(receipt);
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
                // Mirrors the production service: the host owns the frame's
                // credit from onmessage on, so the ack survives a throwing
                // handler (which keeps propagating).
                try {
                    while (evtQueue.length) {
                        const queued = evtQueue.shift()!;
                        evtQueueBytes -= queued.bytes;
                        if (queued.generation !== slot.generation) continue;
                        // Queued frames were acked at enqueue (ownership taken then).
                        handler(queued.evt);
                    }
                    handler(evt);
                } finally {
                    ackEvent(slot, frame);
                }
            } else {
                if (evtQueue.length >= MAX_QUEUED_EVENT_FRAMES
                    || evtQueueBytes > MAX_QUEUED_EVENT_BYTES - bytes) {
                    retireWorker(slot, 'ngspice_service event-frame queue exceeded credit');
                    return;
                }
                evtQueue.push(frame);
                evtQueueBytes += bytes;
                // Enqueueing IS taking ownership (mirrors the production
                // service): release the transport credit so a pre-handler
                // stream cannot starve the worker's window.
                ackEvent(slot, frame);
            }
        };

        // Mirrors the production service: the worker's terminal notice carries
        // the deferred frames it had already accepted — deliver best-effort,
        // in order, WITHOUT acking (the fatal frame is outside the credit
        // protocol), and record them for the specs like any live frame.
        const deliverTerminalEvents = (entries: unknown): void => {
            if (!Array.isArray(entries) || entries.length === 0) return;
            const handler = (globalThis as any).__ngspiceOnEvent;
            for (const entry of entries) {
                const evt = (entry as { evt?: any } | null)?.evt;
                if (!evt) continue;
                (window as any).__ngspiceEvents.push({ ...evt, t: Date.now() - t0 });
                if (!handler) continue;
                try {
                    handler(evt);
                } catch (error) {
                    console.log(`[TEST-NGSPICE] terminal event delivery failed: ${String(error)}`);
                }
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
            console.log(`[TEST-NGSPICE] retiring generation ${slot.generation}: ${why}`);
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

            // Mirrors the production service (E-10): a retired worker emits
            // no bg/exit frame of its own, so synthesize the controlled-exit
            // the crashed engine could not send — straight to the installed
            // handler, never through dispatchEvt (no fabricated credit).
            const handler = (globalThis as any).__ngspiceOnEvent;
            if (handler) {
                (window as any).__ngspiceEvents.push({
                    kind: 'exit', status: 1, immediate: true, quit: false,
                    t: Date.now() - t0,
                });
                try {
                    handler({ kind: 'exit', status: 1, immediate: true, quit: false });
                } catch (error) {
                    console.log(`[TEST-NGSPICE] synthetic exit dispatch failed: ${String(error)}`);
                }
            }
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
                            deliverTerminalEvents(data.pendingEvents);
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
            // Armed fault: the transport dies on the bg_run launch itself —
            // AFTER the native side published its run generation, BEFORE any
            // RUNNING transition could fire (the E-12 window). Retirement
            // runs the production funnel (and its synthetic exit).
            if (dieOnNextBgRunArmed && req.kind === 'command'
                && typeof req.cmd === 'string' && req.cmd.startsWith('bg_run')) {
                dieOnNextBgRunArmed = false;
                console.log('[TEST-NGSPICE] armed fault: transport death on bg_run');
                const res = {
                    error: 'ngspice_service crashed: transport died on bg_run (armed fault)',
                };
                if (workerSlot) retireWorker(workerSlot, res.error);
                publishRequestReceipt({
                    sequence: requestSequence,
                    kind: req.kind,
                    cmd: req.cmd,
                    error: res.error,
                    t: Date.now() - t0,
                });
                return res;
            }
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
            // Armed fault: corrupt the next get_vec_info answer's LENGTH field
            // only (the arrays stay small) — the corrupted-worker shape the
            // sharedspice client must clamp against.
            if (corruptNextGetVecArmed && req.kind === 'get_vec_info'
                && res && !res.error) {
                corruptNextGetVecArmed = false;
                console.log('[TEST-NGSPICE] armed fault: inflating get_vec_info length');
                res.length = 1 << 29;
            }
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
            requestReceipts.drain('ngspice request receipt canceled by teardown');
            appliedReceipts.drain('ngspice applied-generation receipt canceled by teardown');
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
            /** Retire the active generation through the production funnel
             *  (the same retireWorker every watchdog/onerror path uses). */
            forceRetire(reason: string): boolean {
                const slot = workerSlot;
                if (!slot) return false;
                retireWorker(slot, String(reason || 'forced retirement'));
                return true;
            },
            /** One-shot: the transport dies on the next bg_run launch (the
             *  generation retires through the production funnel before any
             *  RUNNING transition can fire). */
            dieOnNextBgRun() {
                dieOnNextBgRunArmed = true;
            },
            /** One-shot: the next successful get_vec_info answer reports a
             *  huge vector length while its arrays stay small. */
            corruptNextGetVec() {
                corruptNextGetVecArmed = true;
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
                    requestReceiptWaiters: requestReceipts.size(),
                    appliedGenerations: appliedGenerations.map((entry) => entry.generation),
                    appliedGenerationWaiters: appliedReceipts.size(),
                    disposed,
                };
            },
        };

        (globalThis as any).ngspiceService = { request };
        window.addEventListener('pagehide', dispose, { once: true });
    }, { workerSrc: NGSPICE_WORKER_SRC, bootTimeoutMs, responseTimeoutMs });
}
