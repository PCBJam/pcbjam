import { test, expect, type Page } from "@playwright/test";
import {
  clickByLabel,
  clickMenuBarItem,
  clickMenuItemByText,
  waitUntil,
} from "../e2e/utils/element-tracker";

/**
 * Footprints added by "Update PCB from Schematic" must survive a schematic ⇄ PCB
 * tool switch.
 *
 * Field report (2026-09-04, staging, board blinky-328): after going to the
 * schematic and back to the PCB editor, some footprints are gone and the user
 * runs Update PCB from Schematic again to get them back. Every round trip drops
 * them again.
 *
 * A tool switch is a hard `location.assign` to the other file's URL
 * (components/wasm-tool/tool-navigation.ts) — a full reload whose boot seeds the
 * editor from the shared document. A plain URL round trip on the staging board
 * loses nothing (both boots seed the same item count, "editor matches doc"). So a
 * footprint that vanishes on the round trip is one that never reached the
 * document: the netlist updater's commit fired the collab listener, but the
 * post-settle items-wire emit (wasm/bindings/pcbnew_embind.cpp flushDiff) did
 * not carry it, the JS side dropped the batch (kicad-binding.ts onItems), or
 * the backend rejected the resulting document and reverted it.
 *
 * This spec drives the real flow end to end, in one tab, the way the user does:
 *   1. eeschema: add a symbol (R99, a Device R with an SMD footprint the
 *      reference backend serves) to the schematic document, exactly as the C++
 *      emit does — `kicadCollab.onItems` with an `added` items-wire entry.
 *   2. Tools → Switch to PCB Editor. The PCB boot restages the schematic from
 *      the document, so the staged .kicad_sch carrying R99 is the fence that the
 *      add reached the room.
 *   3. Tools → Update PCB from Schematic → Update PCB → Close. R99's footprint
 *      is now on the board. The emitted deltas and the three console signatures
 *      above are recorded as annotations.
 *   4. The half-done layout the user described: the four mounting holes and a
 *      few footprints are moved, and some tracks are routed, all through real
 *      BOARD_COMMITs (the collab test hooks), so the board leaves in the same
 *      intermediate state a person would leave it in.
 *   5. Tools → Switch to Schematic Editor, then Switch to PCB Editor.
 *   6. The board must still carry R99, the moved footprints at their new
 *      positions, and the tracks.
 *   7. Reload the PCB, so it re-seeds from the room document, and assert the
 *      footprint count again — the DOCUMENT's truth, not just the live editor.
 *
 * Staging finding (2026-09-04, board blinky-328): the loss was document-level.
 * The room ydoc itself had dropped two footprints (C6, H4); the editor loaded
 * "seed: editor matches doc (N)" and faithfully showed the reduced set, so a
 * reload kept the loss, and only the original rev-1 upload still had all of them.
 * Step 7 is what makes this spec able to catch that: an editor-only check would
 * miss a footprint that is gone from the document but momentarily still drawn.
 * A concurrent-peer variant (PCBJAM_E2E_PEER=1, at the bottom) adds the second
 * connection whose remote applies raced the seed on staging. Both pass on the
 * local dev stack — the loss reproduces only against staging's room server
 * timing / build, so this ships as the regression guard the fix must keep green.
 *
 * Board content is read through `kicadSaveBoard` into a MEMFS scratch path
 * (the drift detector's route), never `kicadCollabSnapshotItems`: a snapshot
 * re-baselines the differ and would itself swallow an edit whose flush is still
 * pending — the very thing under test.
 *
 * The room's documents persist across runs, so the spec restores them at the
 * end (footprint removed via a real commit, symbol removed via the wire) and
 * tolerates a stale R99 left by an aborted run.
 */

const SCOPE = "default";
// Point the flow at another project (a field board uploaded to the dev stack):
//   PCBJAM_E2E_SLUG=blinky-328 PCBJAM_E2E_STEM=main PCBJAM_E2E_MISSING_REF=C7
// SLUG is the project, STEM the file stem, MISSING_REF a schematic part the board
// already lacks (then no symbol is added; Update PCB adds that part instead).
const SLUG = process.env.PCBJAM_E2E_SLUG ?? "demo";
const STEM = process.env.PCBJAM_E2E_STEM ?? SLUG;
const MISSING_REF = process.env.PCBJAM_E2E_MISSING_REF;
const SCH_URL = `/${SCOPE}/projects/${SLUG}/${STEM}.kicad_sch`;
const PCB_URL = `/${SCOPE}/projects/${SLUG}/${STEM}.kicad_pcb`;
const SCH_TITLE = new RegExp(`${STEM} — Schematic Editor`, "i");
const PCB_TITLE = new RegExp(`${STEM} — PCB Editor`, "i");
const SCH_PATH = new RegExp(`/${STEM}\\.kicad_sch`);
const PCB_PATH = new RegExp(`/${STEM}\\.kicad_pcb`);
const USER = "alice";
const REF = MISSING_REF ?? "R99";
const ADD_SYMBOL = !MISSING_REF;
const TEMPLATE_REF = "R1";
const FOOTPRINT = "Resistor_SMD:R_0603_1608Metric";
const SCRATCH_DIR = "/tmp/update-pcb-tool-switch";
const SCRATCH_PCB = `${SCRATCH_DIR}/board.kicad_pcb`;
const BOOT_TIMEOUT = 180000;

type WireItem = { sexpr: string; parent: string | null };
type DeltaLogEntry = { added: string[]; changed: string[]; removed: number };
type Mod = {
  kicadCollabSnapshotItems(): string;
  kicadCollabTestRemoveItem(id: string): boolean;
  kicadCollabTestMoveBoardItem(id: string, dx: number, dy: number): boolean;
  kicadCollabTestAddTrack(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    layer: string
  ): string;
  kicadCollabGetPos(id: string): string;
  kicadSaveBoard(path: string): void;
};
type Fs = {
  readFile(p: string, o: { encoding: "utf8" }): string;
  mkdirTree(p: string): void;
  readdir(p: string): string[];
  analyzePath(p: string): { exists: boolean };
};
type RegistryEl = { typeName?: string; label?: string; name?: string };
type W = Window & {
  Module: Mod;
  FS: Fs;
  kicadCollab: { onItems?: (json: string) => void };
  wxElementRegistry?: { findAll?: (o: { visible: boolean }) => RegistryEl[] };
  __deltaLog?: DeltaLogEntry[];
};

// Console lines that name the three known loss paths, plus the nav/quit trace.
const SIGNATURE_RE =
  /P-5|batch failed to apply|doc reverted|\[nav\]|\[quit\]|seed:|doc items/;

async function waitForToolReady(page: Page, titleRe: RegExp): Promise<void> {
  await expect(page.locator("#canvas")).toBeVisible({ timeout: BOOT_TIMEOUT });
  await expect
    .poll(() => page.title(), {
      message: `editor never reached title ${titleRe}`,
      timeout: BOOT_TIMEOUT,
      intervals: [1000],
    })
    .toMatch(titleRe);
  await page.waitForFunction(
    () => !!(window as unknown as W).wxElementRegistry?.findAll,
    null,
    { timeout: 30000 }
  );
  // The boot and eager-library overlays cover the menubar until they clear.
  await expect(page.locator("div.absolute.inset-0.z-30")).toHaveCount(0, {
    timeout: BOOT_TIMEOUT,
  });
  // The binding owns the emit slot; the spec feeds and watches it.
  await page.waitForFunction(
    () => typeof (window as unknown as W).kicadCollab?.onItems === "function",
    null,
    { timeout: 60000 }
  );
}

type Nav = "menu" | "history";

/**
 * The schematic ⇄ PCB round trip, the two ways a person does it: through the
 * Tools menu (location.assign to the other file), or with the browser's Back and
 * Forward buttons (a bfcache restore that the quit hook turns into a reload).
 */
async function roundTrip(page: Page, nav: Nav): Promise<void> {
  if (nav === "menu") {
    await switchTool(page, "Switch to Schematic Editor", SCH_PATH, SCH_TITLE);
    await switchTool(page, "Switch to PCB Editor", PCB_PATH, PCB_TITLE);
    return;
  }
  await page.goBack();
  await page.waitForURL(SCH_PATH, { timeout: 30000 });
  await waitForToolReady(page, SCH_TITLE);
  await page.goForward();
  await page.waitForURL(PCB_PATH, { timeout: 30000 });
  await waitForToolReady(page, PCB_TITLE);
}

async function switchTool(
  page: Page,
  menuLabel: string,
  expectedUrl: RegExp,
  titleRe: RegExp
): Promise<void> {
  expect(
    await clickMenuBarItem(page, "Tools"),
    "Tools menubar item clickable"
  ).toBe(true);
  await clickMenuItemByText(page, menuLabel);
  await page.waitForURL(expectedUrl, { timeout: 30000 });
  await waitForToolReady(page, titleRe);
}

/** The board as pcbnew would save it right now (no differ re-baseline). */
async function boardText(page: Page): Promise<string> {
  return page.evaluate(
    ({ dir, file }) => {
      const w = window as unknown as W;
      if (!w.FS.analyzePath(dir).exists) w.FS.mkdirTree(dir); // idempotent scratch dir
      w.Module.kicadSaveBoard(file);
      return w.FS.readFile(file, { encoding: "utf8" });
    },
    { dir: SCRATCH_DIR, file: SCRATCH_PCB }
  );
}

/** The schematic as staged into MEMFS for the netlist updater to read. */
async function stagedSchematicText(page: Page): Promise<string> {
  return page.evaluate(
    ({ slug, stem }) => {
      const w = window as unknown as W;
      const root = "/home/kicad/documents/kicad";
      const versions = w.FS.readdir(root).filter(
        (d) => d !== "." && d !== ".."
      );
      const paths = versions.map(
        (v) => `${root}/${v}/projects/${slug}/${stem}.kicad_sch`
      );
      const hit = paths.find((p) => w.FS.analyzePath(p).exists);
      if (!hit)
        throw new Error(
          `staged schematic not found under ${root} (${paths.join(", ")})`
        );
      return w.FS.readFile(hit, { encoding: "utf8" });
    },
    { slug: SLUG, stem: STEM }
  );
}

type FootprintBlock = { ref: string; uuid: string; lib: string };

/** Every footprint of a saved board: its reference, its own uuid and its library id. */
function footprintBlocks(text: string): FootprintBlock[] {
  const starts = [...text.matchAll(/\(footprint "([^"]*)"/g)].map(
    (m) => m.index!
  );
  const blocks: FootprintBlock[] = [];
  starts.forEach((start, i) => {
    const block = text.slice(start, starts[i + 1] ?? text.length);
    const lib = block.match(/^\(footprint "([^"]*)"/)?.[1] ?? "";
    const uuid = block.match(/\(uuid "([^"]+)"\)/)?.[1] ?? "";
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1] ?? "";
    blocks.push({ ref, uuid, lib });
  });
  return blocks;
}

const hasFootprint = (text: string, ref: string) =>
  footprintBlocks(text).some((b) => b.ref === ref);

/** Feed the binding a local-edit delta exactly as the C++ emit does. */
async function emit(
  page: Page,
  delta: { added?: WireItem[]; removed?: string[] }
): Promise<string> {
  return page.evaluate((d) => {
    try {
      (window as unknown as W).kicadCollab.onItems!(
        JSON.stringify({
          added: d.added ?? [],
          changed: [],
          removed: d.removed ?? [],
        })
      );
      return "no throw";
    } catch (e) {
      return String(e);
    }
  }, delta);
}

/** Record every delta the wasm hands the binding from here on (this document only). */
async function installDeltaLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__deltaLog = [];
    const orig = w.kicadCollab.onItems!;
    w.kicadCollab.onItems = (json: string) => {
      const d = JSON.parse(json) as {
        added: WireItem[];
        changed: WireItem[];
        removed: string[];
      };
      // A wire entry is one root item's s-expr; name it by its Reference when it
      // has one (footprints), else by its head keyword.
      const label = (x: WireItem) =>
        x.sexpr.match(/\(property\s+"Reference"\s+"([^"]*)"/)?.[1] ??
        x.sexpr.slice(1, x.sexpr.indexOf(" "));
      w.__deltaLog!.push({
        added: d.added.map(label),
        changed: d.changed.map(label),
        removed: d.removed.length,
      });
      orig(json);
    };
  });
}

async function readDeltaLog(page: Page): Promise<DeltaLogEntry[]> {
  return page.evaluate(() => (window as unknown as W).__deltaLog ?? []);
}

/** Whitespace-tolerant match for a property in the compact wire format: `(property  "Reference" "R1"`. */
const propertyRe = (name: string, value: string) =>
  new RegExp(
    `\\(property\\s+"${name}"\\s+"${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`
  );

/**
 * Derive the new symbol from the template's wire entry. An eeschema wire entry
 * bundles the library symbol with the instance —
 * `(lib_symbols(symbol "lib:R" …))(symbol(lib_id "lib:R") … (instances …))` —
 * so only the instance part is rewritten: fresh uuids, the new reference, the
 * SMD footprint, and a moved anchor. The lib_symbols prefix travels unchanged.
 */
function deriveSymbol(
  template: string,
  ref: string,
  footprint: string,
  uuids: string[]
): string {
  const at = template.search(/\(symbol\s*\(lib_id/);
  if (at < 0) throw new Error("template entry has no symbol instance part");
  const prefix = template.slice(0, at);
  let i = 0;
  let inst = template
    .slice(at)
    .replace(/\(uuid "[^"]+"\)/g, () => `(uuid "${uuids[i++]}")`);
  if (i > uuids.length)
    throw new Error(`template needs ${i} uuids, got ${uuids.length}`);
  inst = inst
    .replace(
      propertyRe("Reference", TEMPLATE_REF),
      `(property  "Reference" "${ref}"`
    )
    .replace(`(reference "${TEMPLATE_REF}")`, `(reference "${ref}")`)
    .replace(
      /\(property\s+"Footprint"\s+"[^"]*"/,
      `(property  "Footprint" "${footprint}"`
    )
    // The first (at …) of the instance is its anchor; every later one belongs to a property.
    .replace(
      /\(at (-?[\d.]+) (-?[\d.]+)( [-\d.]+)?\)/,
      (_m, x, y, rot) =>
        `(at ${(parseFloat(x) + 50).toFixed(2)} ${(parseFloat(y) + 30).toFixed(2)}${rot ?? ""})`
    );
  return prefix + inst;
}

/** KiCad internal units: nanometres. */
const MM = 1_000_000;

async function posOf(page: Page, uuid: string): Promise<[number, number]> {
  const raw = await page.evaluate(
    (id) => (window as unknown as W).Module.kicadCollabGetPos(id),
    uuid
  );
  expect(raw, `kicadCollabGetPos resolves ${uuid}`).toMatch(/^-?\d+,-?\d+$/);
  const [x, y] = raw.split(",").map(Number);
  return [x!, y!];
}

/** Move an item by (dx, dy) mm through a real BOARD_COMMIT and wait for the commit to land. */
async function moveItem(
  page: Page,
  uuid: string,
  ref: string,
  dxMm: number,
  dyMm: number
): Promise<[number, number]> {
  const [x0, y0] = await posOf(page, uuid);
  const want: [number, number] = [x0 + dxMm * MM, y0 + dyMm * MM];
  expect(
    await page.evaluate(
      ({ id, dx, dy }) =>
        (window as unknown as W).Module.kicadCollabTestMoveBoardItem(
          id,
          dx,
          dy
        ),
      { id: uuid, dx: dxMm * MM, dy: dyMm * MM }
    ),
    `kicadCollabTestMoveBoardItem resolves ${ref}`
  ).toBe(true);
  await expect
    .poll(() => posOf(page, uuid), {
      message: `${ref} never reached its moved position`,
      timeout: 30000,
      intervals: [250],
    })
    .toEqual(want);
  return want;
}

/** Route a track between two points through a real BOARD_COMMIT; returns its uuid once on the board. */
async function addTrack(
  page: Page,
  from: [number, number],
  to: [number, number]
): Promise<string> {
  const uuid = await page.evaluate(
    ({ a, b }) =>
      (window as unknown as W).Module.kicadCollabTestAddTrack(
        a[0],
        a[1],
        b[0],
        b[1],
        250000,
        "F.Cu"
      ),
    { a: from, b: to }
  );
  expect(uuid, "kicadCollabTestAddTrack returns the new track uuid").toMatch(
    /^[0-9a-f-]{36}$/
  );
  await expect
    .poll(async () => (await boardText(page)).includes(`(uuid "${uuid}")`), {
      message: `track ${uuid} never appeared in the saved board`,
      timeout: 30000,
      intervals: [250],
    })
    .toBe(true);
  return uuid;
}

async function openUpdateDialog(page: Page): Promise<void> {
  expect(await clickMenuBarItem(page, "Tools"), "Tools menu should open").toBe(
    true
  );
  await clickMenuItemByText(page, "Update PCB from Schematic");
  await waitUntil(
    page,
    () => {
      const r = (window as unknown as W).wxElementRegistry;
      if (!r?.findAll) return false;
      const visible = r.findAll({ visible: true });
      return (
        visible.some((e) => e.typeName === "wxDialog") &&
        visible.some((e) =>
          /Update PCB|Changes to Be Applied/i.test(
            `${e.label ?? ""} ${e.name ?? ""}`
          )
        )
      );
    },
    "DIALOG_UPDATE_PCB visible",
    { timeout: 120000 }
  );
}

async function waitDialogClosed(page: Page): Promise<void> {
  await waitUntil(
    page,
    () => {
      const r = (window as unknown as W).wxElementRegistry;
      return (
        !!r?.findAll &&
        !r.findAll({ visible: true }).some((e) => e.typeName === "wxDialog")
      );
    },
    "DIALOG_UPDATE_PCB closed",
    { timeout: 30000 }
  );
}

/** Remove the footprint through a real BOARD_COMMIT (emits to the room like a delete would). */
async function removeFootprint(
  page: Page,
  uuid: string,
  ref: string
): Promise<void> {
  expect(
    await page.evaluate(
      (id) => (window as unknown as W).Module.kicadCollabTestRemoveItem(id),
      uuid
    ),
    `kicadCollabTestRemoveItem resolves ${ref} (${uuid})`
  ).toBe(true);
  await expect
    .poll(async () => hasFootprint(await boardText(page), ref), {
      message: `${ref} still on the board after the remove commit`,
      timeout: 30000,
      intervals: [500],
    })
    .toBe(false);
}

// The user's flow is the in-app tool switch (Tools → Switch to …), i.e. `menu`.
// A Back/Forward round trip is a second navigation shape worth covering, but two
// tests editing the same persistent room interfere (a late-draining cleanup from
// one arrives mid-flight in the next), so it is not run by default — the repo is
// retries:0 and a room-ordering flake is not a real failure. Set
// PCBJAM_E2E_NAV=history to exercise it in isolation.
const NAV = (process.env.PCBJAM_E2E_NAV ?? "menu") as Nav;
{
  const nav = NAV;
  test(`a footprint added by Update PCB from Schematic survives a schematic ⇄ PCB switch (${nav})`, async ({
    page,
  }) => {
    test.setTimeout(1200000); // five wasm boots, two of them eeschema with its library hydration

    // The web suite's reference backend (@pcbjam/backend-example) keeps no
    // server-side room: tabs sync over BroadcastChannel and a reload re-seeds
    // from the file on disk, so a single-tab tool switch cannot carry an edit
    // there by design. The flow under test needs the full server's rooms — run
    // with WEB_APP_URL=http://localhost:3048 BACKEND_URL=http://localhost:3050.
    const backend = process.env.BACKEND_URL ?? "http://localhost:3060";
    const projectMeta = (await (
      await fetch(`${backend}/api/scopes/${SCOPE}/projects/${SLUG}`)
    ).json()) as {
      project?: { id?: string };
    };
    test.skip(
      !projectMeta.project?.id,
      "needs a server-side collab room (the full server), not the reference backend"
    );

    const consoleLines: string[] = [];
    page.on("console", (m) => {
      const t = m.text();
      if (SIGNATURE_RE.test(t)) consoleLines.push(t.slice(0, 200));
    });
    page.on("pageerror", (e) =>
      consoleLines.push(`pageerror: ${e.message.slice(0, 200)}`)
    );
    const annotate = (type: string, description: string) =>
      test.info().annotations.push({ type, description });

    // ── 1. eeschema: put R99 into the schematic document ──────────────────────
    await page.goto(`${SCH_URL}?user=${USER}`);
    await waitForToolReady(page, SCH_TITLE);

    let symbolUuid: string | undefined;
    if (ADD_SYMBOL) {
      const schSnap = await page.evaluate(() => {
        const snap = JSON.parse(
          (window as unknown as W).Module.kicadCollabSnapshotItems()
        ) as {
          added: WireItem[];
        };
        return snap.added.map((w) => w.sexpr);
      });
      const templateBlob = schSnap.find((s) =>
        propertyRe("Reference", TEMPLATE_REF).test(s)
      );
      expect(
        templateBlob,
        `schematic snapshot carries the ${TEMPLATE_REF} symbol as a template`
      ).toBeTruthy();

      // A stale R99 from an aborted run is reused rather than duplicated — the
      // editor was seeded from the document, so the snapshot says whether the room has it.
      const staleBlob = schSnap.find((s) =>
        propertyRe("Reference", REF).test(s)
      );
      if (staleBlob) {
        symbolUuid = staleBlob
          .slice(staleBlob.search(/\(symbol\s*\(lib_id/))
          .match(/\(uuid "([^"]+)"\)/)![1]!;
        annotate(
          "setup",
          `stale ${REF} already in the schematic document (uuid ${symbolUuid}) — reused`
        );
      } else {
        const uuids = await page.evaluate(() =>
          Array.from({ length: 8 }, () => crypto.randomUUID())
        );
        symbolUuid = uuids[0]!;
        const symbol = deriveSymbol(templateBlob!, REF, FOOTPRINT, uuids);
        expect(symbol, "derived symbol carries the new reference").toMatch(
          propertyRe("Reference", REF)
        );
        expect(symbol, "derived symbol carries the new uuid").toContain(
          `(uuid "${symbolUuid}")`
        );
        expect(
          await emit(page, { added: [{ sexpr: symbol, parent: null }] }),
          "symbol add emit"
        ).toBe("no throw");
        annotate(
          "setup",
          `${REF} added to the schematic document (uuid ${symbolUuid}, ${FOOTPRINT})`
        );
      }
    } else {
      annotate(
        "setup",
        `${REF} is a schematic part the board already lacks (PCBJAM_E2E_MISSING_REF) — no symbol added`
      );
    }

    let footprintUuid: string | undefined;
    const movedItems: Array<{
      ref: string;
      uuid: string;
      dx: number;
      dy: number;
    }> = [];
    const tracks: string[] = [];
    try {
      // ── 2. Tools → Switch to PCB Editor; the staged schematic is the fence ────
      await switchTool(page, "Switch to PCB Editor", PCB_PATH, PCB_TITLE);
      await expect
        .poll(
          async () =>
            propertyRe("Reference", REF).test(await stagedSchematicText(page)),
          {
            message: `the schematic staged for the netlist updater never carried ${REF} — the add did not reach the room`,
            timeout: 60000,
            intervals: [1000],
          }
        )
        .toBe(true);

      // A stale footprint from an aborted run would make the update a no-op.
      const before = footprintBlocks(await boardText(page));
      const stale = before.find((b) => b.ref === REF);
      if (stale) {
        annotate(
          "setup",
          `stale ${REF} footprint on the board (uuid ${stale.uuid}) — removed first`
        );
        await removeFootprint(page, stale.uuid, REF);
      }
      const countBefore = footprintBlocks(await boardText(page)).length;

      // ── 3. Update PCB from Schematic ──────────────────────────────────────────
      await installDeltaLog(page);
      await openUpdateDialog(page);
      expect(
        await clickByLabel(page, "Update PCB", { visible: true, exact: true }),
        "Update PCB button"
      ).toBe(true);
      await expect
        .poll(async () => hasFootprint(await boardText(page), REF), {
          message: `Update PCB never added ${REF} to the board`,
          timeout: 120000,
          intervals: [1000],
        })
        .toBe(true);
      expect(
        await clickByLabel(page, "Close", { visible: true, exact: true }),
        "Close button"
      ).toBe(true);
      await waitDialogClosed(page);

      const afterUpdate = footprintBlocks(await boardText(page));
      footprintUuid = afterUpdate.find((b) => b.ref === REF)!.uuid;
      expect(afterUpdate.length, "exactly one footprint was added").toBe(
        countBefore + 1
      );

      // What the wasm handed the binding for that commit — the diagnostic if the
      // final assertion fails. Recorded, not enforced: the invariant is step 5.
      const deltas = await readDeltaLog(page);
      annotate("emitted deltas after Update PCB", JSON.stringify(deltas));
      // Observed 2026-09-04 on the dev stack: the netlist-update commit reaches the
      // wire as `changed` entries only (18 of them, R99 among them, no `added`) —
      // flushDiff lifts a new footprint's CHILD to its parent before it visits the
      // root, and the lifted blob lands in `changed`. The receiver upserts, so the
      // document still gains the footprint. Recorded so a change in that shape is
      // visible next to a failure.
      annotate(
        `${REF} in an emitted entry`,
        `added: ${deltas.some((d) => d.added.includes(REF))}, changed: ${deltas.some((d) => d.changed.includes(REF))}`
      );

      // ── 4. the half-done layout: place the holes, move parts, route some of it ─
      const byRef = new Map(afterUpdate.map((b) => [b.ref, b.uuid]));
      // The four holes to the corners, and a few parts around them.
      const holes = afterUpdate
        .filter((b) => /MountingHole/i.test(b.lib))
        .slice(0, 4)
        .map((b) => b.ref);
      expect(holes, "the board has mounting holes to place").toHaveLength(4);
      const corners: Array<[number, number]> = [
        [-8, -8],
        [8, -8],
        [8, 8],
        [-8, 8],
      ];
      const parts = [REF, "R1", "C1"].filter((r) => byRef.has(r));
      expect(parts, `${REF}, R1 and C1 are on the board`).toHaveLength(3);
      const placements: Array<[string, number, number]> = [
        ...holes.map((h, i): [string, number, number] => [
          h,
          corners[i]![0],
          corners[i]![1],
        ]),
        [parts[0]!, 12, 0],
        [parts[1]!, -3, 5],
        [parts[2]!, 4, -6],
      ];
      const moved = new Map<string, [number, number]>();
      for (const [ref, dx, dy] of placements) {
        const uuid = byRef.get(ref);
        expect(uuid, `${ref} is on the board`).toBeTruthy();
        moved.set(uuid!, await moveItem(page, uuid!, ref, dx, dy));
        movedItems.push({ ref, uuid: uuid!, dx, dy });
      }
      // Half of it routed: tracks between the parts just placed.
      const routes: Array<[string, string]> = [
        [holes[0]!, holes[1]!],
        [holes[1]!, holes[2]!],
        [REF, "R1"],
        ["C1", REF],
      ];
      for (const [a, b] of routes) {
        const t = await addTrack(
          page,
          moved.get(byRef.get(a)!)!,
          moved.get(byRef.get(b)!)!
        );
        tracks.push(t);
      }
      const deltasAfterLayout = await readDeltaLog(page);
      annotate(
        "emitted deltas after the layout edits",
        JSON.stringify(deltasAfterLayout.slice(deltas.length))
      );

      // ── 5. the round trip ─────────────────────────────────────────────────────
      await roundTrip(page, nav);

      // ── 6. the invariants ─────────────────────────────────────────────────────
      const afterTripText = await boardText(page);
      const afterTrip = footprintBlocks(afterTripText);
      annotate("console signatures", consoleLines.slice(0, 40).join("\n"));
      expect(
        afterTrip.map((b) => b.ref),
        `${REF} must still be on the board after the schematic ⇄ PCB round trip`
      ).toContain(REF);
      expect(
        afterTrip.length,
        "no other footprint was lost on the round trip"
      ).toBe(countBefore + 1);
      footprintUuid =
        afterTrip.find((b) => b.ref === REF)?.uuid ?? footprintUuid;
      for (const { ref, uuid } of movedItems) {
        expect(
          await posOf(page, uuid),
          `${ref} kept its placed position across the round trip`
        ).toEqual(moved.get(uuid));
      }
      for (const t of tracks) {
        expect(afterTripText, `track ${t} survived the round trip`).toContain(
          `(uuid "${t}")`
        );
      }

      // ── 7. the document's own truth: reload and re-seed from the room ──────────
      // The staging finding (2026-09-04) was that the ROOM DOCUMENT, not just the
      // on-screen model, had dropped footprints — the editor loaded "editor
      // matches doc (N)" and faithfully showed the reduced set, so a reload kept
      // the loss. A fresh page load re-seeds from the ydoc, so this reads exactly
      // what that seed path reads: the document's persisted footprints.
      await page.goto(`${PCB_URL}?user=${USER}`);
      await waitForToolReady(page, PCB_TITLE);
      const reloaded = footprintBlocks(await boardText(page));
      annotate(
        "footprints after reload (document truth)",
        `${reloaded.length}: ${reloaded
          .map((b) => b.ref)
          .sort()
          .join(",")}`
      );
      expect(
        reloaded.map((b) => b.ref),
        `${REF} must still be in the room document after a reload (not just the live editor)`
      ).toContain(REF);
      expect(
        reloaded.length,
        "the room document kept every footprint across the round trip + reload"
      ).toBe(countBefore + 1);
    } finally {
      // ── restore the room for the other specs ──────────────────────────────────
      const onBoard = /PCB Editor/i.test(await page.title());
      if (onBoard) {
        const text = await boardText(page);
        for (const t of tracks) {
          if (text.includes(`(uuid "${t}")`)) {
            expect(
              await page.evaluate(
                (id) =>
                  (window as unknown as W).Module.kicadCollabTestRemoveItem(id),
                t
              ),
              `remove track ${t}`
            ).toBe(true);
          }
        }
        const live = new Set(footprintBlocks(text).map((b) => b.uuid));
        for (const { ref, uuid, dx, dy } of movedItems) {
          if (live.has(uuid) && ref !== REF)
            await moveItem(page, uuid, ref, -dx, -dy);
        }
        const now = footprintBlocks(await boardText(page)).find(
          (b) => b.ref === REF
        );
        if (now) await removeFootprint(page, now.uuid, REF);
      }
      if (symbolUuid) {
        await page.goto(`${SCH_URL}?user=${USER}`);
        await waitForToolReady(page, SCH_TITLE);
        expect(
          await emit(page, { removed: [symbolUuid] }),
          "symbol remove emit"
        ).toBe("no throw");
      }
      annotate(
        "cleanup",
        `removed ${REF}: ${symbolUuid ? `symbol ${symbolUuid}` : "no symbol to remove"}${footprintUuid ? `, footprint ${footprintUuid}` : ""}`
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent-peer variant (opt-in: PCBJAM_E2E_PEER=1).
//
// The staging finding was document-level loss with a `⬆ remote Y change → apply
// to editor` stream arriving while the board was edited — i.e. a SECOND
// connection to the room. A single localhost tab never produced that, because
// its in-process room has no peer to race the seed/commit against. This variant
// keeps a second tab (bob) open on the same board for the whole flow, so alice's
// Update PCB and tool switch run against a live peer whose remote applies
// interleave with alice's local commits (drift-trio S4: a remote apply wins over
// a concurrent local edit). After the round trip BOTH tabs reload and must agree
// with each other and with the full footprint count — a divergence is the bug.
//
// Not run by default: it needs a real room server (skips on the reference
// backend) and, until it reliably reproduces, a failure here is a lead to chase,
// not a green-bar gate. retries:0 stays.
if (process.env.PCBJAM_E2E_PEER === "1") {
  test("concurrent peer: the room keeps every footprint across one tab's switch", async ({
    page,
    context,
  }) => {
    test.setTimeout(1800000); // several boots across two tabs

    const alice = page;
    const bob = await context.newPage();
    try {
      await alice.goto(`${PCB_URL}?user=alice`);
      await waitForToolReady(alice, PCB_TITLE);
      await bob.goto(`${PCB_URL}?user=bob`);
      await waitForToolReady(bob, PCB_TITLE);

      const baseline = footprintBlocks(await boardText(alice)).length;
      const bobBaseline = footprintBlocks(await boardText(bob)).length;
      expect(bobBaseline, "both peers see the same board at start").toBe(
        baseline
      );

      // Alice moves the holes and a few parts, and routes tracks, while bob is
      // live — every commit emits to the room and bob applies it back.
      const parts = footprintBlocks(await boardText(alice));
      const holes = parts
        .filter((b) => /MountingHole/i.test(b.lib))
        .slice(0, 4);
      const others = parts
        .filter((b) => !/MountingHole/i.test(b.lib))
        .slice(0, 4);
      const corners: Array<[number, number]> = [
        [-8, -8],
        [8, -8],
        [8, 8],
        [-8, 8],
      ];
      const placed: Array<{
        ref: string;
        uuid: string;
        dx: number;
        dy: number;
      }> = [];
      const laid: string[] = [];
      for (let i = 0; i < holes.length; i++) {
        await moveItem(
          alice,
          holes[i]!.uuid,
          holes[i]!.ref,
          corners[i]![0],
          corners[i]![1]
        );
        placed.push({
          ref: holes[i]!.ref,
          uuid: holes[i]!.uuid,
          dx: corners[i]![0],
          dy: corners[i]![1],
        });
      }
      for (let i = 0; i < others.length; i++) {
        const dx = 3 + i;
        await moveItem(alice, others[i]!.uuid, others[i]!.ref, dx, -2);
        placed.push({ ref: others[i]!.ref, uuid: others[i]!.uuid, dx, dy: -2 });
      }
      try {
        const a = placed[0]!;
        const b = placed[1]!;
        const t = await addTrack(
          alice,
          await posOf(alice, a.uuid),
          await posOf(alice, b.uuid)
        );
        laid.push(t);
      } catch {
        // routing is not the invariant here; the footprint count is
      }

      // Alice switches away and back while bob stays connected.
      await roundTrip(alice, "menu");

      // Both tabs reload — read each one's document truth (the seed path).
      await alice.goto(`${PCB_URL}?user=alice`);
      await waitForToolReady(alice, PCB_TITLE);
      await bob.goto(`${PCB_URL}?user=bob`);
      await waitForToolReady(bob, PCB_TITLE);
      const aRefs = footprintBlocks(await boardText(alice))
        .map((b) => b.ref)
        .sort();
      const bRefs = footprintBlocks(await boardText(bob))
        .map((b) => b.ref)
        .sort();
      test.info().annotations.push(
        {
          type: "alice footprints after reload",
          description: `${aRefs.length}: ${aRefs.join(",")}`,
        },
        {
          type: "bob footprints after reload",
          description: `${bRefs.length}: ${bRefs.join(",")}`,
        }
      );

      expect(aRefs.length, "alice's document kept every footprint").toBe(
        baseline
      );
      expect(
        bRefs,
        "both peers agree on the footprint set (no divergence)"
      ).toEqual(aRefs);

      // Restore positions and tracks (best effort — the count is the invariant).
      for (const t of laid) {
        await alice.evaluate(
          (id) => (window as unknown as W).Module.kicadCollabTestRemoveItem(id),
          t
        );
      }
      for (const { ref, uuid, dx, dy } of placed) {
        const live = footprintBlocks(await boardText(alice)).some(
          (b) => b.uuid === uuid
        );
        if (live) await moveItem(alice, uuid, ref, -dx, -dy);
      }
    } finally {
      await bob.close();
    }
  });
}
