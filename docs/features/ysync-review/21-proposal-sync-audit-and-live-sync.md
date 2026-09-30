# Proposal 21 — Fix the 2026-09-29 sync audit, and stop needing Save to sync

**Status:** ACCEPTED and IMPLEMENTED (2026-09-30), all work packages WP-0 to WP7. Section 8 records what
was built, where it deviates from the design above, and what is still open. Reviewer decisions are in
section 7.
**Supersedes:** the earlier draft `21-proposal-live-header-sync.md` (board layers/header only). That draft's
design is now work package WP4 below.
**Inputs:**
- the sync e2e audit on branch `codex/sync-e2e-audit` (pcbjam `87aa58a`, report
  `docs/features/ysync-review/2026-09-29-sync-e2e-audit.md` on that branch);
- a user drift report after adding/removing PCB layers (2026-09-29), reproduced in
  `web/standalone/src/wasm/collab/layers-drift.repro.test.ts`;
- a read-through of every path where a change only reaches the room or peers on File→Save.

The doc has five parts:
1. the audit findings;
2. which files to recreate from the audit branch;
3. fixes for the audit findings, grouped into work packages;
4. every place a user has to save before something syncs;
5. fixes for those places.

The last section gives the order and cost.

---

## 1. Audit findings

The audit drives real KiCad commits → native wire → production binding → BroadcastChannel → a second
browser's native editor. It has 17 scenarios: 1 control that passes and 16 defect assertions that fail on
staging (Chromium only). Its specs assert the *desired* behaviour and deliberately don't use `test.fail`.

| ID | Severity | What goes wrong | Mechanism (where) | Audit scenarios |
|---|---|---|---|---|
| **SYNC-01** | high | A peer inserts a polygon vertex while the local user moves a later vertex. The move lands on the **wrong vertex**. | `patchNodeFromSlots` / `keySlots` (`web/pcbjam-shared/src/kicad-y2.ts`) key repeated unkeyed fields (`xy`) by occurrence. Both the baseline (`before`) and the new body (`after`) are keyed against the *current* node, which already has the peer's insert, so occurrence k now names a different point. | 1 |
| **SYNC-02** | high | On eeschema, a global edit to a symbol on a **parked** sheet reverts a peer's move of that symbol. | `doWriteOffSheet` (`web/standalone/src/wasm/collab/sheet-manager.ts:505`) diffs the stale native fragment against the *doc*. A parked sheet has no native baseline, so every stale field reads as a local change. | 1 |
| **SYNC-03** | high | A stale local item packet writes back an **old library definition** over a newer one. | The DOWN path of `kicad-binding.ts` (~l.345) calls `upsertLibSymbolsToY(wireLibSymbols(wire))` unconditionally. Items are baseline-relative; library definitions are not. | 1 |
| **SYNC-04** | high | Groups lose their members on the receiving side, both when a group is adopted and when a member is replaced. PCB and SCH. | (a) `makeFromBlob` (`wasm/bindings/pcbnew_embind.cpp`) parses a group in a temporary board, so `resolveGroups` finds no members. (b) The upsert does `commit.Remove(existing)` + `commit.Add(parsed)`, and the replacement never rejoins the old object's parent group. eeschema's `doApplyItems` has the same two paths. | 4 |
| **SYNC-05** | high | Points, generators (tuning patterns) and groups are **missing from native snapshots**. Points and generators present in Yjs also never materialize on a peer. | `pcbCollabSnapshotItems` (`pcbnew_embind.cpp:1583`) walks footprints, tracks, zones and drawings only. `forEachTopItem` adds groups but not `Points()` / `Generators()`. `makeFromBlob` only extracts tracks, zones, drawings, footprints and groups. | 5 |
| **SYNC-06a** | medium/high | A peer's open board keeps the old paper size and title after the room has the new ones. | Root header sections (`paper`, `title_block`, `setup`, `layers`…) are written to the room only by the save-time `syncLayoutToY`. Nothing ever applies them to an open editor (`kicad-binding.ts` `onLayout` only repairs duplicates). Same root cause as the layer drift report. | 1 |
| **SYNC-06b** | medium/high | A stale peer saves a revision change and **wipes a peer's newer title**. | `syncLayoutToY` (`kicad-y.ts:763`) replaces a whole section when anything in it changed. The baseline says *which section* changed, not *which field*. Same mechanism as layer-drift repro case 3 (a stale setup edit wipes a 4-layer stackup). | 1 |
| **SYNC-07** | high | Two sheet files share a symbol uuid (a copied sheet), and one global commit edits both. **Only one sheet emits**; the other room stays stale. | The eeschema dirty collector `g_dirty` is a `std::map<uuid, SCH_SCREEN*>` (`wasm/bindings/eeschema_embind.cpp:569`), so the second screen overwrites the first. Room identity is per file, so the key must be `(screen, uuid)`. | 1 |
| **SYNC-08** | high | A moves a footprint, B edits its Value, then A undoes its move. A's native board reverts **both** (X and the old Value), and **no packet is emitted**, so A diverges from the doc and B. | Native undo restores whole-item images (`SwapItemData`), which was accepted in doc [20](20-fix-miss09-collab-aware-undo.md). The missing packet is **not explained yet**: undo does fire `BOARD::OnItemsCompositeUpdate` (`kicad/pcbnew/undo_redo.cpp:718`), which `COLLAB_LISTENER` handles. | 1 |

The layer drift report adds two gaps the audit didn't cover, found by reading code (see WP4):
- **G1:** `wrapInBoardEnvelope` builds the parse envelope from the *receiver's* enabled layers.
- **G2:** `BOARD::RemoveAllItemsOnLayer` changes a multi-layer item's layer set without firing a listener, so
  a zone that loses one layer never emits.

---

## 2. What to recreate from the audit branch

**Rule:** nothing is merged or cherry-picked from `codex/sync-e2e-audit`; that's the standing rule for
codex branches. Each piece is written fresh on staging, with the branch as a read-only reference. The branch
has been **handed over** (decision 4): no other agent works on it, so its content is frozen as the reference,
and any further scenarios are added by us, directly on staging.

**What's actually new on the branch:** `git cherry` against `origin/staging` shows that only pcbjam
`87aa58a` and the root pointer bump `faf5719` are new. The KiCad 10.0.6 rebase, the 3d-regression include
fix and the other commits below it are already on staging, so nothing to do for those.

**Landing rule:** every `tests/kicad` spec runs in CI on both kicad projects (`npm run test:e2e`). A
scenario therefore lands **in the same commit as the fix that makes it pass**; the harness and hooks can
land earlier. The spec file is recreated once and grows scenario by scenario. The audit only ran Chromium,
so each scenario must also be checked on Firefox when it lands.

| File in `87aa58a` | Recreate? | Lands with |
|---|---|---|
| `docs/features/ysync-review/2026-09-29-sync-e2e-audit.md` | Yes, verbatim | WP-0 (first commit), so the finding IDs resolve |
| `tests/collab/browser-entry-sync-audit.ts` (test driver) | Yes | WP-0. In WP4, `saveLayout()` switches from its own `layoutBaseline` to the binding's baseline. |
| `tests/collab/build-sync-audit.mjs` (esbuild bundle of the driver) | Yes | WP-0 |
| `tests/kicad/ysync-audit-2026-09-29.spec.ts` | Yes, **incrementally** | Helpers + `control` in WP-0; each scenario with its WP (table below) |
| `wasm/bindings/pcbnew_embind.cpp`: `kicadCollabTestAuditPolygon` | Yes | WP1 (SYNC-01) |
| `wasm/bindings/pcbnew_embind.cpp`: `kicadCollabTestAuditSettings` (+ `page_info.h` / `title_block.h` includes) | Yes | WP1 (SYNC-06b), reused by WP4 |
| `wasm/bindings/eeschema_embind.cpp`: `kicadCollabTestAuditLibrary` | Yes | WP1 (SYNC-03) |
| `wasm/bindings/eeschema_embind.cpp`: `kicadCollabTestAuditFields`, `kicadCollabTestAuditSheetItems` | Yes | WP2 (SYNC-02, SYNC-07) |
| Root `faf5719` (pointer bump) | No | The root pointer gets bumped by our own commits |

Scenario → work package:

| Scenario | WP |
|---|---|
| control | WP-0 |
| SYNC-01 | WP1 |
| SYNC-03 | WP1 |
| SYNC-06b | WP1 |
| SYNC-02 | WP2 |
| SYNC-07 | WP2 |
| SYNC-04 pcb / sch × adopt / replace (4) | WP3 |
| SYNC-05 point / generator / group snapshot (3) + point / generator remote (2) | WP3 |
| SYNC-06a | WP4 |
| SYNC-08 | WP7 |

**New test pieces on our side (not from the branch):**
- `layers-drift.repro.test.ts` (already written, uncommitted) becomes WP1/WP4 regression tests.
- A `kicadCollabTestAuditLayers` hook (WP4).
- Repros for the save-only data-loss bugs (WP-0).

---

## 3. Fixes for the audit findings

The findings are grouped by the layer the fix lives in, so each package touches one area and has its own
tests.

### WP1 — Shared-TS merge correctness (SYNC-01, SYNC-03, SYNC-06b)

Pure TypeScript in `pcbjam-shared` and the binding, no WASM rebuild. It goes first because every later
package writes through these merges.

**SYNC-01: value-anchored matching for repeated fields without a key.**
- In `patchNodeFromSlots`, positional pools are currently matched against the node *as it is now*. Replace
  this with a two-step alignment for kinds that have no identity (rule 3):
  1. align `before` → current node entries by **value**, using a longest-common-subsequence over the
     entries' JSON. That finds where each baseline entry sits now, after the peer's insert;
  2. align `before` → `after` the same way, which gives the local edit script (keep / replace / insert /
     delete).
- Apply the edit script to the matched current keys:
  - a replaced entry writes to the key its *before*-value matched;
  - an insert lands after the matched key of its left neighbour;
  - a delete removes the matched key.
- An entry whose before-value can't be matched uniquely (duplicate vertices, or edited by both sides) falls
  back to today's behaviour: replace the whole parent slot. That degrades to last-writer-wins but never
  retargets a vertex.
- Same change in `keySlots` for `updateNodeFromSlots`'s positional pool, so both write paths agree.
- **Tests:**
  - unit: the audit's example (`[50,50] [60,50] [60,60] [50,60]`, peer inserts `[55,50]`, local moves
    `[60,60]`→`[62,62]`) plus duplicate-vertex and delete-vs-move tables;
  - e2e: SYNC-01.

**SYNC-03: a native baseline for library definitions.**
- The binding keeps `nativeLibDefs: Map<libId, def>`. It's filled at seed from the snapshot's definitions,
  updated whenever a payload carrying definitions is handed to the editor (`deltaToItemsWire(…, libDefs)`
  folds the definitions it rendered), and updated by every local emit.
- In the DOWN path, write a definition only if it differs from `nativeLibDefs[id]`, i.e. the user changed it
  locally. This is the same rule `syncLayoutToY` already uses with `baseDefs`.
- The sheet manager's off-sheet path gets the same guard through WP2's per-sheet baseline.
- **Tests:** unit (stale packet vs newer definition); e2e: SYNC-03.

**SYNC-06b (and layer repro case 3): three-way merge per field inside a header section.**
- For each section the writer changed relative to its baseline, write `merge3(base, mine = file,
  theirs = current Y)`, not `mine`:
  - a sub-slot comes from `mine` only where `mine` differs from `base`;
  - sub-slots are matched with the v2 identity rules (`identityIds`), plus **header-only** rules: a repeated
    kind keyed by a numeric first atom where that number *is* the identity (`title_block (comment N …)`) and
    layer-table entries by their ordinal head;
  - deletes in `mine` apply; entries only `theirs` added survive;
  - order follows `mine`, with keys only `theirs` has kept in place.
- Storage stays a plain `Slot[]` per section, so no s-expr version bump and no migration.
- Covers title vs revision, setup scalar vs stackup, and two different layer renames. Two writes to the same
  field at the same instant stay last-writer-wins.
- **Tests:**
  - unit: `merge3` tables plus `layers-drift.repro.test.ts` case 3 flipped to assert the fix;
  - e2e: SYNC-06b.

### WP2 — eeschema sheet manager and dirty tracking (SYNC-02, SYNC-07)

**SYNC-02: a native baseline per parked sheet.**
- When a sheet parks, keep its binding's `nativeView` (and `nativeLibDefs`) in the room record instead of
  dropping it. Remote updates to a parked sheet don't touch its native screen, so that baseline stays true.
- `doWriteOffSheet` then converts with `itemsWireToDelta(wire, view, …, { baseline: parkedNativeView })`,
  the same call the active binding makes. It writes only baseline-relative changes, then folds what it
  wrote into the parked baseline.
- A sheet that was never bound (no baseline) keeps today's rule: skip if unseeded, otherwise diff against the
  doc. That case can't have a stale peer edit, because the native screen was loaded from the room.
- On activation, the existing diff-on-rebind adopt (opt 13) brings the native screen up to date and replaces
  the parked baseline.
- **Tests:** a sheet-manager unit test (park → remote move → off-sheet field edit keeps the move); e2e: SYNC-02.

**SYNC-07: dirty tracking keyed by `(screen, uuid)`.**
- In `eeschema_embind.cpp`, change `g_dirty` to `std::set<std::pair<SCH_SCREEN*, std::string>>` (or a map
  keyed by that pair). `noteDirty` inserts the pair, and the flush loop (~l.818) emits one entry per pair
  into that screen's room.
- The stale-screen pruning (~l.619) filters by screen as it does today.
- **Tests:** e2e SYNC-07. Also check that one screen's dirty uuid never emits into another screen's room.

### WP3 — Native object coverage (SYNC-04, SYNC-05)

C++ in the bindings only (no KiCad fork change), one WASM rebuild.

**SYNC-05: cover every root collection the file writer writes.**
- Add `board->Points()`, `board->Generators()` and `board->Groups()` to `pcbCollabSnapshotItems`.
- Add `Points()` and `Generators()` to `forEachTopItem`, which feeds the diff baseline and dirty flush.
- Extend `makeFromBlob`'s extraction with `clip->Points()` and `clip->Generators()`. Check the order:
  generators before groups, because `PCB_GENERATOR` is a `PCB_GROUP`.
- `itemToJson` needs nothing new: position + layer is enough for change detection, and dirty roots emit
  their blob anyway.
- Add a static guard test that compares the collections the board writer visits with the ones the snapshot
  visits, so a future KiCad collection can't be silently missed.
- Do the same inventory for eeschema: `SCH_SCREEN` item types vs the eeschema snapshot. The audit only
  covered PCB for this finding.

**SYNC-04 (and generators, which are groups): relink group members after apply.**
- **Adopt:** before parsing, read the group's `(members "uuid" …)` list from the blob (a small s-expr scan in
  C++, or a `members` field the JS side attaches when it renders the wire). After `commit.Add(group)`,
  resolve each uuid on the **live** board and `group->AddItem(member)`, inside the same commit with
  `commit.Modify(group)`.
- **Member replacement:** in the upsert, remember `existing->GetParentGroup()` before
  `commit.Remove(existing)`. After `commit.Add(parsed)`, `group->AddItem(parsed)`.
- **Ordering inside a batch:** a group can arrive before its members. So run one **relink pass at the end of
  `doApplyItems`**: for every group touched in this batch, and every group whose declared member list
  contains a uuid touched in this batch, add any live member it's missing. The declared lists come from a
  small `groupUuid → member uuids` cache, filled from every group blob applied or emitted.
- eeschema: the same three steps in its `doApplyItems` (SCH groups).
- **Tests:** e2e SYNC-04 ×4 and SYNC-05 ×5. Also a generator (tuning pattern) round trip that edits a member
  track.

### WP4 — Live header sync (SYNC-06a, layer drift, G1, G2)

This is the earlier draft, unchanged in substance. It depends on WP1's `merge3`.

**Part A: emit header changes as they happen.**
- **Triggers:** all three only set a flag. The real check serializes the header alone and compares it with
  the last emitted text.
  1. **Board Setup OK.** It runs `SynchronizeNetsAndNetClasses(true)`, which fires
     `BOARD_LISTENER::OnBoardNetSettingsChanged` (`board.cpp:2750`). Override that in `COLLAB_LISTENER`.
  2. **Any modal or quasi-modal dialog closing.** A new notification in the **wx-wasm layer**, so neither
     wx core nor KiCad changes. This catches Page Settings (paper, title block), which fires no listener
     and whose `OnModify` has no hook.
  3. **Backstop:** the existing drift check (every 50 Y updates, and at unload) also compares the header
     text. This is event-driven, with no timer.
- **Serialize:** `WIRE_BOARD_IO::FormatHeaderOnly(board)` emits version, generator, paper, title block, then
  the protected `formatHeader` (general, layers, setup, properties, variants), and **`(embedded_files …)`**
  (S2 below).
- **Wire:** a separate `kicadCollab.onHeader(text)` callback. The item wire schema stays untouched, and old
  peers ignore the new callback.
- **JS:** the binding owns the layout baseline (moved from `WasmTool.tsx`'s `layoutBaselineRef`, which the
  save path then shares). It runs `syncLayoutToY(fileToDoc(text), doc, ORIGIN_HEADER, baseline)` with WP1's
  `merge3`.
- **G2:** when the header-dirty flag is set, mark every root dirty once. Zones that silently lost a layer
  then re-emit; the upsert is idempotent, so unchanged items cost one no-op echo each.

**Part B: apply header changes on peers.**
- **JS:** `onLayout` for a remote transaction that touched a non-item section renders the header slice and
  skips it if it matches what this editor last applied or emitted. Otherwise it calls
  `mod.kicadCollabApplyHeader(text)` through the apply queue, coalescing to the latest change.
- **C++ `kicadCollabApplyHeader`,** on the apply coroutine with `s_applyingRemote` set:
  1. Parse the text into a temporary `BOARD`.
  2. Copy onto the live board:
     - enabled layers, layer names and layer types;
     - the board-file part of `BOARD_DESIGN_SETTINGS`: stackup, thickness, mask/paste, origins, tenting,
       plot params;
     - page settings, title block, properties, variants, embedded files.
     - Never touch the parts that live in the project file.
  3. Refresh as `ShowBoardSetupDialog` does after OK: visible layers, appearance panel, layer box,
     `UpdateAllItems`.
  4. Rebaseline. No undo entry.
- **Guards:**
  - Defer while the local Board Setup dialog is open (`m_boardSetupDlg`).
  - Respect `kicadCollabBusy`.
  - Never delete items for a removed layer; the author's deletes arrive as normal item removals.
- **G1:** goes away once headers apply live. As a cheap safety net, `wrapInBoardEnvelope` can list every
  layer the item uses, not only the enabled ones.

**Tests:**
- e2e: SYNC-06a.
- New layer scenarios using a `kicadCollabTestAuditLayers` hook, which goes through the real Board Setup
  trigger:
  1. 2→4 layers shows up on the peer;
  2. a track on In1.Cu is visible on the peer;
  3. 4→2 removes the track, and a multi-layer zone keeps F.Cu only (G2);
  4. the apply is deferred while the peer's Board Setup is open (real dialog);
  5. two stale renames both survive (WP1).
- Unit: `layers-drift.repro.test.ts` cases 1, 2 and 4 flipped to assert the fix.

### WP7 — Undo (SYNC-08)

Two separate problems:

**(a) The missing outbound packet: isolate first, then fix.** Reading the code doesn't explain it:
`PutDataInPreviousState` ends in `OnItemsCompositeUpdate`, and `COLLAB_LISTENER` marks those items dirty.
Candidates to check with temporary logging on the audit scenario:
1. the undo picker was re-anchored to the object a remote apply replaced, and the listener reports the
   *stale* pointer, whose uuid lookup or `STRUCT_DELETED` flag makes the flush skip it (compare
   `deletedDirtyRoots`, `flushDiff` ~l.845);
2. `s_applyingRemote` is still set when undo runs, because the undo executed inside or right after an apply
   coroutine;
3. the flush emits, but the binding's DOWN path drops it: the emitted body equals `nativeView` because the
   remote payload was folded before native applied it.

The fix depends on which one it is. It's expected to be small, in the binding.

**(b) Whole-item undo overwrites a peer's field: NOT in this plan (decision 1).** Whole-item undo stays as
accepted in doc 20. Once (a) is fixed, the undo at least emits, so the doc and peers converge on the
undone image instead of diverging. The peer's field is still lost, but visibly and consistently. The design
below is kept for reference if this is revisited:
- The binding keeps a local **op log**: for each local emit, the root's `(before, after)` bodies, keyed by
  the native undo depth at that time. The depth can be read without a fork change through the
  `testUndoDepth` accessor pattern already in `collab_common.h`.
- When a flush sees the undo depth *drop*, the emitted roots are an undo. The binding doesn't write the
  native full image. It computes the **inverse of the logged op**, i.e. `patchNodeFromSlots(current,
  before = op.after, after = op.before)`, applies that to the doc, then sends the merged result back to
  the editor so the native board takes back the peer's field.
- Redo is the same with the op applied forward.
- **Tests:** e2e SYNC-08; unit tests for the op-log inverse, including a peer deleting the item before the
  undo (the undo becomes a no-op, which matches doc 20's dropped-picker rule).

SYNC-08's audit assertion (the peer's Value survives) therefore **stays failing** after WP7. The recreated
scenario lands with an adjusted assertion: after undo, local native == doc == peer native. The
field-preservation check becomes a documented known limitation, not a failing spec.

---

## 4. Everywhere a user has to save before a change syncs

This list comes from reading every save chokepoint (`kicadCollabOnSave` in `pcbnew/files.cpp`,
`eeschema/files-io.cpp`, `pagelayout_editor/files.cpp`), the save hook (`web/standalone/src/wasm/save-flow.ts`),
the layout save-sync, files-watch and sibling-restage.

| # | What | Why it waits for a save today | Where |
|---|---|---|---|
| **S1** | pcbnew header sections: `general`, `paper`, `title_block`, `layers`, `setup`, `property`, `variants` | Not items, so they're piggybacked on save (miss 08B). Never applied to open peers. | `WasmTool.tsx` `onSavedText` → `syncLayoutToY` |
| **S2** | pcbnew root `(embedded_files …)`: embedded fonts, models, datasheets at board level | A root layout section like S1. Footprint-level embedded files travel inside the footprint and *are* live. | `pcb_io_kicad_sexpr.cpp:878` |
| **S3** | eeschema root sections: `paper`, `title_block`, `bus_alias`, `sheet_instances` (page numbers), `embedded_fonts`, `embedded_files` | Same as S1, per sheet. | `sheet-manager.ts` `syncLayoutFromSave` |
| **S4** | pl_editor `(setup …)` of a `.kicad_wks`: margins, default text size and line width | Same as S1. | `WasmTool.tsx` single-room path |
| **S5** | `.kicad_pro`: netclasses and patterns, text variables, DRC severities and exclusions, ERC settings, bus aliases, schematic defaults | Not a room doc: rooms exist only for `.kicad_pcb` / `.kicad_sch` / `.kicad_wks` (`COLLAB_DOC_EXT`, `packages/core/src/services/collab.ts:19`). Uploaded (CAS PUT) only when a board or root sheet is saved. Peers restage it to MEMFS, but an **open editor never reloads it**. | `files.cpp:1121`, `files-io.cpp:1097`, `files-watch.ts` |
| **S5a** | **⚠ Stale `.kicad_pro` overwrite** (data loss; code reading, not run) | Files-watch restages a peer's `.kicad_pro` through `fetchFileBytes`, which records the **peer's revision as the CAS base** (`lib/project-source.ts:224`), while the native project still holds the old settings. This tab's next save passes CAS and **silently overwrites the peer's settings**. Both tools write the whole file. | `files-watch.ts` → `fetchFileBytes` |
| **S6** | **⚠ `.kicad_dru` custom rules never persist** (data loss; code reading, not run) | The Custom Rules panel writes the file to MEMFS on OK. **No path** routes it through `kicadCollabOnSave`; `SavePcbFile` routes only `.kicad_pcb` and `.kicad_pro`. Lost on reload, never reaches peers. | `panel_setup_rules.cpp` `SaveFile`, `files.cpp` save tail |
| **S7** | A new subsheet file ("Add Sheet") | The `(sheet …)` item is live, but the child `.kicad_sch` and its room exist only after the author's first save (`onSaved` → `sheetManager.onboard`). A peer navigating in finds nothing to load. | `WasmTool.tsx` `onSaved`, `sibling-restage.ts` accepted v1 gap |
| **S8** | A custom drawing sheet (`.kicad_wks`) used by an open board or schematic | pl_editor edits reach the `.kicad_wks` room live, but pcbnew/eeschema read the drawing sheet once at open (`PCB_EDIT_FRAME::LoadDrawingSheet`). Sibling-restage watches schematics only. | `pcbnew_config.cpp:44`, `sibling-restage.ts` |
| **S9** | Library editors (`.kicad_sym` / `.kicad_mod`) | By design: a KiCad library edit is an explicit save. Peers are invalidated on save (libs 0019). | lib save path |
| **S10** | Root `(net N …)` table | Frozen on purpose, not even synced on save. KiCad 10 no longer writes it (nets are by name on items). | `kicad-y.ts` `FROZEN` |
| **S11** | `.kicad_prl`, project `fp-lib-table` / `sym-lib-table`, plot/export outputs | `.kicad_prl` is per-user view state. The lib tables are managed by pcbjam's library system. Outputs are artifacts, not documents. | — |

---

## 5. Fixes for the save-only points

### WP-0 — Data-loss bugs first (S5a, S6) + audit harness

These are small, and they lose data today, so they go first. Each gets a repro before its fix.

**S5a: a restage must not move the CAS base.**
- Files-watch restages a file the *native model doesn't adopt* (it only writes MEMFS). So it must record the
  **observed** revision only, never the **base**. Give `fetchFileBytes` a `{ adoptAsBase: false }` option
  (or add a separate `fetchSiblingBytes`) for the restage path.
- The stale tab's next save then hits the existing save-blocked conflict instead of overwriting.
- After WP5, `.kicad_pro` and `.kicad_dru` are room-backed and never restaged from the row. This fix still matters for every other restaged file.
- **Repro:** unit test on `project-source` + files-watch (restage, then save → expect a conflict, not a
  silent 200).

**S6: persist custom rules (stopgap until WP5 gives `.kicad_dru` a room).**
- **Emit:** a JS **project-sidecar sweep**. At staging time, hash the project's sidecar files in MEMFS
  (`.kicad_pro`, `.kicad_dru`). On every save-hook call, and on WP4's dialog-close trigger, rehash and upload
  any that changed through the normal CAS save path. No fork change.
- This covers every sidecar KiCad writes outside the three save chokepoints, not only `.kicad_dru`. After
  WP5 the sweep feeds the file rooms instead of the CAS PUT, and it stays the upload path for any sidecar
  without a room.
- **Apply on peers:** after files-watch restages a `.kicad_dru`, call a new `kicadReloadDesignRules()` in
  pcbnew, which runs `m_DRCEngine->InitEngine(GetDesignRulesPath())`. WP5 reuses this function.
- **Why a stopgap and not the room right away:** it's a one-day fix for a bug that loses data today. WP5
  needs the codec layer first.
- **Repro:** an e2e scenario (edit Custom Rules → reload → rules still there).

**Harness:** also recreate the audit report, driver, bundle script and `control` scenario (section 2).

### S1, S2, S4 → WP4

- **S1** is WP4 itself.
- **S2** is included in WP4's header slice and apply (`BOARD::GetEmbeddedFiles`). Embedded files are keyed
  by name, so WP1's `merge3` merges per file.
- **S4 (pl_editor)** reuses the same pattern with its own serializer (`DS_DATA_MODEL` setup) and
  `kicadCollabApplyHeader`. Its trigger is simpler: pl_editor's setup is only edited in a dialog, so the
  dialog-close trigger alone is enough.

### WP5 — Project settings as file rooms (S5, and S6 properly)

**Why a room and not an endpoint.** The first draft proposed a JSON three-way merge before a CAS PUT, with
peers picking the change up through files-watch. Review asked why that shouldn't go "live" over the
websocket instead. It should:

- **Whole-file writes don't force an endpoint.** KiCad writes `.kicad_pro` as a whole file either way, but
  so does the board writer, and the board already goes through rooms. The pattern is the same: the native
  side produces a full file, the client diffs it against its baseline, and only the changed keys go into Y.
- **A room merges for free.** A Y.Map tree per JSON object merges concurrent edits per key, so no
  hand-written `merge3` for JSON, no CAS conflict path and no refetch-and-retry.
- **It's live.** Peers get the change over the room's existing websocket, instead of a files-watch hint
  followed by a GET.
- **S5a disappears for these files.** A room-backed path is never restaged from the CAS row
  (files-watch already skips room-backed paths), so the stale-base overwrite can't happen for them. The WP-0
  fix stays for files that keep the plain path.

The only reason for the endpoint was reuse. The room stack is s-expr-only today (`COLLAB_DOC_EXT`,
`fileToDoc` / `docToFile` / `yToDoc` at every materialize point), so a room for JSON needs a codec layer.
That's the real cost, and it's contained.

**Design.**
1. **Codec per extension (shared).** A `docCodecFor(path)` in `pcbjam-shared` returns
   `{ fileToY, yToFile, patchYFromFile(ydoc, baseline, file) }` for three kinds:
   - `kicad-sexpr`: the existing converters, unchanged;
   - `json`: `.kicad_pro`, and `.kicad_jobset` later. Objects become nested Y.Maps and arrays become
     Y.Arrays of values. Arrays of named objects (netclasses, net-class patterns, severities) become Y.Maps
     keyed by `name`, so concurrent edits of different netclasses merge. `yToFile` pretty-prints with
     KiCad's key order (2-space JSON as `JSON_SETTINGS` writes it), so the room form round-trips byte-equal
     with a native save;
   - `text`: `.kicad_dru`, as a Y.Text. `patchYFromFile` applies a line diff against the baseline, so two
     people editing different rules merge.
2. **Server: one predicate becomes a codec lookup.** Replace `isCollabDoc` / `COLLAB_DOC_EXT` with the codec
   lookup at the materialize points:
   - `packages/core/src/services/collab.ts` (materialize, export bytes);
   - `git/room-hash.ts` and `git/change-facts/item-diff.ts`: JSON and text get a whole-file diff, not the
     item diff;
   - `tools/run-interactive.ts` and `tools/run-tools-job.ts`;
   - the client's ydoc fetch in `lib/project-source.ts`.

   Comments stay s-expr-only (`isCommentCapableDoc` keeps its current predicate), and drift detection
   stays pcbnew/eeschema/pl_editor-only. Listings, file ops, soft delete and working copies already key off
   `isCollabDoc`, so they follow the new predicate automatically. Each call site gets checked.
3. **Client: a sidecar room binding.** For each project sidecar with a codec, the editor session joins its
   room: passive, the same pattern sibling-restage uses.
   - **Local → room:** the WP-0 sidecar sweep, triggered by save, a setup dialog closing, or the WP4
     backstop, calls `patchYFromFile(doc, baseline, memfsBytes)`, then advances the baseline.
   - **Room → local:** a remote update materializes with `yToFile`, writes MEMFS, and calls the native
     reload:
     - `kicadReloadProjectSettings()` (pcbnew and eeschema):
       1. re-read `PROJECT_FILE` (`JSON_SETTINGS::LoadFromFile`);
       2. pcbnew: `LoadProjectSettings()` + `SynchronizeNetsAndNetClasses(true)` + DRC engine init;
       3. eeschema: ERC settings, netclasses, connection-graph recalculation;
     - `kicadReloadDesignRules()` (from WP-0) for `.kicad_dru`.
   - Only after the reload does the materialized file become the new baseline.
   - Per decision 2, the apply runs live even during a DRC run. Only an open Board Setup / Schematic Setup
     dialog defers it, because otherwise that dialog would commit stale settings on OK.
4. **Seeding and migration.** A sidecar with no ydoc is seeded from its file row on first join. This is
   the same seed-nonce arbitration the s-expr rooms use, generalized to go through the codec. No bulk
   migration: rooms appear as projects get opened.
5. **Both tools share one room.** pcbnew and eeschema both write the whole `.kicad_pro`. Through the room,
   each tool's write only patches the keys it changed against its own baseline, so an eeschema ERC change
   and a pcbnew netclass change no longer overwrite each other.

**Tests:**
- shared unit:
  - codec round trips (a real `.kicad_pro` from the QA data is byte-equal after file → Y → file);
  - JSON per-key merge tables (netclass added on A while B changes a severity);
  - text line merges for `.kicad_dru`;
- server unit: materialize / export / git hash per codec;
- e2e:
  - A adds a netclass in Board Setup; B's open pcbnew shows it without a reload;
  - B's later save keeps it;
  - an eeschema ERC-setting change and a pcbnew netclass change made at the same time both survive;
  - custom rules survive a reload and reach the peer's DRC.

**Risk to watch:** `JSON_SETTINGS` has migrations and defaults. A `.kicad_pro` written by an older KiCad
may be rewritten with extra keys on first native save. That shows up as one large first patch, which is
fine; add a test that the patch converges and doesn't ping-pong between two tabs.

### WP4 extension — eeschema root sections (S3)

- Same Part A/B pattern per sheet. The sheet manager routes the header slice for the **active** sheet; a
  **parked** sheet uses its WP2 baseline and applies on activation.
- **Triggers:** the eeschema equivalents are Page Settings / Schematic Setup dialog close (the WP4 wx-wasm
  hook) plus the drift backstop.
- `sheet_instances` page numbers change through the Edit Page Number dialog, which is covered by dialog
  close.

### WP6 — New subsheets and drawing sheets (S7, S8)

**S7: seed a new subsheet's room when its sheet item is committed, not on save.**
- When the eeschema dirty flush sees a `SCH_SCREEN` whose file path has no room yet, serialize that screen
  read-only (the pattern of the audit's `kicadCollabTestAuditSheetItems`, promoted to a real export) and call
  `sheetManager.onboard(path, text)`.
- `onboard` seeds the room and registers the file (one upload, so the files listing has the row).
- Peers already discover it through presence and files-watch.

**S8: reload the drawing sheet in open editors.**
- Sibling-restage (or files-watch for a non-room `.kicad_wks`) also watches the project's drawing-sheet
  path.
- After a restage, call a new `kicadReloadDrawingSheet()`, which runs `LoadDrawingSheet()` plus a canvas
  refresh.

### Kept as they are (S9, S10, S11)

- **S9 (library editors):** stays explicit-save by design. Live library co-editing would be a product
  decision, not a sync fix.
- **S10:** nothing to do on KiCad 10.
- **S11:** out of scope.

---

## 6. Order, cost, rollout

| WP | Contents | Size | Needs |
|---|---|---|---|
| **WP-0** | S5a restage/CAS fix, S6 sidecar sweep + rules reload, audit harness + report + `control` | ~1 day | TS; small embind addition (rules reload) → rebuild |
| **WP1** | SYNC-01 value-anchored patch, SYNC-03 lib-def baseline, SYNC-06b / case 3 `merge3` | ~2 days | shared TS + binding; audit hooks (polygon, settings, library) → rebuild |
| **WP2** | SYNC-02 parked-sheet baseline, SYNC-07 `(screen, uuid)` dirty set | ~1–1.5 days | TS sheet manager + eeschema embind → rebuild |
| **WP3** | SYNC-05 collections, SYNC-04 group relink (PCB + SCH), generators | ~2 days | pcbnew + eeschema embind → rebuild |
| **WP4** | Live header sync Parts A/B, G1/G2, S1 + S2 + S4; then S3 | ~2–3 days + ~1–2 days for S3 | embind + small wx-wasm dialog-close hook + TS → rebuild |
| **WP5** | Sidecar file rooms: codec layer, JSON room for `.kicad_pro`, text room for `.kicad_dru`, native reloads (S5, S6) | ~3–4 days | shared codec + server materialize points + client binding + embind reloads → rebuild |
| **WP6** | New subsheet seeding (S7), drawing-sheet reload (S8) | ~1.5 days | eeschema embind + sheet manager → rebuild |
| **WP7** | SYNC-08: isolate and fix the missing undo packet; whole-item undo stays (decision 1) | ~1 day | TS binding and/or embind → rebuild |

- **Order:** WP-0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7.
  - WP1 goes before WP4 and WP5 because both write through its merges.
  - WP7 goes last because it changes undo.
- **Each WP is its own commit series** and lands its audit scenarios with its fix (section 2), so staging CI
  stays green throughout.
- **Every rebuild** reuses the warm build volume (`COMPOSE_PROJECT_NAME=kicad-wasm-staging`).
- **Wire compatibility:** no wire version bump anywhere.
  - New callbacks (`onHeader`) and new embind functions are ignored by old clients.
  - Storage formats don't change (`Slot[]` sections stay; `merge3` only changes what gets written).
  - Old peers keep today's behaviour and converge on reload.
- **Regression gates per WP:**
  - the full `tests/kicad` collab/ysync set on both engines;
  - `collab-undo.spec.ts` for WP7;
  - the drift-trio harness for WP1 and WP3.

## 7. Reviewer decisions (round 1, 2026-09-30)

1. **Undo:** whole-item undo is acceptable for now. WP7 only fixes the missing packet (SYNC-08a); the
   field-level op-log undo is not built.
2. **Project settings apply live**, including during a running DRC. Rare races are left to the users.
   Only an open setup dialog defers an apply.
3. **Library editors stay explicit-save** (S9).
4. **The audit branch is handed over.** Only we work on it from now on. It stays a frozen reference;
   pieces are recreated on staging (section 2), and new scenarios are added on staging directly.
5. **WP5 uses file rooms, not a CAS endpoint** (round-1 question). See WP5 "Why a room and not an endpoint".

## 8. Implementation record (2026-09-30)

Built on staging, recreated from the audit branch (never merged). Verification: the recreated audit spec
`tests/kicad/ysync-audit-2026-09-29.spec.ts` (all 17 audit scenarios plus the proposal-21 WP4/WP5 scenarios,
green on chromium) and the collab/ysync/drift-trio regression set; unit tests in `pcbjam-shared`,
`web/standalone`, `packages/core`, `apps/sync`, `apps/server`.

| WP | Built | Where |
|---|---|---|
| WP-0 | S5a: restage fetches with `adoptAsBase: false` (observed revision only). S6: sidecar sweep (`sidecar-sweep.ts`), `kicadReloadDesignRules`. Audit report, driver, bundle script, spec. | `lib/project-source.ts`, `pages/ToolPage.tsx`, `WasmTool.tsx`, `pcbnew_embind.cpp`, `tests/collab`, `tests/kicad` |
| WP1 | SYNC-01 value-anchored positional keys (`anchorPositionalKeys`). SYNC-03 `nativeLibDefs` baseline (binding + parked sheets). SYNC-06b / case 3 `merge3Slots` in `syncLayoutToY`. | `kicad-y2.ts`, `kicad-binding.ts`, `layout-merge.ts`, `kicad-y.ts` |
| WP2 | SYNC-02 `parkedBaseline` per parked sheet. SYNC-07 dirty set keyed by `(uuid, screen)`. | `sheet-manager.ts`, `eeschema_embind.cpp` |
| WP3 | SYNC-05 points / generators / groups in snapshot, `forEachTopItem`, `makeFromBlob`. SYNC-04 group relink (declared members + rejoin) in pcbnew and eeschema. | `pcbnew_embind.cpp`, `eeschema_embind.cpp`, `collab_common.h` |
| WP4 | Live board header (Parts A/B) with G2 zone re-emit; eeschema sheet header (S3); S2 not yet (see open items). | `header-sync.ts`, `index.ts`, `sheet-manager.ts`, both embinds, fork `OnModify` hooks |
| WP5 | Sidecar rooms: `sidecar-doc.ts` codec (lossless JSON, per-key / per-name merge; text with context-anchored patch). Server: `isKdoc` / `isCollabDoc` split, codec materialize + export, sidecar room hash, rewrites, upload install into an existing room, codec-aware `/room/replace`. Client: `sidecar-rooms.ts`, save policy, staging conversion. Native: project fingerprint check → `SaveProject` → save hook; `kicad{Pcb,Sch}ReloadProjectSettings`. | shared, `packages/core`, `apps/sync`, `apps/runner`, `apps/server`, standalone, both embinds |
| WP6 | S7 new-subsheet onboarding from the flush (local commits only, file must not exist). S8 drawing-sheet mirror + `kicad{Pcb,Sch}ReloadDrawingSheet`; pl_editor joins project presence. | `eeschema_embind.cpp`, `sibling-restage.ts`, `WasmTool.tsx` |
| WP7 | SYNC-08 root cause found and fixed (below). | `pcbnew_embind.cpp` |

**Deviations from the design, and why:**
- **WP4 trigger.** Not a wx-wasm dialog-close hook: a 13-line fork hook in `PCB_EDIT_FRAME::OnModify` and
  `SCH_EDIT_FRAME::OnModify` (weak symbol, the same pattern as the existing save hooks). It catches every
  header editor, including the origin tools the dialog hook would have missed, and needs no wx change. The
  flush compares a header-only serialization, so an ordinary commit costs one small string compare.
- **WP4 apply-time resolution (new).** The e2e run showed a peer's local header edit being overwritten by a
  queued remote apply before it was emitted. Header applies now flush pending local header changes first and
  then ask JS (`kicadCollab.resolveHeader`) for the room's latest header, like item applies already do.
- **S3 apply payload.** The schematic parser only accepts `paper` / `title_block` in a full-file parse, so JS
  decodes them (`decodeSchHeader`) and the native side calls the setters.
- **Header dialog guard.** By RTTI class name: the dialog headers pull generated `*_base.h` files the
  bindings' include path doesn't carry.
- **SYNC-08 root cause.** A use-after-free, not a lost listener event: a remote item apply replaced the
  footprint object and freed the old one, which the local undo entry still pointed at, so undo restored into
  freed memory and nothing coherent was emitted. pcbnew now updates an existing root IN PLACE with
  `SwapItemData` (the sequence `BOARD_COMMIT::Revert` uses: out of view and connectivity, swap, back in), so
  undo entries stay valid and undo emits. Groups and generators keep replace + relink (a swap would move
  their member sets). The audit's SYNC-08 check is adjusted per decision 1: converge, whole-item undo.
- **WP5 change detection.** `FormatAsString()` on the project file leaves out the nested settings (net
  classes, design rules, ERC); the fingerprint adds every nested settings object of the editor.
- **WP5 first write.** A sidecar room is created by the first save into it (not at open), and saves of a
  room-backed sidecar go only into the room while its binding is connected; otherwise the upload path is
  unchanged.

**Open items:**
- **Same-instant header writes.** Two peers writing the same header section in the same instant, each
  without having seen the other, stay last-writer-wins per section (the layout repair keeps one copy). Stale
  writers merge per field. Fix: header sections as per-field Y structures ("Later").
- **eeschema remote apply still replaces objects.** Its undo re-anchor reads the uuid through a possibly-freed
  pointer, the same hazard SYNC-08 fixed in pcbnew. Follow-up: the same in-place update in eeschema.
- **S2** (board-level `embedded_files`) is not in the live header slice yet; still synced on save.
- **Text sidecar first seed.** Two tabs whose FIRST save into an empty `.kicad_dru` room lands in the same
  instant duplicate the text (JSON seeds are per-key LWW and safe).
- **Activity attribution** for sidecar edits (`apps/sync/src/activity-tracker.ts` observes kdoc roots only).
- **Firefox** was not part of the audit's original run; the recreated spec runs in both kicad CI projects.
