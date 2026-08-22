import { execSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "./fixtures";
import {
  bootOpen,
  hasAbort,
  modelText,
  renderDoc,
  startV2,
  TRIO_SCH,
  type ToolCfg,
} from "./utils/trio";

/**
 * Browser/Wasm refinement test for the shared-library counterexample in
 * web/pcbjam-shared/test/yjs-conflict-domain-counterexamples.test.ts.
 *
 * Two isolated Yjs replicas start from the same empty schematic and concurrently
 * create the same root UUID with different complete item blobs. Their updates
 * are merged before delivery to the live room. The bound editor therefore sees
 * only the late merged projection and must serialize one whole authored item,
 * never fields manufactured from both writes.
 */

const UUID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";

const BASE = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "11111111-1111-1111-1111-111111111111")
\t(paper "A4")
\t(lib_symbols)
\t(sheet_instances (path "/" (page "1")))
)
`;

const LEFT = BASE.replace(
  "\n\t(sheet_instances",
  `\n\t(wire (pts (xy 10 20) (xy 30 40)) (stroke (width 0.25) (type default)) (uuid "${UUID}"))\n\t(sheet_instances`,
);

const RIGHT = BASE.replace(
  "\n\t(sheet_instances",
  `\n\t(text "RIGHT-TEXT" (exclude_from_sim no) (at 70 80 0) (effects (font (size 2 3))) (uuid "${UUID}"))\n\t(sheet_instances`,
);

const SCH: ToolCfg = {
  html: "eeschema.html",
  ext: "kicad_sch",
  saveFn: "kicadSaveSchematic",
  fixture: BASE,
  fns: [],
};

const PL_BASE = `(kicad_wks
\t(version 20220228)
\t(generator "pl_editor")
\t(generator_version "9.0")
\t(setup
\t\t(textsize 1.5 1.5)
\t\t(linewidth 0.15)
\t\t(textlinewidth 0.15)
\t\t(left_margin 10)
\t\t(right_margin 10)
\t\t(top_margin 10)
\t\t(bottom_margin 10)
\t)
)
`;

const PL_LEFT = PL_BASE.replace(
  "\n)\n",
  `\n\t(rect (uuid "${UUID}") (name left-rect) (start 11 12 ltcorner) (end 31 42 rbcorner))\n)\n`,
);

const PL_RIGHT = PL_BASE.replace(
  "\n)\n",
  `\n\t(tbtext "RIGHT-TEXT" (uuid "${UUID}") (name right-text) (pos 70 80 ltcorner) (font (size 2 3)))\n)\n`,
);

const PL: ToolCfg = {
  html: "pl_editor.html",
  ext: "kicad_wks",
  saveFn: "kicadSaveDrawingSheet",
  fixture: PL_BASE,
  fns: [],
};

const PL_SETUP_LEFT = PL_BASE.replace("(textsize 1.5 1.5)", "(textsize 2.1 2.2)")
  .replace("(linewidth 0.15)", "(linewidth 0.21)")
  .replace("(textlinewidth 0.15)", "(textlinewidth 0.22)")
  .replace("(left_margin 10)", "(left_margin 11)")
  .replace("(right_margin 10)", "(right_margin 12)")
  .replace("(top_margin 10)", "(top_margin 13)")
  .replace("(bottom_margin 10)", "(bottom_margin 14)");

const PL_SETUP_RIGHT = PL_BASE.replace("(textsize 1.5 1.5)", "(textsize 3.1 3.2)")
  .replace("(linewidth 0.15)", "(linewidth 0.31)")
  .replace("(textlinewidth 0.15)", "(textlinewidth 0.32)")
  .replace("(left_margin 10)", "(left_margin 21)")
  .replace("(right_margin 10)", "(right_margin 22)")
  .replace("(top_margin 10)", "(top_margin 23)")
  .replace("(bottom_margin 10)", "(bottom_margin 24)");

const POLY_UUID = "cccccccc-1111-2222-3333-dddddddddddd";
const PCB_BASE = `(kicad_pcb
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
	(gr_poly
		(pts (xy 0 0) (xy 10 0) (xy 10 10))
		(stroke (width 0.2) (type default))
		(fill none)
		(layer "F.SilkS")
		(uuid "${POLY_UUID}")
	)
)
`;

const PCB_POLY_EDITED = PCB_BASE.replace(
  "(pts (xy 0 0) (xy 10 0) (xy 10 10))",
  "(pts (xy 7 7) (xy 10 0) (xy 10 10))",
);
const PCB_POLY_INSERTED = PCB_BASE.replace(
  "(pts (xy 0 0) (xy 10 0) (xy 10 10))",
  "(pts (xy 9 9) (xy 0 0) (xy 10 0) (xy 10 10))",
);

const PCB: ToolCfg = {
  html: "pcbnew-collab.html",
  ext: "kicad_pcb",
  saveFn: "kicadSaveBoard",
  fixture: PCB_BASE,
  fns: [],
};

const LIB_LEFT = TRIO_SCH.fixture
  .replace(
    '(property "Reference" "R" (at 2.032 0 90)',
    '(property "Reference" "LEFT-LIB-REF" (at 2.032 0 90)',
  )
  .replace(
    '(property "Value" "R" (at 0 0 90)',
    '(property "Value" "LEFT-LIB-VALUE" (at 0 0 90)',
  );

const LIB_RIGHT = TRIO_SCH.fixture
  .replace(
    '(property "Reference" "R" (at 2.032 0 90)',
    '(property "Reference" "RIGHT-LIB-REF" (at 2.032 0 90)',
  )
  .replace(
    '(property "Value" "R" (at 0 0 90)',
    '(property "Value" "RIGHT-LIB-VALUE" (at 0 0 90)',
  );

const LIB_SCH: ToolCfg = { ...SCH, fixture: TRIO_SCH.fixture };

function occurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function expectOneCompleteAuthoredItem(text: string, source: string): void {
  expect(occurrences(text, /\(version \d+\)/g), `${source}: one root version`).toBe(1);
  expect(occurrences(text, new RegExp(UUID, "g")), `${source}: one root UUID`).toBe(1);
  expect(occurrences(text, /\((?:wire|text)\b/g), `${source}: one root item`).toBe(1);

  const completeLeft = [
    "(wire",
    "(xy 10 20)",
    "(xy 30 40)",
    "(width 0.25)",
  ].every((marker) => text.includes(marker));
  const completeRight = [
    '(text "RIGHT-TEXT"',
    "(at 70 80 0)",
    "(font (size 2 3))",
  ].every((marker) => text.includes(marker));

  expect(
    [completeLeft, completeRight].filter(Boolean),
    `${source}: output must equal one complete authored conflict domain`,
  ).toHaveLength(1);
}

function expectOneCompletePlItem(text: string, source: string): void {
  expect(occurrences(text, /\(version \d+\)/g), `${source}: one root version`).toBe(1);
  expect(occurrences(text, new RegExp(UUID, "g")), `${source}: one root UUID`).toBe(1);
  expect(occurrences(text, /\((?:rect|tbtext)\b/g), `${source}: one root item`).toBe(1);

  // PL's writer quotes names and drops the default `rbcorner` anchor. Accept
  // those native normalizations while still requiring every semantic field
  // from one branch and forbidding fields from the other branch.
  const completeLeft =
    text.includes("(rect") &&
    /\(name "?left-rect"?\)/.test(text) &&
    text.includes("(start 11 12 ltcorner)") &&
    /\(end 31 42(?: rbcorner)?\)/.test(text) &&
    !text.includes("RIGHT-TEXT") &&
    !text.includes("(pos 70 80") &&
    !text.includes("(font (size 2 3))");
  const completeRight =
    text.includes('(tbtext "RIGHT-TEXT"') &&
    /\(name "?right-text"?\)/.test(text) &&
    text.includes("(pos 70 80 ltcorner)") &&
    text.includes("(font (size 2 3))") &&
    !text.includes("(start 11 12") &&
    !text.includes("(end 31 42");

  expect(
    [completeLeft, completeRight].filter(Boolean),
    `${source}: output must equal one complete authored conflict domain`,
  ).toHaveLength(1);
}

function applyConcurrentRootsWithDeadline(
  page: Parameters<typeof modelText>[0],
  left: string,
  right: string,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const projection = page.evaluate(
    ({ leftText, rightText }) => {
      const collab = (window as unknown as {
        KicadCollabV2: {
          applyConcurrentRootCreations(leftDoc: string, rightDoc: string): string;
        };
      }).KicadCollabV2;
      return collab.applyConcurrentRootCreations(leftText, rightText);
    },
    { leftText: left, rightText: right },
  );
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`concurrent root projection did not return within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([projection, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

type TestPage = Parameters<typeof modelText>[0];

interface ProjectionFailure {
  kind: string;
  message: string;
  recovery: string;
}

function projectionFailures(page: TestPage): Promise<ProjectionFailure[]> {
  return page.evaluate(() =>
    (window as unknown as {
      KicadCollabV2: { projectionFailures(): ProjectionFailure[] };
    }).KicadCollabV2.projectionFailures(),
  );
}

function layoutHead(page: TestPage, fileText: string, head: string): Promise<string> {
  return page.evaluate(
    ({ fileText, head }) =>
      (window as unknown as {
        KicadCollabV2: { layoutHead(text: string, key: string): string };
      }).KicadCollabV2.layoutHead(fileText, head),
    { fileText, head },
  );
}

function auditPage(page: TestPage): {
  projectionAttempts(): number;
  aborts(): string[];
} {
  let attempts = 0;
  const aborts: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("desired Y state → apply to editor")) attempts += 1;
    if (text.includes("Aborted(")) aborts.push(text);
  });
  page.on("pageerror", (error) => {
    if (error.message.includes("Aborted(")) aborts.push(error.message);
  });
  return {
    projectionAttempts: () => attempts,
    aborts: () => aborts.slice(),
  };
}

function balancedForm(text: string, head: string): string {
  const start = text.indexOf(`(${head}`);
  if (start < 0) throw new Error(`missing (${head} …) form`);

  let depth = 0;
  let quoted = false;
  let escaped = false;
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated (${head} …) form`);
}

const EDITED_POINTS = [
  [7, 7],
  [10, 0],
  [10, 10],
] as const;
const INSERTED_POINTS = [
  [9, 9],
  [0, 0],
  [10, 0],
  [10, 10],
] as const;

function polygonPoints(text: string): number[][] {
  const polygon = balancedForm(text, "gr_poly");
  const points = balancedForm(polygon, "pts");
  return [...points.matchAll(/\(xy\s+(-?(?:\d+(?:\.\d*)?|\.\d+))\s+(-?(?:\d+(?:\.\d*)?|\.\d+))\)/g)]
    .map((match) => [Number(match[1]), Number(match[2])]);
}

function expectOneAuthoredPolygonSequence(text: string, source: string): number[][] {
  expect(occurrences(text, new RegExp(POLY_UUID, "g")), `${source}: one polygon UUID`).toBe(1);
  expect(occurrences(text, /\(gr_poly\b/g), `${source}: one polygon`).toBe(1);
  const actual = polygonPoints(text);
  expect(
    [EDITED_POINTS, INSERTED_POINTS],
    `${source}: pts must be one authored anonymous sequence, never an insert/edit hybrid`,
  ).toContainEqual(actual);
  return actual;
}

function expectOneAuthoredLibraryDefinition(text: string, source: string): void {
  expect(
    occurrences(text, /\(symbol "Device:R"/g),
    `${source}: one Device:R definition`,
  ).toBe(1);

  const completeLeft =
    text.includes('"LEFT-LIB-REF"') &&
    text.includes('"LEFT-LIB-VALUE"') &&
    !text.includes('"RIGHT-LIB-REF"') &&
    !text.includes('"RIGHT-LIB-VALUE"');
  const completeRight =
    text.includes('"RIGHT-LIB-REF"') &&
    text.includes('"RIGHT-LIB-VALUE"') &&
    !text.includes('"LEFT-LIB-REF"') &&
    !text.includes('"LEFT-LIB-VALUE"');
  expect(
    [completeLeft, completeRight].filter(Boolean),
    `${source}: same-ID definition must equal one complete authored value`,
  ).toHaveLength(1);
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

test.describe("Yjs conflict domains — PL native late projection", () => {
  test.describe.configure({ timeout: 90_000 });

  test("same-UUID rect-vs-tbtext selects one complete native item without looping", async ({
    context,
    testLogger,
  }) => {
    const room = `ysync-conflict-domain-pl-${test.info().workerIndex}`;
    const producer = await context.newPage();
    let projectionAttempts = 0;
    producer.on("console", (message) => {
      if (message.text().includes("desired Y state → apply to editor")) projectionAttempts += 1;
    });

    try {
      await bootOpen(producer, PL);
      await startV2(producer, { room, seedText: PL_BASE });

      const merged = await applyConcurrentRootsWithDeadline(
        producer,
        PL_LEFT,
        PL_RIGHT,
        20_000,
      );
      expectOneCompletePlItem(merged, "PL merged Y.Doc");

      await expect
        .poll(async () => (await modelText(producer, PL)).includes(UUID), {
          timeout: 20_000,
          intervals: [300],
        })
        .toBe(true);

      const native = await modelText(producer, PL);
      expectOneCompletePlItem(native, "PL late native save");
      expect(projectionAttempts, "PL projection must reach a fixed point").toBeLessThanOrEqual(3);

      const roomDoc = await renderDoc(producer);
      expect(roomDoc.err, "PL room must materialize").toBeUndefined();
      expect(roomDoc.ok).toBe(merged);
      expect(hasAbort(testLogger), "no Wasm abort").toBe(false);
    } finally {
      await producer.close({ runBeforeUnload: false });
    }
  });

  test("concurrent setup replacements select one whole group and rehydrate fresh Wasm", async ({
    context,
  }) => {
    const room = `ysync-conflict-domain-layout-${test.info().workerIndex}`;
    const producer = await context.newPage();
    const producerAudit = auditPage(producer);
    let recovered: TestPage | undefined;
    let recoveredAudit: ReturnType<typeof auditPage> | undefined;

    try {
      await bootOpen(producer, PL);
      await startV2(producer, { room, seedText: PL_BASE });

      const [leftGroup, rightGroup] = await Promise.all([
        layoutHead(producer, PL_SETUP_LEFT, "setup"),
        layoutHead(producer, PL_SETUP_RIGHT, "setup"),
      ]);
      expect(leftGroup, "the authored groups must be observably distinct").not.toBe(rightGroup);

      const merged = await applyConcurrentRootsWithDeadline(
        producer,
        PL_SETUP_LEFT,
        PL_SETUP_RIGHT,
        20_000,
      );
      const mergedGroup = await layoutHead(producer, merged, "setup");
      expect(
        [leftGroup, rightGroup],
        "merged Y must select one complete authored setup register",
      ).toContain(mergedGroup);

      await expect
        .poll(() => projectionFailures(producer), { timeout: 10_000, intervals: [100] })
        .toHaveLength(1);
      expect((await projectionFailures(producer))[0]).toMatchObject({
        kind: "non-item-structure",
        recovery: "recreate-from-yjs",
      });
      expect(
        producerAudit.projectionAttempts(),
        "structural drift fails before any item-only native apply",
      ).toBe(0);

      const authority = await renderDoc(producer);
      expect(authority.err, "merged room remains materializable").toBeUndefined();
      expect(authority.ok).toBe(merged);

      // Recovery deliberately creates a new editor generation from the exact
      // materialized authority. The retired native owner is never repaired in
      // place because the item bridge cannot apply root/layout structure.
      const recoveryCfg: ToolCfg = { ...PL, fixture: merged };
      recovered = await context.newPage();
      recoveredAudit = auditPage(recovered);
      await bootOpen(recovered, recoveryCfg);
      await startV2(recovered, { room, editorMatchesDoc: true });
      await expect
        .poll(async () => (await renderDoc(recovered!)).ok, {
          timeout: 15_000,
          intervals: [200],
        })
        .toBe(merged);

      const native = await modelText(recovered, recoveryCfg);
      expect(await layoutHead(recovered, native, "setup"), "fresh native save keeps winner").toBe(
        mergedGroup,
      );
      expect(
        recoveredAudit.projectionAttempts(),
        "matching fresh native baseline requires no corrective apply",
      ).toBeLessThanOrEqual(1);
      expect(await projectionFailures(recovered), "fresh owner stays live").toEqual([]);
      expect([...producerAudit.aborts(), ...recoveredAudit.aborts()], "no Wasm abort").toEqual([]);
    } finally {
      if (recovered) await recovered.close({ runBeforeUnload: false });
      await producer.close({ runBeforeUnload: false });
    }
  });
});

test.describe("Yjs conflict domains — pcbnew anonymous nested sequence", () => {
  test.describe.configure({ timeout: 180_000 });

  test("concurrent gr_poly pts insert-vs-edit projects exactly one authored sequence", async ({
    context,
  }) => {
    const room = `ysync-conflict-domain-poly-${test.info().workerIndex}`;
    const producer = await context.newPage();
    const audit = auditPage(producer);

    try {
      await bootOpen(producer, PCB);
      await startV2(producer, { room, seedText: PCB_BASE });

      const merged = await applyConcurrentRootsWithDeadline(
        producer,
        PCB_POLY_EDITED,
        PCB_POLY_INSERTED,
        20_000,
      );
      const mergedPoints = expectOneAuthoredPolygonSequence(merged, "pcbnew merged Y.Doc");

      await expect
        .poll(
          async () => {
            try {
              return polygonPoints(await modelText(producer, PCB));
            } catch {
              return [];
            }
          },
          { timeout: 20_000, intervals: [300] },
        )
        .toEqual(mergedPoints);

      const native = await modelText(producer, PCB);
      expect(expectOneAuthoredPolygonSequence(native, "pcbnew late native save")).toEqual(
        mergedPoints,
      );
      expect(audit.projectionAttempts(), "pcbnew projection reaches a fixed point").toBeLessThanOrEqual(
        3,
      );
      expect(await projectionFailures(producer), "item projection stays live").toEqual([]);

      const roomDoc = await renderDoc(producer);
      expect(roomDoc.err, "pcbnew room must materialize").toBeUndefined();
      expect(roomDoc.ok).toBe(merged);
      expect(audit.aborts(), "no Wasm abort").toEqual([]);
    } finally {
      await producer.close({ runBeforeUnload: false });
    }
  });
});

test.describe("Yjs conflict domains — Eeschema same-ID library definition", () => {
  test.describe.configure({ timeout: 180_000 });

  test("concurrent Device:R definitions select one whole value through fresh rehydration", async ({
    context,
  }) => {
    const room = `ysync-conflict-domain-lib-${test.info().workerIndex}`;
    const producer = await context.newPage();
    const producerAudit = auditPage(producer);
    let recovered: TestPage | undefined;
    let recoveredAudit: ReturnType<typeof auditPage> | undefined;

    try {
      await bootOpen(producer, LIB_SCH);
      await startV2(producer, { room, seedText: TRIO_SCH.fixture });

      const merged = await applyConcurrentRootsWithDeadline(
        producer,
        LIB_LEFT,
        LIB_RIGHT,
        20_000,
      );
      expectOneAuthoredLibraryDefinition(merged, "Eeschema merged Y.Doc");
      const leftWon = merged.includes('"LEFT-LIB-REF"');

      await expect
        .poll(() => projectionFailures(producer), { timeout: 10_000, intervals: [100] })
        .toHaveLength(1);
      expect((await projectionFailures(producer))[0]).toMatchObject({
        kind: "non-item-structure",
        recovery: "recreate-from-yjs",
      });
      expect(
        producerAudit.projectionAttempts(),
        "library drift fails before an item-only native apply",
      ).toBe(0);

      const authority = await renderDoc(producer);
      expect(authority.err, "library-conflicted room remains materializable").toBeUndefined();
      expect(authority.ok).toBe(merged);

      const recoveryCfg: ToolCfg = { ...LIB_SCH, fixture: merged };
      recovered = await context.newPage();
      recoveredAudit = auditPage(recovered);
      await bootOpen(recovered, recoveryCfg);
      await startV2(recovered, { room, editorMatchesDoc: true });
      await expect
        .poll(async () => (await renderDoc(recovered!)).ok, {
          timeout: 15_000,
          intervals: [200],
        })
        .toBe(merged);

      const native = await modelText(recovered, recoveryCfg);
      expectOneAuthoredLibraryDefinition(native, "Eeschema fresh native save");
      expect(
        native.includes('"LEFT-LIB-REF"'),
        "fresh save must preserve the same atomic definition winner as Y",
      ).toBe(leftWon);
      expect(
        recoveredAudit.projectionAttempts(),
        "matching fresh native baseline requires no corrective apply",
      ).toBeLessThanOrEqual(1);
      expect(await projectionFailures(recovered), "fresh owner stays live").toEqual([]);
      expect([...producerAudit.aborts(), ...recoveredAudit.aborts()], "no Wasm abort").toEqual([]);
    } finally {
      if (recovered) await recovered.close({ runBeforeUnload: false });
      await producer.close({ runBeforeUnload: false });
    }
  });
});

test.describe("Yjs conflict domains — native late projection", () => {
  test.describe.configure({ timeout: 420_000 });

  test("same-UUID concurrent root creation serializes one complete authored item", async ({
    context,
    testLogger,
  }) => {
    const room = `ysync-conflict-domain-${test.info().workerIndex}`;
    const producer = await context.newPage();
    await bootOpen(producer, SCH);
    await startV2(producer, { room, seedText: BASE });

    const merged = await producer.evaluate(
      ({ left, right }) => {
        const collab = (window as unknown as {
          KicadCollabV2: {
            applyConcurrentRootCreations(leftText: string, rightText: string): string;
          };
        }).KicadCollabV2;
        return collab.applyConcurrentRootCreations(left, right);
      },
      { left: LEFT, right: RIGHT },
    );
    expectOneCompleteAuthoredItem(merged, "merged Y.Doc");

    // The helper merged both isolated replicas before it delivered one update
    // to this bound editor. Native never saw either authored branch and can
    // only project the selected canonical Y state through the production
    // binding and Wasm apply path.
    await expect
      .poll(async () => (await modelText(producer, SCH)).includes(UUID), {
        timeout: 30_000,
        intervals: [300],
      })
      .toBe(true);

    const native = await modelText(producer, SCH);
    expectOneCompleteAuthoredItem(native, "late native save");

    const roomDoc = await renderDoc(producer);
    expect(roomDoc.err, "room must materialize").toBeUndefined();
    expect(roomDoc.ok).toBe(merged);
    expect(hasAbort(testLogger), "no Wasm abort").toBe(false);

    await producer.close();
  });
});
