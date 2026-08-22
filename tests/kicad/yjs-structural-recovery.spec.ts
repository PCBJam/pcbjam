import { execSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "./fixtures";
import {
  bootOpen,
  drift,
  modelText,
  renderDoc,
  startV2,
  TRIO_PL,
  type ToolCfg,
} from "./utils/trio";

/**
 * Browser/Wasm refinement test for the structural projection boundary.
 *
 * The Y.Doc is authoritative, but the current native protocol can hot-apply
 * UUID items only. A remote setup/layout edit must therefore retire the old
 * native owner instead of pretending that the editor is still synchronized.
 * Recovery is a new Wasm instance opened from docToFile(yToDoc(room)).
 */

interface ProjectionFailure {
  kind: string;
  message: string;
  status?: string;
  recovery: string;
}

interface CollabProbe {
  applyRemoteLayout(fileText: string): boolean;
  applyRemoteDoc(fileText: string): void;
  projectionFailures(): ProjectionFailure[];
  layoutHead(fileText: string, head: string): string;
}

const STRUCTURE_CHANGED = TRIO_PL.fixture.replace(
  "(left_margin 10)",
  "(left_margin 23)",
);
function probe(page: Parameters<typeof modelText>[0]): Promise<ProjectionFailure[]> {
  return page.evaluate(() =>
    (window as unknown as { KicadCollabV2: CollabProbe }).KicadCollabV2.projectionFailures(),
  );
}

function layoutHead(
  page: Parameters<typeof modelText>[0],
  fileText: string,
  head: string,
): Promise<string> {
  return page.evaluate(
    ({ fileText, head }) =>
      (window as unknown as { KicadCollabV2: CollabProbe }).KicadCollabV2.layoutHead(
        fileText,
        head,
      ),
    { fileText, head },
  );
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

test.describe("Yjs non-item projection recovery", () => {
  test.describe.configure({ timeout: 420_000 });

  test("fails closed, absorbs later updates, and rehydrates a fresh native instance", async ({
    page,
    context,
    testLogger,
  }) => {
    const room = `ysync-structure-recovery-${test.info().workerIndex}`;
    await bootOpen(page, TRIO_PL);
    await startV2(page, { room, seedText: TRIO_PL.fixture });

    const originalNative = await modelText(page, TRIO_PL);
    expect(originalNative).toContain("(left_margin 10)");
    expect(originalNative).toContain('"Title"');

    const changed = await page.evaluate((text) =>
      (window as unknown as { KicadCollabV2: CollabProbe }).KicadCollabV2.applyRemoteLayout(text),
      STRUCTURE_CHANGED,
    );
    expect(changed, "the remote Y-only setup transaction changed authority").toBe(true);

    await expect.poll(() => probe(page), { timeout: 10_000, intervals: [100] }).toHaveLength(1);
    expect((await probe(page))[0]).toEqual({
      kind: "non-item-structure",
      message:
        "remote root/layout/library structure cannot be hot-applied; native rehydration is required",
      recovery: "recreate-from-yjs",
    });

    // The guard fires before the item-only native bridge can claim the setup
    // change. The old editor remains its last known-good snapshot.
    const afterStructure = await modelText(page, TRIO_PL);
    expect(afterStructure).toContain("(left_margin 10)");
    expect(afterStructure).not.toContain("(left_margin 23)");

    // A later, otherwise hot-applicable UUID-item update must not revive the
    // retired owner. Base it on the room's normalized rendering so the test
    // changes only the intended item instead of reformatting every item body.
    const afterStructureAuthority = await renderDoc(page);
    expect(afterStructureAuthority.err).toBeUndefined();
    const laterItemChanged = afterStructureAuthority.ok!.replace(
      '"Title"',
      '"AFTER-TERMINAL"',
    );
    expect(laterItemChanged).not.toBe(afterStructureAuthority.ok);
    await page.evaluate((text) =>
      (window as unknown as { KicadCollabV2: CollabProbe }).KicadCollabV2.applyRemoteDoc(text),
      laterItemChanged,
    );
    const authority = await renderDoc(page);
    expect(authority.err, "authoritative Y.Doc remains materializable").toBeUndefined();
    expect(authority.ok).toContain("(left_margin 23)");
    expect(authority.ok).toContain('"AFTER-TERMINAL"');
    expect(await probe(page), "terminal failure is emitted exactly once").toHaveLength(1);

    const retiredNative = await modelText(page, TRIO_PL);
    expect(retiredNative).toContain("(left_margin 10)");
    expect(retiredNative).toContain('"Title"');
    expect(retiredNative).not.toContain("(left_margin 23)");
    expect(retiredNative).not.toContain('"AFTER-TERMINAL"');

    // Recovery: create a genuinely fresh Wasm page from the materialized Y
    // authority, then attach baseline-only to the still-live room.
    const recoveryCfg: ToolCfg = { ...TRIO_PL, fixture: authority.ok! };
    const recovered = await context.newPage();
    await bootOpen(recovered, recoveryCfg);
    await startV2(recovered, { room, editorMatchesDoc: true });

    await expect
      .poll(async () => (await renderDoc(recovered)).ok, {
        timeout: 15_000,
        intervals: [200],
      })
      .toBe(authority.ok);

    const recoveredNative = await modelText(recovered, recoveryCfg);
    expect(recoveredNative).toContain("(left_margin 23)");
    expect(recoveredNative).toContain('"AFTER-TERMINAL"');
    expect(await layoutHead(recovered, recoveredNative, "setup")).toBe(
      await layoutHead(recovered, authority.ok!, "setup"),
    );

    const recoveredDrift = await drift(recovered, recoveryCfg);
    expect(recoveredDrift?.added ?? [], "recovered native has every Y item").toEqual([]);
    expect(recoveredDrift?.updated ?? [], "recovered native item bodies match Y").toEqual([]);
    expect(recoveredDrift?.removed ?? [], "recovered native has no stale items").toEqual([]);

    expect(
      [...testLogger.consoleLogs, ...testLogger.errors].some((line) => line.includes("Aborted(")),
      "no Wasm abort",
    ).toBe(false);
    await recovered.close();
  });
});
