import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  bootOpen,
  callHook,
  drift,
  hasAbort,
  modelText,
  PAD1,
  PAD2,
  renderDoc,
  startV2,
  SYM1,
  TRIO_PCB,
  TRIO_SCH,
  type ToolCfg,
} from "./utils/trio";

/**
 * Real-native save → Yjs → materialized file → fresh-native refinement for the
 * two non-item domains whose old save path could drift silently.
 */

interface LayoutSaveProbe {
  applySavedLayout(fileText: string): boolean;
  projectionFailures(): Array<{ kind: string; message: string }>;
}

function syncNativeSave(page: Page, text: string): Promise<boolean> {
  return page.evaluate((saved) => {
    const probe = (window as unknown as { KicadCollabV2: LayoutSaveProbe }).KicadCollabV2;
    return probe.applySavedLayout(saved);
  }, text);
}

function failures(page: Page): Promise<Array<{ kind: string; message: string }>> {
  return page.evaluate(() =>
    (window as unknown as { KicadCollabV2: LayoutSaveProbe }).KicadCollabV2.projectionFailures(),
  );
}

const PCB_WITH_NET = TRIO_PCB.fixture
  .replace(`\t(net 0 "")`, `\t(net 0 "")\n\t(net 1 "SIG")`)
  .replace(
    `(layers "F.Cu") (uuid "${PAD1}")`,
    `(layers "F.Cu") (net 1 "SIG") (uuid "${PAD1}")`,
  )
  .replace(
    `(layers "F.Cu") (uuid "${PAD2}")`,
    `(layers "F.Cu") (net 1 "SIG") (uuid "${PAD2}")`,
  );
const PCB_WITH_RENAMED_NET = PCB_WITH_NET.replaceAll('"SIG"', '"RENAMED"');

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

test.describe("native non-item save roundtrip", () => {
  test.describe.configure({ timeout: 420_000 });

  test("real PCB net rename survives native save, Y materialization, and fresh reopen", async ({
    page,
    context,
    testLogger,
  }) => {
    const room = `ysync-net-save-${test.info().workerIndex}`;
    const nativeCfg: ToolCfg = { ...TRIO_PCB, fixture: PCB_WITH_RENAMED_NET };
    await bootOpen(page, nativeCfg);

    // Deliberately seed authority from the pre-rename file while the real
    // pcbnew instance has opened the renamed board. The item snapshot carries
    // the renamed pad nets; only save-sync can publish the root net table.
    await startV2(page, { room, seedText: PCB_WITH_NET });
    const saved = await modelText(page, nativeCfg);
    expect(saved).toContain('(net 1 "RENAMED")');
    expect(saved).not.toContain('(net 1 "SIG")');

    expect(await syncNativeSave(page, saved), "the net head changed Y").toBe(true);
    const authority = await renderDoc(page);
    expect(authority.err).toBeUndefined();
    expect(authority.ok).toContain('(net 1 "RENAMED")');
    expect(authority.ok).not.toContain('(net 1 "SIG")');
    expect(await failures(page), "local native save remains a live projection").toEqual([]);

    // Cold native refinement: open exactly the file regenerated from Y, attach
    // baseline-only to the same room, and ask pcbnew's real writer again.
    const reopened = await context.newPage();
    const reopenedCfg: ToolCfg = { ...TRIO_PCB, fixture: authority.ok! };
    await bootOpen(reopened, reopenedCfg);
    await startV2(reopened, { room, editorMatchesDoc: true });
    const reopenedSave = await modelText(reopened, reopenedCfg);
    expect(reopenedSave).toContain('(net 1 "RENAMED")');
    expect(reopenedSave).not.toContain('(net 1 "SIG")');
    expect(await drift(reopened, reopenedCfg), "fresh pcbnew has zero drift from Y").toBeNull();
    expect(await failures(reopened)).toEqual([]);

    expect(hasAbort(testLogger), "no Wasm abort").toBe(false);
    await reopened.close();
  });

  test("real Eeschema last-consumer deletion removes the definition and stays deleted", async ({
    page,
    context,
    testLogger,
  }) => {
    const room = `ysync-lib-delete-save-${test.info().workerIndex}`;
    await bootOpen(page, TRIO_SCH);
    const nativeSeed = await modelText(page, TRIO_SCH);
    await startV2(page, { room, seedText: nativeSeed });

    expect(await callHook<boolean>(page, "kicadCollabTestRemoveItem", SYM1)).toBe(true);
    await expect
      .poll(async () => (await renderDoc(page)).ok?.includes(SYM1), {
        timeout: 15_000,
        intervals: [100],
      })
      .toBe(false);

    // SCH_SCREEN::Remove prunes its embedded cache entry when the final native
    // consumer goes away. Feed those real writer bytes through save-sync.
    const saved = await modelText(page, TRIO_SCH);
    expect(saved).not.toContain(SYM1);
    expect(saved).not.toContain('(symbol "Device:R"');
    expect(
      await syncNativeSave(page, saved),
      "orphan knowledge stays internal, so the save needs no Y deletion",
    ).toBe(false);

    const authority = await renderDoc(page);
    expect(authority.err).toBeUndefined();
    expect(authority.ok).not.toContain(SYM1);
    expect(authority.ok).not.toContain('(symbol "Device:R"');
    expect(await failures(page)).toEqual([]);
    expect(await drift(page, TRIO_SCH), "authoring Eeschema has zero drift from Y").toBeNull();

    const reopened = await context.newPage();
    const reopenedCfg: ToolCfg = { ...TRIO_SCH, fixture: authority.ok! };
    await bootOpen(reopened, reopenedCfg);
    await startV2(reopened, { room, editorMatchesDoc: true });
    const reopenedSave = await modelText(reopened, reopenedCfg);
    expect(reopenedSave).not.toContain(SYM1);
    expect(reopenedSave).not.toContain('(symbol "Device:R"');
    expect(await drift(reopened, reopenedCfg), "fresh Eeschema has zero drift from Y").toBeNull();
    expect(await failures(reopened)).toEqual([]);

    expect(hasAbort(testLogger), "no Wasm abort").toBe(false);
    await reopened.close();
  });
});
