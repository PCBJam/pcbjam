import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Subschema (hierarchical sheet) collab scoping — the Phase-0 C++ change.
 *
 * A hierarchical design references a child `.kicad_sch` from the root via a (sheet …)
 * symbol; opening the root loads BOTH screens into memory. Each `.kicad_sch` is its own
 * collab room, so `kicadCollabSnapshotItems()` (which feeds the active room) must return
 * ONLY the active screen's items — NOT the whole hierarchy. Before Phase 0 it iterated
 * `Schematic().Hierarchy()` and would have leaked the child's items into the root's room.
 *
 * Headless scope: this asserts the snapshot is scoped to the root (active) screen on
 * load. Driving sheet navigation + the onSheetChanged hook needs the real wx UI (the
 * same reason eeschema-collab's two-tab test is skipped) and is verified in the app.
 */

type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadCollabSnapshotItems(): Promise<string>;
} & Record<string, (...a: never[]) => unknown>;
type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
};

const BOOT_TIMEOUT = 150000;

const ROOT_WIRE_UUID = "1aaaaaaa-0000-0000-0000-000000000001";
const SHEET_SYMBOL_UUID = "5ee70000-0000-0000-0000-000000000001";
const CHILD_WIRE_UUID = "2ccccccc-0000-0000-0000-000000000001";

const ROOT_SCH = `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "10000000-0000-0000-0000-000000000000")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${ROOT_WIRE_UUID}"))
	(sheet (at 127 50.8) (size 20 20)
		(stroke (width 0.1524) (type solid))
		(fill (color 0 0 0 0.0000))
		(uuid "${SHEET_SYMBOL_UUID}")
		(property "Sheetname" "child" (at 127 50 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
		(property "Sheetfile" "child.kicad_sch" (at 127 71 0) (effects (font (size 1.27 1.27)) (justify left top)))
		(instances (project "rt" (path "/10000000-0000-0000-0000-000000000000" (page "2"))))
	)
	(sheet_instances (path "/" (page "1")))
)
`;

const CHILD_SCH = `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "20000000-0000-0000-0000-000000000000")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 25.4 25.4) (xy 76.2 25.4)) (stroke (width 0) (type default)) (uuid "${CHILD_WIRE_UUID}"))
	(sheet_instances (path "/" (page "1")))
)
`;

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootOpenHierarchy(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSnapshotItems === "function"
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
    async ({ root, child }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      // Write BOTH sheets so the root's (sheet … Sheetfile "child.kicad_sch") resolves
      // and eeschema loads the child screen alongside the root.
      w.FS.writeFile("/home/kicad/documents/child.kicad_sch", child);
      w.FS.writeFile("/home/kicad/documents/root.kicad_sch", root);
      await w.Module.kicadOpenFile("/home/kicad/documents/root.kicad_sch");
    },
    { root: ROOT_SCH, child: CHILD_SCH },
  );
}

test.describe("eeschema subschema (hierarchical sheet) collab scoping", () => {
  test.describe.configure({ timeout: 420000 });

  test("snapshot covers ONLY the active (root) screen, not the child sheet", async ({
    page,
    testLogger,
  }) => {
    await bootOpenHierarchy(page);

    // Poll: the root snapshot must include the root's own items but NOT the child's.
    await expect
      .poll(
        async () => {
          const snap = JSON.parse(
            await page.evaluate(() => window.Module.kicadCollabSnapshotItems()),
          ) as { added: Array<{ sexpr: string }> };
          return snap.added.map((w) => w.sexpr).join("\n");
        },
        { timeout: 30000, intervals: [500] },
      )
      .toContain(ROOT_WIRE_UUID);

    const blobs = JSON.parse(
      await page.evaluate(() => window.Module.kicadCollabSnapshotItems()),
    ) as { added: Array<{ sexpr: string }> };
    const allBlobs = blobs.added.map((w) => w.sexpr).join("\n");

    // Root items present (the wire + the sheet symbol live on the root screen)…
    expect(allBlobs, "root wire in snapshot").toContain(ROOT_WIRE_UUID);
    expect(allBlobs, "sheet symbol in snapshot").toContain(SHEET_SYMBOL_UUID);
    // …but the CHILD sheet's items must NOT leak into the root's room (Phase 0).
    expect(allBlobs, "child wire must NOT be in the root snapshot").not.toContain(
      CHILD_WIRE_UUID,
    );

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});
