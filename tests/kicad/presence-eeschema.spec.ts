import type { Page } from "@playwright/test";
import { settledShot } from "../e2e/utils/element-tracker";
import { test, expect } from "./fixtures";

/**
 * eeschema collab presence — C++ bridge e2e (collab-presence 0003).
 *
 * The eeschema port of presence-pcbnew.spec.ts: selection emit (programmatic +
 * real box-select), throttled cursor emit, remote VIEW_OVERLAY render with no
 * local-selection leak, and the viewport unit band (px-per-IU through the GAL
 * matrix — eeschema IU is 1e4/mm, not pcbnew's 1e6, so only the band differs).
 * The sheet-scoped awareness layer (skeleton states, rebind on navigation) is
 * unit-tested in the standalone (presence.test.ts) — this spec covers the wasm
 * side on the current sheet.
 */

const WIRE1 = "22222222-0000-0000-0000-000000000001";
// version must be the CURRENT schematic format (sch_file_versions.h): an older
// one makes eeschema show the "created by an older version" wxInfoBar, whose
// appearance relayouts the GL panel at a load-dependent moment — permanently
// breaking the overlay tests' before/after pixel equality.
const SAMPLE_SCH = `(kicad_sch
\t(version 20260306)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${WIRE1}"))
\t(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000002"))
\t(sheet_instances (path "/" (page "1")))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabPresenceStart(): void;
  kicadCollabSetRemote(j: string): void;
  kicadCollabGetViewport(): string;
  kicadCollabGetSelection(): string;
  kicadCollabTestGetCrossMapped(): string;
  kicadCollabTestSelectFirst(): string;
  kicadCollabTestClearSelection(): boolean;
};
type PresenceWindow = {
  FS: FS;
  Module: Mod;
  kicadCollab?: Record<string, unknown>;
  __selEmits?: string[][];
  __cursorEmits?: Array<{ x: number; y: number; active: number }>;
};

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

/**
 * The visible GAL draw panel — the pixel-compare target for overlay tests.
 * `#canvas` is the WHOLE wx window; its chrome is not pixel-stable across a
 * test (the "older KiCad version" infobar auto-dismisses, widget carets
 * blink), which made whole-window before/after equality flaky. The presence
 * overlay renders only into the GL panel, so compare exactly that.
 */
async function galPanel(page: Page) {
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
  expect(glId, "no visible GAL panel found").toBeTruthy();
  return page.locator(`#${glId}`);
}

async function bootAndOpen(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Partial<Mod> }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSetRemote === "function" &&
        typeof m?.kicadCollabTestSelectFirst === "function"
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
      const w = window as unknown as PresenceWindow;
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const p = `${dir}/presence.kicad_sch`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_SCH },
  );

  await expect
    .poll(() => page.title(), { timeout: 60000, intervals: [500] })
    .toMatch(/presence/i);

  await page.evaluate(() => {
    const w = window as unknown as PresenceWindow;
    w.__selEmits = [];
    w.__cursorEmits = [];
    w.kicadCollab = {
      ...w.kicadCollab,
      onSelection: (json: string) => w.__selEmits!.push(JSON.parse(json)),
      onCursor: (x: number, y: number, active: number) =>
        w.__cursorEmits!.push({ x, y, active }),
    };
    w.Module.kicadCollabPresenceStart();
  });
}

test("selection emit: programmatic select/clear reaches onSelection with uuids", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  const selectedId = await page.evaluate(() =>
    (window as unknown as PresenceWindow).Module.kicadCollabTestSelectFirst(),
  );
  expect(selectedId).toBeTruthy();

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as PresenceWindow;
          return w.__selEmits!.at(-1) ?? null;
        }),
      { timeout: 10000 },
    )
    .toEqual([selectedId]);

  await page.evaluate(() =>
    (window as unknown as PresenceWindow).Module.kicadCollabTestClearSelection(),
  );
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as PresenceWindow;
          return w.__selEmits!.at(-1) ?? null;
        }),
      { timeout: 10000 },
    )
    .toEqual([]);

  expect(hasAbort(testLogger)).toBe(false);
});

test("selection emit: a real canvas box-select drives the wx-layer trigger", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  const glId = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('[id^="glcanvas-"]'))
      .map((c) => c as HTMLCanvasElement)
      .find((c) => {
        const rect = c.getBoundingClientRect();
        return window.getComputedStyle(c).display !== "none" && rect.width > 0;
      });
    return visible?.id ?? null;
  });
  expect(glId).toBeTruthy();
  const box = await page.locator(`#${glId}`).boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.move(box!.x + box!.width * 0.1, box!.y + box!.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.9, box!.y + box!.height * 0.9, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          JSON.parse(
            (window as unknown as PresenceWindow).Module.kicadCollabGetSelection(),
          ).length,
        ),
      { timeout: 10000, message: "box-select never selected anything" },
    )
    .toBeGreaterThan(0);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as PresenceWindow;
          return w.__selEmits!.some((s) => s.length > 0);
        }),
      { timeout: 10000, message: "selection happened but onSelection never emitted" },
    )
    .toBe(true);

  expect(hasAbort(testLogger)).toBe(false);
});

test("cursor emit: mouse motion over the canvas produces throttled world coords", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const sweepStart = Date.now();
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(cx - 150 + i * 10, cy, { steps: 1 });
  }
  const sweepMs = Date.now() - sweepStart;

  const emits = await page.evaluate(
    () => (window as unknown as PresenceWindow).__cursorEmits!,
  );
  expect(emits.length).toBeGreaterThan(0);
  // Throttle is 50 ms (≤20 Hz). On a slow runner the awaited moves themselves
  // can straddle throttle windows, so bound by measured sweep duration rather
  // than a fixed count: one emit per 50 ms window, +1 leading edge, +2 slack.
  expect(emits.length).toBeLessThanOrEqual(Math.floor(sweepMs / 50) + 3);

  const active = emits.filter((e) => e.active === 1);
  expect(active.length).toBeGreaterThan(0);
  for (const e of active) {
    expect(Math.abs(e.x)).toBeLessThan(1e8);
    expect(Math.abs(e.y)).toBeLessThan(1e8);
  }

  expect(hasAbort(testLogger)).toBe(false);
});

test("remote render paints the overlay without touching local selection", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  const canvas = await galPanel(page);
  const before = await settledShot(canvas);

  await page.evaluate(
    ({ wire }) => {
      const w = window as unknown as PresenceWindow;
      w.Module.kicadCollabSetRemote(
        JSON.stringify({
          peers: [
            {
              id: "bob",
              name: "bob",
              color: "#ef4444",
              // eeschema IU = 1e4/mm; park the cursor around (90,90) mm.
              cursor: { x: 90e4, y: 90e4 },
              selection: [wire],
            },
          ],
        }),
      );
    },
    { wire: WIRE1 },
  );

  await expect
    .poll(
      async () => {
        const after = await canvas.screenshot();
        return !after.equals(before);
      },
      { timeout: 15000, intervals: [500] },
    )
    .toBe(true);

  const localSel = await page.evaluate(() =>
    JSON.parse(
      (window as unknown as PresenceWindow).Module.kicadCollabGetSelection(),
    ),
  );
  expect(localSel).toEqual([]);

  await page.evaluate(() =>
    (window as unknown as PresenceWindow).Module.kicadCollabSetRemote(
      JSON.stringify({ peers: [] }),
    ),
  );
  await expect
    .poll(
      async () => {
        const after = await canvas.screenshot();
        return after.equals(before);
      },
      { timeout: 15000, intervals: [500] },
    )
    .toBe(true);

  expect(hasAbort(testLogger)).toBe(false);
});

test("cross-app ghost render: a pcbnew peer's xsel uuid resolves on the current sheet (0006)", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  const canvas = await galPanel(page);
  const before = await settledShot(canvas);

  // A pcbnew peer snapshot entry: xsel = the symbol uuid derived from the
  // footprint's path by the TS side. The fixture has no symbols, but the C++
  // resolve/draw path is uuid-kind-agnostic — a wire uuid exercises it fully.
  await page.evaluate(
    ({ id }) => {
      const w = window as unknown as PresenceWindow;
      w.Module.kicadCollabSetRemote(
        JSON.stringify({
          peers: [
            {
              id: "alice#x3",
              name: "alice · pcb",
              color: "#3b82f6",
              cursor: null,
              selection: [],
              xsel: [id],
            },
          ],
        }),
      );
    },
    { id: WIRE1 },
  );

  // Resolves onto the current sheet → probe reports it, ghost outline paints.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          JSON.parse(
            (window as unknown as PresenceWindow).Module.kicadCollabTestGetCrossMapped(),
          ),
        ),
      { timeout: 10000 },
    )
    .toEqual([WIRE1]);
  await expect
    .poll(
      async () => !(await canvas.screenshot()).equals(before),
      { timeout: 15000, intervals: [500] },
    )
    .toBe(true);

  // No selection leak, unknown uuids map to nothing, clear restores pixels.
  const localSel = await page.evaluate(() =>
    JSON.parse((window as unknown as PresenceWindow).Module.kicadCollabGetSelection()),
  );
  expect(localSel).toEqual([]);

  await page.evaluate(() => {
    const w = window as unknown as PresenceWindow;
    w.Module.kicadCollabSetRemote(
      JSON.stringify({
        peers: [
          {
            id: "alice#x3",
            name: "alice · pcb",
            color: "#3b82f6",
            cursor: null,
            selection: [],
            xsel: ["99999999-0000-0000-0000-000000000099"],
          },
        ],
      }),
    );
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          JSON.parse(
            (window as unknown as PresenceWindow).Module.kicadCollabTestGetCrossMapped(),
          ),
        ),
      { timeout: 10000 },
    )
    .toEqual([]);

  await page.evaluate(() =>
    (window as unknown as PresenceWindow).Module.kicadCollabSetRemote(
      JSON.stringify({ peers: [] }),
    ),
  );
  await expect
    .poll(
      async () => (await canvas.screenshot()).equals(before),
      { timeout: 15000, intervals: [500] },
    )
    .toBe(true);

  expect(hasAbort(testLogger)).toBe(false);
});

// Follow-user (0008): FitViewport applies a world rect with contain semantics —
// verified through the GetViewport round trip (center lands, the contained
// axis' half-extent matches the request within the fit's own tolerance).
test("fitViewport applies a world rect (contain) — GetViewport round trip", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  const target = { cx: 120e6, cy: 90e6, halfW: 40e6, halfH: 30e6 };
  await page.evaluate((t) => {
    const m = (window as unknown as PresenceWindow).Module as unknown as {
      kicadCollabFitViewport(cx: number, cy: number, hw: number, hh: number): void;
    };
    m.kicadCollabFitViewport(t.cx, t.cy, t.halfW, t.halfH);
  }, target);

  // The fit is CallAfter+coroutine scheduled — poll the transform until it lands.
  await expect
    .poll(
      async () => {
        const vp = await page.evaluate(() =>
          JSON.parse((window as unknown as PresenceWindow).Module.kicadCollabGetViewport()),
        );
        return Math.abs(vp.cx - target.cx) < 1e6 && Math.abs(vp.cy - target.cy) < 1e6;
      },
      { timeout: 20000, intervals: [250] },
    )
    .toBe(true);

  const vp = await page.evaluate(() =>
    JSON.parse((window as unknown as PresenceWindow).Module.kicadCollabGetViewport()),
  );
  // Contain: at least one axis' visible half-extent matches the request (the
  // other overshoots by the canvas aspect), and neither is SMALLER (cropping).
  const halfW = vp.w / 2 / vp.scale;
  const halfH = vp.h / 2 / vp.scale;
  expect(halfW).toBeGreaterThan(target.halfW * 0.95);
  expect(halfH).toBeGreaterThan(target.halfH * 0.95);
  const relW = Math.abs(halfW - target.halfW) / target.halfW;
  const relH = Math.abs(halfH - target.halfH) / target.halfH;
  expect(Math.min(relW, relH)).toBeLessThan(0.05);

  expect(hasAbort(testLogger)).toBe(false);
});

test("viewport export returns a sane world↔screen transform", async ({ page, testLogger }) => {
  await bootAndOpen(page);

  const vp = await page.evaluate(() =>
    JSON.parse((window as unknown as PresenceWindow).Module.kicadCollabGetViewport()),
  );
  expect(vp.w).toBeGreaterThan(0);
  expect(vp.h).toBeGreaterThan(0);
  // px per IU through the GAL matrix. eeschema IU = 1e4/mm (100× coarser than
  // pcbnew), so a framed A4 sheet is O(1e-3) px/IU — assert the band + a sane
  // world width, same guard as pcbnew for the GetScale()-is-zoom bug.
  expect(vp.scale).toBeGreaterThan(0);
  expect(vp.scale).toBeLessThan(1);
  const worldWidthMm = vp.w / vp.scale / 1e4;
  expect(worldWidthMm).toBeGreaterThan(50);
  expect(worldWidthMm).toBeLessThan(3000);
  expect(vp.cx).toBeGreaterThan(0);
  expect(vp.cx).toBeLessThan(400e4);
  expect(vp.cy).toBeGreaterThan(0);
  expect(vp.cy).toBeLessThan(400e4);

  expect(hasAbort(testLogger)).toBe(false);
});
