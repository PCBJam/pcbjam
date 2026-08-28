import { test, expect } from '@playwright/test';
import {
    clickMenuBarItem,
    clickMenuItemByText,
    waitForEditorReady,
    waitUntil,
    stableShot,
} from '../e2e/utils/element-tracker';
import { injectFromSubmodule } from './utils/fs-inject';

/**
 * project-sync 0001 — "Update PCB from Schematic" in the merged WASM editor.
 *
 * The merged kicad_editor bundle statically links BOTH kifaces, so the fork's
 * KIWAY::FaceRegistered(FACE_SCH) predicate lets a "standalone" PCB editor run
 * the sync: F8 spawns the eeschema kiface IN-PROCESS (kept hidden in the wasm
 * build — see TestStandalone's __EMSCRIPTEN__ branch), loads the sibling
 * .kicad_sch, and returns the netlist over MAIL_SCH_GET_NETLIST into
 * DIALOG_UPDATE_PCB.
 *
 * Two tests:
 *   1. first sync — the action is enabled, the dialog opens, the spawned
 *      schematic frame stays HIDDEN (does not hijack the PCB tab).
 *   2. edit-then-resync — after the .kicad_sch changes underneath (the live
 *      sibling-restage's effect), a SECOND sync reflects the NEW schematic, not
 *      a cached parse. This is the regression guard for the hidden-player
 *      reload (repeat-F8 freshness).
 */

const STEM = 'syncspike';
const DIR = '/home/kicad/documents';
const SCH_UUID = '00000000-0000-4000-8000-00000000a001';

const PCB = `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general (thickness 1.6))
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup)
\t(net 0 "")
)
`;

// Keep in sync with web/standalone/src/lib/new-file.ts defaultKicadPro().
const PRO = `${JSON.stringify({ meta: { filename: `${STEM}.kicad_pro`, version: 3 } }, null, 2)}\n`;

// Empty root sheet — enough to prove the sync round-trips (netlist has zero
// components; DIALOG_UPDATE_PCB still opens).
const EMPTY_SCH = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "${SCH_UUID}")
\t(paper "A4")
\t(lib_symbols)
\t(sheet_instances
\t\t(path "/" (page "1"))
\t)
)
`;

// A self-contained resistor symbol (lib def + placement) lifted verbatim from
// the ecc83 demo, with a swappable reference designator so two schematic
// versions carry DIFFERENT, searchable references in the netlist.
const R_LIBDEF = String.raw`(symbol "ecc83-pp:R"
			(pin_numbers
				(hide yes)
			)
			(pin_names
				(offset 0)
			)
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(property "Reference" "R"
				(at 2.032 0 90)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Value" "R"
				(at 0 0 90)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(property "Footprint" ""
				(at -1.778 0 90)
				(effects
					(font
						(size 0.762 0.762)
					)
				)
			)
			(property "Datasheet" ""
				(at 0 0 0)
				(effects
					(font
						(size 0.762 0.762)
					)
				)
			)
			(property "Description" ""
				(at 0 0 0)
				(effects
					(font
						(size 1.27 1.27)
					)
					(hide yes)
				)
			)
			(property "ki_fp_filters" "R_* Resistor_*"
				(at 0 0 0)
				(effects
					(font
						(size 1.27 1.27)
					)
					(hide yes)
				)
			)
			(symbol "R_0_1"
				(rectangle
					(start -1.016 -2.54)
					(end 1.016 2.54)
					(stroke
						(width 0.254)
						(type default)
					)
					(fill
						(type none)
					)
				)
			)
			(symbol "R_1_1"
				(pin passive line
					(at 0 3.81 270)
					(length 1.27)
					(name "~"
						(effects
							(font
								(size 1.524 1.524)
							)
						)
					)
					(number "1"
						(effects
							(font
								(size 1.524 1.524)
							)
						)
					)
				)
				(pin passive line
					(at 0 -3.81 90)
					(length 1.27)
					(name "~"
						(effects
							(font
								(size 1.524 1.524)
							)
						)
					)
					(number "2"
						(effects
							(font
								(size 1.524 1.524)
							)
						)
					)
				)
			)
			(embedded_fonts no)
		)`;
const R_PLACEMENT = String.raw`(symbol
		(lib_id "ecc83-pp:R")
		(at 157.48 85.09 180)
		(unit 1)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(dnp no)
		(uuid "00000000-0000-0000-0000-00004549f38a")
		(property "Reference" "__REF__"
			(at 154.94 85.09 0)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Value" "1.5K"
			(at 157.48 85.09 90)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Footprint" "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"
			(at 159.512 85.0392 90)
			(effects
				(font
					(size 0.254 0.254)
				)
			)
		)
		(property "Datasheet" ""
			(at 157.48 85.09 0)
			(effects
				(font
					(size 1.524 1.524)
				)
				(hide yes)
			)
		)
		(property "Description" ""
			(at 157.48 85.09 0)
			(effects
				(font
					(size 1.27 1.27)
				)
				(hide yes)
			)
		)
		(pin "1"
			(uuid "490a35ba-1ba2-44c5-adce-e27a045257ab")
		)
		(pin "2"
			(uuid "51355c82-d1cf-445b-b079-21c660dd8989")
		)
		(instances
			(project "ecc83-pp"
				(path "/28f865a0-4433-4a53-bbd7-b62f276848e4"
					(reference "__REF__")
					(unit 1)
				)
			)
		)
	)`;

function resistorSch(ref: string): string {
    return `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "${SCH_UUID}")
\t(paper "A4")
\t(lib_symbols
\t\t${R_LIBDEF}
\t)
\t${R_PLACEMENT.replace(/__REF__/g, ref)}
\t(sheet_instances
\t\t(path "/" (page "1"))
\t)
)
`;
}

const BOOT_TIMEOUT = 150000;

interface FS { mkdirTree(p: string): void; writeFile(p: string, d: string): void; }
interface Mod { kicadOpenFile(p: string): unknown; }

/** Stage board + schematic + minimal .kicad_pro into MEMFS, then open the board. */
async function stageAndOpen(
    page: import('@playwright/test').Page,
    sch: string,
    /** Runs after the project files are staged and BEFORE the board opens (e.g. lib tables). */
    beforeOpen?: (page: import('@playwright/test').Page) => Promise<void>,
): Promise<void> {
    await page.goto('/kicad/pcbnew.html');
    await waitForEditorReady(page);
    await page.evaluate(
        ({ dir, stem, pcb, sch, pro }) => {
            const w = window as unknown as { FS: FS };
            try { w.FS.mkdirTree(dir); } catch { /* exists */ }
            w.FS.writeFile(`${dir}/${stem}.kicad_pcb`, pcb);
            w.FS.writeFile(`${dir}/${stem}.kicad_sch`, sch);
            w.FS.writeFile(`${dir}/${stem}.kicad_pro`, pro);
        },
        { dir: DIR, stem: STEM, pcb: PCB, sch, pro: PRO },
    );
    if (beforeOpen) await beforeOpen(page);
    await page.evaluate(
        ({ dir, stem }) => {
            const w = window as unknown as { Module: Mod };
            w.Module.kicadOpenFile(`${dir}/${stem}.kicad_pcb`);
        },
        { dir: DIR, stem: STEM },
    );
    await waitUntil(
        page,
        (s: string) => document.title.includes(s),
        `board "${STEM}" opened (window title)`,
        { timeout: BOOT_TIMEOUT, arg: STEM },
    );
}

/** Overwrite the staged schematic in MEMFS (simulates the live sibling-restage). */
async function rewriteSchematic(page: import('@playwright/test').Page, sch: string): Promise<void> {
    await page.evaluate(
        ({ dir, stem, sch }) => {
            const w = window as unknown as { FS: FS };
            w.FS.writeFile(`${dir}/${stem}.kicad_sch`, sch);
        },
        { dir: DIR, stem: STEM, sch },
    );
}

/** Tools -> Update PCB from Schematic, and wait for DIALOG_UPDATE_PCB. */
async function openSyncDialog(page: import('@playwright/test').Page): Promise<void> {
    const opened = await clickMenuBarItem(page, 'Tools');
    expect(opened, 'Tools menu should open').toBe(true);
    await clickMenuItemByText(page, 'Update PCB from Schematic');
    await waitUntil(
        page,
        () => {
            const r = window.wxElementRegistry;
            if (!r || !r.findAll) return false;
            const visible = r.findAll({ visible: true });
            const dialogUp = visible.some((e) => e.typeName === 'wxDialog');
            const marker = visible.some((e) => /Update PCB|Changes to Be Applied/i
                .test(`${e.label || ''} ${e.name || ''}`));
            return dialogUp && marker;
        },
        'DIALOG_UPDATE_PCB visible',
        { timeout: 120000 },
    );
}

/** Close the currently-open modal dialog (Escape resolves the wx modal wait). */
async function closeDialog(page: import('@playwright/test').Page): Promise<void> {
    await page.keyboard.press('Escape');
    await waitUntil(
        page,
        () => {
            const r = window.wxElementRegistry;
            return !!r && !!r.findAll && !r.findAll({ visible: true })
                .some((e) => e.typeName === 'wxDialog');
        },
        'DIALOG_UPDATE_PCB closed',
        { timeout: 30000 },
    );
}

/** The spawned schematic frame must not be visible / must not take over the tab. */
async function assertSchFrameHidden(page: import('@playwright/test').Page): Promise<void> {
    const schShown = await page.evaluate(() => {
        const r = window.wxElementRegistry;
        if (!r || !r.findAll) return false;
        return r.findAll({ visible: true })
            .some((e) => e.typeName === 'wxFrame' && /Schematic/i.test(e.name || e.label || ''));
    });
    expect(schShown, 'schematic frame must stay hidden (no PCB-tab hijack)').toBe(false);
    expect(await page.title(), 'PCB tab keeps its title').toMatch(/PCB Editor/i);
}

test.describe('project-sync: update PCB from schematic (merged bundle)', () => {
    test('first sync opens the dialog with the schematic frame hidden', async ({ page }) => {
        const consoleLines: string[] = [];
        page.on('console', (m) => consoleLines.push(m.text()));
        page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));

        await stageAndOpen(page, EMPTY_SCH);
        await stableShot(page, 'project-sync-00-board-open.png');

        await openSyncDialog(page);
        await stableShot(page, 'project-sync-01-update-dialog.png');

        // The core of the hidden-player fix: the netlist came back and the
        // dialog is up, but eeschema never hijacked the PCB tab.
        await assertSchFrameHidden(page);

        expect(consoleLines.some((s) => s.includes('Aborted(')),
            'no wasm abort during the sync flow').toBe(false);
    });

    test('a schematic edit between syncs is reflected on the second sync', async ({ page }) => {
        const consoleLines: string[] = [];
        page.on('console', (m) => consoleLines.push(m.text()));
        page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));

        // The netlist report (DIALOG_UPDATE_PCB's WX_HTML_REPORT_BOX) is painted to
        // the GL canvas — its text is NOT in the DOM or the wx registry (verified),
        // so the R777-vs-R888 content is asserted the way this repo asserts all
        // editor-rendered content: the committed screenshot baseline. The
        // PROGRAMMATIC guards here are the reload MECHANICS: that a second sync,
        // with the .kicad_sch changed underneath, reaches DIALOG_UPDATE_PCB again
        // (openSyncDialog throws on timeout — so a reload that hung on a "save
        // changes?" prompt, or a cached frame that never re-read, would fail loudly)
        // with the schematic frame still hidden and no wasm abort.

        // First sync: schematic has R777. Reaching the dialog proves the freshly
        // spawned hidden player loaded this schematic and returned its netlist.
        await stageAndOpen(page, resistorSch('R777'));
        await openSyncDialog(page);
        await assertSchFrameHidden(page);
        await stableShot(page, 'project-sync-02-resync-first-R777.png');
        await closeDialog(page);

        // The schematic changes underneath — exactly what the live sibling-restage
        // writes into MEMFS when a collaborator edits it: R777 -> R888.
        await rewriteSchematic(page, resistorSch('R888'));

        // Second sync: the hidden player re-reads MEMFS (IsShownOnScreen() stays
        // false, so TestStandalone re-runs OpenProjectFiles), so the netlist now
        // reflects R888. Reaching the dialog again == the repeat-sync path did not
        // hang; the screenshot baseline is the R888-not-R777 content guard.
        await openSyncDialog(page);
        await assertSchFrameHidden(page);
        await stableShot(page, 'project-sync-03-resync-second-R888.png');

        expect(consoleLines.some((s) => s.includes('Aborted(')),
            'no wasm abort during the resync flow').toBe(false);
    });
});

// ---------------------------------------------------------------------------
// R-9 (docs/features/findings/groups/R-fixed-during-demo-record.md): the sync
// must APPLY. The tests above prove the dialog is reached; DIALOG_UPDATE_PCB's
// report can still say "done" while nothing lands on the board (the O-1
// failure class the demo ledger hit). This one presses Update PCB and asserts
// the BOARD EFFECT — the schematic's footprint exists on the board with the
// schematic's reference — through the collab snapshot embind, never the
// dialog text. A self-contained footprint library (the ecc83 demo's
// footprints.pretty, staged into MEMFS with an absolute-uri project
// fp-lib-table) makes the placement resolvable offline.
// ---------------------------------------------------------------------------

const FP_LIB_NICK = 'SyncFixture';
const FP_NAME = 'R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal';
const FP_LIB_DIR = `${DIR}/${FP_LIB_NICK}.pretty`;

/** The schematic with the resistor pointed at the staged fixture library. */
function resistorSchWithFixtureLib(ref: string): string {
    return resistorSch(ref).replace('"Resistor_THT:', `"${FP_LIB_NICK}:`);
}

/** Stage the .pretty + a project fp-lib-table (absolute uri; no env expansion needed). */
async function stageFootprintLib(page: import('@playwright/test').Page): Promise<void> {
    await injectFromSubmodule(
        page,
        `kicad/demos/ecc83/footprints.pretty/${FP_NAME}.kicad_mod`,
        `${FP_LIB_DIR}/${FP_NAME}.kicad_mod`,
    );
    await page.evaluate(
        ({ dir, nick, libDir }) => {
            const w = window as unknown as { FS: FS };
            w.FS.writeFile(
                `${dir}/fp-lib-table`,
                `(fp_lib_table\n  (version 7)\n  (lib (name "${nick}")(type "KiCad")(uri "${libDir}")(options "")(descr ""))\n)\n`,
            );
        },
        { dir: DIR, nick: FP_LIB_NICK, libDir: FP_LIB_DIR },
    );
}

interface SnapMod {
    kicadCollabSnapshot(): string;
    kicadCollabTestItemBlob(uuid: string): string;
}

/** Click a visible wx button by label (registry coords, real mouse click — the
 *  proven recipe from occ-export.spec.ts; a `&` mnemonic may prefix the label). */
async function clickWxButton(page: import('@playwright/test').Page, label: string): Promise<void> {
    const pos = await page.evaluate((wanted: string) => {
        const el = (window.wxElementRegistry?.findAll({ visible: true }) ?? []).find(
            (e) => (e.label === wanted || e.label === `&${wanted}`) && (e.typeName ?? '').includes('Button'),
        );
        return el ? { x: el.centerX, y: el.centerY } : null;
    }, label);
    expect(pos, `wx button "${label}" found`).not.toBeNull();
    await page.mouse.click(pos!.x, pos!.y);
}

/** After an apply the dialog is in its "done" state (OK disabled, Close is the
 *  default) and Escape no longer resolves it — press Close explicitly. */
async function closeDialogByButton(page: import('@playwright/test').Page): Promise<void> {
    await clickWxButton(page, 'Close');
    await waitUntil(
        page,
        () => {
            const r = window.wxElementRegistry;
            return !!r && !!r.findAll && !r.findAll({ visible: true })
                .some((e) => e.typeName === 'wxDialog');
        },
        'DIALOG_UPDATE_PCB closed via Close',
        { timeout: 30000 },
    );
}

/** References of every footprint currently on the board (from the item blobs). */
async function boardFootprintRefs(page: import('@playwright/test').Page): Promise<string[]> {
    return page.evaluate(() => {
        const m = (window as unknown as { Module: SnapMod }).Module;
        const snap = JSON.parse(m.kicadCollabSnapshot()) as { added: Array<{ id: string; type: string }> };
        return snap.added
            .filter((i) => i.type === 'FOOTPRINT')
            .map((i) => /\(property "Reference" "([^"]*)"/.exec(m.kicadCollabTestItemBlob(i.id))?.[1] ?? '?');
    });
}

/** Press Update PCB and wait until the board carries exactly the expected references. */
async function updateAndExpectRefs(page: import('@playwright/test').Page, refs: string[]): Promise<void> {
    await clickWxButton(page, 'Update PCB');
    await expect
        .poll(() => boardFootprintRefs(page), {
            message: `board footprints after Update PCB should be ${JSON.stringify(refs)}`,
            timeout: 60000,
            intervals: [500],
        })
        .toEqual(refs);
}

test.describe('project-sync: Update PCB applies to the board (R-9)', () => {
    test('the schematic footprint lands on the board, and a re-sync tracks a reference change', async ({ page }) => {
        test.setTimeout(240000);
        const consoleLines: string[] = [];
        page.on('console', (m) => consoleLines.push(m.text()));
        page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));

        await stageAndOpen(page, resistorSchWithFixtureLib('R777'), stageFootprintLib);
        await page.waitForFunction(
            () => {
                const m = (window as unknown as { Module?: Partial<SnapMod> }).Module;
                return typeof m?.kicadCollabSnapshot === 'function'
                    && typeof m?.kicadCollabTestItemBlob === 'function';
            },
            null,
            { timeout: 30000 },
        );
        expect(await boardFootprintRefs(page), 'board starts empty').toEqual([]);

        // First sync: the effect, not the report.
        await openSyncDialog(page);
        await updateAndExpectRefs(page, ['R777']);
        await assertSchFrameHidden(page);
        await closeDialogByButton(page);

        // The schematic changes underneath (live sibling restage) — re-sync must
        // apply the NEW reference, not a cached parse.
        await rewriteSchematic(page, resistorSchWithFixtureLib('R888'));
        await openSyncDialog(page);
        await updateAndExpectRefs(page, ['R888']);
        await assertSchFrameHidden(page);
        await closeDialogByButton(page);

        expect(consoleLines.some((s) => s.includes('Aborted(')),
            'no wasm abort during the apply flow').toBe(false);
    });
});
