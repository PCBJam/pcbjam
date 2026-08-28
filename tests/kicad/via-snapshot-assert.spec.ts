import { test, expect, type Page } from "./fixtures";
import { execSync } from "child_process";
import * as path from "path";

/**
 * repro for R-2 (docs/features/findings/groups/R-fixed-during-demo-record.md)
 *
 * `itemToJson` (wasm/bindings/pcbnew_embind.cpp) once called the layerless
 * virtual `PCB_VIA::GetWidth()` — since the padstack refactor that is a
 * wxCHECK trap ("Warning: PCB_VIA::GetWidth called without a layer argument",
 * pcbnew/pcb_track.cpp) — once per via per snapshot. The value came back
 * right (the wxCHECK's fallback IS the ALL_LAYERS slot), so no spec noticed;
 * on a big board every collab baseline/snapshot was an assert storm in the
 * console. The fix passes `PADSTACK::ALL_LAYERS`.
 *
 * Oracle: the wx assert line in the console (the wasm build logs asserts via
 * wxMessageOutputDebug and continues — wxTrap is a no-op there), plus the
 * via width itself. Harness: pcbnew-collab.html (wizard-skipping seed), a
 * two-via board written into MEMFS.
 */

const VIA1 = "aaaaaaaa-0000-4000-8000-00000000c001";
const VIA2 = "aaaaaaaa-0000-4000-8000-00000000c002";

const VIA_PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(via (at 80 80) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "${VIA1}"))
\t(via (at 90 80) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 0) (uuid "${VIA2}"))
)
`;

const VIA_WIDTH_ASSERT =
  /PCB_VIA::GetWidth called without a layer argument|assert "false" failed in GetWidth\(\)/;

interface FS { mkdirTree(p: string): void; writeFile(p: string, d: string): void; }
interface Mod { kicadOpenFile(p: string): unknown; kicadCollabSnapshot(): string; }

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadOpenFile === "function" && typeof m?.kicadCollabSnapshot === "function";
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
  await page.evaluate((content) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    const dir = "/home/kicad/documents";
    try { w.FS.mkdirTree(dir); } catch { /* exists */ }
    const p = `${dir}/vias.kicad_pcb`;
    w.FS.writeFile(p, content);
    w.Module.kicadOpenFile(p);
  }, VIA_PCB);
  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(/vias/i);
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

test("snapshotting a board with vias emits their width without a GetWidth assert (R-2)", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(180000);
  await bootAndOpen(page);

  // Several snapshots: pre-fix this was one assert PER VIA PER SNAPSHOT.
  const snaps = await page.evaluate(() => {
    const m = (window as unknown as { Module: Mod }).Module;
    return [0, 1, 2].map(() => JSON.parse(m.kicadCollabSnapshot()));
  });
  const last = snaps[snaps.length - 1] as { added: Array<{ id: string; type: string; width?: number; drill?: number }> };
  const byId = new Map(last.added.map((i) => [i.id, i]));

  for (const [id, mm] of [[VIA1, 1.4], [VIA2, 0.8]] as const) {
    const via = byId.get(id);
    expect(via, `via ${id} present in snapshot`).toBeTruthy();
    expect(via!.type).toBe("PCB_VIA");
    // internal units are nm; the (size …) is the whole-stack width.
    expect(via!.width, `via ${id} width`).toBe(Math.round(mm * 1_000_000));
    expect(via!.drill, `via ${id} drill`).toBeGreaterThan(0);
  }

  const assertLines = [...testLogger.consoleLogs, ...testLogger.errors].filter((l) =>
    VIA_WIDTH_ASSERT.test(l),
  );
  expect(assertLines, "no PCB_VIA::GetWidth assert in the console").toEqual([]);
});
