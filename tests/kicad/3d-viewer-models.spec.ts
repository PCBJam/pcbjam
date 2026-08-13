import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { clickMenuBarItem, clickMenuItemByText, waitForEditorReady, shotPath } from '../e2e/utils/element-tracker';
import { injectFromSubmodule } from './utils/fs-inject';
import { openBoardProgrammatically } from './utils/board-ready';
import { logThreeDDiag, waitForThreeDRender, waitForThreeDViewerCanvas }
    from './utils/threed-viewer';

/**
 * 3D viewer COMPONENT MODELS e2e (docs/features/3d-models): load pic_programmer,
 * open the 3D viewer, and verify the model-delivery machinery end to end at the
 * KiCad/wasm level:
 *
 *  1. Statically linked format plugins (vrml + oce — upstream loads them via
 *     dlopen, which wasm doesn't have) parse real model files.
 *  2. Project-local models resolve exactly as upstream: the board references
 *     `${KIPRJMOD}/libs/3d_shapes/*.wrl`, injected with the project.
 *  3. The lazy-fetch fallback (S3D_CACHE::load → PCBJAM_3D::EnsureModelFile →
 *     `kicadLibs.request("ensure", …, "model3d")`) asks JS for every
 *     `${KICAD*_3DMODEL_DIR}` ref, with the ref NORMALIZED to
 *     `<lib>.3dshapes/<name>.<ext>` — and a served ref (the stub writes the
 *     bytes into MEMFS and answers "1") then resolves and renders.
 *
 * The stub provider stands in for the standalone's models-bridge (which fetches
 * from the CDN into IDB); here it serves ONE in-repo STEP fixture under a
 * board-referenced name — geometry is a USB-C connector where a DIP-8 socket
 * belongs, which is irrelevant: the assertion is parse+render, not fidelity.
 */

const KICAD_VERSION_DIR = '10.0';
const PROJECT_DIR_MEMFS = `/home/kicad/documents/kicad/${KICAD_VERSION_DIR}/projects`;

// The JS-owned MEMFS root the stub writes model bodies under — the same dir
// the standalone's models-bridge uses (constants.ts MODELS_3D_ROOT). Its exact
// location is immaterial: the ensure protocol answers with the ABSOLUTE path
// and S3D_CACHE loads it directly (env-var expansion never resolves
// ${KICAD*_3DMODEL_DIR} refs in the wasm runtime — see
// docs/features/3d-models/0001).
const MODELS_ROOT_MEMFS = '/pcbjam/3dmodels';

// The board ref the stub provider serves (normalized form the bridge must ask
// for), and the in-repo STEP whose bytes stand in for it.
const SERVED_REF = 'Package_DIP.3dshapes/DIP-8_W7.62mm.step';
const STEP_FIXTURE = 'kicad/demos/openair-max/Libraries/HRO_TYPE-C-31-M-12.step';

const DEMO = { name: 'pic_programmer', dir: 'pic_programmer', stem: 'pic_programmer' } as const;

declare global {
    interface Window {
        __modelEnsures?: Array<{ op: string; arg: string; kind: string }>;
        __stepFixtureB64?: string;
    }
}

/** Record every model3d bridge request; serve SERVED_REF from the fixture. */
async function installModelProviderStub(page: Page, serveAll = false): Promise<void> {
    await page.evaluate(
        ({ stockDir, servedRef, serveAll }) => {
            window.__modelEnsures = [];
            (globalThis as any).kicadLibs = {
                request: async (op: string, _lib: string, arg: string, kind: string) => {
                    if (kind !== 'model3d') return null;
                    window.__modelEnsures!.push({ op, arg, kind });
                    console.log(`[TEST-3D] ensure request: ${op} ${arg}`);
                    if (op !== 'ensure' || (!serveAll && arg !== servedRef)) return null;

                    const b64 = window.__stepFixtureB64!;
                    const binary = atob(b64);
                    const data = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);

                    // Mirror models-bridge.ts ensureModelInMemfs: write under the
                    // JS-owned model root and answer with the ABSOLUTE path —
                    // S3D_CACHE loads it directly (no env-var expansion needed).
                    // @ts-expect-error — Emscripten FS lives on window
                    const FS = (window as any).FS;
                    const dest = `${stockDir}/${arg}`;
                    FS.mkdirTree(dest.slice(0, dest.lastIndexOf('/')));
                    FS.writeFile(dest, data);
                    console.log(`[TEST-3D] served ${arg} → ${dest} (${data.length} bytes)`);
                    return dest;
                },
            };
        },
        { stockDir: MODELS_ROOT_MEMFS, servedRef: SERVED_REF, serveAll },
    );
}

async function loadBoard(page: Page, testLogger: { consoleLogs: string[]; errors: string[] }): Promise<void> {
    const pcbFilename = `${DEMO.stem}.kicad_pcb`;
    const proFilename = `${DEMO.stem}.kicad_pro`;

    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${pcbFilename}`,
        `${PROJECT_DIR_MEMFS}/${pcbFilename}`);
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${proFilename}`,
        `${PROJECT_DIR_MEMFS}/${proFilename}`);
    // Project-local 3D models — the board references them as
    // ${KIPRJMOD}/libs/3d_shapes/<name>.wrl; resolved by the stock resolver, so
    // they must NOT go through the ensure bridge (asserted below).
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/libs/3d_shapes/textool_40.wrl`,
        `${PROJECT_DIR_MEMFS}/libs/3d_shapes/textool_40.wrl`);
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/libs/3d_shapes/adjustable_rx2v4.wrl`,
        `${PROJECT_DIR_MEMFS}/libs/3d_shapes/adjustable_rx2v4.wrl`);

    const result = await openBoardProgrammatically(
        page,
        `${PROJECT_DIR_MEMFS}/${pcbFilename}`,
        DEMO.stem,
        testLogger,
        60000,
    );
    console.log(`[TEST] ${DEMO.name} board-ready result: ${result}`);
}

function countGlCanvases(page: Page): Promise<number> {
    return page.evaluate(() => document.querySelectorAll('canvas[id^="glcanvas-"]').length);
}

async function openThreeDViewer(page: Page, glBefore: number): Promise<number> {
    // Open View → 3D Viewer deterministically; assert the menu path (an Alt+3 fallback
    // would mask a real menu regression).
    expect(await clickMenuBarItem(page, 'View'), 'View menu should be findable').toBe(true);
    await clickMenuItemByText(page, '3D Viewer');

    // 180s (not 60s): CI headroom for the scene build + first raytrace on software WebGL
    // (real GPU ~2s). See threed-viewer.ts openThreeDViewer for the rationale.
    await page.waitForFunction(() => {
        return !!document.querySelector('#window-container [id^="window-"]')
            || document.querySelectorAll('canvas[id^="glcanvas-"]').length > 0;
    }, null, { timeout: 180000 });

    await page.waitForFunction((before: number) =>
        document.querySelectorAll('canvas[id^="glcanvas-"]').length > before,
        glBefore, { timeout: 180000 });

    const glAfter = await countGlCanvases(page);
    console.log(`[TEST] glcanvas count after opening 3D viewer: ${glAfter}`);
    expect(glAfter, 'a new WebGL canvas should appear for the 3D viewer').toBeGreaterThan(glBefore);
    return glAfter;
}

test.describe('3D viewer component models', () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240000);

    test('resolves project models, lazy-fetches lib models via the bridge, renders', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForEditorReady(page);

        // Stash the STEP fixture bytes + install the provider stub BEFORE the
        // viewer can issue any ensure request.
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        const fixtureAbs = path.resolve(__dirname, '..', '..', STEP_FIXTURE);
        await page.evaluate(
            (b64: string) => { window.__stepFixtureB64 = b64; },
            fs.readFileSync(fixtureAbs).toString('base64'),
        );
        await installModelProviderStub(page);
        // (.step models parse in the occ_service worker — the oce3d_Load shadow
        // suspends on globalThis.occService, installed ambiently by fixtures.)

        await loadBoard(page, testLogger);

        const glBefore = await countGlCanvases(page);
        await openThreeDViewer(page, glBefore);
        const viewerCanvasId = await waitForThreeDViewerCanvas(page);

        // The ensure requests fire during the scene BUILD (S3D_CACHE::load), i.e. BEFORE any
        // rendering — wait for the served ref to cross the bridge, then give the rest of the
        // enumeration a moment to flush. Front-loading the bridge assertions keeps the
        // protocol regression signal independent of the render below.
        await page.waitForFunction(
            (ref: string) => (window.__modelEnsures ?? []).some((e) => e.arg === ref),
            SERVED_REF, { timeout: 120000 });
        // Let the rest of the model-enumeration ensures flush after the served ref lands —
        // the total count isn't known up front, so this is a documented settle interval.
        await page.waitForTimeout(3000); // eslint-disable-line -- documented interaction dwell

        // --- bridge assertions (run on CI too) ---------------------------------
        const ensures = await page.evaluate(() => window.__modelEnsures ?? []);
        console.log(`[TEST] ensure requests: ${ensures.length}`);
        for (const e of ensures.slice(0, 30)) console.log(`[TEST]   ${e.op} ${e.arg}`);

        // Every ${KICAD*_3DMODEL_DIR} ref crossed the bridge, normalized.
        const args = ensures.map((e) => e.arg);
        expect(args, 'the served lib ref must cross the bridge normalized')
            .toContain(SERVED_REF);
        expect(args.every((a) => /^[^/${]+\.3dshapes\//.test(a)),
            'every bridge ref is a normalized <lib>.3dshapes/<file> path').toBe(true);
        // Project-local (${KIPRJMOD}) models resolve natively — never bridged.
        expect(args.some((a) => a.includes('textool_40') || a.includes('adjustable_rx2v4')),
            'project-local models must not go through the ensure bridge').toBe(false);
        // Board refs are unique per model file — the C++ memo must not re-ask.
        expect(new Set(args).size, 'ensure requests are deduplicated').toBe(args.length);

        // The served model landed in MEMFS where the resolver looks.
        const servedSize = await page.evaluate(
            ({ stockDir, servedRef }) => {
                // @ts-expect-error — Emscripten FS lives on window
                const FS = (window as any).FS;
                try { return FS.stat(`${stockDir}/${servedRef}`).size as number; }
                catch { return -1; }
            },
            { stockDir: MODELS_ROOT_MEMFS, servedRef: SERVED_REF },
        );
        expect(servedSize, 'served STEP written into the model root').toBeGreaterThan(1000);

        // OCC split: the .step parse runs in the occ_service worker (the oce3d
        // shadow bridges to it) and must SUCCEED — a boot/bridge failure logs
        // 'oce Load FAILED' and silently skips the model, which the render
        // assertions below can miss (hollow green). The worker parse is async
        // relative to the bridge ensures asserted above, so poll for its verdict
        // instead of assuming it already landed.
        await expect.poll(
            () => testLogger.consoleLogs.some((l) => l.includes('oce Load')),
            { timeout: 90000, message: 'the occ_service worker should report the served STEP parse' },
        ).toBe(true);
        const oceLoadLines = testLogger.consoleLogs.filter((l) => l.includes('oce Load'));
        expect(oceLoadLines.some((l) => l.includes('oce Load ok')),
            'the served STEP must parse in the occ_service worker').toBe(true);
        expect(oceLoadLines.some((l) => l.includes('oce Load FAILED')),
            'no oce model parse may fail').toBe(false);

        // Gate on the scene actually being ON the canvas (not a fixed sleep) before
        // reading pixels — see waitForThreeDRender for the all-black-first-frame flake.
        await waitForThreeDRender(page);
        await logThreeDDiag(page, 'models: before screenshot');
        await page.screenshot({ path: shotPath(page, `3d-viewer-models-${DEMO.name}.png`), scale: 'css' });

        // --- render assertion --------------------------------------------------
        const render = await page.evaluate((canvasId) => {
            const el = document.getElementById(canvasId) as HTMLCanvasElement;
            const tmp = document.createElement('canvas');
            tmp.width = el.width;
            tmp.height = el.height;
            // One full-frame read on a CPU-backed canvas, then sample in JS — not 256
            // per-pixel getImageData GPU round-trips (see 3d-viewer.spec.ts for why).
            const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(el, 0, 0);
            const img = ctx.getImageData(0, 0, el.width, el.height).data;
            const colors = new Set<string>();
            for (let i = 0; i < 16; i++) {
                for (let j = 0; j < 16; j++) {
                    const p = (Math.floor(el.height * j / 16) * el.width
                             + Math.floor(el.width * i / 16)) * 4;
                    colors.add(`${img[p]},${img[p + 1]},${img[p + 2]}`);
                }
            }
            return { id: el.id, w: el.width, h: el.height, distinctColors: colors.size,
                     dataUrl: tmp.toDataURL('image/png') };
        }, viewerCanvasId);
        console.log(`[TEST] 3D canvas ${render.id} ${render.w}x${render.h}, distinct colours: ${render.distinctColors}`);
        const b64 = render.dataUrl.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(shotPath(page, `3d-viewer-models-${DEMO.name}-render.png`),
                         Buffer.from(b64, 'base64'));
        expect(render.distinctColors,
            'the 3D viewer canvas should render the board + models, not a blank fill')
            .toBeGreaterThan(8);

        expect(testLogger.errors, 'no page errors during the model flow').toEqual([]);
    });
});
