import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const BOOT_TIMEOUT = 150_000;
const DIR = "/home/kicad/documents";
const STEM = "eeschema-project-save-fence";
const ROOT_UUID = "10000000-0000-0000-0000-000000000000";
const ROOT_WIRE_UUID = "1aaaaaaa-0000-0000-0000-000000000001";
const SHEET_SYMBOL_UUID = "5ee70000-0000-0000-0000-000000000001";
const CHILD_WIRE_UUID = "2ccccccc-0000-0000-0000-000000000001";

const ROOT_SCH = `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "${ROOT_UUID}")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${ROOT_WIRE_UUID}"))
	(sheet (at 127 50.8) (size 20 20)
		(stroke (width 0.1524) (type solid))
		(fill (color 0 0 0 0.0000))
		(uuid "${SHEET_SYMBOL_UUID}")
		(property "Sheetname" "child" (at 127 50 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
		(property "Sheetfile" "child.kicad_sch" (at 127 71 0) (effects (font (size 1.27 1.27)) (justify left top)))
		(instances (project "${STEM}" (path "/${ROOT_UUID}" (page "2"))))
	)
	(sheet_instances (path "/" (page "1")))
)
`;

const CHILD_SCH = `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "20000000-0000-0000-0000-000000000000")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 25.4 25.4) (xy 76.2 25.4)) (stroke (width 0) (type default)) (uuid "${CHILD_WIRE_UUID}"))
	(sheet_instances (path "/" (page "1")))
)
`;

const PROJECT = `${JSON.stringify(
  { meta: { filename: `${STEM}.kicad_pro`, version: 3 }, sheets: [] },
  null,
  2,
)}\n`;

interface Ack {
  requestId: string;
  status: string;
}

interface SnapshotItem {
  parent: string | null;
  sexpr: string;
}

interface NativeModule {
  kicadOpenFile(path: string): unknown;
  kicadCollabApplyItems(json: string): unknown;
  kicadCollabReleaseItemsOwner(owner: string): void;
  kicadCollabSetItemsOwner(owner: string): boolean;
  kicadCollabSnapshotItems(): string;
  kicadCollabTestMoveFirst(dx: number, dy: number): string;
}

interface ProbeWindow {
  FS: {
    mkdirTree(path: string): void;
    readFile(path: string, opts: { encoding: "utf8" }): string;
    writeFile(path: string, data: string): void;
  };
  Module: NativeModule;
  kicadCollab?: {
    onItemsApplied?: (json: string) => void;
    onSave?: (path: string) => void;
  };
  __acks?: Ack[];
  __saveEvents?: Array<{ path: string; text: string }>;
}

async function bootProject(page: Page): Promise<void> {
  await page.goto("/kicad/eeschema.html");
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    () => typeof (window.Module as Partial<NativeModule>)?.kicadOpenFile === "function",
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.waitForFunction(
    () =>
      !!window.wxElementRegistry &&
      window.wxElementRegistry
        .findAll({ visible: true })
        .some((element) =>
          /Frame$/.test(element.typeName) || (element.name || "").endsWith("Frame"),
        ),
    null,
    { timeout: BOOT_TIMEOUT },
  );
  await page.evaluate(
    ({ child, dir, project, root, stem }) => {
      const runtime = window as unknown as ProbeWindow;
      try {
        runtime.FS.mkdirTree(dir);
      } catch {
        // The shared MEMFS documents directory already exists.
      }
      runtime.FS.writeFile(`${dir}/child.kicad_sch`, child);
      runtime.FS.writeFile(`${dir}/${stem}.kicad_pro`, project);
      runtime.FS.writeFile(`${dir}/${stem}.kicad_sch`, root);
      runtime.Module.kicadOpenFile(`${dir}/${stem}.kicad_sch`);
    },
    { child: CHILD_SCH, dir: DIR, project: PROJECT, root: ROOT_SCH, stem: STEM },
  );
  await expect.poll(() => page.title(), { timeout: BOOT_TIMEOUT }).toContain(STEM);
}

async function focusCanvas(page: Page): Promise<void> {
  const box = await page.locator("#canvas").boundingBox();
  expect(box, "#canvas has a bounding box").not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.waitForTimeout(300); // wx has no JS-observable focus-settled signal.
}

function hasAbort(log: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...log.consoleLogs, ...log.errors].some((line) => line.includes("Aborted("));
}

test.describe("eeschema project save projection cut", () => {
  test.describe.configure({ timeout: 420_000 });

  test("one cut spans every sheet, the final project bytes, and its persistence callback", async ({
    page,
    testLogger,
  }) => {
    await bootProject(page);

    const armed = await page.evaluate(
      ({ rootWireUuid, stem }) => {
        const runtime = window as unknown as ProbeWindow;
        const snapshot = JSON.parse(runtime.Module.kicadCollabSnapshotItems()) as {
          added: SnapshotItem[];
        };
        const wire = snapshot.added.find((item) => item.sexpr.includes(rootWireUuid));
        if (!wire) throw new Error(`root wire ${rootWireUuid} is absent from snapshot`);

        const changed = wire.sexpr.replace(
          /\(xy\s+[-+0-9.eE]+\s+[-+0-9.eE]+\)/,
          "(xy 55.8 50.8)",
        );
        if (changed === wire.sexpr) throw new Error("wire change fixture did not match");

        const owner = "eeschema-project-save-owner";
        const acquired = runtime.Module.kicadCollabSetItemsOwner(owner);
        runtime.__acks = [];
        runtime.__saveEvents = [];
        let injectedAtFinalProjectCallback = false;
        const previousAck = runtime.kicadCollab?.onItemsApplied;
        const previousSave = runtime.kicadCollab?.onSave;
        runtime.kicadCollab = {
          ...runtime.kicadCollab,
          onItemsApplied: (json: string) => {
            runtime.__acks!.push(JSON.parse(json) as Ack);
            previousAck?.(json);
          },
          onSave: (path: string) => {
            runtime.__saveEvents!.push({
              path,
              text: runtime.FS.readFile(path, { encoding: "utf8" }),
            });

            if (path.endsWith(`${stem}.kicad_pro`) && !injectedAtFinalProjectCallback) {
              injectedAtFinalProjectCallback = true;
              runtime.Module.kicadCollabApplyItems(
                JSON.stringify({
                  added: [],
                  changed: [{ parent: wire.parent ?? null, sexpr: changed }],
                  removed: [],
                  _pcbjam: {
                    ownerGeneration: owner,
                    requestId: "during-final-project-callback",
                  },
                }),
              );
            }

            previousSave?.(path);
          },
        };

        return { acquired, changed, owner, parent: wire.parent ?? null };
      },
      { rootWireUuid: ROOT_WIRE_UUID, stem: STEM },
    );
    expect(armed.acquired).toBe(true);

    // A real local mutation enables the user Save action.  SaveProject then
    // walks both screens and performs its final project settings write.
    expect(
      await page.evaluate(() =>
        (window as unknown as ProbeWindow).Module.kicadCollabTestMoveFirst(200_000, 0),
      ),
    ).toMatch(/[0-9a-f-]{36}/);
    await focusCanvas(page);
    await page.keyboard.press("Control+s");

    await expect
      .poll(
        () =>
          page.evaluate(
            (stem) =>
              ((window as unknown as ProbeWindow).__saveEvents ?? []).filter(({ path }) =>
                path.endsWith(`${stem}.kicad_pro`),
              ).length,
            STEM,
          ),
        { timeout: 30_000, intervals: [100, 250] },
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              ((window as unknown as ProbeWindow).__acks ?? []).find(
                ({ requestId }) => requestId === "during-final-project-callback",
              )?.status,
          ),
        { timeout: 30_000, intervals: [100, 250] },
      )
      .toBe("busy");

    const saveEvents = await page.evaluate(
      () => (window as unknown as ProbeWindow).__saveEvents ?? [],
    );
    expect(saveEvents.some(({ path }) => path.endsWith(`${STEM}.kicad_sch`))).toBe(true);
    expect(saveEvents.some(({ path }) => path.endsWith("child.kicad_sch"))).toBe(true);

    const projectEvents = saveEvents.filter(({ path }) => path.endsWith(`${STEM}.kicad_pro`));
    expect(
      projectEvents,
      "the stale pre-sheet-map project callback is suppressed",
    ).toHaveLength(1);
    const finalProject = JSON.parse(projectEvents[0]!.text) as {
      sheets?: Array<[string, string]>;
    };
    expect(
      finalProject.sheets,
      "the callback observes the sheet map written at the end of SaveProject",
    ).toEqual(
      expect.arrayContaining([
        [ROOT_UUID, "Root"],
        [SHEET_SYMBOL_UUID, "child"],
      ]),
    );

    // The callback returned and SaveProject's outer scope has now unwound.  A
    // retry of the exact same projection can enter native and acknowledge.
    await page.evaluate(({ changed, owner, parent }) => {
      const runtime = window as unknown as ProbeWindow;
      runtime.Module.kicadCollabApplyItems(
        JSON.stringify({
          added: [],
          changed: [{ parent, sexpr: changed }],
          removed: [],
          _pcbjam: { ownerGeneration: owner, requestId: "after-project-save" },
        }),
      );
    }, armed);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              ((window as unknown as ProbeWindow).__acks ?? []).find(
                ({ requestId }) => requestId === "after-project-save",
              )?.status,
          ),
        { timeout: 30_000, intervals: [100, 250] },
      )
      .toBe("applied");
    await page.evaluate((owner) => {
      (window as unknown as ProbeWindow).Module.kicadCollabReleaseItemsOwner(owner);
    }, armed.owner);

    expect(hasAbort(testLogger), "save fencing does not trap or re-enter Wasm").toBe(false);
  });
});
