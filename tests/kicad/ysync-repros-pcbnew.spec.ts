import type { Page } from "@playwright/test";
import { fileToDoc } from "../../web/pcbjam-shared/src/index.js";
import { test, expect } from "./fixtures";

/**
 * pcbnew single-tab repros for the C++-side ysync bugs (docs in
 * docs/features/ysync-review on the ysync-review branch) — items-bridge.spec.ts
 * driving style: the v2 exports are called directly, no Y.Doc/bundle.
 *
 * REPRO CONVENTION: each repro asserts the CORRECT behavior and is marked
 * `test.fail()` with a comment naming the bug doc; fixing the bug flips it to
 * "unexpected pass", forcing the marker's removal. Green companion tests pin
 * the preconditions so an expected failure can only come from the bug itself.
 * Expected-fail polls use short timeouts so they don't burn the clock.
 *
 * The "local move emits" control doubles as the HEADLESS EMIT PROBE (plan
 * phase C): if it is red, the emit-dependent repros here and the bug-01
 * two-tab repros in ysync-two-tab.spec.ts cannot run headless → test.fixme.
 */

const FP1 = "66666666-0000-0000-0000-000000000001";
const FP1_TXT = "66666666-0000-0000-0000-0000000000cc";
const PAD1 = "66666666-0000-0000-0000-0000000000d1";
const PAD2 = "66666666-0000-0000-0000-0000000000d2";
const VIA1 = "77777777-0000-0000-0000-000000000001";
const SEG1 = "88888888-0000-0000-0000-000000000001";
const SEG2 = "88888888-0000-0000-0000-000000000002";
const NEW_FP = "99999999-0000-0000-0000-000000000009";
const ROOT_POINT = "dddddddd-0000-0000-0000-000000000004";
// Bug-04 rotation target: every child sits EXACTLY on the anchor (rotation
// moves no child's absolute position) and there is no fp_text (whose json
// carries an angle) — so nothing in the scalar projection changes.
const FP2 = "aaaaaaaa-0000-0000-0000-000000000002";
// Bug-04 endpoint target: a graphic shape (Drawings → position-only json).
const GRL1 = "cccccccc-0000-0000-0000-000000000003";

// SAMPLE_PCB + a real net (net 1 "SIG") carried by two pads on the footprint —
// the bug-02 fixture requirement (pad net fidelity through the blob).
const SAMPLE_PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(37 "F.SilkS" user)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
\t(net 1 "SIG")
\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "${FP1}")
\t\t(at 100 100)
\t\t(attr smd)
\t\t(property "Reference" "R1" (at 0 -4.2 0) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15))))
\t\t(property "Value" "R" (at 0 4.6 0) (layer "F.Fab") (uuid "66666666-0000-0000-0000-0000000000bb") (effects (font (size 1 1) (thickness 0.15))))
\t\t(fp_text user "HELLO" (at 0 0 0) (layer "F.SilkS") (uuid "${FP1_TXT}") (effects (font (size 1 1) (thickness 0.15))))
\t\t(pad "1" smd rect (at -1.27 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "${PAD1}"))
\t\t(pad "2" smd rect (at 1.27 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (uuid "${PAD2}"))
\t)
\t(footprint "TestLib:X"
\t\t(layer "F.Cu")
\t\t(uuid "${FP2}")
\t\t(at 120 120)
\t\t(attr smd)
\t\t(property "Reference" "X1" (at 0 0 0) (layer "F.SilkS") (hide yes) (uuid "aaaaaaaa-0000-0000-0000-0000000000ee") (effects (font (size 1 1) (thickness 0.15))))
\t\t(property "Value" "X" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "aaaaaaaa-0000-0000-0000-0000000000ff") (effects (font (size 1 1) (thickness 0.15))))
\t)
\t(gr_line (start 20 20) (end 40 20) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "${GRL1}"))
\t(via (at 80 80) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "${VIA1}"))
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG1}"))
\t(segment (start 50.8 76.2) (end 101.6 76.2) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG2}"))
)
`;

// PCB_POINT (KiCad 10) is a persisted board root, separate from the points nested in a
// footprint.  It was missing from the collaboration root iterator even though the native writer
// saves it.  Keep it in a dedicated current-version fixture so the older net-code fixture above
// continues to exercise its compatibility path unchanged.
const POINT_PCB = SAMPLE_PCB
  .replace("(version 20241229)", "(version 20260206)")
  .replace('(generator_version "9.0")', '(generator_version "10.0")')
  .replace('\t(net 0 "")\n\t(net 1 "SIG")\n', "")
  .replaceAll('(net 1 "SIG")', '(net "SIG")')
  .replace(
    /\n\)\n$/,
    `\n\t(point (at 30 30) (size 1) (layer "F.Cu") (uuid "${ROOT_POINT}"))\n)\n`,
  );

// A bare footprint blob for the bug-05 "unrelated remote apply" (the proven
// v2 add path — same shape as items-bridge.spec.ts PCB.added).
const NEW_FP_SEXPR = `(footprint "TestLib:C" (layer "F.Cu") (uuid "${NEW_FP}") (at 50 50) (attr smd) (property "Reference" "C1" (at 0 -2 0) (layer "F.SilkS") (uuid "99999999-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15)))))`;

type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};
type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabSnapshotItems(): string;
  kicadCollabApplyItems(j: string): unknown;
  kicadCollabSetItemsOwner(owner: string): boolean;
  kicadCollabReleaseItemsOwner(owner: string): void;
  kicadCollabBusy(): boolean;
  kicadCollabTestMoveFirst(dx: number, dy: number): string;
  kicadCollabTestMoveBoardItem(id: string, dx: number, dy: number): boolean;
  kicadCollabTestCreateNetAndAssign(id: string, net: string): boolean;
  kicadCollabTestRenameNet(oldName: string, newName: string): boolean;
  kicadCollabTestDeleteNet(name: string): boolean;
  kicadCollabTestListNets(): string;
  kicadCollabGetPos(id: string): string;
  kicadSaveBoard(p: string): unknown;
};

const BOOT_TIMEOUT = 150000;

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootOpen(page: Page, content = SAMPLE_PCB): Promise<void> {
  await page.goto("/kicad/pcbnew-collab.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSnapshotItems === "function" &&
        typeof m?.kicadCollabApplyItems === "function" &&
        typeof m?.kicadCollabTestMoveFirst === "function" &&
        typeof m?.kicadSaveBoard === "function"
      );
    },
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((e) => /Frame$/.test(e.typeName) || (e.name || "").endsWith("Frame")),
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.evaluate((content) => {
    const w = window as unknown as { FS: FS; Module: Mod };
    try {
      w.FS.mkdirTree("/home/kicad/documents");
    } catch {
      /* exists */
    }
    const p = "/home/kicad/documents/rt.kicad_pcb";
    w.FS.writeFile(p, content);
    w.Module.kicadOpenFile(p);
  }, content);
}

function saveRead(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { FS: FS; Module: Mod };
    const out = "/home/kicad/documents/probe.kicad_pcb";
    w.Module.kicadSaveBoard(out);
    return w.FS.readFile(out, { encoding: "utf8" });
  });
}

/** The footprint's snapshot blob (v2 wire) — FP1 with its children embedded. */
async function fp1Blob(page: Page): Promise<string> {
  const snap = JSON.parse(
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems()),
  ) as { added: Array<{ sexpr: string }> };
  const blob = snap.added.map((w) => w.sexpr).find((s) => s.includes(FP1));
  expect(blob, "snapshot blob for the footprint").toBeTruthy();
  return blob!;
}

/** Register the onItems capture (single tab — no binding to preserve). */
function captureEmits(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __items: string[] }).__items = [];
    (window as unknown as { kicadCollab: object }).kicadCollab = {
      onItems: (j: string) => (window as unknown as { __items: string[] }).__items.push(j),
    };
  });
}

function emittedWires(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window as unknown as { __items: string[] }).__items.join("\n"),
  );
}

type CapturedWire = {
  added: Array<{ sexpr: string }>;
  changed: Array<{ sexpr: string }>;
  removed: string[];
};

function capturedWires(page: Page): Promise<CapturedWire[]> {
  return page.evaluate(() =>
    (window as unknown as { __items: string[] }).__items.map(
      (wire) => JSON.parse(wire) as CapturedWire,
    ),
  );
}

function expectOnlyUuidBearingUpserts(wires: CapturedWire[]): void {
  const upserts = wires.flatMap((wire) => [...wire.added, ...wire.changed]);
  expect(
    upserts.length,
    "the native operation emitted at least one persisted root",
  ).toBeGreaterThan(0);
  for (const entry of upserts) {
    expect(entry.sexpr, "no furniture-only PCB envelope reaches the item wire").toContain("(uuid");
  }
}

test.describe("pcbnew ysync repros (v2 items wire, single tab)", () => {
  test.describe.configure({ timeout: 420000 });

  test("precondition: the footprint blob embeds its pad children", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    const blob = await fp1Blob(page);
    // Pins the green half of bug 02: the pads ARE in the blob — only their
    // nets are stripped. If this test breaks, the bug-02 repro below is
    // failing for the wrong reason.
    expect(blob).toContain(PAD1);
    expect(blob).toContain(PAD2);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("footprint blob preserves pad nets", async ({ page, testLogger }) => {
    await bootOpen(page);
    const blob = await fp1Blob(page);
    // Peers share the same board/net lineage — identity-by-uuid, not a
    // foreign-board paste — so the SIG net must survive the wire
    // (02-bug-footprint-blob-zeroes-pad-nets.md). KiCad 10 formats pad nets by
    // NAME only, `(net "SIG")`; accept the legacy code+name form too.
    expect(blob).toMatch(/\(net (1 )?"SIG"\)/);

    // Exercise the receiver decoder, not just the outbound snapshot. Before
    // the board-envelope fix a bare footprint ACKed successfully but both pads
    // became net 0, and the next native save silently omitted their nets.
    await page.evaluate(
      ({ id, sexpr }) =>
        window.Module.kicadCollabApplyItems(
          JSON.stringify({ added: [], changed: [{ id, sexpr }], removed: [] }),
        ),
      { id: FP1, sexpr: blob },
    );
    await page.waitForFunction(
      () => !(window as unknown as { Module: Mod }).Module.kicadCollabBusy(),
      null,
      { timeout: 25_000 },
    );
    const saved = await saveRead(page);
    expect(saved).toContain(PAD1);
    expect(saved).toContain(PAD2);
    const savedDoc = fileToDoc(saved);
    expect(JSON.stringify(savedDoc.items[PAD1]), "pad 1 retained SIG").toContain("SIG");
    expect(JSON.stringify(savedDoc.items[PAD2]), "pad 2 retained SIG").toContain("SIG");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("creating and assigning a net emits its connected footprint root", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    await captureEmits(page);

    const queued = await page.evaluate(
      ({ pad, net }) =>
        (window as unknown as { Module: Mod }).Module.kicadCollabTestCreateNetAndAssign(
          pad,
          net,
        ),
      { pad: PAD1, net: "AUX_CREATED" },
    );
    expect(queued, "create/reassign hook accepted the real pad").toBe(true);

    await expect
      .poll(async () => await emittedWires(page), { timeout: 20_000, intervals: [400] })
      .toContain("AUX_CREATED");
    const wires = await capturedWires(page);
    expectOnlyUuidBearingUpserts(wires);
    expect(JSON.stringify(fileToDoc(await saveRead(page)).items[PAD1])).toContain("AUX_CREATED");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("renaming a net emits final names through every affected persisted root", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    await captureEmits(page);

    const queued = await page.evaluate(
      ({ from, to }) =>
        (window as unknown as { Module: Mod }).Module.kicadCollabTestRenameNet(from, to),
      { from: "SIG", to: "SIG_RENAMED" },
    );
    expect(queued, "rename hook found the live native net").toBe(true);

    await expect
      .poll(async () => await emittedWires(page), { timeout: 20_000, intervals: [400] })
      .toContain("SIG_RENAMED");
    const wires = await capturedWires(page);
    expectOnlyUuidBearingUpserts(wires);
    expect(JSON.stringify(fileToDoc(await saveRead(page)).items[PAD1])).toContain("SIG_RENAMED");
    expect(JSON.stringify(fileToDoc(await saveRead(page)).items[PAD2])).toContain("SIG_RENAMED");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("deleting a net emits the connected roots after native reassignment to net zero", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    await captureEmits(page);

    const queued = await page.evaluate(
      (net) => (window as unknown as { Module: Mod }).Module.kicadCollabTestDeleteNet(net),
      "SIG",
    );
    expect(queued, "delete hook found the live native net").toBe(true);

    await expect
      .poll(async () => await emittedWires(page), { timeout: 20_000, intervals: [400] })
      .toContain(FP1);
    const wires = await capturedWires(page);
    expectOnlyUuidBearingUpserts(wires);
    expect(
      wires
        .flatMap((wire) => wire.changed)
        .map((entry) => entry.sexpr)
        .join("\n"),
    ).not.toContain('"SIG"');
    const savedDoc = fileToDoc(await saveRead(page));
    expect(JSON.stringify(savedDoc.items[PAD1])).not.toContain("SIG");
    expect(JSON.stringify(savedDoc.items[PAD2])).not.toContain("SIG");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("an invalid batch cannot leak a parsed new net before a valid retry", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    const original = await fp1Blob(page);
    const withNewNet = original.replace(/\(net (?:1 )?"SIG"\)/g, '(net "ATOMIC_NEW_NET")');
    expect(withNewNet, "the early valid root references a genuinely new net").toContain(
      "ATOMIC_NEW_NET",
    );

    const result = await page.evaluate(async ({ validRoot, fpUuid }) => {
      const runtime = window as unknown as {
        FS: FS;
        Module: Mod;
        kicadCollab?: {
          onItems?: (json: string) => void;
          onItemsApplied?: (json: string) => void;
        };
      };
      const module = runtime.Module;
      const acknowledgements: Array<{ requestId: string; status: string; error?: string }> = [];
      const emissions: string[] = [];
      runtime.kicadCollab = {
        ...runtime.kicadCollab,
        onItems: (json) => emissions.push(json),
        onItemsApplied: (json) => acknowledgements.push(JSON.parse(json)),
      };

      const save = (name: string): string => {
        const path = `/home/kicad/documents/${name}.kicad_pcb`;
        module.kicadSaveBoard(path);
        return runtime.FS.readFile(path, { encoding: "utf8" });
      };
      const state = (saveName: string) => ({
        nets: JSON.parse(module.kicadCollabTestListNets()) as string[],
        snapshot: module.kicadCollabSnapshotItems(),
        saved: save(saveName),
      });
      const waitFor = async (requestId: string) => {
        const deadline = performance.now() + 20_000;
        while (
          !acknowledgements.some((ack) => ack.requestId === requestId) &&
          performance.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        while (module.kicadCollabBusy() && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const acknowledgement = acknowledgements.find((ack) => ack.requestId === requestId);
        if (!acknowledgement || module.kicadCollabBusy()) {
          throw new Error(`timed out waiting for settled native projection ${requestId}`);
        }
        return acknowledgement;
      };
      const apply = (owner: string, requestId: string, changed: Array<{ sexpr: string }>) =>
        module.kicadCollabApplyItems(
          JSON.stringify({
            added: [],
            changed: changed.map((entry) => ({ ...entry, parent: null })),
            removed: [],
            _pcbjam: { requestId, ownerGeneration: owner },
          }),
        );

      const before = state("atomic-before");
      const firstOwner = "atomic-net-invalid-owner";
      const acquiredFirst = module.kicadCollabSetItemsOwner(firstOwner);
      // Both roots parse successfully, but the second repeats the complete native identity tree.
      // That makes the batch invalid only at the post-parse identity-validation boundary.
      apply(firstOwner, "invalid-new-net-tail", [
        { sexpr: validRoot },
        { sexpr: validRoot },
      ]);
      const rejectedAck = await waitFor("invalid-new-net-tail");
      const afterInvalid = state("atomic-after-invalid");
      module.kicadCollabReleaseItemsOwner(firstOwner);

      // A terminally rejected projection closes that owner epoch by design. A fresh owner is the
      // explicit recovery boundary; retry the exact early root as a now-valid complete batch.
      const secondOwner = "atomic-net-valid-retry-owner";
      const acquiredSecond = module.kicadCollabSetItemsOwner(secondOwner);
      apply(secondOwner, "valid-new-net-retry", [{ sexpr: validRoot }]);
      const appliedAck = await waitFor("valid-new-net-retry");
      const afterValid = state("atomic-after-valid");
      module.kicadCollabReleaseItemsOwner(secondOwner);

      return {
        acquiredFirst,
        acquiredSecond,
        afterInvalid,
        afterValid,
        appliedAck,
        before,
        emissions,
        fpUuid,
        rejectedAck,
      };
    }, { validRoot: withNewNet, fpUuid: FP1 });

    expect(result.acquiredFirst).toBe(true);
    expect(result.rejectedAck).toEqual(
      expect.objectContaining({ requestId: "invalid-new-net-tail", status: "invalid" }),
    );
    expect(result.rejectedAck.error).toContain("duplicate parsed UUID");
    expect(result.afterInvalid.nets, "parse/validation created no live NETINFO_ITEM").toEqual(
      result.before.nets,
    );
    expect(result.afterInvalid.snapshot, "native item snapshot is byte-stable after rejection").toBe(
      result.before.snapshot,
    );
    expect(result.afterInvalid.saved, "native save is byte-stable after rejection").toBe(
      result.before.saved,
    );
    expect(result.emissions, "rejected preflight fires no spurious local item emission").toEqual([]);

    expect(result.acquiredSecond).toBe(true);
    expect(result.appliedAck).toEqual(
      expect.objectContaining({ requestId: "valid-new-net-retry", status: "applied" }),
    );
    expect(result.afterValid.nets).toContain("ATOMIC_NEW_NET");
    expect(result.afterValid.snapshot).toContain("ATOMIC_NEW_NET");
    expect(result.afterValid.snapshot).toContain(result.fpUuid);
    expect(result.afterValid.saved).toContain("ATOMIC_NEW_NET");
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a persisted root PCB_POINT snapshots, emits, applies, and saves", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page, POINT_PCB);
    const snapshot = JSON.parse(
      await page.evaluate(() => window.Module.kicadCollabSnapshotItems()),
    ) as CapturedWire;
    const original = snapshot.added.find((entry) => entry.sexpr.includes(ROOT_POINT));
    expect(original, "root point is part of the complete native snapshot").toBeTruthy();

    await captureEmits(page);
    const queued = await page.evaluate(
      (point) =>
        (window as unknown as { Module: Mod }).Module.kicadCollabTestMoveBoardItem(
          point,
          1_000_000,
          0,
        ),
      ROOT_POINT,
    );
    expect(queued, "move hook resolved the root point").toBe(true);
    await expect
      .poll(async () => await emittedWires(page), { timeout: 20_000, intervals: [400] })
      .toContain(ROOT_POINT);
    expect(await saveRead(page)).toMatch(
      new RegExp(`\\(point\\s+\\(at 31 30\\)[\\s\\S]*?${ROOT_POINT}`),
    );

    // The receiving half uses the same root inventory to require exactly one parsed item.
    await page.evaluate(
      ({ id, sexpr }) =>
        (window as unknown as { Module: Mod }).Module.kicadCollabApplyItems(
          JSON.stringify({ added: [], changed: [{ id, sexpr }], removed: [] }),
        ),
      { id: ROOT_POINT, sexpr: original!.sexpr },
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            (point) => (window as unknown as { Module: Mod }).Module.kicadCollabGetPos(point),
            ROOT_POINT,
          ),
        { timeout: 25_000, intervals: [400] },
      )
      .toBe("30000000,30000000");
    expect(await saveRead(page)).toMatch(
      new RegExp(`\\(point\\s+\\(at 30 30\\)[\\s\\S]*?${ROOT_POINT}`),
    );
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("precondition: applyItems removes a root item (harness proof)", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    expect(await saveRead(page)).toContain(SEG2);
    await page.evaluate((seg) => {
      window.Module.kicadCollabApplyItems(
        JSON.stringify({ added: [], changed: [], removed: [seg] }),
      );
    }, SEG2);
    // The same remove path + poll the bug-03 repro uses — proven on a ROOT item.
    await expect
      .poll(async () => (await saveRead(page)).includes(SEG2), {
        timeout: 25000,
        intervals: [400],
      })
      .toBe(false);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("applyItems removes a footprint CHILD by uuid", async ({ page, testLogger }) => {
    await bootOpen(page);
    expect(await saveRead(page)).toContain(FP1_TXT);
    // The wire a peer sends after deleting the fp_text: a bare child removal
    // (the emit side lifts adds/changes to a parent re-blob but NOT removals —
    // 03-bug-child-removal-dangling-slot.md).
    await page.evaluate((uuid) => {
      window.Module.kicadCollabApplyItems(
        JSON.stringify({ added: [], changed: [], removed: [uuid] }),
      );
    }, FP1_TXT);
    // CORRECT: the receiver loses the child too. TODAY: doApplyItems skips any
    // removed uuid with GetParentFootprint() (pcbnew_embind.cpp:838) → the peer
    // KEEPS the field while the sender lost it — permanent divergence.
    await expect
      .poll(async () => (await saveRead(page)).includes(FP1_TXT), {
        timeout: 8000,
        intervals: [400],
      })
      .toBe(false);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("control: a local move emits the v2 items wire (HEADLESS EMIT PROBE)", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    // snapshotItems: registers the COLLAB_LISTENER (ensureBridge) + baselines
    // the differ — the two side effects seed()'s non-file-seed branches rely on.
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    await captureEmits(page);

    const movedId = (await page.evaluate(() =>
      window.Module.kicadCollabTestMoveFirst(2_000_000, 0),
    )) as string;
    expect(movedId).toMatch(/[0-9a-f-]{36}/);

    // listener → scheduleFlush → flushDiff → emitItems: the moved item's uuid
    // must appear in an emitted wire. THIS is the phase-C gate: if red, the
    // emit-dependent repros (bug 01 two-tab, bug 05 below) become test.fixme.
    await expect
      .poll(async () => await emittedWires(page), { timeout: 20000, intervals: [400] })
      .toContain(movedId);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a local edit committed while a remote apply is queued still reaches the wire", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    await captureEmits(page);

    // Pre-positions of every fixture uuid, so the moved item is verifiable
    // whichever item forEachTopItem yields first.
    const uuids = [FP1, FP1_TXT, PAD1, PAD2, VIA1, SEG1, SEG2];
    const before: Record<string, string> = {};
    for (const u of uuids) {
      before[u] = await page.evaluate((id) => window.Module.kicadCollabGetPos(id), u);
    }

    // ONE JS turn: queue the local move, then the unrelated remote apply.
    // CallAfter drain order is FIFO → [move, apply, flush]: the move's commit
    // fires the listener (flush queued BEHIND the apply), then the apply's
    // global rebaseline() snapshots the model WITH the move already in it, so
    // the flush diffs to empty (05-bug-rebaseline-swallows-local-edits.md).
    const movedId = (await page.evaluate((fpSexpr) => {
      const m = window.Module;
      const id = m.kicadCollabTestMoveFirst(3_000_000, 0);
      m.kicadCollabApplyItems(
        JSON.stringify({ added: [{ sexpr: fpSexpr, parent: null }], changed: [], removed: [] }),
      );
      return id;
    }, NEW_FP_SEXPR)) as string;
    expect(movedId).toMatch(/[0-9a-f-]{36}/);

    // Green preconditions: the apply landed (FIFO ⇒ the move ran before it)…
    await expect
      .poll(() => page.evaluate((id) => window.Module.kicadCollabGetPos(id), NEW_FP), {
        timeout: 15000,
        intervals: [300],
      })
      .not.toBe("");
    // …and the local move is REAL.
    expect(
      await page.evaluate((id) => window.Module.kicadCollabGetPos(id), movedId),
      "the local move landed on the board",
    ).not.toBe(before[movedId]);

    // CORRECT: the concurrent local edit still reaches peers. TODAY: the flush
    // runs against the post-apply baseline and emits NOTHING for it.
    await expect
      .poll(async () => await emittedWires(page), { timeout: 8000, intervals: [400] })
      .toContain(movedId);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // ── Bug 04 matrix — edits invisible to the scalar-projection differ ────────
  // 04-bug-lossy-change-detection.md: the v2 wire's TRIGGER is still the legacy
  // scalar json diff; any edit that doesn't change the projection never emits.
  // Each test: real commit via a repro hook (wasm ≥ the ysync-hooks build) →
  // green precondition that the edit LANDED → expected-fail that it EMITTED.
  // The "local move emits" control above proves the emit harness itself.

  /** Baseline + capture + hook-presence guard (returns false on stale wasm). */
  async function armed(page: Page, hook: string): Promise<boolean> {
    await bootOpen(page);
    const has = await page.evaluate(
      (h) => typeof (window as unknown as { Module: Record<string, unknown> }).Module[h] === "function",
      hook,
    );
    if (!has) return false;
    await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
    await captureEmits(page);
    return true;
  }

  test("an anchor-centred footprint rotation reaches the wire", async ({ page, testLogger }) => {
    const ok = await armed(page, "kicadCollabTestRotateItem");
    test.skip(!ok, "wasm build predates the ysync repro hooks");

    const queued = await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestRotateItem(i: string, d: number): boolean } })
          .Module.kicadCollabTestRotateItem(id, 90),
      FP2,
    );
    expect(queued, "rotate hook resolved the footprint").toBe(true);

    // Green precondition: the rotation LANDED (the saved footprint gained an
    // orientation). FP2's children all sit on the anchor, so no child position
    // moved — nothing in the scalar projection changed.
    await expect
      .poll(async () => /\(at 120 120 (-?[\d.]+)\)/.test(await saveRead(page)), {
        timeout: 15000,
        intervals: [400],
      })
      .toBe(true);

    // CORRECT: the rotation is broadcast (any wire mentioning FP2). TODAY: the
    // diff is empty — the rotation exists only on this tab, forever.
    await expect
      .poll(async () => await emittedWires(page), { timeout: 8000, intervals: [400] })
      .toContain(FP2);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a pad size edit reaches the wire", async ({ page, testLogger }) => {
    const ok = await armed(page, "kicadCollabTestSetPadSize");
    test.skip(!ok, "wasm build predates the ysync repro hooks");

    const queued = await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestSetPadSize(i: string, w: number, h: number): boolean } })
          .Module.kicadCollabTestSetPadSize(id, 2_000_000, 2_000_000),
      PAD1,
    );
    expect(queued, "pad hook resolved the pad").toBe(true);

    // Green precondition: the resize LANDED in the model.
    await expect
      .poll(async () => (await saveRead(page)).includes("(size 2 2)"), {
        timeout: 15000,
        intervals: [400],
      })
      .toBe(true);

    // CORRECT: the edit is broadcast — as the pad's parent re-blob (liftBlob
    // lifts children), so PAD1 appears inside an emitted footprint blob.
    // TODAY: nothing emits.
    await expect
      .poll(async () => await emittedWires(page), { timeout: 8000, intervals: [400] })
      .toContain(PAD1);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a graphic-shape endpoint drag reaches the wire", async ({ page, testLogger }) => {
    const ok = await armed(page, "kicadCollabTestMoveEndpoint");
    test.skip(!ok, "wasm build predates the ysync repro hooks");

    const queued = await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestMoveEndpoint(i: string, dx: number, dy: number): boolean } })
          .Module.kicadCollabTestMoveEndpoint(id, 5_000_000, 0),
      GRL1,
    );
    expect(queued, "endpoint hook resolved the shape").toBe(true);

    // Green precondition: the reshape LANDED (end 40 20 → 45 20).
    await expect
      .poll(async () => (await saveRead(page)).includes("(end 45 20)"), {
        timeout: 15000,
        intervals: [400],
      })
      .toBe(true);

    // CORRECT: the reshape is broadcast. TODAY: start (== position) unchanged
    // → invisible to the differ.
    await expect
      .poll(async () => await emittedWires(page), { timeout: 8000, intervals: [400] })
      .toContain(GRL1);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // ── Bug 03 sending half — child removal must lift to a parent re-blob ─────
  test("precondition: TestRemoveItem deletes a footprint child locally", async ({
    page,
    testLogger,
  }) => {
    await bootOpen(page);
    const has = await page.evaluate(
      () =>
        typeof (window as unknown as { Module: Record<string, unknown> }).Module
          .kicadCollabTestRemoveItem === "function",
    );
    test.skip(!has, "wasm build predates the ysync repro hooks");

    const queued = await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestRemoveItem(i: string): boolean } })
          .Module.kicadCollabTestRemoveItem(id),
      FP1_TXT,
    );
    expect(queued, "remove hook resolved the child").toBe(true);
    await expect
      .poll(async () => (await saveRead(page)).includes(FP1_TXT), {
        timeout: 15000,
        intervals: [400],
      })
      .toBe(false);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("a child deletion goes out as the parent's re-blob", async ({ page, testLogger }) => {
    const ok = await armed(page, "kicadCollabTestRemoveItem");
    test.skip(!ok, "wasm build predates the ysync repro hooks");

    await page.evaluate(
      (id) =>
        (window as unknown as { Module: { kicadCollabTestRemoveItem(i: string): boolean } })
          .Module.kicadCollabTestRemoveItem(id),
      FP1_TXT,
    );

    // Green precondition: the deletion LANDED locally.
    await expect
      .poll(async () => (await saveRead(page)).includes(FP1_TXT), {
        timeout: 15000,
        intervals: [400],
      })
      .toBe(false);

    // CORRECT: the deletion travels as the parent footprint's re-blob (its new
    // body simply lacks the child — the same containment adds/changes use), so
    // some emitted wire carries an FP1 blob WITHOUT the child. TODAY nothing of
    // the sort goes out — the flushDiff code would send a bare
    // `removed:[childUuid]` (03-bug…md), but the headless run shows the child-
    // only delete commit does not even trigger a flush (the baseline-snapshot
    // tracer fires once, never again) — the sending-side hole is total.
    await expect
      .poll(
        async () => {
          const wires = (await page.evaluate(
            () => (window as unknown as { __items: string[] }).__items,
          )) as string[];
          return wires.some((w) => {
            const wire = JSON.parse(w) as {
              added?: Array<{ sexpr: string }>;
              changed?: Array<{ sexpr: string }>;
            };
            return [...(wire.added ?? []), ...(wire.changed ?? [])].some(
              (b) => b.sexpr.includes(FP1) && !b.sexpr.includes(FP1_TXT),
            );
          });
        },
        { timeout: 8000, intervals: [400] },
      )
      .toBe(true);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });
});
