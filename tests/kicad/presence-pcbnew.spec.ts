import type { Page } from "@playwright/test";
import { settledShot } from "../e2e/utils/element-tracker";
import { test, expect } from "./fixtures";

/**
 * pcbnew collab presence — C++ bridge e2e (collab-presence 0002).
 *
 * Covers the wasm side of presence in isolation (no yjs/awareness — that layer is
 * unit-tested in the standalone and exercised end-to-end by tests/web):
 *   - selection emit: kicadCollabTestSelectFirst → window.kicadCollab.onSelection
 *     fires with the item's uuid; clear → fires with []. Real canvas CLICKS also
 *     drive the emit (the wx-layer trigger path).
 *   - cursor emit: synthetic mouse motion over the canvas → onCursor with world
 *     coords inside the board area; throttled; pointer-leave handled by the DOM
 *     leave event (not synthesizable reliably headless — covered in tests/web).
 *   - remote render, no state leak: kicadCollabSetRemote paints the VIEW_OVERLAY
 *     (canvas pixels change) while kicadCollabGetSelection stays [].
 *   - viewport export: kicadCollabGetViewport returns a sane transform.
 *
 * Board fixture mirrors pcbnew-collab.spec.ts (seeded harness, wizard-free).
 */

const SEG1 = "44444444-0000-0000-0000-000000000001";
const FP1 = "66666666-0000-0000-0000-000000000001";
// The footprint's schematic link (0006): its (path …) ends in the symbol uuid.
const SYM1 = "aaaaaaaa-0000-0000-0000-000000000001";
const FP1_PATH = `/${SYM1}`;
// version must be the CURRENT board format (pcb_io_kicad_sexpr.h): an older
// one makes pcbnew show the "created by an older version" wxInfoBar, whose
// appearance relayouts the GL panel at a load-dependent moment — permanently
// breaking the overlay tests' before/after pixel equality.
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
\t\t(path "${FP1_PATH}")
\t\t(attr smd)
\t\t(property "Reference" "R1"
\t\t\t(at 0 -4.2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "66666666-0000-0000-0000-0000000000aa")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t\t(property "Value" "R"
\t\t\t(at 0 4.6 0)
\t\t\t(layer "F.Fab")
\t\t\t(uuid "66666666-0000-0000-0000-0000000000bb")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at -1 0)
\t\t\t(size 1 1)
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
  kicadCollabGetSelectionFull(): string;
  kicadCollabTestGetCrossMapped(): string;
  kicadCollabTestSelectFirst(): string;
  kicadCollabTestClearSelection(): boolean;
};
type SelPayload = { uuids: string[]; fpPaths: string[] };
type PresenceWindow = {
  FS: FS;
  Module: Mod;
  kicadCollab?: Record<string, unknown>;
  __selEmits?: string[][];
  __selPayloads?: SelPayload[];
  __cursorEmits?: Array<{ x: number; y: number; active: number }>;
};

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
      const p = `${dir}/presence.kicad_pcb`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: SAMPLE_PCB },
  );

  // Board open settles asynchronously; wait for the title to carry the file stem.
  await expect
    .poll(() => page.title(), { timeout: 60000, intervals: [500] })
    .toMatch(/presence/i);

  // Install the capture hooks + start the presence input bindings. Since 0006
  // pcbnew emits `{uuids, fpPaths}` — capture the uuid arrays (the pre-0006
  // assertions) AND the full payloads (the cross-app ones).
  await page.evaluate(() => {
    const w = window as unknown as PresenceWindow;
    w.__selEmits = [];
    w.__selPayloads = [];
    w.__cursorEmits = [];
    w.kicadCollab = {
      ...w.kicadCollab,
      onSelection: (json: string) => {
        const parsed = JSON.parse(json) as SelPayload | string[];
        const payload: SelPayload = Array.isArray(parsed)
          ? { uuids: parsed, fpPaths: [] }
          : parsed;
        w.__selEmits!.push(payload.uuids);
        w.__selPayloads!.push(payload);
      },
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

test("selection emit carries the footprint's schematic path (0006)", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  // TestSelectFirst picks the first top-level item — the fixture's only
  // footprint sorts first, but assert by payload rather than by luck: select,
  // then find the emit whose uuids contain the footprint.
  await page.evaluate(() =>
    (window as unknown as PresenceWindow).Module.kicadCollabTestSelectFirst(),
  );
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as PresenceWindow;
          return w.__selPayloads!.at(-1) ?? null;
        }),
      { timeout: 10000 },
    )
    .not.toBeNull();

  const payload = await page.evaluate(
    () => (window as unknown as PresenceWindow).__selPayloads!.at(-1)!,
  );
  if (payload.uuids.includes(FP1)) {
    expect(payload.fpPaths).toEqual([FP1_PATH]);
  } else {
    // A non-footprint got selected first — the paths list must then be empty.
    expect(payload.fpPaths).toEqual([]);
  }

  // The pull export mirrors the emit payload (cross-app seed at attach).
  const full = await page.evaluate(() =>
    JSON.parse((window as unknown as PresenceWindow).Module.kicadCollabGetSelectionFull()),
  );
  expect(full.uuids).toEqual(payload.uuids);
  expect(full.fpPaths).toEqual(payload.fpPaths);

  expect(hasAbort(testLogger)).toBe(false);
});

test("selection emit: a real canvas click drives the wx-layer trigger", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  // Rubber-band box-select across the sheet: `#canvas` is the WHOLE wx app
  // window (menus/toolbars included) — the GAL draw panel is its own DOM element
  // (`#glcanvas-*`, see zoom-cursor.spec.ts). A drag over most of the panel
  // catches the board items without depending on exact world→screen math; the
  // closing LEFT_UP is the wx-layer trigger under test.
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

  const x0 = box!.x + box!.width * 0.1;
  const y0 = box!.y + box!.height * 0.1;
  const x1 = box!.x + box!.width * 0.9;
  const y1 = box!.y + box!.height * 0.9;

  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();

  // First check the selection actually happened (separates "the drag didn't
  // select" from "the emit trigger is broken").
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

  // Sweep the pointer across the canvas center with many small steps.
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
  // World coords: an A4 board view centers around 10^8 nm — sanity-band check.
  for (const e of active) {
    expect(Math.abs(e.x)).toBeLessThan(1e10);
    expect(Math.abs(e.y)).toBeLessThan(1e10);
  }

  expect(hasAbort(testLogger)).toBe(false);
});

test("remote render paints the overlay without touching local selection", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  const canvas = page.locator("#canvas");
  const before = await settledShot(canvas);

  await page.evaluate(
    ({ fp }) => {
      const w = window as unknown as PresenceWindow;
      w.Module.kicadCollabSetRemote(
        JSON.stringify({
          peers: [
            {
              id: "bob",
              name: "bob",
              color: "#ef4444",
              cursor: { x: 90e6, y: 90e6 },
              selection: [fp],
            },
          ],
        }),
      );
    },
    { fp: FP1 },
  );

  // The overlay redraw runs via CallAfter + coroutine; poll the pixels.
  await expect
    .poll(
      async () => {
        const after = await canvas.screenshot();
        return !after.equals(before);
      },
      { timeout: 15000, intervals: [500] },
    )
    .toBe(true);

  // No state leak: the remote render never enters the local selection.
  const localSel = await page.evaluate(() =>
    JSON.parse(
      (window as unknown as PresenceWindow).Module.kicadCollabGetSelection(),
    ),
  );
  expect(localSel).toEqual([]);

  // Clearing the peers restores the original pixels.
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

test("cross-app ghost render: an eeschema peer's symbol uuid maps to the footprint (0006)", async ({
  page,
  testLogger,
}) => {
  await bootAndOpen(page);

  const canvas = page.locator("#canvas");
  const before = await settledShot(canvas);

  // An eeschema peer snapshot entry: no same-doc selection, xsel = symbol uuid.
  await page.evaluate(
    ({ sym }) => {
      const w = window as unknown as PresenceWindow;
      w.Module.kicadCollabSetRemote(
        JSON.stringify({
          peers: [
            {
              id: "bob#x7",
              name: "bob · sch",
              color: "#d946ef",
              cursor: null,
              selection: [],
              xsel: [sym],
            },
          ],
        }),
      );
    },
    { sym: SYM1 },
  );

  // The suffix match resolves the symbol to the fixture footprint.
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
    .toEqual([FP1]);

  // …and paints the ghost outline (pixels change), with no selection leak.
  await expect
    .poll(
      async () => !(await canvas.screenshot()).equals(before),
      { timeout: 15000, intervals: [500] },
    )
    .toBe(true);
  const localSel = await page.evaluate(() =>
    JSON.parse((window as unknown as PresenceWindow).Module.kicadCollabGetSelection()),
  );
  expect(localSel).toEqual([]);

  // An unknown symbol uuid maps to nothing; clearing restores the pixels.
  await page.evaluate(() => {
    const w = window as unknown as PresenceWindow;
    w.Module.kicadCollabSetRemote(
      JSON.stringify({
        peers: [
          {
            id: "bob#x7",
            name: "bob · sch",
            color: "#d946ef",
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
  // scale must be px per IU (nm) THROUGH THE GAL MATRIX — VIEW::GetScale() is
  // the zoom (O(1)), which once shipped here and made every screen-constant
  // overlay size sub-nanometre. A framed A4 sheet is a few thousand px per
  // 3e8 nm, so the true value is O(1e-5).
  expect(vp.scale).toBeGreaterThan(0);
  expect(vp.scale).toBeLessThan(0.01);
  const worldWidthMm = vp.w / vp.scale / 1e6;
  expect(worldWidthMm).toBeGreaterThan(50);
  expect(worldWidthMm).toBeLessThan(3000);
  // The opened A4 board frames around (148.5,105) mm — the center must be on-board.
  expect(vp.cx).toBeGreaterThan(0);
  expect(vp.cx).toBeLessThan(400e6);
  expect(vp.cy).toBeGreaterThan(0);
  expect(vp.cy).toBeLessThan(400e6);

  expect(hasAbort(testLogger)).toBe(false);
});
