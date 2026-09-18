import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Plugin platform `board.geometry` — the engine entry point, against the real engine.
 *
 * kicadPluginBoardGeometry hands out the open board as finished shapes, a bounded slice per call
 * (wasm/bindings/plugin_board_geometry.h). Checked here: the shapes are right for the awkward cases
 * (rotated rounded pad, oval hole, arcs, text), slicing is invisible, tracks/zones are opt-in, a
 * board that changed between slices is refused, and malformed input never reaches the walk.
 */

const FP1 = "66666666-0000-0000-0000-000000000001";
const PAD1 = "66666666-0000-0000-0000-0000000000d1";
const PAD2 = "66666666-0000-0000-0000-0000000000d2";
const ZONE1 = "77777777-0000-0000-0000-000000000001";
const font = "(effects (font (size 1 1) (thickness 0.15)))";
const SAMPLE_PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(5 "F.SilkS" user "F.Silkscreen")
\t\t(7 "B.SilkS" user "B.Silkscreen")
\t\t(35 "F.Fab" user)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(net 1 "GND")
\t(footprint "TestLib:R_0603"
\t\t(layer "F.Cu")
\t\t(uuid "${FP1}")
\t\t(at 100 100 90)
\t\t(property "Reference" "R1" (at 0 -2 90) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000a1") ${font})
\t\t(property "Value" "10k" (at 0 2 90) (layer "F.Fab") (uuid "66666666-0000-0000-0000-0000000000a2") ${font})
\t\t(property "MPN" "RC0603-10K" (at 0 0 90) (layer "F.Fab") (hide yes) (uuid "66666666-0000-0000-0000-0000000000a3") ${font})
\t\t(attr smd dnp)
\t\t(fp_circle (center 0 0) (end 0.5 0) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (fill no) (uuid "66666666-0000-0000-0000-0000000000c1"))
\t\t(fp_arc (start -1 -1) (mid 0 -1.4) (end 1 -1) (layer "F.SilkS") (stroke (width 0.12) (type solid)) (uuid "66666666-0000-0000-0000-0000000000c2"))
\t\t(fp_line (start -1 1) (end 1 1) (layer "B.Cu") (stroke (width 0.12) (type solid)) (uuid "66666666-0000-0000-0000-0000000000c3"))
\t\t(pad "1" smd roundrect (at -1 0 135) (size 1.5 0.8) (layers "F.Cu" "F.Mask") (roundrect_rratio 0.25) (net 1 "GND") (pinfunction "A") (uuid "${PAD1}"))
\t\t(pad "2" thru_hole oval (at 2 0 90) (size 2 1.2) (drill oval 1 0.6) (layers "*.Cu" "*.Mask") (uuid "${PAD2}"))
\t)
\t(gr_rect (start 50 50) (end 150 130) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "55555555-0000-0000-0000-000000000001"))
\t(gr_text "HELLO" (at 70 70 0) (layer "F.SilkS") (uuid "55555555-0000-0000-0000-000000000002") ${font})
\t(gr_text "COPPER" (at 70 80 0) (layer "F.Cu") (uuid "55555555-0000-0000-0000-000000000003") ${font})
\t(segment (start 60 120) (end 90 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "44444444-0000-0000-0000-000000000001"))
\t(arc (start 90 120) (mid 95 118) (end 100 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "44444444-0000-0000-0000-000000000002"))
\t(via (at 60 120) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "44444444-0000-0000-0000-000000000003"))
\t(zone (net 1) (net_name "GND") (layer "B.Cu") (uuid "${ZONE1}") (hatch edge 0.5)
\t\t(connect_pads (clearance 0.5)) (min_thickness 0.25) (filled_areas_thickness no)
\t\t(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
\t\t(polygon (pts (xy 60 60) (xy 90 60) (xy 90 90) (xy 60 90)))
\t\t(filled_polygon (layer "B.Cu") (pts (xy 60 60) (xy 90 60) (xy 90 90) (xy 60 90)))
\t)
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabPresenceStart(): void;
  kicadCollabTestMoveFirst(dx: number, dy: number): string;
  kicadPluginBoardGeometry(options: string, cursor: string, budgetMs: number, maxChars: number): string;
  kicadPluginBoardGeometryVersion(): number;
};
type LocksWindow = { FS: FS; Module: Mod };
type Pt = [number, number];
type Poly = { outline: Pt[]; holes?: Pt[][] };
type Rec = Record<string, any>;

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadPluginBoardGeometry === "function"
      );
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
    ({ content }) => {
      const w = window as unknown as LocksWindow;
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const p = `${dir}/geometry.kicad_pcb`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_PCB },
  );

  await expect
    .poll(() => page.title(), { timeout: 60000, intervals: [500] })
    .toMatch(/geometry/i);

  await page.evaluate(() => {
    (window as unknown as LocksWindow).Module.kicadCollabPresenceStart();
  });
}


/** One engine call, parsed: envelope line, then one JSON record per line. */
const slice = (page: Page, options: string, cursor: string, budgetMs = 50, maxChars = 4194304) =>
  page.evaluate(
    ({ options, cursor, budgetMs, maxChars }) => {
      const started = performance.now();
      const text = (window as unknown as LocksWindow).Module.kicadPluginBoardGeometry(options, cursor, budgetMs, maxChars);
      const ms = performance.now() - started, at = text.indexOf("\n");
      return { envelope: JSON.parse(text.slice(0, at)), body: text.slice(at + 1), ms };
    },
    { options, cursor, budgetMs, maxChars },
  );

/** Drain a whole read; returns the records and how many engine calls it took. */
async function readAll(page: Page, options: object, budgetMs = 50, maxChars = 4194304) {
  let cursor = "", body = "", calls = 0, worstMs = 0;
  for (;;) {
    const part = await slice(page, JSON.stringify(options), cursor, budgetMs, maxChars);
    expect(part.envelope.ok, JSON.stringify(part.envelope)).toBe(true);
    body += part.body; calls++; worstMs = Math.max(worstMs, part.ms);
    if (part.envelope.next === null) break;
    cursor = JSON.stringify(part.envelope.next);
    expect(calls).toBeLessThan(5000);
  }
  return { records: body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Rec), body, calls, worstMs };
}

const bounds = (polys: Poly[]) => {
  const pts = polys.flatMap((p) => p.outline);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
};

test("hands out finished shapes for pads, holes, graphics and text", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  expect(await page.evaluate(() => (window as unknown as LocksWindow).Module.kicadPluginBoardGeometryVersion())).toBe(1);

  const { records } = await readAll(page, {});
  const board = records[0]!;
  expect(board.$).toBe("board");
  expect(board.units).toBe("mm");
  expect(board.footprints).toBe(1);
  expect(board.nets).toBeUndefined(); // only sent with tracks or zones
  // The edge rectangle, as a polygon: 50..150 x 50..130 (the 0.1 mm line is centred on it).
  expect(board.outline).toHaveLength(1);
  const edge = bounds(board.outline);
  for (const [got, want] of [[edge.x1, 50], [edge.y1, 50], [edge.x2, 150], [edge.y2, 130]]) expect(got).toBeCloseTo(want, 1);

  const fps = records.filter((r) => r.$ === "footprint");
  expect(fps).toHaveLength(1);
  const fp = fps[0]!;
  expect([fp.id, fp.ref, fp.value, fp.footprint, fp.side, fp.pos, fp.angle]).toEqual([FP1, "R1", "10k", "TestLib:R_0603", "F", [100, 100], 90]);
  expect(fp.attrs).toMatchObject({ smd: true, tht: false, dnp: true, excludeFromBom: false });
  // Hidden fields are data even though they draw nothing; KiCad adds its own empty Datasheet/Description.
  expect(fp.fields).toEqual({ MPN: "RC0603-10K", Datasheet: "", Description: "" });
  expect(fp.bbox[0]).toBeLessThan(100); expect(fp.bbox[2]).toBeGreaterThan(100);

  // Pad 1: a 1.5 x 0.8 rounded rectangle. The footprint is rotated 90 degrees and the pad sits at (-1, 0)
  // in it, so on the board it is at (100, 99)... the engine, not the plugin, works that out.
  const pad1 = fp.pads.find((p: Rec) => p.id === PAD1);
  expect([pad1.number, pad1.net, pad1.pinFunction, pad1.type]).toEqual(["1", "GND", "A", "smd"]);
  expect(Object.keys(pad1.polygons)).toEqual(["F"]);
  expect(pad1.hole).toBeUndefined();
  const p1 = pad1.polygons.F as Poly[];
  expect(p1).toHaveLength(1);
  expect(p1[0]!.outline.length).toBeGreaterThan(8); // rounded corners are real points, not a 4-corner box
  const b1 = bounds(p1);
  expect((b1.x1 + b1.x2) / 2).toBeCloseTo(pad1.pos[0], 2);
  expect((b1.y1 + b1.y2) / 2).toBeCloseTo(pad1.pos[1], 2);
  // Rotated 45 degrees off-axis: the bounding box is a square of side (1.5 + 0.8) / sqrt(2), less the rounding.
  expect(b1.x2 - b1.x1).toBeCloseTo(b1.y2 - b1.y1, 2);
  expect(b1.x2 - b1.x1).toBeGreaterThan(1.3); expect(b1.x2 - b1.x1).toBeLessThan(1.63);

  // Pad 2: through-hole on both sides, with an oval hole that is longer one way than the other.
  const pad2 = fp.pads.find((p: Rec) => p.id === PAD2);
  expect(pad2.type).toBe("tht");
  expect(Object.keys(pad2.polygons).sort()).toEqual(["B", "F"]);
  const hole = bounds(pad2.hole);
  const [long, short] = [hole.x2 - hole.x1, hole.y2 - hole.y1].sort((a, b) => b - a);
  expect(long).toBeCloseTo(1, 1); expect(short).toBeCloseTo(0.6, 1);

  // Drawings: reference on silk and value on fab as polygons, tagged; the hidden field and the copper line are absent.
  const kinds = fp.drawings.map((d: Rec) => `${d.layer}:${d.text ?? "shape"}`).sort();
  expect(kinds).toEqual(["F.Fab:value", "F.SilkS:reference", "F.SilkS:shape", "F.SilkS:shape"]);
  for (const d of fp.drawings) { expect(d.polygons.length).toBeGreaterThan(0); expect(d.polygons[0].outline.length).toBeGreaterThan(2); }
  // The 0.5 mm-radius circle drawn with a 0.12 mm line is about 1.12 mm across, both ways. (KiCad hands a ring
  // back as one outline with a slit rather than an outline plus a hole, so size is the observable.)
  const round = fp.drawings.filter((d: Rec) => !d.text).map((d: Rec) => bounds(d.polygons)).find((b: ReturnType<typeof bounds>) => Math.abs(b.x2 - b.x1 - 1.12) < 0.05);
  expect(round, JSON.stringify(fp.drawings.filter((d: Rec) => !d.text).map((d: Rec) => bounds(d.polygons)))).toBeTruthy();
  expect(round!.y2 - round!.y1).toBeCloseTo(1.12, 1);
  // Board-level graphics: silk text and the edge rectangle; text on copper is not a drawing.
  const drawn = records.filter((r) => r.$ === "drawing").map((r) => `${r.item.layer}:${r.item.text ?? "shape"}`).sort();
  expect(drawn).toEqual(["Edge.Cuts:shape", "F.SilkS:text"]);
  expect(records.some((r) => r.$ === "tracks" || r.$ === "zone")).toBe(false);
  expect(hasAbort(testLogger)).toBe(false);
});

test("tracks, vias and zone fills are opt-in", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  const { records } = await readAll(page, { tracks: true, zones: true });
  expect(records[0]!.nets).toEqual({ "1": "GND" });

  const items = records.filter((r) => r.$ === "tracks").flatMap((r) => r.items as Rec[]);
  expect(items).toHaveLength(3);
  const seg = items.find((t) => t.start);
  expect(seg).toEqual({ layer: "F.Cu", width: 0.25, start: [60, 120], end: [90, 120], net: 1 });
  const arc = items.find((t) => t.polygons);
  expect([arc!.layer, arc!.net]).toEqual(["F.Cu", 1]);
  const ab = bounds(arc!.polygons);
  expect(ab.x1).toBeCloseTo(90 - 0.125, 1); expect(ab.x2).toBeCloseTo(100 + 0.125, 1); expect(ab.y1).toBeLessThan(118.1);
  expect(items.find((t) => t.via)).toEqual({ via: [60, 120], diameter: 0.8, drill: 0.4, net: 1 });

  const zones = records.filter((r) => r.$ === "zone");
  expect(zones).toHaveLength(1);
  expect([zones[0]!.id, zones[0]!.layer, zones[0]!.net]).toEqual([ZONE1, "B.Cu", 1]);
  const zb = bounds([zones[0]!.polygon]);
  expect([zb.x1, zb.y1, zb.x2, zb.y2]).toEqual([60, 60, 90, 90]);

  // Each flag alone.
  expect((await readAll(page, { tracks: true })).records.some((r) => r.$ === "zone")).toBe(false);
  expect((await readAll(page, { zones: true })).records.some((r) => r.$ === "tracks")).toBe(false);
  expect(hasAbort(testLogger)).toBe(false);
});

test("slicing is invisible and a changed board is refused mid-read", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  const whole = await readAll(page, { tracks: true, zones: true });
  expect(whole.calls).toBe(1);
  // The smallest size the engine accepts: it stops as soon as a slice passes 1024 characters.
  const sliced = await readAll(page, { tracks: true, zones: true }, 50, 1024);
  expect(sliced.calls).toBeGreaterThan(2);
  expect(sliced.body).toBe(whole.body);

  const first = await slice(page, "{}", "", 50, 1024);
  expect(first.envelope.next).not.toBeNull();
  const cursor = JSON.stringify(first.envelope.next);
  expect((await slice(page, "{}", cursor, 50, 1024)).envelope.ok).toBe(true); // resumable while nothing changed

  // Move an item through the real commit path, then resume the OLD cursor.
  await page.evaluate(() => (window as unknown as LocksWindow).Module.kicadCollabTestMoveFirst(1000000, 0));
  await expect
    .poll(async () => (await slice(page, "{}", cursor, 50, 1024)).envelope, { timeout: 15000 })
    .toEqual({ ok: false, error: "CHANGED" });
  // A fresh read works and sees the board as it is now.
  expect((await readAll(page, {})).records[0]!.$).toBe("board");
  expect(hasAbort(testLogger)).toBe(false);
});

test("malformed options, cursors and limits never reach the walk", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  const good = JSON.stringify((await slice(page, "{}", "", 50, 1024)).envelope.next);
  const cases: Array<[string, string, number, number]> = [
    ["not json", "", 8, 262144], ["[]", "", 8, 262144], ['"tracks"', "", 8, 262144],
    ["{}", "not json", 8, 262144], ["{}", "[1,2,3]", 8, 262144], ["{}", '{"s":1,"i":0,"j":0}', 8, 262144],
    ["{}", '{"s":99,"i":0,"j":0,"t":0}', 8, 262144], ["{}", '{"s":1,"i":-1,"j":0,"t":0}', 8, 262144], ["{}", '{"s":"1","i":0,"j":0,"t":0}', 8, 262144],
    ["{}", good, 0, 262144], ["{}", good, 1000, 262144], ["{}", good, 8, 10], ["{}", good, 8, 1 << 30],
  ];
  for (const [options, cursor, budget, max] of cases) {
    const reply = await slice(page, options, cursor, budget, max);
    expect(reply.envelope, `${options} | ${cursor} | ${budget} | ${max}`).toEqual({ ok: false, error: "INVALID" });
    expect(reply.body).toBe("");
  }
  // Option values that are not the literal `true` are simply off: no string ever selects anything.
  const odd = await readAll(page, { tracks: "yes", zones: 1, layers: ["B.Cu"], __proto__: { tracks: true } });
  expect(odd.records.some((r) => r.$ === "tracks" || r.$ === "zone")).toBe(false);
  // An index past the end is a finished section, not an out-of-bounds read.
  const stamp = JSON.parse(good).t;
  const past = await slice(page, "{}", JSON.stringify({ s: 1, i: 1000000, j: 0, t: stamp }), 50, 262144);
  expect(past.envelope.ok).toBe(true);
  expect(past.body.includes('"$":"footprint"')).toBe(false);
  expect(hasAbort(testLogger)).toBe(false);
});
