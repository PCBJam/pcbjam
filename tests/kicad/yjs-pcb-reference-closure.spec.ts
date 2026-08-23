import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { fileToDoc } from "../../web/pcbjam-shared/src/index.js";
import { expect, test } from "./fixtures";
import { TRIO_PCB, bootOpen, callHook, modelText, type ToolCfg } from "./utils/trio";

/**
 * Real-Wasm regressions for KiCad's pointer-based PCB_GROUP/PCB_GENERATOR
 * relation.  These intentionally send isolated root blobs, exactly as the Yjs
 * projector does.  KiCad's parser can only resolve `(members ...)` while
 * parsing a complete BOARD, so the collaboration applier must preserve and
 * rebind the UUID graph after every root in the batch is known.
 */

const ROOT = path.resolve(__dirname, "../..");
const read = (relative: string): string =>
  fs.readFileSync(path.join(ROOT, relative), "utf8");

const GROUPED_PCB: ToolCfg = {
  ...TRIO_PCB,
  fixture: read("kicad/demos/stickhub/StickHub.kicad_pcb"),
};
const GENERATED_PCB: ToolCfg = {
  ...TRIO_PCB,
  fixture: read("kicad/qa/data/pcbnew/diff_pair_uncoupled_tuning_drc.kicad_pcb"),
};

interface ItemsSnapshot {
  added: Array<{ sexpr: string }>;
}

interface ReferenceWindow {
  FS: {
    readFile(path: string, opts: { encoding: "utf8" }): string;
  };
  Module: {
    kicadCollabBusy(): boolean;
    kicadCollabTestSaveCurrent(): Promise<boolean>;
  };
  kicadCollab?: Record<string, unknown> & { onSave?: (path: string) => void };
  __pcbReferenceSaves?: Array<{ path: string; text: string }>;
}

test.beforeAll(() => {
  execSync("node collab/build.mjs", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
});

function balancedForm(text: string, head: "group" | "generated", uuid: string): string {
  let cursor = text.indexOf(`(${head}`);

  while (cursor >= 0) {
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let i = cursor; i < text.length; i += 1) {
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
        if (form.toLowerCase().includes(uuid.toLowerCase())) return form;
        cursor = text.indexOf(`(${head}`, i + 1);
        break;
      }
    }
  }

  throw new Error(`${head} ${uuid} is missing`);
}

function memberUuids(ownerForm: string): string[] {
  const members = /\(members\b([^()]*)\)/i.exec(ownerForm)?.[1];
  if (members === undefined) throw new Error("reference owner has no direct members form");

  return [
    ...members.matchAll(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ),
  ]
    .map(([uuid]) => uuid.toLowerCase())
    .sort();
}

async function snapshot(page: Page): Promise<ItemsSnapshot> {
  return JSON.parse(
    await callHook<string>(page, "kicadCollabSnapshotItems"),
  ) as ItemsSnapshot;
}

async function applyChangedRoot(page: Page, id: string, sexpr: string): Promise<void> {
  await callHook(
    page,
    "kicadCollabApplyItems",
    JSON.stringify({
      added: [],
      changed: [{ id, parent: null, sexpr }],
      removed: [],
    }),
  );
  await page.waitForFunction(
    () => !(window as unknown as ReferenceWindow).Module.kicadCollabBusy(),
    null,
    { timeout: 30_000 },
  );
}

async function saveCurrentBytes(page: Page): Promise<string> {
  await page.evaluate(() => {
    const runtime = window as unknown as ReferenceWindow;
    const previous = runtime.kicadCollab?.onSave;
    runtime.__pcbReferenceSaves = [];
    runtime.kicadCollab = {
      ...runtime.kicadCollab,
      onSave: (savedPath: string) => {
        runtime.__pcbReferenceSaves!.push({
          path: savedPath,
          text: runtime.FS.readFile(savedPath, { encoding: "utf8" }),
        });
        previous?.(savedPath);
      },
    };
  });

  expect(
    await page.evaluate(async () =>
      (window as unknown as ReferenceWindow).Module.kicadCollabTestSaveCurrent(),
    ),
    "the production PCB_EDIT_FRAME save completed",
  ).toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as ReferenceWindow).__pcbReferenceSaves?.length ?? 0,
        ),
      { timeout: 30_000, intervals: [100] },
    )
    .toBeGreaterThan(0);

  const saved = await page.evaluate(() => {
    const writes = (window as unknown as ReferenceWindow).__pcbReferenceSaves ?? [];
    return [...writes].reverse().find(({ path: savedPath }) =>
      savedPath.endsWith(".kicad_pcb"),
    )?.text;
  });
  expect(saved, "onSave exposed the exact persisted PCB bytes").toBeDefined();
  return saved!;
}

function ownerFromDocument(
  text: string,
  type: "group" | "generated",
): { id: string; item: ReturnType<typeof fileToDoc>["items"][string] } {
  const match = Object.entries(fileToDoc(text).items).find(([, item]) => item.type === type);
  expect(match, `real corpus contains a ${type} root`).toBeTruthy();
  return { id: match![0], item: match![1] };
}

function rootBlob(wire: ItemsSnapshot, uuid: string): string {
  const entry = wire.added.find((candidate) =>
    candidate.sexpr.toLowerCase().includes(`(uuid "${uuid.toLowerCase()}")`),
  );
  expect(entry, `native snapshot contains root ${uuid}`).toBeTruthy();
  return entry!.sexpr;
}

test.describe("PCB group/generator reference closure", () => {
  test.describe.configure({ timeout: 300_000 });

  test("identical StickHub group apply -> production save preserves every member", async ({
    page,
  }) => {
    await bootOpen(page, GROUPED_PCB);
    const normalized = await modelText(page, GROUPED_PCB);
    const source = ownerFromDocument(normalized, "group");
    const wire = await snapshot(page);
    const blob = rootBlob(wire, source.id);
    const expectedMembers = memberUuids(balancedForm(blob, "group", source.id));
    expect(expectedMembers.length, "the real group has reference-bearing members").toBeGreaterThan(
      0,
    );

    await applyChangedRoot(page, source.id, blob);
    const persisted = await saveCurrentBytes(page);

    expect(fileToDoc(persisted).items[source.id], "saved group AST is exact").toEqual(source.item);
    expect(memberUuids(balancedForm(persisted, "group", source.id))).toEqual(expectedMembers);
  });

  test("identical tuning generator apply -> save preserves every generated reference", async ({
    page,
  }) => {
    await bootOpen(page, GENERATED_PCB);
    const normalized = await modelText(page, GENERATED_PCB);
    const source = ownerFromDocument(normalized, "generated");
    const wire = await snapshot(page);
    const blob = rootBlob(wire, source.id);
    const expectedMembers = memberUuids(balancedForm(blob, "generated", source.id));
    expect(
      expectedMembers.length,
      "the real tuning generator has reference-bearing members",
    ).toBeGreaterThan(0);

    await applyChangedRoot(page, source.id, blob);
    const saved = await modelText(page, GENERATED_PCB);

    expect(fileToDoc(saved).items[source.id], "saved generator AST is exact").toEqual(source.item);
    expect(memberUuids(balancedForm(saved, "generated", source.id))).toEqual(expectedMembers);
  });

  test("replacing a known StickHub member preserves its group through production save", async ({
    page,
  }) => {
    await bootOpen(page, GROUPED_PCB);
    const normalized = await modelText(page, GROUPED_PCB);
    const source = ownerFromDocument(normalized, "group");
    const wire = await snapshot(page);
    const groupBlob = rootBlob(wire, source.id);
    const expectedMembers = memberUuids(balancedForm(groupBlob, "group", source.id));
    const member = expectedMembers
      .map((id) => ({ id, blob: rootBlob(wire, id) }))
      .find(({ blob }) => !blob.includes(`(group `) && !blob.includes(`(generated`));
    expect(member, "the real group has a replaceable non-owner root member").toBeTruthy();

    await applyChangedRoot(page, member!.id, member!.blob);
    const persisted = await saveCurrentBytes(page);

    expect(fileToDoc(persisted).items[source.id], "saved group AST is exact").toEqual(source.item);
    expect(memberUuids(balancedForm(persisted, "group", source.id))).toEqual(expectedMembers);
    expect(
      memberUuids(balancedForm(persisted, "group", source.id)),
      "replacement UUID remains owned by the group",
    ).toContain(member!.id);
  });
});
