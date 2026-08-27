import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import * as path from 'path';
import {
    clickByTooltip,
    clickMenuBarItem,
    clickMenuItemByText,
    findByTooltip,
} from '../../e2e/utils/element-tracker';
import { injectFileIntoMemfs } from './fs-inject';

/**
 * Shared eeschema-simulator harness (one copy for eeschema-sim.spec.ts and
 * eeschema-sim-recovery.spec.ts): rectifier project load, Inspect → Simulator
 * open, and the exact applied-generation run driver.
 */

const RECTIFIER_DIR = path.resolve(__dirname, '..', '..', '..',
    'kicad', 'demos', 'simulation', 'rectifier');
const MEMFS_DIR = '/home/kicad/documents/rectifier';
const PROJECT_FILES = ['rectifier.kicad_sch', 'rectifier.kicad_pro', 'diode.mod',
                       'rectifier_schlib.kicad_sym', 'sym-lib-table', 'rectifier.wbk'];

export async function loadRectifier(page: Page): Promise<void> {
    for (const f of PROJECT_FILES)
        await injectFileIntoMemfs(page, path.join(RECTIFIER_DIR, f), `${MEMFS_DIR}/${f}`);

    await page.evaluate(async (sch: string) => {
        await (window as any).Module.kicadOpenFile(sch);
    }, `${MEMFS_DIR}/rectifier.kicad_sch`);

    await expect
        .poll(async () => page.title(), { timeout: 120000 })
        .toMatch(/rectifier/i);
}

/** Open Inspect → Simulator and return the new top-level window's DOM id. */
export async function openSimulator(page: Page): Promise<string> {
    const idsBefore = await page.$$eval('#window-container [id^="window-"]',
        (els) => els.map((e) => e.id));

    expect(await clickMenuBarItem(page, 'Inspect'), 'Inspect menu').toBe(true);
    await clickMenuItemByText(page, 'Simulator');

    await page.waitForFunction((before: string[]) => {
        const ids = Array.from(
            document.querySelectorAll('#window-container [id^="window-"]'),
            (e) => e.id);
        return ids.some((id) => !before.includes(id));
    }, idsBefore, { timeout: 60000 });

    const idsAfter = await page.$$eval('#window-container [id^="window-"]',
        (els) => els.map((e) => e.id));
    const simWin = idsAfter.find((id) => !idsBefore.includes(id));
    expect(simWin, 'simulator window appeared').toBeTruthy();
    return simWin!;
}

/**
 * Poll until the Run Simulation tool is enabled. The Run tool's
 * ENABLE(!simRunning) condition is a wxUpdateUIEvent check, and the WASM port
 * only reliably re-evaluates those when input events pump the loop — nudge
 * the mouse each poll or the toolbar can hold a stale state forever.
 */
export async function waitForRunToolEnabled(page: Page, timeout = 60000): Promise<void> {
    await expect
        .poll(async () => {
            await page.mouse.move(4, 4);
            await page.mouse.move(8, 8);
            const el = await findByTooltip(page, 'Run Simulation', { elementType: 'tool' });
            return !!el && el.enabled;
        }, { message: 'Run Simulation tool must be enabled', timeout })
        .toBe(true);
}

/**
 * Run the loaded workbook's analysis and await the exact native run generation
 * only after its final plot, operating-point, and canvas refresh calls return.
 */
export async function runSimulation(page: Page): Promise<number> {
    // The simulator window div appears while the frame ctor is still
    // suspended in the init RPC; the toolbar registers its tools only after
    // init completes and the frame first paints.
    await waitForRunToolEnabled(page);

    const generationCheckpoint = await page.evaluate(() => {
        const hooks = (globalThis as any).__ngspiceServiceTestHooks;
        if (!hooks || typeof hooks.appliedGenerationCheckpoint !== 'function'
            || typeof hooks.waitForAppliedGenerationAfter !== 'function') {
            throw new Error('exact ngspice applied-generation hooks are missing');
        }
        return hooks.appliedGenerationCheckpoint() as number;
    });

    expect(await clickByTooltip(page, 'Run Simulation', { elementType: 'tool' }),
        'Run tool').toBe(true);

    const appliedReceipt = await page.evaluate(async (after: number) => {
        const hooks = (globalThis as any).__ngspiceServiceTestHooks;
        return await hooks.waitForAppliedGenerationAfter(after, 120000);
    }, generationCheckpoint);
    expect(appliedReceipt.generation, 'the clicked run published a newer applied generation')
        .toBeGreaterThan(generationCheckpoint);

    // The native receipt fires after the final refreshes. Additionally
    // require the scheduler to hold no parked ngspice wait — a stale
    // suspended frame here means the finish path leaked a wait. (The codex
    // line awaited the execution owner's barrier; that machinery does not
    // exist on the JSPI line, and wait drainage is its observable
    // equivalent.)
    await expect.poll(
        () => page.evaluate(() => {
            const scheduler = (globalThis as any).__wxScheduler;
            return scheduler?.pendingWaits?.('ngspice') ?? -1;
        }),
        { message: 'no ngspice wait may stay parked after the applied receipt', timeout: 30000 },
    ).toBe(0);

    // Vector traffic is result validation only. It is deliberately not used as
    // completion evidence because periodic OnSimRefresh(false) pulls can look
    // identical to the final pull at the worker boundary.
    const vectorReceipt = await page.evaluate(() =>
        ((window as any).__ngspiceLog as Array<{
            sequence: number; kind: string; error?: string; length?: number;
        }>).find((entry) => entry.kind === 'get_vec_info'
            && entry.error === undefined
            && (entry.length ?? -1) >= 101) ?? null,
    );
    expect(vectorReceipt, 'the applied run returned a non-trivial successful vector')
        .not.toBeNull();

    return appliedReceipt.generation;
}
