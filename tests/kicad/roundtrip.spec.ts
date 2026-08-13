import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { sexprDiff } from "../../web/standalone/src/wasm/collab/sexpr-diff";

/**
 * Round-trip integration tests (feature 0004; v2 items wire since ysync 0008
 * Stage D): for each collab-capable, file-bearing tool prove the Y.Doc
 * representation is lossless —
 *
 *   load a fixture file  →  save it (ORIG, normalized through the serializer)
 *   →  kicadCollabSnapshotItems (per-item s-expr blobs, the Slot-model wire)
 *   →  RELOAD the page (fresh process-global wasm; boot.ts) → open an EMPTY doc
 *   →  kicadCollabApplyItems(snapshot)  (rebuild the model purely from the blobs)
 *   →  save (REGEN)
 *   →  assert sexprDiff(ORIG, REGEN).equal
 *
 * Both ORIG and REGEN come out of the SAME tool serializer, so `sexprDiff` (which
 * compares uuid-keyed items as multisets of normalized children) is false-positive
 * free by construction — non-item structure (setup, layers, paper) carries no uuid
 * and is intentionally not compared.
 *
 * The empty fixture shares the full fixture's top-level identity uuid(s) (where a
 * tool has one, e.g. the schematic root) so only the synced ITEMS differ between
 * ORIG and REGEN.
 */

interface ToolCfg {
  tool: string;
  html: string;
  ext: string;
  /** The per-tool save embind export (README §A). */
  saveFn: "kicadSaveDrawingSheet" | "kicadSaveSchematic" | "kicadSaveBoard";
  /** Full document with explicit uuid items to round-trip. */
  fixture: string;
  /** Valid, openable document of the same type carrying NO synced items (but the
   *  same top-level identity uuids as `fixture`). */
  empty: string;
  /** Known-volatile top-level tokens to ignore (serializer nondeterminism). */
  ignoreTokens?: string[];
  /**
   * uuids that live in the FILE but are legitimately absent from the items wire,
   * because they identify the document rather than an item — e.g. a schematic's
   * root `(uuid …)`, which travels in kdoc_meta/kdoc_layout, not kdoc_items.
   * Listed explicitly per fixture so `expectWireMatchesFile` can subtract them
   * without blanket-ignoring "the wire dropped an item", which is a real defect.
   */
  wireOmitsUuids?: string[];
}

type Mod = {
  kicadOpenFile(p: string): unknown;
  kicadCollabSnapshotItems(): string;
  kicadCollabApplyItems(j: string): unknown;
} & Record<string, (p: string) => unknown>;
type FS = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};

// Heavy tools (pcbnew ~190MB wasm) can take well over a minute to download +
// compile + boot, especially the SECOND instance of a run; keep this generous.
const BOOT_TIMEOUT = 150000;

function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return [...l.consoleLogs, ...l.errors].some((s) => s.includes("Aborted("));
}

/** Boot a fresh tool page and open `content` from MEMFS. */
async function bootOpen(page: Page, cfg: ToolCfg, content: string, name: string): Promise<void> {
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
    ({ content, name, ext }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      const p = `/home/kicad/documents/${name}.${ext}`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content, name, ext: cfg.ext },
  );
}

/** Save the current model to MEMFS via the tool's save export and read it back. */
async function saveRead(page: Page, cfg: ToolCfg, name: string): Promise<string> {
  return page.evaluate(
    ({ saveFn, ext, name }) => {
      const w = window as unknown as { FS: FS; Module: Mod };
      const out = `/home/kicad/documents/${name}.${ext}`;
      w.Module[saveFn](out);
      return w.FS.readFile(out, { encoding: "utf8" });
    },
    { saveFn: cfg.saveFn, ext: cfg.ext, name },
  );
}

/**
 * The full load → yjs → reload → apply → save loop. Uses TWO separate pages — the
 * extract page is CLOSED before the rebuild page opens — so the process-global wasm
 * heap of the first instance is freed before the second boots (otherwise the heavy
 * tools, e.g. pcbnew at ~190MB, boot the second instance under memory pressure and
 * stall). `snap` crosses the boundary as a plain JS string in test scope.
 */
async function roundTrip(
  context: BrowserContext,
  cfg: ToolCfg,
): Promise<{ orig: string; regen: string }> {
  // 1–3: load the fixture, normalize via a save, extract the yjs snapshot.
  // Open from a FIXED filename for both sides: some serializers embed the opened
  // file name (e.g. eeschema's root "Sheetfile" property), so ORIG and REGEN must
  // share it or that artifact reads as a (spurious) diff.
  const extract = await context.newPage();
  await bootOpen(extract, cfg, cfg.fixture, "rt");
  const orig = await saveRead(extract, cfg, "orig_dump");
  const snap = await extract.evaluate(() => window.Module.kicadCollabSnapshotItems());
  await extract.close();

  // v2 wire: { added: [{ sexpr, parent }] } — uuids live inside the blobs.
  const blobs: string[] = JSON.parse(snap).added.map((w: { sexpr: string }) => w.sexpr);
  const ids = [...new Set(blobs.flatMap((s) => [...s.matchAll(/\(uuid "([^"]+)"\)/g)].map((m) => m[1]!)))];
  expect(ids.length, "fixture must contain uuid items").toBeGreaterThan(0);

  // 4–5: fresh page (fresh wasm), open an empty doc, rebuild the model from the snapshot.
  const rebuild = await context.newPage();
  await bootOpen(rebuild, cfg, cfg.empty, "rt");
  await rebuild.evaluate((s) => window.Module.kicadCollabApplyItems(s), snap);

  // apply() runs async for eeschema/pcbnew (CallAfter + coroutine). Best-effort wait
  // for the first applied item to materialize — but DON'T fail here: proceed to save
  // REGEN regardless, so sexprDiff reports exactly which items failed to round-trip
  // (a poll timeout would hide that signal). pl_editor settles within a tick.
  const deadline = Date.now() + 15000;
  for (;;) {
    const probe = await saveRead(rebuild, cfg, "regen_probe");
    if (probe.includes(`(uuid "${ids[0]}")`) || Date.now() >= deadline) break;
    await rebuild.waitForTimeout(300);  // eslint-disable-line -- deliberate best-effort poll (a hard wait would hide which items failed)
  }

  const regen = await saveRead(rebuild, cfg, "regen_dump");
  await rebuild.close();
  return { orig, regen };
}

/**
 * One boot: the file the tool would SAVE, and the per-item blobs it would put on
 * the collab WIRE, taken from the same model at the same moment.
 */
async function fileAndWire(
  context: BrowserContext,
  cfg: ToolCfg,
): Promise<{ file: string; wire: string }> {
  const page = await context.newPage();
  await bootOpen(page, cfg, cfg.fixture, "rt");
  const file = await saveRead(page, cfg, "orig_dump");
  const snap = await page.evaluate(() => window.Module.kicadCollabSnapshotItems());
  await page.close();

  // Splice the blobs into one synthetic document so sexprDiff can index them by
  // uuid. Non-footprint blobs already arrive wrapped in their own `(kicad_pcb …)`
  // envelope; nesting is harmless — only uuid-bearing forms are compared, and the
  // envelope's layers/version carry none.
  const blobs: string[] = JSON.parse(snap).added.map((w: { sexpr: string }) => w.sexpr);
  return { file, wire: `(${cfg.tool}_wire ${blobs.join("\n")})` };
}

/**
 * THE invariant this suite was missing. `roundTrip` compares two FILE saves, so a
 * wire blob written in a different dialect than the file writer round-trips
 * perfectly and still corrupts the Y.Doc — which is exactly what happened:
 *
 *   - pcbnew serialized wire footprints through CLIPBOARD_IO (CTL_FOR_CLIPBOARD),
 *     which unlike CTL_FOR_BOARD emits `(version …) (generator …)
 *     (generator_version …)` INSIDE every `(footprint …)`. Every footprint of
 *     every board drifted, permanently.
 *   - eeschema serialized symbols with `aForClipboard=true`, whose
 *     `MakeRelativeTo(currentSheet)` collapses `(instances … (path "/<sheet>" …))`
 *     to `(path "")` — so materializing the Y.Doc would strip every symbol's sheet
 *     path, reference and unit.
 *
 * The Y.Doc is the source of truth for the FILE, so the two must agree token for
 * token. NOTE: no `ignoreTokens` here on purpose — `generator_version` is exactly
 * one of the tokens the pcbnew bug leaked, and ignoring it would re-mask it. (The
 * fixture-vs-build version mismatch that `ignoreTokens` exists for lives on the
 * ROOT form, which carries no uuid and is therefore never compared.)
 */
async function expectWireMatchesFile(context: BrowserContext, cfg: ToolCfg): Promise<void> {
  const { file, wire } = await fileAndWire(context, cfg);
  const raw = sexprDiff(file, wire);
  const omitted = new Set(cfg.wireOmitsUuids ?? []);
  const diff = {
    ...raw,
    removed: raw.removed.filter((u) => !omitted.has(u)),
  };
  expect(
    diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0,
    `wire blobs disagree with the file save:\n${JSON.stringify(diff, null, 2)}`,
  ).toBe(true);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PL: ToolCfg = {
  tool: "pl_editor",
  html: "pl_editor.html",
  ext: "kicad_wks",
  saveFn: "kicadSaveDrawingSheet",
  // No root uuid in a .kicad_wks; rect + tbtext carry the uuids we compare.
  fixture: `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (rect (uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") (name border) (start 0 0 ltcorner) (end 0 0 rbcorner))
  (tbtext "Title" (uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") (name title) (pos 100 20 ltcorner) (font (size 2 2)))
)
`,
  empty: `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
)
`,
  ignoreTokens: ["generator_version"],
};

const SCH: ToolCfg = {
  tool: "eeschema",
  html: "eeschema.html",
  ext: "kicad_sch",
  saveFn: "kicadSaveSchematic",
  // Root (uuid …) shared with the empty doc so only the wires differ.
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
  empty: `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "11111111-1111-1111-1111-111111111111")
	(paper "A4")
	(lib_symbols)
	(sheet_instances (path "/" (page "1")))
)
`,
  ignoreTokens: ["generator_version"],
};

// A schematic carrying a real SYMBOL with `(instances …)`. The wire-vs-file test
// below needs one: the eeschema clipboard dialect rewrote the instance path
// relative to the current sheet, collapsing it to `(path "")`. A wire-only
// fixture (SCH above) cannot catch that — only symbols have instances.
const SCH_SYM: ToolCfg = {
  ...SCH,
  // The schematic's own root uuid is document identity (kdoc_meta/kdoc_layout),
  // never an item on the items wire — so the file has it and the wire does not.
  wireOmitsUuids: ["11111111-1111-1111-1111-111111111111"],
  fixture: `(kicad_sch
	(version 20250114)
	(generator "eeschema")
	(generator_version "9.0")
	(uuid "11111111-1111-1111-1111-111111111111")
	(paper "A4")
	(lib_symbols
		(symbol "Device:R"
			(pin_numbers (hide yes))
			(pin_names (offset 0))
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
			(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
			(symbol "R_0_1"
				(rectangle (start -1.016 -2.54) (end 1.016 2.54)
					(stroke (width 0.254) (type default)) (fill (type none)))
			)
			(symbol "R_1_1"
				(pin passive line (at 0 3.81 270) (length 1.27)
					(name "~" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27)))))
				(pin passive line (at 0 -3.81 90) (length 1.27)
					(name "~" (effects (font (size 1.27 1.27))))
					(number "2" (effects (font (size 1.27 1.27)))))
			)
		)
	)
	(symbol
		(lib_id "Device:R")
		(at 100 100 0)
		(unit 1)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(dnp no)
		(uuid "33333333-0000-0000-0000-000000000001")
		(property "Reference" "R1" (at 102 99 0) (effects (font (size 1.27 1.27)) (justify left)))
		(property "Value" "R" (at 102 101 0) (effects (font (size 1.27 1.27)) (justify left)))
		(pin "1" (uuid "33333333-0000-0000-0000-0000000000a1"))
		(pin "2" (uuid "33333333-0000-0000-0000-0000000000a2"))
		(instances
			(project "rt"
				(path "/11111111-1111-1111-1111-111111111111" (reference "R1") (unit 1))
			)
		)
	)
	(sheet_instances (path "/" (page "1")))
)
`,
};

const PCB: ToolCfg = {
  tool: "pcbnew",
  // pcbnew-collab.html seeds kicad_common.json to skip the first-run setup wizard;
  // plain pcbnew.html keeps the wizard, whose modal blocks boot (see pcbnew-collab.spec).
  html: "pcbnew-collab.html",
  ext: "kicad_pcb",
  saveFn: "kicadSaveBoard",
  // No root uuid in a .kicad_pcb; footprint / via / zone / gr_text / segments carry the uuids.
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
	(gr_text "BOARDTEXT" (at 90 95 0) (layer "F.SilkS") (uuid "77777777-0000-0000-0000-000000000003") (effects (font (size 1 1) (thickness 0.15)) (justify left bottom)))
	(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "88888888-0000-0000-0000-000000000001"))
	(segment (start 50.8 76.2) (end 101.6 76.2) (width 0.2) (layer "F.Cu") (net 0) (uuid "88888888-0000-0000-0000-000000000002"))
)
`,
  empty: `(kicad_pcb
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
)
`,
  ignoreTokens: ["generator_version"],
};

// Footprint-only board: the v2 items wire's PROVEN pcbnew apply path (bare
// footprint blob parse + children — the 0004 containment win). Kept separate
// from PCB so the fragile-envelope types (via/text/segment, see the fixme
// below) don't mask the passing footprint coverage.
const PCB_FP: ToolCfg = {
  ...PCB,
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
	(footprint "TestLib:C"
		(layer "F.Cu")
		(uuid "99999999-0000-0000-0000-000000000009")
		(at 50 50)
		(attr smd)
		(property "Reference" "C1" (at 0 -2 0) (layer "F.SilkS") (uuid "99999999-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15))))
	)
)
`,
};

test.beforeAll(() => {
  // No reconciler bundle needed — the round trip drives only the C++ Module.*
  // exports (open / snapshot / apply / save).
});

test.describe("round trip: file → yjs → file", () => {
  // Each test boots the tool TWICE (extract + rebuild); the heavy tools need well
  // beyond the config's 180s per-test budget.
  test.describe.configure({ timeout: 420000 });

  test("pl_editor preserves items through a yjs round trip", async ({ context, testLogger }) => {
    const { orig, regen } = await roundTrip(context, PL);
    const diff = sexprDiff(orig, regen, { ignoreTokens: PL.ignoreTokens });
    expect(
      diff.equal,
      `round trip lost data:\n${JSON.stringify(diff, null, 2)}`,
    ).toBe(true);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("eeschema preserves items through a yjs round trip", async ({ context, testLogger }) => {
    const { orig, regen } = await roundTrip(context, SCH);
    const diff = sexprDiff(orig, regen, { ignoreTokens: SCH.ignoreTokens });
    expect(
      diff.equal,
      `round trip lost data:\n${JSON.stringify(diff, null, 2)}`,
    ).toBe(true);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // THE 0004 CONTAINMENT WIN (ysync 0008 Stage C/D): footprints round-trip via the
  // items wire — the bare-footprint blob parse recreates the footprint WITH its
  // children (properties, fp_text) in place, which the scalar wire never could.
  test("pcbnew preserves footprint containment through a yjs round trip", async ({
    context,
    testLogger,
  }) => {
    const { orig, regen } = await roundTrip(context, PCB_FP);
    const diff = sexprDiff(orig, regen, { ignoreTokens: PCB_FP.ignoreTokens });
    expect(
      diff.equal,
      `round trip lost data:\n${JSON.stringify(diff, null, 2)}`,
    ).toBe(true);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // The wire dialect must BE the file dialect — see expectWireMatchesFile. These
  // two would both have failed before the CTL_FOR_BOARD / aForClipboard=false fix:
  // pcbnew on the `(version)(generator)(generator_version)` triple inside every
  // footprint, eeschema on `(instances … (path ""))`.
  test("pcbnew wire blobs match the file save token for token", async ({
    context,
    testLogger,
  }) => {
    await expectWireMatchesFile(context, PCB_FP);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  test("eeschema wire blobs keep the symbol's instance path", async ({
    context,
    testLogger,
  }) => {
    await expectWireMatchesFile(context, SCH_SYM);
    expect(hasAbort(testLogger), "no WASM abort").toBe(false);
  });

  // REMAINING KNOWN GAP (ysync 0008 status, known limit 1 — tracked, not a test
  // bug): pcbnew track/via/zone/text APPLY rides the `(kicad_pcb …)` envelope
  // parse, the codebase's documented asyncify-fragile path (even a verbatim
  // SaveSelection envelope for a segment dies silently in the commit). The full
  // fixture (via + gr_text + segments) therefore still loses those items on the
  // rebuild side. Un-fixme when the envelope parse is solved. Run with
  // --grep-invert skipped to see the live diff.
  test(  // re-enabled 2026-08-13: the asyncify-fragile envelope parse is gone with JSPI — passes both engines
    "pcbnew preserves items through a yjs round trip",
    async ({ context, testLogger }) => {
      const { orig, regen } = await roundTrip(context, PCB);
      const diff = sexprDiff(orig, regen, { ignoreTokens: PCB.ignoreTokens });
      expect(
        diff.equal,
        `round trip lost data:\n${JSON.stringify(diff, null, 2)}`,
      ).toBe(true);
      expect(hasAbort(testLogger), "no WASM abort").toBe(false);
    },
  );
});
