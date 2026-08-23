import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execSync } from "node:child_process";
import type { BrowserContext, Page } from "@playwright/test";
import {
  compareSlots,
  driftDocDelta,
  KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER,
  parseSexpr,
  fileToDoc,
} from "../../web/pcbjam-shared/src/index.js";
import { expect, test } from "./fixtures";
import {
  TRIO_PCB,
  TRIO_SCH,
  bootOpen,
  callHook,
  drift,
  getPos,
  modelText,
  renderDoc,
  startV2,
  type ToolCfg,
} from "./utils/trio";

/**
 * Real-Wasm refinement over pinned upstream KiCad designs.
 *
 * Unlike the synthetic item round-trip battery, these checks include the full
 * parsed document and exercise the explicit recreate-from-Yjs recovery path.
 * The grouped-board cases also audit that the C++ snapshot universe equals the
 * C++ diff/apply universe; a missing root makes every later projection compute
 * a destructive, spurious add.
 */

const ROOT = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  fs.readFileSync(path.join(ROOT, relative), "utf8");

const REAL_PCB: ToolCfg = {
  ...TRIO_PCB,
  fixture: read("tests/fixtures/demo/demo.kicad_pcb"),
};
const REAL_SCH: ToolCfg = {
  ...TRIO_SCH,
  fixture: read("tests/fixtures/demo/demo.kicad_sch"),
};
const GROUPED_PCB: ToolCfg = {
  ...TRIO_PCB,
  fixture: read("kicad/demos/stickhub/StickHub.kicad_pcb"),
};
const GENERATED_PCB: ToolCfg = {
  ...TRIO_PCB,
  fixture: read("kicad/qa/data/pcbnew/diff_pair_uncoupled_tuning_drc.kicad_pcb"),
};

const STICKHUB_NETTED_FOOTPRINT = "02995be1-979b-4b84-a4b4-8eb9bd3d9e39";
const STICKHUB_GND_PAD = "746cc8bc-1074-4915-abdb-85c85120ff59";
const STICKHUB_SIGNAL_PAD = "8f217301-5df2-4f16-9eb0-3c8e53dd326a";

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

interface ProjectionFailure {
  kind: string;
  message: string;
  status?: string;
  recovery: string;
}

interface CorpusWindow {
  Module: Record<string, (...args: unknown[]) => unknown>;
  KicadCollabV2: { projectionFailures(): ProjectionFailure[] };
  __submittedItems?: string[];
}

function projectionFailures(page: Page): Promise<ProjectionFailure[]> {
  return page.evaluate(
    () => (window as unknown as CorpusWindow).KicadCollabV2.projectionFailures(),
  );
}

function expectCompleteParsedEqual(actual: string, expected: string, label: string): void {
  expect(
    isDeepStrictEqual(parseSexpr(actual), parseSexpr(expected)),
    `${label}: complete parsed KiCad documents differ ` +
      `(actual=${actual.length} bytes, expected=${expected.length} bytes)`,
  ).toBe(true);
}

function expectSemanticallyEqual(actual: string, expected: string, label: string): void {
  const actualDoc = fileToDoc(actual);
  const expectedDoc = fileToDoc(expected);
  const delta = driftDocDelta(expectedDoc, actualDoc);
  expect(actualDoc.root, `${label}: root metadata differs`).toBe(expectedDoc.root);
  expect(
    {
      added: delta.added.map((item) => item.uuid),
      updated: delta.updated.map((item) => item.uuid),
      removed: delta.removed,
    },
    `${label}: item content or membership differs`,
  ).toEqual({ added: [], updated: [], removed: [] });
  expect(
    compareSlots(
      expectedDoc.layout,
      actualDoc.layout,
      KICAD_WRITER_NORMALIZED_ITEM_REFERENCE_ORDER,
    ),
    `${label}: layout differs`,
  ).not.toBe("different");
}

async function realFreshOwnerRoundTrip(
  page: Page,
  context: BrowserContext,
  cfg: ToolCfg,
  room: string,
): Promise<void> {
  await bootOpen(page, cfg);
  const native0 = await modelText(page, cfg);
  await startV2(page, { room, seedText: native0 });

  const authority = await renderDoc(page);
  expect(authority.err, "real design Y authority materializes").toBeUndefined();
  expectCompleteParsedEqual(authority.ok!, native0, "native -> Yjs");
  expect(await drift(page, cfg), "seed owner is full-document drift free").toBeNull();

  // Keep the seeder connected until the fresh owner has received the room;
  // BroadcastChannel itself is intentionally not persistence.
  const fresh = await context.newPage();
  try {
    const freshCfg: ToolCfg = { ...cfg, fixture: authority.ok! };
    await bootOpen(fresh, freshCfg);
    await startV2(fresh, { room, editorMatchesDoc: true });
    const native1 = await modelText(fresh, freshCfg);
    // KiCad may reorder independent top-level roots on reopen (the demo board
    // moves one track block while preserving every UUID-bearing AST). The
    // production invariant is semantic equality: exact membership/content,
    // identical non-item root state, and at most order-only layout churn.
    expectSemanticallyEqual(native1, authority.ok!, "Yjs -> fresh native");
    expect(await drift(fresh, freshCfg), "fresh owner is full-document drift free").toBeNull();
    expect(await projectionFailures(fresh), "fresh owner stays live").toEqual([]);
  } finally {
    await fresh.close({ runBeforeUnload: false });
  }
}

test.describe("real KiCad designs through Yjs and fresh native owners", () => {
  test.describe.configure({ timeout: 600_000 });

  test("app demo PCB: native -> Yjs -> fresh native preserves the complete board", async ({
    page,
    context,
  }) => {
    await realFreshOwnerRoundTrip(
      page,
      context,
      REAL_PCB,
      `real-native-pcb-${test.info().workerIndex}`,
    );
  });

  test("app demo schematic: native -> Yjs -> fresh native preserves the complete sheet", async ({
    page,
    context,
  }) => {
    await realFreshOwnerRoundTrip(
      page,
      context,
      REAL_SCH,
      `real-native-sch-${test.info().workerIndex}`,
    );
  });

  test("StickHub: native snapshot includes its real PCB_GROUP root", async ({ page }) => {
    await bootOpen(page, GROUPED_PCB);
    const source = fileToDoc(await modelText(page, GROUPED_PCB));
    const group = Object.entries(source.items).find(([, item]) => item.type === "group");
    expect(group, "real board has a parsed group canary").toBeTruthy();

    const snapshot = await page.evaluate(() => {
      const runtime = window as unknown as CorpusWindow;
      return runtime.Module.kicadCollabSnapshotItems!() as string;
    });
    const wire = JSON.parse(snapshot) as {
      added: Array<{ sexpr: string }>;
    };
    expect(
      wire.added.some((entry) => entry.sexpr.includes(group![0])),
      `native snapshot omitted PCB_GROUP ${group![0]}`,
    ).toBe(true);
  });

  test("StickHub: replacing a real footprint root preserves pad nets and remains saveable", async ({
    page,
  }) => {
    await bootOpen(page, GROUPED_PCB);
    const snapshot = JSON.parse(
      await callHook<string>(page, "kicadCollabSnapshotItems"),
    ) as { added: Array<{ sexpr: string }> };
    const footprint = snapshot.added.find((entry) =>
      entry.sexpr.includes(STICKHUB_NETTED_FOOTPRINT),
    );
    expect(footprint, "real netted footprint is present in the native snapshot").toBeTruthy();

    await callHook(
      page,
      "kicadCollabApplyItems",
      JSON.stringify({
        added: [],
        changed: [{ id: STICKHUB_NETTED_FOOTPRINT, sexpr: footprint!.sexpr }],
        removed: [],
      }),
    );
    await page.waitForFunction(
      () => !(window as unknown as CorpusWindow).Module.kicadCollabBusy!(),
      null,
      { timeout: 30_000 },
    );

    const saved = await modelText(page, GROUPED_PCB);
    const savedDoc = fileToDoc(saved);
    expect(JSON.stringify(savedDoc.items[STICKHUB_GND_PAD]), "GND pad retained its net").toContain(
      "GND",
    );
    expect(
      JSON.stringify(savedDoc.items[STICKHUB_SIGNAL_PAD]),
      "signal pad retained its net",
    ).toContain("/U2D+");
  });

  test("tuning-pattern board: native snapshot includes its real PCB_GENERATOR root", async ({
    page,
  }) => {
    await bootOpen(page, GENERATED_PCB);
    const source = fileToDoc(await modelText(page, GENERATED_PCB));
    const generated = Object.entries(source.items).find(
      ([, item]) => item.type === "generated",
    );
    expect(generated, "real board has a parsed tuning-pattern generator canary").toBeTruthy();

    const snapshot = await page.evaluate(() => {
      const runtime = window as unknown as CorpusWindow;
      return runtime.Module.kicadCollabSnapshotItems!() as string;
    });
    const wire = JSON.parse(snapshot) as {
      added: Array<{ sexpr: string }>;
    };
    expect(
      wire.added.some((entry) => entry.sexpr.includes(generated![0])),
      `native snapshot omitted PCB_GENERATOR ${generated![0]}`,
    ).toBe(true);
  });

  test("StickHub: unrelated remote edit does not spuriously re-add its existing group", async ({
    page,
    context,
  }) => {
    await bootOpen(page, GROUPED_PCB);
    const normalized = await modelText(page, GROUPED_PCB);
    const doc = fileToDoc(normalized);
    const groupUuid = Object.entries(doc.items).find(([, item]) => item.type === "group")?.[0];
    const targetUuid = Object.entries(doc.items).find(
      ([, item]) => item.type === "footprint" && item.parent === null,
    )?.[0];
    expect(groupUuid, "real board has a group").toBeTruthy();
    expect(targetUuid, "real board has a movable footprint").toBeTruthy();

    const room = `real-group-shadow-${test.info().workerIndex}`;
    await startV2(page, { room, seedText: normalized });

    const peer = await context.newPage();
    try {
      await bootOpen(peer, GROUPED_PCB);
      await peer.evaluate(() => {
        const runtime = window as unknown as CorpusWindow;
        const submit = runtime.Module.kicadCollabApplyItems!.bind(runtime.Module);
        runtime.__submittedItems = [];
        runtime.Module.kicadCollabApplyItems = (json: unknown) => {
          runtime.__submittedItems!.push(String(json));
          return submit(json);
        };
      });
      await startV2(peer, { room, editorMatchesDoc: true });
      await peer.evaluate(
        () => ((window as unknown as CorpusWindow).__submittedItems = []),
      );

      const before = await getPos(page, targetUuid!);
      expect(
        await callHook<boolean>(page, "kicadCollabTestMoveBoardItem", targetUuid!, 1_000_000, 0),
        "real native footprint move committed",
      ).toBe(true);
      await expect
        .poll(() => getPos(page, targetUuid!), { timeout: 20_000, intervals: [200] })
        .not.toBe(before);
      await expect
        .poll(async () => (await getPos(peer, targetUuid!)) === (await getPos(page, targetUuid!)), {
          timeout: 60_000,
          intervals: [400],
        })
        .toBe(true);

      const submitted = await peer.evaluate(
        () => (window as unknown as CorpusWindow).__submittedItems ?? [],
      );
      expect(submitted.length, "peer received a native projection").toBeGreaterThan(0);
      expect(
        submitted.some((wire) => wire.includes(groupUuid!)),
        `unrelated projection spuriously included existing PCB_GROUP ${groupUuid}`,
      ).toBe(false);
      expect(await drift(peer, GROUPED_PCB), "real peer remains drift free").toBeNull();
      expect(await projectionFailures(peer), "real peer stays live").toEqual([]);
    } finally {
      await peer.close({ runBeforeUnload: false });
    }
  });
});
