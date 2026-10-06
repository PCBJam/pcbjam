import { test, expect, type Page } from '@playwright/test';

/**
 * Cross-tab cross-probing e2e (cross-probe 0001): KiCad's own cross-probe
 * (SendCommand → BroadcastChannel → ExecuteRemoteCommand) between the user's
 * schematic and PCB tabs of one project.
 *
 * Unlike tests/web/cross-probe.spec.ts (collab-presence ghost highlights of a
 * PEER's selection), these assert a real selection in the other editor — the
 * native "select in one, show in the other" — and the explicit "Select on PCB"
 * opening the PCB tab when none is open. Focus is not asserted (automation
 * can't observe tab activation); the transport counters stand in for it.
 */

const SCOPE = 'default';

type Mod = {
  kicadCollabTestSelectComponent(): string;
  kicadCollabGetSelectionFull(): string;
  kicadTestRunAction(name: string): boolean;
};
type W = {
  Module: Mod;
  kicadCrossProbeStats?: () => { opened: number; focused: number; notices: number; executed: number };
};

async function waitForEditor(page: Page, titleRe: RegExp): Promise<void> {
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect
    .poll(() => page.title(), { timeout: 120000, intervals: [1000] })
    .toMatch(titleRe);
  // The cross-probe transport joins after identity and is "ready" once the
  // file open settled; the selection hooks come with the wasm.
  await page.waitForFunction(
    () => {
      const w = window as unknown as Partial<W>;
      return (
        typeof w.kicadCrossProbeStats === 'function' &&
        typeof w.Module?.kicadCollabTestSelectComponent === 'function' &&
        typeof w.Module?.kicadTestRunAction === 'function'
      );
    },
    null,
    { timeout: 60000 },
  );
}

const selection = (page: Page) =>
  page.evaluate(
    () => JSON.parse((window as unknown as W).Module.kicadCollabGetSelectionFull()).uuids as string[],
  );

const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as W).kicadCrossProbeStats!());

/** Fail on the old symptom: KiCad's localhost cross-probe socket. */
function watchLocalhostSockets(page: Page): string[] {
  const hits: string[] = [];
  page.on('console', (msg) => {
    if (/localhost:424[234]/.test(msg.text())) hits.push(msg.text());
  });
  page.on('websocket', (ws) => {
    if (/localhost:424[234]/.test(ws.url())) hits.push(ws.url());
  });
  return hits;
}

test.describe('web app — cross-tab cross-probing', () => {
  test('a symbol selected in the schematic gets selected in the open PCB tab', async ({
    page,
    context,
  }) => {
    test.setTimeout(480000); // two full editor boots

    const sch = page;
    const schSockets = watchLocalhostSockets(sch);
    await sch.goto(`/${SCOPE}/projects/demo/demo.kicad_sch`);
    await waitForEditor(sch, /demo — Schematic Editor/i);

    // Opened by hand (not by the schematic tab): reached over the channel only.
    const pcb = await context.newPage();
    const pcbSockets = watchLocalhostSockets(pcb);
    await pcb.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb`);
    await waitForEditor(pcb, /demo — PCB Editor/i);
    expect(await selection(pcb)).toEqual([]);

    const symId = await sch.evaluate(() =>
      (window as unknown as W).Module.kicadCollabTestSelectComponent(),
    );
    expect(symId, 'demo schematic should contain a symbol').toBeTruthy();

    await expect
      .poll(() => selection(pcb), {
        timeout: 20000,
        message: 'the PCB tab never selected the probed footprint',
      })
      .not.toEqual([]);
    expect((await stats(pcb)).executed).toBeGreaterThan(0);
    // A plain selection never opens a tab.
    expect(context.pages()).toHaveLength(2);
    expect((await stats(sch)).opened).toBe(0);

    expect(schSockets).toEqual([]);
    expect(pcbSockets).toEqual([]);
  });

  test('Select on PCB with no PCB tab opens it and selects the footprint there', async ({
    page,
  }) => {
    test.setTimeout(480000);

    const sch = page;
    await sch.goto(`/${SCOPE}/projects/demo/demo.kicad_sch`);
    await waitForEditor(sch, /demo — Schematic Editor/i);
    const schUrl = sch.url();

    const symId = await sch.evaluate(() =>
      (window as unknown as W).Module.kicadCollabTestSelectComponent(),
    );
    expect(symId).toBeTruthy();
    await expect.poll(() => selection(sch), { timeout: 20000 }).toContain(symId);

    const [pcb] = await Promise.all([
      sch.waitForEvent('popup', { timeout: 30000 }),
      sch.evaluate(() =>
        (window as unknown as W).Module.kicadTestRunAction('eeschema.EditorControl.selectOnPCB'),
      ),
    ]);
    await expect(pcb).toHaveURL(/\/default\/projects\/demo\/demo\.kicad_pcb/, { timeout: 30000 });
    await waitForEditor(pcb, /demo — PCB Editor/i);

    // The pending probe is replayed once the board finished opening.
    await expect
      .poll(() => selection(pcb), {
        timeout: 30000,
        message: 'the opened PCB tab never got the pending probe',
      })
      .not.toEqual([]);
    expect(sch.url()).toBe(schUrl);
    expect((await stats(sch)).opened).toBe(1);
  });
});
