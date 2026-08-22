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
  TRIO_SCH,
  WIRE1,
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

interface OrderingProbeModule {
  kicadCollabApplyItems(json: string): unknown;
  kicadCollabBusy(): boolean;
  kicadCollabSnapshotItems(): string;
  kicadTestSetItemsApplyPark(ms: number): void;
}

interface OrderingProbeWindow {
  Module: OrderingProbeModule;
  KicadCollabV2: CollabProbe;
  kicadCollab?: { onItems?: (json: string) => void };
  __nativeApplySubmissions?: string[];
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

test.describe("Yjs native-emission ordering recovery", () => {
  test.describe.configure({ timeout: 420_000 });

  test("preserves an in-flight native emission, fails closed, and rehydrates from Y", async ({
    page,
    context,
    testLogger,
  }) => {
    const room = `ysync-emission-order-${test.info().workerIndex}`;
    const nativeIntent = "0.4";
    const remoteIntent = "0.55";

    await bootOpen(page, TRIO_SCH);
    await page.waitForFunction(
      () =>
        typeof (window.Module as unknown as Partial<OrderingProbeModule>)
          ?.kicadTestSetItemsApplyPark === "function",
      undefined,
      { timeout: 15_000 },
    );

    // Count calls at the actual embind boundary. The wrapper is installed
    // before attach, so both the production acknowledged bridge and its native
    // owner protocol still execute unchanged underneath it.
    await page.evaluate(() => {
      const runtime = window as unknown as OrderingProbeWindow;
      const nativeApply = runtime.Module.kicadCollabApplyItems.bind(runtime.Module);
      runtime.__nativeApplySubmissions = [];
      runtime.Module.kicadCollabApplyItems = (json: string): unknown => {
        runtime.__nativeApplySubmissions!.push(json);
        return nativeApply(json);
      };
    });
    // Seed Y from this exact native writer output so the final recovery oracle
    // can require whole-document drift silence (not merely item equality).
    const nativeSeed = await modelText(page, TRIO_SCH);
    await startV2(page, { room, seedText: nativeSeed });

    const seeded = await renderDoc(page);
    expect(seeded.err).toBeUndefined();
    const remoteProjection = seeded.ok!.replace(
      "(width 0)",
      `(width ${remoteIntent})`,
    );
    expect(remoteProjection).not.toBe(seeded.ok);

    // Capture a real native wire entry before the remote projection starts,
    // then alter only the segment width that native reports during the park.
    const nativeEmission = await page.evaluate(
      ({ wireUuid, nativeIntent }) => {
        const runtime = window as unknown as OrderingProbeWindow;
        const snapshot = JSON.parse(runtime.Module.kicadCollabSnapshotItems()) as {
          added: Array<{ sexpr: string; parent: string | null }>;
        };
        const segment = snapshot.added.find((entry) =>
          entry.sexpr.includes(`(uuid "${wireUuid}")`),
        );
        if (!segment) throw new Error(`native snapshot omitted segment ${wireUuid}`);
        const sexpr = segment.sexpr.replace(
          /\(width [^)]+\)/,
          `(width ${nativeIntent})`,
        );
        if (sexpr === segment.sexpr) throw new Error("native segment wire omitted width");
        return JSON.stringify({
          added: [],
          changed: [{ ...segment, sexpr }],
          removed: [],
        });
      },
      { wireUuid: WIRE1, nativeIntent },
    );

    // Enter the real native apply coroutine and suspend before its model swap.
    // Y already contains width 0.55 while native is still on width 0.
    await page.evaluate(
      ({ remoteProjection }) => {
        const runtime = window as unknown as OrderingProbeWindow;
        runtime.Module.kicadTestSetItemsApplyPark(3_000);
        runtime.KicadCollabV2.applyRemoteDoc(remoteProjection);
      },
      { remoteProjection },
    );
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as unknown as OrderingProbeWindow).Module.kicadCollabBusy(),
          ),
        { timeout: 10_000, intervals: [25] },
      )
      .toBe(true);
    expect(
      await page.evaluate(() =>
        (window as unknown as OrderingProbeWindow).__nativeApplySubmissions?.length,
      ),
      "one real native projection is parked before ACK",
    ).toBe(1);

    // This is the exact production DOWN hook. The parseable native transition
    // is first preserved in Y, then the generated policy retires the owner
    // because it cannot order this transition against the outstanding wire.
    await page.evaluate((wire) => {
      const runtime = window as unknown as OrderingProbeWindow;
      if (!runtime.kicadCollab?.onItems) throw new Error("native items sink is not attached");
      runtime.kicadCollab.onItems(wire);
    }, nativeEmission);

    await expect.poll(() => probe(page), { timeout: 10_000, intervals: [50] }).toHaveLength(1);
    expect((await probe(page))[0]).toEqual({
      kind: "native-emission-order",
      message:
        "native emitted an item transition before the outstanding projection was acknowledged; its order is ambiguous",
      status: "emission-before-ack",
      recovery: "recreate-from-yjs",
    });

    const preserved = await renderDoc(page);
    expect(preserved.err, "Y remains materializable after fail-stop").toBeUndefined();
    expect(preserved.ok, "native intent survives in authoritative Y").toContain(
      `(width ${nativeIntent})`,
    );
    expect(preserved.ok).not.toContain(`(width ${remoteIntent})`);

    // The already-entered native coroutine has an unknowable outcome. Let it
    // drain: it may commit or reject the earlier wire before observing its
    // released owner. The terminal binding must not guess a new shadow.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as unknown as OrderingProbeWindow).Module.kicadCollabBusy(),
          ),
        { timeout: 15_000, intervals: [50] },
      )
      .toBe(false);
    await page.evaluate(() =>
      (window as unknown as OrderingProbeWindow).Module.kicadTestSetItemsApplyPark(0),
    );

    const ambiguousNative = await modelText(page, TRIO_SCH);
    expect(ambiguousNative).not.toContain(`(width ${nativeIntent})`);
    const ambiguousDrift = await drift(page, TRIO_SCH);
    expect(
      ambiguousDrift?.updated ?? [],
      "the retired native is observably stale against preserved Y intent",
    ).toContain(WIRE1);

    // Advance a disjoint item after terminalization. Y accepts it, but the old
    // owner neither submits another native apply nor emits a second failure.
    const laterAuthority = preserved.ok!.replace(
      "(width 0)",
      "(width 0.9)",
    );
    expect(laterAuthority).not.toBe(preserved.ok);
    await page.evaluate((text) =>
      (window as unknown as OrderingProbeWindow).KicadCollabV2.applyRemoteDoc(text),
      laterAuthority,
    );
    await page.evaluate(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const authority = await renderDoc(page);
    expect(authority.err).toBeUndefined();
    expect(authority.ok).toContain(`(width ${nativeIntent})`);
    expect(authority.ok).toContain("(width 0.9)");
    expect(await probe(page), "terminal event is emitted exactly once").toHaveLength(1);
    expect(
      await page.evaluate(() =>
        (window as unknown as OrderingProbeWindow).__nativeApplySubmissions?.length,
      ),
      "terminal owner absorbs later Y updates without another native apply",
    ).toBe(1);
    expect(await modelText(page, TRIO_SCH), "retired native stays frozen").toBe(
      ambiguousNative,
    );

    // Recovery is a fresh Wasm instance opened from the authoritative Y file.
    const recoveryCfg: ToolCfg = { ...TRIO_SCH, fixture: authority.ok! };
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
    expect(recoveredNative).toContain(`(width ${nativeIntent})`);
    expect(recoveredNative).toContain("(width 0.9)");
    expect(recoveredNative).not.toContain(`(width ${remoteIntent})`);

    const recoveredDrift = await drift(recovered, recoveryCfg);
    expect(recoveredDrift, "fresh native save has zero drift from authoritative Y").toBeNull();
    expect(await probe(recovered), "fresh owner stays live").toEqual([]);

    expect(
      [...testLogger.consoleLogs, ...testLogger.errors].some((line) => line.includes("Aborted(")),
      "no Wasm abort",
    ).toBe(false);
    await recovered.close();
  });
});
