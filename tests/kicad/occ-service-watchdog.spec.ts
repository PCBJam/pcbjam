import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from './fixtures';

/**
 * occ_service boot watchdog (findings E-22): a wedged worker boot — an
 * importScripts hang, pthread spawn wedge, or OOM-kill leaves a worker that
 * never posts `ready` OR `bootError` — must settle the request with a loud
 * boot-timeout report instead of hanging to the spec timeout with zero
 * evidence, and the NEXT request must recover on a fresh generation against
 * the real occ_service.
 *
 * The wedge is a real silent Worker (a data: module that runs nothing), armed
 * one-shot through the harness hook; the recovery half exercises the real
 * occ_service wasm end to end.
 */

test.describe('occ_service boot watchdog', () => {
    test.setTimeout(240000);

    test('a wedged boot settles with a timeout report and the next request recovers', async ({ page }) => {
        await page.goto('/kicad/pcbnew.html', { waitUntil: 'domcontentloaded' });

        const probeBoard = fs.readFileSync(
            path.resolve(__dirname, '..', 'fixtures', 'demo', 'demo.kicad_pcb'),
            'utf8',
        );

        await page.evaluate((boardText: string) => {
            const runtime = globalThis as any;
            runtime.__occServiceTestHooks.wedgeNextBoot(5000);
            runtime.__occWedgeResult = null;
            void runtime.occService.request({
                kind: 'export',
                board: new TextEncoder().encode(boardText),
                jobJson: JSON.stringify({ format: 'step', export_components: false }),
                fileName: 'wedged.step',
            }).then((res: unknown) => { runtime.__occWedgeResult = res; });
        }, probeBoard);

        await expect.poll(
            () => page.evaluate(() => (globalThis as any).__occWedgeResult),
            {
                message: 'the wedged boot must settle via the boot watchdog, not hang',
                timeout: 30000,
            },
        ).toMatchObject({
            ok: false,
            report: expect.stringContaining('boot timed out after 5000 ms'),
        });

        const wedgedState = await page.evaluate(
            () => (globalThis as any).__occServiceTestHooks.snapshot());
        expect(wedgedState.retiredGenerations, 'the wedged generation was retired')
            .toEqual([1]);
        expect(wedgedState.activeGeneration, 'no active generation remains').toBeNull();
        expect(wedgedState.pending, 'nothing left pending').toBe(0);

        // Recovery: the wedge was one-shot — this boots the REAL occ_service
        // and completes a real export through it.
        const recovered = await page.evaluate(async (boardText: string) => {
            const runtime = globalThis as any;
            return await runtime.occService.request({
                kind: 'export',
                board: new TextEncoder().encode(boardText),
                jobJson: JSON.stringify({ format: 'step', export_components: false }),
                fileName: 'recovered.step',
            });
        }, probeBoard);
        expect(recovered.ok, 'the fresh generation must serve the retry').toBe(true);

        const recoveredState = await page.evaluate(
            () => (globalThis as any).__occServiceTestHooks.snapshot());
        expect(recoveredState.workerGenerationsStarted, 'a replacement generation booted')
            .toEqual([1, 2]);
        expect(recoveredState.pending, 'the replacement generation quiesced').toBe(0);

        const exports = await page.evaluate(() => (window as any).__occExports);
        expect(exports, 'the recovery produced a real STEP capture').toHaveLength(1);
        expect(exports[0].magic.startsWith('ISO-10303-21'), 'real STEP bytes').toBe(true);
    });
});
