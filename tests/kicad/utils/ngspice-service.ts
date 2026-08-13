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
 *  - request/response summaries are appended to window.__ngspiceLog.
 *
 * The worker fetches ngspice_service.js lazily on the FIRST request — specs
 * assert the lazy-load boundary by watching network requests.
 */

const NGSPICE_WORKER_SRC = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..',
        'web', 'standalone', 'src', 'wasm', 'ngspice-worker.js'),
    'utf8');

export async function installNgspiceServiceStub(page: Page): Promise<void> {
    await page.addInitScript((workerSrc: string) => {
        if ((globalThis as any).ngspiceService) return;

        const t0 = Date.now();
        (window as any).__ngspiceEvents = [];
        (window as any).__ngspiceLog = [];

        let workerP: Promise<Worker> | null = null;
        const pending = new Map<number, (res: any) => void>();
        let nextId = 1;

        const evtQueue: any[] = [];
        const dispatchEvt = (evt: any) => {
            (window as any).__ngspiceEvents.push({ ...evt, t: Date.now() - t0 });
            const handler = (globalThis as any).__ngspiceOnEvent;
            if (handler) {
                while (evtQueue.length) handler(evtQueue.shift());
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
                    const glue = new URL('ngspice_service.js', window.location.href).href;
                    console.log(`[TEST-NGSPICE] booting ngspice_service from ${glue}`);
                    const worker = new Worker(URL.createObjectURL(new Blob(
                        [`self.NGSPICE_GLUE_URL = ${JSON.stringify(glue)};\n`, workerSrc],
                        { type: 'text/javascript' })));
                    worker.onmessage = (e) => {
                        const data = e.data ?? {};
                        if (data.evt) { dispatchEvt(data.evt); return; }
                        if (typeof data.id !== 'number') return;
                        const resolve = pending.get(data.id);
                        if (resolve) { pending.delete(data.id); resolve(data.res); }
                    };
                    worker.onerror = (e) => {
                        console.log(`[TEST-NGSPICE] worker error: ${e.message} — resetting service`);
                        failAllPending(`ngspice_service crashed: ${e.message}`);
                        workerP = null;
                        try { worker.terminate(); } catch { /* already gone */ }
                    };
                    // Legible boot: bound the handshake and surface worker
                    // death — the bare version hung to the spec timeout with
                    // zero evidence (occ-service.ts has the same guard).
                    await new Promise<void>((resolve, reject) => {
                        const fail = (msg: string) => {
                            clearTimeout(timer);
                            reject(new Error(msg));
                        };
                        const timer = setTimeout(
                            () => fail('[TEST-NGSPICE] ngspice_service boot timed out after '
                                + '60s (no ready/bootError from the worker)'), 60000);
                        const onFirst = (e: MessageEvent) => {
                            if (e.data?.ready) {
                                worker.removeEventListener('message', onFirst);
                                clearTimeout(timer);
                                resolve();
                            } else if (e.data?.bootError) {
                                fail(`[TEST-NGSPICE] ngspice_service bootError: ${e.data.bootError}`);
                            }
                        };
                        worker.addEventListener('message', onFirst);
                        worker.addEventListener('error', (e: any) => fail(
                            `[TEST-NGSPICE] ngspice_service worker error: ${e?.message ?? e} `
                            + `(${e?.filename ?? '?'}:${e?.lineno ?? '?'})`));
                        worker.addEventListener('messageerror', () => fail(
                            '[TEST-NGSPICE] ngspice_service worker messageerror (structured clone failed)'));
                    });
                    console.log('[TEST-NGSPICE] ngspice_service ready');
                    return worker;
                })().catch((e) => { workerP = null; throw e; });
            }
            return workerP;
        };

        const request = async (req: any) => {
            let worker: Worker;
            try {
                worker = await ensureWorker();
            } catch (e) {
                return { error: `ngspice_service unavailable: ${e}` };
            }
            const id = nextId++;
            const res: any = await new Promise((resolve) => {
                pending.set(id, resolve);
                worker.postMessage({ id, req });
            });
            (window as any).__ngspiceLog.push({
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

        (globalThis as any).ngspiceService = { request };
    }, NGSPICE_WORKER_SRC);
}
