import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Trio harness (standalone-hardening 0008): three tabs as three users in one
 * room — A seeds + edits, B edits, C only observes. Runs the PRODUCTION v2
 * items stack via collab-bundle-v2.js (window.KicadCollabV2), same plumbing as
 * ysync-two-tab.spec.ts, generalized to N pages with a per-step oracle sweep:
 *
 *   1. per-tab drift silence  — driftReport(): editor model ≡ room Y.Doc
 *   2. cross-tab convergence  — every tab's silent save is byte-identical
 *   3. room materialization   — docToFile(yToDoc(doc)) renders, identically
 *
 * BroadcastChannel does not cross Playwright contexts, so all tabs live in ONE
 * context. Heavy editors (eeschema/pcbnew) exceed Firefox's per-content-process
 * wasm budget at 2+ instances — trio specs must skip firefox and run Chromium.
 */

type FSApi = {
  mkdirTree(p: string): void;
  writeFile(p: string, d: string): void;
  readFile(p: string, o: { encoding: "utf8" }): string;
};
type Mod = Record<string, (...a: never[]) => unknown>;

export interface ToolCfg {
  html: string;
  ext: string;
  saveFn: string;
  fixture: string;
  /** Module fns (beyond the v2 bridge pair + saveFn) boot must wait for. */
  fns: string[];
}

export const BOOT_TIMEOUT = 150000;

/** All trio tabs open the SAME document name (it is the same file). Symbol
 *  `(instances (project "trio" …))` entries must match this name. */
export const TRIO_DOC = "trio";

import { hasNativeFailure } from "./native-failure";

export function hasAbort(l: { consoleLogs: string[]; errors: string[] }): boolean {
  return hasNativeFailure(l);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Adapted from the proven roundtrip.spec.ts fixtures: the schematic carries a
// real symbol (lib_symbols + instances — required by TestSetFieldText and the
// instance-path drift class), the board's footprint carries pads (required by
// TestSetPadSize).

export const SCH_ROOT = "11111111-1111-1111-1111-111111111111";
export const SYM1 = "33333333-0000-0000-0000-000000000001";
export const WIRE1 = "22222222-0000-0000-0000-000000000001";
export const WIRE2 = "22222222-0000-0000-0000-000000000002";

export const TRIO_SCH: ToolCfg = {
  html: "eeschema.html",
  ext: "kicad_sch",
  saveFn: "kicadSaveSchematic",
  fns: [
    "kicadCollabTestMoveFirst",
    "kicadCollabGetPos",
    "kicadCollabTestRotateItem",
    "kicadCollabTestRemoveItem",
    "kicadCollabTestSetFieldText",
    "kicadCollabTestUndoDepth",
    // drift-trio phase B action hooks
    "kicadCollabTestAddWire",
    "kicadCollabTestAddJunction",
    "kicadCollabTestAddNoConnect",
    "kicadCollabTestAddLabel",
    "kicadCollabTestAddSymbol",
    "kicadCollabTestMoveSchItem",
    "kicadCollabTestMirrorSchItem",
    "kicadCollabTestDuplicateSchItem",
  ],
  fixture: `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "${SCH_ROOT}")
\t(paper "A4")
\t(lib_symbols
\t\t(symbol "Device:R"
\t\t\t(pin_numbers (hide yes))
\t\t\t(pin_names (offset 0))
\t\t\t(exclude_from_sim no)
\t\t\t(in_bom yes)
\t\t\t(on_board yes)
\t\t\t(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
\t\t\t(symbol "R_0_1"
\t\t\t\t(rectangle (start -1.016 -2.54) (end 1.016 2.54)
\t\t\t\t\t(stroke (width 0.254) (type default)) (fill (type none)))
\t\t\t)
\t\t\t(symbol "R_1_1"
\t\t\t\t(pin passive line (at 0 3.81 270) (length 1.27)
\t\t\t\t\t(name "~" (effects (font (size 1.27 1.27))))
\t\t\t\t\t(number "1" (effects (font (size 1.27 1.27)))))
\t\t\t\t(pin passive line (at 0 -3.81 90) (length 1.27)
\t\t\t\t\t(name "~" (effects (font (size 1.27 1.27))))
\t\t\t\t\t(number "2" (effects (font (size 1.27 1.27)))))
\t\t\t)
\t\t)
\t)
\t(symbol
\t\t(lib_id "Device:R")
\t\t(at 100 100 0)
\t\t(unit 1)
\t\t(exclude_from_sim no)
\t\t(in_bom yes)
\t\t(on_board yes)
\t\t(dnp no)
\t\t(uuid "${SYM1}")
\t\t(property "Reference" "R1" (at 102 99 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" "R" (at 102 101 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(pin "1" (uuid "33333333-0000-0000-0000-0000000000a1"))
\t\t(pin "2" (uuid "33333333-0000-0000-0000-0000000000a2"))
\t\t(instances
\t\t\t(project "${TRIO_DOC}"
\t\t\t\t(path "/${SCH_ROOT}" (reference "R1") (unit 1))
\t\t\t)
\t\t)
\t)
\t(wire (pts (xy 50.8 50.8) (xy 101.6 50.8)) (stroke (width 0) (type default)) (uuid "${WIRE1}"))
\t(wire (pts (xy 50.8 76.2) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "${WIRE2}"))
\t(sheet_instances (path "/" (page "1")))
)
`,
};

export const FP1 = "66666666-0000-0000-0000-000000000001";
export const PAD1 = "66666666-0000-0000-0000-0000000000d1";
export const PAD2 = "66666666-0000-0000-0000-0000000000d2";
export const FP1_TXT = "66666666-0000-0000-0000-0000000000cc";
export const VIA1 = "77777777-0000-0000-0000-000000000001";
export const SEG1 = "88888888-0000-0000-0000-000000000001";
export const SEG2 = "88888888-0000-0000-0000-000000000002";

export const TRIO_PCB: ToolCfg = {
  // pcbnew-collab.html: memory-tuned + seeds kicad_common.json so the first-run
  // wizard modal never blocks boot (see pcbnew-collab.spec.ts).
  html: "pcbnew-collab.html",
  ext: "kicad_pcb",
  saveFn: "kicadSaveBoard",
  fns: [
    "kicadCollabTestMoveFirst",
    "kicadCollabGetPos",
    "kicadCollabTestRotateItem",
    "kicadCollabTestRemoveItem",
    "kicadCollabTestSetPadSize",
    "kicadCollabTestMoveEndpoint",
    "kicadCollabTestUndoDepth",
    // drift-trio phase B action hooks
    "kicadCollabTestAddTrack",
    "kicadCollabTestAddVia",
    "kicadCollabTestAddBoardText",
    "kicadCollabTestAddZone",
    "kicadCollabTestFlipBoardItem",
    "kicadCollabTestSetFootprintField",
    "kicadCollabTestSetBoardItemLocked",
    "kicadCollabTestMoveBoardItem",
    "kicadCollabTestDuplicateBoardItem",
  ],
  fixture: `(kicad_pcb
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
\t(footprint "TestLib:R"
\t\t(layer "F.Cu")
\t\t(uuid "${FP1}")
\t\t(at 100 100)
\t\t(attr smd)
\t\t(property "Reference" "R1" (at 0 -4.2 0) (layer "F.SilkS") (uuid "66666666-0000-0000-0000-0000000000aa") (effects (font (size 1 1) (thickness 0.15))))
\t\t(property "Value" "R" (at 0 4.6 0) (layer "F.Fab") (uuid "66666666-0000-0000-0000-0000000000bb") (effects (font (size 1 1) (thickness 0.15))))
\t\t(property "Datasheet" "" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "66666666-0000-0000-0000-0000000000d3") (effects (font (size 1.27 1.27))))
\t\t(property "Description" "" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "66666666-0000-0000-0000-0000000000d4") (effects (font (size 1.27 1.27))))
\t\t(fp_text user "HELLO" (at 0 0 0) (layer "F.SilkS") (uuid "${FP1_TXT}") (effects (font (size 1 1) (thickness 0.15))))
\t\t(pad "1" smd rect (at -1.27 0) (size 1.2 1) (layers "F.Cu") (uuid "${PAD1}"))
\t\t(pad "2" smd rect (at 1.27 0) (size 1.2 1) (layers "F.Cu") (uuid "${PAD2}"))
\t)
\t(via (at 80 80) (size 1.4) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "${VIA1}"))
\t(segment (start 50.8 50.8) (end 101.6 50.8) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG1}"))
\t(segment (start 50.8 76.2) (end 101.6 76.2) (width 0.2) (layer "F.Cu") (net 0) (uuid "${SEG2}"))
)
`,
};

export const PL_TEXT1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const PL_RECT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** pl_editor: the small tool whose emit hook is eager (OnModify) — the green
 *  baseline that validates the trio plumbing itself, independent of the heavy
 *  editors (three pl_editor tabs even fit Firefox's wasm budget). */
export const TRIO_PL: ToolCfg = {
  html: "pl_editor.html",
  ext: "kicad_wks",
  saveFn: "kicadSaveDrawingSheet",
  // pl_editor has no undo-depth hook — the undo oracle is heavy-tools-only.
  fns: ["kicadCollabTestAddText"],
  fixture: `(kicad_wks (version 20220228) (generator "pl_editor") (generator_version "9.0")
  (setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
    (left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
  (rect (uuid "${PL_RECT}") (name border) (start 0 0 ltcorner) (end 0 0 rbcorner))
  (tbtext "Title" (uuid "${PL_TEXT1}") (name title) (pos 100 20 ltcorner) (font (size 2 2)))
)
`,
};

// ── Boot + session plumbing (bootOpen recipe from ysync-two-tab.spec.ts) ────

const BUNDLE = path.resolve(__dirname, "../../apps/kicad/collab-bundle-v2.js");

export async function bootOpen(page: Page, cfg: ToolCfg): Promise<void> {
  await page.goto(`/kicad/${cfg.html}`);
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => !!window.wxElementRegistry, null, { timeout: BOOT_TIMEOUT });
  await page.waitForFunction(
    (fns) => {
      const m = (window as unknown as { Module?: Mod }).Module;
      return !!m && fns.every((f) => typeof m[f] === "function");
    },
    ["kicadOpenFile", "kicadCollabSnapshotItems", "kicadCollabApplyItems", cfg.saveFn, ...cfg.fns],
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
    ({ content, ext, name }) => {
      const w = window as unknown as { FS: FSApi; Module: { kicadOpenFile(p: string): unknown } };
      try {
        w.FS.mkdirTree("/home/kicad/documents");
      } catch {
        /* exists */
      }
      const p = `/home/kicad/documents/${name}.${ext}`;
      w.FS.writeFile(p, content);
      w.Module.kicadOpenFile(p);
    },
    { content: cfg.fixture, ext: cfg.ext, name: TRIO_DOC },
  );
  await expect.poll(() => page.title(), { timeout: 30000 }).toMatch(new RegExp(TRIO_DOC, "i"));
  await page.addScriptTag({ path: BUNDLE });
}

export function startV2(
  page: Page,
  opts: { room: string; settleMs?: number; seedText?: string; editorMatchesDoc?: boolean },
): Promise<void> {
  return page.evaluate(async (o) => {
    const w = window as unknown as {
      KicadCollabV2: { start: (m: unknown, win: unknown, o: unknown) => Promise<void> };
      Module: unknown;
    };
    await w.KicadCollabV2.start(w.Module, window, o);
  }, opts);
}

/** Anything with labeled tabs — the oracles work on trios, duos, quads alike. */
export interface TabSet {
  tabs: ReadonlyArray<readonly [label: string, page: Page]>;
}

export interface Trio extends TabSet {
  A: Page;
  B: Page;
  C: Page;
}

/**
 * Boot three tabs on the same fixture + room. A file-seeds (the production
 * first-tab path — its listener registers via seed's snapshotItems, ysync bug
 * 01's regression surface); B and C open the identical file and join with
 * editorMatchesDoc (the ydoc-load style baseline-only path). Returns after all
 * three converge on the seeded state.
 */
export async function openTrio(context: BrowserContext, cfg: ToolCfg, room: string): Promise<Trio> {
  const [A, B, C] = [await context.newPage(), await context.newPage(), await context.newPage()];
  // Sequential boots: three concurrent wasm compiles thrash; the two-tab spec
  // boots serially for the same reason.
  await bootOpen(A, cfg);
  await bootOpen(B, cfg);
  await bootOpen(C, cfg);
  await startV2(A, { room, seedText: cfg.fixture });
  await startV2(B, { room, editorMatchesDoc: true });
  await startV2(C, { room, editorMatchesDoc: true });
  const trio: Trio = {
    A,
    B,
    C,
    tabs: [
      ["A", A],
      ["B", B],
      ["C", C],
    ],
  };
  await settleConverged(trio, cfg);
  return trio;
}

export async function closeTrio(trio: Trio): Promise<void> {
  for (const [, page] of trio.tabs) await page.close();
}

// ── Per-tab probes ───────────────────────────────────────────────────────────

/** Silent save-to-MEMFS + read back — no onSave side effects. Defers while
 *  collab coroutine work is in flight: a bare-embind-stack save during a parked
 *  apply mis-dispatches (finding #10b) — the wait is JS-side, so it is safe. */
export function modelText(page: Page, cfg: ToolCfg): Promise<string> {
  return page.evaluate(
    async ({ saveFn, ext }) => {
      const w = window as unknown as {
        FS: FSApi;
        Module: Mod & { kicadCollabBusy?: () => boolean };
      };
      for (let i = 0; i < 200 && w.Module.kicadCollabBusy?.(); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const out = `/home/kicad/documents/_dump.${ext}`;
      (w.Module[saveFn] as (p: string) => unknown)(out);
      return w.FS.readFile(out, { encoding: "utf8" });
    },
    { saveFn: cfg.saveFn, ext: cfg.ext },
  );
}

/** docToFile(yToDoc(room doc)) in-page; { err } instead of throwing. */
export function renderDoc(page: Page): Promise<{ ok?: string; err?: string }> {
  return page.evaluate(() => {
    const w = window as unknown as { KicadCollabV2: { renderActiveDoc(): string } };
    try {
      return { ok: w.KicadCollabV2.renderActiveDoc() };
    } catch (e) {
      return { err: String(e) };
    }
  });
}

export interface DriftSummary {
  added: string[];
  updated: string[];
  removed: string[];
  reordered: string[];
  layoutChanged: boolean;
  layoutReordered: boolean;
  metaChanged: boolean;
}

/** Item-level drift summary via the production comparator (browser-entry-v2). */
export function drift(page: Page, cfg: ToolCfg): Promise<DriftSummary | null> {
  return page.evaluate(
    async ({ saveFn, ext }) => {
      const w = window as unknown as {
        KicadCollabV2: { driftReport(f: string, p: string): DriftSummary | null };
        Module: { kicadCollabBusy?: () => boolean };
      };
      for (let i = 0; i < 200 && w.Module.kicadCollabBusy?.(); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return w.KicadCollabV2.driftReport(saveFn, `/home/kicad/documents/_drift.${ext}`);
    },
    { saveFn: cfg.saveFn, ext: cfg.ext },
  );
}

/** Invoke a Module.* test hook with plain args and return its result. */
export function callHook<T>(page: Page, fn: string, ...args: (string | number)[]): Promise<T> {
  return page.evaluate(
    ({ fn, args }) => {
      const w = window as unknown as { Module: Record<string, (...a: unknown[]) => unknown> };
      return w.Module[fn]!(...args);
    },
    { fn, args },
  ) as Promise<T>;
}

export function getPos(page: Page, uuid: string): Promise<string> {
  return callHook<string>(page, "kicadCollabGetPos", uuid);
}

export function undoDepth(page: Page): Promise<number> {
  return callHook<number>(page, "kicadCollabTestUndoDepth");
}

// ── Oracles ──────────────────────────────────────────────────────────────────

/** First differing line between two texts, for readable failure messages. */
function firstDiff(a: string, b: string): string {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}:\n  a: ${la[i] ?? "<missing>"}\n  b: ${lb[i] ?? "<missing>"}`;
    }
  }
  return "<no line diff — length/EOL mismatch>";
}

/**
 * Poll until every tab's silent save is byte-identical. The convergence gate
 * between scenario steps — bounded poll, no blind sleeps (tests/TESTING.md).
 */
export async function settleConverged(trio: TabSet, cfg: ToolCfg, timeout = 90000): Promise<void> {
  // On timeout the failure names WHICH tab diverged and the first differing
  // line — a bare `false` hid the actual divergence (memory: s4-value-race).
  let last: string[] = [];
  try {
    await expect
      .poll(
        async () => {
          last = await Promise.all(trio.tabs.map(([, p]) => modelText(p, cfg)));
          return last.every((t) => t === last[0]);
        },
        { timeout, intervals: [400] },
      )
      .toBe(true);
  } catch (e) {
    const labels = trio.tabs.map(([l]) => l);
    const diffs = last
      .map((t, i) => (i > 0 && t !== last[0] ? `${labels[0]} vs ${labels[i]}: ${firstDiff(last[0], t)}` : null))
      .filter(Boolean);
    throw new Error(`trio did not converge:\n${diffs.join("\n")}\n\n${(e as Error).message}`);
  }
}

/**
 * The full oracle sweep, run at every settle point:
 *   1. every tab is drift-silent at the ITEM level (added/updated/removed —
 *      layoutChanged/metaChanged are NOT asserted: non-item state only syncs at
 *      seed, and the writer may normalize preamble formatting; reordered /
 *      layoutReordered are not drift by definition),
 *   2. all three silent saves are byte-identical,
 *   3. the room doc materializes, identically, on every tab.
 */
export async function oracleSweep(trio: TabSet, cfg: ToolCfg): Promise<void> {
  for (const [label, page] of trio.tabs) {
    const d = await drift(page, cfg);
    expect(d?.added ?? [], `${label} drift added`).toEqual([]);
    expect(d?.updated ?? [], `${label} drift updated`).toEqual([]);
    expect(d?.removed ?? [], `${label} drift removed`).toEqual([]);
  }

  const texts = await Promise.all(trio.tabs.map(([, p]) => modelText(p, cfg)));
  for (let i = 1; i < texts.length; i++) {
    expect(
      texts[i] === texts[0],
      `model ${trio.tabs[i]![0]} diverged from A — ${firstDiff(texts[0]!, texts[i]!)}`,
    ).toBe(true);
  }

  const renders = await Promise.all(trio.tabs.map(([, p]) => renderDoc(p)));
  for (let i = 0; i < renders.length; i++) {
    expect(renders[i]!.err, `${trio.tabs[i]![0]} room doc must materialize`).toBeUndefined();
  }
  for (let i = 1; i < renders.length; i++) {
    expect(
      renders[i]!.ok === renders[0]!.ok,
      `room doc render ${trio.tabs[i]![0]} diverged from A`,
    ).toBe(true);
  }
}
