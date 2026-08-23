import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  SEG1,
  VIA1,
  TRIO_PCB,
  bootOpen,
  callHook,
  drift,
  getPos,
  modelText,
  renderDoc,
  startV2,
} from "./utils/trio";

/**
 * Save/durability refinement: a user save must not acknowledge bytes older
 * than the authoritative Y revision already queued for native projection.
 */

interface SaveProbeWindow {
  FS: {
    readFile(path: string, opts: { encoding: "utf8" }): string;
  };
  Module: {
    kicadCollabApplyItems(json: string): unknown;
    kicadCollabBusy(): boolean;
    kicadCollabTestSaveCopy(path: string): Promise<boolean>;
    kicadCollabTestSaveCurrent(): Promise<boolean>;
    kicadTestSetItemsApplyPark(ms: number): void;
  };
  KicadCollabV2: {
    applyRemoteDoc(text: string): void;
    projectionFailures(): Array<{
      kind: string;
      status?: string;
      recovery: string;
    }>;
  };
  kicadCollab?: Record<string, unknown> & { onSave?: (path: string) => void };
  __nativeApplyStatuses?: string[];
  __submittedProjection?: string[];
  __savedDuringProjection?: Array<{ path: string; text: string }>;
}

function balancedForm(text: string, head: string, uuid: string): string {
  const start = text.indexOf(`(${head}`);
  let cursor = start;
  while (cursor >= 0) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = cursor; i < text.length; i++) {
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
        if (form.includes(uuid)) return form;
        cursor = text.indexOf(`(${head}`, i + 1);
        break;
      }
    }
  }
  throw new Error(`${head} ${uuid} is missing`);
}

function segmentWidth(text: string): number {
  const match = balancedForm(text, "segment", SEG1).match(/\(width\s+([^)\s]+)\)/);
  if (!match) throw new Error(`segment ${SEG1} has no width`);
  return Number(match[1]);
}

function replaceSegmentWidth(text: string, width: string): string {
  const before = balancedForm(text, "segment", SEG1);
  const after = before.replace(/\(width\s+([^)\s]+)\)/, `(width ${width})`);
  if (before === after) throw new Error(`segment ${SEG1} width did not change`);
  return text.replace(before, after);
}

async function installProjectionProbeAndSaveCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as unknown as SaveProbeWindow;
    const submit = runtime.Module.kicadCollabApplyItems.bind(runtime.Module);
    runtime.__submittedProjection = [];
    runtime.Module.kicadCollabApplyItems = (json: string): unknown => {
      runtime.__submittedProjection!.push(json);
      return submit(json);
    };

    runtime.__savedDuringProjection = [];
    const previous = runtime.kicadCollab?.onSave;
    runtime.kicadCollab = {
      ...runtime.kicadCollab,
      onSave: (savedPath: string) => {
        runtime.__savedDuringProjection!.push({
          path: savedPath,
          text: runtime.FS.readFile(savedPath, { encoding: "utf8" }),
        });
        previous?.(savedPath);
      },
    };
  });
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

test.describe("Yjs projection and native save ordering", () => {
  test.describe.configure({ timeout: 300_000 });

  test("the real editor save cannot acknowledge stale bytes while a newer Y revision awaits native", async ({
    page,
  }) => {
    await bootOpen(page, TRIO_PCB);
    await installProjectionProbeAndSaveCapture(page);
    const seed = await modelText(page, TRIO_PCB);
    await startV2(page, {
      room: `save-projection-${test.info().workerIndex}`,
      seedText: seed,
    });

    // Make the native document genuinely dirty so the real Save accelerator is
    // enabled before the remote projection is parked.
    const beforeVia = await getPos(page, VIA1);
    expect(
      await callHook<boolean>(page, "kicadCollabTestMoveBoardItem", VIA1, 500_000, 0),
    ).toBe(true);
    await expect
      .poll(() => getPos(page, VIA1), { timeout: 20_000, intervals: [200] })
      .not.toBe(beforeVia);
    await expect
      .poll(async () => (await renderDoc(page)).ok === seed, {
        timeout: 20_000,
        intervals: [200],
      })
      .toBe(false);

    const authority0 = await renderDoc(page);
    expect(authority0.err).toBeUndefined();
    expect(segmentWidth(authority0.ok!)).toBe(0.2);
    const remote = replaceSegmentWidth(authority0.ok!, "0.55");
    const saveResult = await page.evaluate(async (text) => {
      const runtime = window as unknown as SaveProbeWindow;
      // Both operations happen in one JS turn: Y queues its native projection,
      // then the real PCB_EDIT_FRAME::SaveBoard path runs before wx has drained
      // the queued apply. The writer must drain that accepted revision first.
      runtime.KicadCollabV2.applyRemoteDoc(text);
      const busyBeforeSave = runtime.Module.kicadCollabBusy();
      const saved = await runtime.Module.kicadCollabTestSaveCurrent();
      return { busyBeforeSave, saved };
    }, remote);

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as SaveProbeWindow).__submittedProjection?.length ?? 0,
          ),
        { timeout: 15_000, intervals: [50] },
      )
      .toBe(1);
    expect(segmentWidth((await renderDoc(page)).ok!)).toBe(0.55);
    expect(saveResult.busyBeforeSave, "the projection was accepted before save").toBe(
      true,
    );
    expect(saveResult.saved, "the real editor save completed").toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as SaveProbeWindow).__savedDuringProjection?.length ?? 0,
          ),
        { timeout: 30_000, intervals: [200] },
      )
      .toBeGreaterThan(0);

    const saved = await page.evaluate(
      () =>
        (window as unknown as SaveProbeWindow).__savedDuringProjection?.find(
          ({ path: savedPath }) => savedPath.endsWith(".kicad_pcb"),
        )?.text,
    );
    expect(saved, "the editor emitted a PCB persistence acknowledgement").toBeDefined();

    // The save cut drained the accepted native entry before returning.
    await expect
      .poll(async () => segmentWidth(await modelText(page, TRIO_PCB)), {
        timeout: 30_000,
        intervals: [200],
      })
      .toBe(0.55);
    expect(
      segmentWidth(saved!),
      "the save acknowledged after Y revision 0.55 existed must include that revision",
    ).toBe(0.55);
  });

  test("the real PCB Save-a-Copy waits for its accepted Y revision and writes that exact cut", async ({
    page,
  }) => {
    await bootOpen(page, TRIO_PCB);
    const seed = await modelText(page, TRIO_PCB);
    await startV2(page, {
      room: `save-copy-projection-${test.info().workerIndex}`,
      seedText: seed,
    });

    const authority0 = await renderDoc(page);
    expect(authority0.err).toBeUndefined();
    expect(segmentWidth(authority0.ok!)).toBe(0.2);
    const remote = replaceSegmentWidth(authority0.ok!, "0.58");
    const copyPath = `/home/kicad/documents/save-copy-cut-${test.info().workerIndex}-${Date.now()}.kicad_pcb`;
    const copyResult = await page.evaluate(
      async ({ text, path: targetPath, parkMs }) => {
        const runtime = window as unknown as SaveProbeWindow;
        runtime.Module.kicadTestSetItemsApplyPark(parkMs);
        const startedAt = performance.now();

        try {
          // Submit first so this revision belongs to the copy's frozen cut.
          // The deterministic in-commit park makes an unfenced SavePcbCopy
          // serialize the old 0.2 board before this 0.58 commit can land.
          runtime.KicadCollabV2.applyRemoteDoc(text);
          const busyBeforeCopy = runtime.Module.kicadCollabBusy();
          const saved = await runtime.Module.kicadCollabTestSaveCopy(targetPath);
          const elapsedMs = performance.now() - startedAt;
          const busyAfterCopy = runtime.Module.kicadCollabBusy();
          const copied = saved
            ? runtime.FS.readFile(targetPath, { encoding: "utf8" })
            : "";
          return { busyBeforeCopy, saved, elapsedMs, busyAfterCopy, copied };
        } finally {
          runtime.Module.kicadTestSetItemsApplyPark(0);
        }
      },
      { text: remote, path: copyPath, parkMs: 1_200 },
    );

    expect(
      copyResult.busyBeforeCopy,
      "the authoritative revision was accepted before Save-a-Copy froze its cut",
    ).toBe(true);
    expect(copyResult.saved, "the real headless SavePcbCopy path completed").toBe(true);
    expect(
      copyResult.elapsedMs,
      "Save-a-Copy waited for the deliberately parked pre-cut projection",
    ).toBeGreaterThanOrEqual(800);
    expect(
      copyResult.busyAfterCopy,
      "Save-a-Copy returned only after its accepted projection queue drained",
    ).toBe(false);
    expect(
      segmentWidth(copyResult.copied),
      "copied PCB bytes contain the authoritative pre-cut revision, never the stale board",
    ).toBe(0.58);
    expect(segmentWidth((await renderDoc(page)).ok!)).toBe(0.58);
    await expect
      .poll(() => drift(page, TRIO_PCB), {
        timeout: 30_000,
        intervals: [100, 250],
      })
      .toBeNull();
  });

  test("a save deadline fails closed and a fresh native persists the converged revision", async ({
    page,
    context,
  }) => {
    await bootOpen(page, TRIO_PCB);
    await installProjectionProbeAndSaveCapture(page);
    const seed = await modelText(page, TRIO_PCB);
    await startV2(page, {
      room: `save-timeout-${test.info().workerIndex}`,
      seedText: seed,
    });

    const authority0 = await renderDoc(page);
    expect(authority0.err).toBeUndefined();
    const remote = replaceSegmentWidth(authority0.ok!, "0.77");
    const first = await page.evaluate(async (text) => {
      const runtime = window as unknown as SaveProbeWindow;
      runtime.Module.kicadTestSetItemsApplyPark(38_000);
      runtime.KicadCollabV2.applyRemoteDoc(text);
      const busyBeforeSave = runtime.Module.kicadCollabBusy();
      const saved = await runtime.Module.kicadCollabTestSaveCurrent();
      return { busyBeforeSave, saved };
    }, remote);

    expect(first.busyBeforeSave, "the projection was accepted before save").toBe(true);
    expect(first.saved, "deadline exhaustion must reject the stale save").toBe(false);
    expect(
      await page.evaluate(
        () => (window as unknown as SaveProbeWindow).__savedDuringProjection?.length ?? 0,
      ),
      "a rejected save must not emit a persistence acknowledgement",
    ).toBe(0);
    expect(segmentWidth((await renderDoc(page)).ok!)).toBe(0.77);

    await expect
      .poll(
        () =>
          page.evaluate(
            () => !(window as unknown as SaveProbeWindow).Module.kicadCollabBusy(),
          ),
        { timeout: 60_000, intervals: [200] },
      )
      .toBe(true);
    await page.evaluate(() =>
      (window as unknown as SaveProbeWindow).Module.kicadTestSetItemsApplyPark(0),
    );

    expect(
      await page.evaluate(async () =>
        (window as unknown as SaveProbeWindow).Module.kicadCollabTestSaveCurrent(),
      ),
      "the ACK-timeout owner is terminal even if its already-entered commit later drains",
    ).toBe(false);
    expect(
      await page.evaluate(
        () => (window as unknown as SaveProbeWindow).__savedDuringProjection?.length ?? 0,
      ),
      "the terminal owner never acknowledges persistence",
    ).toBe(0);
    expect(
      await page.evaluate(
        () => (window as unknown as SaveProbeWindow).KicadCollabV2.projectionFailures(),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "native-apply",
        status: "ack-timeout",
        recovery: "recreate-from-yjs",
      }),
    ]);

    // Recovery is a genuinely fresh native instance opened from canonical Y.
    // Reusing the terminalized binding would guess whether its late coroutine
    // committed; rebuilding from Y removes that ambiguity.
    const authority = await renderDoc(page);
    expect(authority.err).toBeUndefined();
    expect(segmentWidth(authority.ok!)).toBe(0.77);
    const recoveryCfg = { ...TRIO_PCB, fixture: authority.ok! };
    const recovered = await context.newPage();
    await bootOpen(recovered, recoveryCfg);
    await installProjectionProbeAndSaveCapture(recovered);
    await startV2(recovered, {
      room: `save-timeout-${test.info().workerIndex}`,
      editorMatchesDoc: true,
    });
    expect(await drift(recovered, recoveryCfg), "fresh native starts without drift").toBeNull();
    expect(
      await recovered.evaluate(async () =>
        (window as unknown as SaveProbeWindow).Module.kicadCollabTestSaveCurrent(),
      ),
      "fresh native save succeeds",
    ).toBe(true);
    await expect
      .poll(
        () =>
          recovered.evaluate(
            () => (window as unknown as SaveProbeWindow).__savedDuringProjection?.length ?? 0,
          ),
        { timeout: 20_000, intervals: [100] },
      )
      .toBeGreaterThan(0);
    const savedPcbs = await recovered.evaluate(() =>
      ((window as unknown as SaveProbeWindow).__savedDuringProjection ?? [])
        .filter(({ path: savedPath }) => savedPath.endsWith(".kicad_pcb"))
        .map(({ text }) => text),
    );
    expect(savedPcbs, "recovery emitted a PCB persistence acknowledgement").not.toHaveLength(0);
    expect(
      savedPcbs.map(segmentWidth),
      "every fresh-native save persists the authoritative revision",
    ).toEqual(savedPcbs.map(() => 0.77));
    await recovered.close();
  });

  test("an update injected by the real save callback waits until the writer lease releases", async ({
    page,
  }) => {
    await bootOpen(page, TRIO_PCB);
    await installProjectionProbeAndSaveCapture(page);
    const seed = await modelText(page, TRIO_PCB);
    await startV2(page, {
      room: `save-writer-lease-${test.info().workerIndex}`,
      seedText: seed,
    });

    // Make Save enabled without changing the segment used as the oracle.
    expect(
      await callHook<boolean>(page, "kicadCollabTestMoveBoardItem", VIA1, 500_000, 0),
    ).toBe(true);
    const authority = await renderDoc(page);
    expect(authority.err).toBeUndefined();
    const afterCut = replaceSegmentWidth(authority.ok!, "0.66");

    const saved = await page.evaluate(async (text) => {
      const runtime = window as unknown as SaveProbeWindow & {
        __injectedAfterCut?: boolean;
        __saveLeasePromise?: Promise<boolean>;
        kicadCollab?: Record<string, unknown> & {
          onSave?: (path: string) => void;
          onItemsApplied?: (json: string) => void;
        };
      };
      runtime.__nativeApplyStatuses = [];
      const previousAck = runtime.kicadCollab?.onItemsApplied;
      const previousSave = runtime.kicadCollab?.onSave;
      runtime.kicadCollab = {
        ...runtime.kicadCollab,
        onItemsApplied: (json: string) => {
          runtime.__nativeApplyStatuses!.push(
            String((JSON.parse(json) as { status?: unknown }).status),
          );
          previousAck?.(json);
        },
        onSave: (savedPath: string) => {
          previousSave?.(savedPath);
          if (!savedPath.endsWith(".kicad_pcb") || runtime.__injectedAfterCut) return;
          runtime.__injectedAfterCut = true;
          // This callback runs synchronously inside SavePcbFile. The update was
          // not in the frozen cut and must receive a retryable busy ACK until
          // the function-scope writer lease is destroyed.
          runtime.KicadCollabV2.applyRemoteDoc(text);
        },
      };
      return runtime.Module.kicadCollabTestSaveCurrent();
    }, afterCut);

    expect(saved).toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as SaveProbeWindow).__nativeApplyStatuses ?? [],
          ),
        { timeout: 30_000, intervals: [50, 100, 250] },
      )
      .toEqual(expect.arrayContaining(["busy", "applied"]));
    await expect
      .poll(async () => segmentWidth(await modelText(page, TRIO_PCB)), {
        timeout: 30_000,
        intervals: [100, 250],
      })
      .toBe(0.66);
    expect(segmentWidth((await renderDoc(page)).ok!)).toBe(0.66);

    // The after-cut retry is now part of a later cut and is durable too.
    expect(
      await page.evaluate(async () =>
        (window as unknown as SaveProbeWindow).Module.kicadCollabTestSaveCurrent(),
      ),
    ).toBe(true);
    const savedPcbs = await page.evaluate(() =>
      ((window as unknown as SaveProbeWindow).__savedDuringProjection ?? [])
        .filter(({ path: savedPath }) => savedPath.endsWith(".kicad_pcb"))
        .map(({ text }) => text),
    );
    expect(savedPcbs.map(segmentWidth)).toContain(0.66);
  });
});
