import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { fileToDoc } from "../../web/pcbjam-shared/src/index.js";
import { expect, test } from "./fixtures";
import { clickMenuItem, findRenderedByType } from "../e2e/utils/element-tracker";
import {
  FP1,
  PAD1,
  TRIO_PCB,
  bootOpen,
  callHook,
  modelText,
  type ToolCfg,
} from "./utils/trio";

/**
 * Real-Wasm regressions for KiCad's PCB root identity and pointer-based
 * PCB_GROUP/PCB_GENERATOR relations. These intentionally send isolated root
 * blobs, exactly as the Yjs projector does. KiCad's parser can only resolve
 * `(members ...)` while parsing a complete BOARD, so the collaboration applier
 * must validate and rebind the complete UUID graph after every root in the
 * batch is known.
 */

const ROOT = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  fs.readFileSync(path.join(ROOT, relative), "utf8");

const GROUPED_PCB: ToolCfg = {
  ...TRIO_PCB,
  fixture: read("kicad/demos/stickhub/StickHub.kicad_pcb"),
};
const GENERATED_PCB: ToolCfg = {
  ...TRIO_PCB,
  fixture: read("kicad/qa/data/pcbnew/diff_pair_uncoupled_tuning_drc.kicad_pcb"),
};
const POINTER_HOOKS = [
  "kicadCollabGetSelection",
  "kicadCollabTestSelectByUuid",
  "kicadCollabTestClearSelection",
];
const GROUPED_POINTER_PCB: ToolCfg = {
  ...GROUPED_PCB,
  fns: [...GROUPED_PCB.fns, ...POINTER_HOOKS],
};
const CHILD_POINTER_PCB: ToolCfg = {
  ...TRIO_PCB,
  fns: [...TRIO_PCB.fns, ...POINTER_HOOKS],
};

const TABLE_ROOT_UUID = "91919191-0000-0000-0000-000000000001";
const TABLE_CELL_UUID = "91919191-0000-0000-0000-0000000000c1";
const TABLE_REPLACEMENT_CELL_UUID = "91919191-0000-0000-0000-0000000000c2";
const TABLE_PCB: ToolCfg = {
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
  (table (column_count 1)
    (uuid "${TABLE_ROOT_UUID}")
    (layer "F.SilkS")
    (border (external yes) (header no) (stroke (width 0.15) (type solid)))
    (separators (rows yes) (cols yes) (stroke (width 0.15) (type solid)))
    (column_widths 25)
    (row_heights 10)
    (cells
      (table_cell "identity sentinel"
        (start 20 20) (end 45 30)
        (margins 0 0 0 0)
        (span 1 1)
        (layer "F.SilkS")
        (uuid "${TABLE_CELL_UUID}")
        (effects (font (size 1.27 1.27)))
      )
    )
  )
)`,
};

interface ItemsSnapshot {
  added: Array<{ sexpr: string }>;
}

interface ReferenceWindow {
  FS: {
    readFile(path: string, opts: { encoding: "utf8" }): string;
  };
  Module: {
    kicadCollabBusy(): boolean;
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
  __pcbReferenceSaves?: Array<{ path: string; text: string }>;
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

function balancedForm(text: string, head: "group" | "generated", uuid: string): string {
  let cursor = text.indexOf(`(${head}`);

  while (cursor >= 0) {
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let i = cursor; i < text.length; i += 1) {
      const char = text[i]!;

      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }

      if (char === '"') quoted = true;
      else if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) {
        const form = text.slice(cursor, i + 1);
        if (form.toLowerCase().includes(uuid.toLowerCase())) return form;
        cursor = text.indexOf(`(${head}`, i + 1);
        break;
      }
    }
  }

  throw new Error(`${head} ${uuid} is missing`);
}

function memberUuids(ownerForm: string): string[] {
  const members = /\(members\b([^()]*)\)/i.exec(ownerForm)?.[1];
  if (members === undefined) throw new Error("reference owner has no direct members form");

  return [
    ...members.matchAll(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ),
  ]
    .map(([uuid]) => uuid.toLowerCase())
    .sort();
}

async function snapshot(page: Page): Promise<ItemsSnapshot> {
  return JSON.parse(
    await callHook<string>(page, "kicadCollabSnapshotItems"),
  ) as ItemsSnapshot;
}

async function applyChangedRoot(page: Page, id: string, sexpr: string): Promise<void> {
  await callHook(
    page,
    "kicadCollabApplyItems",
    JSON.stringify({
      added: [],
      changed: [{ id, parent: null, sexpr }],
      removed: [],
    }),
  );
  await page.waitForFunction(
    () => !(window as unknown as ReferenceWindow).Module.kicadCollabBusy(),
    null,
    { timeout: 30_000 },
  );
}

async function applyRemovedRoot(page: Page, id: string): Promise<void> {
  await callHook(
    page,
    "kicadCollabApplyItems",
    JSON.stringify({
      added: [],
      changed: [],
      removed: [id],
    }),
  );
  await page.waitForFunction(
    () => !(window as unknown as ReferenceWindow).Module.kicadCollabBusy(),
    null,
    { timeout: 30_000 },
  );
}

async function selection(page: Page): Promise<string[]> {
  return JSON.parse(
    await callHook<string>(page, "kicadCollabGetSelection"),
  ) as string[];
}

async function expectSelection(page: Page, expected: string[]): Promise<void> {
  const sortedExpected = [...expected].sort();
  await expect
    .poll(async () => [...(await selection(page))].sort(), {
      timeout: 15_000,
      intervals: [50, 100, 250],
    })
    .toEqual(sortedExpected);
}

async function enterRealGroup(page: Page, groupUuid: string, members: string[]): Promise<void> {
  expect(
    await callHook<boolean>(page, "kicadCollabTestSelectByUuid", groupUuid),
    "the real group resolves through KiCad's selection tool",
  ).toBe(true);
  await expectSelection(page, [groupUuid]);

  const canvas = page.locator('[id^="glcanvas-"]:visible').first();
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  const box = await canvas.boundingBox();
  expect(box, "the real GAL canvas has an interactive bounding box").not.toBeNull();
  await page.mouse.click(
    Math.round(box!.x + box!.width / 2),
    Math.round(box!.y + box!.height / 2),
    { button: "right" },
  );

  await expect
    .poll(
      async () =>
        (await findRenderedByType(page, "menuitem", { parentId: "popupmenu" })).map(
          (item) => item.label,
        ),
      {
        timeout: 15_000,
        intervals: [50, 100, 250],
        message: "the selected PCB_GROUP exposes KiCad's real Enter Group action",
      },
    )
    .toContain("Enter Group");
  expect(await clickMenuItem(page, "Enter Group"), "the real group-enter action fires").toBe(
    true,
  );

  // EnterGroup replaces the selected owner with all direct members. This is a
  // behavioral proof that PCB_SELECTION_TOOL::m_enteredGroup is populated;
  // no test-only native hook is involved.
  await expectSelection(page, members);
}

async function waitForNativeRoot(page: Page, uuid: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await snapshot(page)).added.some((entry) =>
          entry.sexpr.toLowerCase().includes(uuid.toLowerCase()),
        ),
      { timeout: 30_000, intervals: [50, 100, 250] },
    )
    .toBe(true);
}

function expectNoWasmAbort(logger: { consoleLogs: string[]; errors: string[] }, label: string): void {
  expect(
    [...logger.consoleLogs, ...logger.errors].some((line) => line.includes("Aborted(")),
    label,
  ).toBe(false);
}

async function saveCurrentBytes(page: Page): Promise<string> {
  await page.evaluate(() => {
    const runtime = window as unknown as ReferenceWindow;
    const previous = runtime.kicadCollab?.onSave;
    runtime.__pcbReferenceSaves = [];
    runtime.kicadCollab = {
      ...runtime.kicadCollab,
      onSave: (savedPath: string) => {
        runtime.__pcbReferenceSaves!.push({
          path: savedPath,
          text: runtime.FS.readFile(savedPath, { encoding: "utf8" }),
        });
        previous?.(savedPath);
      },
    };
  });

  expect(
    await page.evaluate(async () =>
      (window as unknown as ReferenceWindow).Module.kicadCollabTestSaveCurrent(),
    ),
    "the production PCB_EDIT_FRAME save completed",
  ).toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as ReferenceWindow).__pcbReferenceSaves?.length ?? 0,
        ),
      { timeout: 30_000, intervals: [100] },
    )
    .toBeGreaterThan(0);

  const saved = await page.evaluate(() => {
    const writes = (window as unknown as ReferenceWindow).__pcbReferenceSaves ?? [];
    return [...writes].reverse().find(({ path: savedPath }) =>
      savedPath.endsWith(".kicad_pcb"),
    )?.text;
  });
  expect(saved, "onSave exposed the exact persisted PCB bytes").toBeDefined();
  return saved!;
}

function ownerFromDocument(
  text: string,
  type: "group" | "generated",
): { id: string; item: ReturnType<typeof fileToDoc>["items"][string] } {
  const match = Object.entries(fileToDoc(text).items).find(([, item]) => item.type === type);
  expect(match, `real corpus contains a ${type} root`).toBeTruthy();
  return { id: match![0], item: match![1] };
}

function rootBlob(wire: ItemsSnapshot, uuid: string): string {
  const entry = wire.added.find((candidate) =>
    candidate.sexpr.toLowerCase().includes(`(uuid "${uuid.toLowerCase()}")`),
  );
  expect(entry, `native snapshot contains root ${uuid}`).toBeTruthy();
  return entry!.sexpr;
}

test.describe("PCB root identity/reference closure", () => {
  test.describe.configure({ timeout: 300_000 });

  test("identical StickHub group apply -> production save preserves every member", async ({
    page,
  }) => {
    await bootOpen(page, GROUPED_PCB);
    const normalized = await modelText(page, GROUPED_PCB);
    const source = ownerFromDocument(normalized, "group");
    const wire = await snapshot(page);
    const blob = rootBlob(wire, source.id);
    const expectedMembers = memberUuids(balancedForm(blob, "group", source.id));
    expect(expectedMembers.length, "the real group has reference-bearing members").toBeGreaterThan(
      0,
    );

    await applyChangedRoot(page, source.id, blob);
    const persisted = await saveCurrentBytes(page);

    expect(fileToDoc(persisted).items[source.id], "saved group AST is exact").toEqual(source.item);
    expect(memberUuids(balancedForm(persisted, "group", source.id))).toEqual(expectedMembers);
  });

  test("identical tuning generator apply -> save preserves every generated reference", async ({
    page,
  }) => {
    await bootOpen(page, GENERATED_PCB);
    const normalized = await modelText(page, GENERATED_PCB);
    const source = ownerFromDocument(normalized, "generated");
    const wire = await snapshot(page);
    const blob = rootBlob(wire, source.id);
    const expectedMembers = memberUuids(balancedForm(blob, "generated", source.id));
    expect(
      expectedMembers.length,
      "the real tuning generator has reference-bearing members",
    ).toBeGreaterThan(0);

    await applyChangedRoot(page, source.id, blob);
    const saved = await modelText(page, GENERATED_PCB);

    expect(fileToDoc(saved).items[source.id], "saved generator AST is exact").toEqual(source.item);
    expect(memberUuids(balancedForm(saved, "generated", source.id))).toEqual(expectedMembers);
  });

  test("replacing a known StickHub member preserves its group through production save", async ({
    page,
  }) => {
    await bootOpen(page, GROUPED_PCB);
    const normalized = await modelText(page, GROUPED_PCB);
    const source = ownerFromDocument(normalized, "group");
    const wire = await snapshot(page);
    const groupBlob = rootBlob(wire, source.id);
    const expectedMembers = memberUuids(balancedForm(groupBlob, "group", source.id));
    const member = expectedMembers
      .map((id) => ({ id, blob: rootBlob(wire, id) }))
      .find(({ blob }) => !blob.includes(`(group `) && !blob.includes(`(generated`));
    expect(member, "the real group has a replaceable non-owner root member").toBeTruthy();

    await applyChangedRoot(page, member!.id, member!.blob);
    const persisted = await saveCurrentBytes(page);

    expect(fileToDoc(persisted).items[source.id], "saved group AST is exact").toEqual(source.item);
    expect(memberUuids(balancedForm(persisted, "group", source.id))).toEqual(expectedMembers);
    expect(
      memberUuids(balancedForm(persisted, "group", source.id)),
      "replacement UUID remains owned by the group",
    ).toContain(member!.id);
  });

  test("remote replacement clears a real entered-group pointer before retiring the root", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, GROUPED_POINTER_PCB);
    const source = ownerFromDocument(
      await modelText(page, GROUPED_POINTER_PCB),
      "group",
    );
    const before = await snapshot(page);
    const groupBlob = rootBlob(before, source.id);
    const expectedMembers = memberUuids(balancedForm(groupBlob, "group", source.id));
    expect(expectedMembers.length, "the real StickHub group is not empty").toBeGreaterThan(0);

    await enterRealGroup(page, source.id, expectedMembers);
    await applyChangedRoot(page, source.id, groupBlob);

    // The projection replaced the exact BOARD_ITEM pointer that EnterGroup
    // retained. The selection and entered-group caches must be cleared before
    // BOARD_COMMIT retires it, while the replacement UUID remains selectable.
    await expectSelection(page, []);
    expect(
      await callHook<boolean>(page, "kicadCollabTestSelectByUuid", source.id),
      "the replacement group resolves through a fresh native pointer",
    ).toBe(true);
    await expectSelection(page, [source.id]);

    // BOARD_COMMIT consults GetEnteredGroup when adding a root. If the old
    // pointer survived, this is a deterministic use-after-free surface; if an
    // implementation incorrectly rebound entered state, it would also adopt
    // the new text into the group.
    const addedUuid = await callHook<string>(
      page,
      "kicadCollabTestAddBoardText",
      "after-group-replace",
      180_000_000,
      120_000_000,
      "F.SilkS",
    );
    expect(addedUuid, "the post-replacement native action returns a UUID").not.toBe("");
    await waitForNativeRoot(page, addedUuid);

    const after = await snapshot(page);
    const reboundGroup = rootBlob(after, source.id);
    expect(memberUuids(balancedForm(reboundGroup, "group", source.id))).toEqual(
      expectedMembers,
    );
    expect(reboundGroup, "post-replacement additions stay outside the exited group").not.toContain(
      addedUuid,
    );

    expect(await callHook<boolean>(page, "kicadCollabTestClearSelection")).toBe(true);
    await expectSelection(page, []);
    expect(page.isClosed(), "the Wasm editor remains alive after pointer retirement").toBe(false);
    expectNoWasmAbort(
      testLogger,
      "entered-group replacement and the following native action do not abort Wasm",
    );
  });

  test("remote removal clears a real entered-group pointer before retiring the owner", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, GROUPED_POINTER_PCB);
    const source = ownerFromDocument(
      await modelText(page, GROUPED_POINTER_PCB),
      "group",
    );
    const before = await snapshot(page);
    const groupBlob = rootBlob(before, source.id);
    const expectedMembers = memberUuids(balancedForm(groupBlob, "group", source.id));

    await enterRealGroup(page, source.id, expectedMembers);
    await applyRemovedRoot(page, source.id);

    await expectSelection(page, []);
    expect(
      await callHook<boolean>(page, "kicadCollabTestSelectByUuid", source.id),
      "the removed group UUID no longer resolves",
    ).toBe(false);

    const addedUuid = await callHook<string>(
      page,
      "kicadCollabTestAddBoardText",
      "after-group-remove",
      185_000_000,
      125_000_000,
      "F.SilkS",
    );
    expect(addedUuid, "native editing continues after group retirement").not.toBe("");
    await waitForNativeRoot(page, addedUuid);
    expect(
      await callHook<boolean>(page, "kicadCollabTestSelectByUuid", addedUuid),
      "the selection tool resolves a post-removal root",
    ).toBe(true);
    await expectSelection(page, [addedUuid]);

    const after = await snapshot(page);
    expect(
      after.added.some((entry) =>
        entry.sexpr.toLowerCase().includes(source.id.toLowerCase()),
      ),
      "the retired group is absent from the native root universe",
    ).toBe(false);
    expect(page.isClosed(), "the Wasm editor remains alive after group removal").toBe(false);
    expectNoWasmAbort(
      testLogger,
      "entered-group removal and the following selection/native actions do not abort Wasm",
    );
  });

  test("footprint replacement clears a selected child pointer and selects the new child safely", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, CHILD_POINTER_PCB);
    const before = await snapshot(page);
    const footprintBlob = rootBlob(before, FP1);
    expect(footprintBlob, "the parent root owns the selected pad").toContain(PAD1);

    expect(
      await callHook<boolean>(page, "kicadCollabTestSelectByUuid", PAD1),
      "the original footprint child resolves",
    ).toBe(true);
    await expectSelection(page, [PAD1]);

    await applyChangedRoot(page, FP1, footprintBlob);
    await expectSelection(page, []);

    expect(
      await callHook<boolean>(page, "kicadCollabTestSelectByUuid", PAD1),
      "the replacement footprint's child resolves by the same durable UUID",
    ).toBe(true);
    await expectSelection(page, [PAD1]);
    expect(await callHook<boolean>(page, "kicadCollabTestClearSelection")).toBe(true);
    await expectSelection(page, []);

    expect(
      await callHook<boolean>(page, "kicadCollabTestSetPadSize", PAD1, 2_000_000, 2_000_000),
      "a native action resolves and mutates the replacement child",
    ).toBe(true);
    await expect
      .poll(async () => rootBlob(await snapshot(page), FP1), {
        timeout: 30_000,
        intervals: [50, 100, 250],
      })
      .not.toBe(footprintBlob);

    expect(page.isClosed(), "the Wasm editor survives child pointer retirement").toBe(false);
    expectNoWasmAbort(
      testLogger,
      "selected-child replacement and following selection/native actions do not abort Wasm",
    );
  });

  test("a root upsert cannot reuse an unrelated live table-cell UUID", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, TABLE_PCB);
    const beforeSave = await modelText(page, TABLE_PCB);
    const beforeSnapshot = await snapshot(page);
    const tableBlob = rootBlob(beforeSnapshot, TABLE_ROOT_UUID);
    expect(tableBlob, "the live table owns the collision target as a nested child").toContain(
      `(uuid "${TABLE_CELL_UUID}")`,
    );

    const result = await page.evaluate(
      async ({ childUuid }) => {
        const runtime = window as unknown as ReferenceWindow;
        const owner = "table-child-collision-owner";
        const requestId = "table-child-as-root";
        const acknowledgements: Array<{
          error?: string;
          requestId: string;
          retryable?: boolean;
          status: string;
        }> = [];
        const saveCallbacks: string[] = [];
        runtime.kicadCollab = {
          ...runtime.kicadCollab,
          onItemsApplied: (json) => acknowledgements.push(JSON.parse(json)),
          onSave: (savedPath) => saveCallbacks.push(savedPath),
        };

        const acquired = runtime.Module.kicadCollabSetItemsOwner(owner);

        // Before the complete root-tree preflight, this non-footprint child
        // bypassed the GetParentFootprint-only guard. BOARD_COMMIT then lifted
        // its removal to the unrelated table while installing this segment as
        // a root with the table cell's identity.
        runtime.Module.kicadCollabApplyItems(
          JSON.stringify({
            added: [
              {
                parent: null,
                sexpr: `(segment (start 70 70) (end 80 70) (width 0.2) (layer "F.Cu") (net 0) (uuid "${childUuid}"))`,
              },
            ],
            changed: [],
            removed: [],
            _pcbjam: { requestId, ownerGeneration: owner },
          }),
        );

        const deadline = performance.now() + 30_000;
        while (
          !acknowledgements.some((ack) => ack.requestId === requestId) &&
          performance.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const nativeSnapshot = JSON.parse(
          runtime.Module.kicadCollabSnapshotItems(),
        ) as ItemsSnapshot;
        const productionSaveAccepted =
          await runtime.Module.kicadCollabTestSaveCurrent();
        runtime.Module.kicadCollabReleaseItemsOwner(owner);

        return {
          acknowledgement: acknowledgements.find((ack) => ack.requestId === requestId),
          acquired,
          nativeSnapshot,
          productionSaveAccepted,
          saveCallbacks,
        };
      },
      { childUuid: TABLE_CELL_UUID },
    );
    const afterSave = await modelText(page, TABLE_PCB);

    expect(result.acquired).toBe(true);
    expect(result.acknowledgement, "the malformed projection is explicitly rejected").toEqual(
      expect.objectContaining({
        requestId: "table-child-as-root",
        retryable: false,
        status: "invalid",
      }),
    );
    expect(result.acknowledgement?.error).toMatch(/child|collid/i);
    expect(result.nativeSnapshot, "rejection leaves every native root byte-for-byte intact").toEqual(
      beforeSnapshot,
    );
    expect(afterSave, "a direct native save remains byte-identical after rejection").toBe(
      beforeSave,
    );
    expect(fileToDoc(afterSave), "the saved semantic document is unchanged").toEqual(
      fileToDoc(beforeSave),
    );
    expect(
      result.productionSaveAccepted,
      "a terminal rejected projection fail-stops the acknowledged persistence cut",
    ).toBe(false);
    expect(result.saveCallbacks, "no rejected state is reported as persisted").toEqual([]);
    expect(
      [...testLogger.consoleLogs, ...testLogger.errors].some((line) =>
        line.includes("Aborted("),
      ),
      "collision rejection does not trap or corrupt Wasm",
    ).toBe(false);
  });

  test("a bare nested table-cell removal is rejected atomically and fail-stops save", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, TABLE_PCB);
    const beforeSave = await modelText(page, TABLE_PCB);
    const beforeSnapshot = await snapshot(page);
    expect(rootBlob(beforeSnapshot, TABLE_ROOT_UUID)).toContain(
      `(uuid "${TABLE_CELL_UUID}")`,
    );

    const result = await page.evaluate(
      async ({ childUuid }) => {
        const runtime = window as unknown as ReferenceWindow;
        const owner = "table-child-removal-owner";
        const requestId = "bare-table-child-removal";
        const acknowledgements: Array<{
          error?: string;
          requestId: string;
          retryable?: boolean;
          status: string;
        }> = [];
        const saveCallbacks: string[] = [];
        runtime.kicadCollab = {
          ...runtime.kicadCollab,
          onItemsApplied: (json) => acknowledgements.push(JSON.parse(json)),
          onSave: (savedPath) => saveCallbacks.push(savedPath),
        };

        const acquired = runtime.Module.kicadCollabSetItemsOwner(owner);
        runtime.Module.kicadCollabApplyItems(
          JSON.stringify({
            added: [],
            changed: [],
            removed: [childUuid],
            _pcbjam: { requestId, ownerGeneration: owner },
          }),
        );

        const deadline = performance.now() + 30_000;
        while (
          !acknowledgements.some((ack) => ack.requestId === requestId) &&
          performance.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const nativeSnapshot = JSON.parse(
          runtime.Module.kicadCollabSnapshotItems(),
        ) as ItemsSnapshot;
        const productionSaveAccepted =
          await runtime.Module.kicadCollabTestSaveCurrent();
        runtime.Module.kicadCollabReleaseItemsOwner(owner);

        return {
          acknowledgement: acknowledgements.find((ack) => ack.requestId === requestId),
          acquired,
          nativeSnapshot,
          productionSaveAccepted,
          saveCallbacks,
        };
      },
      { childUuid: TABLE_CELL_UUID },
    );
    const afterSave = await modelText(page, TABLE_PCB);

    expect(result.acquired).toBe(true);
    expect(result.acknowledgement).toEqual(
      expect.objectContaining({
        requestId: "bare-table-child-removal",
        retryable: false,
        status: "invalid",
      }),
    );
    expect(result.acknowledgement?.error).toMatch(/child|nested|root|owned/i);
    expect(result.nativeSnapshot, "preflight rejection preserves every native root").toEqual(
      beforeSnapshot,
    );
    expect(afterSave, "direct native serialization remains byte-identical").toBe(beforeSave);
    expect(fileToDoc(afterSave), "the native semantic document is unchanged").toEqual(
      fileToDoc(beforeSave),
    );
    expect(
      result.productionSaveAccepted,
      "a nonretryable child-removal rejection blocks the acknowledged save cut",
    ).toBe(false);
    expect(result.saveCallbacks, "rejected native state is never reported persisted").toEqual([]);
    expect(
      [...testLogger.consoleLogs, ...testLogger.errors].some((line) =>
        line.includes("Aborted("),
      ),
      "child-removal rejection does not trap or corrupt Wasm",
    ).toBe(false);
  });

  test("a nested table-cell removal with its complete replacement root saves exactly", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, TABLE_PCB);
    const beforeSave = await modelText(page, TABLE_PCB);
    const beforeSnapshot = await snapshot(page);
    const originalTable = rootBlob(beforeSnapshot, TABLE_ROOT_UUID);
    const replacementTable = originalTable
      .replace(TABLE_CELL_UUID, TABLE_REPLACEMENT_CELL_UUID)
      .replace("identity sentinel", "replacement sentinel");
    expect(replacementTable).not.toContain(TABLE_CELL_UUID);
    expect(replacementTable).toContain(TABLE_REPLACEMENT_CELL_UUID);

    const result = await page.evaluate(
      async ({ childUuid, ownerUuid, replacement }) => {
        const runtime = window as unknown as ReferenceWindow;
        const owner = "table-root-replacement-owner";
        const requestId = "table-child-with-root-replacement";
        const acknowledgements: Array<{
          error?: string;
          requestId: string;
          retryable?: boolean;
          status: string;
        }> = [];
        runtime.kicadCollab = {
          ...runtime.kicadCollab,
          onItemsApplied: (json) => acknowledgements.push(JSON.parse(json)),
        };

        const acquired = runtime.Module.kicadCollabSetItemsOwner(owner);
        runtime.Module.kicadCollabApplyItems(
          JSON.stringify({
            added: [],
            changed: [{ id: ownerUuid, parent: null, sexpr: replacement }],
            removed: [childUuid],
            _pcbjam: { requestId, ownerGeneration: owner },
          }),
        );

        const deadline = performance.now() + 30_000;
        while (
          !acknowledgements.some((ack) => ack.requestId === requestId) &&
          performance.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        while (runtime.Module.kicadCollabBusy() && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const nativeSnapshot = JSON.parse(
          runtime.Module.kicadCollabSnapshotItems(),
        ) as ItemsSnapshot;
        runtime.Module.kicadCollabReleaseItemsOwner(owner);

        return {
          acknowledgement: acknowledgements.find((ack) => ack.requestId === requestId),
          acquired,
          nativeSnapshot,
        };
      },
      {
        childUuid: TABLE_CELL_UUID,
        ownerUuid: TABLE_ROOT_UUID,
        replacement: replacementTable,
      },
    );
    const persisted = await saveCurrentBytes(page);
    const expected = beforeSave
      .replace(TABLE_CELL_UUID, TABLE_REPLACEMENT_CELL_UUID)
      .replace("identity sentinel", "replacement sentinel");
    const savedTable = fileToDoc(persisted).items[TABLE_ROOT_UUID];

    expect(result.acquired).toBe(true);
    expect(result.acknowledgement).toEqual(
      expect.objectContaining({
        requestId: "table-child-with-root-replacement",
        status: "applied",
      }),
    );
    expect(rootBlob(result.nativeSnapshot, TABLE_ROOT_UUID)).not.toContain(TABLE_CELL_UUID);
    expect(rootBlob(result.nativeSnapshot, TABLE_ROOT_UUID)).toContain(
      TABLE_REPLACEMENT_CELL_UUID,
    );
    expect(persisted).not.toContain(TABLE_CELL_UUID);
    expect(persisted).toContain(TABLE_REPLACEMENT_CELL_UUID);
    expect(savedTable, "the saved table equals the complete desired replacement root").toEqual(
      fileToDoc(expected).items[TABLE_ROOT_UUID],
    );
    expect(
      [...testLogger.consoleLogs, ...testLogger.errors].some((line) =>
        line.includes("Aborted("),
      ),
      "valid root replacement does not trap or corrupt Wasm",
    ).toBe(false);
  });
});
