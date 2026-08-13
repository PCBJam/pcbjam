import { test, expect } from './fixtures';
import { waitForUiBoardReady } from './utils/board-ready';

test.describe('board readiness receipts', () => {
    test('a preexisting PcbFrame with no dialogs cannot satisfy a later board open', async ({ page }) => {
        await page.setContent('<canvas id="canvas" width="96" height="64"></canvas>');
        await page.evaluate(() => {
            document.title = 'old-board — PCB Editor';
            const frame = {
                id: 'old-pcb-frame',
                label: '',
                name: 'PcbFrame',
                typeName: 'wxFrame',
                screenX: 0,
                screenY: 0,
                width: 96,
                height: 64,
                centerX: 48,
                centerY: 32,
                parentId: null,
                visible: true,
                enabled: true,
                lastUpdated: 1,
            };
            const elements = new Map([[frame.id, frame]]);
            window.wxElementRegistry = {
                elements,
                version: 1,
                findAll(filter = {}) {
                    return [...elements.values()].filter((element) =>
                        (filter.visible === undefined || element.visible === filter.visible)
                        && (filter.name === undefined || element.name === filter.name)
                    );
                },
                getElement(id: string) { return elements.get(id) ?? null; },
            } as unknown as typeof window.wxElementRegistry;

            const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
            const context = canvas.getContext('2d')!;
            context.fillStyle = '#203040';
            context.fillRect(0, 0, canvas.width, canvas.height);

            let resolveBarrier!: () => void;
            const barrier = new Promise<void>((resolve) => { resolveBarrier = resolve; });
            const runtime = globalThis as typeof globalThis & {
                __wxScheduler: { executionBarrier(): Promise<void> };
                __testBarrierCalls: number;
                __testResolveBarrier: () => void;
            };
            runtime.__testBarrierCalls = 0;
            runtime.__testResolveBarrier = resolveBarrier;
            runtime.__wxScheduler = {
                executionBarrier() {
                    runtime.__testBarrierCalls++;
                    return barrier;
                },
            };
        });

        // This is the state which satisfied the removed heuristic: PcbFrame is
        // already visible and no wxFileDialog or progress dialog exists.
        const oldHeuristicWouldClaimReady = await page.evaluate(() => {
            const visible = window.wxElementRegistry!.findAll({ visible: true });
            return visible.some((element) => element.name === 'PcbFrame')
                && !visible.some((element) => /Dialog/.test(element.typeName));
        });
        expect(oldHeuristicWouldClaimReady).toBe(true);

        let settled = false;
        const readiness = waitForUiBoardReady(
            page,
            { id: 'dialog-created-by-the-new-open' },
            'new-board',
            undefined,
            5000,
        ).finally(() => { settled = true; });

        await expect.poll(() => page.evaluate(() =>
            (globalThis as typeof globalThis & { __testBarrierCalls: number })
                .__testBarrierCalls
        )).toBe(1);
        await Promise.resolve();
        expect(settled, 'the preexisting frame/no-dialog state is not a receipt').toBe(false);

        await page.evaluate(() =>
            (globalThis as typeof globalThis & { __testResolveBarrier: () => void })
                .__testResolveBarrier()
        );
        await expect.poll(() => page.evaluate(() =>
            (globalThis as typeof globalThis & {
                __pcbjamBoardBarriers?: Map<number, { state: string }>;
            }).__pcbjamBoardBarriers?.get(1)?.state
        )).toBe('fulfilled');
        await Promise.resolve();
        expect(settled, 'owner retirement without the expected document is insufficient').toBe(false);

        await page.evaluate(() => {
            document.title = 'new-board — PCB Editor';
            const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
            const context = canvas.getContext('2d')!;
            context.fillStyle = '#80a020';
            context.fillRect(0, 0, canvas.width, canvas.height);
        });
        await expect(readiness).resolves.toContain('loaded new-board');
        expect(settled).toBe(true);
    });
});
