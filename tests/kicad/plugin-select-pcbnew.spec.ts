import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Plugin platform `editor.select` — the engine entry point, against the real engine.
 *
 * kicadPluginSelectItems REPLACES the selection on behalf of a plugin. A selection
 * is also a collaborator soft-lock claim whose tiebreak ignores who held the item
 * first, so the entry point must never take an item another client holds; it must
 * refuse while a tool runs; and it must say nothing about who holds what.
 * Locks are seeded through kicadCollabSetRemote like presence-locks-pcbnew.spec.ts.
 */

const SEG1 = "44444444-0000-0000-0000-000000000001";
const FP1 = "66666666-0000-0000-0000-000000000001";
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
\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "${FP1}")
\t\t(at 100 100)
\t\t(attr smd)
\t\t(fp_rect (start -2 -2) (end 2 2) (layer "F.SilkS") (stroke (width 0.3) (type solid)) (uuid "66666666-0000-0000-0000-0000000000cc"))
\t\t(pad "1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 3 3)
\t\t\t(layers "F.Cu")
\t\t\t(uuid "66666666-0000-0000-0000-0000000000dd")
\t\t)
\t)
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG1}"))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabPresenceStart(): void;
  kicadCollabSetRemote(j: string): void;
  kicadCollabGetViewport(): string;
  kicadCollabGetSelection(): string;
  kicadCollabGetPos(id: string): string;
  kicadCollabTestGetLocked(): string;
  kicadPluginSelectItems(uuidsJson: string): string;
  kicadPluginSelectVersion(): number;
};
type LocksWindow = { FS: FS; Module: Mod };
type Reply = { ok: boolean; error?: string; selected?: string[]; held?: string[]; missing?: string[] };

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
        typeof m?.kicadPluginSelectItems === "function"
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
      const p = `${dir}/select.kicad_pcb`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_PCB },
  );

  await expect
    .poll(() => page.title(), { timeout: 60000, intervals: [500] })
    .toMatch(/select/i);

  await page.evaluate(() => {
    (window as unknown as LocksWindow).Module.kicadCollabPresenceStart();
  });
}

/** Seed (or clear) the remote lock set for FP1. */
function setLock(page: Page, locked: boolean): Promise<void> {
  return page.evaluate(
    ({ fp, locked: isLocked }) => {
      const w = window as unknown as LocksWindow;
      w.Module.kicadCollabSetRemote(
        JSON.stringify({
          peers: [],
          locks: isLocked ? [{ uuid: fp, name: "bob" }] : [],
        }),
      );
    },
    { fp: FP1, locked },
  );
}

/** The footprint's current screen position via the exported GAL transform. */
async function fpScreenPos(page: Page): Promise<{ x: number; y: number }> {
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
  expect(glId).toBeTruthy();
  const box = await page.locator(`#${glId}`).boundingBox();
  expect(box).toBeTruthy();

  const { vp, pos } = await page.evaluate(() => {
    const w = window as unknown as LocksWindow;
    return {
      vp: JSON.parse(w.Module.kicadCollabGetViewport()),
      pos: w.Module.kicadCollabGetPos("66666666-0000-0000-0000-000000000001"),
    };
  });
  const [wx, wy] = pos.split(",").map(Number);
  return {
    x: box!.x + (wx - vp.cx) * vp.scale + vp.w / 2,
    y: box!.y + (wy - vp.cy) * vp.scale + vp.h / 2,
  };
}


const GHOST = "99999999-0000-0000-0000-000000000009";

/** Raw engine call: the argument is passed through verbatim so malformed input can be tried. */
const select = (page: Page, raw: string): Promise<{ reply: Reply; text: string }> =>
  page.evaluate((json) => {
    const text = (window as unknown as LocksWindow).Module.kicadPluginSelectItems(json);
    return { reply: JSON.parse(text), text };
  }, raw);
const selection = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (JSON.parse((window as unknown as LocksWindow).Module.kicadCollabGetSelection()) as string[]).sort(),
  );

test("replaces the selection, reports unknown ids, and clears it", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  expect(await page.evaluate(() => (window as unknown as LocksWindow).Module.kicadPluginSelectVersion())).toBe(1);

  expect((await select(page, JSON.stringify([SEG1, FP1, SEG1, GHOST]))).reply).toEqual({
    ok: true, selected: [SEG1, FP1], held: [], missing: [GHOST],
  });
  await expect.poll(() => selection(page)).toEqual([SEG1, FP1].sort());

  // Replace, not add: the footprint drops out.
  expect((await select(page, JSON.stringify([SEG1]))).reply.selected).toEqual([SEG1]);
  await expect.poll(() => selection(page)).toEqual([SEG1]);

  expect((await select(page, "[]")).reply).toEqual({ ok: true, selected: [], held: [], missing: [] });
  await expect.poll(() => selection(page)).toEqual([]);

  expect(hasAbort(testLogger)).toBe(false);
});

test("never takes an item a collaborator holds, and does not say who holds it", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  await setLock(page, true);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as LocksWindow).Module.kicadCollabTestGetLocked()))
    .toContain(FP1);

  const { reply, text } = await select(page, JSON.stringify([FP1, SEG1]));
  expect(reply).toEqual({ ok: true, selected: [SEG1], held: [FP1], missing: [] });
  expect(text).not.toContain("bob");
  await expect.poll(() => selection(page)).toEqual([SEG1]);

  // Asking for nothing but held items leaves the collaborator's item alone and empties the selection.
  expect((await select(page, JSON.stringify([FP1]))).reply).toEqual({ ok: true, selected: [], held: [FP1], missing: [] });
  await expect.poll(() => selection(page)).toEqual([]);

  // Once the collaborator lets go, the same request selects it.
  await setLock(page, false);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as LocksWindow).Module.kicadCollabTestGetLocked()))
    .not.toContain(FP1);
  expect((await select(page, JSON.stringify([FP1]))).reply.selected).toEqual([FP1]);
  await expect.poll(() => selection(page)).toEqual([FP1]);

  expect(hasAbort(testLogger)).toBe(false);
});

test("rejects malformed input without touching the selection", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);
  expect((await select(page, JSON.stringify([SEG1]))).reply.ok).toBe(true);
  await expect.poll(() => selection(page)).toEqual([SEG1]);

  const tooMany = JSON.stringify(Array.from({ length: 501 }, (_, i) => `id-${i}`));
  for (const raw of ["not json", "{}", '"' + SEG1 + '"', "[1]", '[["' + SEG1 + '"]]', JSON.stringify(["x".repeat(65)]), tooMany, ""]) {
    expect((await select(page, raw)).reply, raw.slice(0, 40)).toEqual({ ok: false, error: "INVALID" });
  }
  // A refused call schedules nothing: the earlier selection is still there after a later accepted call settles.
  expect((await select(page, JSON.stringify([SEG1]))).reply.ok).toBe(true);
  await expect.poll(() => selection(page)).toEqual([SEG1]);

  expect(hasAbort(testLogger)).toBe(false);
});

test("is refused while the user has a tool running", async ({ page, testLogger }) => {
  test.setTimeout(240000);
  await bootAndOpen(page);

  // A real click: it selects through the tool AND gives the canvas the keyboard focus the hotkey needs.
  const at = await fpScreenPos(page);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await selection(page)).length, { message: "click never landed a selection" }).toBeGreaterThan(0);
  const held = await selection(page); // the footprint or its pad, depending on zoom

  await page.mouse.move(at.x, at.y);
  await page.keyboard.press("m");
  // The refusal is the observable for "the move tool is armed": poll the call itself, no dwell. Until then
  // the call is accepted and re-selects what is already selected, so polling does not disturb the move.
  await expect
    .poll(async () => (await select(page, JSON.stringify(held))).reply.error ?? "accepted", { timeout: 15000 })
    .toBe("TOOL_ACTIVE");
  // Refused means untouched: asking for something else mid-move changes nothing. (Compare with the
  // selection as the move tool left it: EDIT_TOOL::Move swaps a clicked pad for its parent footprint.)
  const moving = await selection(page);
  expect(moving).not.toContain(SEG1);
  expect((await select(page, JSON.stringify([SEG1]))).reply).toEqual({ ok: false, error: "TOOL_ACTIVE" });
  expect(await selection(page)).toEqual(moving);

  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await select(page, JSON.stringify([SEG1]))).reply.ok, { timeout: 15000 })
    .toBe(true);
  await expect.poll(() => selection(page)).toEqual([SEG1]);

  expect(hasAbort(testLogger)).toBe(false);
});
