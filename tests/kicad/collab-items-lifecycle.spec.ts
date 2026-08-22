import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const FIRST_UUID = "aa110000-0000-0000-0000-000000000001";
const SECOND_UUID = "bb220000-0000-0000-0000-000000000002";

function board(uuid: string, x: number): string {
  return `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (generator_version "9.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (5 "F.SilkS" user)
    (25 "Edge.Cuts" user)
  )
  (setup)
  (net 0 "")
  (segment (start ${x} 10) (end ${x + 5} 10) (width 0.2)
    (layer "F.Cu") (net 0) (uuid "${uuid}"))
)`;
}

type NativeModule = {
  kicadOpenFile(path: string): unknown;
  kicadOpenFileBusy(): boolean;
  kicadCollabBusy(): boolean;
  kicadCollabSnapshotItems(): string;
  kicadCollabApplyItems(json: string): unknown;
  kicadCollabSetItemsOwner(owner: string): boolean;
  kicadCollabReleaseItemsOwner(owner: string): void;
  kicadTestSetItemsApplyPark(ms: number): void;
  kicadCollabGetPos(uuid: string): string;
};

async function boot(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(
    () =>
      typeof (window.Module as unknown as Partial<NativeModule>)?.kicadOpenFile ===
      "function",
    undefined,
    { timeout: 90_000 },
  );
}

test("programmatic open waits for an owner-scoped items commit suspended in flight", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(240_000);
  await boot(page);

  const result = await page.evaluate(
    async ({ first, second, firstUuid }) => {
      const runtime = window as unknown as {
        FS: { mkdirTree(path: string): void; writeFile(path: string, data: string): void };
        Module: NativeModule;
        kicadCollab?: { onItemsApplied?: (json: string) => void };
      };
      const dir = "/home/kicad/documents";
      try {
        runtime.FS.mkdirTree(dir);
      } catch {
        // Exists from a previous test.
      }
      const firstPath = `${dir}/owner-before-open.kicad_pcb`;
      const secondPath = `${dir}/owner-after-open.kicad_pcb`;
      runtime.FS.writeFile(firstPath, first);
      runtime.FS.writeFile(secondPath, second);

      await Promise.resolve(runtime.Module.kicadOpenFile(firstPath));
      runtime.Module.kicadCollabSnapshotItems();

      const owner = "lifecycle-e2e-owner";
      const acquired = runtime.Module.kicadCollabSetItemsOwner(owner);
      const acknowledgements: Array<{ status: string; requestId: string }> = [];
      runtime.kicadCollab = {
        ...runtime.kicadCollab,
        onItemsApplied: (json) => acknowledgements.push(JSON.parse(json)),
      };

      runtime.Module.kicadTestSetItemsApplyPark(1_500);
      runtime.Module.kicadCollabApplyItems(
        JSON.stringify({
          added: [],
          changed: [
            {
              sexpr: `(segment (start 40 40) (end 45 40) (width 0.2) (layer "F.Cu") (net 0) (uuid "${firstUuid}"))`,
              parent: null,
            },
          ],
          removed: [],
          _pcbjam: { requestId: "parked-apply", ownerGeneration: owner },
        }),
      );

      const deadline = performance.now() + 15_000;
      while (!runtime.Module.kicadCollabBusy() && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const observedApplyBusy = runtime.Module.kicadCollabBusy();

      // This embind open starts while BOARD_COMMIT owns pointers on a suspended
      // coroutine stack. It must wait for apply+flush drain before replacing the board.
      await Promise.resolve(runtime.Module.kicadOpenFile(secondPath));
      runtime.Module.kicadTestSetItemsApplyPark(0);

      const settledDeadline = performance.now() + 30_000;
      while (
        (runtime.Module.kicadOpenFileBusy() || runtime.Module.kicadCollabBusy()) &&
        performance.now() < settledDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = runtime.Module.kicadCollabSnapshotItems();
      runtime.Module.kicadCollabReleaseItemsOwner(owner);
      return { acknowledgements, acquired, observedApplyBusy, snapshot };
    },
    {
      first: board(FIRST_UUID, 10),
      second: board(SECOND_UUID, 70),
      firstUuid: FIRST_UUID,
    },
  );

  expect(result.acquired, "owner acquired only across an idle apply barrier").toBe(true);
  expect(result.observedApplyBusy, "the deterministic in-commit park engaged").toBe(true);
  expect(result.acknowledgements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ requestId: "parked-apply", status: "applied" }),
    ]),
  );
  expect(result.snapshot).toContain(SECOND_UUID);
  expect(result.snapshot).not.toContain(FIRST_UUID);
  expect(
    [...testLogger.consoleLogs, ...testLogger.errors].some((line) =>
      line.includes("Aborted("),
    ),
    "no Wasm abort/UAF while open waits for the suspended commit",
  ).toBe(false);
});

test("a malformed or identity-overlapping native batch rejects without partial mutation", async ({
  page,
  testLogger,
}) => {
  test.setTimeout(180_000);
  await boot(page);

  const result = await page.evaluate(
    async ({ content, uuid }) => {
      const runtime = window as unknown as {
        FS: { mkdirTree(path: string): void; writeFile(path: string, data: string): void };
        Module: NativeModule;
        kicadCollab?: { onItemsApplied?: (json: string) => void };
      };
      const dir = "/home/kicad/documents";
      try {
        runtime.FS.mkdirTree(dir);
      } catch {
        // Exists from a previous test.
      }
      const path = `${dir}/atomic-items.kicad_pcb`;
      runtime.FS.writeFile(path, content);
      await Promise.resolve(runtime.Module.kicadOpenFile(path));
      runtime.Module.kicadCollabSnapshotItems();

      const owner = "atomic-e2e-owner";
      const acquired = runtime.Module.kicadCollabSetItemsOwner(owner);
      const acknowledgements: Array<{ status: string; requestId: string }> = [];
      runtime.kicadCollab = {
        ...runtime.kicadCollab,
        onItemsApplied: (json) => acknowledgements.push(JSON.parse(json)),
      };
      const before = runtime.Module.kicadCollabGetPos(uuid);
      const validChanged = {
        sexpr: `(segment (start 40 40) (end 45 40) (width 0.2) (layer "F.Cu") (net 0) (uuid "${uuid}"))`,
        parent: null,
      };

      runtime.Module.kicadCollabApplyItems(
        JSON.stringify({
          added: [],
          changed: [validChanged, { sexpr: "(not-a-kicad-item", parent: null }],
          removed: [],
          _pcbjam: { requestId: "malformed-tail", ownerGeneration: owner },
        }),
      );

      const firstDeadline = performance.now() + 20_000;
      while (
        !acknowledgements.some((ack) => ack.requestId === "malformed-tail") &&
        performance.now() < firstDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const afterMalformed = runtime.Module.kicadCollabGetPos(uuid);

      runtime.Module.kicadCollabApplyItems(
        JSON.stringify({
          added: [validChanged],
          changed: [validChanged],
          removed: [],
          _pcbjam: { requestId: "overlapping-id", ownerGeneration: owner },
        }),
      );

      const secondDeadline = performance.now() + 20_000;
      while (
        !acknowledgements.some((ack) => ack.requestId === "overlapping-id") &&
        performance.now() < secondDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const afterOverlap = runtime.Module.kicadCollabGetPos(uuid);

      runtime.Module.kicadCollabApplyItems(
        JSON.stringify({
          added: [],
          changed: [{ ...validChanged, parent: "unresolved-parent" }],
          removed: [],
          _pcbjam: { requestId: "non-root-parent", ownerGeneration: owner },
        }),
      );

      const parentDeadline = performance.now() + 20_000;
      while (
        !acknowledgements.some((ack) => ack.requestId === "non-root-parent") &&
        performance.now() < parentDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const afterParent = runtime.Module.kicadCollabGetPos(uuid);
      runtime.Module.kicadCollabReleaseItemsOwner(owner);
      return {
        acknowledgements,
        acquired,
        afterMalformed,
        afterOverlap,
        afterParent,
        before,
      };
    },
    { content: board(FIRST_UUID, 10), uuid: FIRST_UUID },
  );

  expect(result.acquired).toBe(true);
  expect(result.acknowledgements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ requestId: "malformed-tail", status: "invalid" }),
      expect.objectContaining({ requestId: "overlapping-id", status: "invalid" }),
      expect.objectContaining({ requestId: "non-root-parent", status: "invalid" }),
    ]),
  );
  expect(result.afterMalformed, "valid prefix was not partially committed").toBe(result.before);
  expect(result.afterOverlap, "cross-category UUID was not staged twice").toBe(result.before);
  expect(result.afterParent, "a dangling child was not installed as a root").toBe(result.before);
  expect(
    [...testLogger.consoleLogs, ...testLogger.errors].some((line) =>
      line.includes("Aborted("),
    ),
    "invalid batches do not trap/double-delete",
  ).toBe(false);
});
