import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * eeschema selection soft-locks — C++ veto e2e (collab-presence 0007, #47).
 * Mirror of presence-locks-pcbnew.spec.ts: eeschema has NO native item-lock
 * plumbing (the itemPassesFilter lock branch is #if 0), so each mutating tool
 * trims remote-held items from its selection (PCBJAM_SCH_REMOTE_LOCK::Trim):
 * a selected locked wire must not move, rotate or delete, the infobar names
 * the holder, the same drag moves it unlocked, and ReleaseSelection strips
 * exactly the contested uuid. The last test drags while a wx dispatch chain
 * is parked: the queued gesture must replay as a drag, not a click.
 */

const WIRE1 = "22222222-0000-0000-0000-000000000001";
const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${WIRE1}"))
\t(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000002"))
\t(sheet_instances (path "/" (page "1")))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadTestArmTimerPark(delayMs: number, parkMs: number): boolean;
  kicadTestTimerParkState(): string;
  kicadOpenFileBusy(): boolean;
  kicadCollabPresenceStart(): void;
  kicadCollabSetRemote(j: string): void;
  kicadCollabGetViewport(): string;
  kicadCollabGetSelection(): string;
  kicadCollabGetPos(id: string): string;
  kicadCollabReleaseSelection(uuidsJson: string, holder: string): void;
  kicadCollabTestGetLocked(): string;
  kicadCollabTestSelectFirst(): string;
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
  await page.goto("/kicad/eeschema.html");
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
    ({ content }) => {
      const w = window as unknown as LocksWindow;
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const p = `${dir}/locks.kicad_sch`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_SCH },
  );

  await expect
    .poll(() => page.title(), { timeout: 60000, intervals: [500] })
    .toMatch(/locks/i);
  // The open has truly returned (the title is set part-way through it).
  await expect
    .poll(() => page.evaluate(() => (window as unknown as LocksWindow).Module.kicadOpenFileBusy()), {
      timeout: 60000,
      intervals: [250],
    })
    .toBe(false);

  await page.evaluate(() => {
    (window as unknown as LocksWindow).Module.kicadCollabPresenceStart();
  });
}

function setLock(page: Page, locked: boolean): Promise<void> {
  return page.evaluate(
    ({ id, locked: isLocked }) => {
      const w = window as unknown as LocksWindow;
      w.Module.kicadCollabSetRemote(
        JSON.stringify({
          peers: [],
          locks: isLocked ? [{ uuid: id, name: "bob" }] : [],
        }),
      );
    },
    { id: WIRE1, locked },
  );
}

const wirePos = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as LocksWindow).Module.kicadCollabGetPos(
      "22222222-0000-0000-0000-000000000001",
    ),
  );

/** Screen position of the wire's stored (start) point via the GAL transform. */
async function wireScreenPos(page: Page): Promise<{ x: number; y: number }> {
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

  const { vp, pos } = await page.evaluate(() => {
    const w = window as unknown as LocksWindow;
    return {
      vp: JSON.parse(w.Module.kicadCollabGetViewport()),
      pos: w.Module.kicadCollabGetPos("22222222-0000-0000-0000-000000000001"),
    };
  });
  const [wx, wy] = pos.split(",").map(Number);
  return {
    x: box!.x + (wx - vp.cx) * vp.scale + vp.w / 2,
    y: box!.y + (wy - vp.cy) * vp.scale + vp.h / 2,
  };
}

const selection = (page: Page) =>
  page.evaluate(() =>
    JSON.parse((window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
  );

/** Click the wire (off its start point) so it is selected. */
async function selectWire(page: Page): Promise<{ x: number; y: number }> {
  const at = await wireScreenPos(page);
  await page.mouse.click(at.x + 60, at.y);
  await expect.poll(() => selection(page)).toEqual([WIRE1]);
  return at;
}

/**
 * Drag the selected wire along itself. With KiCad's default left-drag mode
 * ("drag selected items") a drag that starts on an UNSELECTED item draws a
 * selection box, so the wire is selected first; every pointer position of the
 * gesture lies on the wire (it spans ~130 px from `at`), so wherever KiCad
 * reads the press and the first motion, the drag starts inside the selection.
 */
async function dragAlongWire(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x + 20, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 110, at.y, { steps: 10 });
  await page.mouse.up();
}

/** The "being edited by bob" infobar, if it is up. */
const lockInfobar = (page: Page) =>
  page.evaluate(
    () =>
      (window.wxElementRegistry?.findAll({ visible: true }) ?? []).some((e) =>
        /being edited by bob/i.test(e.label || ""),
      ),
  );

/** Bounded chance for a slow wrongful edit to surface: a VETOED edit has no
 *  JS-observable, the whole point is that nothing happens. The unlocked
 *  control leg proves the gesture itself works via its own position poll. */
const vetoDwell = (page: Page) =>
  page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: negative-assert window

test("a selected locked wire resists drag, move, rotate and delete; unlocked it drags", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(240000);
  await bootAndOpen(page);

  // Select first, THEN lock: the case the old narrowSelection-only veto
  // missed (a preselected item never reached it).
  const at = await selectWire(page);
  await setLock(page, true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse((window as unknown as LocksWindow).Module.kicadCollabTestGetLocked()),
      ),
    )
    .toEqual([{ uuid: WIRE1, name: "bob" }]);

  const before = await wirePos(page);
  expect(before).toBeTruthy();

  // Drag gesture (preselected path through SCH_MOVE_TOOL).
  await dragAlongWire(page, at);
  await expect.poll(() => lockInfobar(page), { message: "no 'being edited by bob' infobar" }).toBe(true);
  await vetoDwell(page);
  expect(await wirePos(page)).toBe(before);

  // The trim dropped the wire from the selection; the remaining hotkeys
  // hover-select it under the pointer (still on the wire) and trim it again.
  await page.mouse.move(at.x + 60, at.y);
  await page.keyboard.press("m");
  await page.mouse.move(at.x + 60, at.y + 80, { steps: 5 });
  await page.mouse.click(at.x + 60, at.y + 80);
  await page.keyboard.press("Escape");
  await page.mouse.move(at.x + 60, at.y);
  await page.keyboard.press("r");
  await page.keyboard.press("Delete");
  await vetoDwell(page);
  expect(await wirePos(page)).toBe(before);

  // Control: unlocked, the same drag moves the wire.
  await page.keyboard.press("Escape");
  await setLock(page, false);
  await selectWire(page);
  await dragAlongWire(page, at);
  await expect
    .poll(() => wirePos(page), {
      timeout: 10000,
      message: "control drag never moved the unlocked wire",
    })
    .not.toBe(before);

  expect(hasAbort(testLogger)).toBe(false);
});

test("a locked wire stays selectable; ReleaseSelection strips it", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  await setLock(page, true);

  // Inspection: programmatic select through the real tool still lands.
  const id = await page.evaluate(() =>
    (window as unknown as LocksWindow).Module.kicadCollabTestSelectFirst(),
  );
  expect(id).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse((window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
      ),
    )
    .toContain(id);

  // Tiebreak-loser path: release exactly that uuid.
  await page.evaluate(
    ({ uuid }) =>
      (window as unknown as LocksWindow).Module.kicadCollabReleaseSelection(
        JSON.stringify([uuid]),
        "bob",
      ),
    { uuid: id },
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse((window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
      ),
    )
    .toEqual([]);

  expect(hasAbort(testLogger)).toBe(false);
});

test("a drag made entirely while a wx chain is parked replays as a drag", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(240000);
  await bootAndOpen(page);

  const at = await selectWire(page);
  const before = await wirePos(page);
  expect(before).toBeTruthy();

  // Park a wx timer chain (Notify() sleeps), then make the whole press-drag-
  // release inside the park. wx queues the events; KiCad reads the pointer
  // and button state live, so before #47 the replay saw the end position with
  // the button already up and turned the drag into a click.
  const parkMs = 3000;
  const armed = await page.evaluate(
    ({ parkMs: ms }) => {
      const m = (window as unknown as LocksWindow).Module;
      return {
        ok: m.kicadTestArmTimerPark(30, ms),
        done: (JSON.parse(m.kicadTestTimerParkState()) as { done: number }).done,
      };
    },
    { parkMs },
  );
  expect(armed.ok).toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              JSON.parse(
                (window as unknown as LocksWindow).Module.kicadTestTimerParkState(),
              ) as { parked: boolean }
            ).parked,
        ),
      { intervals: [10], timeout: 5000 },
    )
    .toBe(true);

  await dragAlongWire(page, at);

  // The gesture finished inside the park (the park outlasts it).
  const parkState = await page.evaluate(
    () =>
      JSON.parse((window as unknown as LocksWindow).Module.kicadTestTimerParkState()) as {
        parked: boolean;
        done: number;
      },
  );
  expect(parkState.parked).toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              JSON.parse(
                (window as unknown as LocksWindow).Module.kicadTestTimerParkState(),
              ) as { done: number }
            ).done,
        ),
      { timeout: parkMs + 20000 },
    )
    .toBeGreaterThan(armed.done);

  // Moved by the drag delta along x (90 px), not left in place by a click.
  await expect
    .poll(() => wirePos(page), { timeout: 10000, message: "parked drag replayed as a click" })
    .not.toBe(before);
  const [bx, by] = before.split(",").map(Number);
  const [ax, ay] = (await wirePos(page)).split(",").map(Number);
  expect(ax).toBeGreaterThan(bx);
  expect(ay).toBe(by);
  expect(await selection(page)).toEqual([WIRE1]);

  expect(hasAbort(testLogger)).toBe(false);
});
