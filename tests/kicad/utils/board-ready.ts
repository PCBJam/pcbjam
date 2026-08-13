import type { Page } from '@playwright/test';
import { waitForCanvasStable } from '../../e2e/utils/element-tracker';

export type RuntimeLogger = { consoleLogs: string[]; errors: string[] };

/** Registry identities which existed before the File -> Open command. */
export type FileDialogCheckpoint = Readonly<{ existingIds: readonly string[] }>;

/** Exact wxFileDialog created causally after one File -> Open command. */
export type FileDialogReceipt = Readonly<{ id: string }>;

type BarrierOutcome = { state: 'pending' | 'fulfilled' | 'rejected'; error?: string };

function assertExpectedBoard(expectedBoard: string): void {
    if (!expectedBoard.trim()) {
        throw new Error('Expected board identity must not be empty');
    }
}

function assertNoNativeFailure(logger: RuntimeLogger | undefined, phase: string): void {
    if (!logger) return;
    const failure = [...logger.consoleLogs, ...logger.errors].find((line) =>
        line.includes('Aborted(')
        || line.includes('RuntimeError: unreachable')
        || line.includes('memory access out of bounds')
    );
    if (failure) throw new Error(`WASM failed during ${phase}:\n${failure}`);
}

/**
 * Take the causal checkpoint immediately before clicking File -> Open.
 *
 * A later wait accepts only a wxFileDialog identity which was not present at
 * this checkpoint. It cannot accidentally attach to an old or unrelated file
 * dialog that happened to be visible already.
 */
export async function checkpointFileDialogs(page: Page): Promise<FileDialogCheckpoint> {
    const existingIds = await page.evaluate(() =>
        (window.wxElementRegistry?.findAll({}) ?? [])
            .filter((element) => element.typeName === 'wxFileDialog')
            .map((element) => element.id)
    );
    return Object.freeze({ existingIds: Object.freeze(existingIds) });
}

/** Wait for and return the exact new wxFileDialog created after a checkpoint. */
export async function waitForNewFileDialog(
    page: Page,
    checkpoint: FileDialogCheckpoint,
    timeoutMs = 15000,
): Promise<FileDialogReceipt> {
    const previous = [...checkpoint.existingIds];
    await page.waitForFunction(
        (oldIds: string[]) => {
            const old = new Set(oldIds);
            return (window.wxElementRegistry?.findAll({ visible: true }) ?? [])
                .some((element) => element.typeName === 'wxFileDialog' && !old.has(element.id));
        },
        previous,
        { timeout: timeoutMs },
    );
    const id = await page.evaluate((oldIds: string[]) => {
        const old = new Set(oldIds);
        return (window.wxElementRegistry?.findAll({ visible: true }) ?? [])
            .find((element) => element.typeName === 'wxFileDialog' && !old.has(element.id))?.id ?? null;
    }, previous);
    if (!id) throw new Error('The new wxFileDialog vanished before its identity was captured');
    return Object.freeze({ id });
}

async function startExecutionBarrier(page: Page, label: string): Promise<number> {
    return page.evaluate((barrierLabel) => {
        type Scheduler = { executionBarrier(label?: string): Promise<void> };
        type Runtime = typeof globalThis & {
            __wxScheduler?: Scheduler;
            __pcbjamBoardBarrierSeq?: number;
            __pcbjamBoardBarriers?: Map<number, BarrierOutcome>;
        };
        const runtime = globalThis as Runtime;
        const scheduler = runtime.__wxScheduler;
        if (!scheduler || typeof scheduler.executionBarrier !== 'function') {
            throw new Error('The public wx executionBarrier is not installed');
        }

        const id = (runtime.__pcbjamBoardBarrierSeq ?? 0) + 1;
        runtime.__pcbjamBoardBarrierSeq = id;
        const barriers = (runtime.__pcbjamBoardBarriers ??= new Map());
        const outcome: BarrierOutcome = { state: 'pending' };
        barriers.set(id, outcome);
        scheduler.executionBarrier(barrierLabel).then(
            () => { outcome.state = 'fulfilled'; },
            (error: unknown) => {
                outcome.state = 'rejected';
                outcome.error = error instanceof Error
                    ? `${error.name}: ${error.message}`
                    : String(error);
            },
        );
        return id;
    }, label);
}

async function awaitExecutionBarrier(page: Page, id: number, timeoutMs: number): Promise<void> {
    try {
        await page.waitForFunction(
            (barrierId: number) => {
                const runtime = globalThis as typeof globalThis & {
                    __pcbjamBoardBarriers?: Map<number, BarrierOutcome>;
                };
                const outcome = runtime.__pcbjamBoardBarriers?.get(barrierId);
                return !!outcome && outcome.state !== 'pending';
            },
            id,
            { timeout: timeoutMs },
        );
        const outcome = await page.evaluate((barrierId: number) => {
            const runtime = globalThis as typeof globalThis & {
                __pcbjamBoardBarriers?: Map<number, BarrierOutcome>;
            };
            return runtime.__pcbjamBoardBarriers?.get(barrierId) ?? null;
        }, id);
        if (!outcome) throw new Error(`Execution barrier ${id} lost its exact receipt`);
        if (outcome.state === 'rejected') {
            throw new Error(`Execution barrier ${id} rejected: ${outcome.error ?? 'unknown error'}`);
        }
    } finally {
        await page.evaluate((barrierId: number) => {
            const runtime = globalThis as typeof globalThis & {
                __pcbjamBoardBarriers?: Map<number, BarrierOutcome>;
            };
            runtime.__pcbjamBoardBarriers?.delete(barrierId);
        }, id).catch(() => undefined);
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
 * Complete a UI File -> Open transaction from exact causal evidence.
 *
 * The barrier is submitted only after the captured file dialog identity is
 * gone. It enters the bounded Ordinary owner lane behind the still-live open
 * transaction. If that transaction opens a progress or warning dialog, the
 * barrier remains queued until the dialog work and the exact open owner have
 * retired; merely hiding the first dialog cannot satisfy this helper.
 */
export async function waitForUiBoardReady(
    page: Page,
    fileDialog: FileDialogReceipt,
    expectedBoard: string,
    logger?: RuntimeLogger,
    timeoutMs = 60000,
): Promise<string> {
    assertExpectedBoard(expectedBoard);
    if (!fileDialog.id) throw new Error('File dialog receipt has no exact identity');

    await page.waitForFunction(
        (dialogId: string) => {
            const registry = window.wxElementRegistry;
            return !!registry && registry.getElement(dialogId) === null;
        },
        fileDialog.id,
        { timeout: timeoutMs },
    );
    assertNoNativeFailure(logger, `closing file dialog ${fileDialog.id}`);

    const barrier = await startExecutionBarrier(page, `File -> Open: ${expectedBoard}`);
    await awaitExecutionBarrier(page, barrier, timeoutMs);
    assertNoNativeFailure(logger, `retiring the ${expectedBoard} open owner`);

    await waitForBoardIdentityAndPaint(page, expectedBoard, timeoutMs);
    assertNoNativeFailure(logger, `painting ${expectedBoard}`);
    return `loaded ${expectedBoard} after dialog ${fileDialog.id} and owner barrier ${barrier}`;
}

/**
 * Use the shell's exact owned-open Promise, then prove document identity and
 * paint. No PcbFrame/no-dialog heuristic is involved.
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
