import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { fileToDoc } from "../../web/pcbjam-shared/src/index.js";
import { expect, test } from "./fixtures";
import { TRIO_PCB, bootOpen, modelText, type ToolCfg } from "./utils/trio";

/**
 * Real-Wasm regressions for roots which KiCad's parser accepts but its board
 * writer cannot faithfully persist. An apply acknowledgement is a durability
 * claim: a root which traps, disappears, or changes shape at the next save must
 * be rejected before BOARD_COMMIT mutates the live board.
 */

const ROOT = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  fs.readFileSync(path.join(ROOT, relative), "utf8");

const SEGMENT_UUID = "92929292-0000-0000-0000-000000000001";
const TABLE_UUID = "92929292-0000-0000-0000-000000000002";
const TABLE_CELL_UUID = "92929292-0000-0000-0000-0000000000c1";
const GROUP_UUID = "92929292-0000-0000-0000-000000000003";
const POLYGON_UUID = "92929292-0000-0000-0000-000000000004";

const PERSISTABILITY_PCB: ToolCfg = {
  ...TRIO_PCB,
  fns: [
    ...TRIO_PCB.fns,
    "kicadCollabTestSaveCurrent",
    "kicadCollabSetItemsOwner",
    "kicadCollabReleaseItemsOwner",
  ],
  fixture: `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (generator_version "9.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (37 "F.SilkS" user)
    (25 "Edge.Cuts" user)
  )
  (setup)
  (net 0 "")
  (segment (start 10 10) (end 20 10) (width 0.2)
    (layer "F.Cu") (net 0) (uuid "${SEGMENT_UUID}"))
  (table (column_count 1)
    (uuid "${TABLE_UUID}")
    (layer "F.SilkS")
    (border (external yes) (header no) (stroke (width 0.15) (type solid)))
    (separators (rows yes) (cols yes) (stroke (width 0.15) (type solid)))
    (column_widths 25)
    (row_heights 10)
    (cells
      (table_cell "persistability sentinel"
        (start 20 20) (end 45 30)
        (margins 0 0 0 0)
        (span 1 1)
        (layer "F.SilkS")
        (uuid "${TABLE_CELL_UUID}")
        (effects (font (size 1.27 1.27)))
      )
    )
  )
  (group "persistability sentinel"
    (uuid "${GROUP_UUID}")
    (members "${SEGMENT_UUID}")
  )
)`,
};

const GENERATED_PCB: ToolCfg = {
  ...TRIO_PCB,
  fns: [
    ...TRIO_PCB.fns,
    "kicadCollabTestSaveCurrent",
    "kicadCollabSetItemsOwner",
    "kicadCollabReleaseItemsOwner",
  ],
  fixture: read("kicad/qa/data/pcbnew/diff_pair_uncoupled_tuning_drc.kicad_pcb"),
};

interface ItemsSnapshot {
  added: Array<{ sexpr: string }>;
  changed: unknown[];
  removed: unknown[];
}

interface RootEntry {
  id?: string;
  parent: null;
  sexpr: string;
}

interface RootBatch {
  added: RootEntry[];
  changed: RootEntry[];
  removed: string[];
}

interface PersistabilityAck {
  error?: string;
  requestId: string;
  retryable?: boolean;
  status: string;
}

interface PersistabilityWindow {
  Module: {
    kicadCollabApplyItems(json: string): unknown;
    kicadCollabSnapshotItems(): string;
    kicadCollabSetItemsOwner(owner: string): boolean;
    kicadCollabReleaseItemsOwner(owner: string): void;
    kicadCollabTestSaveCurrent(): Promise<boolean>;
  };
  kicadCollab?: Record<string, unknown> & {
    onItemsApplied?: (json: string) => void;
    onSave?: (path: string) => void;
  };
}

interface TestLogger {
  consoleLogs: string[];
  errors: string[];
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

function rootBlob(wire: ItemsSnapshot, uuid: string): string {
  const entry = wire.added.find((candidate) =>
    candidate.sexpr.toLowerCase().includes(`(uuid "${uuid.toLowerCase()}")`),
  );
  expect(entry, `native snapshot contains root ${uuid}`).toBeTruthy();
  return entry!.sexpr;
}

function generatedOwner(blob: string): string {
  const match = /\(generated\b[\s\S]*?\((?:uuid|id)\s+"?([0-9a-f-]{36})"?\)/i.exec(
    blob,
  );
  expect(match, "the real tuning-pattern blob carries its owner UUID").toBeTruthy();
  return match![1]!.toLowerCase();
}

async function snapshot(page: Page): Promise<ItemsSnapshot> {
  return JSON.parse(
    await page.evaluate(() =>
      (window as unknown as PersistabilityWindow).Module.kicadCollabSnapshotItems(),
    ),
  ) as ItemsSnapshot;
}

async function expectRejectedWithoutNativeDrift({
  page,
  cfg,
  batch,
  owner,
  requestId,
  error,
  testLogger,
}: {
  page: Page;
  cfg: ToolCfg;
  batch: RootBatch;
  owner: string;
  requestId: string;
  error: RegExp;
  testLogger: TestLogger;
}): Promise<void> {
  const beforeSave = await modelText(page, cfg);
  const beforeSnapshot = await snapshot(page);

  const result = await page.evaluate(
    async ({ requestedBatch, requestedOwner, requestedId }) => {
      const runtime = window as unknown as PersistabilityWindow;
      const acknowledgements: PersistabilityAck[] = [];
      const saveCallbacks: string[] = [];
      runtime.kicadCollab = {
        ...runtime.kicadCollab,
        onItemsApplied: (json) => acknowledgements.push(JSON.parse(json)),
        onSave: (savedPath) => saveCallbacks.push(savedPath),
      };

      const acquired = runtime.Module.kicadCollabSetItemsOwner(requestedOwner);
      runtime.Module.kicadCollabApplyItems(
        JSON.stringify({
          ...requestedBatch,
          _pcbjam: {
            requestId: requestedId,
            ownerGeneration: requestedOwner,
          },
        }),
      );

      const deadline = performance.now() + 30_000;
      while (
        !acknowledgements.some((ack) => ack.requestId === requestedId) &&
        performance.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Snapshotting exercises the same root serializer used by the Yjs seed.
      // In the zero-column-table regression this used to trap after BOARD_COMMIT;
      // invalid polygons/groups instead serialized as an empty envelope.
      const nativeSnapshot = JSON.parse(
        runtime.Module.kicadCollabSnapshotItems(),
      ) as ItemsSnapshot;
      const productionSaveAccepted =
        await runtime.Module.kicadCollabTestSaveCurrent();
      runtime.Module.kicadCollabReleaseItemsOwner(requestedOwner);

      return {
        acknowledgement: acknowledgements.find(
          (ack) => ack.requestId === requestedId,
        ),
        acquired,
        nativeSnapshot,
        productionSaveAccepted,
        saveCallbacks,
      };
    },
    {
      requestedBatch: batch,
      requestedOwner: owner,
      requestedId: requestId,
    },
  );

  // This raw test writer intentionally bypasses the acknowledged save cut. It
  // proves the rejected batch did not change even the underlying native model.
  const afterSave = await modelText(page, cfg);

  expect(result.acquired, "the test owns an otherwise-idle projection epoch").toBe(true);
  expect(result.acknowledgement, "the lossy root is rejected explicitly").toEqual(
    expect.objectContaining({
      requestId,
      retryable: false,
      status: "invalid",
    }),
  );
  expect(result.acknowledgement?.error).toMatch(error);
  expect(
    result.nativeSnapshot,
    "preflight rejection preserves every native root byte-for-byte",
  ).toEqual(beforeSnapshot);
  expect(afterSave, "the native board writer remains byte-identical").toBe(beforeSave);
  expect(fileToDoc(afterSave), "the saved semantic PCB remains unchanged").toEqual(
    fileToDoc(beforeSave),
  );
  expect(
    result.productionSaveAccepted,
    "a nonretryable projection rejection fail-stops its acknowledged save cut",
  ).toBe(false);
  expect(
    result.saveCallbacks,
    "the rejected revision is never reported as persisted",
  ).toEqual([]);
  expect(
    [...testLogger.consoleLogs, ...testLogger.errors].some((line) =>
      line.includes("Aborted("),
    ),
    "persistability rejection leaves the Wasm runtime alive",
  ).toBe(false);
}

test.describe("PCB root persistability preflight", () => {
  test.describe.configure({ timeout: 300_000 });

  test("an empty zero-column table rejects before BOARD_COMMIT instead of trapping on serialization", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, PERSISTABILITY_PCB);

    const invalidTable = `(table (column_count 0)
  (uuid "${TABLE_UUID}")
  (layer "F.SilkS")
  (border (external no) (header no))
  (separators (rows no) (cols no))
  (column_widths)
  (row_heights)
  (cells)
)`;

    await expectRejectedWithoutNativeDrift({
      page,
      cfg: PERSISTABILITY_PCB,
      batch: {
        added: [],
        changed: [{ id: TABLE_UUID, parent: null, sexpr: invalidTable }],
        removed: [],
      },
      owner: "zero-column-table-owner",
      requestId: "zero-column-table",
      error: /cell|column|persist|serializ|table/i,
      testLogger,
    });
  });

  test("an empty PCB_GROUP rejects instead of becoming an acknowledged ghost root", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, PERSISTABILITY_PCB);
    const before = await snapshot(page);
    const group = rootBlob(before, GROUP_UUID);
    const emptyGroup = group.replace(/\(members\b[^()]*\)/i, "(members)");
    expect(emptyGroup, "the wire root now has no members").not.toBe(group);

    await expectRejectedWithoutNativeDrift({
      page,
      cfg: PERSISTABILITY_PCB,
      batch: {
        added: [],
        changed: [{ id: GROUP_UUID, parent: null, sexpr: emptyGroup }],
        removed: [],
      },
      owner: "empty-group-owner",
      requestId: "empty-group",
      error: /empty|member|persist|group/i,
      testLogger,
    });
  });

  test("a two-point polygon rejects instead of applying native data the writer omits", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, PERSISTABILITY_PCB);

    const invalidPolygon = `(gr_poly
  (pts (xy 60 60) (xy 70 70))
  (stroke (width 0.2) (type solid))
  (fill none)
  (layer "F.SilkS")
  (uuid "${POLYGON_UUID}")
)`;

    await expectRejectedWithoutNativeDrift({
      page,
      cfg: PERSISTABILITY_PCB,
      batch: {
        added: [{ id: POLYGON_UUID, parent: null, sexpr: invalidPolygon }],
        changed: [],
        removed: [],
      },
      owner: "invalid-polygon-owner",
      requestId: "invalid-polygon",
      error: /point|polygon|poly|persist|serializ|shape/i,
      testLogger,
    });
  });

  test("an empty tuning-pattern generator rejects without replacing the real corpus root", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, GENERATED_PCB);
    const before = await snapshot(page);
    const generated = before.added.find((entry) => /\(generated\b/i.test(entry.sexpr));
    expect(generated, "the KiCad QA corpus contains a tuning-pattern generator").toBeTruthy();
    const owner = generatedOwner(generated!.sexpr);
    const emptyGenerator = generated!.sexpr.replace(
      /\(members\b[^()]*\)/i,
      "(members)",
    );
    expect(emptyGenerator, "the wire generator now has no members").not.toBe(
      generated!.sexpr,
    );

    await expectRejectedWithoutNativeDrift({
      page,
      cfg: GENERATED_PCB,
      batch: {
        added: [],
        changed: [{ id: owner, parent: null, sexpr: emptyGenerator }],
        removed: [],
      },
      owner: "empty-generator-owner",
      requestId: "empty-tuning-generator",
      error: /empty|generator|member|persist|rejected/i,
      testLogger,
    });
  });
});
