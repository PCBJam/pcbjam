import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Miss 09 — collab-aware undo (docs/features/ysync-review/09 + 19): remote
 * applies are pushed with SKIP_UNDO, so a peer's edit never lands on the local
 * undo stack; Ctrl+Z is local-ops-only. Stale local undo entries — an item a
 * remote apply replaced (same uuid, new object) or deleted — are re-anchored /
 * dropped by the UUID guard at undo time instead of dereferencing a freed
 * pointer.
 *
 * Single-tab, items-bridge driving style: kicadCollabApplyItems plays the
 * remote peer, kicadCollabTest* plays the local user. Assertions are
 * model-level (undo depth + positions); hasAbort pins crash-freedom, which is
 * the point of the stranded-entry cases.
 *
 * The current CI build must carry the undo test hooks. A missing hook is a
 * broken build/staging prerequisite and fails loudly.
 */

const WIRE1 = "22222222-0000-0000-0000-000000000001";
const WIRE2 = "22222222-0000-0000-0000-000000000002";
const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
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

const VIA1 = "77777777-0000-0000-0000-000000000001";
const SEG1 = "88888888-0000-0000-0000-000000000001";
const SEG2 = "88888888-0000-0000-0000-000000000002";
const SAMPLE_PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(via (at 80 80) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "${VIA1}"))
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG1}"))
\t(segment (start 50.8 76.2) (end 101.6 76.2) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG2}"))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadCollabSnapshotItems(): Promise<string>;
  kicadCollabApplyItems(j: string): Promise<void>;
  kicadCollabTestMoveFirst(dx: number, dy: number): Promise<string>;
  kicadCollabTestRotateItem(id: string, deg: number): Promise<boolean>;
  kicadCollabGetPos(id: string): Promise<string>;
  kicadCollabTestUndo(): Promise<boolean>;
  kicadCollabTestUndoDepth(): Promise<number>;
};

const BOOT_TIMEOUT = 150000;

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootOpen(page: Page, url: string, content: string, file: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSnapshotItems === "function" &&
        typeof m?.kicadCollabApplyItems === "function" &&
        typeof m?.kicadCollabTestMoveFirst === "function"
      );
    },
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.evaluate(
    async ({ content, file }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      const p = `/home/kicad/documents/${file}`;
      w.FS.writeFile(p, content);
      await w.Module.kicadOpenFile(p);
    },
    { content, file },
  );

  const hooks = await page.evaluate(() => {
    const m = (window as unknown as { Module: Record<string, unknown> }).Module;
    return typeof m.kicadCollabTestUndo === "function" && typeof m.kicadCollabTestUndoDepth === "function";
  });
  expect(hooks, "current wasm exposes both collab undo test hooks").toBe(true);
}

const getPos = (page: Page, id: string) =>
  page.evaluate((i) => window.Module.kicadCollabGetPos(i), id);
const undoDepth = (page: Page) => page.evaluate(() => (window.Module as unknown as Mod).kicadCollabTestUndoDepth());
const runUndo = (page: Page) => page.evaluate(() => (window.Module as unknown as Mod).kicadCollabTestUndo());
const applyItems = (page: Page, wire: object) =>
  page.evaluate((j) => window.Module.kicadCollabApplyItems(j), JSON.stringify(wire));

test.describe("eeschema collab undo (miss 09: local-ops-only)", () => {
  test.describe.configure({ timeout: 420000 });

  test("remote apply adds no undo entry; undo reverts own op, not the peer's", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, "/kicad/eeschema.html", SAMPLE_SCH, "undoA.kicad_sch");

    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    expect(await undoDepth(page)).toBe(0);

    const orig: Record<string, string> = {
      [WIRE1]: await getPos(page, WIRE1),
      [WIRE2]: await getPos(page, WIRE2),
    };

    // Local op → exactly one undo entry.
    const movedId = (await page.evaluate(() =>
      window.Module.kicadCollabTestMoveFirst(200000, 0),
    )) as string;
    expect([WIRE1, WIRE2]).toContain(movedId);
    await expect
      .poll(() => getPos(page, movedId), { timeout: 15000, intervals: [250] })
      .not.toBe(orig[movedId]);
    expect(await undoDepth(page)).toBe(1);

    // Remote apply (peer deletes the other wire) → depth must NOT grow.
    const target = movedId === WIRE1 ? WIRE2 : WIRE1;
    await applyItems(page, { added: [], changed: [], removed: [target] });
    await expect.poll(() => getPos(page, target), { timeout: 15000, intervals: [250] }).toBe("");
    expect(await undoDepth(page), "remote apply must not land on the undo stack").toBe(1);

    // Undo → own move reverts, peer's delete stays.
    await runUndo(page);
    await expect
      .poll(() => getPos(page, movedId), { timeout: 15000, intervals: [250] })
      .toBe(orig[movedId]);
    expect(await getPos(page, target), "undo must not resurrect the peer's delete").toBe("");
    await expect.poll(() => undoDepth(page), { timeout: 15000, intervals: [250] }).toBe(0);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("stranded CHANGED entry: remote replaced the item — undo re-anchors by uuid", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, "/kicad/eeschema.html", SAMPLE_SCH, "undoB.kicad_sch");

    // Original WIRE1 blob (pre-edit geometry) — the "peer's" replacement payload.
    const snap = JSON.parse(
      await page.evaluate(() => window.Module.kicadCollabSnapshotItems()),
    ) as { added: Array<{ id?: string; sexpr?: string }> };
    const wire1Blob = snap.added.find((e) => e.id === WIRE1 || (e.sexpr ?? "").includes(WIRE1));
    expect(wire1Blob?.sexpr, "snapshot must carry WIRE1's blob").toBeTruthy();

    // Local op referencing WIRE1 → undo entry holds a pointer to today's object.
    await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestRotateItem(i: string, d: number): Promise<boolean> } })
          .Module.kicadCollabTestRotateItem(id, 90),
      WIRE1,
    );
    await expect.poll(() => undoDepth(page), { timeout: 15000, intervals: [250] }).toBe(1);

    // Remote upsert of WIRE1 (remove old object + re-add same uuid) frees the
    // pointer the undo entry holds; WIRE2's removal doubles as the completion marker.
    await applyItems(page, {
      added: [],
      changed: [{ sexpr: wire1Blob!.sexpr }],
      removed: [WIRE2],
    });
    await expect.poll(() => getPos(page, WIRE2), { timeout: 15000, intervals: [250] }).toBe("");
    expect(await undoDepth(page)).toBe(1);

    // Undo → the guard re-resolves WIRE1 by uuid onto the new live object. The
    // assertion that matters is crash-freedom (pre-guard this dereferenced a
    // freed pointer).
    await runUndo(page);
    await expect.poll(() => undoDepth(page), { timeout: 15000, intervals: [250] }).toBe(0);
    expect(await getPos(page, WIRE1), "WIRE1 must still exist after undo").not.toBe("");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("stranded entry: remote deleted the item — undo drops the picker quietly", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, "/kicad/eeschema.html", SAMPLE_SCH, "undoC.kicad_sch");

    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());

    await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestRotateItem(i: string, d: number): Promise<boolean> } })
          .Module.kicadCollabTestRotateItem(id, 90),
      WIRE1,
    );
    await expect.poll(() => undoDepth(page), { timeout: 15000, intervals: [250] }).toBe(1);

    await applyItems(page, { added: [], changed: [], removed: [WIRE1] });
    await expect.poll(() => getPos(page, WIRE1), { timeout: 15000, intervals: [250] }).toBe("");

    // Undo → the entry's item is gone; the guard drops the picker (log, no modal, no crash).
    await runUndo(page);
    await expect.poll(() => undoDepth(page), { timeout: 15000, intervals: [250] }).toBe(0);
    expect(await getPos(page, WIRE1), "undo must not resurrect the deleted item").toBe("");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});

test.describe("pcbnew collab undo (miss 09: local-ops-only)", () => {
  test.describe.configure({ timeout: 420000 });

  test("remote apply adds no undo entry; undo reverts own op, not the peer's", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, "/kicad/pcbnew-collab.html", SAMPLE_PCB, "undoA.kicad_pcb");

    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    expect(await undoDepth(page)).toBe(0);

    const ids = [VIA1, SEG1, SEG2];
    const orig: Record<string, string> = {};
    for (const id of ids) orig[id] = await getPos(page, id);

    const movedId = (await page.evaluate(() =>
      window.Module.kicadCollabTestMoveFirst(200000, 0),
    )) as string;
    expect(ids).toContain(movedId);
    await expect
      .poll(() => getPos(page, movedId), { timeout: 15000, intervals: [250] })
      .not.toBe(orig[movedId]);
    expect(await undoDepth(page)).toBe(1);

    const target = movedId === SEG1 ? SEG2 : SEG1;
    await applyItems(page, { added: [], changed: [], removed: [target] });
    await expect.poll(() => getPos(page, target), { timeout: 15000, intervals: [250] }).toBe("");
    expect(await undoDepth(page), "remote apply must not land on the undo stack").toBe(1);

    await runUndo(page);
    await expect
      .poll(() => getPos(page, movedId), { timeout: 15000, intervals: [250] })
      .toBe(orig[movedId]);
    expect(await getPos(page, target), "undo must not resurrect the peer's delete").toBe("");
    await expect.poll(() => undoDepth(page), { timeout: 15000, intervals: [250] }).toBe(0);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("stranded entry: remote deleted the item — undo drops it (log, not modal)", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, "/kicad/pcbnew-collab.html", SAMPLE_PCB, "undoB.kicad_pcb");

    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());

    const origins: Record<string, string> = {};
    for (const id of [VIA1, SEG1, SEG2]) origins[id] = await getPos(page, id);

    const movedId = (await page.evaluate(() =>
      window.Module.kicadCollabTestMoveFirst(200000, 0),
    )) as string;
    await expect
      .poll(() => getPos(page, movedId), { timeout: 15000, intervals: [250] })
      .not.toBe(origins[movedId]);
    await expect.poll(() => undoDepth(page), { timeout: 15000, intervals: [250] }).toBe(1);

    await applyItems(page, { added: [], changed: [], removed: [movedId] });
    await expect.poll(() => getPos(page, movedId), { timeout: 15000, intervals: [250] }).toBe("");

    // Undo → the CHANGED picker's item is gone: the pcbnew guard drops it. This
    // path used to raise a blocking wxMessageBox; now it must only log.
    await runUndo(page);
    await expect.poll(() => undoDepth(page), { timeout: 15000, intervals: [250] }).toBe(0);
    expect(await getPos(page, movedId), "undo must not resurrect the deleted item").toBe("");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});
