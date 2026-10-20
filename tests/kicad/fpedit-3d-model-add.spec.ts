import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Page } from './fixtures';
import { clickTab } from '../e2e/utils/element-tracker';
import { editorAction, loadInEditor, openEcc83WithFootprintEditor } from './utils/fpedit-lib';

/**
 * Footprint Properties → 3D Models: a model path loads when its cell is
 * committed, not when the next row is added.
 *
 * The preview fetches a model (S3D_CACHE::load → PCBJAM_3D::EnsureModelFile →
 * kicadLibs.request("ensure", …, "model3d")) whenever a committed path cell
 * rebuilds the scene. In wasm the path cell's editor did not commit when it
 * lost focus, so a pasted path only loaded once "add" committed it on the way
 * to a new empty row.
 */

const FP = 'NoModel';
const BODY = `(footprint "${FP}" (version 20241229) (generator "pcbnew") (layer "F.Cu")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
)
`;

const MODEL_REF = '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl';
const ENSURE_ARG = 'Resistor_SMD.3dshapes/R_0603_1608Metric.wrl';
// VRML parses in-process (a STEP goes to the OCC service worker).
const MODEL_FIXTURE = 'kicad/demos/pic_programmer/libs/3d_shapes/adjustable_rx2v4.wrl';
const MODELS_ROOT_MEMFS = '/pcbjam/3dmodels';

declare global {
    interface Window {
        __modelEnsures?: string[];
        __modelFixtureB64?: string;
    }
}

/** Record every model3d ensure; serve the fixture model for any of them. */
async function installModelProvider(page: Page): Promise<void> {
    const root = path.resolve(__dirname, '..', '..');
    const b64 = fs.readFileSync(path.join(root, MODEL_FIXTURE)).toString('base64');
    await page.evaluate(({ b64, stockDir }) => {
        window.__modelFixtureB64 = b64;
        window.__modelEnsures = [];
        (globalThis as any).kicadLibs = {
            request: async (op: string, _lib: string, arg: string, kind: string) => {
                if (kind !== 'model3d' || op !== 'ensure') return null;
                window.__modelEnsures!.push(arg);
                const bin = atob(window.__modelFixtureB64!);
                const data = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
                const FS = (window as any).FS;
                const dest = `${stockDir}/${arg}`;
                FS.mkdirTree(dest.slice(0, dest.lastIndexOf('/')));
                FS.writeFile(dest, data);
                return dest;
            },
        };
    }, { b64, stockDir: MODELS_ROOT_MEMFS });
}

const ensures = (page: Page) => page.evaluate(() => window.__modelEnsures ?? []);

/** The "add model" button: the left-most bitmap button on the row of
 *  "Configure Paths..." (add, browse, remove sit left to right; none has a
 *  label or tooltip). */
async function addRowButton(page: Page): Promise<{ x: number; y: number }> {
    const btn = await page.evaluate(() => {
        const all = window.wxElementRegistry!.findAll({ visible: true });
        const cfg = all.find((e) => (e.label ?? '').startsWith('Configure Paths'));
        if (!cfg) return null;
        const row = all
            .filter((e) => e.typeName === 'StdBitmapButton' && Math.abs(e.centerY - cfg.centerY) < 4)
            .sort((a, b) => a.centerX - b.centerX);
        return row.length ? { x: row[0].centerX, y: row[0].centerY } : null;
    });
    expect(btn, 'the add-model button').not.toBeNull();
    return btn!;
}

/** The 3D preview: the dialog's visible GL canvas. */
async function previewCanvas(page: Page): Promise<{ x: number; y: number }> {
    const c = await page.evaluate(() => {
        const cs = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 50 && r.height > 50 && r.x > 300);
        const r = cs.sort((a, b) => a.width * a.height - b.width * b.height)[0];
        return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    expect(c, 'the 3D preview canvas').not.toBeNull();
    return c!;
}

const editorInputFocused = (page: Page) =>
    page.evaluate(() => document.activeElement?.tagName === 'INPUT');

test.describe('Footprint Properties → 3D Models: adding a model', () => {
    test.setTimeout(240000);

    test('a pasted path loads when its cell loses focus, once', async ({ page, testLogger }) => {
        await openEcc83WithFootprintEditor(page, testLogger, { [FP]: BODY });
        await installModelProvider(page);
        await loadInEditor(page, FP);
        await editorAction(page, 'pcbnew.ModuleEditor.footprintProperties');
        await expect.poll(() => clickTab(page, '3D Models'), { message: '3D Models tab', timeout: 30000 }).toBe(true);

        // Add a row: its path editor opens empty. Nothing is fetched for it.
        const add = await addRowButton(page);
        await page.mouse.click(add.x, add.y);
        await expect.poll(() => editorInputFocused(page), { message: 'the new row edits its path' }).toBe(true);

        await page.keyboard.type(MODEL_REF);
        expect(await ensures(page), 'nothing fetched for an empty row or while typing').toEqual([]);

        // Leaving the cell commits it: the preview fetches the model, once.
        const preview = await previewCanvas(page);
        await page.mouse.click(preview.x, preview.y);
        await expect.poll(() => ensures(page), { message: 'the model loads on blur', timeout: 30000 })
            .toEqual([ENSURE_ARG]);

        // Adding the next row does not fetch it again.
        await page.mouse.click(add.x, add.y);
        await expect.poll(() => editorInputFocused(page), { message: 'the second row edits its path' }).toBe(true);
        await page.keyboard.press('Escape');
        expect(await ensures(page), 'one fetch in total').toEqual([ENSURE_ARG]);
    });
});
