import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';

/**
 * Install a REAL `globalThis.occService` provider into a harness page — the
 * same worker-backed occ_service boot the standalone app does, minus the CDN
 * manifest resolution: the harness serves occ_service.{js,wasm} same-origin
 * next to the tool page (tests/scripts/setup-kicad-wasm.sh copies them from
 * output/).
 *
 * The worker-side wrapper is the SHARED source of truth
 * (web/standalone/src/wasm/occ-worker.js — the standalone imports it via vite
 * `?raw`; the harness reads it off disk and injects it verbatim), so the
 * trap-prone boot logic (blob worker + locateFile absolutization + pthread
 * mainScriptUrlOrBlob) cannot drift between app and tests.
 *
 * Differences from the app provider, for assertability:
 *  - export results are captured into window.__occExports (name, size, magic
 *    prefix, the exporter's report text, and a PRODUCT-entity count for STEP
 *    bodies — the per-component geometry signal) instead of triggering a
 *    browser download;
 *  - the app's export model prefetch (occ-service.ts → models-bridge
 *    collectBoardModelFiles) is mirrored against the page's `kicadLibs`
 *    provider: lib refs scanned from the board text are ensured (kind
 *    "model3d"), read back from the editor MEMFS, and shipped as the
 *    request's `models` array. Specs without a kicadLibs stub ship none —
 *    the pre-delivery behavior.
 *  - installed as an init script (kicad fixtures do this for every page), so
 *    it exists from document start on every navigation — standalone parity,
 *    where boot.ts installs the provider whenever the editor bundle boots.
 *
 * The worker fetches occ_service.js lazily on the FIRST request — specs can
 * assert the lazy-load boundary by watching network requests.
 */

const OCC_WORKER_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..',
        'web', 'standalone', 'src', 'wasm', 'occ-worker.js'),
    'utf8');

export interface OccHarnessWatchdogs {
    bootTimeoutMs?: number;
}

export async function installOccServiceStub(
    page: Page,
    watchdogs: OccHarnessWatchdogs = {},
): Promise<void> {
    const bootTimeoutMs = watchdogs.bootTimeoutMs ?? 2 * 60_000;
    if (!Number.isSafeInteger(bootTimeoutMs) || bootTimeoutMs < 1)
        throw new Error('bootTimeoutMs must be a positive safe integer');

    await page.addInitScript((options: { workerSrc: string; bootTimeoutMs: number }) => {
        if ((globalThis as any).occService) return;

        const { workerSrc, bootTimeoutMs } = options;

        (window as any).__occExports = [];

        interface WorkerSlot {
            generation: number;
            worker?: Worker;
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
        }

        let nextGeneration = 1;
        let workerSlot: WorkerSlot | null = null;
        const pending = new Map<number, PendingRequest>();
        let nextId = 1;
        let maxPending = 0;
        let requestsStarted = 0;
        let requestsPosted = 0;
        const workerGenerationsStarted: number[] = [];
        let armedFault: { count: number; report: string } | null = null;
        /** One-shot: the next boot uses a worker that never answers. */
        let wedgeNextBootArmed: { bootTimeoutMs?: number } | null = null;
        const retiredGenerations: number[] = [];

        const pendingInGeneration = (generation: number): number => {
            let count = 0;
            for (const request of pending.values()) {
                if (request.generation === generation) count++;
            }
            return count;
        };

        const failPending = (generation: number, report: string): void => {
            for (const [id, request] of pending) {
                if (request.generation !== generation) continue;
                pending.delete(id);
                request.resolve({ ok: false, report });
            }
        };

        const retireWorker = (slot: WorkerSlot, report: string): void => {
            if (slot.failed) return;
            slot.failed = true;
            retiredGenerations.push(slot.generation);
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
            const reject = slot.rejectBoot;
            slot.rejectBoot = undefined;
            reject?.(new Error(report));
        };

        const maybeTriggerArmedFault = (slot: WorkerSlot): void => {
            if (!armedFault || slot.failed) return;
            if (pendingInGeneration(slot.generation) < armedFault.count) return;
            const { report } = armedFault;
            armedFault = null;
            console.log(`[TEST-OCC] faulting generation ${slot.generation} (messageerror): ${report}`);
            if (slot.worker) {
                // Synthetic dispatch on Worker is engine-dependent. Invoke
                // the exact transition installed as the real event handler.
                slot.failDecode();
            } else {
                retireWorker(slot, report);
            }
        };

        const ensureWorker = (): Promise<WorkerSlot> => {
            if (!workerSlot) {
                const slot = {
                    generation: nextGeneration++,
                    failed: false,
                } as WorkerSlot;
                workerGenerationsStarted.push(slot.generation);
                workerSlot = slot;

                const wedge = wedgeNextBootArmed;
                wedgeNextBootArmed = null;
                const bootDeadlineMs = wedge?.bootTimeoutMs ?? bootTimeoutMs;

                // Legible boot (E-22): a worker DEATH shape that never posts
                // ready OR bootError (importScripts hang, pthread spawn
                // wedge, OOM-kill) used to hang every request until the
                // spec's timeout with zero evidence. Bound the boot — same
                // shape as the ngspice stub and the production service.
                const bootDeadline = new Promise<never>((_resolve, reject) => {
                    slot.rejectBoot = reject;
                    slot.bootTimer = setTimeout(() => {
                        if (slot.failed || workerSlot !== slot) return;
                        const why = `occ_service boot timed out after ${bootDeadlineMs} ms`;
                        console.log(`[TEST-OCC] ${why} — resetting service`);
                        retireWorker(slot, why);
                    }, bootDeadlineMs);
                });

                const boot = (async () => {
                    const glue = new URL('occ_service.js', window.location.href).href;
                    console.log(`[TEST-OCC] booting occ_service from ${glue}`);
                    // A wedged boot is a REAL silent Worker (an empty module:
                    // it boots, runs nothing, never posts ready/bootError) —
                    // the importScripts-hang / pthread-wedge shape, engine
                    // independent.
                    const worker = wedge
                        ? new Worker('data:text/javascript,/* [TEST-OCC] wedged boot */')
                        : new Worker(URL.createObjectURL(new Blob(
                            [`self.OCC_GLUE_URL = ${JSON.stringify(glue)};\n`, workerSrc],
                            { type: 'text/javascript' })));
                    slot.worker = worker;

                    // All fatal transitions settle the boot through the ONE
                    // retirement funnel (which clears the deadline, removes
                    // the boot listener, and rejects the raced promise).
                    worker.onerror = (e) => {
                        const report = `occ_service crashed: ${e.message || 'worker error'}`;
                        console.error(`[TEST-OCC] ${report}; resetting service`);
                        retireWorker(slot, report);
                    };
                    slot.failDecode = () => {
                        const report = 'occ_service transport failed: message decode failed';
                        console.error(`[TEST-OCC] ${report}; resetting service`);
                        retireWorker(slot, report);
                    };
                    worker.onmessageerror = slot.failDecode;
                    worker.onmessage = (e) => {
                        if (slot.failed || workerSlot !== slot) return;
                        const { id, res } = e.data ?? {};
                        if (typeof id !== 'number') return;
                        const request = pending.get(id);
                        if (request?.generation === slot.generation) {
                            pending.delete(id);
                            request.resolve(res);
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
                                retireWorker(slot,
                                    `occ_service boot failed: ${String(e.data.bootError)}`);
                            }
                        };
                        worker.addEventListener('message', onFirst);
                        slot.removeBootListener = () => worker.removeEventListener('message', onFirst);
                    });
                    if (slot.failed || workerSlot !== slot)
                        throw new Error('occ_service worker retired during boot');
                    console.log('[TEST-OCC] occ_service ready');
                    return slot;
                })();

                slot.ready = Promise.race([boot, bootDeadline]).catch((e) => {
                    // A late rejection from a retired generation cannot clear
                    // the replacement slot created by a new request.
                    retireWorker(slot, `occ_service unavailable: ${String(e)}`);
                    throw e;
                });
            }
            return workerSlot.ready;
        };

        // Mirror of the app's collectBoardModelFiles, against the page's
        // kicadLibs provider (the specs' model stub): scan lib refs, ensure
        // each into the editor MEMFS, read the staged bytes back.
        const collectModels = async (boardText: string) => {
            const hook = (globalThis as any).kicadLibs;
            const FS = (window as any).FS;
            if (!hook?.request || !FS) return [];
            const ROOT = '/pcbjam/3dmodels';
            const refs = new Set<string>();
            const re = /\(\s*model\s+"((?:[^"\\]|\\.)*)"/g;
            for (let m = re.exec(boardText); m; m = re.exec(boardText)) {
                const raw = m[1].replace(/\\(.)/g, '$1');
                const lib = raw.match(/^\$[{(](?:[^})]*3DMODEL_DIR|KISYS3DMOD)[})][/\\]+(.+)$/);
                if (lib) refs.add(lib[1]);
            }
            const models: Array<{ path: string; bytes: Uint8Array }> = [];
            const seen = new Set<string>();
            for (const ref of refs) {
                const abs = await hook.request('ensure', '', ref, 'model3d');
                if (typeof abs !== 'string' || !abs.startsWith(`${ROOT}/`) || seen.has(abs)) continue;
                seen.add(abs);
                models.push({ path: abs.slice(ROOT.length + 1), bytes: FS.readFile(abs) });
            }
            console.log(`[TEST-OCC] shipping ${models.length} board model(s) with the export`);
            return models;
        };

        const request = async (req: any) => {
            // Count provider entry before model collection or worker boot. This
            // distinguishes "the wx button reached OCC" from a worker that was
            // already active for some earlier request.
            requestsStarted++;
            if (req.kind === 'export')
                req.models = await collectModels(new TextDecoder().decode(req.board));
            let slot: WorkerSlot;
            try {
                slot = await ensureWorker();
            } catch (e) {
                return { ok: false, report: `occ_service unavailable: ${e}` };
            }
            const worker = slot.worker;
            if (!worker || slot.failed || workerSlot !== slot)
                return { ok: false, report: 'occ_service worker is unavailable' };
            const id = nextId++;
            const transfer = req.kind === 'export'
                ? [req.board.buffer, ...(req.models ?? []).map((m: any) => m.bytes.buffer)]
                : [req.bytes.buffer];
            const res: any = await new Promise((resolve) => {
                pending.set(id, { generation: slot.generation, resolve });
                maxPending = Math.max(maxPending, pendingInGeneration(slot.generation));
                try {
                    worker.postMessage({ id, req }, transfer);
                    requestsPosted++;
                    maybeTriggerArmedFault(slot);
                } catch (error) {
                    pending.delete(id);
                    resolve({ ok: false, report: `occ_service request failed: ${String(error)}` });
                }
            });
            if (req.kind === 'export') {
                if (res.ok && res.bytes?.length) {
                    const magic = new TextDecoder().decode(res.bytes.slice(0, 16));
                    // STEP is a text format: `#n=PRODUCT('name',…)` entities count the
                    // distinct model bodies in the assembly (a bare board exports 1–2;
                    // component models add one each). The anchored `=PRODUCT(` match
                    // excludes PRODUCT_DEFINITION/PRODUCT_CONTEXT relatives.
                    let productCount = -1;
                    if (magic.startsWith('ISO-10303-21')) {
                        const text = new TextDecoder().decode(res.bytes);
                        productCount = (text.match(/=\s*PRODUCT\s*\(/g) ?? []).length;
                    }
                    (window as any).__occExports.push({
                        name: req.fileName || res.fileName,
                        size: res.bytes.length,
                        magic,
                        report: String(res.report ?? ''),
                        productCount,
                    });
                    console.log(`[TEST-OCC] export captured: ${req.fileName} ${res.bytes.length}B "${magic}" products=${productCount}`);
                }
                return { ok: res.ok, report: res.report, fileName: res.fileName };
            }
            return res;
        };

        (globalThis as any).__occServiceTestHooks = {
            /** One-shot: wedge the next boot (silent worker, no ready and no
             *  bootError), optionally shortening that boot's deadline. */
            wedgeNextBoot(bootTimeoutMs?: number) {
                if (bootTimeoutMs !== undefined
                    && (!Number.isSafeInteger(bootTimeoutMs) || bootTimeoutMs < 1))
                    throw new Error('bootTimeoutMs must be a positive safe integer');
                wedgeNextBootArmed = { bootTimeoutMs };
            },
            /** Arm the real Worker's production-parity messageerror handler. */
            messageErrorWhenPendingAtLeast(count: number) {
                if (!Number.isSafeInteger(count) || count < 1)
                    throw new Error('pending threshold must be a positive safe integer');
                armedFault = {
                    count,
                    report: 'occ_service transport failed: message decode failed',
                };
                if (workerSlot) maybeTriggerArmedFault(workerSlot);
            },
            snapshot() {
                return {
                    activeGeneration: workerSlot?.generation ?? null,
                    pending: pending.size,
                    maxPending,
                    requestsStarted,
                    requestsPosted,
                    workerGenerationsStarted: [...workerGenerationsStarted],
                    retiredGenerations: [...retiredGenerations],
                    armed: armedFault !== null,
                };
            },
        };

        (globalThis as any).occService = { request };
    }, { workerSrc: OCC_WORKER_SRC, bootTimeoutMs });
}
