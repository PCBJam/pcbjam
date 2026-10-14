import { test, expect, type Page } from './fixtures';
import { clickTab } from '../e2e/utils/element-tracker';
import { editorAction, loadInEditor, openEcc83WithFootprintEditor } from './utils/fpedit-lib';

/**
 * Footprint Properties → 3D Models: the fields under the model list.
 *
 *  1. Rotation shows and keeps "-90.00°". wxString::Format with a "°" came back
 *     EMPTY in the wasm runtime (musl's default "C" locale cannot convert a wide
 *     char above 0x7F), so the rotation fields were blank, and a blur rewrote
 *     the typed value to "" = 0° (the model jumped away). Fix: wx wasm app.cpp
 *     sets LC_CTYPE to C.UTF-8.
 *  2. Selecting another model and focusing an offset field keeps THAT model's
 *     offset. TEXT_CTRL_EVAL remembered the text it last failed to evaluate
 *     ("2.300000 mm"); ChangeValue() on the model switch did not clear it, and
 *     the next focus restored it, writing model A's offset into model B. Fix:
 *     TEXT_CTRL_EVAL::DoSetValue clears the evaluator.
 *
 * The footprint carries two models (paths need not exist: the fields are what
 * is tested) — A rotated 90° and offset 2.3 mm in X, B at zero.
 */

const FP = 'TwoModels';
const BODY = `(footprint "${FP}" (version 20241229) (generator "pcbnew") (layer "F.Cu")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
  (model "\${KIPRJMOD}/model-a.step" (offset (xyz 2.3 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))
  (model "\${KIPRJMOD}/model-b.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
`;

type Field = { value: string; x: number; y: number };

/** The 3D panel's nine fields (scale X/Y/Z, rotation X/Y/Z, offset X/Y/Z), top to bottom. */
function modelFields(page: Page): Promise<Field[] | null> {
    return page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input.wx-dom-control'))
            .map((i) => i as HTMLInputElement)
            .filter((i) => i.type === 'text' && i.style.display !== 'none' && i.getBoundingClientRect().width > 0);
        // They are the one column of exactly nine text fields sharing a left edge.
        const columns = new Map<number, HTMLInputElement[]>();
        for (const i of inputs) {
            const k = Math.round(i.getBoundingClientRect().x);
            columns.set(k, [...(columns.get(k) ?? []), i]);
        }
        const col = [...columns.values()].find((c) => c.length === 9);
        if (!col) return null;
        return col
            .map((i) => ({ i, r: i.getBoundingClientRect() }))
            .sort((a, b) => a.r.y - b.r.y)
            .map(({ i, r }) => ({ value: i.value, x: r.x + r.width / 2, y: r.y + r.height / 2 }));
    });
}

const ROT_Z = 5;
const OFF_X = 6;

async function field(page: Page, idx: number): Promise<Field> {
    let f: Field[] | null = null;
    await expect.poll(async () => (f = await modelFields(page)) !== null, { message: '3D model fields shown' }).toBe(true);
    return f![idx];
}

/** Click a model row's path cell (selects that model). */
async function selectModel(page: Page, file: string): Promise<void> {
    const cell = await page.evaluate((file) => {
        const c = window.wxElementRegistry!.findAllRendered({ elementType: 'gridcell' })
            .find((e: any) => typeof e.label === 'string' && e.label.endsWith(file));
        return c ? { x: c.centerX, y: c.centerY } : null;
    }, file);
    expect(cell, `model row ${file}`).not.toBeNull();
    await page.mouse.click(cell!.x, cell!.y);
}

async function openModelsTab(page: Page, testLogger: { consoleLogs: string[]; errors: string[] }): Promise<void> {
    await openEcc83WithFootprintEditor(page, testLogger, { [FP]: BODY });
    await loadInEditor(page, FP);
    await editorAction(page, 'pcbnew.ModuleEditor.footprintProperties');
    await expect.poll(() => clickTab(page, '3D Models'), { message: '3D Models tab' }).toBe(true);
}

test.describe('Footprint Properties → 3D Models fields', () => {
    test.setTimeout(240000);

    test('rotation shows "-90.00°" and keeps it after the field loses focus', async ({ page, testLogger }) => {
        await openModelsTab(page, testLogger);

        await expect.poll(async () => (await field(page, ROT_Z)).value, { message: 'model A rotation Z' }).toBe('-90.00°');
        expect((await field(page, 3)).value, 'rotation X').toBe('0.00°');

        const rz = await field(page, ROT_Z);
        await page.mouse.click(rz.x, rz.y);
        await page.keyboard.press('Tab');
        await expect.poll(async () => (await field(page, ROT_Z)).value, { message: 'rotation Z after blur' }).toBe('-90.00°');
    });

    test("switching models keeps the selected model's offset when a field gets focus", async ({ page, testLogger }) => {
        await openModelsTab(page, testLogger);

        // Model A: focus and leave its X offset (the evaluator now holds "2.300000 mm").
        await expect.poll(async () => (await field(page, OFF_X)).value).toBe('2.300000 mm');
        const ax = await field(page, OFF_X);
        await page.mouse.click(ax.x, ax.y);
        await page.keyboard.press('Tab');

        // Model B: its X offset is 0, before AND after the field gets focus.
        await selectModel(page, 'model-b.step');
        await expect.poll(async () => (await field(page, OFF_X)).value, { message: 'model B offset X shown' }).toBe('0.000000 mm');
        const bx = await field(page, OFF_X);
        await page.mouse.click(bx.x, bx.y);
        await expect.poll(async () => (await field(page, OFF_X)).value, { message: 'model B offset X after focus' }).toBe('0.000000 mm');
    });
});
