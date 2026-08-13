import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { loadBoard } from "./utils/threed-viewer";
import { waitForPcbnew } from "./utils/pcbnew-ready";
import { clickMenuBarItem, clickMenuItemByText } from "../e2e/utils/element-tracker";

/**
 * JSPI coroutine lifecycle in the REAL editor — successor to
 * fiber-resume-park.spec.ts (which pinned the retired Asyncify rewind guard;
 * its beacon string `fiber-resume-refused` no longer exists, making its
 * engagement assert vacuous).
 *
 * The prod-shaped gate for the August 2026 ownership bug: coroutine.h's
 * ~CALL_CONTEXT released a BORROWED context record (the live enterer of a
 * nested dispatch); the JSPI backend read that as destroy-while-parked,
 * killed the record, and the poisoned caller slot made PCB_SELECTION_TOOL's
 * first Wait() dereference the raw -1 refusal: "coroutine 1 entry REJECTED:
 * memory access out of bounds" at boot, then a "[wx-scheduler] job tick
 * error" per tool activation and no dialog ever opening. This walks
 * boot → board load → Place Footprints → chooser opens → Cancel → chooser
 * closes, asserting a zero ghost/deadParked census and no rejection/trap
 * lines at every stage. Deterministically RED on the pre-fix build.
 *
 * (The old spec's mid-park-resume staging lives on as the jspi-coroutine
 * standalone harness, 18 protocol cases in both engines — the doc-15
 * refusal, destroy-while-parked containment, and the phantom-release
 * refusals are pinned there, against the same libcontext.cpp.)
 */

const TRAP_SIGNATURE =
  /Aborted\(|index out of bounds|unreachable executed|indirect call signature|null function or function signature|memory access out of bounds|entry REJECTED|job tick error/;

interface CoroCensus {
  ghosts: number;
  deadParked: number;
  refusedResumes: number;
  quarantines: number;
  parkedCoroutines: string[];
}

function census(page: Page): Promise<CoroCensus> {
  return page.evaluate(() => {
    const L = (globalThis as any).__libctxJspi;
    const S = (globalThis as any).__wxScheduler;
    const ring: [number, string, string, number][] = S?._ring ?? [];
    return {
      ghosts: L?.ghosts ?? -1,
      deadParked: L?.deadParked ?? -1,
      refusedResumes: ring.filter((r) => r[1] === "libctxRefusedResume").length,
      quarantines: ring.filter((r) => r[1] === "libctxQuarantine").length,
      parkedCoroutines: [...(S?._suspended?.keys?.() ?? [])].filter((k: string) =>
        String(k).startsWith("lc"),
      ),
    };
  });
}

// The footprint chooser is a wxFrame, not a wxDialog — count top-level frames
// (same detection as footprint-chooser-close.spec.ts).
function frameCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) =>
        /Frame$/.test(e.typeName || ""),
      ).length,
  );
}

// Synthetic emscripten mouse events on the canvas: a Playwright click is
// intercepted by the wx scrollbar overlay (same helper as
// footprint-chooser-close.spec.ts).
async function synthClick(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([cx, cy]) => {
      const c = document.querySelector("#canvas") as HTMLCanvasElement;
      const opt = (b: number) => ({
        clientX: cx,
        clientY: cy,
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: b,
      });
      c.dispatchEvent(new MouseEvent("mousemove", opt(0)));
      c.dispatchEvent(new MouseEvent("mousedown", opt(1)));
      c.dispatchEvent(new MouseEvent("mouseup", opt(0)));
      c.dispatchEvent(new MouseEvent("click", opt(0)));
    },
    [x, y],
  );
}

test.describe("JSPI coroutine lifecycle (prod-shaped)", () => {
  test("boot, board load and tool activation stay coroutine-clean; chooser opens and cancels", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(240000);
    await page.goto("/kicad/pcbnew.html");
    await waitForPcbnew(page);

    const atBoot = await census(page);
    console.log(`[TEST] boot census: ${JSON.stringify(atBoot)}`);
    expect(atBoot.ghosts, "no ghost/refused transitions at boot").toBe(0);
    expect(atBoot.deadParked, "no coroutine died parked at boot").toBe(0);
    expect(
      atBoot.parkedCoroutines.length,
      "the always-on selection tool is parked in Wait()",
    ).toBeGreaterThan(0);

    // The board load is the historical trigger surface (SetBoard →
    // ResetTools(MODEL_RELOAD) ×2 → wake/dispatch storm over the parked
    // selection tool — where the phantom release fired).
    await loadBoard(page, testLogger);

    const afterLoad = await census(page);
    console.log(`[TEST] after-load census: ${JSON.stringify(afterLoad)}`);
    expect(afterLoad.ghosts, "no ghost transitions across the board load").toBe(0);
    expect(afterLoad.deadParked, "no coroutine died across the board load").toBe(0);

    // Place Footprints via the menu, then a canvas click opens the chooser
    // (the pre-fix build swallowed the activation: no dialog, job tick OOB).
    const framesBefore = await frameCount(page);
    expect(await clickMenuBarItem(page, "Place"), "Place menu findable").toBe(true);
    await clickMenuItemByText(page, "Place Footprints");
    const canvas = (await page.locator("#canvas").boundingBox())!;
    await synthClick(page, Math.round(canvas.width * 0.35), Math.round(canvas.height * 0.45));

    await expect
      .poll(() => frameCount(page), { timeout: 40000, intervals: [200] })
      .toBeGreaterThan(framesBefore);

    const chooserOpen = await census(page);
    console.log(`[TEST] chooser-open census: ${JSON.stringify(chooserOpen)}`);
    expect(chooserOpen.ghosts, "no ghost transitions opening the chooser").toBe(0);
    expect(chooserOpen.deadParked, "no coroutine died opening the chooser").toBe(0);

    // Cancel the quasimodal. NOTE: in the harness the chooser's library
    // enumeration stays parked on its `fp-lib` bridge wait forever (the page
    // installs no `window.kicadLibs` provider), so the CLOSE itself is not
    // assertable here — the same reason footprint-chooser-close.spec.ts
    // soft-waits it. The live app (with a provider) closes on Cancel — probed
    // as part of the 2026-08-13 fix verification. What IS assertable, and
    // what the pre-fix build fails: the census stays clean and the app stays
    // responsive across the whole exercise.
    const cancel = await page.evaluate(() => {
      const btn = (window.wxElementRegistry?.findAll({ visible: true }) ?? []).find(
        (e) => /Button/i.test(e.typeName || "") && /cancel/i.test(e.label || ""),
      );
      return btn ? { x: btn.centerX, y: btn.centerY } : null;
    });
    expect(cancel, "Cancel button found in the chooser").not.toBeNull();
    await synthClick(page, cancel!.x, cancel!.y);

    await expect
      .poll(() => frameCount(page), { timeout: 15000, intervals: [200] })
      .toBe(framesBefore)
      .catch(() =>
        console.log(
          "[TEST] chooser close not observable without a lib provider (fp-lib park) — soft",
        ),
      );

    // Responsiveness after the cancel: a wx timer still gets delivered (the
    // doc-19 dead-app class froze the loop here).
    const firedBefore = await page.evaluate(() => {
      try { return JSON.parse((window as any).Module.kicadTestTimerParkState()).fired as number; }
      catch { return -1; }
    });
    await page.evaluate(() => (window as any).Module.kicadTestArmTimerPark(30, 0));
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            try { return JSON.parse((window as any).Module.kicadTestTimerParkState()).fired as number; }
            catch { return -1; }
          }),
        { timeout: 10000, intervals: [100] },
      )
      .toBeGreaterThan(firedBefore);

    const afterCancel = await census(page);
    console.log(`[TEST] after-cancel census: ${JSON.stringify(afterCancel)}`);
    expect(afterCancel.ghosts, "cancel left no ghost transitions").toBe(0);
    expect(afterCancel.deadParked, "cancel killed no coroutine").toBe(0);

    const trapLines = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) =>
      TRAP_SIGNATURE.test(l),
    );
    expect(trapLines, "no trap/rejection signature anywhere in the run").toEqual([]);
  });
});
