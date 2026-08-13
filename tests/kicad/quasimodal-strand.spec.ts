import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Regression for the doc-19 quasi-modal strand and for execution-owner modal
 * admission. Symbol Properties parks its parent owner behind an exact modal
 * lease. The ownerless test timer is Ordinary work, so it must remain queued
 * while the lease is open. The dialog's exact-scope OK input must bypass that
 * blocked work, close the lease, and resume the parent. The timer can run only
 * after the modal owner retires. This ordering removes the concurrent native
 * park which caused the historical strand.
 */

const SCH = `(kicad_sch
\t(version 20231120)
\t(generator "eeschema")
\t(uuid "cccc0000-0000-0000-0000-000000000001")
\t(paper "A4")
\t(lib_symbols
\t\t(symbol "Device:R"
\t\t\t(pin_numbers (hide yes))
\t\t\t(pin_names (offset 0))
\t\t\t(exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t\t(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(symbol "R_0_1"
\t\t\t\t(rectangle (start -1.016 -2.54) (end 1.016 2.54)
\t\t\t\t\t(stroke (width 0.254) (type default)) (fill (type none)))
\t\t\t)
\t\t\t(symbol "R_1_1"
\t\t\t\t(pin passive line (at 0 3.81 270) (length 1.27)
\t\t\t\t\t(name "~" (effects (font (size 1.27 1.27))))
\t\t\t\t\t(number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -3.81 90) (length 1.27)
\t\t\t\t\t(name "~" (effects (font (size 1.27 1.27))))
\t\t\t\t\t(number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t)
\t(symbol
\t\t(lib_id "Device:R")
\t\t(at 100 100 0)
\t\t(unit 1)
\t\t(exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "dddd0000-0000-0000-0000-000000000002")
\t\t(property "Reference" "R1" (at 102 98 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "10k" (at 102 101 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(instances (project "strand" (path "/cccc0000-0000-0000-0000-000000000001" (reference "R1") (unit 1))))
\t)
)`;

const SYMBOL_UUID = "dddd0000-0000-0000-0000-000000000002";

type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadOpenFileBusy(): boolean;
  kicadCollabGetPos(id: string): Promise<string>;
  kicadCollabGetViewport(): Promise<string>;
  kicadTestArmTimerPark(delayMs: number, parkMs: number): boolean;
  kicadTestTimerParkState(): string;
};
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };

type SchedulerBooks = {
  enqueued: number;
  delivered: number;
  waitsBegun: number;
  waitsResolved: number;
  pendingWaits(kind: string): number;
};

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 120000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabGetPos === "function" &&
        // The parking-timer lever exists in the merged kicad_editor bundle
        // (which eeschema.html serves via --frame=sch) — hard requirement,
        // the staging is built on it.
        typeof m?.kicadTestArmTimerPark === "function"
      );
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: 120000 },
  );
  await page.evaluate(async (sch) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    const dir = "/home/kicad/documents";
    try {
      w.FS.mkdirTree(dir);
    } catch {
      /* exists */
    }
    w.FS.writeFile(`${dir}/strand.kicad_sch`, sch);
    const open = Promise.resolve(w.Module.kicadOpenFile(`${dir}/strand.kicad_sch`));
    await open;
  }, SCH);
  // Completion belongs to the exact open ticket. Busy is a state cross-check,
  // not a substitute that can pass before the queued command starts.
  await expect
    .poll(() => page.evaluate(() => (window.Module as unknown as Mod).kicadOpenFileBusy()), {
      timeout: 120000,
      intervals: [250],
    })
    .toBe(false);
  // The symbol landed and is queryable — the open truly settled.
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (window.Module as unknown as Mod).kicadCollabGetPos(id),
          SYMBOL_UUID,
        ),
      { timeout: 30000, intervals: [250] },
    )
    .toMatch(/^-?[\d.]+,-?[\d.]+$/);
}

/** Screen-space center of the fixture symbol (viewport transform math as
 *  presence-locks-pcbnew.spec.ts). */
async function symbolScreenPos(page: Page): Promise<{ x: number; y: number }> {
  const glId = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
      .map((c) => c as HTMLCanvasElement)
      .find(
        (c) =>
          window.getComputedStyle(c).display !== "none" &&
          c.getBoundingClientRect().width > 0,
      );
    return visible?.id ?? null;
  });
  expect(glId, "a visible GAL canvas (glcanvas-*)").toBeTruthy();
  const box = await page.locator(`#${glId}`).boundingBox();
  expect(box, "canvas bounding box").not.toBeNull();

  const { vp, pos } = await page.evaluate(async (id) => {
    const m = window.Module as unknown as Mod;
    return {
      vp: JSON.parse(await m.kicadCollabGetViewport()) as {
        cx: number;
        cy: number;
        scale: number;
        w: number;
        h: number;
      },
      pos: await m.kicadCollabGetPos(id),
    };
  }, SYMBOL_UUID);
  const [wx, wy] = pos.split(",").map(Number);
  const x = box!.x + (wx - vp.cx) * vp.scale + vp.w / 2;
  const y = box!.y + (wy - vp.cy) * vp.scale + vp.h / 2;
  console.log(
    `[STRAND] canvas=${glId} box=${JSON.stringify(box)} vp=${JSON.stringify(vp)} ` +
      `pos=${pos} -> screen=(${x.toFixed(1)}, ${y.toFixed(1)})`,
  );
  // The point must be inside the canvas or the double-click is aimed at air.
  expect(x, "symbol x inside canvas").toBeGreaterThan(box!.x);
  expect(x, "symbol x inside canvas").toBeLessThan(box!.x + box!.width);
  expect(y, "symbol y inside canvas").toBeGreaterThan(box!.y);
  expect(y, "symbol y inside canvas").toBeLessThan(box!.y + box!.height);
  return { x, y };
}

/** Visible non-file dialogs in the wx element registry (the pre-created
 *  wxFileDialog reads visible at boot — exclude it). */
const dialogCount = (page: Page) =>
  page.evaluate(
    () =>
      window.wxElementRegistry
        .findAll({ visible: true })
        .filter((e) => /Dialog/i.test(e.typeName) && e.typeName !== "wxFileDialog").length,
  );

/** Center of the dialog's OK button (a real DOM button inside the dialog's
 *  window div — import-settings-modal-stack.spec.ts pattern). */
async function okButtonCenter(page: Page): Promise<{ x: number; y: number }> {
  const rect = await page.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll("#window-container button"),
    ).find((b) => (b.textContent ?? "").trim() === "OK");
    if (!btn) return null;
    const r = (btn as HTMLElement).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });
  expect(rect, "the dialog has an OK button").not.toBeNull();
  expect(rect!.w, "OK button has extent").toBeGreaterThan(0);
  return { x: rect!.x, y: rect!.y };
}

/** Open Symbol Properties and queue ownerless Ordinary timer work behind it. */
async function openDialogAndQueueTimer(
  page: Page,
): Promise<{
  timer: { fired: number; done: number; parked: boolean };
  transport: { enqueued: number; delivered: number };
}> {
  const { x, y } = await symbolScreenPos(page);

  await page.mouse.dblclick(x, y);

  // Symbol Properties opens: the edit tool's fiber is now parked in the
  // quasi-modal wait and STAYS parked for as long as the dialog is up.
  await expect
    .poll(() => dialogCount(page), { timeout: 20000, intervals: [250] })
    .toBeGreaterThan(0);

  const before = await page.evaluate(() => {
    const scheduler = (globalThis as unknown as { __wxScheduler: SchedulerBooks })
      .__wxScheduler;
    return { enqueued: scheduler.enqueued, delivered: scheduler.delivered };
  });

  // ParkingTimer has no wxWindow owner. Its timeout is transported to the
  // typed queue, but Ordinary admission must wait for the modal lease to end.
  const armed = await page.evaluate(() =>
    (window.Module as unknown as Mod).kicadTestArmTimerPark(30, 1500),
  );
  expect(armed, "parking timer armed while the dialog is open").toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(
          (baseline) => {
            const scheduler = (
              globalThis as unknown as { __wxScheduler: SchedulerBooks }
            ).__wxScheduler;
            return (
              scheduler.enqueued > baseline.enqueued &&
              scheduler.delivered > baseline.delivered
            );
          },
          before,
        ),
      { timeout: 5000, intervals: [25] },
    )
    .toBe(true);

  const current = await page.evaluate(() => {
    const scheduler = (globalThis as unknown as { __wxScheduler: SchedulerBooks })
      .__wxScheduler;
    return {
      timer: JSON.parse((window.Module as unknown as Mod).kicadTestTimerParkState()),
      transport: {
        enqueued: scheduler.enqueued,
        delivered: scheduler.delivered,
      },
    };
  });
  return {
    timer: current.timer,
    transport: current.transport,
  };
}

test.describe("quasi-modal strand (doc 19)", () => {
  test.describe.configure({ mode: "serial" });

  test("ownerless timer waits for the Symbol Properties modal lease", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(240000);
    await bootAndOpen(page);
    const { timer, transport } = await openDialogAndQueueTimer(page);
    console.log(
      `[STRAND] queued timer: state=${JSON.stringify(timer)} transport=${JSON.stringify(transport)}`,
    );
    expect(timer.fired, "ordinary timer body is blocked by the modal lease").toBe(0);
    expect(timer.done).toBe(0);

    // The dialog is up and its OK button is a real, hittable DOM button.
    expect(await dialogCount(page)).toBeGreaterThan(0);
    const ok = await okButtonCenter(page);
    await page.mouse.click(ok.x, ok.y);
    await expect.poll(() => dialogCount(page), { timeout: 15000 }).toBe(0);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const state = JSON.parse(
              (window.Module as unknown as Mod).kicadTestTimerParkState(),
            ) as { fired: number; done: number };
            return { fired: state.fired, done: state.done };
          }),
        { timeout: 10000, intervals: [100] },
      )
      .toEqual({ fired: 1, done: 1 });

    const overlapBeacons = testLogger.consoleLogs.filter((l) =>
      /\[wx-asyncify\] (concurrent-park|aliased-wake-live|overlapped-wake)/.test(l),
    );
    console.log(`[STRAND] staging overlap beacons: ${overlapBeacons.length}`);
    expect(
      overlapBeacons.length,
      "no concurrent-park window is observable post-flip",
    ).toBe(0);
  });

  test("doc-19: OK resolves the quasi-modal wait and the dialog closes", async ({
    page,
    testLogger,
  }) => {
    // WAS RED (aliased wake → quarantined fiber → refused resume → the dialog
    // could never be closed by a click). GREEN since the quasi-modal's nested
    // event loop stopped running on the tool coroutine's stack: it is bounced
    // onto the main stack, so the coroutine is suspended the legitimate way —
    // a recorded fiber swap — instead of parking its body where the fiber
    // layer cannot see it. This test is now the regression pin for that.
    test.setTimeout(240000);
    await bootAndOpen(page);
    const { timer } = await openDialogAndQueueTimer(page);
    console.log(`[STRAND] blocked timer before close: ${JSON.stringify(timer)}`);
    expect(timer.fired, "unaffiliated Ordinary work stays blocked").toBe(0);

    const ok = await okButtonCenter(page);
    await page.mouse.click(ok.x, ok.y);

    // Give the close its full budget, then REPORT the outcome before
    // asserting — the log should say which end state failed, not merely that
    // one did. (Polling to a boolean never throws; the assertions below are
    // the verdict.)
    const closed = await page
      .waitForFunction(
        () =>
          window.wxElementRegistry
            .findAll({ visible: true })
            .filter((e) => /Dialog/i.test(e.typeName) && e.typeName !== "wxFileDialog")
            .length === 0,
        null,
        { timeout: 15000 },
      )
      .then(() => true, () => false);
    const refusedSoFar = testLogger.consoleLogs.filter((l) =>
      l.includes("fiber-resume-refused"),
    ).length;
    console.log(
      `[STRAND] red outcome: closed=${closed} dialogs=${await dialogCount(page)} ` +
        `refused-resumes=${refusedSoFar}`,
    );

    // Desired end state 1: the dialog closes.
    expect(closed, "OK closed the quasi-modal dialog").toBe(true);

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const state = JSON.parse(
              (window.Module as unknown as Mod).kicadTestTimerParkState(),
            ) as { fired: number; done: number };
            return { fired: state.fired, done: state.done };
          }),
        { timeout: 10000, intervals: [100] },
      )
      .toEqual({ fired: 1, done: 1 });

    // Desired end state 2: no refused fiber resume anywhere in the run.
    const refused = testLogger.consoleLogs.filter((l) =>
      l.includes("fiber-resume-refused"),
    );
    expect(refused, `refused resumes: ${refused.join(" || ")}`).toHaveLength(0);

    // Desired end state 3: the wait books balance — the quasi-modal's
    // "nested" wait was resolved and consumed, nothing left parked.
    const books = await page.evaluate(() => {
      const s = (globalThis as unknown as { __wxScheduler: SchedulerBooks }).__wxScheduler;
      return {
        begun: s.waitsBegun,
        resolved: s.waitsResolved,
        pendingNested: s.pendingWaits("nested"),
        pendingModal: s.pendingWaits("modal"),
      };
    });
    expect(books.pendingNested, "no unresolved nested wait").toBe(0);
    expect(books.pendingModal, "no unresolved modal wait").toBe(0);
    expect(books.resolved, "every begun wait resolved").toBe(books.begun);
  });
});
