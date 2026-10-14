import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * The AI chat's agent executor (ai-chat 0003 step 4) against the real engine:
 * the edits the chat's tools compute (`@pcbjam/shared` schematic-ops) carried
 * out by KiCad in the open editor, through web/standalone/src/agent/executor.ts
 * (bundled with the ops into apps/kicad/agent-bundle.js, global PcbjamAgent).
 *
 *  - applyAgentEdit: one native commit, one undo step, broadcast on the items
 *    wire like any edit; KiCad's own connectivity sees the labels it placed;
 *  - an edit KiCad cannot parse is refused whole and changes nothing;
 *  - placeAgentPart: KiCad's Place Symbol, committed at the person's click;
 *    Esc and the chat's Stop cancel it with nothing added.
 */

const SCH_PATH = "/home/kicad/documents/agentexec.kicad_sch";
// A synthetic sheet: Device:R R1 at (127, 95.25); its pins end at y 91.44 (1) and 99.06 (2).
const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "aaaaaaaa-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols
\t\t(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t\t(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
\t\t\t(property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t\t\t(symbol "R_0_1"
\t\t\t\t(rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t\t)
\t\t\t(symbol "R_1_1"
\t\t\t\t(pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t)
\t(symbol (lib_id "Device:R") (at 127 95.25 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "bbbbbbbb-2222-2222-2222-222222222222")
\t\t(property "Reference" "R1" (at 129.54 94.615 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "10k" (at 129.54 96.52 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Footprint" "" (at 125.222 95.25 90) (effects (font (size 1.27 1.27)) hide))
\t\t(property "Datasheet" "~" (at 127 95.25 0) (effects (font (size 1.27 1.27)) hide))
\t\t(pin "1" (uuid "cccccccc-0000-0000-0000-000000000001"))
\t\t(pin "2" (uuid "cccccccc-0000-0000-0000-000000000002"))
\t\t(instances (project "agentexec" (path "/aaaaaaaa-1111-1111-1111-111111111111" (reference "R1") (unit 1))))
\t)
\t(sheet_instances (path "/" (page "1")))
)
`;

type Json = Record<string, unknown>;
type Part = { ref: string; value: string; uuid: string; at: [number, number] };
type Net = { net: string; pins: { ref: string; pin: string }[] };
type Agent = {
  applyAgentEdit(edit: unknown, signal: AbortSignal): Promise<Json>;
  placeAgentPart(blob: { sexpr: string }, signal: AbortSignal): Promise<Json>;
  readParts(): { parts: Part[]; nets: Net[] } | { error: string; code: string };
  ops: {
    fileToDoc(text: string): unknown;
    placePartEdit(input: unknown): { edit: unknown; placed: { ref: string; uuid: string }[] };
    connectEdit(input: unknown): { edit: unknown };
    placementBlob(input: unknown): { sexpr: string };
    readSheet(doc: unknown): { defs: Map<string, unknown> };
  };
};
type Win = {
  FS: { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
  Module: {
    kicadOpenFile(p: string): unknown;
    kicadCollabPresenceStart(): void;
    kicadCollabSnapshotItems(): string;
    kicadCollabGetSelection(): string;
    kicadCollabTestUndo(): boolean;
    kicadCollabTestUndoDepth(): number;
    kicadPluginEditItems?: unknown;
    kicadPlaceImportedItem?: unknown;
  };
  kicadCollab?: { onItems?: (json: string) => void; onDelta?: (json: string) => void };
  __agentWires?: { added?: { sexpr: string }[]; changed?: { sexpr: string }[] }[];
  __agentPlace?: Promise<Json>;
  __agentStop?: AbortController;
  PcbjamAgent: Agent;
};

const BOOT_TIMEOUT = 120000;

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Win["Module"]> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadPluginEditItems === "function" && typeof m?.kicadPlaceImportedItem === "function";
    },
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry.findAll({ visible: true }).some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.evaluate(
    ({ path, content }) => {
      const w = window as unknown as Win;
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      w.FS.writeFile(path, content);
      w.Module.kicadOpenFile(path);
    },
    { path: SCH_PATH, content: SAMPLE_SCH },
  );
  await expect.poll(() => page.title(), { timeout: 60000, intervals: [500] }).toMatch(/agentexec/i);
  await page.addScriptTag({ path: path.resolve(__dirname, "../apps/kicad/agent-bundle.js") });
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.Module.kicadCollabPresenceStart();
    // Seed the collab bridge as the app does at load: later commits then diff against it.
    w.Module.kicadCollabSnapshotItems();
    // The items wire the collab layer normally consumes: every broadcast lands here.
    w.__agentWires = [];
    w.kicadCollab = { onItems: (json: string) => { w.__agentWires!.push(JSON.parse(json)); }, onDelta: () => {} };
  });
}

const undoDepth = (page: Page) => page.evaluate(() => (window as unknown as Win).Module.kicadCollabTestUndoDepth());
const undo = (page: Page) => page.evaluate(() => (window as unknown as Win).Module.kicadCollabTestUndo());
const selection = (page: Page) => page.evaluate(() => JSON.parse((window as unknown as Win).Module.kicadCollabGetSelection()) as string[]);
/** Every blob the items wire carried, added or changed (receivers upsert both). */
const wiredBlobs = (page: Page) =>
  page.evaluate(() => ((window as unknown as Win).__agentWires ?? []).flatMap((w) => [...(w.added ?? []), ...(w.changed ?? [])].map((a) => a.sexpr)));

/** KiCad's live view through the executor, as the chat reads it. */
async function sheet(page: Page): Promise<{ parts: Part[]; nets: Net[] }> {
  const read = await page.evaluate(() => (window as unknown as Win).PcbjamAgent.readParts());
  expect("error" in read ? read.error : "", "readParts").toBe("");
  return read as { parts: Part[]; nets: Net[] };
}
const partRefs = async (page: Page) => (await sheet(page)).parts.map((p) => `${p.ref}=${p.value}`).sort();
/** The pins KiCad has on the net `R1.2` is on. */
const netOfR1Pin2 = async (page: Page) =>
  (await sheet(page)).nets
    .find((n) => n.pins.some((p) => p.ref === "R1" && p.pin === "2"))
    ?.pins.map((p) => `${p.ref}.${p.pin}`)
    .sort();

test.describe("AI chat agent executor (ai-chat 0003 step 4)", () => {
  test("applyAgentEdit: schematic-ops edits are one undo step each, broadcast, and KiCad connects their labels", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page);
    const depth = await undoDepth(page);
    expect(await partRefs(page)).toEqual(["R1=10k"]);

    // Place R2 with pin 1 on SDA: computed by schematic-ops, applied by the executor.
    const placed = await page.evaluate(async (text) => {
      const A = (window as unknown as Win).PcbjamAgent;
      const { edit, placed } = A.ops.placePartEdit({ doc: A.ops.fileToDoc(text), parts: [{ libId: "Device:R", value: "4.7k", at: [152.4, 95.25], nets: { "1": "SDA" } }] });
      return { result: await A.applyAgentEdit(edit, new AbortController().signal), uuid: placed[0]!.uuid, ref: placed[0]!.ref };
    }, SAMPLE_SCH);
    expect(placed.ref).toBe("R2");
    expect(placed.result).toMatchObject({ status: "applied" });
    expect(placed.result.added as string[]).toContain(placed.uuid);
    await expect.poll(() => undoDepth(page), { timeout: 10000 }).toBe(depth + 1);
    await expect.poll(() => wiredBlobs(page), { timeout: 10000 }).toEqual(expect.arrayContaining([expect.stringContaining(placed.uuid)]));
    await expect.poll(() => partRefs(page), { timeout: 10000 }).toEqual(["R1=10k", "R2=4.7k"]);
    expect((await sheet(page)).parts.find((p) => p.ref === "R2")?.at).toEqual([152.4, 95.25]);

    // Put R1.2 on SDA too: KiCad's own connectivity joins it with R2.1.
    const connected = await page.evaluate(async (text) => {
      const A = (window as unknown as Win).PcbjamAgent;
      const { edit } = A.ops.connectEdit({ doc: A.ops.fileToDoc(text), pins: [{ ref: "R1", pin: "2", net: "SDA" }] });
      return A.applyAgentEdit(edit, new AbortController().signal);
    }, SAMPLE_SCH);
    expect(connected).toMatchObject({ status: "applied" });
    await expect.poll(() => undoDepth(page), { timeout: 10000 }).toBe(depth + 2);
    await expect.poll(() => netOfR1Pin2(page), { timeout: 15000, intervals: [500] }).toEqual(["R1.2", "R2.1"]);

    // One Undo per edit, in order.
    expect(await undo(page)).toBe(true);
    await expect.poll(() => netOfR1Pin2(page), { timeout: 15000, intervals: [500] }).toEqual(["R1.2"]);
    expect(await undo(page)).toBe(true);
    await expect.poll(() => partRefs(page), { timeout: 10000 }).toEqual(["R1=10k"]);
  });

  test("an edit KiCad cannot load is refused whole and changes nothing", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page);
    const depth = await undoDepth(page);
    const wire = "eeeeeeee-0000-4000-8000-000000000001";
    const result = await page.evaluate(
      (wire) =>
        (window as unknown as Win).PcbjamAgent.applyAgentEdit(
          {
            label: "broken",
            upsert: [
              { sexpr: `(wire (pts (xy 100 80) (xy 120 80)) (stroke (width 0) (type default)) (uuid "${wire}"))` },
              { sexpr: `(label "X" (at 10.16 10.16 0) (bogus_token yes) (effects (font (size 1.27 1.27))) (uuid "eeeeeeee-0000-4000-8000-000000000002"))` },
            ],
            remove: [],
            libSymbols: {},
          },
          new AbortController().signal,
        ),
      wire,
    );
    console.log(`[agent-executor] broken edit: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ code: "INVALID" });
    expect(await undoDepth(page)).toBe(depth);
    const snapshot = await page.evaluate(() => (window as unknown as Win).Module.kicadCollabSnapshotItems());
    expect(snapshot).not.toContain(wire);
  });

  test("placeAgentPart: the click commits KiCad's own placement; Esc and Stop cancel it", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page);
    // Focus the drawing area, zoom to objects.
    await page.mouse.click(700, 400);
    await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell: the click's focus handoff rides the wx scheduler with no page-observable
    await page.keyboard.press("Control+Home");
    await page.waitForTimeout(800); // eslint-disable-line -- documented interaction dwell: zoom animates on the wx scheduler with no page-observable
    const depth = await undoDepth(page);

    /** Arms a placement of a 22k Device:R; resolves once KiCad has the part on the cursor. */
    const arm = async () => {
      const known = new Set(await selection(page));
      await page.evaluate((text) => {
        const w = window as unknown as Win;
        const A = w.PcbjamAgent;
        const def = A.ops.readSheet(A.ops.fileToDoc(text)).defs.get("Device:R");
        w.__agentStop = new AbortController();
        w.__agentPlace = A.placeAgentPart(A.ops.placementBlob({ def, libId: "Device:R", value: "22k" }), w.__agentStop.signal);
      }, SAMPLE_SCH);
      await expect
        .poll(async () => (await selection(page)).some((id) => !known.has(id)), { message: "the part should be on the cursor", timeout: 15000, intervals: [250] })
        .toBe(true);
    };
    const outcome = () => page.evaluate(() => (window as unknown as Win).__agentPlace!);

    // Click: committed where the person clicked, one undo step, broadcast.
    await arm();
    await page.mouse.move(900, 500, { steps: 8 });
    await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell: asyncified pointer-move needs wall-clock time before the placement reads the cursor
    await page.mouse.click(901, 500);
    const placed = await outcome();
    expect(placed).toMatchObject({ status: "placed", ref: "R2" });
    expect(await partRefs(page)).toEqual(["R1=10k", "R2=22k"]);
    await expect.poll(() => undoDepth(page), { timeout: 10000 }).toBe(depth + 1);
    await expect.poll(() => wiredBlobs(page), { timeout: 10000 }).toEqual(expect.arrayContaining([expect.stringContaining(`"${placed.uuid}"`)]));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell: exit-tool has no page-observable

    // Esc: nothing added.
    await arm();
    await page.keyboard.press("Escape");
    expect(await outcome()).toEqual({ status: "cancelled" });

    // The chat's Stop: the armed placement is withdrawn, nothing added.
    await arm();
    await page.evaluate(() => (window as unknown as Win).__agentStop!.abort());
    expect(await outcome()).toEqual({ error: "Placement cancelled", code: "CANCELLED" });

    expect(await partRefs(page)).toEqual(["R1=10k", "R2=22k"]);
    expect(await undoDepth(page)).toBe(depth + 1);
  });
});
