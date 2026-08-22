import { execSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "./fixtures";
import {
  bootOpen,
  hasAbort,
  modelText,
  renderDoc,
  startV2,
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

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
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
