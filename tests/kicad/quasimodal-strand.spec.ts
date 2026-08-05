import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Doc-19 strand red spec (docs/features/async/19, 20 §6 D0, 21 §4).
 *
 * The user-visible bug: Symbol Properties (any quasi-modal opened from a tool
 * action) stops responding — OK/Cancel click, nothing happens, only the
 * titlebar × closes it. Mechanism (doc 19 §4): the tool fiber that owns the
 * dialog parks mid-body in the quasi-modal wait; a concurrent park's wake
 * aliases over its live sleep buffer (`aliased-wake-live`), the stale-fiber
 * guard quarantines it, and the fiber's own legitimate resume is then REFUSED
 * (`fiber-resume-refused`) and dropped. The fiber never completes, the
 * dispatch guard it holds never releases, every later click defers forever.
 *
 * Staging: the strand needs concurrent parks over the dialog's parked fiber.
 * The deterministic lever is the parking timer (wasm/bindings/timer_park.h):
 * arm it so its Notify() parks and wakes while the Symbol Properties fiber is
 * parked — the same overlap Leonardo's warm loads produce by volume dice
 * (docs/features/async/19 §5, gal-refresh lineage).
 *
 * Two tests, deliberately split so the red pin cannot rot into vacuity:
 *  - "staging" is a plain GREEN test: the dialog opens, the timer window
 *    engages (fired + parked + done), the shim observed the overlap. If this
 *    breaks, the harness is broken — loudly, not silently inside a
 *    test.fail() wrapper.
 *  - "OK closes" is the RED pin, marked test.fail(): its assertions are the
 *    desired end state (dialog closes, no refused-resume beacon, wait books
 *    balanced). It goes green at D3 (waits become context yields), at which
 *    point Playwright reports "expected to fail but passed" and the marker
 *    must be removed — the forced flip doc 20 §8 asks for.
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
  kicadOpenFile(p: string): unknown;
  kicadOpenFileBusy(): boolean;
  kicadCollabGetPos(id: string): string;
  kicadCollabGetViewport(): string;
  kicadTestArmTimerPark(delayMs: number, parkMs: number): boolean;
  kicadTestTimerParkState(): string;
};
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };

type SchedulerBooks = {
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
  await page.evaluate((sch) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    const dir = "/home/kicad/documents";
    try {
      w.FS.mkdirTree(dir);
    } catch {
      /* exists */
    }
    w.FS.writeFile(`${dir}/strand.kicad_sch`, sch);
    w.Module.kicadOpenFile(`${dir}/strand.kicad_sch`);
  }, SCH);
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

  const { vp, pos } = await page.evaluate((id) => {
    const m = window.Module as unknown as Mod;
    return {
      vp: JSON.parse(m.kicadCollabGetViewport()) as {
        cx: number;
        cy: number;
        scale: number;
        w: number;
        h: number;
      },
      pos: m.kicadCollabGetPos(id),
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

/** Open Symbol Properties via the real UI path (double-click the symbol) and
 *  run the parking-timer window across the dialog's parked fiber.
 *
 *  NOTE on what this returns: `done` (the timer's park completed) is NOT a
 *  staging invariant — whether a park survives the aliasing is part of the
 *  disease under test, so asserting it would make the harness fail for the
 *  bug's own reason. Only `fired` + `sawParked` prove the window existed. */
async function openDialogAndEngageWindow(
  page: Page,
): Promise<{ timer: { fired: boolean; sawParked: boolean; done: boolean } }> {
  const { x, y } = await symbolScreenPos(page);

  await page.mouse.dblclick(x, y);

  // Symbol Properties opens: the edit tool's fiber is now parked in the
  // quasi-modal wait and STAYS parked for as long as the dialog is up.
  await expect
    .poll(() => dialogCount(page), { timeout: 20000, intervals: [250] })
    .toBeGreaterThan(0);

  // Arm only NOW. Because the fiber's park is open-ended (it ends when the
  // dialog closes, which is what the red pin is about), a timer that fires
  // while the dialog is up necessarily parks ON TOP of it — the overlap is
  // deterministic by construction rather than a race won by luck. (The
  // opener zeroes its interlock slot for the park's duration, so the mailbox
  // delivers the timer instead of deferring it.)
  const armed = await page.evaluate(() =>
    (window.Module as unknown as Mod).kicadTestArmTimerPark(30, 1500),
  );
  expect(armed, "parking timer armed while the dialog is open").toBe(true);

  // Ride the window: fired → (parked) → done. `sawParked` is best-effort —
  // a sample may simply miss a short park — so it is reported, never asserted.
  const timer = await page.evaluate(async () => {
    const m = window.Module as unknown as Mod;
    const stats = { fired: false, sawParked: false, done: false };
    const t0 = performance.now();
    // Bounded ride: exits as soon as the park completes, and stops after the
    // budget if it never does (a park that never completes is a legitimate
    // outcome here — see the note on the caller).
    while (performance.now() - t0 < 12000) {
      const st = JSON.parse(m.kicadTestTimerParkState()) as {
        fired: number;
        done: number;
        parked: boolean;
      };
      if (st.fired > 0) stats.fired = true;
      if (st.parked) stats.sawParked = true;
      if (st.done > 0) {
        stats.done = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return stats;
  });
  return { timer };
}

test.describe("quasi-modal strand (doc 19)", () => {
  test.describe.configure({ mode: "serial" });

  test("staging: Symbol Properties opens and the parked-timer window engages", async ({
    page,
    testLogger,
  }) => {
    test.setTimeout(240000);
    await bootAndOpen(page);
    const { timer } = await openDialogAndEngageWindow(page);
    console.log(`[STRAND] staging timer: ${JSON.stringify(timer)}`);

    // Engagement proofs — without these the red pin below is vacuous.
    // Asserted: the timer FIRED inside the window (monotonic counter, not a
    // sampled state). Not asserted: `done` (whether a park survives is the
    // disease under test) and `sawParked` (a 100 ms sampler can miss a short
    // park); the beacon check below is the sampling-independent overlap proof.
    expect(timer.fired, "parking timer fired while the dialog was open").toBe(true);

    // The dialog is up and its OK button is a real, hittable DOM button.
    expect(await dialogCount(page)).toBeGreaterThan(0);
    await okButtonCenter(page);

    // The overlap actually reached the asyncify layer: the shim must have
    // beaconed at least one concurrent-context event. Silence here means the
    // two parks never coexisted and the red pin below proves nothing.
    const overlapBeacons = testLogger.consoleLogs.filter((l) =>
      /\[wx-asyncify\] (concurrent-park|aliased-wake-live|overlapped-wake)/.test(l),
    );
    console.log(`[STRAND] staging overlap beacons: ${overlapBeacons.length}`);
    expect(
      overlapBeacons.length,
      "the shim observed concurrent asyncify contexts (the doc-19 window)",
    ).toBeGreaterThan(0);
  });

  test("doc-19 red: OK resolves the quasi-modal wait and the dialog closes", async ({
    page,
    testLogger,
  }) => {
    // RED today by the doc-19 strand (aliased wake → quarantined fiber →
    // refused resume → dialog never closes). Goes GREEN at D3 (waits become
    // scheduler-context yields); Playwright then reports "expected to fail
    // but passed" and this marker comes off.
    test.fail();
    test.setTimeout(240000);
    await bootAndOpen(page);
    const { timer } = await openDialogAndEngageWindow(page);
    console.log(`[STRAND] red timer: ${JSON.stringify(timer)}`);
    expect(timer.fired, "the doc-19 window was staged").toBe(true);

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
