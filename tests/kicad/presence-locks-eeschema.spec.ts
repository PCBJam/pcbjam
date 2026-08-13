import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * eeschema selection soft-locks — C++ veto e2e (collab-presence 0007).
 * Mirror of presence-locks-pcbnew.spec.ts: eeschema has NO native item-lock
 * plumbing (the itemPassesFilter lock branch is #if 0), so the veto rides the
 * pcbjam remote-lock check in narrowSelection's aCheckLocked path — a real
 * drag gesture on a locked wire must not move it, the same gesture moves it
 * unlocked, and ReleaseSelection strips exactly the contested uuid.
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
  kicadOpenFile(p: string): Promise<unknown>;
  kicadCollabPresenceStart(): Promise<void>;
  kicadCollabSetRemote(j: string): Promise<void>;
  kicadCollabGetViewport(): Promise<string>;
  kicadCollabGetSelection(): Promise<string>;
  kicadCollabGetPos(id: string): Promise<string>;
  kicadCollabReleaseSelection(uuidsJson: string, holder: string): Promise<void>;
  kicadCollabTestGetLocked(): Promise<string>;
  kicadCollabTestSelectFirst(): Promise<string>;
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
    async ({ content }) => {
      const w = window as unknown as LocksWindow;
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const p = `${dir}/locks.kicad_sch`;
      w.FS.writeFile(p, content);
      await w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_SCH },
  );

  await expect
    .poll(() => page.title(), { timeout: 60000, intervals: [500] })
    .toMatch(/locks/i);

  await page.evaluate(async () => {
    await (window as unknown as LocksWindow).Module.kicadCollabPresenceStart();
  });
}

function setLock(page: Page, locked: boolean): Promise<void> {
  return page.evaluate(
    async ({ id, locked: isLocked }) => {
      const w = window as unknown as LocksWindow;
      await w.Module.kicadCollabSetRemote(
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

  const { vp, pos } = await page.evaluate(async () => {
    const w = window as unknown as LocksWindow;
    return {
      vp: JSON.parse(await w.Module.kicadCollabGetViewport()),
      pos: await w.Module.kicadCollabGetPos("22222222-0000-0000-0000-000000000001"),
    };
  });
  const [wx, wy] = pos.split(",").map(Number);
  return {
    x: box!.x + (wx - vp.cx) * vp.scale + vp.w / 2,
    y: box!.y + (wy - vp.cy) * vp.scale + vp.h / 2,
  };
}

async function dragFromWire(page: Page): Promise<void> {
  const at = await wireScreenPos(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 100, at.y + 60, { steps: 10 });
  await page.mouse.up();
  // The drag commit has no JS-observable in the VETOED (locked) case — the whole
  // point is that NOTHING happens. Bounded chance for a slow wrongful move to
  // surface before the caller's position assert; the unlocked control leg proves
  // the gesture itself works via its own position poll.
  await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: negative-assert window
}

test("a locked wire resists a real drag; the same drag moves it unlocked", async ({
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
    .toEqual([{ uuid: WIRE1, name: "bob" }]);

  const before = await wirePos(page);
  expect(before).toBeTruthy();
  await dragFromWire(page);
  expect(await wirePos(page)).toBe(before);

  // Control: unlocked, the same gesture moves/bends the wire.
  await setLock(page, false);
  await dragFromWire(page);
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
      page.evaluate(async () =>
        JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
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
      page.evaluate(async () =>
        JSON.parse(await (window as unknown as LocksWindow).Module.kicadCollabGetSelection()),
      ),
    )
    .toEqual([]);

  expect(hasAbort(testLogger)).toBe(false);
});
