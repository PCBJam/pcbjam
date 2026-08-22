import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  bootOpen,
  drift,
  hasAbort,
  modelText,
  renderDoc,
  SEG1,
  startV2,
  TRIO_PCB,
  type ToolCfg,
} from "./utils/trio";

/**
 * Real-Wasm refinement for the central three-way native publication rebase.
 *
 * The binding has submitted a newer remote segment width, but a deterministic
 * test boundary holds that one native submission before it enters Wasm. The
 * native editor is therefore genuinely stale and idle when a real BOARD_COMMIT
 * moves the same segment's endpoint. Its emitted whole-item blob still carries
 * the old width. Production rebase must retain the remote width and the local
 * endpoint instead of letting that stale blob roll the width back.
 */

interface ProjectionFailure {
  kind: string;
  message: string;
  status?: string;
  recovery: string;
}

interface RebaseProbeModule {
  kicadCollabApplyItems(json: string): unknown;
  kicadCollabBusy(): boolean;
  kicadCollabTestMoveEndpoint(uuid: string, dx: number, dy: number): boolean;
}

interface RebaseProbeWindow {
  Module: RebaseProbeModule;
  KicadCollabV2: {
    applyRemoteDoc(fileText: string): void;
    projectionFailures(): ProjectionFailure[];
  };
  __holdNextNativeApply?: boolean;
  __heldNativeApplies?: string[];
}

function balancedForms(text: string, head: string): string[] {
  const forms: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(`(${head}`, cursor);
    if (start < 0) break;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`unterminated (${head} …) form`);
    forms.push(text.slice(start, end));
    cursor = end;
  }
  return forms;
}

function segmentForm(text: string, uuid: string): string {
  const form = balancedForms(text, "segment").find((candidate) => candidate.includes(uuid));
  if (!form) throw new Error(`segment ${uuid} is missing`);
  return form;
}

function replaceSegmentWidth(text: string, uuid: string, width: string): string {
  const before = segmentForm(text, uuid);
  const after = before.replace(/\(width [^)]+\)/, `(width ${width})`);
  if (after === before) throw new Error(`segment ${uuid} has no width field`);
  return text.replace(before, after);
}

function segmentState(text: string, uuid: string): { width: number; end: [number, number] } {
  const segment = segmentForm(text, uuid);
  const width = segment.match(/\(width\s+(-?(?:\d+(?:\.\d*)?|\.\d+))\)/);
  const end = segment.match(
    /\(end\s+(-?(?:\d+(?:\.\d*)?|\.\d+))\s+(-?(?:\d+(?:\.\d*)?|\.\d+))\)/,
  );
  if (!width || !end) throw new Error(`segment ${uuid} omitted width or end`);
  return { width: Number(width[1]), end: [Number(end[1]), Number(end[2])] };
}

function projectionFailures(page: Page): Promise<ProjectionFailure[]> {
  return page.evaluate(() =>
    (window as unknown as RebaseProbeWindow).KicadCollabV2.projectionFailures(),
  );
}

function installOneShotNativeSubmissionHold(page: Page): Promise<void> {
  return page.evaluate(() => {
    const runtime = window as unknown as RebaseProbeWindow;
    const submit = runtime.Module.kicadCollabApplyItems.bind(runtime.Module);
    runtime.__heldNativeApplies = [];
    runtime.__holdNextNativeApply = false;
    runtime.Module.kicadCollabApplyItems = (json: string): unknown => {
      if (runtime.__holdNextNativeApply) {
        runtime.__holdNextNativeApply = false;
        runtime.__heldNativeApplies!.push(json);
        return undefined;
      }
      return submit(json);
    };
  });
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

test.describe("Yjs native three-way rebase — real Wasm refinement", () => {
  test.describe.configure({ timeout: 240_000 });

  test("a genuine stale-native endpoint edit preserves a disjoint newer Y width", async ({
    page,
    context,
    testLogger,
  }) => {
    const room = `ysync-native-rebase-${test.info().workerIndex}`;
    let recovered: Page | undefined;
    const recoveredAborts: string[] = [];

    try {
      await bootOpen(page, TRIO_PCB);
      const nativeSeed = await modelText(page, TRIO_PCB);
      expect(segmentState(nativeSeed, SEG1)).toEqual({ width: 0.2, end: [101.6, 50.8] });

      // Install before attach so the acknowledged bridge captures this exact
      // module boundary. Only the explicitly armed next submission is held;
      // seed/adopt and every other native export remain production behavior.
      await installOneShotNativeSubmissionHold(page);
      await startV2(page, { room, seedText: nativeSeed });

      const seeded = await renderDoc(page);
      expect(seeded.err, "seeded room must materialize").toBeUndefined();
      const remote = replaceSegmentWidth(seeded.ok!, SEG1, "0.55");

      await page.evaluate((fileText) => {
        const runtime = window as unknown as RebaseProbeWindow;
        runtime.__holdNextNativeApply = true;
        runtime.KicadCollabV2.applyRemoteDoc(fileText);
      }, remote);

      await expect
        .poll(
          () =>
            page.evaluate(
              () => (window as unknown as RebaseProbeWindow).__heldNativeApplies?.length ?? 0,
            ),
          { timeout: 10_000, intervals: [50] },
        )
        .toBe(1);

      const held = await page.evaluate(
        () => (window as unknown as RebaseProbeWindow).__heldNativeApplies![0]!,
      );
      expect(held, "held production wire carries the newer desired width").toContain(
        "(width 0.55)",
      );
      expect(held).toContain(SEG1);
      expect(
        await page.evaluate(
          () => (window as unknown as RebaseProbeWindow).Module.kicadCollabBusy(),
        ),
        "held submission has not entered the native queue",
      ).toBe(false);
      expect(
        segmentState(await modelText(page, TRIO_PCB), SEG1),
        "native remains on the acknowledged stale base",
      ).toEqual({ width: 0.2, end: [101.6, 50.8] });

      // This is a genuine BOARD_COMMIT + BOARD_LISTENER + post-settle native
      // wire, not a JS-injected emission. It edits only `end`; its whole-item
      // snapshot necessarily still says width=0.2.
      expect(
        await page.evaluate(
          ({ uuid, dx }) =>
            (window as unknown as RebaseProbeWindow).Module.kicadCollabTestMoveEndpoint(
              uuid,
              dx,
              0,
            ),
          { uuid: SEG1, dx: 2_000_000 },
        ),
        "native endpoint commit was queued",
      ).toBe(true);

      await expect
        .poll(() => projectionFailures(page), { timeout: 20_000, intervals: [100] })
        .toHaveLength(1);
      expect((await projectionFailures(page))[0]).toMatchObject({
        kind: "native-emission-order",
        status: "emission-before-ack",
        recovery: "recreate-from-yjs",
      });

      const authority = await renderDoc(page);
      expect(authority.err, "rebased Y authority remains materializable").toBeUndefined();
      expect(
        segmentState(authority.ok!, SEG1),
        "three-way rebase retains remote width and genuine local endpoint",
      ).toEqual({ width: 0.55, end: [103.6, 50.8] });

      const retiredNative = await modelText(page, TRIO_PCB);
      expect(
        segmentState(retiredNative, SEG1),
        "retired native contains only the local commit; held remote wire never entered",
      ).toEqual({ width: 0.2, end: [103.6, 50.8] });
      expect(
        await page.evaluate(
          () => (window as unknown as RebaseProbeWindow).__heldNativeApplies?.length ?? 0,
        ),
        "terminal owner submits no follow-up after preserving the native intent",
      ).toBe(1);

      // The explicit recovery contract: materialize Y, open a fresh editor
      // generation from those bytes, then baseline it against the same room.
      const recoveryCfg: ToolCfg = { ...TRIO_PCB, fixture: authority.ok! };
      recovered = await context.newPage();
      recovered.on("console", (message) => {
        if (message.text().includes("Aborted(")) recoveredAborts.push(message.text());
      });
      recovered.on("pageerror", (error) => {
        if (error.message.includes("Aborted(")) recoveredAborts.push(error.message);
      });
      await bootOpen(recovered, recoveryCfg);
      await startV2(recovered, { room, editorMatchesDoc: true });
      await expect
        .poll(async () => (await renderDoc(recovered!)).ok, {
          timeout: 15_000,
          intervals: [200],
        })
        .toBe(authority.ok);

      const freshNative = await modelText(recovered, recoveryCfg);
      expect(segmentState(freshNative, SEG1), "fresh native contains both intents").toEqual({
        width: 0.55,
        end: [103.6, 50.8],
      });
      expect(await drift(recovered, recoveryCfg), "fresh native converges exactly to Y").toBeNull();
      expect(await projectionFailures(recovered), "fresh owner stays live").toEqual([]);
      expect(hasAbort(testLogger), "producer has no Wasm abort").toBe(false);
      expect(recoveredAborts, "recovery has no Wasm abort").toEqual([]);
    } finally {
      if (recovered) await recovered.close({ runBeforeUnload: false });
    }
  });
});
