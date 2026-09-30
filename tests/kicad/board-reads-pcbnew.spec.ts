import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Guide-tour board read (docs/features/overlay-system/0004 H3): kicadBoardStatus,
 * against the real engine on a hand-written board with known state:
 *
 *   Edge.Cuts rectangle (50,50)–(80,70)
 *   R1 at (60,60): pad 1 (59,60) net A, pad 2 (61,60) net B
 *   R2 at (70,60): pad 1 (69,60) net A, pad 2 (71,60) net B — plus a Dwgs.User line
 *      ABOVE the edge (a connector's "board edge here" note): its pads still count inside
 *   R3 at (100,100): outside the board
 *   net A routed (3 segments under the parts), net B not → 1 unrouted connection
 *
 * Checked: outline closed, per-footprint `inside` from pads (not the bounding box),
 * track/via counts, unrouted, the active layer, and that edits show up on the next read
 * (a removed segment → 2 unrouted; the outline removed → not closed, nothing inside).
 */
type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadBoardStatus(): string;
  kicadCollabTestRemoveItem(id: string): boolean;
  kicadLayersSetActive(layer: number): boolean;
};
type Status = {
  outlineClosed: boolean;
  activeLayer: string;
  tracks: number;
  vias: number;
  unrouted: number;
  footprints: { uuid: string; ref: string; fpid: string; x: number; y: number; side: string; inside: boolean }[];
};

const BOOT = 150000;
const OUTLINE = "55555555-0000-0000-0000-000000000001";
const SEG = ["44444444-0000-0000-0000-000000000001", "44444444-0000-0000-0000-000000000002", "44444444-0000-0000-0000-000000000003"];
const font = "(effects (font (size 1 1) (thickness 0.15)))";
const fp = (uuid: string, ref: string, x: number, y: number, pads: [string, number][], extra = "") => `\t(footprint "Resistor_SMD:R_0805_2012Metric"
\t\t(layer "F.Cu")
\t\t(uuid "${uuid}")
\t\t(at ${x} ${y})
\t\t(property "Reference" "${ref}" (at 0 -2) (layer "F.SilkS") (uuid "${uuid.slice(0, -2)}a1") ${font})
\t\t(property "Value" "1k" (at 0 2) (layer "F.Fab") (uuid "${uuid.slice(0, -2)}a2") ${font})
\t\t(attr smd)
${extra}\t\t(pad "1" smd rect (at -1 0) (size 1 1.2) (layers "F.Cu" "F.Mask") ${pads[0]![1] ? `(net ${pads[0]![1]} "${pads[0]![0]}") ` : ""}(uuid "${uuid.slice(0, -2)}d1"))
\t\t(pad "2" smd rect (at 1 0) (size 1 1.2) (layers "F.Cu" "F.Mask") ${pads[1]![1] ? `(net ${pads[1]![1]} "${pads[1]![0]}") ` : ""}(uuid "${uuid.slice(0, -2)}d2"))
\t)
`;
const BOARD = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(5 "F.SilkS" user "F.Silkscreen")
\t\t(13 "F.Mask" user)
\t\t(35 "F.Fab" user)
\t\t(33 "Dwgs.User" user "User.Drawings")
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(net 1 "A")
\t(net 2 "B")
${fp("66666666-0000-0000-0000-000000000001", "R1", 60, 60, [["A", 1], ["B", 2]])}${fp("66666666-0000-0000-0000-000000000002", "R2", 70, 60, [["A", 1], ["B", 2]],
  `\t\t(fp_line (start 0 -15) (end 0 -12) (stroke (width 0.15) (type solid)) (layer "Dwgs.User") (uuid "66666666-0000-0000-0000-0000000002c1"))\n`)}${fp("66666666-0000-0000-0000-000000000003", "R3", 100, 100, [["", 0], ["", 0]])}\t(gr_rect (start 50 50) (end 80 70) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "${OUTLINE}"))
\t(segment (start 59 60) (end 59 64) (width 0.25) (layer "F.Cu") (net 1) (uuid "${SEG[0]}"))
\t(segment (start 59 64) (end 69 64) (width 0.25) (layer "F.Cu") (net 1) (uuid "${SEG[1]}"))
\t(segment (start 69 64) (end 69 60) (width 0.25) (layer "F.Cu") (net 1) (uuid "${SEG[2]}"))
)
`;

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadBoardStatus === "function";
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
  await page.evaluate(
    ({ content }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      w.FS.writeFile(`${dir}/boardreads.kicad_pcb`, content);
      w.Module.kicadOpenFile(`${dir}/boardreads.kicad_pcb`);
    },
    { content: BOARD },
  );
  await expect.poll(() => page.title(), { timeout: 60000, intervals: [500] }).toMatch(/boardreads/i);
}

const status = (page: Page) =>
  page.evaluate(() => JSON.parse((window as unknown as { Module: Mod }).Module.kicadBoardStatus()) as Status);
const inside = (s: Status) => Object.fromEntries(s.footprints.map((f) => [f.ref, f.inside]));

test.describe("guide-tour board read (pcbnew)", () => {
  test.describe.configure({ timeout: 420000 });

  test("kicadBoardStatus reports outline, placement, routing and the active layer", async ({ page, testLogger }) => {
    await bootAndOpen(page);
    await expect.poll(async () => (await status(page)).footprints?.length ?? 0, { timeout: 60000, intervals: [500] }).toBe(3);

    const s = await status(page);
    expect(s.outlineClosed).toBe(true);
    expect(s.tracks).toBe(3);
    expect(s.vias).toBe(0);
    expect(s.unrouted, "net B is not routed").toBe(1);
    expect(inside(s), "pads decide — R2's note above the edge does not").toEqual({ R1: true, R2: true, R3: false });
    expect(s.footprints.find((f) => f.ref === "R1")).toMatchObject({
      uuid: "66666666-0000-0000-0000-000000000001",
      fpid: "Resistor_SMD:R_0805_2012Metric",
      x: 60_000_000,
      y: 60_000_000,
      side: "front",
    });
    expect(s.activeLayer).toBe("F.Cu");

    // Edits show on the next read: one routed segment gone → net A open again.
    await page.evaluate((id) => (window as unknown as { Module: Mod }).Module.kicadCollabTestRemoveItem(id), SEG[1]!);
    await expect.poll(async () => { const n = await status(page); return [n.tracks, n.unrouted]; }, { timeout: 20000, intervals: [400] }).toEqual([2, 2]);

    // The outline removed: not closed, and so nothing counts as inside.
    await page.evaluate((id) => (window as unknown as { Module: Mod }).Module.kicadCollabTestRemoveItem(id), OUTLINE);
    await expect.poll(async () => { const n = await status(page); return [n.outlineClosed, ...Object.values(inside(n))]; }, { timeout: 20000, intervals: [400] }).toEqual([false, false, false, false]);

    // The active layer follows the editor (Edge.Cuts = 25; applied on the coroutine).
    expect(await page.evaluate(() => (window as unknown as { Module: Mod }).Module.kicadLayersSetActive(25))).toBe(true);
    await expect.poll(async () => (await status(page)).activeLayer, { timeout: 20000, intervals: [400] }).toBe("Edge.Cuts");

    expect([...testLogger.consoleLogs, ...testLogger.errors].some((l) => l.includes("Aborted(")), "no WASM abort").toBe(false);
  });

  test("the schematic frame answers {} (merged image, no board)", async ({ page }) => {
    await page.goto("/kicad/eeschema.html");
    await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT });
    await page.waitForFunction(() => typeof (window as unknown as { Module?: Partial<Mod> }).Module?.kicadBoardStatus === "function", null, { timeout: BOOT });
    await page.waitForFunction(
      () => !!window.wxElementRegistry && window.wxElementRegistry.findAll({ visible: true }).some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
      null,
      { timeout: BOOT },
    );
    expect(await page.evaluate(() => (window as unknown as { Module: Mod }).Module.kicadBoardStatus())).toBe("{}");
  });
});
