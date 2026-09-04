/**
 * Grid cell editors in a wasm dialog must be typeable — the Symbol Properties
 * fields grid as the specimen (fields_grid_table.cpp mixes all three editor
 * kinds):
 *
 *  - Value      → GRID_CELL_STC_EDITOR: canvas-drawn wxStyledTextCtrl. Text
 *                 only arrives as wxEVT_CHAR, which this port derives from the
 *                 browser 'keypress'. The canvas keydown callback is a plain
 *                 (non-promising) entry, so its wx job is deferred and the
 *                 callback used to answer preventDefault=true by default —
 *                 cancelling keypress and every typed character (app.cpp
 *                 KeyCallback / evtloop.cpp wxWasmRunOnDispatchContext).
 *  - Footprint  → GRID_CELL_FPID_EDITOR on wxComboCtrl: its inner <input>
 *                 stayed at the 10px creation size because
 *                 wxComboCtrlBase::PositionTextCtrl bails when
 *                 GetHandle() is NULL, which the wasm port hard-coded.
 *
 * Both are asserted end-to-end: type, commit, OK, save, read the file back.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const SCH = `(kicad_sch
\t(version 20231120)
\t(generator "eeschema")
\t(uuid "cccc0000-0000-0000-0000-000000000011")
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
\t\t(uuid "dddd0000-0000-0000-0000-000000000012")
\t\t(property "Reference" "R1" (at 102 98 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "10k" (at 102 101 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(instances (project "grid-editors" (path "/cccc0000-0000-0000-0000-000000000011" (reference "R1") (unit 1))))
\t)
)`;

const SYMBOL_UUID = "dddd0000-0000-0000-0000-000000000012";
const DIR = "/home/kicad/documents";
const FILE = `${DIR}/grid-editors.kicad_sch`;

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadOpenFileBusy(): boolean;
  kicadCollabGetPos(id: string): string;
  kicadCollabGetViewport(): string;
  kicadSaveSchematic(p: string): unknown;
};
type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
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
        typeof m?.kicadSaveSchematic === "function"
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
  await page.evaluate(
    ({ sch, dir, file }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      w.FS.writeFile(file, sch);
      w.Module.kicadOpenFile(file);
    },
    { sch: SCH, dir: DIR, file: FILE },
  );
  await expect
    .poll(() => page.evaluate(() => (window.Module as unknown as Mod).kicadOpenFileBusy()), {
      timeout: 120000,
      intervals: [250],
    })
    .toBe(false);
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

/** Screen-space centre of the fixture symbol (viewport math as
 *  quasimodal-strand.spec.ts). */
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
  return {
    x: box!.x + (wx - vp.cx) * vp.scale + vp.w / 2,
    y: box!.y + (wy - vp.cy) * vp.scale + vp.h / 2,
  };
}

const dialogCount = (page: Page) =>
  page.evaluate(
    () =>
      window.wxElementRegistry
        .findAll({ visible: true })
        .filter((e) => /Dialog/i.test(e.typeName) && e.typeName !== "wxFileDialog").length,
  );

type Box = { x: number; y: number; w: number; h: number };

/** Visible wx-dom text inputs (the combo/text grid editors and the
 *  "Library link" field), with their viewport boxes. */
const visibleTextInputs = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("input.wx-dom-control[type=text]"))
      .map((i) => i as HTMLInputElement)
      .filter((i) => i.style.display !== "none")
      .map((i) => {
        const r = i.getBoundingClientRect();
        return {
          value: i.value,
          focused: document.activeElement === i,
          box: { x: r.x, y: r.y, w: r.width, h: r.height } as Box,
        };
      }),
  );

/** The fields grid opens with the Reference cell's text editor already up
 *  (row 0, "Value" column) — the one geometry anchor the page exposes for
 *  the grid's cell layout: same column for every row, and the editor box is
 *  the cell box (wxGridCellTextEditor::SetSize expands it by 2px each side,
 *  the cell pitch adds the 1px grid line: pitch = editor height + 1). */
async function valueColumnAnchor(page: Page): Promise<{ cx: number; row0cy: number; pitch: number }> {
  let anchor: Box | undefined;
  await expect
    .poll(
      async () => {
        const inputs = await visibleTextInputs(page);
        anchor = inputs.find((i) => i.value === "R1")?.box;
        return anchor ? anchor.w : 0;
      },
      { timeout: 20000, intervals: [250] },
    )
    .toBeGreaterThan(100);
  return {
    cx: anchor!.x + anchor!.w / 2,
    row0cy: anchor!.y + anchor!.h / 2,
    pitch: anchor!.h + 1,
  };
}

async function clickOk(page: Page): Promise<void> {
  const rect = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("#window-container button")).find(
      (b) => (b.textContent ?? "").trim() === "OK",
    );
    if (!btn) return null;
    const r = (btn as HTMLElement).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
  });
  expect(rect, "the dialog has an OK button").not.toBeNull();
  expect(rect!.w, "OK button has extent").toBeGreaterThan(0);
  await page.mouse.click(rect!.x, rect!.y);
  await expect.poll(() => dialogCount(page), { timeout: 20000, intervals: [250] }).toBe(0);
}

async function savedProperty(page: Page, name: string): Promise<string | null> {
  const text = await page.evaluate((file) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    w.Module.kicadSaveSchematic(file);
    return w.FS.readFile(file, { encoding: "utf8" });
  }, FILE);
  // The symbol instance's property (the lib_symbols template carries the same
  // names — take the LAST occurrence, the instance is serialized after
  // lib_symbols).
  const re = new RegExp(`\\(property "${name}" "([^"]*)"`, "g");
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

/** Completed wx idle passes (wxWasmIdlePassCount, a plain wasm export). */
const idlePasses = (page: Page) =>
  page.evaluate(
    () => (window.Module as unknown as { _wxWasmIdlePassCount(): number })._wxWasmIdlePassCount(),
  );

/** Resolve once at least one full ProcessIdle() pass has run from now on. */
async function waitForIdlePass(page: Page): Promise<void> {
  const before = await idlePasses(page);
  await expect
    .poll(() => idlePasses(page), { timeout: 20000, intervals: [50] })
    .toBeGreaterThan(before);
}

test.describe("grid cell editors are typeable (Symbol Properties)", () => {
  test("STC editor (Value) receives typed characters; combo editor (Footprint) is full-width", async ({
    page,
  }) => {
    test.setTimeout(240000);
    await bootAndOpen(page);

    const { x, y } = await symbolScreenPos(page);
    await page.mouse.dblclick(x, y);
    await expect.poll(() => dialogCount(page), { timeout: 20000, intervals: [250] }).toBeGreaterThan(0);

    const { cx, row0cy, pitch } = await valueColumnAnchor(page);
    const valueRowY = row0cy + pitch; // row 1: Value
    const footprintRowY = row0cy + 2 * pitch; // row 2: Footprint

    // --- Value: canvas-drawn wxStyledTextCtrl editor -----------------------
    await page.mouse.dblclick(cx, valueRowY);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.wxElementRegistry
              .findAll({ visible: true })
              .filter((e) => e.typeName === "wxStyledTextCtrl").length,
          ),
        { timeout: 20000, intervals: [250] },
      )
      .toBeGreaterThan(0);
    // BeginEdit selects the whole cell text, but the double-click's trailing
    // mouse-up lands in the freshly shown editor and collapses that selection
    // to a caret — select explicitly (SCINTILLA_TRICKS handles Ctrl+A).
    await page.keyboard.press("Control+a");
    await page.keyboard.type("47k");
    await page.keyboard.press("Enter"); // GRID_CELL_STC_EDITOR single-line accept
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.wxElementRegistry
              .findAll({ visible: true })
              .filter((e) => e.typeName === "wxStyledTextCtrl").length,
          ),
        { timeout: 20000, intervals: [250] },
      )
      .toBe(0);

    // The Value commit made WX_GRID's column widths dirty; the auto-size pass
    // that consumes that flag runs from wxEVT_UPDATE_UI on the port's idle
    // (every third event-loop tick) and starts with AcceptCellEditControlIfShown,
    // which would commit+hide the Footprint editor opened below if it ran after
    // the double-click. Wait for one idle pass after the commit so the pass has
    // run before the next editor opens (deterministic; see
    // docs/features/wx-parity-bugs/grid-combo-editor-caret.md §2).
    await waitForIdlePass(page);

    // --- Footprint: wxComboCtrl-based editor --------------------------------
    await page.mouse.dblclick(cx, footprintRowY);
    let combo: { value: string; focused: boolean; box: Box } | undefined;
    await expect
      .poll(
        async () => {
          const inputs = await visibleTextInputs(page);
          combo = inputs.find((i) => Math.abs(i.box.y + i.box.h / 2 - footprintRowY) < pitch / 2);
          return combo ? 1 : 0;
        },
        { timeout: 20000, intervals: [250] },
      )
      .toBe(1);
    // The bug: the inner text ctrl stayed at its 10px creation width.
    expect(combo!.box.w, "combo editor text ctrl spans the cell").toBeGreaterThan(100);
    expect(combo!.focused, "combo editor text ctrl took focus").toBe(true);
    // Per-key pacing (not a Firefox quirk): WX_GRID's auto-size pass, run from
    // the first UPDATE_UI idle after the Value commit above, may commit and
    // hide this editor under the typist; the next key then reopens it through
    // wxGrid::OnChar → StartingKey → WriteText, which inserts at the live DOM
    // caret (gated by grid-combo-editor-caret.spec.ts). Two keys inside that
    // hidden window would lose the second one (OnChar skips it once the editor
    // is enabled and the <input> never saw its keydown), so keep one key per
    // ~40 ms. See docs/features/wx-parity-bugs/grid-combo-editor-caret.md.
    await page.keyboard.type("Resistor_SMD:R_0805", { delay: 40 });
    await expect
      .poll(async () => (await visibleTextInputs(page)).find((i) => i.focused)?.value ?? "", {
        timeout: 20000,
        intervals: [250],
      })
      .toBe("Resistor_SMD:R_0805");

    // OK commits the still-open cell editor (CommitPendingChanges).
    await clickOk(page);

    expect(await savedProperty(page, "Value"), "Value typed through the STC editor").toBe("47k");
    expect(await savedProperty(page, "Footprint"), "Footprint typed through the combo editor").toBe(
      "Resistor_SMD:R_0805",
    );
  });
});
