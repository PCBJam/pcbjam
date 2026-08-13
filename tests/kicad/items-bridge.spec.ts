import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * v2 "items" bridge (ysync 0008 Stage C): per-item s-expr payloads on
 * kicadCollabSnapshotItems / kicadCollabApplyItems / window.kicadCollab.onItems.
 *
 * Per tool this drives the C++ exports directly (no reconciler/Y.Doc — that's the
 * Stage B binding, unit-tested in the standalone):
 *   1. snapshotItems: every fixture item's uuid appears in some wire blob;
 *   2. applyItems: changed (full/bare blob) + added (bare blob → tool wraps in its
 *      envelope) + removed (uuid) land in the model — verified via the save export;
 *   3. onItems: a genuine local edit emits a wire whose blob carries the item.
 */

type Mod = {
  kicadOpenFile(p: string): Promise<unknown>;
  kicadCollabSnapshotItems(): Promise<string>;
  kicadCollabApplyItems(j: string): Promise<unknown>;
} & Record<string, (...a: never[]) => unknown>;
type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};

interface ToolCfg {
  tool: string;
  html: string;
  ext: string;
  saveFn: string;
  fixture: string;
  /** uuids that must appear in the snapshot wire. */
  uuids: string[];
  /** applyItems payloads + the save-text markers proving they landed. Either a
   *  static sexpr, or derive it from the snapshot blob of `uuid` via replace —
   *  for pcbnew, whose non-footprint envelopes are the known-fragile parse. */
  changed:
    | { sexpr: string; marker: string }
    | { fromSnapshotUuid: string; replace: [string, string]; marker: string };
  added: { sexpr: string; uuid: string };
  removedUuid: string;
  /** evaluate-able local edit that must trigger an onItems emit. Omitted for
   *  eeschema: the headless harness can't drive its emit (open=false →
   *  SCH_COMMIT no-ops — the documented reason eeschema-collab's two-tab test
   *  is skipped; verified working in the real web app). */
  localEdit?: string;
}

const BOOT_TIMEOUT = 150000;

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

async function bootOpen(page: Page, cfg: ToolCfg): Promise<void> {
  await page.goto(`/kicad/${cfg.html}`);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    (saveFn) => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return (
        typeof m?.kicadOpenFile === "function" &&
        typeof m?.kicadCollabSnapshotItems === "function" &&
        typeof m?.kicadCollabApplyItems === "function" &&
        typeof m?.[saveFn] === "function"
      );
    },
    cfg.saveFn,
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
  await page.evaluate(
    async ({ content, ext }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      const p = `/home/kicad/documents/rt.${ext}`;
      w.FS.writeFile(p, content);
      await w.Module.kicadOpenFile(p);
    },
    { content: cfg.fixture, ext: cfg.ext },
  );
}

async function saveRead(page: Page, cfg: ToolCfg, name: string): Promise<string> {
  return page.evaluate(
    async ({ saveFn, ext, name }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const out = `/home/kicad/documents/${name}.${ext}`;
      await (w.Module[saveFn] as (p: string) => Promise<unknown>)(out);
      return w.FS.readFile(out, { encoding: "utf8" });
    },
    { saveFn: cfg.saveFn, ext: cfg.ext, name },
  );
}

// ── Tool configurations ──────────────────────────────────────────────────────

const PL: ToolCfg = {
  tool: "pl_editor",
  html: "pl_editor.html",
  ext: "kicad_wks",
  saveFn: "kicadSaveDrawingSheet",
  fixture: `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (rect (uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") (name border) (start 0 0 ltcorner) (end 0 0 rbcorner))
  (tbtext "Title" (uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") (name title) (pos 100 20 ltcorner) (font (size 2 2)))
)
`,
  uuids: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
  changed: {
    // Bare item (Y.Doc-rendered shape) — the tool must wrap it in its envelope.
    sexpr: `(tbtext "Title" (uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") (name title) (pos 55 65 ltcorner) (font (size 2 2)))`,
    marker: "(pos 55 65",
  },
  added: {
    sexpr: `(tbtext "BareAdd" (uuid "dddddddd-dddd-dddd-dddd-dddddddddddd") (name bare) (pos 10 10 ltcorner) (font (size 2 2)))`,
    uuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  },
  removedUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  localEdit: `window.Module.kicadCollabTestAddText("EmitMe", 40, 40)`,
};

const SCH: ToolCfg = {
  tool: "eeschema",
  html: "eeschema.html",
  ext: "kicad_sch",
  saveFn: "kicadSaveSchematic",
  fixture: `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "11111111-1111-1111-1111-111111111111")
	(paper "A4")
	(lib_symbols)
	(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000001"))
	(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000002"))
	(sheet_instances (path "/" (page "1")))
)
`,
  uuids: ["22222222-0000-0000-0000-000000000001", "22222222-0000-0000-0000-000000000002"],
  changed: {
    sexpr: `(wire (pts (xy 25.4 25.4) (xy 76.2 25.4)) (stroke (width 0) (type default)) (uuid "22222222-0000-0000-0000-000000000001"))`,
    marker: "(xy 25.4 25.4)",
  },
  added: {
    // Connectivity-neutral: a lone junction would be deleted by SCH_COMMIT::Push's
    // connection cleanup (it sits on no wire crossing) — that's correct editor
    // behavior, not a bridge gap. Text survives.
    sexpr: `(text "BareAdd" (exclude_from_sim no) (at 60.96 60.96 0) (effects (font (size 1.27 1.27))) (uuid "33333333-0000-0000-0000-000000000003"))`,
    uuid: "33333333-0000-0000-0000-000000000003",
  },
  removedUuid: "22222222-0000-0000-0000-000000000002",
  // no localEdit: headless harness cannot drive eeschema emit (see ToolCfg note)
};

const PCB: ToolCfg = {
  tool: "pcbnew",
  html: "pcbnew-collab.html",
  ext: "kicad_pcb",
  saveFn: "kicadSaveBoard",
  fixture: `(kicad_pcb
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
	(footprint "TestLib:R"
		(layer "F.Cu")
		(uuid "66666666-0000-0000-0000-000000000001")
		(at 100 100)
		(attr smd)
		(property "Reference" "R1" (at 0 -4.2 0) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15))))
		(property "Value" "R" (at 0 4.6 0) (layer "F.Fab") (uuid "66666666-0000-0000-0000-0000000000bb") (effects (font (size 1 1) (thickness 0.15))))
		(fp_text user "HELLO" (at 0 0 0) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000cc") (effects (font (size 1 1) (thickness 0.15))))
	)
	(via (at 80 80) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "77777777-0000-0000-0000-000000000001"))
	(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "88888888-0000-0000-0000-000000000001"))
	(segment (start 50.8 76.2) (end 101.6 76.2) (width 0.2) (layer "F.Cu") (net 0) (uuid "88888888-0000-0000-0000-000000000002"))
)
`,
  uuids: [
    "66666666-0000-0000-0000-000000000001",
    "77777777-0000-0000-0000-000000000001",
    "88888888-0000-0000-0000-000000000001",
  ],
  // pcbnew v2-apply scope (ysync 0008 Stage C): FOOTPRINT blobs are the proven
  // path (bare-footprint parse + replace-by-uuid with children — the 0004
  // containment win). Track/via/zone/text APPLY via the (kicad_pcb …) envelope
  // is the codebase's documented asyncify-fragile parse — those types remain on
  // the legacy scalar apply until that's solved (tracked in 0008 status).
  changed: {
    // Replace the footprint wholesale from its own snapshot blob, moved.
    fromSnapshotUuid: "66666666-0000-0000-0000-000000000001",
    replace: ["(at 100 100)", "(at 90 110)"],
    marker: "(at 90 110",
  },
  added: {
    // A bare footprint parses top-level (no envelope) — the proven add path.
    sexpr: `(footprint "TestLib:C" (layer "F.Cu") (uuid "99999999-0000-0000-0000-000000000009") (at 50 50) (attr smd) (property "Reference" "C1" (at 0 -2 0) (layer "F.SilkS") (uuid "99999999-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15)))))`,
    uuid: "99999999-0000-0000-0000-000000000009",
  },
  removedUuid: "88888888-0000-0000-0000-000000000002",
  // no localEdit: pcbnew emit is likewise unverifiable headless (pcbnew-collab two-tab is test.skip)
};

// ── The per-tool suite ───────────────────────────────────────────────────────

for (const cfg of [PL, SCH, PCB]) {
  test.describe(`${cfg.tool} items bridge (v2, per-item s-expr)`, () => {
    test.describe.configure({ timeout: 420000 });

    test(`${cfg.tool}: snapshot, apply (changed/added/removed), emit`, async ({
      page,
      testLogger,
    }) => {
      await bootOpen(page, cfg);

      // 1. snapshotItems: every fixture uuid appears in some wire blob.
      const snap = JSON.parse(
        await page.evaluate(() => window.Module.kicadCollabSnapshotItems()),
      ) as { added: Array<{ sexpr: string; parent: string | null }> };
      const allBlobs = snap.added.map((w) => w.sexpr).join("\n");
      for (const uuid of cfg.uuids) {
        expect(allBlobs, `snapshot blob for ${uuid}`).toContain(uuid);
      }

      // 2. Register the v2 emit hook.
      await page.evaluate(() => {
        (window as unknown as { __items: string[] }).__items = [];
        (window as unknown as { kicadCollab: object }).kicadCollab = {
          onItems: (j: string) => (window as unknown as { __items: string[] }).__items.push(j),
        };
      });

      // 3. A genuine local edit emits an items wire carrying the touched item.
      // Run this BEFORE the applies: TestMoveFirst moves the FIRST screen item,
      // which must be a fixture wire/track (the proven off-fiber move path) — an
      // apply-added text would no-op the virtual Move (known asyncify quirk).
      // Skipped when the harness can't drive the tool's emit (see ToolCfg).
      if (cfg.localEdit) {
        const editedUuid = (await page.evaluate(cfg.localEdit)) as string;
        await expect
          .poll(
            async () =>
              await page.evaluate(
                () => (window as unknown as { __items: string[] }).__items.join("\n"),
              ),
            { timeout: 20000, intervals: [400] },
          )
          .toContain(editedUuid);
      }
      const emitsAfterLocalEdit = await page.evaluate(
        () => (window as unknown as { __items: string[] }).__items.length,
      );

      // 4. applyItems: changed + added (bare blobs) + removed.
      let changedSexpr: string;
      if ("fromSnapshotUuid" in cfg.changed) {
        const blob = snap.added
          .map((w) => w.sexpr)
          .find((s) => s.includes((cfg.changed as { fromSnapshotUuid: string }).fromSnapshotUuid));
        expect(blob, "snapshot blob for the changed item").toBeTruthy();
        const [from, to] = cfg.changed.replace;
        expect(blob!, `blob contains "${from}"`).toContain(from);
        changedSexpr = blob!.replace(from, to);
      } else {
        changedSexpr = cfg.changed.sexpr;
      }
      await page.evaluate(
        async ({ changed, added, removed }) => {
          await window.Module.kicadCollabApplyItems(
            JSON.stringify({ added: [{ sexpr: added }], changed: [{ sexpr: changed }], removed: [removed] }),
          );
        },
        { changed: changedSexpr, added: cfg.added.sexpr, removed: cfg.removedUuid },
      );

      const applied = await saveRead(page, cfg, "applied");
      expect(applied).toContain(cfg.changed.marker);
      expect(applied).toContain(cfg.added.uuid);
      expect(applied).not.toContain(cfg.removedUuid);

      // Remote applies must not have echoed an onItems emit.
      const echoed = await page.evaluate(
        () => (window as unknown as { __items: string[] }).__items.length,
      );
      expect(echoed, "apply must not emit onItems").toBe(emitsAfterLocalEdit);

      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    });
  });
}
