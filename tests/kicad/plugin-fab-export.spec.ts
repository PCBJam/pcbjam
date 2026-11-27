import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Plugin exports in the browser (plugins 0029): kicadFabExport runs the four
 * fabrication exports on the board the PCB editor has open. kicad_tools
 * --fab-batch runs the same code (wasm/bindings/fab_export.h) on the server, so
 * the two must write the same files: this spec runs both on one board and
 * compares every file, with only the time of writing taken out.
 *
 * Another board: FAB_BOARD=/path/to/board.kicad_pcb (its .kicad_pro beside it
 * is staged too). FAB_OUT=/dir keeps the browser's files.
 */

const BOARD = process.env.FAB_BOARD ?? path.resolve(__dirname, "../fixtures/demo/demo.kicad_pcb");
/**
 * Boards whose pads have a shape per layer (custom padstacks), where KiCad's plot code leaves a trace
 * in the pad it plotted: KiCad's own test board (kicad/qa/data/pcbnew/padstacks_complex), and a copy
 * of it in which one custom pad has no shape of its own on the second inner layer.
 */
const PADSTACK_BOARDS = [
  ["a shape on every copper layer", path.resolve(__dirname, "../fixtures/padstacks/padstacks_complex.kicad_pcb")],
  ["no own shape on one inner layer", path.resolve(__dirname, "../fixtures/padstacks/padstacks_gap.kicad_pcb")],
] as const;
const projectOf = (board: string) => board.replace(/\.kicad_pcb$/, ".kicad_pro");
const KICAD_TOOLS = path.resolve(__dirname, "../../output/kicad_tools.js");
const KINDS = ["fab-components", "gerbers", "drill", "ipc356"];
/**
 * What a manufacturer's plugin may ask for (plugins 0027), as the words kicad_tools takes; the
 * editor takes the same words. A layer list in an order of its own with a layer the demo board
 * does not have, KiCad's layer names in the file names, `.gbr` for every file, no job file, the
 * mask as drawn, six decimals; drill files split by plating, a short header, ovals as routes.
 */
const OPTION_WORDS = [
  "--layers", "Edge.Cuts,F.Cu,B.Cu,F.Mask,B.Mask,F.SilkS,B.SilkS,In1.Cu",
  "--canonical-names", "--no-protel-ext", "--no-job-file", "--zero-mask-expansion", "--zero-mask-min-width", "--precision", "6",
  "--separate-plated", "--minimal-header", "--route-oval-holes",
];

type Mod = { kicadOpenFile(p: string): unknown; kicadFabExport(dir: string, kinds: string, optionWords: string): string; kicadTestRunAction(name: string): boolean };
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void; readFile(p: string): Uint8Array; analyzePath(p: string): { exists: boolean } };
type W = { Module: Mod; FS: FS };
type Export = { kind: string; ok: boolean; ms: number; files: { name: string; size: number }[]; messages: string };
type Result = { ok: boolean; error?: string; exports?: Export[] };

/** The lines that say when a file was written: the only ones two runs may differ in. */
function withoutTime(text: string): string {
  return text
    .replace(/^%TF\.CreationDate,.*\*%$/gm, "%TF.CreationDate,<time>*%")
    .replace(/^(G04 Created by KiCad \(.*\) date ).*\*$/gm, "$1<time>*")
    .replace(/^(; DRILL file .* date ).*$/gm, "$1<time>")
    .replace(/^; #@! TF\.CreationDate,.*$/gm, "; #@! TF.CreationDate,<time>")
    .replace(/^(\s*"CreationDate": )".*"(,?)$/gm, '$1"<time>"$2');
}

/** kicad_tools --fab-batch on a copy of the board, with its option words: `kind/name` -> text. */
function serverExports(source = BOARD, words: string[] = []): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fab-export-"));
  try {
    const board = path.join(dir, "in", path.basename(source));
    fs.mkdirSync(path.dirname(board));
    fs.copyFileSync(source, board);
    if (fs.existsSync(projectOf(source))) fs.copyFileSync(projectOf(source), projectOf(board));
    const out = path.join(dir, "out");
    execFileSync(process.execPath, [KICAD_TOOLS, "--fab-batch", board, out, KINDS.join(","), ...words], { stdio: "pipe", timeout: 120000 });
    const files: Record<string, string> = {};
    for (const kind of fs.readdirSync(out))
      for (const name of fs.readdirSync(path.join(out, kind)))
        files[`${kind}/${name}`] = fs.readFileSync(path.join(out, kind, name), "latin1");
    return files;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function bootAndOpen(page: Page, board = BOARD): Promise<void> {
  const name = path.basename(board);
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => typeof (window as unknown as { Module?: Partial<Mod> }).Module?.kicadFabExport === "function", null, { timeout: 90000 });
  await page.waitForFunction(
    () => !!window.wxElementRegistry && window.wxElementRegistry.findAll({ visible: true }).some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: 90000 },
  );
  await page.evaluate(({ name, content, project }) => {
    const w = window as unknown as W;
    const dir = "/home/kicad/documents";
    try { w.FS.mkdirTree(dir); } catch { /* exists */ }
    // The project file next to the board, as the editor stages it (netclasses feed the .gbrjob rules).
    if (project !== null) w.FS.writeFile(`${dir}/${name.replace(/\.kicad_pcb$/, ".kicad_pro")}`, project);
    w.FS.writeFile(`${dir}/${name}`, content);
    w.Module.kicadOpenFile(`${dir}/${name}`);
  }, { name, content: fs.readFileSync(board, "utf8"), project: fs.existsSync(projectOf(board)) ? fs.readFileSync(projectOf(board), "utf8") : null });
  await expect.poll(() => page.title(), { timeout: 90000, intervals: [500] }).toMatch(new RegExp(name.replace(/\.kicad_pcb$/, ""), "i"));
}

/** One kicadFabExport call (option words one per line): its answer, how long the page was held, and the files as latin1 text. */
function exportHere(page: Page, dir: string, kinds = KINDS, words: string[] = []) {
  return page.evaluate(({ dir, kinds, words }) => {
    const w = window as unknown as W;
    const started = performance.now();
    const result = JSON.parse(w.Module.kicadFabExport(dir, kinds.join(","), words.join("\n"))) as Result;
    const ms = performance.now() - started;
    const files: Record<string, string> = {};
    for (const e of result.exports ?? [])
      for (const f of e.files) {
        const bytes = w.FS.readFile(`${dir}/${e.kind}/${f.name}`);
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        files[`${e.kind}/${f.name}`] = text;
      }
    return { ms, result, files };
  }, { dir, kinds, words });
}

/** The board as the editor would save it now. */
function saved(page: Page, dir: string): Promise<string> {
  return page.evaluate((dir) => {
    const w = window as unknown as W & { Module: { kicadSaveBoard(p: string): void } };
    try { w.FS.mkdirTree(dir); } catch { /* exists */ }
    w.Module.kicadSaveBoard(`${dir}/board.kicad_pcb`);
    return new TextDecoder().decode(w.FS.readFile(`${dir}/board.kicad_pcb`));
  }, dir);
}

/** Runs a KiCad action by name; resolves once KiCad has run it (kicadTestRunAction queues it and reports back). */
function action(page: Page, name: string): Promise<boolean> {
  return page.evaluate((name) => new Promise<boolean>((resolve) => {
    const done = (e: Event) => {
      if ((e as CustomEvent<{ name: string }>).detail?.name !== name) return;
      window.removeEventListener("pcbjam:test-action-done", done);
      resolve(true);
    };
    window.addEventListener("pcbjam:test-action-done", done);
    if (!(window as unknown as W).Module.kicadTestRunAction(name)) resolve(false);
  }), name);
}
const ROUTE = "pcbnew.InteractiveRouter.SingleTrack";
/** The toolbar's arrow: leaves whatever tool is running. */
const SELECT = "common.InteractiveSelection.selectionTool";

/** What an export answers: "ok", "failed", or why KiCad would not start. */
async function answer(page: Page, dir: string): Promise<string> {
  const { result } = await exportHere(page, dir);
  return result.error ?? (result.ok ? "ok" : "failed");
}

test.describe("fabrication exports on the open board", () => {
  // CI builds kicad_tools with the editor; a local output/ may hold the editor alone.
  test.skip(!process.env.CI && !fs.existsSync(KICAD_TOOLS), "output/kicad_tools.js is not built");

  test("writes the files kicad_tools writes for the same board", async ({ page }) => {
    test.setTimeout(240000);
    const server = serverExports();
    await bootAndOpen(page);

    const first = await exportHere(page, "/tmp/fab-1");
    const second = await exportHere(page, "/tmp/fab-2");
    console.log("[fab-export] first", Math.round(first.ms), "ms; second", Math.round(second.ms), "ms; per kind",
      JSON.stringify(first.result.exports!.map((e) => [e.kind, Math.round(e.ms), e.files.length])));
    for (const e of first.result.exports!) expect(e.ok, `${e.kind}: ${e.messages}`).toBe(true);
    expect(first.result.ok).toBe(true);
    // In the order asked, each kind in its own folder.
    expect(first.result.exports!.map((e) => e.kind)).toEqual(KINDS);

    if (process.env.FAB_OUT)
      for (const [file, text] of Object.entries(first.files)) {
        fs.mkdirSync(path.dirname(path.join(process.env.FAB_OUT, file)), { recursive: true });
        fs.writeFileSync(path.join(process.env.FAB_OUT, file), text, "latin1");
      }

    // The same files as the server tool, and the same bytes apart from the time of writing.
    expect(Object.keys(first.files).sort()).toEqual(Object.keys(server).sort());
    expect(Object.keys(server).filter((f) => f.endsWith(".gbrjob"))).toHaveLength(1);
    expect(Object.keys(server).filter((f) => f.startsWith("gerbers/")).length).toBeGreaterThan(5);
    for (const file of Object.keys(server)) expect(withoutTime(first.files[file]!), file).toBe(withoutTime(server[file]!));
    // The listing says what is on disk.
    for (const e of first.result.exports!) for (const f of e.files) expect(first.files[`${e.kind}/${f.name}`]!.length, f.name).toBe(f.size);
    // A second run on the same board writes the same again: the first left the board as it was.
    for (const file of Object.keys(first.files)) expect(withoutTime(second.files[file]!), file).toBe(withoutTime(first.files[file]!));
  });

  test("leaves the board as it was", async ({ page }) => {
    test.setTimeout(240000);
    await bootAndOpen(page);
    const before = await saved(page, "/tmp/save-before");
    expect((await exportHere(page, "/tmp/fab-keep")).result.ok).toBe(true);
    expect(await saved(page, "/tmp/save-after")).toBe(before);
  });

  for (const [what, board] of PADSTACK_BOARDS)
    test(`custom padstacks (${what}): the same files, the same board, and the router still starts`, async ({ page }) => {
      test.setTimeout(240000);
      const aborted: string[] = [];
      page.on("console", (m) => { if (m.type() === "error" && /Aborted\(|Assertion failed/.test(m.text())) aborted.push(m.text().slice(0, 300)); });
      const server = serverExports(board);
      await bootAndOpen(page, board);

      const before = await saved(page, "/tmp/pad-before");
      const first = await exportHere(page, "/tmp/fab-pad");
      expect(first.result.ok).toBe(true);
      expect(Object.keys(first.files).sort()).toEqual(Object.keys(server).sort());
      for (const file of Object.keys(server)) expect(withoutTime(first.files[file]!), file).toBe(withoutTime(server[file]!));
      // Plotting a pad on a layer it has no shape of its own for gives it one; fab_export.h puts the
      // padstack back, so the board saves as before.
      expect(await saved(page, "/tmp/pad-after")).toBe(before);

      // Such a trace on a mask layer once stopped the router on an assertion, its tool stuck
      // (plot-custom-padstacks.spec.ts): after an export the router starts, and can be left.
      expect(await action(page, ROUTE)).toBe(true);
      expect(await action(page, SELECT)).toBe(true);
      await expect.poll(() => answer(page, "/tmp/fab-pad-again"), { timeout: 15000 }).toBe("ok");
      expect(aborted).toEqual([]);
    });

  test("with a manufacturer's options: the files kicad_tools writes for the same words, and the board as it was", async ({ page }) => {
    test.setTimeout(240000);
    const server = serverExports(BOARD, OPTION_WORDS);
    await bootAndOpen(page);
    const before = await saved(page, "/tmp/opt-before");

    const here = await exportHere(page, "/tmp/fab-options", KINDS, OPTION_WORDS);
    expect(here.result.ok, JSON.stringify(here.result.exports?.map((e) => [e.kind, e.ok, e.messages]))).toBe(true);
    expect(Object.keys(here.files).sort()).toEqual(Object.keys(server).sort());
    for (const file of Object.keys(server)) expect(withoutTime(here.files[file]!), file).toBe(withoutTime(server[file]!));

    // The options show in the names: KiCad's layer names, `.gbr`, no job file, two drill files.
    const names = Object.keys(here.files);
    const gerbers = names.filter((name) => name.startsWith("gerbers/"));
    expect(gerbers.length).toBeGreaterThan(3);
    expect(gerbers.filter((name) => !name.endsWith(".gbr"))).toEqual([]);
    expect(gerbers.some((name) => name.endsWith("-F_Cu.gbr"))).toBe(true);
    expect(names.filter((name) => name.startsWith("drill/")).map((name) => name.replace(/^.*-/, "")).sort()).toEqual(["NPTH.drl", "PTH.drl"]);

    // The mask options change two board settings for the plot only: the board saves as before,
    // and the plain export afterwards is the plain export.
    expect(await saved(page, "/tmp/opt-after")).toBe(before);
    const plain = await exportHere(page, "/tmp/fab-plain");
    const plainServer = serverExports();
    for (const file of Object.keys(plainServer)) expect(withoutTime(plain.files[file]!), file).toBe(withoutTime(plainServer[file]!));
  });

  test("a word that is no option of the kinds asked for is refused, and nothing runs", async ({ page }) => {
    test.setTimeout(240000);
    await bootAndOpen(page);
    for (const [kinds, words] of [
      [["gerbers", "drill"], ["--no-such-option"]],
      // A drill option without the drill export.
      [["gerbers"], ["--separate-plated"]],
      [["gerbers"], ["--precision", "7"]],
      [["drill"], ["--layers", "F.Cu"]],
    ] as const) {
      const { result } = await exportHere(page, "/tmp/fab-bad-options", [...kinds], [...words]);
      expect(result, words.join(" ")).toEqual({ ok: false, error: "BAD_OPTIONS" });
      expect(await page.evaluate(() => (window as unknown as W).FS.analyzePath("/tmp/fab-bad-options").exists)).toBe(false);
    }
    // A name that is no layer fails the Gerber export alone and says which.
    const { result } = await exportHere(page, "/tmp/fab-bad-layer", ["gerbers", "drill"], ["--layers", "F.Cu,No.Such"]);
    expect(result.exports!.map((e) => [e.kind, e.ok])).toEqual([["gerbers", false], ["drill", true]]);
    expect(result.exports![0]!.messages).toContain("unknown layer 'No.Such'");
  });

  test("an unknown kind fails alone and says so", async ({ page }) => {
    test.setTimeout(240000);
    await bootAndOpen(page);
    const { result } = await exportHere(page, "/tmp/fab-unknown", ["drill", "pdf"]);
    expect(result.ok).toBe(false);
    expect(result.exports!.map((e) => [e.kind, e.ok])).toEqual([["drill", true], ["pdf", false]]);
    expect(result.exports![1]!.messages).toContain("unknown export");
  });

  test("is refused while the user has a tool running", async ({ page }) => {
    test.setTimeout(240000);
    await bootAndOpen(page);
    expect(await answer(page, "/tmp/fab-idle")).toBe("ok");

    expect(await action(page, ROUTE)).toBe(true);
    await expect.poll(() => answer(page, "/tmp/fab-armed"), { timeout: 15000 }).toBe("TOOL_ACTIVE");
    // Refused means nothing was written.
    expect(await answer(page, "/tmp/fab-refused")).toBe("TOOL_ACTIVE");
    expect(await page.evaluate(() => (window as unknown as W).FS.analyzePath("/tmp/fab-refused").exists)).toBe(false);

    // Back in the selection tool, it exports again.
    expect(await action(page, SELECT)).toBe(true);
    await expect.poll(() => answer(page, "/tmp/fab-after"), { timeout: 15000 }).toBe("ok");
  });
});
