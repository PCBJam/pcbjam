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

export async function installOccServiceStub(page: Page): Promise<void> {
    await page.addInitScript((workerSrc: string) => {
        if ((globalThis as any).occService) return;

        (window as any).__occExports = [];

        let workerP: Promise<Worker> | null = null;
        const pending = new Map<number, (res: any) => void>();
        let nextId = 1;

        const ensureWorker = (): Promise<Worker> => {
            if (!workerP) {
                workerP = (async () => {
                    const glue = new URL('occ_service.js', window.location.href).href;
                    console.log(`[TEST-OCC] booting occ_service from ${glue}`);
                    const worker = new Worker(URL.createObjectURL(new Blob(
                        [`self.OCC_GLUE_URL = ${JSON.stringify(glue)};\n`, workerSrc],
                        { type: 'text/javascript' })));
                    worker.onmessage = (e) => {
                        const { id, res } = e.data ?? {};
                        if (typeof id !== 'number') return;
                        const resolve = pending.get(id);
                        if (resolve) { pending.delete(id); resolve(res); }
                    };
                    // Legible boot: the old handshake could never reject on a
                    // worker DEATH (importScripts throw, pthread spawn wedge,
                    // OOM-kill) — the promise just hung until the spec's 180s
                    // timeout with zero evidence. Surface worker errors and
                    // bound the boot.
                    await new Promise<void>((resolve, reject) => {
                        const fail = (msg: string) => {
                            clearTimeout(timer);
                            reject(new Error(msg));
                        };
                        const timer = setTimeout(
                            () => fail('[TEST-OCC] occ_service boot timed out after 60s '
                                + '(no ready/bootError from the worker)'), 60000);
                        const onFirst = (e: MessageEvent) => {
                            if (e.data?.ready) {
                                worker.removeEventListener('message', onFirst);
                                clearTimeout(timer);
                                resolve();
                            } else if (e.data?.bootError) {
                                fail(`[TEST-OCC] occ_service bootError: ${e.data.bootError}`);
                            }
                        };
                        worker.addEventListener('message', onFirst);
                        worker.addEventListener('error', (e: any) => fail(
                            `[TEST-OCC] occ_service worker error: ${e?.message ?? e} `
                            + `(${e?.filename ?? '?'}:${e?.lineno ?? '?'})`));
                        worker.addEventListener('messageerror', () => fail(
                            '[TEST-OCC] occ_service worker messageerror (structured clone failed)'));
                    });
                    console.log('[TEST-OCC] occ_service ready');
                    return worker;
                })().catch((e) => { workerP = null; throw e; });
            }
            return workerP;
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
            if (req.kind === 'export')
                req.models = await collectModels(new TextDecoder().decode(req.board));
            let worker: Worker;
            try {
                worker = await ensureWorker();
            } catch (e) {
                return { ok: false, report: `occ_service unavailable: ${e}` };
            }
            const id = nextId++;
            const transfer = req.kind === 'export'
                ? [req.board.buffer, ...(req.models ?? []).map((m: any) => m.bytes.buffer)]
                : [req.bytes.buffer];
            const res: any = await new Promise((resolve) => {
                pending.set(id, resolve);
                worker.postMessage({ id, req }, transfer);
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

        (globalThis as any).occService = { request };
    }, OCC_WORKER_SRC);
}
