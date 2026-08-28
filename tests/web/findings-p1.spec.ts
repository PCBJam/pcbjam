import { test, expect, type Page } from '@playwright/test';

/**
 * Findings P-1 on the REAL standalone (collab-bound): kicadCollabFitViewport
 * must still move the camera after the page's first committed edit.
 * docs/features/findings/groups/P-editor-tools-embind-interaction.md
 */

const SCOPE = 'default';

type Mod = {
  kicadCollabGetViewport(): string;
  kicadCollabFitViewport(cx: number, cy: number, hw: number, hh: number): void;
  kicadCollabSnapshot(): string;
  kicadCollabTestRotateItem(id: string, deg: number): boolean;
  kicadCollabTestItemBlob(id: string): string;
  kicadCollabGetSelection(): string;
};
type W = { Module: Mod };
type Vp = { cx: number; cy: number; scale: number; w: number; h: number };

async function bootBoard(page: Page, user: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect.poll(() => page.title(), { timeout: 120000, intervals: [1000] }).toMatch(/demo — PCB Editor/i);
  await page.waitForFunction(() => {
    const m = (window as unknown as Partial<W>).Module;
    return typeof m?.kicadCollabGetViewport === 'function' && typeof m?.kicadCollabFitViewport === 'function'
      && typeof m?.kicadCollabTestRotateItem === 'function';
  }, null, { timeout: 60000 });
}
const viewport = (page: Page): Promise<Vp> =>
  page.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetViewport()));
async function fitLands(page: Page, t: { cx: number; cy: number; hw: number; hh: number }, timeout = 15000) {
  await page.evaluate((t) => (window as unknown as W).Module.kicadCollabFitViewport(t.cx, t.cy, t.hw, t.hh), t);
  return expect.poll(async () => {
    const vp = await viewport(page);
    return Math.abs(vp.cx - t.cx) < 1e6 && Math.abs(vp.cy - t.cy) < 1e6;
  }, { timeout, intervals: [250] }).toBe(true).then(() => true, () => false);
}
async function rotation(page: Page, id: string): Promise<number | null> {
  const blob = await page.evaluate((i) => (window as unknown as W).Module.kicadCollabTestItemBlob(i), id);
  const m = blob.match(/\(footprint[^]*?\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\)/);
  return m ? (m[3] ? Number(m[3]) : 0) : null;
}
async function firstFootprint(page: Page): Promise<{ id: string; x: number; y: number }> {
  const items: Array<{ id: string; type: string; x: number; y: number }> = await page.evaluate(
    () => JSON.parse((window as unknown as W).Module.kicadCollabSnapshot()).added);
  const fp = items.find((i) => i.type === 'FOOTPRINT');
  if (!fp) throw new Error('no footprint on demo board');
  return fp;
}
async function glBox(page: Page) {
  const id = await page.evaluate(() => Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
    .map((c) => c as HTMLCanvasElement).find((c) => c.getBoundingClientRect().width > 0)?.id ?? null);
  const box = id ? await page.locator(`#${id}`).boundingBox() : await page.locator('#canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  return box;
}

test('P-1 standalone: fit lands after an embind-committed rotate', async ({ page }) => {
  test.setTimeout(300000);
  await bootBoard(page, 'alice');
  const T1 = { cx: 120e6, cy: 90e6, hw: 40e6, hh: 30e6 };
  const T2 = { cx: 180e6, cy: 120e6, hw: 25e6, hh: 20e6 };
  expect(await fitLands(page, T1), 'fit before edit').toBe(true);
  const fp = await firstFootprint(page);
  const r0 = await rotation(page, fp.id);
  await page.evaluate((id) => (window as unknown as W).Module.kicadCollabTestRotateItem(id, 90), fp.id);
  await expect.poll(() => rotation(page, fp.id), { timeout: 15000 }).not.toBe(r0);
  await page.waitForTimeout(1500); // eslint-disable-line -- let flushDiff + ysync run
  const landed = await fitLands(page, T2);
  console.log(`[PROBE P-1 web] embind rotate ${r0}→${await rotation(page, fp.id)}; fit after landed=${landed} vp=${JSON.stringify(await viewport(page))}`);
  expect(landed, 'P-1: fit after first committed edit').toBe(true);
});

test('P-1 standalone: fit lands after a keyboard rotate of a clicked footprint', async ({ page }) => {
  test.setTimeout(300000);
  await bootBoard(page, 'alice');
  const fp = await firstFootprint(page);
  expect(await fitLands(page, { cx: fp.x, cy: fp.y, hw: 15e6, hh: 10e6 }), 'fit before edit').toBe(true);
  // Click-select, re-projected from the LIVE viewport each attempt: on CI the
  // first click after the fit can land before the canvas has re-rendered at
  // the new zoom (selection = []), so poll the real selection, not one click.
  const selection = (): Promise<string[]> =>
    page.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()));
  const clicked = await expect.poll(async () => {
    const box = await glBox(page);
    const vp = await viewport(page);
    const sx = box.x + (fp.x - vp.cx) * vp.scale + vp.w / 2;
    const sy = box.y + (fp.y - vp.cy) * vp.scale + vp.h / 2;
    await page.mouse.move(sx, sy);
    await page.waitForTimeout(300); // eslint-disable-line -- documented interaction dwell (pointer hover before press)
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(400); // eslint-disable-line -- documented interaction dwell (selection tool commit)
    return (await selection()).includes(fp.id);
  }, { timeout: 15000, intervals: [500], message: 'click-select of the first footprint' }).toBe(true)
    .then(() => true, () => false);
  // Hit-testing is not what P-1 is about (the keyboard rotate → flushDiff → fit
  // chain is): on a saturated runner the canvas can lag the viewport for longer
  // than the click budget, so fall back to the selection tool's own entry point.
  if (!clicked) {
    const ok = await page.evaluate(
      (id) => (window as unknown as { Module: { kicadCollabTestSelectByUuid(u: string): boolean } }).Module.kicadCollabTestSelectByUuid(id),
      fp.id,
    );
    expect(ok, 'programmatic select fallback (kicadCollabTestSelectByUuid)').toBe(true);
    await expect.poll(selection, { timeout: 10000, intervals: [250] }).toContain(fp.id);
  }
  const sel = await selection();
  const r0 = await rotation(page, fp.id);
  await page.keyboard.press('r');
  const rotated = await expect.poll(() => rotation(page, fp.id), { timeout: 10000 }).not.toBe(r0).then(() => true, () => false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500); // eslint-disable-line -- let flushDiff + ysync run
  const T2 = { cx: 180e6, cy: 120e6, hw: 25e6, hh: 20e6 };
  const landed = await fitLands(page, T2);
  console.log(`[PROBE P-1 web] click sel=${JSON.stringify(sel)} kb rotate applied=${rotated} (${r0}→${await rotation(page, fp.id)}); fit after landed=${landed} vp=${JSON.stringify(await viewport(page))}`);
  expect(rotated, 'keyboard rotate applied (precondition)').toBe(true);
  expect(landed, 'P-1: fit after keyboard rotate').toBe(true);
});
