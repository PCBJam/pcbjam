import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  TRIO_PCB,
  TRIO_SCH,
  type ToolCfg,
  callHook,
  closeTrio,
  hasAbort,
  modelText,
  openTrio,
  oracleSweep,
  settleConverged,
} from "./utils/trio";

/**
 * Move-vs-delete with the peer's delete still in the editor's apply queue
 * (ysync 0012 #2 follow-up — "delete wins").
 *
 * drift-trio-scenarios S4 fires A's move and B's delete concurrently and lets
 * timing decide the interleaving; on a laptop the deferred apply on A drains
 * before A's move hook runs, so the failing order (CI run 34711238549, both
 * attempts) never happens locally. This spec forces it: A's move hook is called
 * from INSIDE the remote-removal path on A —
 *
 *   [apply]   when the binding hands B's removal to the wasm bridge (queued,
 *             not yet executed) — the CI order: A's flush-before-apply then
 *             emitted the move as an ADD of a root the doc had deleted, every
 *             peer re-created it, the resolved removal took it out of A alone;
 *   [resolve] when the editor's queue resolves the payload right before
 *             executing it (the resolver already applies delete-wins here).
 *
 * Contract: convergence + drift silence on all three tabs; the winner is the
 * delete. Needs the 0012 #2 wasm (`window.kicadCollab.resolveItems`).
 */

test.beforeAll(() => {
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

interface ToolCase {
  label: string;
  cfg: ToolCfg;
  /** Move hook name + one-mm delta (IU). */
  moveFn: string;
  dx: number;
  /** Add a marker item on `page`; returns its uuid. */
  add(page: Page, text: string): Promise<string>;
}

const CASES: ToolCase[] = [
  {
    label: "pcbnew",
    cfg: TRIO_PCB,
    moveFn: "kicadCollabTestMoveBoardItem",
    dx: 1000000,
    add: (p, text) => callHook<string>(p, "kicadCollabTestAddBoardText", text, 20000000, 130000000, "F.SilkS"),
  },
  {
    label: "eeschema",
    cfg: TRIO_SCH,
    moveFn: "kicadCollabTestMoveSchItem",
    dx: 10000,
    add: (p, text) => callHook<string>(p, "kicadCollabTestAddLabel", "label", text, 400000, 400000),
  },
];

type Point = "apply" | "resolve";

/** Poll until every tab's silent save contains `marker`. */
async function waitAllContain(tabs: ReadonlyArray<readonly [string, Page]>, cfg: ToolCfg, marker: string): Promise<void> {
  for (const [label, page] of tabs) {
    await expect
      .poll(async () => (await modelText(page, cfg)).includes(marker), {
        timeout: 90000,
        intervals: [400],
        message: `${label} must receive "${marker}"`,
      })
      .toBe(true);
  }
}

/**
 * Arm tab `page`: the first removal payload naming `victim` that passes the
 * chosen interception point triggers the move hook synchronously, in the same
 * task. Returns nothing; the outcome is read back via `armedResult`.
 */
function arm(page: Page, point: Point, victim: string, moveFn: string, dx: number): Promise<void> {
  return page.evaluate(
    ({ point, victim, moveFn, dx }) => {
      type Hook = (...a: unknown[]) => unknown;
      const w = window as unknown as {
        Module: Record<string, Hook>;
        kicadCollab: { resolveItems: (json: string) => string };
        __deleteWins: string;
      };
      w.__deleteWins = "armed";
      const fire = (): void => {
        w.__deleteWins = `fired: move → ${String(w.Module[moveFn]!(victim, dx, 0))}`;
      };
      const hits = (json: string): boolean =>
        w.__deleteWins === "armed" && json.includes(victim) && json.includes('"removed"');
      if (point === "apply") {
        const orig = w.Module.kicadCollabApplyItems!;
        w.Module.kicadCollabApplyItems = (json: unknown) => {
          if (hits(String(json))) fire();
          return orig.call(w.Module, json);
        };
      } else {
        const orig = w.kicadCollab.resolveItems;
        w.kicadCollab.resolveItems = (json: string) => {
          if (hits(json)) fire();
          return orig(json);
        };
      }
    },
    { point, victim, moveFn, dx },
  );
}

function armedResult(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __deleteWins: string }).__deleteWins);
}

for (const c of CASES) {
  test.describe(`delete wins — ${c.label}`, () => {
    test.describe.configure({ timeout: 600000 });

    for (const point of ["apply", "resolve"] as const) {
      test(`${c.label} [${point}]: A moves the item while B's delete is queued → converges, item gone`, async ({
        context,
        testLogger,
      }) => {
        const trio = await openTrio(context, c.cfg, `delete-wins-${point}-${c.label}-${test.info().workerIndex}`);

        // The 0012 #2 resolver must be registered — otherwise this is the
        // synchronous-apply wasm and the window under test does not exist.
        expect(
          await trio.A.evaluate(
            () => typeof (window as unknown as { kicadCollab?: { resolveItems?: unknown } }).kicadCollab?.resolveItems,
          ),
          "0012 #2 resolver registered (wasm predates the apply queue otherwise)",
        ).toBe("function");

        const victim = await c.add(trio.A, `delete-wins-${point}`);
        expect(victim).toMatch(/[0-9a-f-]{36}/);
        await waitAllContain(trio.tabs, c.cfg, victim);

        await arm(trio.A, point, victim, c.moveFn, c.dx);
        expect(await callHook<boolean>(trio.B, "kicadCollabTestRemoveItem", victim), "B removes the victim").toBe(true);
        await expect
          .poll(() => armedResult(trio.A), { timeout: 30000, intervals: [100], message: "A's move fired inside the window" })
          .toMatch(/^fired: move → true$/);

        await settleConverged(trio, c.cfg);
        await oracleSweep(trio, c.cfg);
        for (const [label, page] of trio.tabs) {
          expect((await modelText(page, c.cfg)).includes(victim), `${label}: the deleted item stays deleted`).toBe(false);
        }

        expect(hasAbort(testLogger), "no WASM abort").toBe(false);
        await closeTrio(trio);
      });
    }
  });
}
