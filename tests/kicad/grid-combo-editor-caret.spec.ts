/**
 * Symbol Properties → Footprint cell: GRID_CELL_FPID_EDITOR is a wxComboCtrl
 * whose text child is a wx-dom <input>. When wxGrid (re)opens that editor
 * from a KEY — wxGrid::OnChar → BeginEdit (Combo()->SetValue(cell value)) →
 * GRID_CELL_TEXT_BUTTON::StartingKey → wxTextEntry::WriteText(ch) — the wasm
 * port inserts the character at its C++-cached caret, which DoSetValue reset
 * to 0, while the browser draws the caret at the END of the <input> (that is
 * where `el.value = v` leaves it). So typing "e" onto a cell holding "R"
 * yields "eR" and every further character (typed natively into the now
 * focused <input>) lands after the DOM caret: "eRsistor_SMD:R_0805".
 *
 * That is exactly the string grid-editors-typing.spec.ts occasionally
 * produces on Firefox: there the editor is closed UNDER the typist —
 * WX_GRID::RecomputeGridWidths runs on the next wxEVT_UPDATE_UI after any
 * wxEVT_GRID_CELL_CHANGED (the Value cell just committed) and
 * wxGrid::AutoSizeColOrRow starts with AcceptCellEditControlIfShown(), which
 * commits+hides the open Footprint editor (a display:none'd focused <input>
 * drops browser focus to <body>); the next keystroke then reopens the editor
 * through the key path above. This port only runs ProcessIdle every third
 * event-loop tick, so the hide can land tens of ms after the editor opened,
 * i.e. after the first typed character. (Seen live in this spec's trace too:
 * with a freshly COMMITTED cell the recompute hid the reopened editor again
 * ~10 ms later and the next key was prepended as well → "seRistor…".)
 *
 * This spec reproduces the defect without any race: the fixture's Footprint
 * cell already holds "R" (nothing is committed, so no CELL_CHANGED → no
 * auto-size pass); put the grid cursor on the cell without an editor and
 * type — the same reopen-by-key path, deterministically, in both engines.
 *
 * Expected: the character goes where the caret is drawn (end of the text),
 * like wxGTK (gtk_entry_set_text leaves the cursor at the end) and like the
 * <input> itself. Fixed by wx 74fd3a756e (cherry-pick of c5bef486e7 "live
 * DOM caret/selection for wxTextEntry (parity H-3)"): wxTextEntry reads the
 * live DOM caret/selection and WriteText inserts there. Write-up:
 * docs/features/wx-parity-bugs/grid-combo-editor-caret.md
 */

import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";

const SCH = `(kicad_sch
\t(version 20231120)
\t(generator "eeschema")
\t(uuid "cccc0000-0000-0000-0000-000000000021")
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
\t\t(uuid "dddd0000-0000-0000-0000-000000000022")
\t\t(property "Reference" "R1" (at 102 98 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "10k" (at 102 101 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Footprint" "R" (at 102 104 0) (effects (font (size 1.27 1.27)) (justify left) (hide yes)))
\t\t(instances (project "grid-combo-caret" (path "/cccc0000-0000-0000-0000-000000000021" (reference "R1") (unit 1))))
\t)
)`;

const SYMBOL_UUID = "dddd0000-0000-0000-0000-000000000022";
const DIR = "/home/kicad/documents";
const FILE = `${DIR}/grid-combo-caret.kicad_sch`;

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

/** Install the in-page trace: document-level focus/key/input listeners plus
 *  wrappers around the wx-dom bridge entry points wx calls from C++. */
const installTrace = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & { __trace: unknown[][] };
    w.__trace = [];
    const t0 = performance.now();
    const tag = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return String(t);
      const inp = el as HTMLInputElement;
      return el.tagName + (el.id ? "#" + el.id : "") + (inp.type === "text" ? "[" + inp.value + "|" + inp.selectionStart + "]" : "");
    };
    const ae = () => "active=" + tag(document.activeElement);
    const log = (...a: unknown[]) => w.__trace.push([Math.round((performance.now() - t0) * 10) / 10, ...a]);
    log("start", ae());
    for (const ev of ["focusin", "focusout"]) {
      document.addEventListener(ev, (e) => log("doc:" + ev, tag(e.target), ae()));
    }
    document.addEventListener("keydown", (e) => log("doc:keydown", (e as KeyboardEvent).key, ae()), true);
    document.addEventListener("keypress", (e) => log("doc:keypress", (e as KeyboardEvent).key, ae()), true);
    document.addEventListener("input", (e) => log("doc:input", tag(e.target)), true);
    for (const fn of ["wxDomSetValue", "wxDomFocus", "wxDomBlurActive", "wxDomSetShown", "wxDomSetSelection"]) {
      const orig = w[fn] as (...args: unknown[]) => unknown;
      if (typeof orig !== "function") continue;
      w[fn] = function (this: unknown, ...args: unknown[]) {
        log(fn, JSON.stringify(args).slice(0, 60), ae());
        return orig.apply(this, args);
      };
    }
  });

/** Attach the trace; echo it to the log only when the caller says the run
 *  went wrong (keeps CI output quiet on green). */
async function dumpTrace(page: Page, testInfo: TestInfo, name: string, echo: boolean): Promise<void> {
  const trace = await page.evaluate(() => (window as unknown as { __trace: unknown[][] }).__trace);
  const text = trace.map((r) => r.join("  ")).join("\n");
  await testInfo.attach(name, { body: text, contentType: "text/plain" });
  if (echo) console.log(`--- ${name} (${testInfo.project.name}) ---\n${text}\n---`);
}

const TYPED = "Resistor_SMD:R_0805";

/** The visible wx-dom text input centred on a grid row, if any. */
async function inputOnRow(page: Page, rowY: number, pitch: number) {
  const inputs = await visibleTextInputs(page);
  return inputs.find((i) => Math.abs(i.box.y + i.box.h / 2 - rowY) < pitch / 2);
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
  // The symbol instance's property is serialized after lib_symbols: last wins.
  const re = new RegExp(`\\(property "${name}" "([^"]*)"`, "g");
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

test.describe("grid combo editor (Footprint) caret", () => {
  test("a key that reopens the editor on a filled cell appends at the drawn caret", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240000);
    await bootAndOpen(page);

    const { x, y } = await symbolScreenPos(page);
    await page.mouse.dblclick(x, y);
    await expect.poll(() => dialogCount(page), { timeout: 20000, intervals: [250] }).toBeGreaterThan(0);

    const { cx, row0cy, pitch } = await valueColumnAnchor(page);
    const footprintRowY = row0cy + 2 * pitch; // row 2: Footprint
    // The Name column sits left of the Value column; the Reference editor's
    // box is the Value column, so anything left of it is the (read-only) Name.
    const nameX = (await inputOnRow(page, row0cy, pitch))!.box.x - 30;
    expect(nameX, "a Name column left of the Value column").toBeGreaterThan(0);

    await installTrace(page);

    // 1. Park the grid cursor on the Footprint row WITHOUT an editor: a click on
    //    the row's read-only Name cell. wxGrid disables the (Reference) editor
    //    that the dialog opened on show — its value is unchanged, so no
    //    CELL_CHANGED and no auto-size pass — and the Name cell cannot open
    //    one. The grid window takes wx focus (browser focus → <body>).
    await page.mouse.click(nameX, footprintRowY);
    await expect
      .poll(async () => (await inputOnRow(page, row0cy, pitch)) === undefined, {
        timeout: 20000,
        intervals: [250],
      })
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body), {
        timeout: 20000,
        intervals: [250],
      })
      .toBe(true);

    // 2. Onto the Footprint cell with the keyboard (cursor moves never open an
    //    editor) and type the second character of the target: wxGrid::OnChar →
    //    BeginEdit ("R" from the table; the <input> draws its caret at the end)
    //    → StartingKey → wxTextEntry::WriteText("e").
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type(TYPED[1]);
    await expect
      .poll(async () => (await inputOnRow(page, footprintRowY, pitch))?.focused ?? false, {
        timeout: 20000,
        intervals: [250],
      })
      .toBe(true);
    await expect
      .poll(async () => (await inputOnRow(page, footprintRowY, pitch))?.value ?? "", {
        timeout: 10000,
        intervals: [100],
      })
      .toMatch(/^.{2}$/);
    // 3. The rest goes natively into the reopened, focused <input>; wait for
    //    the last character to have arrived (every key lands as its own DOM
    //    'input', in order — the only question is WHERE the second one went).
    await page.keyboard.type(TYPED.slice(2), { delay: 20 });
    await expect
      .poll(async () => ((await inputOnRow(page, footprintRowY, pitch))?.value ?? "").length, {
        timeout: 10000,
        intervals: [100],
      })
      .toBe(TYPED.length);

    const value = (await inputOnRow(page, footprintRowY, pitch))?.value ?? "";
    await dumpTrace(page, testInfo, "trace", value !== TYPED);
    expect.soft(value, "the reopening key inserted at the drawn caret (end)").toBe(TYPED);

    // OK commits the still-open cell editor; the file must carry the same text.
    await clickOk(page);
    expect(await savedProperty(page, "Footprint"), "Footprint as saved").toBe(TYPED);
  });
});
