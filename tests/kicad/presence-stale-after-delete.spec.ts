import type { Page } from "@playwright/test";
import { settledShot } from "../e2e/utils/element-tracker";
import { test, expect } from "./fixtures";

/**
 * Findings group Y (Y-1/Y-3, "selection kept on deleted element") — regression
 * gate. Written red on 2026-08-28, green with the fix the same day.
 *
 * Was: the presence overlay (collab_presence_core.h) was cleared + redrawn
 * ONLY on kicadCollabSetRemote / SetPins / SetStyle / zoom. A document change
 * — the remote apply of a peer's delete, or a local delete — never scheduled
 * a redraw, so a peer's selection box / cross-app ghost kept being painted at
 * the dead item's last bbox until some unrelated awareness change arrived.
 * Now: every collab-listener trigger (local commit AND remote apply) queues
 * CORE::onDocChanged() on the apply coroutine — shapes repaint from the live
 * document and the local selection is re-checked post-settle.
 *
 * Second half: the LOCAL selection emit used to be triggered only by canvas
 * LEFT_UP / RIGHT_UP / KEY_UP / wheel events (plus a listener piggyback that
 * could run before the commit finished). A delete reaching the commit without
 * such an event (menu, toolbar, context menu, programmatic/remote release)
 * left the dead uuids published for every peer. onDocChanged() re-checks
 * after the commit body completes.
 */

const WIRE1 = "22222222-0000-0000-0000-000000000001";
const WIRE2 = "22222222-0000-0000-0000-000000000002";
const SAMPLE_SCH = `(kicad_sch
\t(version 20260306)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${WIRE1}"))
\t(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "${WIRE2}"))
\t(sheet_instances (path "/" (page "1")))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabPresenceStart(): void;
  kicadCollabSetRemote(j: string): void;
  kicadCollabGetSelection(): string;
  kicadCollabTestSelectByUuid(id: string): boolean;
  kicadCollabTestSelectFirst(): string;
  kicadCollabTestRemoveItem(id: string): boolean;
  kicadCollabTestListItems(): string;
};
type W = {
  FS: FS;
  Module: Mod;
  kicadCollab?: Record<string, unknown>;
  __selEmits?: string[][];
};

async function galPanel(page: Page) {
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
  expect(glId, "no visible GAL panel found").toBeTruthy();
  return page.locator(`#${glId}`);
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
        typeof m?.kicadCollabSetRemote === "function" &&
        typeof m?.kicadCollabTestRemoveItem === "function"
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
      const w = window as unknown as W;
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const p = `${dir}/stale.kicad_sch`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_SCH },
  );
  await expect
    .poll(() => page.title(), { timeout: 60000, intervals: [500] })
    .toMatch(/stale/i);
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__selEmits = [];
    w.kicadCollab = {
      ...w.kicadCollab,
      onSelection: (json: string) => w.__selEmits!.push(JSON.parse(json)),
    };
    w.Module.kicadCollabPresenceStart();
  });
}

const setRemote = (page: Page, snapshot: unknown) =>
  page.evaluate(
    (s) => (window as unknown as W).Module.kicadCollabSetRemote(JSON.stringify(s)),
    snapshot,
  );

const removeItem = (page: Page, id: string) =>
  page.evaluate((u) => (window as unknown as W).Module.kicadCollabTestRemoveItem(u), id);

const lastEmit = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__selEmits!.at(-1) ?? null);

for (const kind of ["selection", "xsel"] as const) {
  test(`remote ${kind} outline is dropped when the item is deleted (redraw on doc change)`, async ({
    page,
  }) => {
    await bootAndOpen(page);
    const canvas = await galPanel(page);
    const baseline = await settledShot(canvas);

    // bob (same room, or a pcbnew tab via cross-app xsel) has WIRE1 selected.
    const peer = {
      id: "bob",
      name: "bob",
      color: "#ef4444",
      cursor: null,
      selection: kind === "selection" ? [WIRE1] : [],
      ...(kind === "xsel" ? { xsel: [WIRE1] } : {}),
    };
    await setRemote(page, { peers: [peer] });
    await expect
      .poll(async () => !(await canvas.screenshot()).equals(baseline), {
        timeout: 15000,
        intervals: [500],
        message: "peer outline never painted",
      })
      .toBe(true);

    // WIRE1 is deleted through a real SCH_COMMIT — the same path a remote
    // apply (peer deleted it) or a local menu delete takes.
    expect(await removeItem(page, WIRE1)).toBe(true);
    // Documented interaction dwell: the overlay repaint has no observable signal
    // — settledShot below compares stable frames, this only lets it queue.
    await page.waitForTimeout(1500); // eslint-disable-line -- documented interaction dwell
    const afterDelete = await settledShot(canvas);

    // Ground truth for "what the overlay should look like now": force the
    // overlay to rebuild from the SAME peer snapshot — WIRE1 no longer
    // resolves, so nothing is drawn for it.
    await setRemote(page, { peers: [peer] });
    await page.waitForTimeout(1500); // eslint-disable-line -- documented interaction dwell (overlay rebuild, no observable)
    const afterRepush = await settledShot(canvas);

    expect(
      afterDelete.equals(afterRepush),
      `${kind}: overlay still shows bob's outline on the deleted wire (no redraw on doc change)`,
    ).toBe(true);
  });
}

test("local emit: a commit-path delete of the selected item publishes the empty selection", async ({
  page,
}) => {
  await bootAndOpen(page);
  const id = await page.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectFirst(),
  );
  expect(id).toBeTruthy();
  await expect.poll(() => lastEmit(page), { timeout: 10000 }).toEqual([id]);

  // Delete WITHOUT a canvas key/mouse event (menu / toolbar / context-menu /
  // remote-release shaped): real SCH_COMMIT, item leaves the selection.
  expect(await removeItem(page, id)).toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()),
        ),
      { timeout: 10000, message: "the commit should have dropped the item from the live selection" },
    )
    .toEqual([]);

  // Peers learn the selection is gone (was: the last emit stayed [id] —
  // no LEFT_UP/RIGHT_UP/KEY_UP/wheel closed the delete).
  await expect
    .poll(() => lastEmit(page), { timeout: 5000, intervals: [250] })
    .toEqual([]);
});

test("local emit: keyboard Delete on the canvas does publish the empty selection (control)", async ({
  page,
}) => {
  await bootAndOpen(page);
  const canvas = await galPanel(page);
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  // Give the wx canvas keyboard focus with a click on empty sheet space (this
  // clears any selection — the programmatic select comes after).
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.95);
  await page.locator("#canvas").focus().catch(() => {}); // documented best-effort: wx canvas may reject DOM focus after the click already focused it
  const id = await page.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectFirst(),
  );
  expect(id).toBeTruthy();
  await expect.poll(() => lastEmit(page), { timeout: 10000 }).toEqual([id]);

  await page.keyboard.press("Delete");
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()),
        ),
      { timeout: 10000, message: "Delete key never deleted the selected item (focus?)" },
    )
    .toEqual([]);
  await expect.poll(() => lastEmit(page), { timeout: 5000, intervals: [250] }).toEqual([]);
});
