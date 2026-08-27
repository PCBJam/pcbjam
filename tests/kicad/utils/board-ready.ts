import type { Page } from '@playwright/test';
import { waitForCanvasStable } from '../../e2e/utils/element-tracker';
import { assertNoNativeFailure, findNativeFailure } from './native-failure';

export type { RuntimeLogger } from './native-failure';
import type { RuntimeLogger } from './native-failure';

/**
 * Wait for pcbnew to finish opening a board.
 *
 * Indicators we can rely on with the current wxwidgets-wasm registry:
 *   1. The wxFileDialog ("filedlg") that we used to pick the file disappears.
 *   2. The wxProgressDialog that KiCad pops up during LoadBoard appears and
 *      then disappears — this is the most reliable "load complete" signal
 *      because pcbnew's frame title is set via wxFrame::SetTitle, which the
 *      WASM registry currently does not capture.
 *
 * We accept two terminal states:
 *   - "loaded": progress dialog was seen and then went away while PcbFrame
 *     stays visible (the happy path).
 *   - "no-dialogs": no dialogs are visible after the open command — covers
 *     tiny boards where LoadBoard finishes before the progress dialog paints.
 *
 * Returns a string describing which path completed, for the test log.
 */
export async function waitForBoardLoaded(
    page: Page,
    logger: { consoleLogs: string[]; errors: string[] },
    timeoutMs = 60000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let progressSeen = false;

    while (Date.now() < deadline) {
        // Surface a WASM abort fast — otherwise the progress dialog never
        // goes away and we'd burn the full timeout. KiCad logs the abort
        // line through Module.printErr, which our test logger captures as
        // a console error. We re-read the live arrays each tick.
        const abort = findNativeFailure([...logger.consoleLogs, ...logger.errors]);
        if (abort) {
            throw new Error(`WASM aborted during LoadBoard:\n${abort}`);
        }

        const state = await page.evaluate(() => {
            const registry = window.wxElementRegistry;
            if (!registry) return { ready: false, dialogs: [] as string[], hasProgress: false, hasFileDlg: false };
            const dialogs = registry.findAll({ visible: true })
                .filter((el) => /Dialog/.test(el.typeName))
                .map((el) => el.typeName);
            const hasFileDlg = dialogs.includes('wxFileDialog');
            const hasProgress = dialogs.some((t) => /Progress/.test(t));
            const hasPcbFrame = registry.findAll({ visible: true })
                .some((el) => el.name === 'PcbFrame');
            return {
                ready: hasPcbFrame && !hasFileDlg && !hasProgress,
                dialogs,
                hasProgress,
                hasFileDlg,
            };
        });

        if (state.hasProgress) {
            progressSeen = true;
        }
        if (state.ready) {
            return progressSeen ? 'loaded (progress dialog observed)' : 'loaded (no progress dialog seen)';
        }

        await page.waitForTimeout(200);
    }

    throw new Error(`Timed out waiting for board to load after ${timeoutMs}ms`);
}

function assertExpectedBoard(expectedBoard: string): void {
    if (!expectedBoard.trim()) {
        throw new Error('Expected board identity must not be empty');
    }
}

async function waitForBoardIdentityAndPaint(
    page: Page,
    expectedBoard: string,
    timeoutMs: number,
): Promise<void> {
    assertExpectedBoard(expectedBoard);
    await page.waitForFunction(
        (expected: string) => {
            const titleMatches = document.title.toLocaleLowerCase()
                .includes(expected.toLocaleLowerCase());
            const hasPcbFrame = (window.wxElementRegistry?.findAll({ visible: true }) ?? [])
                .some((element) => element.name === 'PcbFrame');
            return titleMatches && hasPcbFrame;
        },
        expectedBoard,
        { timeout: timeoutMs },
    );
    await waitForCanvasStable(page, '#canvas', { timeout: timeoutMs });
}

/**
 * Use the shell's exact owned-open Promise, then prove document identity and
 * paint. No PcbFrame/no-dialog heuristic is involved. (Ported from the codex
 * line; owner-free — the barrier-based waitForUiBoardReady was NOT taken.)
 */
export async function openBoardProgrammatically(
    page: Page,
    path: string,
    expectedBoard: string,
    logger?: RuntimeLogger,
    timeoutMs = 60000,
): Promise<string> {
    assertExpectedBoard(expectedBoard);
    const opened = await page.evaluate(async (boardPath: string) => {
        const runtime = window as unknown as {
            Module?: { kicadOpenFile?(path: string): Promise<boolean> | boolean };
        };
        if (typeof runtime.Module?.kicadOpenFile !== 'function') {
            throw new Error('Module.kicadOpenFile is not installed');
        }
        return await runtime.Module.kicadOpenFile(boardPath);
    }, path);
    if (opened !== true) {
        throw new Error(`Module.kicadOpenFile did not open ${path}: ${String(opened)}`);
    }
    assertNoNativeFailure(logger, `opening ${expectedBoard}`);
    await waitForBoardIdentityAndPaint(page, expectedBoard, timeoutMs);
    assertNoNativeFailure(logger, `painting ${expectedBoard}`);
    return `opened and painted ${expectedBoard} from exact kicadOpenFile Promise`;
}
