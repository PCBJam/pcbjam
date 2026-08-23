import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { settledShot } from "../e2e/utils/element-tracker";
import { expect, test } from "./fixtures";

/**
 * Context-sensitive PCB item projection.
 *
 * pcbnew's per-root wire parser uses a temporary BOARD. That board is only a
 * parsing envelope; any derived state built while the root still belongs to it
 * must be rebuilt after the root is attached to the live BOARD. This spec uses
 * a real upstream KiCad corpus board and a barcode whose geometry depends on a
 * board text variable. Replaying the byte-identical root is intentionally a
 * semantic no-op:
 *
 *   live BOARD property -> barcode geometry -> per-root wire -> live BOARD
 *
 * Both the persisted wire and the visible geometry must therefore stay equal.
 * A parser that leaves the barcode's temporary-board geometry cache in place
 * still serializes the same `(text "${COLLAB_BARCODE}")` input, but silently
 * renders a QR code for the unresolved variable instead of `acode`.
 */

const ROOT = path.resolve(__dirname, "../..");
const BARCODE_UUID = "705675f1-5a54-4ef0-bc6c-93b7d057008e";
const BOARD_PROPERTY = "COLLAB_BARCODE";
const PROBE_REQUEST_ID = "context-rebind-barcode-probe";
const RESTORE_REQUEST_ID = "context-rebind-barcode-restore";
const OWNER = "context-rebind-owner";

function replaceExactlyOnce(source: string, from: string, to: string): string {
  const first = source.indexOf(from);
  const last = source.lastIndexOf(from);

  if (first < 0 || first !== last)
    throw new Error(`expected exactly one fixture marker: ${from}`);

  return source.slice(0, first) + to + source.slice(first + from.length);
}

const UPSTREAM_KITCHEN_SINK = fs.readFileSync(
  path.join(ROOT, "kicad/qa/data/pcbnew/api_kitchen_sink.kicad_pcb"),
  "utf8",
);

const PROPERTY_BARCODE_BOARD = replaceExactlyOnce(
  replaceExactlyOnce(
    UPSTREAM_KITCHEN_SINK,
    "\t(general",
    `\t(property "${BOARD_PROPERTY}" "acode")\n\t(general`,
  ),
  '\t\t(text "acode")',
  `\t\t(text "\${${BOARD_PROPERTY}}")`,
);

interface ItemsSnapshot {
  added: Array<{ parent: string | null; sexpr: string }>;
  changed: Array<{ parent: string | null; sexpr: string }>;
  removed: string[];
}

interface ItemsAck {
  error?: string;
  ownerGeneration: string;
  requestId: string;
  retryable: boolean;
  status: string;
}

interface NativeModule {
  kicadOpenFile(path: string): unknown;
  kicadCollabApplyItems(json: string): unknown;
  kicadCollabSnapshotItems(): string;
  kicadCollabSetItemsOwner(owner: string): boolean;
  kicadCollabReleaseItemsOwner(owner: string): void;
}

interface ContextWindow {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
  };
  Module: NativeModule;
  kicadCollab?: Record<string, unknown> & {
    onItemsApplied?: (json: string) => void;
  };
}

function rootBlob(snapshot: ItemsSnapshot, uuid: string): string {
  const entry = snapshot.added.find((candidate) =>
    candidate.sexpr.toLowerCase().includes(`(uuid "${uuid.toLowerCase()}")`),
  );
  expect(entry, `native snapshot contains PCB root ${uuid}`).toBeTruthy();
  return entry!.sexpr;
}

function hasAbort(logger: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...logger.consoleLogs, ...logger.errors].some((line) =>
    line.includes("Aborted("),
  );
}

async function bootOpen(page: Page): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: 150_000 });
  await page.waitForFunction(
    () => {
      const module = (window as unknown as { Module?: Partial<NativeModule> }).Module;
      return (
        typeof module?.kicadOpenFile === "function" &&
        typeof module?.kicadCollabSnapshotItems === "function" &&
        typeof module?.kicadCollabApplyItems === "function" &&
        typeof module?.kicadCollabSetItemsOwner === "function"
      );
    },
    undefined,
    { timeout: 150_000 },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((element) =>
          /Frame$/.test(element.typeName) || (element.name || "").endsWith("Frame"),
        ),
    undefined,
    { timeout: 150_000 },
  );

  await page.evaluate((content) => {
    const runtime = window as unknown as ContextWindow;
    const directory = "/home/kicad/documents";

    try {
      runtime.FS.mkdirTree(directory);
    } catch {
      // The harness may have created it during boot.
    }

    const filename = `${directory}/context-rebind.kicad_pcb`;
    runtime.FS.writeFile(filename, content);
    runtime.Module.kicadOpenFile(filename);
  }, PROPERTY_BARCODE_BOARD);

  await expect
    .poll(() => page.title(), { timeout: 90_000, intervals: [500] })
    .toMatch(/context-rebind/i);
}

function visibleGal(page: Page): Locator {
  return page.locator('[id^="glcanvas-"]:visible').first();
}

async function snapshot(page: Page): Promise<ItemsSnapshot> {
  return page.evaluate(() =>
    JSON.parse(
      (window as unknown as ContextWindow).Module.kicadCollabSnapshotItems(),
    ) as ItemsSnapshot,
  );
}

async function applyRoot(
  page: Page,
  requestId: string,
  sexpr: string,
): Promise<ItemsAck | undefined> {
  return page.evaluate(
    async ({ owner, requestedId, rootSexpr, uuid }) => {
      const runtime = window as unknown as ContextWindow;
      const acknowledgements: ItemsAck[] = [];
      runtime.kicadCollab = {
        ...runtime.kicadCollab,
        onItemsApplied: (json) => acknowledgements.push(JSON.parse(json)),
      };

      runtime.Module.kicadCollabApplyItems(
        JSON.stringify({
          added: [],
          changed: [{ id: uuid, parent: null, sexpr: rootSexpr }],
          removed: [],
          _pcbjam: { ownerGeneration: owner, requestId: requestedId },
        }),
      );

      const deadline = performance.now() + 30_000;
      while (
        !acknowledgements.some((ack) => ack.requestId === requestedId) &&
        performance.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      return acknowledgements.find((ack) => ack.requestId === requestedId);
    },
    {
      owner: OWNER,
      requestedId: requestId,
      rootSexpr: sexpr,
      uuid: BARCODE_UUID,
    },
  );
}

test.describe("pcbnew temporary-board context rebind", () => {
  test.describe.configure({ timeout: 420_000 });

  test("identical remote barcode replay preserves board-property-derived geometry", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);

    const beforeSnapshot = await snapshot(page);
    const beforeRoot = rootBlob(beforeSnapshot, BARCODE_UUID);
    expect(beforeRoot, "wire retains the board-variable source text").toContain(
      `(text "\${${BOARD_PROPERTY}}")`,
    );

    const gal = visibleGal(page);
    await expect(gal).toBeVisible({ timeout: 30_000 });
    const beforePixels = await settledShot(gal);

    const acquired = await page.evaluate(
      (owner) =>
        (window as unknown as ContextWindow).Module.kicadCollabSetItemsOwner(owner),
      OWNER,
    );
    expect(acquired, "the test owns the native projection epoch").toBe(true);

    // First prove that this screenshot oracle is sensitive to this exact root,
    // rather than accepting a blank/off-screen WebGL capture. A literal barcode
    // is context-independent and must visibly differ from the property value.
    const probeRoot = replaceExactlyOnce(
      beforeRoot,
      `(text "\${${BOARD_PROPERTY}}")`,
      '(text "context-rebind-visual-probe")',
    );
    const probeAck = await applyRoot(page, PROBE_REQUEST_ID, probeRoot);
    expect(probeAck, "the controlled divergent root reached BOARD_COMMIT").toEqual(
      expect.objectContaining({
        ownerGeneration: OWNER,
        requestId: PROBE_REQUEST_ID,
        retryable: false,
        status: "applied",
      }),
    );
    const probePixels = await settledShot(gal);
    expect(
      probePixels.equals(beforePixels),
      "the visual oracle sees a changed barcode payload",
    ).toBe(false);

    // Restore the exact root emitted by the live board. Its input is the same
    // as before; only the derived native cache needs the live-board context.
    const restoreAck = await applyRoot(page, RESTORE_REQUEST_ID, beforeRoot);
    expect(restoreAck, "the original root reached BOARD_COMMIT").toEqual(
      expect.objectContaining({
        ownerGeneration: OWNER,
        requestId: RESTORE_REQUEST_ID,
        retryable: false,
        status: "applied",
      }),
    );

    const afterPixels = await settledShot(gal);
    const afterSnapshot = await snapshot(page);
    const afterRoot = rootBlob(afterSnapshot, BARCODE_UUID);

    // This is the important split oracle: the writer cannot expose a stale
    // derived cache. It reports an exact no-op even when the visible native
    // geometry was assembled against the wrong BOARD.
    expect(afterRoot, "the persisted root is still byte-identical").toBe(beforeRoot);
    expect(
      afterPixels.equals(beforePixels),
      "an identical Yjs root must not change board-property-derived native geometry",
    ).toBe(true);

    await page.evaluate(
      (owner) =>
        (window as unknown as ContextWindow).Module.kicadCollabReleaseItemsOwner(owner),
      OWNER,
    );
    expect(hasAbort(testLogger), "no Wasm abort while rebinding context").toBe(false);
  });
});
