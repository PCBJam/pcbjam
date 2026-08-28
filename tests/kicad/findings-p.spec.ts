import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { waitForEditorReady, clickByTooltip, findByTooltip, clickMenuBarItem, clickMenuItemByText, waitUntil } from "../e2e/utils/element-tracker";
import { waitForPcbnew } from "./utils/pcbnew-ready";
import { injectFromSubmodule } from "./utils/fs-inject";
import { waitForBoardLoaded } from "./utils/board-ready";
import { PROJECT_DIR_MEMFS } from "./utils/threed-viewer";
import * as fs from "fs";
import * as path from "path";

/**
 * Findings group P — editor tools, selection & embind interaction
 * (docs/features/findings/groups/P-editor-tools-embind-interaction.md).
 *
 * Repro probes for P-1 … P-5, ported from the demo-video ledger's
 * `video/src/probes/*` (not in this tree) onto the kicad harness. Each test
 * names the finding it gates; RED = bug present on the current line.
 */

const TRAP =
  /Aborted\(|index out of bounds|unreachable executed|indirect call signature|null function|memory access out of bounds/;

const SEG1 = "44444444-0000-0000-0000-000000000001";
const FP1 = "66666666-0000-0000-0000-000000000001";
const FP1_REF = "66666666-0000-0000-0000-0000000000aa";
const FP1_VAL = "66666666-0000-0000-0000-0000000000bb";
const FP1_AT = { x: 100e6, y: 100e6 }; // IU (nm)

const SAMPLE_PCB = `(kicad_pcb
\t(version 20260206)
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
\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "${FP1}")
\t\t(at 100 100)
\t\t(attr smd)
\t\t(property "Reference" "R1"
\t\t\t(at 0 -4.2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "${FP1_REF}")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t\t(property "Value" "R"
\t\t\t(at 0 4.6 0)
\t\t\t(layer "F.Fab")
\t\t\t(uuid "${FP1_VAL}")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at -1 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(uuid "66666666-0000-0000-0000-0000000000dd")
\t\t)
\t\t(pad "2" smd rect
\t\t\t(at 1 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(uuid "66666666-0000-0000-0000-0000000000ee")
\t\t)
\t)
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG1}"))
)
`;

type Vp = { cx: number; cy: number; scale: number; w: number; h: number };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabPresenceStart(): void;
  kicadCollabGetViewport(): string;
  kicadCollabFitViewport(cx: number, cy: number, hw: number, hh: number): void;
  kicadCollabGetSelection(): string;
  kicadCollabTestSelectByUuid(id: string): boolean;
  kicadCollabTestClearSelection(): boolean;
  kicadCollabTestRotateItem(id: string, deg: number): boolean;
  kicadCollabTestItemBlob(id: string): string;
  kicadCollabTestListItems(n: number): string;
  kicadCollabSnapshot(): string;
  kicadCollabGetPos(id: string): string;
};
type W = { FS: { mkdirTree(p: string): void; writeFile(p: string, d: string): void }; Module: Mod };

function hasTrap(l: { consoleLogs: string[]; errors: string[] }): string[] {
  return [...l.consoleLogs, ...l.errors].filter((s) => TRAP.test(s));
}

async function bootCollab(page: Page, content: string = SAMPLE_PCB, firstId: string = FP1): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabFitViewport === "function" &&
        typeof m?.kicadCollabTestRotateItem === "function"
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
  await page.evaluate(({ content }) => {
    const w = window as unknown as W;
    const dir = "/home/kicad/documents";
    try {
      w.FS.mkdirTree(dir);
    } catch {
      /* exists */
    }
    const p = `${dir}/findings-p.kicad_pcb`;
    w.FS.writeFile(p, content);
    w.Module.kicadOpenFile(p);
  }, { content });
  await page.waitForFunction(
    (id) => {
      try {
        const m = (window as unknown as W).Module;
        return JSON.parse(m.kicadCollabTestListItems(1000)).some((i: { id?: string }) => (i.id ?? i) === id)
          || m.kicadCollabTestItemBlob(id).includes("(footprint");
      } catch {
        return false;
      }
    },
    firstId,
    { timeout: 60000 },
  );
  await page.evaluate(() => (window as unknown as W).Module.kicadCollabPresenceStart());
}

const getVp = (page: Page): Promise<Vp> =>
  page.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetViewport()));

async function fit(page: Page, t: { cx: number; cy: number; hw: number; hh: number }) {
  await page.evaluate((t) => (window as unknown as W).Module.kicadCollabFitViewport(t.cx, t.cy, t.hw, t.hh), t);
}

/** Fit and wait for the camera to land; returns whether it did (P-1 oracle). */
async function fitLands(page: Page, t: { cx: number; cy: number; hw: number; hh: number }, timeout = 8000) {
  await fit(page, t);
  return expect
    .poll(async () => {
      const vp = await getVp(page);
      return Math.abs(vp.cx - t.cx) < 1e6 && Math.abs(vp.cy - t.cy) < 1e6;
    }, { timeout, intervals: [200] })
    .toBe(true)
    .then(() => true, () => false);
}

async function fpRotation(page: Page, id: string): Promise<number | null> {
  const blob = await page.evaluate((i) => (window as unknown as W).Module.kicadCollabTestItemBlob(i), id);
  const m = blob.match(/\(footprint[^]*?\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\)/);
  if (!m) return null;
  return m[3] ? Number(m[3]) : 0;
}

async function glCanvasBox(page: Page) {
  const id = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
      .map((c) => c as HTMLCanvasElement)
      .find((c) => {
        const r = c.getBoundingClientRect();
        return window.getComputedStyle(c).display !== "none" && r.width > 0 && r.height > 0;
      });
    return c?.id ?? null;
  });
  expect(id, "visible GL canvas").not.toBeNull();
  const box = await page.locator(`#${id}`).boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

// ─────────────────────────────────────────────────────────────────────────────
// P-1 · kicadCollabFitViewport wedges after the page's first committed edit
// ─────────────────────────────────────────────────────────────────────────────
test.describe("P-1 FitViewport after first edit", () => {
  test("fit still lands after a committed rotate (embind commit)", async ({ page, testLogger }) => {
    await bootCollab(page);

    const a = { cx: 120e6, cy: 90e6, hw: 40e6, hh: 30e6 };
    const b = { cx: 60e6, cy: 140e6, hw: 20e6, hh: 15e6 };
    expect(await fitLands(page, a), "fit BEFORE any edit lands").toBe(true);

    const rot0 = await fpRotation(page, FP1);
    await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestRotateItem(id, 90), FP1);
    await expect.poll(() => fpRotation(page, FP1), { timeout: 10000 }).not.toBe(rot0);
    console.log(`[PROBE P-1] rotation ${rot0} → ${await fpRotation(page, FP1)}`);

    const landed = await fitLands(page, b);
    console.log(`[PROBE P-1] fit AFTER embind-commit rotate landed: ${landed} vp=${JSON.stringify(await getVp(page))}`);
    expect(hasTrap(testLogger)).toEqual([]);
    expect(landed, "P-1: fit after the first committed edit must still move the camera").toBe(true);
  });

  test("fit still lands after a keyboard rotate of a selected footprint", async ({ page, testLogger }) => {
    await bootCollab(page);

    const a = { cx: FP1_AT.x, cy: FP1_AT.y, hw: 20e6, hh: 15e6 };
    expect(await fitLands(page, a), "fit BEFORE any edit lands").toBe(true);

    // Click the part (real input, so keyboard focus is where a user's would be), then `r`.
    const box = await glCanvasBox(page);
    const vp = await getVp(page);
    const sx = box.x + (FP1_AT.x - vp.cx) * vp.scale + vp.w / 2;
    const sy = box.y + (FP1_AT.y - vp.cy) * vp.scale + vp.h / 2;
    await page.mouse.move(sx, sy);
    await page.waitForTimeout(300); // eslint-disable-line -- pointer-move dwell
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300); // eslint-disable-line -- selection dwell
    const sel = await page.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()));
    console.log(`[PROBE P-1] selection after click: ${JSON.stringify(sel)} activeElement=${await page.evaluate(() => document.activeElement?.tagName)}`);
    if (!sel.length) {
      await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestSelectByUuid(id), FP1);
    }
    const rot0 = await fpRotation(page, FP1);
    await page.keyboard.press("r");
    const rotated = await expect.poll(() => fpRotation(page, FP1), { timeout: 8000 }).not.toBe(rot0)
      .then(() => true, () => false);
    console.log(`[PROBE P-1] keyboard rotate applied: ${rotated} (${rot0} → ${await fpRotation(page, FP1)})`);
    await page.keyboard.press("Escape");

    const b = { cx: 60e6, cy: 140e6, hw: 20e6, hh: 15e6 };
    const landed = await fitLands(page, b);
    console.log(`[PROBE P-1] fit AFTER keyboard rotate landed: ${landed} vp=${JSON.stringify(await getVp(page))}`);
    expect(hasTrap(testLogger)).toEqual([]);
    expect(rotated, "keyboard `r` rotated the selected footprint (precondition)").toBe(true);
    expect(landed, "P-1: fit after a keyboard rotate must still move the camera").toBe(true);
  });
});

test.describe("P-1 apply-queue poisoning", () => {
  // Candidate mechanism: runOnCoroutine is a single-slot FIFO whose `done` flag is set
  // only when the body returns normally. A JS exception thrown from a wire callback
  // (EM_ASM inside flushDiff) unwinds the body → busy forever → every later fit no-ops.
  test("fit still lands after a JS wire callback throws during flushDiff", async ({ page, testLogger }) => {
    await bootCollab(page);
    expect(await fitLands(page, { cx: 120e6, cy: 90e6, hw: 40e6, hh: 30e6 })).toBe(true);
    await page.evaluate(() => {
      const w = window as unknown as { kicadCollab?: Record<string, unknown> };
      w.kicadCollab = { ...(w.kicadCollab ?? {}),
        onItems: () => { throw new Error("P-1 probe: onItems throws"); },
        onDelta: () => { throw new Error("P-1 probe: onDelta throws"); } };
    });
    const rot0 = await fpRotation(page, FP1);
    await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestRotateItem(id, 90), FP1);
    await expect.poll(() => fpRotation(page, FP1), { timeout: 10000 }).not.toBe(rot0);
    await page.waitForTimeout(1000); // eslint-disable-line -- let the flush run
    const landed = await fitLands(page, { cx: 60e6, cy: 140e6, hw: 20e6, hh: 15e6 });
    const errs = testLogger.errors.filter((e) => e.includes("P-1 probe"));
    // Apply-slot probe (added with the P-1 hardening): a wedge reads busy=true with a growing
    // queue; a healthy slot is idle once the fit landed.
    const state = await page.evaluate(() => {
      const m = (window as unknown as { Module: { kicadCollabTestApplyQueueState?: () => string } }).Module;
      return m.kicadCollabTestApplyQueueState ? JSON.parse(m.kicadCollabTestApplyQueueState()) : null;
    });
    console.log(`[PROBE P-1c] callback threw: ${errs.length > 0}; fit after landed: ${landed}; applyQueue=${JSON.stringify(state)}`);
    expect(hasTrap(testLogger)).toEqual([]);
    expect(landed, "P-1: a throwing JS wire callback must not wedge the apply queue").toBe(true);
    if (state) expect(state.busy, "apply slot idle after the edit + fit").toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-2 · reference text steals the click at wide zoom
// ─────────────────────────────────────────────────────────────────────────────
test.describe("P-2 click-to-select a footprint across zoom levels", () => {
  test("clicking the part origin selects the footprint from 10 mm to 150 mm half-width", async ({ page, testLogger }) => {
    await bootCollab(page);
    const box = await glCanvasBox(page);
    const results: Array<{ hw: number; sel: string[]; pxPerMm: number }> = [];

    for (const hwMm of [10, 20, 40, 80, 150]) {
      await page.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());
      const t = { cx: FP1_AT.x, cy: FP1_AT.y, hw: hwMm * 1e6, hh: hwMm * 0.75e6 };
      expect(await fitLands(page, t), `fit ${hwMm}mm lands`).toBe(true);
      const vp = await getVp(page);
      const sx = box.x + (FP1_AT.x - vp.cx) * vp.scale + vp.w / 2;
      const sy = box.y + (FP1_AT.y - vp.cy) * vp.scale + vp.h / 2;
      await page.mouse.move(sx, sy);
      await page.waitForTimeout(300); // eslint-disable-line -- pointer-move dwell
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400); // eslint-disable-line -- selection dwell
      const sel: string[] = await page.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()));
      results.push({ hw: hwMm, sel, pxPerMm: vp.scale * 1e6 });
      console.log(`[PROBE P-2] hw=${hwMm}mm px/mm=${(vp.scale * 1e6).toFixed(2)} click=(${sx.toFixed(0)},${sy.toFixed(0)}) sel=${JSON.stringify(sel)}`);
      await page.keyboard.press("Escape");
    }

    expect(hasTrap(testLogger)).toEqual([]);
    const wrong = results.filter((r) => !(r.sel.length === 1 && r.sel[0] === FP1));
    expect(wrong, "P-2: every framing must select the footprint itself (not its text child)").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-5 · a footprint FIELD blobbed standalone yields an item-less board envelope
// ─────────────────────────────────────────────────────────────────────────────
test.describe("P-5 liftBlob gap", () => {
  test("blobForItem on a PCB_FIELD must not emit a bare (kicad_pcb …) envelope", async ({ page, testLogger }) => {
    await bootCollab(page);
    const blob = await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestItemBlob(id), FP1_REF);
    console.log(`[PROBE P-5] field blob (${blob.length} bytes): ${blob.slice(0, 200).replace(/\n/g, " ")}`);
    expect(hasTrap(testLogger)).toEqual([]);
    // Either lifted to the parent footprint (contains the property) or refused (empty) —
    // never a hollow board envelope that carries no uuid-bearing item.
    const hollow = blob.includes("(kicad_pcb") && !blob.includes("(footprint") && !blob.includes("(property");
    expect(hollow, "P-5: hollow envelope emitted for a standalone field").toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-3 · `m` move wedges after its first use (pcbnew.html, real input)
// ─────────────────────────────────────────────────────────────────────────────
type SnapItem = { id: string; type: string; x: number; y: number };

async function snapshotItems(page: Page): Promise<SnapItem[]> {
  return page.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabSnapshot()).added);
}
async function getPos(page: Page, id: string) {
  const raw = await page.evaluate((i) => (window as unknown as W).Module.kicadCollabGetPos(i), id);
  const [x, y] = raw.split(",").map(Number);
  return { x, y };
}

async function moveWithM(page: Page, at: { x: number; y: number }, nudges: number) {
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell
  await page.keyboard.press("m");
  await page.waitForTimeout(400); // eslint-disable-line -- documented interaction dwell
  for (let i = 0; i < nudges; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150); // eslint-disable-line -- documented interaction dwell
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500); // eslint-disable-line -- documented interaction dwell
}

test.describe("P-3 `m` move twice per page", () => {
  test("the second `m` move works too", async ({ page, testLogger }) => {
    await page.goto("/kicad/pcbnew.html");
    await waitForEditorReady(page);
    await page.waitForFunction(() => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return typeof m?.kicadCollabSnapshot === "function" && typeof m?.kicadCollabGetPos === "function";
    }, null, { timeout: 30000 });
    await page.waitForFunction(() =>
      !!window.wxElementRegistry?.findAllRendered
        && window.wxElementRegistry.findAllRendered({ elementType: "tool" }).some((t) => t.tooltip?.includes("Draw Lines")),
      null, { timeout: 15000 });

    const idsBefore = new Set((await snapshotItems(page)).map((i) => i.id));
    expect(await clickByTooltip(page, "Draw Lines", { elementType: "tool" })).toBe(true);
    await expect.poll(async () => ((await findByTooltip(page, "Draw Lines", { elementType: "tool" }))?.label ?? "").includes("[checked]"),
      { timeout: 5000 }).toBe(true);

    const gl = await glCanvasBox(page);
    const p0 = { x: Math.round(gl.x + gl.width * 0.35), y: Math.round(gl.y + gl.height * 0.45) };
    const p1 = { x: Math.round(gl.x + gl.width * 0.55), y: Math.round(gl.y + gl.height * 0.45) };
    const mid = { x: Math.round((p0.x + p1.x) / 2), y: p0.y };
    for (const p of [p0, p1]) {
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(350); // eslint-disable-line -- documented interaction dwell
    }
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await snapshotItems(page)).filter((i) => !idsBefore.has(i.id)).length,
      { timeout: 8000, intervals: [200] }).toBe(1);
    const id = (await snapshotItems(page)).find((i) => !idsBefore.has(i.id))!.id;

    const pos0 = await getPos(page, id);
    await moveWithM(page, mid, 10);
    const pos1 = await getPos(page, id);
    const dx1 = pos1.x - pos0.x;
    // The item moved right; its midpoint on screen moved by dx1 world → recompute via the viewport.
    const vp = await getVp(page);
    const mid2 = { x: Math.round(mid.x + dx1 * vp.scale), y: mid.y };
    await moveWithM(page, mid2, 10);
    const pos2 = await getPos(page, id);
    const dx2 = pos2.x - pos1.x;
    console.log(`[PROBE P-3] first m: dx=${dx1}; second m: dx=${dx2} (pos0=${JSON.stringify(pos0)} pos1=${JSON.stringify(pos1)} pos2=${JSON.stringify(pos2)})`);

    expect(hasTrap(testLogger)).toEqual([]);
    expect(dx1, "first `m` move works (precondition, issue #9)").toBeGreaterThan(0);
    expect(dx2, "P-3: the second `m` move on the same page must work too").toBeGreaterThan(0);
  });
});

test.describe("P-3 `m` move twice on a TRACK", () => {
  test("the second `m` move of a track works too", async ({ page, testLogger }) => {
    await bootCollab(page);
    const t = { cx: FP1_AT.x, cy: FP1_AT.y, hw: 20e6, hh: 15e6 };
    expect(await fitLands(page, t)).toBe(true);
    const id: string = await page.evaluate(() => (window as unknown as { Module: { kicadCollabTestAddTrack(x1: number, y1: number, x2: number, y2: number, w: number, l: string): string } }).Module
      .kicadCollabTestAddTrack(90e6, 110e6, 110e6, 110e6, 500000, "F.Cu"));
    console.log(`[PROBE P-3b] added track ${id}`);
    await expect.poll(() => getPos(page, id).then((p) => p.x), { timeout: 8000 }).toBeGreaterThan(0);
    const box = await glCanvasBox(page);
    const toScreen = async (wx: number, wy: number) => {
      const vp = await getVp(page);
      return { x: Math.round(box.x + (wx - vp.cx) * vp.scale + vp.w / 2), y: Math.round(box.y + (wy - vp.cy) * vp.scale + vp.h / 2) };
    };
    const pos0 = await getPos(page, id);
    await moveWithM(page, await toScreen(100e6, 110e6), 10);
    const pos1 = await getPos(page, id);
    const dx1 = pos1.x - pos0.x;
    await moveWithM(page, await toScreen(100e6 + dx1, 110e6), 10);
    const pos2 = await getPos(page, id);
    const dx2 = pos2.x - pos1.x;
    console.log(`[PROBE P-3b] track first m: dx=${dx1}; second m: dx=${dx2}`);
    expect(hasTrap(testLogger)).toEqual([]);
    expect(dx1, "first `m` move of a track works (precondition)").toBeGreaterThan(0);
    expect(dx2, "P-3: the second `m` move of a track must work too").toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-4 · `r` on a chooser-held footprint does nothing (placed at rotation 0)
// ─────────────────────────────────────────────────────────────────────────────
const DEMO_DIR = "kicad/demos/ecc83";
const STEM = "ecc83-pp";
const FILTER = "ECC-83-1";

async function synthClick(page: Page, x: number, y: number) {
  await page.evaluate(([cx, cy]) => {
    const c = document.querySelector("#canvas") as HTMLCanvasElement;
    const opt = (b: number) => ({ clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0, buttons: b });
    c.dispatchEvent(new MouseEvent("mousemove", opt(0)));
    c.dispatchEvent(new MouseEvent("mousedown", opt(1)));
    c.dispatchEvent(new MouseEvent("mouseup", opt(0)));
    c.dispatchEvent(new MouseEvent("click", opt(0)));
  }, [x, y]);
}
const frameCount = (page: Page) => page.evaluate(() =>
  (window.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) => /Frame$/.test(e.typeName || "")).length);
const listIds = (page: Page): Promise<string[]> => page.evaluate(() => {
  try { return JSON.parse((window as unknown as W).Module.kicadCollabTestListItems(100000)); } catch { return []; }
});

test.describe("P-4 rotate a chooser-held footprint", () => {
  test("`r` while holding the part from the chooser rotates it before placement", async ({ page, testLogger }) => {
    test.setTimeout(300000);
    await page.goto("/kicad/pcbnew.html");
    await waitForPcbnew(page);
    const root = path.resolve(__dirname, "..", "..");
    for (const f of fs.readdirSync(path.join(root, DEMO_DIR, "footprints.pretty"))) {
      await injectFromSubmodule(page, `${DEMO_DIR}/footprints.pretty/${f}`, `${PROJECT_DIR_MEMFS}/footprints.pretty/${f}`);
    }
    for (const f of ["fp-lib-table", `${STEM}.kicad_pcb`, `${STEM}.kicad_pro`]) {
      await injectFromSubmodule(page, `${DEMO_DIR}/${f}`, `${PROJECT_DIR_MEMFS}/${f}`);
    }
    expect(await clickMenuBarItem(page, "File")).toBe(true);
    await clickMenuItemByText(page, "Open");
    await waitUntil(page, () => {
      const r = window.wxElementRegistry;
      return !!r && r.findAll({ visible: true }).some((el) => el.typeName === "wxTextCtrl" && el.name === "text");
    }, "file dialog filename input");
    const input = await page.evaluate(() => {
      const t = window.wxElementRegistry!.findAll({ visible: true }).find((el) => el.typeName === "wxTextCtrl" && el.name === "text");
      return t ? { x: t.centerX, y: t.centerY } : null;
    });
    await page.mouse.click(input!.x, input!.y);
    await page.waitForTimeout(200); // eslint-disable-line -- dwell
    await page.keyboard.type(`${STEM}.kicad_pcb`);
    await page.waitForTimeout(300); // eslint-disable-line -- dwell
    await page.keyboard.press("Enter");
    await waitForBoardLoaded(page, testLogger, 60000);

    const idsBefore = new Set(await listIds(page));
    const framesBefore = await frameCount(page);
    expect(await clickMenuBarItem(page, "Place")).toBe(true);
    await clickMenuItemByText(page, "Place Footprints");
    const canvas = (await page.locator("#canvas").boundingBox())!;
    const target = { x: Math.round(canvas.width * 0.5), y: Math.round(canvas.height * 0.5) };
    await synthClick(page, target.x, target.y);
    await page.waitForFunction((n) => (window.wxElementRegistry?.findAll({ visible: true }) ?? [])
      .filter((e) => /Frame$/.test(e.typeName || "")).length > n, framesBefore, { timeout: 60000 });

    const inputsOf = () => page.evaluate(() =>
      Array.from(document.querySelectorAll("input.wx-dom-control")).map((i) => i as HTMLInputElement)
        .filter((i) => i.style.display !== "none" && i.getBoundingClientRect().width > 0)
        .map((i) => { const r = i.getBoundingClientRect(); return { value: i.value, x: r.x, y: r.y, w: r.width, h: r.height }; }));
    await expect.poll(async () => (await inputsOf()).length, { timeout: 30000 }).toBeGreaterThan(0);
    const search = (await inputsOf()).reduce((a, b) => (b.y < a.y ? b : a));
    await page.mouse.click(search.x + search.w / 2, search.y + search.h / 2);
    await page.waitForTimeout(200); // eslint-disable-line -- focus dwell
    await page.keyboard.type(FILTER, { delay: 30 });
    await expect.poll(async () => (await inputsOf()).some((i) => i.value.includes(FILTER)), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(1500); // eslint-disable-line -- filter timer dwell
    await page.keyboard.press("Enter");
    const closed = (n: number) => page.waitForFunction((k) => (window.wxElementRegistry?.findAll({ visible: true }) ?? [])
      .filter((e) => /Frame$/.test(e.typeName || "")).length <= k, n, { timeout: 8000 }).then(() => true, () => false);
    let isClosed = await closed(framesBefore);
    console.log(`[PROBE P-4] chooser closed by Enter: ${isClosed} (O-2)`);
    if (!isClosed) {
      const ok = await page.evaluate(() => {
        const b = (window.wxElementRegistry?.findAll({ visible: true }) ?? []).find(
          (e) => /Button/i.test(e.typeName || "") && /^&?ok$/i.test((e.label || "").trim()));
        return b ? { x: b.centerX, y: b.centerY } : null;
      });
      if (!ok) {
        const dump = await page.evaluate(() => (window.wxElementRegistry?.findAll({ visible: true }) ?? [])
          .filter((e) => /Button|Dialog|Frame/i.test(e.typeName || "")).map((e) => `${e.typeName}:${e.name}:${(e.label || "").slice(0, 20)}`));
        console.log(`[PROBE P-4] visible buttons/dialogs: ${JSON.stringify(dump)}`);
      }
      expect(ok, "chooser OK button").not.toBeNull();
      await page.mouse.click(ok!.x, ok!.y);
      isClosed = await closed(framesBefore);
      console.log(`[PROBE P-4] chooser closed by OK: ${isClosed}`);
    }
    expect(isClosed, "chooser closed (precondition)").toBe(true);
    await page.waitForTimeout(1000); // eslint-disable-line -- footprint load dwell

    // Holding the part now. Move the (real) mouse onto the canvas, press `r`, then place.
    const wxFocus = () => page.evaluate(() => {
      const m = (window as unknown as { Module: { kicadTestFocusWindow?: () => string } }).Module;
      return m.kicadTestFocusWindow ? m.kicadTestFocusWindow() : "n/a";
    });
    console.log(`[PROBE P-4] wx focus after chooser closed: ${await wxFocus()}`);
    const active0 = await page.evaluate(() => `${document.activeElement?.tagName}.${(document.activeElement as HTMLElement)?.className}`);
    await page.mouse.move(canvas.x + target.x + 40, canvas.y + target.y + 40);
    await page.waitForTimeout(300); // eslint-disable-line -- pointer dwell
    await page.keyboard.press("r");
    await page.waitForTimeout(400); // eslint-disable-line -- key dwell
    const active1 = await page.evaluate(() => `${document.activeElement?.tagName}.${(document.activeElement as HTMLElement)?.className}`);
    console.log(`[PROBE P-4] activeElement before r: ${active0}; after r: ${active1}; wx focus after r: ${await wxFocus()}`);
    await synthClick(page, target.x + 40, target.y + 40);
    await expect.poll(async () => (await listIds(page)).filter((i) => !idsBefore.has(i)).length, { timeout: 15000 }).toBeGreaterThan(0);
    const newId = (await listIds(page)).find((i) => !idsBefore.has(i))!;
    const rot = await fpRotation(page, newId);
    console.log(`[PROBE P-4] placed ${newId} rotation=${rot}`);

    expect(hasTrap(testLogger)).toEqual([]);
    expect(rot, "P-4: `r` while holding the part must rotate it (placed rotation ≠ 0)").not.toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-2b · real board (ecc83): click every footprint origin at a wide framing
// ─────────────────────────────────────────────────────────────────────────────
test.describe("P-2b ecc83 origin clicks at wide zoom", () => {
  test("clicking each footprint origin at 40/80/150 mm half-width selects the footprint", async ({ page, testLogger }) => {
    test.setTimeout(300000);
    // Informational probe: on a dense board tracks/zones under the origin legitimately win
    // (stock GuessSelectionCandidates) — see group doc P-2, 2026-08-28. Not a gate.
    test.fixme(true, "P-2 probe — stock KiCad candidate priority, informational");
    await page.goto("/kicad/pcbnew.html");
    await waitForPcbnew(page);
    const root = path.resolve(__dirname, "..", "..");
    for (const f of fs.readdirSync(path.join(root, DEMO_DIR, "footprints.pretty"))) {
      await injectFromSubmodule(page, `${DEMO_DIR}/footprints.pretty/${f}`, `${PROJECT_DIR_MEMFS}/footprints.pretty/${f}`);
    }
    for (const f of ["fp-lib-table", `${STEM}.kicad_pcb`, `${STEM}.kicad_pro`]) {
      await injectFromSubmodule(page, `${DEMO_DIR}/${f}`, `${PROJECT_DIR_MEMFS}/${f}`);
    }
    expect(await clickMenuBarItem(page, "File")).toBe(true);
    await clickMenuItemByText(page, "Open");
    await waitUntil(page, () => {
      const r = window.wxElementRegistry;
      return !!r && r.findAll({ visible: true }).some((el) => el.typeName === "wxTextCtrl" && el.name === "text");
    }, "file dialog filename input");
    const input = await page.evaluate(() => {
      const t = window.wxElementRegistry!.findAll({ visible: true }).find((el) => el.typeName === "wxTextCtrl" && el.name === "text");
      return t ? { x: t.centerX, y: t.centerY } : null;
    });
    await page.mouse.click(input!.x, input!.y);
    await page.waitForTimeout(200); // eslint-disable-line -- dwell
    await page.keyboard.type(`${STEM}.kicad_pcb`);
    await page.waitForTimeout(300); // eslint-disable-line -- dwell
    await page.keyboard.press("Enter");
    await waitForBoardLoaded(page, testLogger, 60000);
    await page.waitForFunction(() => typeof (window as unknown as { Module?: Partial<Mod> }).Module?.kicadCollabFitViewport === "function");
    await page.evaluate(() => (window as unknown as W).Module.kicadCollabPresenceStart());

    const all = await snapshotItems(page);
    const byId = new Map(all.map((i) => [i.id, i as SnapItem & { parent?: string }]));
    const fps: SnapItem[] = all.filter((i) => /footprint/i.test(i.type));
    console.log(`[PROBE P-2b] ${fps.length} footprints: ${JSON.stringify(fps.slice(0, 3))}`);
    const box = await glCanvasBox(page);
    const wrong: string[] = [];
    for (const hwMm of [40, 80, 150]) {
      for (const fp of fps) {
        await page.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());
        expect(await fitLands(page, { cx: fp.x, cy: fp.y, hw: hwMm * 1e6, hh: hwMm * 0.75e6 })).toBe(true);
        const vp = await getVp(page);
        const sx = box.x + (fp.x - vp.cx) * vp.scale + vp.w / 2;
        const sy = box.y + (fp.y - vp.cy) * vp.scale + vp.h / 2;
        await page.mouse.move(sx, sy);
        await page.waitForTimeout(250); // eslint-disable-line -- pointer dwell
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(350); // eslint-disable-line -- selection dwell
        const sel: string[] = await page.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()));
        const ok = sel.length === 1 && sel[0] === fp.id;
        const desc = sel.map((s) => { const it = byId.get(s); return it ? `${it.type}${it.parent === fp.id ? "(own child)" : it.parent ? "(child of other)" : ""}` : `?${s.slice(-6)}`; });
        console.log(`[PROBE P-2b] hw=${hwMm}mm fp=…${fp.id.slice(-6)} px/mm=${(vp.scale * 1e6).toFixed(2)} sel=${JSON.stringify(desc)} ${ok ? "OK" : "WRONG"}`);
        if (!ok) wrong.push(`${hwMm}mm:…${fp.id.slice(-6)}→${desc.join(",")}`);
        await page.keyboard.press("Escape");
      }
    }
    expect(hasTrap(testLogger)).toEqual([]);
    expect(wrong, "P-2: every footprint origin click must select that footprint").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-2c · the ledger's own board (tests/fixtures/demo): origin clicks, own-child hits
// ─────────────────────────────────────────────────────────────────────────────
test.describe("P-2c demo fixture origin clicks", () => {
  test("footprint origin clicks on demo.kicad_pcb at 20/40/80/150 mm", async ({ page, testLogger }) => {
    test.setTimeout(300000);
    // Informational probe (6/60 own-child hits, all stock hit-slop behaviour) — see group doc P-2.
    test.fixme(true, "P-2 probe — stock KiCad candidate priority, informational");
    const content = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "demo", "demo.kicad_pcb"), "utf-8");
    const firstId = content.match(/\(footprint[^]*?\(uuid "([^"]+)"/)?.[1] ?? FP1;
    await bootCollab(page, content, firstId);
    const all = await snapshotItems(page);
    const byId = new Map(all.map((i) => [i.id, i as SnapItem & { parent?: string }]));
    const fps = all.filter((i) => /footprint/i.test(i.type));
    console.log(`[PROBE P-2c] ${fps.length} footprints, ${all.length} items`);
    const box = await glCanvasBox(page);
    const tally: Record<string, number> = {};
    const ownChild: string[] = [];
    for (const hwMm of [20, 40, 80, 150]) {
      for (const fp of fps) {
        await page.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());
        expect(await fitLands(page, { cx: fp.x, cy: fp.y, hw: hwMm * 1e6, hh: hwMm * 0.75e6 })).toBe(true);
        const vp = await getVp(page);
        const sx = box.x + (fp.x - vp.cx) * vp.scale + vp.w / 2;
        const sy = box.y + (fp.y - vp.cy) * vp.scale + vp.h / 2;
        await page.mouse.move(sx, sy);
        await page.waitForTimeout(250); // eslint-disable-line -- pointer dwell
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(350); // eslint-disable-line -- selection dwell
        const sel: string[] = await page.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()));
        const kind = sel.length === 0 ? "none" : sel.length > 1 ? "multi" : sel[0] === fp.id ? "footprint" :
          (byId.get(sel[0])?.parent === fp.id ? `own-child:${byId.get(sel[0])?.type}` : `other:${byId.get(sel[0])?.type ?? "?"}`);
        tally[`${hwMm}mm:${kind}`] = (tally[`${hwMm}mm:${kind}`] ?? 0) + 1;
        if (kind.startsWith("own-child")) ownChild.push(`${hwMm}mm:${fp.id.slice(-6)}`);
        await page.keyboard.press("Escape");
      }
    }
    console.log(`[PROBE P-2c] tally=${JSON.stringify(tally)} ownChild=${JSON.stringify(ownChild)}`);
    expect(hasTrap(testLogger)).toEqual([]);
    expect(ownChild, "P-2: a footprint's own text child must not win the origin click").toEqual([]);
  });
});
