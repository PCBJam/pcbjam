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
  };
  KicadCollabV2: { applyRemoteDoc(text: string): void };
  kicadCollab?: Record<string, unknown> & { onSave?: (path: string) => void };
  __holdProjection?: boolean;
  __heldProjection?: string[];
  __releaseProjection?: () => unknown;
  __savedDuringProjection?: string[];
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

async function installProjectionHoldAndSaveCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as unknown as SaveProbeWindow;
    const submit = runtime.Module.kicadCollabApplyItems.bind(runtime.Module);
    runtime.__heldProjection = [];
    runtime.__holdProjection = false;
    runtime.Module.kicadCollabApplyItems = (json: string): unknown => {
      if (!runtime.__holdProjection) return submit(json);
      runtime.__holdProjection = false;
      runtime.__heldProjection!.push(json);
      return undefined;
    };
    runtime.__releaseProjection = () => {
      const json = runtime.__heldProjection!.shift();
      if (!json) throw new Error("no held native projection");
      return submit(json);
    };

    runtime.__savedDuringProjection = [];
    const previous = runtime.kicadCollab?.onSave;
    runtime.kicadCollab = {
      ...runtime.kicadCollab,
      onSave: (savedPath: string) => {
        runtime.__savedDuringProjection!.push(
          runtime.FS.readFile(savedPath, { encoding: "utf8" }),
        );
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

  test("Ctrl+S cannot acknowledge stale bytes while a newer Y revision awaits native", async ({
    page,
  }) => {
    await bootOpen(page, TRIO_PCB);
    await installProjectionHoldAndSaveCapture(page);
    const seed = await modelText(page, TRIO_PCB);
    await startV2(page, {
      room: `save-projection-${test.info().workerIndex}`,
      seedText: seed,
    });

    // Make the native document genuinely dirty so the real Save accelerator is
    // enabled before the remote projection is held.
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
    await page.evaluate((text) => {
      const runtime = window as unknown as SaveProbeWindow;
      runtime.__holdProjection = true;
      runtime.KicadCollabV2.applyRemoteDoc(text);
    }, remote);

    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as SaveProbeWindow).__heldProjection?.length ?? 0,
          ),
        { timeout: 15_000, intervals: [50] },
      )
      .toBe(1);
    expect(segmentWidth((await renderDoc(page)).ok!)).toBe(0.55);
    expect(segmentWidth(await modelText(page, TRIO_PCB))).toBe(0.2);

    const canvas = page.locator("#canvas");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.press("Control+s");
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
      () => (window as unknown as SaveProbeWindow).__savedDuringProjection![0]!,
    );

    // Drain the held request before asserting, so even the intentionally red
    // pre-fix run leaves no native coroutine or ACK waiter behind.
    await page.evaluate(
      () => (window as unknown as SaveProbeWindow).__releaseProjection!(),
    );
    await expect
      .poll(async () => segmentWidth(await modelText(page, TRIO_PCB)), {
        timeout: 30_000,
        intervals: [200],
      })
      .toBe(0.55);

    expect(
      segmentWidth(saved),
      "the save acknowledged after Y revision 0.55 existed must include that revision",
    ).toBe(0.55);
  });
});
