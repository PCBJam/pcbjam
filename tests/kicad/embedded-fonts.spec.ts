import * as fs from "fs";
import * as path from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { findRenderedByType, stableShot, waitForRenderedByLabel } from "../e2e/utils/element-tracker";
import { bootOpen, drift, renderDoc, settleConverged, startV2, type ToolCfg } from "./utils/trio";

/**
 * KiCad 9+ embedded fonts in the wasm editors (pcbjam-private issue 14; findings and
 * plan in docs/features/fonts/0001-embedded-fonts.md).
 *
 * The wasm build has FreeType + HarfBuzz but no fontconfig: wasm/stubs/fontconfig_wasm.cpp
 * serves the fonts documents embed (extracted to the embed cache in MEMFS) and the browser's
 * installed fonts (Local Font Access, handed over by the shell); anything else gets the
 * bundled fallback (Noto Sans) and keeps its name. In a room, the fonts texts use are embedded
 * as they are used, not only on save (wasm/bindings/embedded_sync.h). Fixtures in
 * tests/fixtures/embedded-fonts carry two texts with the same
 * string: uuid ...0002 in the TrueType face `wxprivate`, ...0003 in the KiCad stroke font.
 * The TrueType one lays out ~1.6x wider, so comparing the two bounding boxes shows which
 * font a text resolved to.
 *
 * What works is asserted plainly. Each gap asserts the CORRECT behavior and is marked
 * test.fail() naming its GAP in the doc; fixing the gap flips it to an unexpected pass.
 */

type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string | Uint8Array): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
  readdir(p: string): string[];
  stat(p: string): { size: number };
};
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadItemBBox(id: string): string;
  kicadSaveBoard(p: string): unknown;
  kicadSaveSchematic(p: string): unknown;
  kicadCollabTestItemBlob(id: string): string;
  kicadCollabApplyItems(j: string): unknown;
  kicadCollabTestSelectByUuid(id: string): boolean;
  kicadCollabTestMoveBoardItem(id: string, dx: number, dy: number): boolean;
  kicadCollabTestMoveSchItem(id: string, dx: number, dy: number): boolean;
  kicadTestRunAction(name: string): boolean;
  kicadSetLocalFonts(json: string): void;
};
type W = { FS: FS; Module: Mod };
type BBox = { x: number; y: number; w: number; h: number };

const BOOT = 150000;
const DOC = "docs/features/fonts/0001-embedded-fonts.md";
const FIXTURES = path.join(__dirname, "..", "fixtures", "embedded-fonts");
const DOCS = "/home/kicad/documents";
// PATHS::GetUserCachePath()/embed on wasm (wasm/kiplatform/environment.cpp + common/paths.cpp)
const EMBED_CACHE = "/home/kicad/.cache/kicad/kicad/10.0/embed";
const FONT_BYTES = fs.statSync(path.join(FIXTURES, "wxprivate.ttf")).size;

const PCB_TTF = "a0000000-0000-4000-8000-000000000002";
const PCB_STROKE = "a0000000-0000-4000-8000-000000000003";
const SCH_TTF = "b0000000-0000-4000-8000-000000000002";
const SCH_STROKE = "b0000000-0000-4000-8000-000000000003";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

/** Every `(file …)` of an `(embedded_files …)` block; `data` without bars and whitespace. */
function embeddedFiles(text: string): Array<{ name: string; data: string }> {
  const re = /\(file\s+\(name "([^"]+)"\)\s+\(type font\)\s+\(data([^)]*)\)/g;
  return [...text.matchAll(re)].map((m) => ({ name: m[1]!, data: m[2]!.replace(/[|\s]/g, "") }));
}
const faces = (text: string) => [...text.matchAll(/\(face "([^"]+)"\)/g)].map((m) => m[1]);
const count = (text: string, needle: string) => text.split(needle).length - 1;
/** Width of the TrueType text relative to the same string in the stroke font, minus one. */
const widthDelta = (ttf: BBox, stroke: BBox) => Math.abs(ttf.w / stroke.w - 1);

async function boot(page: Page, html: string): Promise<void> {
  await page.goto(`/kicad/${html}`);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadItemBBox === "function";
    },
    null,
    { timeout: BOOT },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: BOOT },
  );
}

/** Write a fixture (and optionally a minimal .kicad_pro next to it) into MEMFS and open it;
 *  resolves once the item `probeId` is in the model. */
async function open(page: Page, file: string, probeId: string, opts: { project?: boolean; content?: string } = {}): Promise<void> {
  const stem = file.replace(/\.[^.]+$/, "");
  await page.evaluate(
    ({ dir, file, content, pro }) => {
      const w = window as unknown as W;
      w.FS.mkdirTree(dir);
      if (pro) w.FS.writeFile(`${dir}/${pro.name}`, pro.content);
      w.FS.writeFile(`${dir}/${file}`, content);
      w.Module.kicadOpenFile(`${dir}/${file}`);
    },
    {
      dir: DOCS,
      file,
      content: opts.content ?? fixture(file),
      pro: opts.project
        ? { name: `${stem}.kicad_pro`, content: JSON.stringify({ meta: { filename: `${stem}.kicad_pro`, version: 3 } }) }
        : null,
    },
  );
  await expect
    .poll(() => page.evaluate((id) => (window as unknown as W).Module.kicadItemBBox(id), probeId), {
      timeout: 60000,
      intervals: [500],
    })
    .not.toBe("");
}

async function bbox(page: Page, id: string): Promise<BBox> {
  const raw = await page.evaluate((i) => (window as unknown as W).Module.kicadItemBBox(i), id);
  expect(raw, `bbox of ${id}`).not.toBe("");
  return JSON.parse(raw) as BBox;
}

/** Files in the embed cache (name -> size); empty when the dir was never created. */
async function embedCache(page: Page): Promise<Record<string, number>> {
  return page.evaluate((dir) => {
    const w = window as unknown as W;
    let names: string[];
    try {
      names = w.FS.readdir(dir).filter((n) => n !== "." && n !== "..");
    } catch {
      return {}; // no embed dir: nothing was extracted
    }
    return Object.fromEntries(names.map((n) => [n, w.FS.stat(`${dir}/${n}`).size]));
  }, EMBED_CACHE);
}

async function save(page: Page, saveFn: "kicadSaveBoard" | "kicadSaveSchematic", name: string): Promise<string> {
  return page.evaluate(
    ({ saveFn, out }) => {
      const w = window as unknown as W;
      w.Module[saveFn](out);
      return w.FS.readFile(out, { encoding: "utf8" });
    },
    { saveFn, out: `${DOCS}/${name}` },
  );
}

const visible = (page: Page, typeName: string, label?: string) =>
  page.evaluate(
    ({ typeName, label }) =>
      window.wxElementRegistry!.findAll({ visible: true }).find((e) => e.typeName === typeName && (label === undefined || e.label === label)) ?? null,
    { typeName, label },
  );

/** Select the item and open its properties dialog (the E hotkey's action). */
async function openProperties(page: Page, id: string, action = "pcbnew.InteractiveEdit.properties"): Promise<void> {
  await page.evaluate((i) => (window as unknown as W).Module.kicadCollabTestSelectByUuid(i), id);
  await page.evaluate((a) => (window as unknown as W).Module.kicadTestRunAction(a), action);
  await expect.poll(() => visible(page, "wxOwnerDrawnComboBox"), { timeout: 30000 }).not.toBeNull();
}

type Row = { label: string; centerX: number; centerY: number };

/** Rows of the open dropdown popup (the registry's painted listbox items); [] while closed. */
const popupRows = (page: Page): Promise<Row[]> =>
  page.evaluate(() => {
    const pop = Array.from(document.querySelectorAll<HTMLElement>(".window.popup")).find((p) => p.style.display !== "none" && p.isConnected);
    const r = pop?.getBoundingClientRect();
    if (!r || r.width === 0) return [];
    return window
      .wxElementRegistry!.findRenderedByType("listboxitem", {})
      .filter((e) => e.centerX > r.left && e.centerX < r.right && e.centerY > r.top && e.centerY < r.bottom)
      .map((e) => ({ label: e.label, centerX: e.centerX, centerY: e.centerY }))
      // An earlier dialog's popup can leave its rows registered at the same spots.
      .filter((e, i, all) => all.findIndex((o) => o.label === e.label && o.centerY === e.centerY) === i);
  });

/** Open the Text Properties Font dropdown with its arrow button; resolves to its rows. */
async function openFontList(page: Page): Promise<Row[]> {
  const combo = (await visible(page, "wxOwnerDrawnComboBox"))!;
  const arrow = (await findRenderedByType(page, "combobutton")).sort((a, b) => Math.abs(a.centerY - combo.centerY) - Math.abs(b.centerY - combo.centerY))[0];
  expect(arrow, "the Font field's drop button").toBeTruthy();
  await page.mouse.click(arrow!.centerX, arrow!.centerY);
  await expect.poll(async () => (await popupRows(page)).length, { message: "the Font list opens" }).toBeGreaterThan(0);
  return popupRows(page);
}

/** Click a row of the open Font list, as a user picking a font does. */
async function pickRow(page: Page, row: Row): Promise<void> {
  await page.mouse.click(row.centerX, row.centerY);
  await expect.poll(async () => (await popupRows(page)).length, { message: "the Font list closes" }).toBe(0);
}

async function clickOk(page: Page): Promise<void> {
  const ok = await visible(page, "wxButton", "&OK");
  expect(ok, "dialog OK button").not.toBeNull();
  await page.mouse.click(ok!.centerX, ok!.centerY);
  await expect.poll(() => visible(page, "wxDialog"), { timeout: 30000 }).toBeNull();
}

/** A KiCad file without its embedded fonts: `(embedded_fonts no)`, no `(embedded_files …)`. */
function withoutEmbedded(text: string): string {
  const start = text.indexOf("(embedded_files");
  let end = start;
  for (let depth = 0; end < text.length; end++) {
    if (text[end] === "(") depth++;
    else if (text[end] === ")" && --depth === 0) break;
  }
  return (text.slice(0, start) + text.slice(end + 1)).replace("(embedded_fonts yes)", "(embedded_fonts no)");
}

// The browser's installed fonts as the shell hands them over (web/standalone/src/wasm/local-fonts.ts):
// a provider whose load() returns a face's bytes, and the list pushed with kicadSetLocalFonts.
const LOCAL_ID = "wxprivate-Regular";
const LOCAL_PATH = `/home/kicad/.local/share/fonts/${LOCAL_ID}.ttf`;

/** Install a stand-in provider offering wxprivate.ttf as an installed font. `prefetched`
 *  writes the face to MEMFS first, as the open flow's prefetch does. `path` puts it where
 *  the shell writes a team library font instead (wasm/lib-fonts.ts, fonts 0002). */
async function installLocalFonts(page: Page, opts: { prefetched?: boolean; path?: string } = {}): Promise<void> {
  await page.evaluate(
    ({ b64, id, path, prefetched }) => {
      const w = window as unknown as W & { __pcbjamLocalFonts?: unknown; __localFontLoads?: string[] };
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const loads: string[] = [];
      w.__localFontLoads = loads;
      w.__pcbjamLocalFonts = {
        load: async (want: string) => {
          loads.push(want);
          return want === id ? bytes : null;
        },
      };
      if (prefetched) {
        w.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
        w.FS.writeFile(path, bytes);
      }
      w.Module.kicadSetLocalFonts(JSON.stringify([{ id, family: "wxprivate", style: "Regular", path }]));
    },
    { b64: fs.readFileSync(path.join(FIXTURES, "wxprivate.ttf")).toString("base64"), id: LOCAL_ID, path: opts.path ?? LOCAL_PATH, prefetched: !!opts.prefetched },
  );
}

/** One resistor (tests/kicad/fixtures-integrity/copied-symbol.kicad_sch) with its Value field
 *  in `wxprivate` and "Embed fonts" on; `text` adds a free text in the same font. */
function symbolSchematic(opts: { text: boolean }): string {
  let sch = fs
    .readFileSync(path.join(__dirname, "fixtures-integrity", "copied-symbol.kicad_sch"), "utf8")
    .replace('(property "Value" "R" (at 129.54 96.52 0) (effects (font (size 1.27 1.27))', '(property "Value" "R" (at 129.54 96.52 0) (effects (font (face "wxprivate") (size 1.27 1.27))')
    .replace(/\(sheet_instances \(path "\/" \(page "1"\)\)\)\n\)\s*$/, '(sheet_instances (path "/" (page "1")))\n\t(embedded_fonts yes)\n)\n');
  if (opts.text) {
    sch = sch.replace(
      "\t(sheet_instances",
      '\t(text "FONT TTF" (exclude_from_sim no) (at 100 80 0) (effects (font (face "wxprivate") (size 2 2)) (justify left bottom)) (uuid "eeeeeeee-0000-0000-0000-000000000001"))\n\t(sheet_instances',
    );
  }
  expect(faces(sch), "the fixture edit applied").toHaveLength(opts.text ? 2 : 1);
  return sch;
}
const SYMBOL = "bbbbbbbb-2222-2222-2222-222222222222";

const localFontLoads = (page: Page) =>
  page.evaluate(() => (window as unknown as { __localFontLoads?: string[] }).__localFontLoads ?? []);

const memfsHas = (page: Page, p: string) =>
  page.evaluate((f) => {
    try {
      return (window as unknown as W).FS.stat(f).size > 0;
    } catch {
      return false;
    }
  }, p);

/** A wx checkbox's state: the port renders it as <label><input type=checkbox><span>label</span></label>. */
const checkboxChecked = (page: Page, label: string) =>
  page.evaluate(
    (text) =>
      [...document.querySelectorAll<HTMLInputElement>("label > input[type=checkbox]")].find(
        (i) => i.parentElement?.querySelector(".wx-label")?.textContent === text,
      )?.checked ?? null,
    label,
  );

const suspendErrors = (l: { consoleLogs: string[]; errors: string[] }) =>
  [...l.consoleLogs, ...l.errors].filter((s) => /SuspendError|tried to park/.test(s));

test.describe("embedded fonts (pcbnew)", () => {
  test.describe.configure({ timeout: 300000 });

  test("a board's embedded TrueType font is extracted and used for its text", async ({ page, testLogger }) => {
    await boot(page, "pcbnew-collab.html");
    await open(page, "embedded-font.kicad_pcb", PCB_TTF);

    const cache = await embedCache(page);
    console.log(`[FONTS] embed cache: ${JSON.stringify(cache)}`);
    expect(Object.values(cache), "the embedded font is extracted to the embed cache").toContain(FONT_BYTES);
    const ttf = await bbox(page, PCB_TTF);
    const stroke = await bbox(page, PCB_STROKE);
    console.log(`[FONTS] bbox ttf=${JSON.stringify(ttf)} stroke=${JSON.stringify(stroke)}`);
    expect(widthDelta(ttf, stroke), "the TrueType text does not lay out like the stroke font").toBeGreaterThan(0.1);

    await stableShot(page, "embedded-fonts-pcb-01-loaded.png");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("without a render cache the glyphs come from the embedded font itself", async ({ page, testLogger }) => {
    await boot(page, "pcbnew-collab.html");
    await open(page, "embedded-font-nocache.kicad_pcb", PCB_TTF);

    expect(widthDelta(await bbox(page, PCB_TTF), await bbox(page, PCB_STROKE))).toBeGreaterThan(0.1);
    // A save writes a render_cache only for outline-font text; native KiCad wrote 8 glyph
    // polygons for this string (the cache in embedded-font.kicad_pcb).
    const saved = await save(page, "kicadSaveBoard", "nocache-saved.kicad_pcb");
    expect(saved, "a render_cache is regenerated from the font").toContain('(render_cache "FONT TTF"');
    expect(count(saved, "(polygon"), "the same glyph polygons as native KiCad").toBe(count(fixture("embedded-font.kicad_pcb"), "(polygon"));

    await stableShot(page, "embedded-fonts-pcb-02-nocache.png");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a face that is named but not embedded is drawn in the fallback font", async ({ page, testLogger }) => {
    await boot(page, "pcbnew-collab.html");
    await open(page, "face-only.kicad_pcb", PCB_TTF);

    expect(await embedCache(page), "nothing to extract").toEqual({});
    // Native KiCad substitutes an installed system font (Verdana on macOS); the wasm build
    // substitutes its bundled fallback (Noto Sans), not the stroke font (GAP-2).
    expect((await bbox(page, PCB_TTF)).w, "not laid out like the stroke font").not.toBe((await bbox(page, PCB_STROKE)).w);
    await stableShot(page, "embedded-fonts-pcb-03-face-only.png");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a face that is named but not embedded keeps its name on save, and the fallback is never embedded", async ({ page }) => {
    await boot(page, "pcbnew-collab.html");
    await open(page, "face-only.kicad_pcb", PCB_TTF, { content: fixture("face-only.kicad_pcb").replace("(embedded_fonts no)", "(embedded_fonts yes)") });
    const saved = await save(page, "kicadSaveBoard", "face-only-saved.kicad_pcb");
    console.log(`[FONTS] face-only faces after save: ${JSON.stringify(faces(saved))}`);
    expect(faces(saved), "native KiCad writes the face it was given").toEqual(["wxprivate"]);
    // "Embed fonts" is on, but the stand-in is not the font the board asked for.
    expect(saved).toContain("(embedded_fonts yes)");
    expect(saved, "the fallback font is not embedded").not.toContain("(embedded_files");
  });

  test("a save keeps the embedded font, once", async ({ page }) => {
    test.fail(true, `GAP-1 in ${DOC}: EmbedFonts re-adds the font from the embed cache as kicad_embedded_<hash>.ttf`);
    await boot(page, "pcbnew-collab.html");
    await open(page, "embedded-font.kicad_pcb", PCB_TTF);
    const saved = await save(page, "kicadSaveBoard", "embedded-saved.kicad_pcb");
    const files = embeddedFiles(saved);
    console.log(`[FONTS] saved ${saved.length} chars, embedded fonts: ${JSON.stringify(files.map((f) => f.name))}`);
    expect(saved).toContain("(embedded_fonts yes)");
    expect(files.map((f) => f.data), "the payload is unchanged").toContain(embeddedFiles(fixture("embedded-font.kicad_pcb"))[0]!.data);
    expect(files.map((f) => f.name), "one copy of the font").toEqual(["wxprivate.ttf"]);
  });

  test("Text Properties: OK and the Bold toggle keep the TrueType font", async ({ page, testLogger }) => {
    await boot(page, "pcbnew-collab.html");
    await open(page, "embedded-font.kicad_pcb", PCB_TTF);
    const before = await bbox(page, PCB_TTF);

    await openProperties(page, PCB_TTF);
    // Bold only sets the flag (DIALOG_TEXT_PROPERTIES calls SetBoldFlag), so the face stays.
    // The B toggle is a BITMAP_BUTTON the registry does not list. It opens the button bar in
    // the grid column (dialog_text_properties_base) whose "Position X:" label has a 15 px
    // left border, so its left edge is that label's minus 15 whatever the font metrics.
    const combo = (await visible(page, "wxOwnerDrawnComboBox"))!;
    const posX = (await visible(page, "wxStaticText", "Position X:"))!;
    await page.mouse.click(posX.screenX - 15 + 8, combo.centerY);
    await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: the bitmap toggle has no registry signal
    await stableShot(page, "embedded-fonts-pcb-05-text-props-bold.png");
    await clickOk(page);

    const saved = await save(page, "kicadSaveBoard", "props-bold.kicad_pcb");
    expect(saved, "the Bold toggle applied").toContain("(bold yes)");
    expect(faces(saved), "the face survives").toContain("wxprivate");
    const after = await bbox(page, PCB_TTF);
    console.log(`[FONTS] bbox before=${JSON.stringify(before)} after bold=${JSON.stringify(after)}`);
    expect(after.w, "still laid out in the TrueType face").toBe(before.w);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // GAP-3 in the doc: FONT_CHOICE::OnKillFocus swaps a name the list lacks for the KiCad Font,
  // so the list must hold the board's embedded font by its family.
  test("Text Properties: visiting the Font field leaves a TrueType text in its face", async ({ page }) => {
    await boot(page, "pcbnew-collab.html");
    await open(page, "embedded-font.kicad_pcb", PCB_TTF);
    const before = await bbox(page, PCB_TTF);

    await openProperties(page, PCB_TTF);
    const combo = (await visible(page, "wxOwnerDrawnComboBox"))!;
    await page.mouse.click(combo.screenX + combo.width - 8, combo.centerY);
    await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: the owner-drawn popup has no registry entry to wait on
    // The list: "KiCad Font" and the embedded font's family, "wxprivate".
    await stableShot(page, "embedded-fonts-pcb-06-font-list.png");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: popup dismissal has no registry signal
    await clickOk(page);

    expect(await bbox(page, PCB_TTF), "the text keeps its TrueType layout").toEqual(before);
  });

  test("Board Setup lists the embedded font, and Add file picks a .ttf from MEMFS", async ({ page, testLogger }) => {
    await boot(page, "pcbnew-collab.html");
    // A project next to the board: without one Board Setup is read-only ("Embed fonts" disabled).
    await open(page, "face-only.kicad_pcb", PCB_TTF, { project: true });
    await page.evaluate((b64) => {
      const w = window as unknown as W;
      w.FS.mkdirTree("/home/kicad/documents/fonts");
      w.FS.writeFile("/home/kicad/documents/fonts/wxprivate.ttf", Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    }, fs.readFileSync(path.join(FIXTURES, "wxprivate.ttf")).toString("base64"));

    await page.evaluate(() => (window as unknown as W).Module.kicadTestRunAction("pcbnew.EditorControl.boardSetup"));
    const tree = await waitForRenderedByLabel(page, "Embedded Files", { elementType: "treeitem", timeout: 30000 });
    await page.mouse.click(tree.centerX, tree.centerY);
    await expect.poll(() => visible(page, "wxCheckBox", "Embed fonts"), { timeout: 30000 }).not.toBeNull();
    expect((await visible(page, "wxCheckBox", "Embed fonts"))!.enabled, "Embed fonts is editable in a project").toBe(true);

    // The add button is the left one of the two under the grid.
    const add = await page.evaluate(() =>
      window.wxElementRegistry!.findAll({ visible: true }).filter((e) => e.typeName === "StdBitmapButton").sort((a, b) => a.centerX - b.centerX)[0] ?? null,
    );
    expect(add, "Add file button").not.toBeNull();
    await page.mouse.click(add!.centerX, add!.centerY);
    await expect.poll(() => visible(page, "wxFileDialog"), { timeout: 30000 }).not.toBeNull();
    const input = await page.evaluate(() =>
      window.wxElementRegistry!.findAll({ visible: true }).find((e) => e.typeName === "wxTextCtrl" && e.name === "text") ?? null,
    );
    expect(input, "file name field").not.toBeNull();
    await page.mouse.click(input!.centerX, input!.centerY);
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: focus click before typing (load-pcb.spec)
    await page.keyboard.type("/home/kicad/documents/fonts/wxprivate.ttf");
    await page.keyboard.press("Enter");
    await expect.poll(() => visible(page, "wxFileDialog"), { timeout: 30000 }).toBeNull();
    await waitForRenderedByLabel(page, "kicad-embed://wxprivate.ttf", { elementType: "gridcell", timeout: 30000 });
    await stableShot(page, "embedded-fonts-pcb-08-added.png");

    // What the added font can do is GAP-3: no text can select it, and ticking "Embed fonts"
    // (embed the fonts texts use) or a save with it off both drop it again.
    await clickOk(page);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a TrueType text moved by a collab peer keeps its face", async ({ browser, browserName }) => {
    test.skip(browserName === "firefox", "two heavy editors exceed Firefox's per-process wasm budget (see utils/trio.ts)");
    const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()];
    const [a, b] = [await ctxA.newPage(), await ctxB.newPage()];
    try {
      await Promise.all([boot(a, "pcbnew-collab.html"), boot(b, "pcbnew-collab.html")]);
      await open(a, "embedded-font.kicad_pcb", PCB_TTF);
      await open(b, "embedded-font.kicad_pcb", PCB_TTF);
      const before = await bbox(b, PCB_TTF);

      const blob = await a.evaluate((id) => (window as unknown as W).Module.kicadCollabTestItemBlob(id), PCB_TTF);
      expect(blob, "item blob for the TrueType text").toContain('(face "wxprivate")');
      await b.evaluate(
        (sexpr) => (window as unknown as W).Module.kicadCollabApplyItems(JSON.stringify({ added: [], changed: [{ sexpr, parent: null }], removed: [] })),
        blob.replace("(at 95 95 0)", "(at 95 90 0)"),
      );
      await expect.poll(async () => (await bbox(b, PCB_TTF)).y, { timeout: 25000, intervals: [400] }).toBe(before.y - 5_000_000);
      expect((await bbox(b, PCB_TTF)).w, "the moved text keeps its TrueType layout").toBe(before.w);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("a bold TrueType text applied from a collab peer keeps its face", async ({ browser, browserName }) => {
    test.skip(browserName === "firefox", "two heavy editors exceed Firefox's per-process wasm budget (see utils/trio.ts)");
    // GAP-4 in the doc: a remote item resolves its font without the board's embedded files;
    // the font lookup keeps every embedded face of the session findable.
    const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()];
    const [a, b] = [await ctxA.newPage(), await ctxB.newPage()];
    try {
      await Promise.all([boot(a, "pcbnew-collab.html"), boot(b, "pcbnew-collab.html")]);
      await open(a, "embedded-font.kicad_pcb", PCB_TTF);
      await open(b, "embedded-font.kicad_pcb", PCB_TTF);

      const blob = await a.evaluate((id) => (window as unknown as W).Module.kicadCollabTestItemBlob(id), PCB_TTF);
      const BOLD = "a0000000-0000-4000-8000-0000000000b2";
      const bold = blob.split(PCB_TTF).join(BOLD).replace("(at 95 95 0)", "(at 95 105 0)").replace('(face "wxprivate")', '(face "wxprivate") (bold yes)');
      await b.evaluate(
        (sexpr) => (window as unknown as W).Module.kicadCollabApplyItems(JSON.stringify({ added: [{ sexpr, parent: null }], changed: [], removed: [] })),
        bold,
      );
      await expect.poll(() => b.evaluate((id) => (window as unknown as W).Module.kicadItemBBox(id), BOLD), { timeout: 25000, intervals: [400] }).not.toBe("");
      const boldBox = await bbox(b, BOLD);
      console.log(`[FONTS] peer bold bbox=${JSON.stringify(boldBox)} stroke=${JSON.stringify(await bbox(b, PCB_STROKE))}`);
      expect(widthDelta(boldBox, await bbox(b, PCB_STROKE)), "not drawn in the stroke font").toBeGreaterThan(0.1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("a room seeded from the board keeps the font block, and a peer's move arrives as TrueType", async ({ context, browserName }) => {
    test.skip(browserName === "firefox", "two heavy editors exceed Firefox's per-process wasm budget (see utils/trio.ts)");
    const cfg: ToolCfg = {
      html: "pcbnew-collab.html",
      ext: "kicad_pcb",
      saveFn: "kicadSaveBoard",
      fixture: fixture("embedded-font.kicad_pcb"),
      fns: ["kicadItemBBox", "kicadCollabTestMoveBoardItem"],
    };
    const room = `embedded-fonts-${test.info().workerIndex}`;
    const [A, B] = [await context.newPage(), await context.newPage()];
    await bootOpen(A, cfg);
    await bootOpen(B, cfg);
    await startV2(A, { room, seedText: cfg.fixture });
    await startV2(B, { room, editorMatchesDoc: true });
    const duo = { tabs: [["A", A], ["B", B]] as const };
    await settleConverged(duo, cfg);

    // The room's Y.Doc holds the font block as the file had it.
    const seeded = await renderDoc(A);
    expect(seeded.err, "the room doc materializes").toBeUndefined();
    expect(embeddedFiles(seeded.ok!).map((f) => f.data), "the payload is in the room doc").toContain(embeddedFiles(cfg.fixture)[0]!.data);
    for (const [label, page] of duo.tabs) {
      const d = await drift(page, cfg);
      console.log(`[FONTS] room drift ${label}: ${JSON.stringify(d)}`);
      expect([...(d?.added ?? []), ...(d?.updated ?? []), ...(d?.removed ?? [])], `${label} item drift`).toEqual([]);
    }

    const before = await bbox(B, PCB_TTF);
    expect(await A.evaluate((id) => (window as unknown as W).Module.kicadCollabTestMoveBoardItem(id, 0, -5_000_000), PCB_TTF)).toBe(true);
    await expect.poll(async () => (await bbox(B, PCB_TTF)).y, { timeout: 30000, intervals: [400] }).toBe(before.y - 5_000_000);
    expect((await bbox(B, PCB_TTF)).w, "B draws the moved text in the TrueType face").toBe(before.w);
    await settleConverged(duo, cfg);
    const after = await renderDoc(A);
    expect(embeddedFiles(after.ok!).map((f) => f.data), "the payload is still in the room doc").toContain(embeddedFiles(cfg.fixture)[0]!.data);
    // A background tab's canvas repaints on its next input event, so the shot would show the
    // pre-move frame; the bbox above is the real check.
    await B.bringToFront();
    await B.mouse.move(600, 400);
    await stableShot(B, "embedded-fonts-pcb-09-room-peer.png");
  });
});

test.describe("embedded fonts (eeschema)", () => {
  test.describe.configure({ timeout: 300000 });

  test("a schematic's embedded TrueType font is extracted and used for its text", async ({ page, testLogger }) => {
    await boot(page, "eeschema.html");
    await open(page, "embedded-font.kicad_sch", SCH_TTF);

    expect(Object.values(await embedCache(page)), "the embedded font is extracted to the embed cache").toContain(FONT_BYTES);
    const ttf = await bbox(page, SCH_TTF);
    const stroke = await bbox(page, SCH_STROKE);
    console.log(`[FONTS] sch bbox ttf=${JSON.stringify(ttf)} stroke=${JSON.stringify(stroke)}`);
    expect(widthDelta(ttf, stroke), "the TrueType text does not lay out like the stroke font").toBeGreaterThan(0.1);
    await stableShot(page, "embedded-fonts-sch-01-loaded.png");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // GAP-3 in the doc: the list used to name the embedded font after its cache file
  // (kicad_embedded_<hash>), which resolved to the stroke font when picked.
  test("Text Properties: a text switched to the KiCad Font can be switched back to its embedded font", async ({ page }) => {
    await boot(page, "eeschema.html");
    await open(page, "embedded-font.kicad_sch", SCH_TTF);
    const ttf = await bbox(page, SCH_TTF);
    const stroke = await bbox(page, SCH_STROKE);

    await openProperties(page, SCH_TTF, "eeschema.InteractiveEdit.properties");
    const first = await openFontList(page);
    await pickRow(page, first.find((r) => r.label === "KiCad Font")!);
    await clickOk(page);
    expect((await bbox(page, SCH_TTF)).w, "switched to the stroke font").toBe(stroke.w);

    await openProperties(page, SCH_TTF, "eeschema.InteractiveEdit.properties");
    const rows = await openFontList(page);
    console.log(`[FONTS] sch Font list: ${JSON.stringify(rows.map((r) => r.label))}`);
    // "Default Font", "KiCad Font" and the embedded font by its family.
    await stableShot(page, "embedded-fonts-sch-02-font-list.png");
    const family = rows.find((r) => r.label === "wxprivate");
    expect(family, "the embedded font is offered under its family name").toBeTruthy();
    await pickRow(page, family!);
    await clickOk(page);
    expect((await bbox(page, SCH_TTF)).w, "back in the embedded TrueType face").toBe(ttf.w);
  });

  test("a schematic save keeps the embedded font, once", async ({ page }) => {
    test.fail(true, `GAP-1 in ${DOC}: EmbedFonts re-adds the font from the embed cache as kicad_embedded_<hash>.ttf`);
    await boot(page, "eeschema.html");
    await open(page, "embedded-font.kicad_sch", SCH_TTF);
    const saved = await save(page, "kicadSaveSchematic", "embedded-saved.kicad_sch");
    const files = embeddedFiles(saved);
    console.log(`[FONTS] sch saved ${saved.length} chars, embedded fonts: ${JSON.stringify(files.map((f) => f.name))}`);
    expect(saved).toContain("(embedded_fonts yes)");
    expect(faces(saved)).toContain("wxprivate");
    expect(files.map((f) => f.name), "one copy of the font").toEqual(["wxprivate.ttf"]);
  });
});

test.describe("installed fonts (eeschema)", () => {
  test.describe.configure({ timeout: 300000 });

  // Neither text names a TrueType face, and nothing is embedded: both draw in the stroke font.
  const plain = () => withoutEmbedded(fixture("embedded-font.kicad_sch")).split('(face "wxprivate")').join("");

  test("an installed font is listed by family, fetched when picked, and draws the text", async ({ page, testLogger }) => {
    await boot(page, "eeschema.html");
    await open(page, "embedded-font.kicad_sch", SCH_STROKE, { content: plain() });
    await installLocalFonts(page);
    const stroke = await bbox(page, SCH_STROKE);

    await openProperties(page, SCH_STROKE, "eeschema.InteractiveEdit.properties");
    const rows = await openFontList(page);
    console.log(`[FONTS] Font list with an installed font: ${JSON.stringify(rows.map((r) => r.label))}`);
    await stableShot(page, "local-fonts-sch-01-font-list.png");
    const family = rows.find((r) => r.label === "wxprivate");
    expect(family, "the installed font is offered under its family name").toBeTruthy();
    expect(await localFontLoads(page), "listing fetches nothing").toEqual([]);
    await pickRow(page, family!);
    await clickOk(page);

    // OK resolves the font: the lookup parks while the provider reads the face.
    await expect.poll(async () => widthDelta(await bbox(page, SCH_STROKE), stroke), { timeout: 30000 }).toBeGreaterThan(0.1);
    expect(await localFontLoads(page), "the face is fetched once").toEqual([LOCAL_ID]);
    expect(await memfsHas(page, LOCAL_PATH), "the face is in MEMFS").toBe(true);
    const saved = await save(page, "kicadSaveSchematic", "local-font.kicad_sch");
    expect(faces(saved), "the text keeps the installed font's name").toContain("wxprivate");
    await stableShot(page, "local-fonts-sch-02-picked.png");
    expect(suspendErrors(testLogger), "no park outside a promising entry").toEqual([]);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a document naming an installed font draws it when the face was fetched before the open", async ({ page, testLogger }) => {
    await boot(page, "eeschema.html");
    await installLocalFonts(page, { prefetched: true });
    await open(page, "embedded-font.kicad_sch", SCH_TTF, { content: withoutEmbedded(fixture("embedded-font.kicad_sch")) });

    expect(widthDelta(await bbox(page, SCH_TTF), await bbox(page, SCH_STROKE)), "drawn in the installed font").toBeGreaterThan(0.1);
    expect(await localFontLoads(page), "nothing fetched during the load").toEqual([]);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a load that would need to fetch an installed font falls back to the fallback font, keeping the name", async ({ page, testLogger }) => {
    await boot(page, "eeschema.html");
    await installLocalFonts(page);
    await open(page, "embedded-font.kicad_sch", SCH_TTF, { content: withoutEmbedded(fixture("embedded-font.kicad_sch")) });

    // A load may not park (pcbjam_progress_may_yield): the face stays unfetched and the text
    // falls back, as without the font. The shell's open flow prefetches to avoid this.
    expect((await bbox(page, SCH_TTF)).w, "not laid out like the stroke font").not.toBe((await bbox(page, SCH_STROKE)).w);
    expect(faces(await save(page, "kicadSaveSchematic", "unfetched-saved.kicad_sch")), "the name survives").toEqual(["wxprivate"]);
    expect(await localFontLoads(page)).toEqual([]);
    expect(suspendErrors(testLogger), "no park during the load").toEqual([]);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("an installed font a text uses is embedded on save when Embed fonts is on", async ({ page }) => {
    await boot(page, "eeschema.html");
    await installLocalFonts(page, { prefetched: true });
    await open(page, "symbol-font.kicad_sch", SYMBOL, { content: symbolSchematic({ text: true }) });
    const saved = await save(page, "kicadSaveSchematic", "symbol-font-saved.kicad_sch");
    // The file name is what "Embed fonts" stores: the installed face's MEMFS file.
    expect(embeddedFiles(saved).map((f) => f.name)).toEqual([`${LOCAL_ID}.ttf`]);
    expect(embeddedFiles(saved)[0]!.data.length, "the payload is the font").toBeGreaterThan(1000);
  });

  test("a font used only by a symbol field is embedded on save when Embed fonts is on", async ({ page }) => {
    test.fail(true, `GAP-5 in ${DOC}: SCHEMATIC::GetFonts (upstream) only scans top-level items, not symbol fields`);
    await boot(page, "eeschema.html");
    await installLocalFonts(page, { prefetched: true });
    await open(page, "symbol-font.kicad_sch", SYMBOL, { content: symbolSchematic({ text: false }) });
    const saved = await save(page, "kicadSaveSchematic", "symbol-font-saved.kicad_sch");
    expect(faces(saved), "the field keeps its font").toEqual(["wxprivate"]);
    expect(embeddedFiles(saved).map((f) => f.name)).toEqual([`${LOCAL_ID}.ttf`]);
  });
});

// A second font to upload: the fallback font's source file (installable, unlike the copy the
// editor writes for itself).
const NOTO_SANS = path.join(__dirname, "..", "..", "wasm", "stubs", "fonts", "NotoSans-Regular.ttf");

/** A schematic with no embedded font and no text in a TrueType face, in a project so Schematic
 *  Setup is editable, open on the setup's Embedded Files page. */
async function openEmbeddedFilesPage(page: Page) {
  await boot(page, "eeschema.html");
  const plain = withoutEmbedded(fixture("embedded-font.kicad_sch")).split('(face "wxprivate")').join("");
  await open(page, "embedded-font.kicad_sch", SCH_STROKE, { content: plain, project: true });
  await page.evaluate(() => (window as unknown as W).Module.kicadTestRunAction("eeschema.EditorControl.schematicSetup"));
  const tree = await waitForRenderedByLabel(page, "Embedded Files", { elementType: "treeitem", timeout: 30000 });
  await page.mouse.click(tree.centerX, tree.centerY);
  await expect.poll(() => visible(page, "wxCheckBox", "Embed fonts"), { timeout: 30000 }).not.toBeNull();
}

/** Ticks "Embed fonts". Before adding: ticking re-collects the fonts texts use and drops any
 *  other font file, and with the box off a save drops every font file (upstream). */
async function tickEmbedFonts(page: Page) {
  const embed = (await visible(page, "wxCheckBox", "Embed fonts"))!;
  await page.mouse.click(embed.centerX, embed.centerY);
  await expect.poll(() => checkboxChecked(page, "Embed fonts"), { timeout: 10000 }).toBe(true);
}

/** The page's Add button, then "Upload from this computer..." with these files in one pick. The
 *  button opens the browser's own picker; the picked files land in MEMFS and the dialog closes
 *  with them selected. */
async function uploadFromAddFile(page: Page, files: string[], shot?: string) {
  const add = await page.evaluate(() =>
    window.wxElementRegistry!.findAll({ visible: true }).filter((e) => e.typeName === "StdBitmapButton").sort((a, b) => a.centerX - b.centerX)[0] ?? null,
  );
  expect(add, "Add file button").not.toBeNull();
  await page.mouse.click(add!.centerX, add!.centerY);
  await expect.poll(() => visible(page, "wxButton", "Upload from this computer..."), { timeout: 30000 }).not.toBeNull();
  if (shot) await stableShot(page, shot);

  const upload = (await visible(page, "wxButton", "Upload from this computer..."))!;
  const chooser = page.waitForEvent("filechooser");
  await page.mouse.click(upload.centerX, upload.centerY);
  await (await chooser).setFiles(files);
  await expect.poll(() => visible(page, "wxFileDialog"), { timeout: 30000 }).toBeNull();
  for (const file of files) {
    await waitForRenderedByLabel(page, `kicad-embed://${path.basename(file)}`, { elementType: "gridcell", timeout: 30000 });
  }
}

test.describe("uploaded fonts (eeschema)", () => {
  test.describe.configure({ timeout: 300000 });

  test("Embedded Files: Upload from this computer embeds a font, and the Font list offers it without a reload", async ({ page, testLogger }) => {
    await openEmbeddedFilesPage(page);
    const stroke = await bbox(page, SCH_STROKE);
    await tickEmbedFonts(page);
    await uploadFromAddFile(page, [path.join(FIXTURES, "wxprivate.ttf")], "uploaded-fonts-sch-01-file-dialog.png");
    await stableShot(page, "uploaded-fonts-sch-02-embedded.png");
    await clickOk(page);

    await openProperties(page, SCH_STROKE, "eeschema.InteractiveEdit.properties");
    const rows = await openFontList(page);
    console.log(`[FONTS] Font list after the upload: ${JSON.stringify(rows.map((r) => r.label))}`);
    const family = rows.find((r) => r.label === "wxprivate");
    expect(family, "the uploaded font is offered by family, before any reload").toBeTruthy();
    await pickRow(page, family!);
    await clickOk(page);
    await expect.poll(async () => widthDelta(await bbox(page, SCH_STROKE), stroke), { timeout: 30000 }).toBeGreaterThan(0.1);

    const saved = await save(page, "kicadSaveSchematic", "uploaded-font.kicad_sch");
    expect(saved).toContain("(embedded_fonts yes)");
    expect(faces(saved)).toContain("wxprivate");
    expect(embeddedFiles(saved).map((f) => f.name), "the uploaded file, once").toEqual(["wxprivate.ttf"]);
    // The checksum is over the uncompressed font, so it matches what native KiCad wrote for
    // the same file even where the compressed payload differs.
    const checksums = (text: string) => [...text.matchAll(/\(checksum "([0-9A-F]+)"\)/g)].map((m) => m[1]);
    expect(checksums(saved), "the font's own bytes").toEqual(checksums(fixture("embedded-font.kicad_sch")));
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("Embedded Files: one upload pick embeds several fonts, and the Font list offers each", async ({ page, testLogger }) => {
    await openEmbeddedFilesPage(page);
    const stroke = await bbox(page, SCH_STROKE);
    await tickEmbedFonts(page);
    // Add takes several files (wxFD_MULTIPLE), so the browser's picker does too.
    await uploadFromAddFile(page, [path.join(FIXTURES, "wxprivate.ttf"), NOTO_SANS]);
    await stableShot(page, "uploaded-fonts-sch-03-embedded-several.png");
    await clickOk(page);

    await openProperties(page, SCH_STROKE, "eeschema.InteractiveEdit.properties");
    const rows = await openFontList(page);
    console.log(`[FONTS] Font list after the upload: ${JSON.stringify(rows.map((r) => r.label))}`);
    expect(rows.map((r) => r.label), "both uploaded fonts are offered by family").toEqual(expect.arrayContaining(["wxprivate", "Noto Sans"]));
    await pickRow(page, rows.find((r) => r.label === "Noto Sans")!);
    await clickOk(page);
    // Noto Sans runs about 10% off the stroke font's width. The list, not the drawing, shows the
    // upload: the fallback font is also Noto Sans, but it is never listed.
    await expect.poll(async () => widthDelta(await bbox(page, SCH_STROKE), stroke), { timeout: 30000 }).toBeGreaterThan(0.05);

    const saved = await save(page, "kicadSaveSchematic", "uploaded-fonts.kicad_sch");
    expect(faces(saved)).toContain("Noto Sans");
    expect(embeddedFiles(saved).map((f) => f.name).sort(), "each uploaded file, once").toEqual(["NotoSans-Regular.ttf", "wxprivate.ttf"]);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});

// The collab test bundle (built by global-setup), started on an editor that already has the file open.
const COLLAB_BUNDLE = path.join(__dirname, "..", "apps", "kicad", "collab-bundle-v2.js");

/** The test font in the upload folder, as "Upload from this computer..." leaves it: the Font
 *  list offers it and texts can use it, but nothing is embedded yet. */
const putUpload = (page: Page) =>
  page.evaluate((b64) => {
    const w = window as unknown as W;
    w.FS.mkdirTree("/tmp/uploads");
    w.FS.writeFile("/tmp/uploads/wxprivate.ttf", Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }, fs.readFileSync(path.join(FIXTURES, "wxprivate.ttf")).toString("base64"));

const roomFiles = async (page: Page) => embeddedFiles((await renderDoc(page)).ok ?? "").map((f) => f.name);

test.describe("embedded fonts reach the room without a save", () => {
  test.describe.configure({ timeout: 300000 });

  test("a font only a symbol field uses is embedded into the room, and a later peer has it", async ({ page, browser, testLogger }) => {
    await boot(page, "eeschema.html");
    await putUpload(page);
    const content = symbolSchematic({ text: false }); // the Value field in wxprivate, Embed fonts on
    await open(page, "symbol-font.kicad_sch", SYMBOL, { content });
    await page.addScriptTag({ path: COLLAB_BUNDLE });
    await startV2(page, { room: `live-embed-sch-${test.info().workerIndex}`, seedText: content });
    expect(await roomFiles(page), "KiCad embeds on save; nothing yet").toEqual([]);

    // Any edit runs the flush that embeds the fonts texts use (symbol fields too: GAP-5).
    expect(await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestMoveSchItem(id, 0, 12700), SYMBOL)).toBe(true);
    await expect.poll(() => roomFiles(page), { timeout: 30000, intervals: [500] }).toEqual(["wxprivate.ttf"]);
    const room = (await renderDoc(page)).ok!;
    expect(room).toContain("(embedded_fonts yes)");
    expect(faces(room)).toEqual(["wxprivate"]);

    // A peer that opens the room's file later, without the font, extracts it from the file.
    const peer = await (await browser.newContext()).newPage();
    try {
      await boot(peer, "eeschema.html");
      await open(peer, "symbol-font.kicad_sch", SYMBOL, { content: room });
      expect(Object.values(await embedCache(peer)), "the peer extracts the embedded font").toContain(FONT_BYTES);
    } finally {
      await peer.context().close();
    }
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a font a board text uses is embedded into the room", async ({ page, testLogger }) => {
    await boot(page, "pcbnew-collab.html");
    await putUpload(page);
    const content = fixture("face-only.kicad_pcb").replace("(embedded_fonts no)", "(embedded_fonts yes)");
    await open(page, "face-only.kicad_pcb", PCB_TTF, { content });
    await page.addScriptTag({ path: COLLAB_BUNDLE });
    await startV2(page, { room: `live-embed-pcb-${test.info().workerIndex}`, seedText: content });
    expect(await roomFiles(page), "KiCad embeds on save; nothing yet").toEqual([]);

    expect(await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestMoveBoardItem(id, 0, 1_000_000), PCB_STROKE)).toBe(true);
    await expect.poll(() => roomFiles(page), { timeout: 30000, intervals: [500] }).toEqual(["wxprivate.ttf"]);
    expect(faces((await renderDoc(page)).ok!)).toEqual(["wxprivate"]);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // A peer can name any font. Embedding an installed one on its own would send this
  // computer's copy to the room, and tell the peer what is installed here.
  test("a font installed on this computer is not embedded into the room without a save", async ({ page, testLogger }) => {
    await boot(page, "eeschema.html");
    await installLocalFonts(page, { prefetched: true });
    const content = symbolSchematic({ text: true }); // texts in wxprivate, Embed fonts on
    await open(page, "symbol-font.kicad_sch", SYMBOL, { content });
    await page.addScriptTag({ path: COLLAB_BUNDLE });
    await startV2(page, { room: `live-embed-installed-${test.info().workerIndex}`, seedText: content });

    expect(await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestMoveSchItem(id, 0, 12700), SYMBOL)).toBe(true);
    // The move reaching the room is the barrier: the same flush would have embedded.
    await expect.poll(async () => (await renderDoc(page)).ok ?? "", { timeout: 30000, intervals: [500] }).toContain("(at 127 96.52 0)");
    expect(await roomFiles(page)).toEqual([]);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a team library font a text uses is embedded into the room under its file name", async ({ page, testLogger }) => {
    await boot(page, "eeschema.html");
    await installLocalFonts(page, { prefetched: true, path: "/home/kicad/.local/share/fonts/lib/lib-1/wxprivate.ttf" });
    const content = symbolSchematic({ text: true });
    await open(page, "symbol-font.kicad_sch", SYMBOL, { content });
    await page.addScriptTag({ path: COLLAB_BUNDLE });
    await startV2(page, { room: `live-embed-libfont-${test.info().workerIndex}`, seedText: content });

    expect(await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestMoveSchItem(id, 0, 12700), SYMBOL)).toBe(true);
    await expect.poll(() => roomFiles(page), { timeout: 30000, intervals: [500] }).toEqual(["wxprivate.ttf"]);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("with Embed fonts off nothing is embedded", async ({ page }) => {
    await boot(page, "pcbnew-collab.html");
    await putUpload(page);
    const content = fixture("face-only.kicad_pcb");
    await open(page, "face-only.kicad_pcb", PCB_TTF, { content });
    await page.addScriptTag({ path: COLLAB_BUNDLE });
    await startV2(page, { room: `live-embed-off-${test.info().workerIndex}`, seedText: content });
    expect(await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestMoveBoardItem(id, 0, 1_000_000), PCB_STROKE)).toBe(true);
    // The move itself reaching the room is the barrier: the same flush would have embedded.
    await expect.poll(async () => (await renderDoc(page)).ok ?? "", { timeout: 30000, intervals: [500] }).toContain("(at 95 113 0)");
    expect(await roomFiles(page)).toEqual([]);
  });
});


// fonts 0002 F4: a collaborator's text in a font this editor lists but never fetched. The
// editor applies collab changes on KiCad's coroutine queue, where the font lookup may wait,
// so the lookup fetches the face through the shell's provider and the text draws in it at
// once, without a reload (checked on 2026-10-28; the plan had assumed it could not wait).
const LIB_FONT_PATH = "/home/kicad/.local/share/fonts/lib/lib-1/wxprivate.ttf";

test.describe("a collaborator's font arrives without a reload (fonts 0002 F4)", () => {
  test.describe.configure({ timeout: 300000 });

  test("a peer's text in a team font this editor never fetched draws in that font", async ({ context, browserName, testLogger }) => {
    test.skip(browserName === "firefox", "two heavy editors exceed Firefox's per-process wasm budget (see utils/trio.ts)");
    const room = `f4-peer-font-${test.info().workerIndex}`;
    const content = withoutEmbedded(fixture("embedded-font.kicad_sch")).split('(face "wxprivate")').join("");
    const [a, b] = [await context.newPage(), await context.newPage()];
    try {
      // A lists the team font but has not fetched it.
      await boot(a, "eeschema.html");
      await open(a, "embedded-font.kicad_sch", SCH_STROKE, { content });
      await installLocalFonts(a, { path: LIB_FONT_PATH });
      await a.addScriptTag({ path: COLLAB_BUNDLE });
      await startV2(a, { room, seedText: content });
      const stroke = await bbox(a, SCH_STROKE);

      // B has the font and gives the stroke text that font.
      await boot(b, "eeschema.html");
      await open(b, "embedded-font.kicad_sch", SCH_STROKE, { content });
      await installLocalFonts(b, { prefetched: true, path: LIB_FONT_PATH });
      await b.addScriptTag({ path: COLLAB_BUNDLE });
      await startV2(b, { room, editorMatchesDoc: true });
      await openProperties(b, SCH_STROKE, "eeschema.InteractiveEdit.properties");
      const row = (await openFontList(b)).find((r) => r.label === "wxprivate");
      expect(row, "B's Font list offers the team font").toBeTruthy();
      await pickRow(b, row!);
      await clickOk(b);
      await expect.poll(async () => widthDelta(await bbox(b, SCH_STROKE), stroke), { timeout: 30000 }).toBeGreaterThan(0.1);
      const inFont = await bbox(b, SCH_STROKE);

      // A lays the text out exactly as B does, having fetched the face once.
      await expect.poll(async () => (await bbox(a, SCH_STROKE)).w, { timeout: 30000, intervals: [400] }).toBe(inFont.w);
      expect(await localFontLoads(a), "fetched once, by the apply").toEqual([LOCAL_ID]);
      expect(await memfsHas(a, LIB_FONT_PATH)).toBe(true);
      expect(faces(await save(a, "kicadSaveSchematic", "peer-font.kicad_sch")), "A keeps the font name").toContain("wxprivate");
      expect(suspendErrors(testLogger), "the apply may wait for the font").toEqual([]);
      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("a board text a peer gives a team font this editor never fetched draws in that font", async ({ page, testLogger }) => {
    await boot(page, "pcbnew-collab.html");
    await open(page, "face-only.kicad_pcb", PCB_STROKE, { content: fixture("face-only.kicad_pcb").split('(face "wxprivate")').join("") });
    await installLocalFonts(page, { path: LIB_FONT_PATH });
    const stroke = await bbox(page, PCB_STROKE);
    // A peer's change as the binding hands it to the editor.
    const blob = await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestItemBlob(id), PCB_STROKE);
    const named = blob.replace(/\(font\s*\(size/, '(font (face "wxprivate") (size');
    expect(named, "the face was added").toContain('(face "wxprivate")');
    await page.evaluate(
      (sexpr) => (window as unknown as W).Module.kicadCollabApplyItems(JSON.stringify({ added: [], changed: [{ sexpr, parent: null }], removed: [] })),
      named,
    );
    await expect.poll(async () => widthDelta(await bbox(page, PCB_STROKE), stroke), { timeout: 25000, intervals: [400] }).toBeGreaterThan(0.1);
    expect(await localFontLoads(page), "fetched once, by the apply").toEqual([LOCAL_ID]);
    expect(suspendErrors(testLogger)).toEqual([]);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});
