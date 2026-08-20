import { test, expect, type Browser, type Page } from '@playwright/test';
import { openOverlayMenu } from './overlay-menu';
import { shotPath } from '../e2e/utils/element-tracker';

// Viewer + writer pages boot once in beforeAll and the tests are ordered
// (the read-only viewer must join the fresh room FIRST). Serial group:
// fullyParallel would re-boot both pages for every test.
test.describe.configure({ mode: 'serial' });

/**
 * Read-only viewer e2e (read-only-viewer): `?readonly=1` boots the pcbnew
 * editor as a locked viewer — chrome force-hidden with no toggle, the
 * Cmd/Ctrl+\ chord inert, selection alive for INSPECTION (viewer-panels) but
 * nothing editable through the REAL input paths (the kicad PCBJAM_READ_ONLY
 * gates), zoom/pan alive — while a writer tab on the same board
 * (broadcastchannel room) stays fully editable.
 *
 * The viewer boots FIRST on the fresh room (fresh browser context ⇒ empty
 * broadcastchannel room): a read-only binding must not seed it; the writer
 * then file-seeds as the first author, exactly like production where the
 * viewer's server connection is read-only (enforced in the closed repo).
 *
 * Boots once (beforeAll) and runs over the shared pages — the config is
 * workers:1 / fullyParallel:false, so file order holds.
 */

const SCOPE = 'default';
const FRONTEND_URL = process.env.WEB_APP_URL ?? 'http://localhost:3048';

type Mod = {
  kicadCollabGetSelection(): string;
  kicadCollabGetViewport(): string;
  kicadCollabTestSelectFirst(): string;
  kicadCollabTestClearSelection(): boolean;
  kicadCollabGetPos(id: string): string;
  kicadCollabTestMoveFirst(dx: number, dy: number): string;
  // Layer bridge (viewer-panels).
  kicadLayersGetState(): string;
  kicadLayersSetVisible(id: number, visible: boolean): boolean | Promise<boolean>;
  kicadLayersSetActive(id: number): boolean | Promise<boolean>;
};
type W = { Module: Mod };

let viewer: Page;
let writer: Page;

async function bootBoard(page: Page, params: string, user: string): Promise<void> {
  await page.goto(`/${SCOPE}/projects/demo/demo.kicad_pcb?user=${user}${params}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 180000 });
  await expect
    .poll(() => page.title(), {
      message: `${user}: board editor never reached the expected title`,
      timeout: 120000,
      intervals: [1000],
    })
    .toMatch(/demo — PCB Editor/i);
  // Loading overlays (boot + lib fat-load, both `inset-0 z-30`) gone before
  // geometry/selection is trusted.
  await expect(page.locator('div.inset-0.z-30')).toHaveCount(0, { timeout: 180000 });
}

/** Count of visible menubar titles (0 ⇒ menubar hidden) — chrome-toggle.spec.ts. */
async function visibleMenuTitles(pg: Page): Promise<number> {
  return pg.evaluate(
    () =>
      Array.from(document.querySelectorAll('.wx-menu-title')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
      }).length,
  );
}

/**
 * Map a world position ("x,y" internal units, kicadCollabGetPos) to CSS pixels
 * through the page's live GAL viewport — the same mapping the comment pins
 * render through (comments-viewport-resize.spec.ts).
 */
async function screenPosOf(pg: Page, worldCsv: string): Promise<{ x: number; y: number }> {
  return pg.evaluate((csv: string) => {
    const win = window as unknown as W;
    const [wx, wy] = csv.split(',').map(Number);
    const vp = JSON.parse(win.Module.kicadCollabGetViewport()) as {
      cx: number; cy: number; scale: number; w: number; h: number;
    };
    const gl = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
      const r = (c as HTMLElement).getBoundingClientRect();
      return getComputedStyle(c as HTMLElement).display !== 'none' && r.width > 0;
    }) as HTMLElement;
    const r = gl.getBoundingClientRect();
    const ratio = r.width / vp.w;
    return {
      x: r.x + ((wx - vp.cx) * vp.scale + vp.w / 2) * ratio,
      y: r.y + ((wy - vp.cy) * vp.scale + vp.h / 2) * ratio,
    };
  }, worldCsv);
}

const selection = (pg: Page) =>
  pg.evaluate(() => JSON.parse((window as unknown as W).Module.kicadCollabGetSelection()));
const posOf = (pg: Page, id: string) =>
  pg.evaluate((i: string) => (window as unknown as W).Module.kicadCollabGetPos(i), id);
// Zoom probe: w/h are the fixed canvas pixel size — zoom moves `scale`.
const viewportScale = (pg: Page) =>
  pg.evaluate(
    () =>
      (JSON.parse((window as unknown as W).Module.kicadCollabGetViewport()) as { scale: number })
        .scale,
  );

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(480_000); // two full board boots
  const ctx = await browser.newContext({ baseURL: FRONTEND_URL });
  // Viewer FIRST: an empty room a read-only binding must NOT seed.
  viewer = await ctx.newPage();
  await bootBoard(viewer, '&readonly=1', 'viewer');
  // Writer second: file-seeds the room the viewer left untouched.
  writer = await ctx.newPage();
  await bootBoard(writer, '', 'writer');
});

test.afterAll(async () => {
  await writer?.close();
  await viewer?.close();
});

test('viewer boots locked: chrome-less, selection inspect-only, hotkey edits inert, zoom alive', async () => {
  test.setTimeout(240_000);

  // Chrome force-hidden: no menubar, no console footer, no toggle — the
  // "View only" pill is the one read-only affordance; Ctrl+\ stays inert.
  await expect.poll(() => visibleMenuTitles(viewer), { timeout: 15000 }).toBe(0);
  await expect(viewer.getByText(/console \(/)).toHaveCount(0);
  // The pill + (absent) chrome toggle live inside the overlay menu (0010).
  await openOverlayMenu(viewer);
  await expect(viewer.locator('[data-testid="chrome-toggle"]')).toHaveCount(0);
  await expect(viewer.getByTestId('view-only-pill')).toBeVisible();
  await viewer.keyboard.press('Control+\\');
  // Bounded settle via a real round-trip (no blind sleep): the canvas keeps
  // its full-bleed width through the keypress.
  const vp = viewer.viewportSize()!;
  const glWidth = () =>
    viewer.evaluate(() => {
      const gl = Array.from(document.querySelectorAll('[id^="glcanvas-"]')).find((c) => {
        const r = (c as HTMLElement).getBoundingClientRect();
        return getComputedStyle(c as HTMLElement).display !== 'none' && r.width > 0;
      }) as HTMLElement | undefined;
      return gl ? gl.getBoundingClientRect().width : 0;
    });
  await expect.poll(glWidth, { timeout: 15000 }).toBeGreaterThan(vp.width * 0.95);
  expect(await visibleMenuTitles(viewer)).toBe(0);

  // The writer beside it keeps the full UI (positive control for the above).
  await openOverlayMenu(writer);
  await expect(writer.locator('[data-testid="chrome-toggle"]')).toBeVisible();
  await expect(writer.getByTestId('view-only-pill')).toHaveCount(0);

  // Viewer-panels boot defaults: both panels come up OPEN as COLLAPSED
  // headers (inspector anchored top-LEFT, layers top-right) — then close
  // them so the click probes below can't land on a header. The panels test
  // re-opens them through the overlay-menu toggles. First close the still-
  // open overlay menu (z-50) — it covers the layers header's close button.
  await viewer.getByTestId('overlay-menu-fab').click();
  await expect(viewer.getByTestId('overlay-menu-panel')).toHaveCount(0);
  await expect(viewer.getByTestId('layers-panel')).toBeVisible();
  await expect(viewer.getByTestId('inspector-panel')).toBeVisible();
  await expect(viewer.getByTestId('layers-panel-list')).toHaveCount(0);
  await expect(viewer.getByTestId('inspector-panel-list')).toHaveCount(0);
  const inspectorBox = (await viewer.getByTestId('inspector-panel').boundingBox())!;
  expect(inspectorBox.x, 'inspector defaults to the top-left').toBeLessThan(100);
  expect(inspectorBox.y, 'inspector defaults to the top-left').toBeLessThan(60);
  await viewer.getByTestId('layers-panel-close').click();
  await viewer.getByTestId('inspector-panel-close').click();
  await expect(viewer.getByTestId('layers-panel')).toHaveCount(0);
  await expect(viewer.getByTestId('inspector-panel')).toHaveCount(0);

  // No presence/comments surfaces for a viewer.
  await expect(viewer.locator('[data-testid="presence-roster"]')).toHaveCount(0);
  expect(
    await viewer.evaluate(
      () => '__pcbjamComments' in (window as unknown as Record<string, unknown>),
    ),
  ).toBe(false);

  // ── the kicad gates, probed through the REAL paths ─────────────────────────
  // A known item + its world position (the test hook force-selects on the
  // WRITER — fine there — and is cleared again before the click probes).
  const itemId = await writer.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectFirst(),
  );
  expect(itemId, 'demo board should have a first item').toBeTruthy();
  const itemWorld = await posOf(writer, itemId);
  expect(itemWorld).toContain(',');
  await writer.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());

  // Gate 2 (Selectable): a real canvas click ON the item finds candidates for
  // the writer — a selection, or KiCad's clarify popup when several items
  // overlap ("Show More Choices" is unique to it) — and NOTHING for the
  // viewer: the gate empties the collector, so neither selection nor popup
  // can appear (both boards boot zoom-fit; each page maps through its own
  // live viewport).
  const writerClick = await screenPosOf(writer, itemWorld);
  await writer.mouse.click(writerClick.x, writerClick.y);
  await expect
    .poll(
      async () =>
        (await selection(writer)).length > 0 ||
        (await writer.locator('.wx-menu-popup').count()) > 0,
      {
        timeout: 20000,
        message: "writer's click should select the item or pop the clarify menu",
      },
    )
    .toBe(true);
  await writer.keyboard.press('Escape'); // dismiss a clarify popup, drop any selection
  await writer.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());

  // Selection is LIVE for viewers (viewer-panels): the same real click that
  // selects for the writer selects for the viewer too (or pops the clarify
  // list when several items overlap) — the inspector panel consumes it.
  // Everything downstream of the selection stays locked (probed below).
  const viewerClick = await screenPosOf(viewer, itemWorld);
  await viewer.mouse.click(viewerClick.x, viewerClick.y);
  await expect
    .poll(
      async () =>
        (await selection(viewer)).length > 0 ||
        (await viewer.locator('.wx-menu-popup').count()) > 0,
      {
        timeout: 20000,
        message: "viewer's click should select the item or pop the clarify menu",
      },
    )
    .toBe(true);
  await viewer.keyboard.press('Escape'); // dismiss a clarify popup, drop the selection
  await viewer.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());

  // Right-click: the clarify (disambiguation) list stays ALLOWED for viewers
  // — it is pure selection — but the CONTEXT menu that follows a resolved
  // right-click must NOT open (it offers edit entries the action gate
  // silently swallows). Positive control first: the writer's right-click
  // (clarify entry 1 if ambiguous) opens the context menu.
  // All popup probes scope to `.wx-menu-popup` — the hidden wx chrome keeps
  // e.g. a "Properties" pane caption in the DOM, so a bare getByText count
  // would false-positive on both pages.
  const popupWithProperties = (pg: Page) =>
    pg.locator('.wx-menu-popup').getByText(/Properties/).count();
  // Any open wx popup — the clarify list has numbered rows but only shows
  // "Show More Choices" when the collector held extra candidates, so the
  // text is NOT a reliable marker.
  const clarifyOpen = (pg: Page) =>
    pg.locator('.wx-menu-popup').count();

  await writer.mouse.click(writerClick.x, writerClick.y, { button: 'right' });
  await expect
    .poll(
      async () => (await clarifyOpen(writer)) > 0 || (await popupWithProperties(writer)) > 0,
      { timeout: 20000, message: "writer's right-click should open a menu" },
    )
    .toBe(true);
  if ((await clarifyOpen(writer)) > 0 && (await popupWithProperties(writer)) === 0) {
    await writer.locator('.wx-menu-popup > div').filter({ hasText: /^\s*1\s/ }).first().click(); // choose clarify entry 1
  }
  await expect
    .poll(() => popupWithProperties(writer), {
      timeout: 20000,
      message: "writer's resolved right-click should open the context menu",
    })
    .toBeGreaterThan(0);
  await writer.keyboard.press('Escape');
  await writer.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());

  // Viewer, same gesture: the clarify list may resolve the selection, but
  // no context menu follows — no popup remains (or reopens) after the choice.
  await viewer.mouse.click(viewerClick.x, viewerClick.y, { button: 'right' });
  await expect
    .poll(
      async () => (await clarifyOpen(viewer)) > 0 || (await selection(viewer)).length > 0,
      { timeout: 20000, message: "viewer's right-click should reach selection" },
    )
    .toBe(true);
  if ((await clarifyOpen(viewer)) > 0) {
    await viewer.locator('.wx-menu-popup > div').filter({ hasText: /^\s*1\s/ }).first().click(); // choose clarify entry 1
  }
  // Documented interaction dwell: the context menu would open within a frame
  // or two of the resolved selection — give it time, then assert it didn't.
  await viewer.waitForTimeout(800); // dwell
  await expect(viewer.locator('.wx-menu-popup')).toHaveCount(0);
  await viewer.keyboard.press('Escape');
  await viewer.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());

  // Gate 1 (action allowlist): even with an item force-selected through the
  // test hook (AddItemToSel bypasses Selectable by design), the Delete hotkey
  // is swallowed — the item survives on the viewer's own board.
  const forced = await viewer.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectFirst(),
  );
  // SelectFirst's iteration order is NOT stable across separately-booted tabs
  // (CI: writer and viewer picked different first items from the same file) —
  // the gate only needs SOME force-selected item to survive the Delete below.
  expect(forced, 'viewer force-select landed an item').toBeTruthy();
  const posBefore = await posOf(viewer, forced);
  expect(posBefore).toBeTruthy();
  await viewer.keyboard.press('Delete');
  // Documented interaction dwell: a hotkey delete commits within a frame or
  // two and has no observable on the swallowed path — give it time to have
  // acted if it were going to, then assert nothing happened.
  await viewer.waitForTimeout(800); // dwell
  expect(await posOf(viewer, forced), 'Delete must be swallowed in read-only').toBe(posBefore);

  // Zoom stays alive on the viewer (wheel over the canvas changes the scale).
  const canvasBox = (await viewer.locator('#canvas').boundingBox())!;
  const scaleBefore = await viewportScale(viewer);
  await viewer.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await viewer.mouse.wheel(0, -240);
  await expect.poll(() => viewportScale(viewer), { timeout: 15000 }).not.toBe(scaleBefore);

  await viewer.screenshot({ path: shotPath(viewer, 'web-read-only-viewer.png'), scale: 'css' });
});

test("a writer's edits stream into the viewer live (and never the reverse)", async () => {
  // Blocked by a PRE-EXISTING applyItems regression at kicad 8364527: the
  // board-envelope wrap trips "1 is not a valid layer count" in the clipboard
  // parser, so NO cross-tab item apply lands — verified failing identically
  // for two fully WRITABLE tabs on a fresh kicad_editor build (the previous
  // CI artifacts were built at an older kicad rev). Un-fixme once the
  // envelope/parser mismatch is fixed on main.
  // fixme removed 2026-08-13: passes on the JSPI build (both engines):

  const itemId = await writer.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectFirst(),
  );
  await writer.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());
  const posBefore = await posOf(viewer, itemId);

  // 2 mm — small nudges vanish in s-expr formatting (see ysync-two-tab.spec.ts).
  const moved = await writer.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestMoveFirst(2_000_000, 0),
  );
  expect(moved).toBe(itemId);
  await expect
    .poll(() => posOf(viewer, itemId), {
      timeout: 20000,
      message: "the writer's move never reached the viewer",
    })
    .not.toBe(posBefore);
  // The viewer's board still matches the writer's (nothing flowed back).
  expect(await posOf(writer, itemId)).toBe(await posOf(viewer, itemId));
});

test('viewer panels: layer selector + selection inspector (viewer-panels)', async () => {
  test.setTimeout(240_000);

  const layersState = () =>
    viewer.evaluate(
      () =>
        JSON.parse((window as unknown as W).Module.kicadLayersGetState()) as {
          active: number;
          layers: Array<{ id: number; name: string; copper: boolean; visible: boolean }>;
        },
    );

  // ── layer panel ────────────────────────────────────────────────────────────
  await openOverlayMenu(viewer);
  await viewer.getByTestId('layers-panel-toggle').click();
  await expect(viewer.getByTestId('layers-panel')).toBeVisible();
  // Close the overlay menu (z-50) — it overlaps the panel's default anchor
  // and would swallow the row clicks below.
  await viewer.keyboard.press('Escape');
  await expect(viewer.getByTestId('overlay-menu-panel')).toHaveCount(0);
  // Reopened panels keep the read-only default: collapsed — expand.
  await viewer.getByTestId('layers-panel-collapse').click();
  await expect(viewer.getByTestId('layers-panel-list')).toBeVisible();
  await expect(viewer.locator('[data-testid="layer-row"]').first()).toBeVisible();

  const st0 = await layersState();
  expect(st0.layers.length, 'bridge lists the enabled layers').toBeGreaterThan(0);
  const copper = st0.layers.filter((l) => l.copper);
  expect(copper.length, 'demo board has F.Cu + B.Cu').toBeGreaterThanOrEqual(2);
  const target = copper.find((l) => l.id !== st0.active) ?? copper[0]!;
  const row = viewer.locator(`[data-testid="layer-row"][data-layer-id="${target.id}"]`);

  // Eye toggle hides/shows the layer — confirmed through the bridge (the
  // apply runs on the wasm coroutine; the panel updates from the C++ push).
  await row.getByTestId('layer-visibility').click();
  await expect
    .poll(async () => (await layersState()).layers.find((l) => l.id === target.id)?.visible, {
      timeout: 15000,
      message: 'eye toggle should hide the layer',
    })
    .toBe(false);
  await row.getByTestId('layer-visibility').click();
  await expect
    .poll(async () => (await layersState()).layers.find((l) => l.id === target.id)?.visible, {
      timeout: 15000,
      message: 'second toggle should show the layer again',
    })
    .toBe(true);

  // Row click sets the ACTIVE layer.
  await row.getByTestId('layer-activate').click();
  await expect
    .poll(async () => (await layersState()).active, { timeout: 15000 })
    .toBe(target.id);

  // Drag by the header — the shared draggable-panel behavior (position also
  // persists via localStorage, covered by useDraggablePanel's unit tests and
  // the comments panel spec).
  const before = (await viewer.getByTestId('layers-panel').boundingBox())!;
  const hb = (await viewer.getByTestId('layers-panel-header').boundingBox())!;
  await viewer.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await viewer.mouse.down();
  await viewer.mouse.move(hb.x + hb.width / 2 - 120, hb.y + hb.height / 2 + 90, { steps: 5 });
  await viewer.mouse.up();
  const after = (await viewer.getByTestId('layers-panel').boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(-120);
  expect(Math.round(after.y - before.y)).toBe(90);

  // Close it before the canvas click below — a floating panel over the item
  // would swallow the click.
  await viewer.getByTestId('layers-panel-close').click();
  await expect(viewer.getByTestId('layers-panel')).toHaveCount(0);

  // ── selection inspector ────────────────────────────────────────────────────
  // A REAL canvas click selects for the viewer (viewer-panels); the store
  // keeps the selection, so the inspector may open after the click.
  const itemId = await writer.evaluate(() =>
    (window as unknown as W).Module.kicadCollabTestSelectFirst(),
  );
  const itemWorld = await posOf(writer, itemId);
  await writer.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());

  const pt = await screenPosOf(viewer, itemWorld);
  await viewer.mouse.click(pt.x, pt.y);
  await expect
    .poll(
      async () =>
        (await selection(viewer)).length > 0 ||
        (await viewer.locator('.wx-menu-popup').count()) > 0,
      { timeout: 20000, message: 'viewer click should select or pop the clarify list' },
    )
    .toBe(true);
  // Overlapping items popped the clarify list — pick the first entry.
  if ((await viewer.locator('.wx-menu-popup').count()) > 0) {
    await viewer.locator('.wx-menu-popup > div').filter({ hasText: /^\s*1\s/ }).first().click();
    await expect
      .poll(async () => (await selection(viewer)).length, { timeout: 15000 })
      .toBeGreaterThan(0);
  }

  await openOverlayMenu(viewer);
  await viewer.getByTestId('inspector-panel-toggle').click();
  await expect(viewer.getByTestId('inspector-panel')).toBeVisible();
  // Close the covering overlay menu WITHOUT Escape — the allowlisted
  // cancelInteractive would clear the selection the inspector is about to
  // show. The FAB toggle never touches the canvas.
  await viewer.getByTestId('overlay-menu-fab').click();
  await expect(viewer.getByTestId('overlay-menu-panel')).toHaveCount(0);
  // Still collapsed by default — expand (this is a header-button click, it
  // never touches the canvas or the selection).
  await viewer.getByTestId('inspector-panel-collapse').click();
  await expect(viewer.getByTestId('inspector-panel-list')).toBeVisible();
  // The already-made selection renders with real property rows (every item
  // type yields at least one of these labels).
  await expect
    .poll(() => viewer.getByTestId('inspector-item').count(), {
      timeout: 20000,
      message: 'inspector should list the selected item',
    })
    .toBeGreaterThan(0);
  await expect(viewer.getByTestId('inspector-item').first()).toContainText(
    /Position|Start|Net|Layer/,
  );

  await viewer.screenshot({ path: shotPath(viewer, 'web-viewer-panels.png'), scale: 'css' });

  // Close + clear: Esc drops the selection, the inspector empties live.
  await viewer.keyboard.press('Escape');
  await viewer.evaluate(() => (window as unknown as W).Module.kicadCollabTestClearSelection());
  await viewer.getByTestId('inspector-panel-close').click();
  await expect(viewer.getByTestId('inspector-panel')).toHaveCount(0);
});
