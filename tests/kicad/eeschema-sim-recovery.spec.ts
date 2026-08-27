import { test, expect } from './fixtures';
import { clickByTooltip, waitForEditorReady } from '../e2e/utils/element-tracker';
import { FATAL_WASM_PATTERNS, findNativeFailure } from './utils/native-failure';
import {
    loadRectifier,
    openSimulator,
    runSimulation,
    waitForRunToolEnabled,
} from './utils/sim-harness';

/**
 * eeschema simulator worker-death recovery (findings E-10/E-12/E-11): the
 * promise of the out-of-process engine is that a worker death settles
 * everything in flight and the next Run transparently boots a fresh worker.
 * These specs kill (or corrupt) the service at exact points and assert the
 * simulator UI actually recovers:
 *
 *  - E-10: a mid-run worker death must unlatch the client's s_bgRunning
 *    mirror (via the service's synthetic controlled-exit) — otherwise the
 *    Run tool's ENABLE(!simRunning) holds "running" forever and the promised
 *    fresh-worker restart is unreachable for the whole session.
 *  - E-12: a run whose transport dies between launch acceptance and its
 *    RUNNING transition delivers its crash-exit completion — the wasm-only
 *    unowned-event drop must not swallow an owned run's only IDLE.
 *  - E-11: a corrupted worker's oversized get_vec length must be clamped to
 *    the actually-transferred arrays — not copied into the editor heap as a
 *    multi-gigabyte read that traps the instance.
 */

test.describe('eeschema simulator worker-death recovery', () => {
    test.setTimeout(300000);

    test('a mid-run worker death re-enables Run and a rerun succeeds (E-10)', async ({ page, testLogger }) => {
        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        await loadRectifier(page);
        await openSimulator(page);
        await waitForRunToolEnabled(page);
        const checkpoint = await page.evaluate(() => {
            const hooks = (globalThis as any).__ngspiceServiceTestHooks;
            return hooks.appliedGenerationCheckpoint() as number;
        });

        // Start a run and inject the worker death while it is live. The check
        // and the retirement happen in ONE page.evaluate — frames dispatch on
        // the same main thread, so no finish frame can interleave between the
        // "still running" check and the kill. Event scans are scoped past any
        // frame-open activity (workbook plot restoration).
        const eventFloor = await page.evaluate(
            () => ((window as any).__ngspiceEvents as unknown[]).length);
        expect(await clickByTooltip(page, 'Run Simulation', { elementType: 'tool' }),
            'Run tool').toBe(true);

        // Run accepted: the worker's bg started frame arrived.
        await expect.poll(
            () => page.evaluate((floor: number) =>
                ((window as any).__ngspiceEvents as Array<{ kind: string; finished?: boolean }>)
                    .slice(floor)
                    .some((e) => e.kind === 'bg' && e.finished === false), eventFloor),
            { message: 'the run must report bg started', timeout: 60000 },
        ).toBe(true);

        const injected = await page.evaluate((floor: number) => {
            const events = ((window as any).__ngspiceEvents as Array<{
                kind: string; finished?: boolean }>).slice(floor);
            const finishSeen = events.some((e) => e.kind === 'bg' && e.finished === true);
            const retired = (globalThis as any).__ngspiceServiceTestHooks
                .forceRetire('E-10 repro: worker death mid-run');
            return { finishSeen, retired };
        }, eventFloor);
        expect(injected.finishSeen,
            'repro window: the run must still be live when the fault is injected').toBe(false);
        expect(injected.retired, 'the active generation was retired').toBe(true);

        // THE E-10 oracle: without the synthetic controlled-exit the
        // s_bgRunning mirror stays latched true; and without the worker's
        // pre-init read guard the crash-recovery finish parks on a vector
        // pull into the trapped replacement engine — either way this poll
        // times out with the Run tool disabled forever.
        await waitForRunToolEnabled(page);

        // The crashed run's completion was delivered (cursor/finish body ran).
        const crashReceipt = await page.evaluate(async (after: number) => {
            const hooks = (globalThis as any).__ngspiceServiceTestHooks;
            return await hooks.waitForAppliedGenerationAfter(after, 60000);
        }, checkpoint);
        expect(crashReceipt.generation, 'the crashed run applied its completion')
            .toBeGreaterThan(checkpoint);

        // The synthetic exit is visible in the event record.
        const exitSeen = await page.evaluate((floor: number) =>
            ((window as any).__ngspiceEvents as Array<{ kind: string }>)
                .slice(floor)
                .some((e) => e.kind === 'exit'), eventFloor);
        expect(exitSeen, 'a controlled-exit event reached the client').toBe(true);

        // And the promised transparent restart: a full rerun on a fresh
        // worker generation succeeds end to end.
        const rerunGeneration = await runSimulation(page);
        expect(rerunGeneration).toBeGreaterThan(crashReceipt.generation);
        const generations = await page.evaluate(() =>
            (globalThis as any).__ngspiceServiceTestHooks.snapshot());
        expect(generations.retiredGenerations, 'the killed generation was retired')
            .toContain(1);

        expect(findNativeFailure([...testLogger.consoleLogs, ...testLogger.errors]),
            'no wasm abort during the recovery').toBeUndefined();
    });

    test('a launch that dies before RUNNING still delivers its completion (E-12)', async ({ page, testLogger }) => {
        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        await loadRectifier(page);
        await openSimulator(page);
        await waitForRunToolEnabled(page);

        // Arm: the transport dies on the bg_run launch itself — after the
        // native side published its run generation, before any RUNNING
        // transition could fire. The retirement's synthetic exit then
        // delivers this run's ONLY completion. (The arm keys on bg_run
        // specifically, so frame-open plot restoration cannot consume it.)
        const checkpoint = await page.evaluate(() => {
            const hooks = (globalThis as any).__ngspiceServiceTestHooks;
            hooks.dieOnNextBgRun();
            return hooks.appliedGenerationCheckpoint() as number;
        });

        expect(await clickByTooltip(page, 'Run Simulation', { elementType: 'tool' }),
            'Run tool').toBe(true);

        // THE E-12 oracle: on the unfixed build the crash-exit IDLE carries
        // generation 0 (its RUNNING never fired) and is deleted — the owned
        // run's completion never applies and this receipt times out.
        const receipt = await page.evaluate(async (after: number) => {
            const hooks = (globalThis as any).__ngspiceServiceTestHooks;
            return await hooks.waitForAppliedGenerationAfter(after, 60000);
        }, checkpoint);
        expect(receipt.generation, 'the dead launch applied its crash completion')
            .toBeGreaterThan(checkpoint);

        // Recovery stays intact: a rerun on the replacement generation works.
        const rerunGeneration = await runSimulation(page);
        expect(rerunGeneration).toBeGreaterThan(receipt.generation);

        expect(findNativeFailure([...testLogger.consoleLogs, ...testLogger.errors]),
            'no wasm abort during the recovery').toBeUndefined();
    });

    test('a corrupted get_vec length is clamped, not copied out of bounds (E-11)', async ({ page, testLogger }) => {
        await page.goto('/kicad/eeschema.html');
        await waitForEditorReady(page);
        await loadRectifier(page);
        await openSimulator(page);
        await waitForRunToolEnabled(page);

        // Arm BEFORE the run: the next vector pull reports a ~5e8-element
        // length while its arrays stay ~101 elements. (Frame-open plot
        // restoration also pulls vectors; whichever pull the arm hits, the
        // corrupted answer flows through the same client prepare.)
        await page.evaluate(() => {
            (globalThis as any).__ngspiceServiceTestHooks.corruptNextGetVec();
        });

        // THE E-11 oracle: on the unfixed build the client copies v_length
        // doubles from the small buffer. Observed death shape on this build:
        // the 4 GiB std::vector throws an UNHANDLED std::length_error that
        // exits the editor's main loop — the scheduler shuts down and the
        // whole session is dead (an OOB trap is the sibling shape). Fixed,
        // the length clamps to the transferred arrays and the run completes.
        await runSimulation(page);

        const scheduler = await page.evaluate(() => ({
            dead: (globalThis as any).__wxScheduler?.dead === true,
            terminal: (globalThis as any).__wxScheduler?.terminal === true,
        }));
        expect(scheduler.dead,
            'the corrupted vector must not exit the editor main loop').toBe(false);
        expect(scheduler.terminal, 'the editor instance must not be terminal').toBe(false);
        const fatal = findNativeFailure([...testLogger.consoleLogs, ...testLogger.errors]);
        expect(fatal, `no wasm trap from the corrupted vector (patterns: ${
            FATAL_WASM_PATTERNS.join(', ')})`).toBeUndefined();
    });
});
