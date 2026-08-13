import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Regression for an exception from WEBGL_GAL::endUpdate().
 *
 * CACHED_CONTAINER_RAM::Unmap() reports a lost WebGL context by throwing from
 * GAL_UPDATE_CONTEXT's destructor.  The destructor must allow that exception
 * to reach EDA_DRAW_PANEL_GAL::DoRePaint(), where the existing backend recovery
 * replaces the failed GAL (or falls back to Cairo).
 *
 * This test deliberately loses the exact Emscripten context which is current
 * for the freshly loaded board.  The model update is issued from the
 * webglcontextlost callback, immediately after proving that the same context
 * and canvas are still current, attached, connected, and lost.  This prevents
 * a stale canvas left behind by an earlier recovery from satisfying the test.
 */

const SEG_TARGET = "fa220000-0000-0000-0000-00000000cafe";
const PROBE_HOME = "10000000,10000000";
const PROBE_MOVED = "13000000,35000000";

function probeBoard(): string {
  return `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(37 "F.SilkS" user)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(segment (start 10 10) (end 15 10) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG_TARGET}"))
)`;
}

type FS = { mkdirTree(path: string): void; writeFile(path: string, data: string): void };

type Mod = {
  kicadOpenFile(path: string): Promise<unknown>;
  kicadOpenFileBusy(): boolean;
  kicadCollabApply(delta: string): Promise<void>;
  kicadCollabGetPos(id: string): Promise<string>;
};

type EmscriptenContext = {
  handle: number;
  GLctx: WebGLRenderingContext | WebGL2RenderingContext;
};

type EmscriptenCanvas = HTMLCanvasElement & {
  GLctxObject?: EmscriptenContext;
};

type LossProbeState = {
  canvasId: string;
  eventFired: boolean;
  beforeUpdate: {
    sameContext: boolean;
    sameGl: boolean;
    sameCanvas: boolean;
    attached: boolean;
    connected: boolean;
    lost: boolean;
  } | null;
  updateIssued: boolean;
  applySettled: boolean;
  applyError: string | null;
};

type GalRuntime = typeof globalThis & {
  FS: FS;
  Module: Mod;
  GL?: { currentContext?: EmscriptenContext | null };
  __galUpdateLossProbe?: LossProbeState;
  __wxScheduler?: {
    dead: boolean;
    nativeTraps: number;
    canTouchNative?: () => boolean;
  };
  __wxNativeIntegrityUnknown?: boolean;
  __wxWasmFailed?: boolean;
};

function hasContextLoss(logger: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...logger.consoleLogs, ...logger.errors].some((line) =>
    /CONTEXT_LOST_WEBGL:\s*loseContext:\s*context lost|WebGL context lost|\[GAL-TEST\] webglcontextlost/i.test(
      line,
    ),
  );
}

function hasNativeTermination(logger: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...logger.consoleLogs, ...logger.errors].some((line) =>
    /Aborted\(|terminate called|std::terminate/i.test(line),
  );
}

async function bootHarness(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(
    () => {
      const runtime = globalThis as GalRuntime;
      return (
        typeof runtime.Module?.kicadOpenFile === "function" &&
        typeof runtime.Module?.kicadCollabApply === "function" &&
        typeof runtime.Module?.kicadCollabGetPos === "function" &&
        !!runtime.__wxScheduler
      );
    },
    null,
    { timeout: 90000 },
  );
}

async function openProbeBoard(page: Page): Promise<void> {
  await page.evaluate(async ({ board }) => {
    const runtime = globalThis as GalRuntime;
    const dir = "/home/kicad/documents";
    try {
      runtime.FS.mkdirTree(dir);
    } catch {
      // The directory already exists.
    }

    const path = `${dir}/gal-update-context-recovery.kicad_pcb`;
    runtime.FS.writeFile(path, board);
    await Promise.resolve(runtime.Module.kicadOpenFile(path));
  }, { board: probeBoard() });

  await expect
    .poll(() => page.evaluate(() => !(globalThis as GalRuntime).Module.kicadOpenFileBusy()), {
      timeout: 30000,
      intervals: [50],
    })
    .toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (globalThis as GalRuntime).Module.kicadCollabGetPos(id),
          SEG_TARGET,
        ),
      { timeout: 30000, intervals: [100] },
    )
    .toBe(PROBE_HOME);

  // Let the initial board refresh finish so the current GL context belongs to
  // a fully drawn board, not to startup work which is still in flight.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function loseCurrentGalAndIssueUpdate(page: Page): Promise<string> {
  return page.evaluate((targetId) => {
    const runtime = globalThis as GalRuntime;
    const context = runtime.GL?.currentContext;
    const gl = context?.GLctx;
    const canvas = gl?.canvas as EmscriptenCanvas | undefined;

    if (!context || !gl || !canvas)
      throw new Error("Emscripten has no current WebGL context");
    if (!canvas.id.startsWith("glcanvas-"))
      throw new Error(`current context belongs to non-GAL canvas ${canvas.id}`);
    if (!canvas.isConnected)
      throw new Error(`current GAL canvas ${canvas.id} is detached`);
    if (canvas.GLctxObject !== context)
      throw new Error(`current GAL canvas ${canvas.id} is not attached to its current context`);
    if (gl.isContextLost())
      throw new Error(`current GAL context ${canvas.id} was already lost`);

    const loseContext = gl.getExtension("WEBGL_lose_context");
    if (!loseContext)
      throw new Error(`current GAL context ${canvas.id} has no WEBGL_lose_context extension`);

    const state: LossProbeState = {
      canvasId: canvas.id,
      eventFired: false,
      beforeUpdate: null,
      updateIssued: false,
      applySettled: false,
      applyError: null,
    };
    runtime.__galUpdateLossProbe = state;

    canvas.addEventListener(
      "webglcontextlost",
      (event) => {
        // Allow restoration in principle.  KiCad's recovery path should still
        // destroy this failed GAL and create a fresh backend.
        event.preventDefault();

        const current = runtime.GL?.currentContext;
        const currentGl = current?.GLctx;
        state.eventFired = true;
        state.beforeUpdate = {
          sameContext: current === context,
          sameGl: currentGl === gl,
          sameCanvas: currentGl?.canvas === canvas,
          attached: canvas.GLctxObject === context,
          connected: canvas.isConnected,
          lost: gl.isContextLost(),
        };

        // Chromium does not always emit its own console warning when loss was
        // requested through WEBGL_lose_context.  Record the real DOM loss
        // event so the runner log contains deterministic external evidence.
        console.warn(`[GAL-TEST] webglcontextlost canvas=${canvas.id}`);

        const safeToUpdate = Object.values(state.beforeUpdate).every(Boolean);
        if (!safeToUpdate) {
          state.applyError = "lost context stopped being current/attached before the model update";
          state.applySettled = true;
          return;
        }

        const delta = JSON.stringify({
          added: [],
          changed: [
            {
              id: targetId,
              type: "PCB_TRACK",
              sx: 13_000_000,
              sy: 35_000_000,
              ex: 18_000_000,
              ey: 35_000_000,
              width: 200000,
            },
          ],
          removed: [],
        });

        state.updateIssued = true;
        try {
          Promise.resolve(runtime.Module.kicadCollabApply(delta)).then(
            () => {
              state.applySettled = true;
            },
            (error) => {
              state.applyError = String(error);
              state.applySettled = true;
            },
          );
        } catch (error) {
          state.applyError = String(error);
          state.applySettled = true;
        }
      },
      { once: true },
    );

    loseContext.loseContext();
    return canvas.id;
  }, SEG_TARGET);
}

test("lost current GAL context recovers from GAL_UPDATE_CONTEXT::endUpdate", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(180000);
  await bootHarness(page);
  await openProbeBoard(page);

  const oldCanvasId = await loseCurrentGalAndIssueUpdate(page);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = (globalThis as GalRuntime).__galUpdateLossProbe;
          return state
            ? {
                eventFired: state.eventFired,
                beforeUpdate: state.beforeUpdate,
                updateIssued: state.updateIssued,
              }
            : null;
        }),
      {
        message: "context loss was observed before the model update was issued",
        timeout: 10000,
        intervals: [25],
      },
    )
    .toEqual({
      eventFired: true,
      beforeUpdate: {
        sameContext: true,
        sameGl: true,
        sameCanvas: true,
        attached: true,
        connected: true,
        lost: true,
      },
      updateIssued: true,
    });

  await expect
    .poll(() => hasContextLoss(testLogger), {
      message: "the exact GAL context emitted concrete WebGL context-loss evidence",
      timeout: 10000,
      intervals: [25],
    })
    .toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = (globalThis as GalRuntime).__galUpdateLossProbe;
          return state ? { settled: state.applySettled, error: state.applyError } : null;
        }),
      { timeout: 30000, intervals: [50] },
    )
    .toEqual({ settled: true, error: null });

  // BOARD_COMMIT marks the VIEW item pending.  A real browser viewport resize
  // enters wx through its registered Emscripten callback and guarantees another
  // paint opportunity if recovery has not already run.  Do not watch the failed
  // canvas for a resize mutation: successful recovery can destroy it before this
  // stimulus, in which case observing that dead DOM node is a false failure.
  const viewport = page.viewportSize();
  expect(viewport, "the browser project has a fixed viewport").not.toBeNull();
  await page.setViewportSize({ width: viewport!.width - 1, height: viewport!.height });

  await expect
    .poll(
      () =>
        page.evaluate((failedCanvasId) => {
          const oldGone = !document.getElementById(failedCanvasId);

          if (!oldGone)
            return false;

          const remaining = Array.from(
            document.querySelectorAll<EmscriptenCanvas>(
              '#window-container canvas[id^="glcanvas-"]',
            ),
          );
          if (remaining.length === 0)
            return true;

          return remaining.some((canvas) => {
            const context = canvas.GLctxObject;
            return (
              canvas.id !== failedCanvasId &&
              canvas.isConnected &&
              !!context &&
              !context.GLctx.isContextLost()
            );
          });
        }, oldCanvasId),
      {
        message: "recovery replaced the failed GAL or fell back after removing it",
        timeout: 30000,
        intervals: [50],
      },
    )
    .toBe(true);

  const recovery = await page.evaluate((failedCanvasId) => {
    if (document.getElementById(failedCanvasId))
      return { oldGone: false, mode: "failed-canvas-still-present", canvasId: null, zIndex: null };

    const remaining = Array.from(
      document.querySelectorAll<EmscriptenCanvas>(
        '#window-container canvas[id^="glcanvas-"]',
      ),
    );
    if (remaining.length === 0)
      return { oldGone: true, mode: "fallback", canvasId: null, zIndex: null };

    const canvas = remaining.find((candidate) => {
      const context = candidate.GLctxObject;
      return !!context && !context.GLctx.isContextLost();
    });
    if (!canvas)
      return { oldGone: true, mode: "invalid-replacement", canvasId: null, zIndex: null };

    return {
      oldGone: true,
      mode: "replacement",
      canvasId: canvas.id,
      zIndex: Number.parseInt(getComputedStyle(canvas).zIndex, 10),
    };
  }, oldCanvasId);

  expect(recovery.oldGone, "recovery removes the exact failed GAL canvas").toBe(true);
  expect(["replacement", "fallback"], "recovery installs a fresh GAL or falls back to Cairo")
    .toContain(recovery.mode);
  if (recovery.mode === "replacement") {
    expect(recovery.canvasId, "the recovered GAL uses a different canvas")
      .not.toBe(oldCanvasId);
    expect(
      recovery.zIndex,
      "a replacement main-frame GAL keeps the main role while the failed canvas is being removed",
    ).toBe(100);
  }

  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (globalThis as GalRuntime).Module.kicadCollabGetPos(id),
          SEG_TARGET,
        ),
      { timeout: 30000, intervals: [100] },
    )
    .toBe(PROBE_MOVED);

  const health = await page.evaluate(() => {
    const runtime = globalThis as GalRuntime;
    const scheduler = runtime.__wxScheduler;
    return {
      schedulerPresent: !!scheduler,
      schedulerDead: scheduler?.dead ?? null,
      nativeTraps: scheduler?.nativeTraps ?? null,
      canTouchNative: scheduler?.canTouchNative?.() ?? false,
      nativeIntegrityUnknown: runtime.__wxNativeIntegrityUnknown === true,
      wasmFailed: runtime.__wxWasmFailed === true,
    };
  });
  expect(health, "context-loss recovery leaves the native instance usable").toEqual({
    schedulerPresent: true,
    schedulerDead: false,
    nativeTraps: 0,
    canTouchNative: true,
    nativeIntegrityUnknown: false,
    wasmFailed: false,
  });

  expect(hasNativeTermination(testLogger), "lost-context recovery must not terminate WASM").toBe(
    false,
  );
});
