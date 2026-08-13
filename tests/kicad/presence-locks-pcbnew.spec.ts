import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * pcbnew selection soft-locks — C++ veto e2e (collab-presence 0007).
 *
 * Seeds the remote lock set directly via kicadCollabSetRemote (`locks` field)
 * and drives REAL input against it:
 *   - a drag-move gesture starting on a locked footprint must not move it
 *     (selectPoint's aOnDrag strip + the move request filter), while the SAME
 *     gesture moves it once the lock clears (the control that proves the
 *     gesture itself works);
 *   - plain selection of a locked item stays possible (inspection semantics);
 *   - kicadCollabReleaseSelection unselects exactly the contested uuids
 *     (the tiebreak-loser path), leaving the rest selected;
 *   - kicadCollabTestGetLocked mirrors the seeded set.
 *
 * The awareness/tiebreak loop lives in TS (unit-tested) and in the two-tab
 * tests/web/locks.spec.ts.
 */

const SEG1 = "44444444-0000-0000-0000-000000000001";
const FP1 = "66666666-0000-0000-0000-000000000001";
const SAMPLE_PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general
\t\t(thickness 1.6)
\t)
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(37 "F.SilkS" user)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "${FP1}")
\t\t(at 100 100)
\t\t(attr smd)
\t\t(fp_rect (start -2 -2) (end 2 2) (layer "F.SilkS") (stroke (width 0.3) (type solid)) (uuid "66666666-0000-0000-0000-0000000000cc"))
\t\t(pad "1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 3 3)
\t\t\t(layers "F.Cu")
\t\t\t(uuid "66666666-0000-0000-0000-0000000000dd")
\t\t)
\t)
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG1}"))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadCollabPresenceStart(): Promise<void>;
  kicadCollabSetRemote(j: string): Promise<void>;
  kicadCollabGetViewport(): Promise<string>;
  kicadCollabGetSelection(): Promise<string>;
  kicadCollabGetPos(id: string): Promise<string>;
  kicadCollabReleaseSelection(uuidsJson: string, holder: string): Promise<void>;
  kicadCollabTestGetLocked(): Promise<string>;
  kicadCollabTestSelectComponent(): Promise<string>;
  kicadCollabTestSelectFirst(): Promise<string>;
  kicadCollabTestClearSelection(): Promise<boolean>;
};
type LocksWindow = {
  FS: FS;
  Module: Mod;
  kicadCollab?: Record<string, unknown>;
};

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabTestGetLocked === "function"
      );
    },
    null,
    { timeout: 90000 },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: 90000 },
  );

  await page.evaluate(
    async ({ content }) => {
      const w = window as unknown as LocksWindow;
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const p = `${dir}/locks.kicad_pcb`;
      w.FS.writeFile(p, content);
      await w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_PCB },
  );

  await expect
    .poll(() => page.title(), { timeout: 60000, intervals: [500] })
    .toMatch(/locks/i);

  await page.evaluate(async () => {
    await (window as unknown as LocksWindow).Module.kicadCollabPresenceStart();
  });
}

/** Seed (or clear) the remote lock set for FP1. */
function setLock(page: Page, locked: boolean): Promise<void> {
  return page.evaluate(
    async ({ fp, locked: isLocked }) => {
      const w = window as unknown as LocksWindow;
      await w.Module.kicadCollabSetRemote(
        JSON.stringify({
          peers: [],
          locks: isLocked ? [{ uuid: fp, name: "bob" }] : [],
        }),
      );
    },
    { fp: FP1, locked },
  );
}

/** The footprint's current screen position via the exported GAL transform. */
async function fpScreenPos(page: Page): Promise<{ x: number; y: number }> {
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
  expect(glId).toBeTruthy();
  const box = await page.locator(`#${glId}`).boundingBox();
  expect(box).toBeTruthy();

  const { vp, pos } = await page.evaluate(async () => {
    const w = window as unknown as LocksWindow;
    return {
      vp: JSON.parse(await w.Module.kicadCollabGetViewport()),
      pos: await w.Module.kicadCollabGetPos("66666666-0000-0000-0000-000000000001"),
    };
  });
  const [wx, wy] = pos.split(",").map(Number);
  return {
    x: box!.x + (wx - vp.cx) * vp.scale + vp.w / 2,
    y: box!.y + (wy - vp.cy) * vp.scale + vp.h / 2,
  };
}

const fpPos = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as LocksWindow).Module.kicadCollabGetPos(
      "66666666-0000-0000-0000-000000000001",
    ),
  );

/**
 * The real pcbnew move flow: click-select the footprint, then the `M` hotkey
 * (pcbnew's default LEFT-DRAG gesture is rubber-band select, not move — the
 * eeschema spec covers the drag-gesture path where dragging DOES move).
 * `M` routes through EDIT_TOOL::Move → RequestSelection → the locked-items
 * client filter — exactly the veto under test. The drop is a click at the
 * offset position.
 */
async function moveViaHotkey(page: Page): Promise<void> {
  const at = await fpScreenPos(page);
  await page.mouse.click(at.x, at.y); // select (allowed — inspection semantics)
  // The click routes through the real selection tool — wait for the selection to
  // actually land before arming the move (the bridge getter is the observable).
  // Depending on zoom the hit lands the footprint OR its pad — either is fine:
  // EDIT_TOOL::Move on a board pad substitutes the parent footprint anyway.
  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabGetSelection())
              .length,
        ),
      { timeout: 10000, message: "click never landed a selection" },
    )
    .toBeGreaterThan(0);
  await page.mouse.move(at.x, at.y);
  await page.keyboard.press("m");
  // Move-tool arming has no JS-observable (and in the locked case the request is
  // vetoed before any state changes — silence IS the expected outcome).
  await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: tool arming
  await page.mouse.move(at.x + 120, at.y + 80, { steps: 10 });
  await page.mouse.click(at.x + 120, at.y + 80); // drop (no-op if move never started)
  // Bounded chance for a wrongful move to surface before the caller's negative
  // position assert; the unlocked control leg proves the gesture via its own poll.
  await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: negative-assert window
  await page.keyboard.press("Escape"); // leave no half-open tool between phases
  await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: tool teardown
}

test("seeded locks are probeable and a locked footprint resists a real move", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(240000);
  await bootAndOpen(page);

  await setLock(page, true);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabTestGetLocked()),
      ),
    )
    .toEqual([{ uuid: FP1, name: "bob" }]);

  // Veto: select + M + drop must leave the locked footprint in place.
  const before = await fpPos(page);
  expect(before).toBeTruthy();
  await moveViaHotkey(page);
  expect(await fpPos(page)).toBe(before);

  // Control: the SAME flow moves it once the lock clears — proving the veto
  // (not a broken gesture) kept it in place above.
  await setLock(page, false);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabTestGetLocked()),
      ),
    )
    .toEqual([]);
  await moveViaHotkey(page);
  await expect
    .poll(() => fpPos(page), {
      timeout: 10000,
      message: "control move never moved the unlocked footprint",
    })
    .not.toBe(before);

  expect(hasAbort(testLogger)).toBe(false);
});

test("a locked item stays selectable for inspection", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  await setLock(page, true);

  // Programmatic select drives the real selection tool (no drag involved).
  const id = await page.evaluate(() =>
    (window as unknown as LocksWindow).Module.kicadCollabTestSelectComponent(),
  );
  expect(id).toBe(FP1);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
      ),
    )
    .toContain(FP1);

  expect(hasAbort(testLogger)).toBe(false);
});

test("ReleaseSelection unselects exactly the contested uuids", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(240000);
  await bootAndOpen(page);

  // Select the footprint plus (if distinct) the first top-level item through
  // the real tool — TestSelectFirst may pick the footprint itself, so assert
  // set-minus semantics rather than counts.
  await page.evaluate(async () => {
    const w = window as unknown as LocksWindow;
    await w.Module.kicadCollabTestSelectComponent();
    await w.Module.kicadCollabTestSelectFirst();
  });
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
      ),
    )
    .toContain(FP1);
  const preRelease: string[] = await page.evaluate(async () =>
    JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
  );

  // Lose the tiebreak on the footprint only.
  await page.evaluate(
    ({ fp }) =>
      (window as unknown as LocksWindow).Module.kicadCollabReleaseSelection(
        JSON.stringify([fp]),
        "bob",
      ),
    { fp: FP1 },
  );

  // Exactly the contested uuid drops; anything else selected survives.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
      ),
    )
    .toEqual(preRelease.filter((u) => u !== FP1));

  expect(hasAbort(testLogger)).toBe(false);
});
