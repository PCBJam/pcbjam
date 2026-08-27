import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { clickMenuBarItem, clickMenuItem, waitForEditorReady, waitForRenderedByLabel, waitUntil } from '../e2e/utils/element-tracker';
import { injectFromSubmodule } from './utils/fs-inject';
import { waitForBoardLoaded } from './utils/board-ready';
import { clickWxButton, openStepExportDialog, waitForMenuItems, dismissReportDialog } from './utils/wx-dialogs';

/**
 * STEP export × 3D model delivery (docs/features/3d-models, 0007): File →
 * Export → STEP must include the board's lib component models.
 *
 * The STEP export runs in the occ_service worker — its own wasm module with
 * its own MEMFS, where the editor's model files are invisible. Delivery
 * (0007): the export request ships the board's prefetched lib model bodies
 * (`models` array — in the app collected via models-bridge from R2/IDB; here
 * mirrored by the harness occ stub against the page's kicadLibs provider),
 * the worker stages them under /pcbjam/3dmodels, and EXPORTER_STEP's
 * staged-model probe (pcbjam_model_fetch.h FindStagedModel) resolves them on
 * a resolver miss.
 *
 * The first test pins the preconditions (board really references lib models,
 * the export chain itself works, the model provider serves any ref) so a
 * failure of the second can only come from the delivery, not the harness.
 */

const KICAD_VERSION_DIR = '10.0';
const PROJECT_DIR_MEMFS = `/home/kicad/documents/kicad/${KICAD_VERSION_DIR}/projects`;

// Same JS-owned MEMFS model root as the standalone models-bridge
// (constants.ts MODELS_3D_ROOT) — where a delivery fix materializes bodies.
const MODELS_ROOT_MEMFS = '/pcbjam/3dmodels';

// Stand-in STEP bytes served for EVERY lib ref (geometry fidelity is
// irrelevant — the assertion is delivery, not looks).
const STEP_FIXTURE = 'kicad/demos/openair-max/Libraries/HRO_TYPE-C-31-M-12.step';

const DEMO = { name: 'pic_programmer', dir: 'pic_programmer', stem: 'pic_programmer' } as const;

declare global {
    interface Window {
        __modelEnsures?: Array<{ op: string; arg: string; kind: string }>;
        __stepFixtureB64?: string;
    }
}

interface ExportCapture {
    name: string;
    size: number;
    magic: string;
    report: string;
    productCount: number;
}

/**
 * Record every model3d bridge request and serve ALL of them from the fixture —
 * the delivery side is never the bottleneck in this spec (mirrors the serveAll
 * stub in 3d-viewer-models.spec.ts).
 */
async function installModelProviderStub(page: Page): Promise<void> {
    const fixtureAbs = path.resolve(__dirname, '..', '..', STEP_FIXTURE);
    await page.evaluate(
        (b64: string) => { window.__stepFixtureB64 = b64; },
        fs.readFileSync(fixtureAbs).toString('base64'),
    );
    await page.evaluate((stockDir: string) => {
        window.__modelEnsures = [];
        (globalThis as any).kicadLibs = {
            request: async (op: string, _lib: string, arg: string, kind: string) => {
                if (kind !== 'model3d') return null;
                window.__modelEnsures!.push({ op, arg, kind });
                console.log(`[TEST-OCC-MODELS] ensure request: ${op} ${arg}`);
                if (op !== 'ensure') return null;

                const b64 = window.__stepFixtureB64!;
                const binary = atob(b64);
                const data = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);

                // Mirror models-bridge.ts ensureModelInMemfs: write under the
                // JS-owned model root, answer with the ABSOLUTE path.
                const FS = (window as any).FS;
                const dest = `${stockDir}/${arg}`;
                FS.mkdirTree(dest.slice(0, dest.lastIndexOf('/')));
                FS.writeFile(dest, data);
                return dest;
            },
        };
    }, MODELS_ROOT_MEMFS);
}

async function loadBoard(page: Page, testLogger: { consoleLogs: string[]; errors: string[] }): Promise<void> {
    const pcbFilename = `${DEMO.stem}.kicad_pcb`;
    const proFilename = `${DEMO.stem}.kicad_pro`;

    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${pcbFilename}`,
        `${PROJECT_DIR_MEMFS}/${pcbFilename}`);
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/${proFilename}`,
        `${PROJECT_DIR_MEMFS}/${proFilename}`);
    // Project-local (${KIPRJMOD}) models — resolvable by the stock resolver in
    // the EDITOR; the worker-side exporter must get them delivered too.
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/libs/3d_shapes/textool_40.wrl`,
        `${PROJECT_DIR_MEMFS}/libs/3d_shapes/textool_40.wrl`);
    await injectFromSubmodule(page, `kicad/demos/${DEMO.dir}/libs/3d_shapes/adjustable_rx2v4.wrl`,
        `${PROJECT_DIR_MEMFS}/libs/3d_shapes/adjustable_rx2v4.wrl`);

    expect(await clickMenuBarItem(page, 'File'), 'File menu should be findable').toBe(true);
    await waitForMenuItems(page);
    // Items register progressively while the popup paints — wait for the one
    // we click (clickMenuItem is single-shot; the >3-items gate isn't enough).
    await waitForRenderedByLabel(page, 'Open...', { elementType: 'menuitem' });
    expect(await clickMenuItem(page, 'Open...'), 'Open… menu item should be findable').toBe(true);

    await page.waitForFunction(() => {
        const registry = window.wxElementRegistry;
        return !!registry && registry.findAll({ visible: true })
            .some((el) => el.typeName === 'wxFileDialog');
    }, null, { timeout: 15000 });
    // Wait for the filename text input to paint (the dialog object exists before its
    // inner controls register; replaces a fixed 1000ms).
    await waitUntil(page, () => {
        const r = window.wxElementRegistry;
        return !!r && r.findAll({ visible: true }).some((el) => el.typeName === 'wxTextCtrl' && el.name === 'text');
    }, 'file dialog filename input');

    const filenameInput = await page.evaluate(() => {
        const registry = window.wxElementRegistry;
        if (!registry) return null;
        const text = registry.findAll({ visible: true })
            .find((el) => el.typeName === 'wxTextCtrl' && el.name === 'text');
        return text ? { x: text.centerX, y: text.centerY } : null;
    });
    expect(filenameInput, 'filename text input should be visible').not.toBeNull();
    if (!filenameInput) throw new Error('filename text input not found');

    await page.mouse.click(filenameInput.x, filenameInput.y);
    // Documented interaction dwells: focus + typed-text registration have no observable signal.
    await page.waitForTimeout(200); // eslint-disable-line -- documented interaction dwell: focus registration has no observable signal
    await page.keyboard.type(pcbFilename);
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: typed-text registration has no observable signal
    await page.keyboard.press('Enter');

    const result = await waitForBoardLoaded(page, testLogger, 60000);
    console.log(`[TEST] ${DEMO.name} board-ready result: ${result}`);
}

/** Drive File → Export → STEP through the (unchanged) dialog; return the capture. */
async function runStepExport(page: Page): Promise<{ exp: ExportCapture; ensures: Array<{ op: string; arg: string }> }> {
    await openStepExportDialog(page);

    expect(await clickWxButton(page, 'Export'), 'Export button click').toBe(true);

    await page.waitForFunction(
        () => ((window as any).__occExports?.length ?? 0) > 0,
        null, { timeout: 180000 });

    const exports = await page.evaluate(() => (window as any).__occExports as ExportCapture[]);
    expect(exports, 'exactly one export captured').toHaveLength(1);
    const ensures = await page.evaluate(() => window.__modelEnsures ?? []);
    return { exp: exports[0], ensures };
}

/** Parse the exporter report's missing-model warnings into lib / project refs. */
function missingModels(report: string): { lib: string[]; project: string[]; other: string[] } {
    const out = { lib: [] as string[], project: [] as string[], other: [] as string[] };
    const re = /Could not add 3D model for [^\n]+\n\s*File not found: ([^\n]+)/g;
    for (let m = re.exec(report); m; m = re.exec(report)) {
        const file = m[1].trim();
        if (file.includes('.3dshapes')) out.lib.push(file);
        else if (file.includes('KIPRJMOD') || file.includes('3d_shapes')) out.project.push(file);
        else out.other.push(file);
    }
    return out;
}

test.describe('STEP export × 3D model delivery', () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240000);

    // GREEN COMPANION — pins every precondition of the red repro below:
    // the board really references lib models, the export chain works end to
    // end, and the report channel carries the exporter's warnings.
    test('export chain works and the board references lib models', async ({ page, testLogger }) => {
        // Precondition: the demo board references ${KICAD*_3DMODEL_DIR} lib
        // models AND ${KIPRJMOD} project models (counted from the source file,
        // so a demo change can't silently hollow out the repro).
        const pcbText = fs.readFileSync(
            path.resolve(__dirname, '..', '..', `kicad/demos/${DEMO.dir}/${DEMO.stem}.kicad_pcb`), 'utf8');
        const libRefs = pcbText.match(/\(model "\$\{KICAD[^"]*\.3dshapes\/[^"]+"/g) ?? [];
        const prjRefs = pcbText.match(/\(model "\$\{KIPRJMOD\}[^"]+"/g) ?? [];
        console.log(`[TEST] board model refs: ${libRefs.length} lib, ${prjRefs.length} project`);
        expect(libRefs.length, 'board must reference lib 3D models').toBeGreaterThan(0);
        expect(prjRefs.length, 'board must reference project-local 3D models').toBeGreaterThan(0);

        await page.goto('/kicad/pcbnew.html');
        await waitForEditorReady(page);
        await installModelProviderStub(page);
        await loadBoard(page, testLogger);

        const { exp, ensures } = await runStepExport(page);

        // The chain itself is healthy: a real STEP came back with a report.
        expect(exp.name, 'download name from the dialog').toMatch(/\.step$/i);
        expect(exp.magic.startsWith('ISO-10303-21'), 'STEP magic').toBe(true);
        expect(exp.size, 'non-trivial STEP body').toBeGreaterThan(10_000);
        expect(exp.productCount, 'PRODUCT entities parsed from the body').toBeGreaterThan(0);

        // Diagnostics for the red test's failure readout.
        const missing = missingModels(exp.report);
        console.log(`[TEST] export report: ${missing.lib.length} lib + ${missing.project.length} project`
            + ` + ${missing.other.length} other missing models;`
            + ` products=${exp.productCount}, size=${exp.size}B,`
            + ` model3d ensure requests during export: ${ensures.length}`);
        for (const f of missing.lib.slice(0, 5)) console.log(`[TEST]   missing lib: ${f}`);
        for (const f of missing.project) console.log(`[TEST]   missing project: ${f}`);

        // Dismiss the export report dialog via its modal lease (the export
        // dialog holds 1; the report raises it to 2).
        await dismissReportDialog(page, 1, 'export report');

        expect(testLogger.errors, 'no page errors during the export flow').toEqual([]);
    });

    // The delivery guard (docs/features/3d-models/0007). Assertions are
    // OUTCOME-level (report + geometry), not tied to a delivery mechanism.
    //
    // Scope: LIB (`.3dshapes`) models — the R2/IDB-delivered kind. The two
    // project-local (${KIPRJMOD}) refs are still dropped (logged by the
    // companion above); asserting their delivery is the 0007 step-4
    // fast-follow.
    test('exported STEP includes the board lib component models', async ({ page, testLogger }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForEditorReady(page);
        await installModelProviderStub(page);
        await loadBoard(page, testLogger);

        const { exp, ensures } = await runStepExport(page);
        const missing = missingModels(exp.report);
        console.log(`[TEST] model3d ensure requests during export: ${ensures.length}`);

        // Every servable lib ref was delivered: none may be dropped from the
        // assembly with a "File not found" report warning.
        expect(missing.lib, 'no lib model may be missing from the export').toEqual([]);

        // The prefetch really crossed the model bridge (the stub serves via
        // kicadLibs, mirroring the app's models-bridge source).
        expect(ensures.length, 'lib bodies were ensured for the export').toBeGreaterThan(0);

        // The assembly carries per-component geometry: many PRODUCT entities,
        // not just the bare board's 2.
        expect(exp.productCount, 'exported STEP contains component products').toBeGreaterThan(5);
    });
});
