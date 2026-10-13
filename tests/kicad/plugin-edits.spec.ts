import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Plugin edits (plugins 0023): `kicadPluginEditItems` against the real engine.
 *
 * A plugin's create / change / delete of items is ONE local KiCad commit: it lands on the
 * undo stack (one step), the commit listener broadcasts it on the items wire like any edit,
 * and one Undo reverts all of it. It is all or nothing: a held item, an unknown net, a missing
 * id or a child item refuses the whole edit and changes nothing.
 */

const SEG1 = "44444444-0000-0000-0000-000000000001";
const GR1 = "44444444-0000-0000-0000-000000000002";
const VIA_NEW = "44444444-0000-0000-0000-0000000000a1";
const FP1 = "66666666-0000-0000-0000-000000000001";
const PAD1 = "66666666-0000-0000-0000-0000000000dd";
const SAMPLE_PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general
\t\t(thickness 1.6)
\t)
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(37 "F.SilkS" user)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(net 1 "GND")
\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "${FP1}")
\t\t(at 100 100)
\t\t(attr smd)
\t\t(fp_rect (start -2 -2) (end 2 2) (layer "F.SilkS") (stroke (width 0.3) (type solid)) (uuid "66666666-0000-0000-0000-0000000000cc"))
\t\t(pad "1" smd rect (at 0 0) (size 3 3) (layers "F.Cu") (net 1 "GND") (uuid "${PAD1}"))
\t)
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 1) (uuid "${SEG1}"))
\t(gr_line (start 40 40) (end 60 40) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "${GR1}"))
)
`;

const WIRE1 = "77777777-0000-0000-0000-000000000001";
const WIRE_NEW = "77777777-0000-0000-0000-0000000000a1";
const R1 = "bbbbbbbb-2222-2222-2222-222222222222";
const C_NEW = "dddddddd-3333-3333-3333-333333333333";
const R_DEF = `(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
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
\t\t)`;
const r1 = (value: string) => `(symbol (lib_id "Device:R") (at 127 95.25 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "${R1}")
\t\t(property "Reference" "R1" (at 129.54 94.615 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "${value}" (at 129.54 96.52 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Footprint" "" (at 125.222 95.25 90) (effects (font (size 1.27 1.27)) hide))
\t\t(property "Datasheet" "~" (at 127 95.25 0) (effects (font (size 1.27 1.27)) hide))
\t\t(pin "1" (uuid "cccccccc-0000-0000-0000-000000000001"))
\t\t(pin "2" (uuid "cccccccc-0000-0000-0000-000000000002"))
\t\t(instances (project "pluginedit" (path "/aaaaaaaa-1111-1111-1111-111111111111" (reference "R1") (unit 1))))
\t)`;
const SAMPLE_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "aaaaaaaa-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols
\t\t${R_DEF}
\t)
\t${r1("10k")}
\t(wire (pts (xy 100 80) (xy 120 80)) (stroke (width 0) (type default)) (uuid "${WIRE1}"))
\t(sheet_instances (path "/" (page "1")))
)
`;
// A symbol from a library the sheet doesn't have yet: its definition travels in libSymbols.
const C_DEF = `(symbol "PlugLib:C" (pin_numbers hide) (pin_names (offset 0.254)) (exclude_from_sim no) (in_bom yes) (on_board yes)
\t(property "Reference" "C" (at 0.635 2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
\t(property "Value" "C" (at 0.635 -2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
\t(property "Footprint" "" (at 0.9652 -3.81 0) (effects (font (size 1.27 1.27)) hide))
\t(property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t(symbol "C_0_1"
\t\t(polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none)))
\t\t(polyline (pts (xy -2.032 0.762) (xy 2.032 0.762)) (stroke (width 0.508) (type default)) (fill (type none)))
\t)
\t(symbol "C_1_1"
\t\t(pin passive line (at 0 3.81 270) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t(pin passive line (at 0 -3.81 90) (length 2.794) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t)
)`;
const C_NEW_SYMBOL = `(symbol (lib_id "PlugLib:C") (at 150 95.25 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t(uuid "${C_NEW}")
\t(property "Reference" "C?" (at 152.54 94.615 0) (effects (font (size 1.27 1.27)) (justify left)))
\t(property "Value" "100n" (at 152.54 96.52 0) (effects (font (size 1.27 1.27)) (justify left)))
\t(property "Footprint" "" (at 150 95.25 0) (effects (font (size 1.27 1.27)) hide))
\t(property "Datasheet" "~" (at 150 95.25 0) (effects (font (size 1.27 1.27)) hide))
\t(pin "1" (uuid "dddddddd-0000-0000-0000-000000000001"))
\t(pin "2" (uuid "dddddddd-0000-0000-0000-000000000002"))
)`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabPresenceStart(): void;
  kicadCollabSetRemote(j: string): void;
  kicadCollabSnapshotItems(): string;
  kicadCollabTestUndo(): boolean;
  kicadCollabTestUndoDepth(): number;
  kicadPluginEditItems(json: string): string;
  kicadPluginEditStatus(id: number): string;
  kicadCancelPluginEdit(id: number): boolean;
  kicadPluginEditVersion(): number;
};
type Win = {
  FS: FS;
  Module: Mod;
  kicadCollab?: { onItems?: (json: string) => void; onDelta?: (json: string) => void };
  __editWires?: { added?: { sexpr: string }[]; changed?: { sexpr: string }[]; removed?: string[] }[];
};
type Edit = { label: string; upsert?: { sexpr: string }[]; remove?: string[]; libSymbols?: string[] };
type Outcome = { refused?: string; status?: string; code?: string; ids?: string[]; added?: string[]; changed?: string[]; removed?: string[] };

async function bootAndOpen(page: Page, url: string, path: string, content: string, title: RegExp): Promise<void> {
  await page.goto(url);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadPluginEditItems === "function";
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
    { path, content },
  );
  await expect.poll(() => page.title(), { timeout: 60000, intervals: [500] }).toMatch(title);
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.Module.kicadCollabPresenceStart();
    // Seed the collab bridge as the app does at load: later commits then diff against it.
    w.Module.kicadCollabSnapshotItems();
    // The items wire the collab layer normally consumes: every broadcast lands here.
    w.__editWires = [];
    w.kicadCollab = { onItems: (json: string) => { w.__editWires!.push(JSON.parse(json)); }, onDelta: () => {} };
  });
}

/** Runs one plugin edit and waits for its receipt to settle. */
function edit(page: Page, request: Edit): Promise<Outcome> {
  return page.evaluate(async (req) => {
    const m = (window as unknown as Win).Module;
    const started = JSON.parse(m.kicadPluginEditItems(JSON.stringify({ upsert: [], remove: [], ...req })));
    if (!started.ok) return { refused: started.code };
    for (let i = 0; i < 400; i++) {
      const result = JSON.parse(m.kicadPluginEditStatus(started.operation));
      if (result.status !== "queued") return result;
      await new Promise((r) => setTimeout(r, 25));
    }
    return { status: "timeout" };
  }, request);
}

const undoDepth = (page: Page) => page.evaluate(() => (window as unknown as Win).Module.kicadCollabTestUndoDepth());
const undo = (page: Page) => page.evaluate(() => (window as unknown as Win).Module.kicadCollabTestUndo());
/** What collaborators hold, as their selections would. */
const setLocks = (page: Page, ids: string[]) =>
  page.evaluate((ids) => {
    (window as unknown as Win).Module.kicadCollabSetRemote(JSON.stringify({ peers: [], locks: ids.map((uuid) => ({ uuid, name: "bob" })) }));
  }, ids);

/** The engine's own text for an item, or null when it is gone. */
async function blob(page: Page, id: string): Promise<string | null> {
  const snap = JSON.parse(await page.evaluate(() => (window as unknown as Win).Module.kicadCollabSnapshotItems())) as {
    added: { id?: string; sexpr?: string }[];
  };
  // Blobs arrive enveloped ((kicad_pcb …) on the board); every id here is unique to one item.
  const hit = snap.added.find((e) => e.id === id || (e.sexpr ?? "").includes(`(uuid "${id}")`));
  return hit?.sexpr ?? null;
}

/** Every id the items wire broadcast, added, changed or removed. */
function wired(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify((window as unknown as Win).__editWires ?? []));
}

test.describe("Plugin edits (plugins 0023)", () => {
  test("pcbnew: one edit is one undo step, broadcast like any edit, and Undo reverts all of it", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page, "/kicad/pcbnew-collab.html", "/home/kicad/documents/pluginedit.kicad_pcb", SAMPLE_PCB, /pluginedit/i);
    expect(await page.evaluate(() => (window as unknown as Win).Module.kicadPluginEditVersion())).toBe(1);
    const depth = await undoDepth(page);

    const result = await edit(page, {
      label: "Test plugin: widen and stitch",
      upsert: [
        { sexpr: `(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.5) (layer "F.Cu") (net "GND") (uuid "${SEG1}"))` },
        { sexpr: `(via (at 60 50.8) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${VIA_NEW}"))` },
      ],
      remove: [GR1],
    });
    expect(result).toMatchObject({ status: "applied", added: [VIA_NEW], changed: [SEG1], removed: [GR1] });
    await expect.poll(() => undoDepth(page), { timeout: 10000 }).toBe(depth + 1);
    expect(await blob(page, SEG1)).toContain("(width 0.5)");
    expect(await blob(page, SEG1)).toContain('(net "GND")');
    expect(await blob(page, VIA_NEW)).toContain("(via");
    expect(await blob(page, GR1)).toBeNull();
    // Collaborators get it like any local commit.
    await expect.poll(() => wired(page), { timeout: 10000 }).toContain(VIA_NEW);
    expect(await wired(page)).toContain(GR1);

    expect(await undo(page)).toBe(true);
    await expect.poll(() => blob(page, VIA_NEW), { timeout: 10000 }).toBeNull();
    expect(await blob(page, SEG1)).toContain("(width 0.2)");
    expect(await blob(page, GR1)).toContain("gr_line");
    expect(await undoDepth(page)).toBe(depth);
  });

  test("pcbnew: held items, unknown nets, missing ids and pads refuse the whole edit", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page, "/kicad/pcbnew-collab.html", "/home/kicad/documents/pluginrefuse.kicad_pcb", SAMPLE_PCB, /pluginrefuse/i);
    const depth = await undoDepth(page);
    const widen = { sexpr: `(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.5) (layer "F.Cu") (net "GND") (uuid "${SEG1}"))` };

    // A collaborator holds SEG1: refused, with the id, and the rest of the edit is not applied either.
    await page.evaluate((id) => {
      (window as unknown as Win).Module.kicadCollabSetRemote(JSON.stringify({ peers: [], locks: [{ uuid: id, name: "bob" }] }));
    }, SEG1);
    expect(await edit(page, { label: "held", upsert: [widen], remove: [GR1] })).toMatchObject({ status: "error", code: "HELD", ids: [SEG1] });
    await page.evaluate(() => (window as unknown as Win).Module.kicadCollabSetRemote(JSON.stringify({ peers: [], locks: [] })));

    const newFootprint = `(footprint "TestLib:X" (layer "F.Cu") (uuid "66666666-0000-0000-0000-0000000000f1") (at 120 100) (attr smd)
\t\t(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 7 "VCC") (uuid "66666666-0000-0000-0000-0000000000f2")))`;
    expect(await edit(page, { label: "net", upsert: [{ sexpr: newFootprint }] })).toMatchObject({ status: "error", code: "UNKNOWN_NET" });
    // Nets go by name: a bare net code (the pre-KiCad-10 form) would silently disconnect the item.
    expect(await edit(page, { label: "net code", upsert: [{ sexpr: widen.sexpr.replace('(net "GND")', "(net 1)") }] })).toMatchObject({ status: "error", code: "UNKNOWN_NET" });
    expect(await edit(page, { label: "missing", remove: ["44444444-0000-0000-0000-0000000000ff"] })).toMatchObject({ status: "error", code: "MISSING" });
    expect(await edit(page, { label: "pad", remove: [PAD1] })).toMatchObject({ status: "error", code: "INVALID" });
    expect(await edit(page, { label: "garbage", upsert: [{ sexpr: "(segment (start" }] })).toMatchObject({ status: "error", code: "INVALID" });
    expect(await edit(page, { label: "two items", upsert: [{ sexpr: widen.sexpr + widen.sexpr.replace(SEG1, VIA_NEW) }] })).toMatchObject({ status: "error", code: "INVALID" });
    expect(await edit(page, { label: "" })).toMatchObject({ refused: "INVALID" });

    expect(await blob(page, SEG1)).toContain("(width 0.2)");
    expect(await blob(page, GR1)).toContain("gr_line");
    expect(await undoDepth(page)).toBe(depth);
  });

  test("pcbnew: a footprint's pads keep only their own ids, and a held pad holds its footprint", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page, "/kicad/pcbnew-collab.html", "/home/kicad/documents/pluginids.kicad_pcb", SAMPLE_PCB, /pluginids/i);
    const pad = (n: string, id: string) => `(pad "${n}" smd rect (at ${n} 0) (size 1 1) (layers "F.Cu") (net "GND") (uuid "${id}"))`;
    const fp1 = (pads: string, id = FP1) => `(footprint "TestLib:R" (layer "F.Cu") (uuid "${id}") (at 110 100) (attr smd)
\t\t(fp_rect (start -2 -2) (end 2 2) (layer "F.SilkS") (stroke (width 0.3) (type solid)) (uuid "66666666-0000-0000-0000-0000000000cc"))
\t\t${pads})`;

    // A collaborator holds only the pad: changing or removing its footprint rewrites it, so both wait.
    await setLocks(page, [PAD1]);
    expect(await edit(page, { label: "move", upsert: [{ sexpr: fp1(pad("1", PAD1)) }] })).toMatchObject({ status: "error", code: "HELD", ids: [FP1] });
    expect(await edit(page, { label: "remove", remove: [FP1] })).toMatchObject({ status: "error", code: "HELD", ids: [FP1] });
    await setLocks(page, []);

    // The footprint's own pad keeps its id; a second pad claiming it, and a pad claiming the
    // segment's id, get fresh ones, so no id exists twice on the board.
    expect(await edit(page, { label: "pads", upsert: [{ sexpr: fp1(pad("1", PAD1) + pad("2", PAD1) + pad("3", SEG1)) }] }))
      .toMatchObject({ status: "applied", changed: [FP1] });
    const changed = (await blob(page, FP1))!;
    expect(changed.split(`(uuid "${PAD1}")`).length - 1).toBe(1);
    expect(changed).not.toContain(SEG1);
    expect(await blob(page, SEG1)).toContain("(segment");

    // A new footprint copied from FP1 gets fresh pad ids too.
    const FP2 = "66666666-0000-0000-0000-0000000000f3";
    expect(await edit(page, { label: "copy", upsert: [{ sexpr: fp1(pad("1", PAD1), FP2) }] })).toMatchObject({ status: "applied", added: [FP2] });
    expect(await blob(page, FP2)).not.toContain(PAD1);
    expect(await blob(page, FP1)).toContain(PAD1);
  });

  test("eeschema: wires, a changed symbol and a new library symbol are one undo step", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page, "/kicad/eeschema.html", "/home/kicad/documents/pluginedit.kicad_sch", SAMPLE_SCH, /pluginedit/i);
    const depth = await undoDepth(page);

    const result = await edit(page, {
      label: "Test plugin: rewire",
      upsert: [
        { sexpr: `(wire (pts (xy 100 90) (xy 120 90)) (stroke (width 0) (type default)) (uuid "${WIRE_NEW}"))` },
        { sexpr: r1("22k") },
        { sexpr: C_NEW_SYMBOL },
      ],
      remove: [WIRE1],
      libSymbols: [C_DEF],
    });
    expect(result).toMatchObject({ status: "applied", added: [WIRE_NEW, C_NEW], changed: [R1], removed: [WIRE1] });
    await expect.poll(() => undoDepth(page), { timeout: 10000 }).toBe(depth + 1);
    expect(await blob(page, R1)).toContain('"22k"');
    expect(await blob(page, WIRE_NEW)).toContain("(wire");
    expect(await blob(page, C_NEW)).toContain("PlugLib:C");
    expect(await blob(page, WIRE1)).toBeNull();
    await expect.poll(() => wired(page), { timeout: 10000 }).toContain(WIRE_NEW);

    expect(await undo(page)).toBe(true);
    await expect.poll(() => blob(page, WIRE_NEW), { timeout: 10000 }).toBeNull();
    expect(await blob(page, R1)).toContain('"10k"');
    expect(await blob(page, C_NEW)).toBeNull();
    expect(await blob(page, WIRE1)).toContain("(wire");
  });

  test("eeschema: a symbol's pins keep only their own ids, and a held pin holds its symbol", async ({ page, testLogger }) => {
    void testLogger;
    await bootAndOpen(page, "/kicad/eeschema.html", "/home/kicad/documents/pluginids.kicad_sch", SAMPLE_SCH, /pluginids/i);
    const PIN1 = "cccccccc-0000-0000-0000-000000000001";

    await setLocks(page, [PIN1]);
    expect(await edit(page, { label: "value", upsert: [{ sexpr: r1("22k") }] })).toMatchObject({ status: "error", code: "HELD", ids: [R1] });
    expect(await edit(page, { label: "remove", remove: [R1] })).toMatchObject({ status: "error", code: "HELD", ids: [R1] });
    await setLocks(page, []);

    // A copy of R1 under a new id: its pins get fresh ids; R1 keeps its own.
    const R2 = "bbbbbbbb-2222-2222-2222-222222222223";
    expect(await edit(page, { label: "copy", upsert: [{ sexpr: r1("1k").replace(`(uuid "${R1}")`, `(uuid "${R2}")`) }] }))
      .toMatchObject({ status: "applied", added: [R2] });
    expect(await blob(page, R2)).not.toContain(PIN1);
    expect(await blob(page, R1)).toContain(PIN1);
  });
});
