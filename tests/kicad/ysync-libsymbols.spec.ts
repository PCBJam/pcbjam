import * as path from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Miss 08A e2e — embedded library definitions travel the v2 wire.
 *
 * A schematic symbol is only renderable with its `(lib_symbols …)` definition.
 * The TS layer used to strip that envelope ("sender context") so a peer that
 * had never seen the symbol received a definition-less instance and the room's
 * materialization referenced a lib id it didn't contain. Now definitions live
 * in `kdoc_libsymbols` and are re-prefixed on every apply wire.
 *
 * Two kicad_editor instances → Firefox's per-process wasm budget (finding F2):
 * chromium only, like the other two-tab specs.
 */

const SYM1 = "44444444-0000-0000-0000-000000000001";
const WIRE1 = "22222222-0000-0000-0000-000000000001";

const SCH_WITH_SYMBOL = `(kicad_sch
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

// B's cold copy: the same sheet BEFORE the symbol was placed — no instance, no
// definition. The adopt must deliver both.
const SCH_WITHOUT_SYMBOL = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${WIRE1}"))
\t(sheet_instances (path "/" (page "1")))
)
`;

type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabSnapshotItems(): string;
  kicadCollabApplyItems(j: string): unknown;
  kicadSaveSchematic(p: string): unknown;
};

const BOOT_TIMEOUT = 150000;
const BUNDLE = path.resolve(__dirname, "../apps/kicad/collab-bundle-v2.js");

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootOpen(page: Page, content: string, name: string): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        !!m &&
        typeof m.kicadOpenFile === "function" &&
        typeof m.kicadCollabSnapshotItems === "function" &&
        typeof m.kicadSaveSchematic === "function"
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
    ({ content, name }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      const p = `/home/kicad/documents/${name}.kicad_sch`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content, name },
  );
  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(new RegExp(name, "i"));
  await page.addScriptTag({ path: BUNDLE });
}

function startV2(
  page: Page,
  opts: { room: string; settleMs?: number; seedText?: string },
): Promise<void> {
  return page.evaluate(async (o) => {
    const w = window as unknown as {
      KicadCollabV2: { start: (m: unknown, win: unknown, o: unknown) => Promise<void> };
      Module: unknown;
    };
    await w.KicadCollabV2.start(w.Module, window, o);
  }, opts);
}

function saveText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { FS: FS; Module: Mod };
    const out = "/home/kicad/documents/_dump.kicad_sch";
    w.Module.kicadSaveSchematic(out);
    return w.FS.readFile(out, { encoding: "utf8" });
  });
}

test.describe("v2 items wire — lib_symbols travel (miss 08A)", () => {
  test.describe.configure({ timeout: 420000 });

  test("a joiner that never saw the symbol adopts it WITH its definition", async ({
    context,
    testLogger,
  }) => {
    // 2026-08-13: FF wasm-budget skip retired — the JSPI build fits two
    // editor tabs on Firefox 153; passes on kicad-firefox.

    const room = `ysync-libsym-${test.info().workerIndex}`;
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await bootOpen(tabA, SCH_WITH_SYMBOL, "tabA");
    await bootOpen(tabB, SCH_WITHOUT_SYMBOL, "tabB");

    await startV2(tabA, { room, seedText: SCH_WITH_SYMBOL }); // fresh → file-seed
    await startV2(tabB, { room }); // joins → diff-adopt (doc authority)

    // The adopt delivered the INSTANCE…
    await expect
      .poll(async () => (await saveText(tabB)).includes(SYM1), {
        timeout: 20000,
        intervals: [400],
      })
      .toBe(true);
    // …AND its DEFINITION (findLib resolved it from the wire's lib_symbols
    // context; before miss 08A the peer kept an empty lib_symbols and the
    // instance rendered broken / materialized as an invalid file).
    const saved = await saveText(tabB);
    expect(saved).toContain(`(symbol "Device:R"`);
    expect(saved).toContain(`(lib_id "Device:R")`);

    // The untouched wire survived the diff-adopt (only the difference applied).
    expect(saved).toContain(WIRE1);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await tabA.close();
    await tabB.close();
  });
});
