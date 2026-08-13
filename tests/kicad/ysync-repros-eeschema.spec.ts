import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * eeschema single-tab ysync coverage (docs in docs/features/ysync-review on
 * the ysync-review branch) — items-bridge.spec.ts driving style.
 *
 * Today this file holds the HEADLESS EMIT PROBE (plan phase C): whether a real
 * local commit emits the v2 items wire in the headless harness once the
 * listener IS registered. The legacy two-tab skip in eeschema-collab.spec.ts
 * cites a rationale its own single-page test documents as stale ("predated the
 * dyncall-shim fix — apply now works"); the EMIT half was never verified. If
 * this probe is green, the bug-01 eeschema two-tab repro in
 * ysync-two-tab.spec.ts stays a live test.fail; if red, it becomes test.fixme.
 *
 * The bug-04 edit matrix (rotate / field-text — plan phase D) lands here once
 * the C++ test hooks exist in the wasm build.
 */

const WIRE1 = "22222222-0000-0000-0000-000000000001";
const WIRE2 = "22222222-0000-0000-0000-000000000002";
// A real placed symbol (embedded Device:R) — the bug-04 rotate / field-text
// target: symbol rotation leaves GetPosition() unchanged, and fields are not
// in screen->Items() at all.
const SYM1 = "44444444-0000-0000-0000-000000000001";

const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols
\t\t(symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t\t(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(symbol "R_0_1"
\t\t\t\t(rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t\t)
\t\t\t(symbol "R_1_1"
\t\t\t\t(pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${WIRE1}"))
\t(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "${WIRE2}"))
\t(symbol (lib_id "Device:R") (at 63.5 63.5 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "${SYM1}")
\t\t(property "Reference" "R1" (at 66.04 62.23 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "10k" (at 66.04 64.77 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(pin "1" (uuid "44444444-0000-0000-0000-0000000000a1"))
\t\t(pin "2" (uuid "44444444-0000-0000-0000-0000000000a2"))
\t\t(instances (project "rt" (path "/11111111-1111-1111-1111-111111111111" (reference "R1") (unit 1))))
\t)
\t(sheet_instances (path "/" (page "1")))
)
`;

type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};
type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadCollabSnapshotItems(): Promise<string>;
  kicadCollabApplyItems(j: string): Promise<unknown>;
  kicadCollabTestMoveFirst(dx: number, dy: number): Promise<string>;
  kicadCollabGetPos(id: string): Promise<string>;
  kicadSaveSchematic(p: string): Promise<void>;
};

const BOOT_TIMEOUT = 150000;

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootOpen(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSnapshotItems === "function" &&
        typeof m?.kicadCollabApplyItems === "function" &&
        typeof m?.kicadCollabTestMoveFirst === "function" &&
        typeof m?.kicadSaveSchematic === "function"
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
  await page.evaluate(async (content) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    try {
      w.FS.mkdirTree("/home/kicad/documents");
    } catch {
      /* exists */
    }
    const p = "/home/kicad/documents/rt.kicad_sch";
    w.FS.writeFile(p, content);
    await w.Module.kicadOpenFile(p);
  }, SAMPLE_SCH);
}

test.describe("eeschema ysync repros (v2 items wire, single tab)", () => {
  test.describe.configure({ timeout: 420000 });

  test("control: a local move emits the v2 items wire (HEADLESS EMIT PROBE)", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    // snapshotItems: registers the SCHEMATIC_LISTENER (ensureBridge) +
    // baselines the differ — what seed()'s non-file-seed branches rely on.
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    await page.evaluate(() => {
      (window as unknown as { __items: string[] }).__items = [];
      (window as unknown as { kicadCollab: object }).kicadCollab = {
        onItems: (j: string) => (window as unknown as { __items: string[] }).__items.push(j),
      };
    });

    const movedId = (await page.evaluate(() =>
      window.Module.kicadCollabTestMoveFirst(200000, 0),
    )) as string;
    expect(movedId).toMatch(/[0-9a-f-]{36}/);

    // listener → scheduleFlush → flushDiff → emitItems: the moved item's uuid
    // must appear in an emitted wire. Phase-C gate for the eeschema bug-01
    // two-tab repro and the phase-D bug-04 matrix.
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => (window as unknown as { __items: string[] }).__items.join("\n"),
          ),
        { timeout: 20000, intervals: [400] },
      )
      .toContain(movedId);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // ── Bug 04 matrix — edits invisible to the scalar-projection differ ────────
  // 04-bug-lossy-change-detection.md. Same shape as the pcbnew matrix: real
  // commit via a repro hook → green precondition the edit LANDED → expected-
  // fail that it EMITTED. Gated on the wasm build carrying the hooks.

  function saveRead(page: Page): Promise<string> {
    return page.evaluate(async () => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const out = "/home/kicad/documents/probe.kicad_sch";
      await w.Module.kicadSaveSchematic(out);
      return w.FS.readFile(out, { encoding: "utf8" });
    });
  }

  function emittedWires(page: Page): Promise<string> {
    return page.evaluate(() =>
      (window as unknown as { __items: string[] }).__items.join("\n"),
    );
  }

  /** Baseline + capture; the current wasm must expose the requested hook. */
  async function armed(page: Page, hook: string): Promise<void> {
    await bootOpen(page);
    const has = await page.evaluate(
      (h) => typeof (window as unknown as { Module: Record<string, unknown> }).Module[h] === "function",
      hook,
    );
    expect(has, `current wasm exposes ${hook}`).toBe(true);
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    await page.evaluate(() => {
      (window as unknown as { __items: string[] }).__items = [];
      (window as unknown as { kicadCollab: object }).kicadCollab = {
        onItems: (j: string) => (window as unknown as { __items: string[] }).__items.push(j),
      };
    });
  }

  test("an in-place symbol rotation reaches the wire", async ({ page, testLogger }) => {
    await armed(page, "kicadCollabTestRotateItem");

    const queued = await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestRotateItem(i: string, d: number): Promise<boolean> } })
          .Module.kicadCollabTestRotateItem(id, 90),
      SYM1,
    );
    expect(queued, "rotate hook resolved the symbol").toBe(true);

    // Green precondition: the rotation LANDED (the saved symbol's placement
    // gained an angle).
    await expect
      .poll(async () => /\(at 63.5 63.5 (90|180|270)\)/.test(await saveRead(page)), {
        timeout: 15000,
        intervals: [400],
      })
      .toBe(true);

    // CORRECT: the rotation is broadcast. TODAY: the scalar diff is empty.
    await expect
      .poll(async () => await emittedWires(page), { timeout: 8000, intervals: [400] })
      .toContain(SYM1);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a symbol Value field edit reaches the wire", async ({ page, testLogger }) => {
    await armed(page, "kicadCollabTestSetFieldText");

    const queued = await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestSetFieldText(i: string, t: string): Promise<boolean> } })
          .Module.kicadCollabTestSetFieldText(id, "22k"),
      SYM1,
    );
    expect(queued, "field hook resolved the symbol").toBe(true);

    // Green precondition: the edit LANDED in the model.
    await expect
      .poll(async () => (await saveRead(page)).includes(`"22k"`), {
        timeout: 15000,
        intervals: [400],
      })
      .toBe(true);

    // CORRECT: the most common schematic edit after moving things is
    // broadcast. TODAY: nothing emits — the value edit stays local forever.
    await expect
      .poll(async () => await emittedWires(page), { timeout: 8000, intervals: [400] })
      .toContain(SYM1);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});
