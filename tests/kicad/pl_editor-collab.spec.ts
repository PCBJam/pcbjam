import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * pl_editor Yjs collaborative bridge (features/yjs-bridge commit 2).
 *
 * Two layers of coverage:
 *  1. single-page — the C++ bridge contract in isolation: kicadCollabSnapshot reflects
 *     the model; kicadCollabApply mutates it by uuid (changed / removed / added scalar);
 *     applying a remote delta does NOT echo a local onDelta (s_applyingRemote guard).
 *  2. two-tab — the full loop through the generic reconciler + Yjs + BroadcastChannel:
 *     a local text insert in tab A appears in tab B, and vice-versa.
 *
 * The collab reconciler/transport are bundled from web/standalone/src/wasm/collab via
 * esbuild into apps/kicad/collab-bundle.js (rebuilt in beforeAll for freshness).
 */

const CHANNEL_BASE = "pl-collab-e2e";

// A drawing sheet with explicit uuids so both tabs load identical item identities.
const U_TITLE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SHEET = `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (rect (uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") (name border) (start 0 0 ltcorner) (end 0 0 rbcorner))
  (tbtext "Title" (uuid "${U_TITLE}") (name title) (pos 100 20 ltcorner) (font (size 2 2)))
)
`;

type FS = { mkdirTree(p: string): void; writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string };
type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadSaveDrawingSheet(p: string): Promise<void>;
  kicadCollabSnapshot(): Promise<string>;
  kicadCollabApply(j: string): Promise<unknown>;
  kicadCollabTestAddText(text: string, x: number, y: number): Promise<string>;
};

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

/** Bring a pl_editor tab fully up and open SHEET in its MEMFS. */
async function bootAndOpen(page: Page, name: string): Promise<void> {
  await page.goto("/kicad/pl_editor.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90000 });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: 90000 });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSnapshot === "function" &&
        typeof m?.kicadCollabApply === "function" &&
        typeof m?.kicadCollabTestAddText === "function"
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
    async ({ content, name }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const dir = "/home/kicad/documents";
      try {
        w.FS.mkdirTree(dir);
      } catch {
        /* exists */
      }
      const p = `${dir}/${name}.kicad_wks`;
      w.FS.writeFile(p, content);
      await w.Module.kicadOpenFile(p);
    },
    { content: SHEET, name },
  );

  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(new RegExp(name, "i"));
}

/** Read the tab's current model back as text via save-to-MEMFS. */
async function modelText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const w = window as unknown as { FS: FS; Module: Mod };
    const out = "/home/kicad/documents/_dump.kicad_wks";
    await w.Module.kicadSaveDrawingSheet(out);
    return w.FS.readFile(out, { encoding: "utf8" });
  });
}

test.beforeAll(() => {
  // Rebuild the collab bundle so the test always exercises the current reconciler.
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

test.describe("pl_editor collab bridge — single page (C++ contract)", () => {
  test("snapshot reflects model; apply changes/removes/adds by uuid; no echo", async ({
    page,
    testLogger,
  }) => {
    await bootAndOpen(page, "single");

    // snapshot: both seeded items present, with decomposed fields.
    const snap = await page.evaluate(async () =>
      JSON.parse(await window.Module.kicadCollabSnapshot()),
    );
    const ids: string[] = snap.added.map((i: { id: string }) => i.id);
    expect(ids).toContain(U_TITLE);
    const title = snap.added.find((i: { id: string }) => i.id === U_TITLE);
    expect(title.type).toBe("text");
    expect(title.text).toBe("Title");

    // Install an onDelta capture to prove apply() does NOT echo (s_applyingRemote).
    await page.evaluate(() => {
      (window as unknown as { __echo: string[] }).__echo = [];
      (window as unknown as { kicadCollab: { onDelta: (j: string) => void } }).kicadCollab = {
        onDelta: (j: string) => (window as unknown as { __echo: string[] }).__echo.push(j),
      };
    });

    // changed: move the title text. added (scalar): a new line. removed: the border rect.
    await page.evaluate(async (titleId) => {
      await window.Module.kicadCollabApply(
        JSON.stringify({
          changed: [{ id: titleId, type: "text", x: 123, y: 45 }],
          added: [
            {
              id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
              type: "segment",
              name: "seg",
              x: 5,
              y: 5,
              anchor: 3,
              ex: 25,
              ey: 5,
              eanchor: 3,
              linewidth: 0.2,
            },
          ],
          removed: ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
        }),
      );
    }, U_TITLE);

    const out = await modelText(page);
    // title moved
    expect(out).toContain(`(uuid "${U_TITLE}")`);
    expect(out).toMatch(/\(pos 123 45/);
    // new segment added with its uuid
    expect(out).toContain(`(uuid "cccccccc-cccc-cccc-cccc-cccccccccccc")`);
    expect(out).toContain("(line");
    // border rect removed
    expect(out).not.toContain("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    // echo suppression: applying a remote delta must not have produced a local delta.
    const echoes = await page.evaluate(() => (window as unknown as { __echo: string[] }).__echo);
    expect(echoes, "apply() must not echo a local onDelta").toHaveLength(0);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});

test.describe("pl_editor collab bridge — two tabs (BroadcastChannel)", () => {
  test("a local text insert propagates A→B and B→A", async ({ context, testLogger }) => {
    const channel = `${CHANNEL_BASE}-${test.info().workerIndex}`;
    const bundle = path.resolve(__dirname, "../apps/kicad/collab-bundle.js");

    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await bootAndOpen(tabA, "tabA");
    await bootAndOpen(tabB, "tabB");

    // Load the reconciler bundle into both tabs.
    for (const p of [tabA, tabB]) await p.addScriptTag({ path: bundle });

    // Start collab: A first (seeds the doc), then B (adopts via state query).
    const startCollab = async (p: Page) =>
      p.evaluate(async (ch) => {
        const w = window as unknown as {
          KicadCollab: { start: (m: unknown, win: unknown, o: unknown) => Promise<unknown> };
          Module: unknown;
          __collab?: unknown;
        };
        w.__collab = await w.KicadCollab.start(w.Module, window, { provider: { kind: "broadcastchannel", settleMs: 500 }, room: ch });
      }, channel);
    await startCollab(tabA);
    await startCollab(tabB);

    // Tab A inserts text locally (the real PlaceItem model path + OnModify → emit).
    const uuidA = await tabA.evaluate(() =>
      window.Module.kicadCollabTestAddText("Hello from A", 40, 40),
    );
    expect(uuidA).toMatch(/[0-9a-f-]{36}/);

    // Tab B should receive it through Y.Doc + BroadcastChannel + kicadCollabApply.
    await expect
      .poll(async () => await modelText(tabB), { timeout: 15000, intervals: [300] })
      .toContain("Hello from A");
    expect(await modelText(tabB)).toContain(`(uuid "${uuidA}")`);

    // Reverse direction: B → A.
    const uuidB = await tabB.evaluate(() =>
      window.Module.kicadCollabTestAddText("Hello from B", 60, 60),
    );
    await expect
      .poll(async () => await modelText(tabA), { timeout: 15000, intervals: [300] })
      .toContain("Hello from B");
    expect(await modelText(tabA)).toContain(`(uuid "${uuidB}")`);

    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    await tabA.close();
    await tabB.close();
  });
});
