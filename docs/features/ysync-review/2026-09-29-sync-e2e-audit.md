# KiCad ↔ Yjs sync audit — 2026-09-29

## Scope and revision

This audit follows data through KiCad's native in-memory objects, the item wire bridge, the production TypeScript/Yjs binding, a second browser, and native KiCad file serialization. It also examines the multi-room schematic sheet manager and file-level settings. No sync fixes are included. Changes are limited to this report, the browser reproduction suite, its driver, and native test hooks beside the existing collaboration test hooks.

The checkout is a sibling worktree, `../pcbjam-sync-e2e`, on `codex/sync-e2e-audit`, based on staging:

| Repository | Revision |
| --- | --- |
| private superproject | `39849c9325a82f58675515517ae66f728eee9a54` |
| pcbjam | `b7039994df3f31b5e98fc0b6b990af4812c9513f` |
| KiCad | `c0bfce04a371ce272a774a744619fd0345c558dd` |
| shared submodule | `49ba8b4da943707ca2ad510bc29e146a997555e1` |
| wxWidgets | `8bad5f58e9b51050d3678f5c98cb0dc41b4595b2` |

All submodules are checked out at staging's pinned revisions, not independently advanced to their remote branch tips.

## Reproduction approach

`tests/kicad/ysync-audit-2026-09-29.spec.ts` asserts the desired behavior with ordinary assertions. Defects are deliberately **not** marked `test.fail`, skipped, or converted into passing tests. A timeout while loading a fixture is a setup failure, not confirmation of an issue. The control must pass before interpreting failed invariants.

The driver bundles the actual shared converters, `attachKicadCollab`, `connectKicadDoc`, and `createSheetCollabManager`. Real BroadcastChannel transports updates between browser pages. It does not replace the sync algorithm with a model or simulation. For race cases, the driver holds real native commit packets and calls to native apply at the asynchronous boundary, then releases the local packet before native remote apply. This makes a permitted deferred-apply ordering deterministic.

Native test hooks make polygon vertex edits, page/title edits, a symbol library edit, and one `SCH_COMMIT` spanning explicitly named child screens. An additional read-only hook serializes parked native screens without rebaselining the differ. The hooks do not change snapshot, diff, apply, merge, or sheet-manager behavior.

Each scenario attaches `sync-audit-evidence.json` with the shared document, native serialization, emitted and queued packets, and sheet events. The snapshot cases attach the native bridge result as well. Playwright retains a trace and screenshot on failures.

## Findings

### SYNC-01 — concurrent edits can retarget polygon vertices (high)

**Trigger:** a peer inserts a vertex before another vertex while the local editor, still holding the old native shape, moves that later vertex. The queued local packet is emitted after the insertion has reached Yjs, before the insertion reaches local native memory.

**Expected:** retain the peer insertion and move the originally selected vertex.

**Mechanism:** `keySlots` and `patchNodeFromSlots` in `web/pcbjam-shared/src/kicad-y2.ts` match repeated `xy` fields by occurrence. The baseline-relative update is then applied to the current node using those positional identities. A structural insertion changes which occurrence denotes the original point. Tuple atomicity protects coordinates within a point, not the identity of points in the sequence.

**Minimal example:** native polygon `[50,50], [60,50], [60,60], [50,60]`; peer inserts `[55,50]`; local moves `[60,60]` to `[62,62]`. The required merged result is `[50,50], [55,50], [60,50], [62,62], [50,60]`.

**Coverage:** browser test `SYNC-01`. The earlier in-memory production-converter probe already reproduced a wrong-vertex change. Other repeated unkeyed fields need separate coverage; this test does not establish that every repeated field is affected.

### SYNC-02 — a global edit can overwrite peer changes on a parked sheet (high)

**Trigger:** the active view is the root schematic. A peer moves a symbol on a child sheet. The parked child's Y.Doc receives the move, while its native `SCH_SCREEN` retains the old position. A global operation then changes another field on that parked symbol.

**Expected:** sync only the global operation's field change, preserving the peer's position.

**Mechanism:** `createSheetCollabManager` deliberately defers native updates for parked sheets. `doWriteOffSheet` in `web/standalone/src/wasm/collab/sheet-manager.ts` converts the whole stale native fragment against the latest document without the `nativeView` baseline used by an active binding. The unchanged stale position becomes an apparent local change.

**Coverage:** browser test `SYNC-02` navigates actual hierarchical sheets, parks the child, moves it from another editor, and commits a field edit on the parked screen. The preliminary binding-level probe reproduced position rollback.

### SYNC-03 — stale item packets can overwrite newer library definitions (high)

**Trigger:** a pending local symbol move includes the old `lib_symbols` prelude. A newer library definition reaches Yjs but its native refresh is queued. The local packet is flushed first.

**Expected:** keep the newer definition and apply only the local move.

**Mechanism:** the active binding has baseline-relative item merging, but its DOWN path calls `wireLibSymbols` and `upsertLibSymbolsToY` for incoming native preludes. `upsertLibSymbolsToY` in `web/pcbjam-shared/src/kicad-y.ts` unconditionally upserts the supplied definition. The item baseline does not establish that the definition was locally edited.

**Coverage:** browser test `SYNC-03`, with an actual symbol library description edit and native move. The earlier binding-level probe showed NEW reverting to OLD after flushing a stale local packet.

### SYNC-04 — per-item native apply loses group relationships (high)

There are two paths to check in both PCB and schematic editors:

1. A group fragment is parsed in a temporary board/screen containing no member items. KiCad's parser resolves its UUID list against that temporary container. Moving the parsed group to the real board/screen does not relink those references.
2. Updating a member removes/replaces its native object. Removing the old object can detach it from its parent group; the replacement is not relinked by the existing per-item bridge.

**Expected:** group UUID, membership, and native parent relationships survive remote adoption and member edits.

**Source:** `makeFromBlob`/`doApplyItems` in `wasm/bindings/pcbnew_embind.cpp`; schematic `doApplyItems` in `wasm/bindings/eeschema_embind.cpp`; KiCad's `resolveGroups` functions; `BOARD_COMMIT` removal handling.

**Coverage:** four browser tests, group adoption and member replacement in PCB and SCH. An unmodified native file-open is a precondition proving the fixture's group is valid. All four paths reproduced in the browser run: the Y.Doc retained the member UUID while the receiving native group had no members.

### SYNC-05 — PCB item coverage differs from native file coverage (high)

**Potentially omitted collections:** `PCB_POINT_T`, `PCB_GENERATOR_T`, and groups in native snapshots. These are distinct board collections; traversing footprints, tracks, zones and drawings does not cover them all.

**Expected:** every supported top-level root retained by the native file writer is represented in an item snapshot and can be applied remotely.

**Source:** PCB `snapshotItems` walks footprints, tracks, zones, and drawings. The fragment extractor selects tracks, zones, drawings, footprints, and groups, but does not extract points or generators. KiCad's full-board writer serializes those separate collections.

**Coverage:** snapshot tests for points, generated tuning patterns, and groups; native remote-adoption tests for points and generated tuning patterns. The generator fixture comes from the pinned KiCad QA suite (`tuning_generators_load_save.kicad_pcb`), so its required members and parameters are preserved. A Y.Doc containing a root is not proof that the native editor contains it.

### SYNC-06 — root settings have no complete live native sync path (medium/high)

**6a: native view gap.** `paper`, `title_block`, `setup`, and similar root-level content are carried as document layout and reconciled on save. The item bridge does not apply arbitrary root settings to an already-open editor. A peer's document can therefore show new settings while its native save still emits the old ones.

**6b: lost updates within one head.** `syncLayoutToY` groups root fields by head and replaces a changed group. A local revision change in stale `title_block` can overwrite a peer's title change, despite a layout baseline. The baseline checks which head changed, not which nested field changed.

**Coverage:** browser tests `SYNC-06a` (PCB paper and title) and `SYNC-06b` (title versus revision). The second behavior also reproduced with the production converter in memory. Broader settings and drawing-sheet layouts are source-level coverage risks, not exhaustively exercised here.

### SYNC-07 — copied-sheet UUID collisions can drop one global edit (high)

**Trigger:** two separate child files contain the same symbol UUID, and a single global `SCH_COMMIT` modifies that UUID on both screens.

**Expected:** emit one changed symbol into each sheet's own room.

**Mechanism:** the native schematic dirty collector keys entries by item UUID and stores one owning screen. Recording the second occurrence replaces the first owner. Since room identity is per file, UUID alone is insufficient for a hierarchy-wide dirty set.

**Coverage:** browser test `SYNC-07` explicitly resolves both `(filename, UUID)` targets for one native commit, verifies both in-memory symbols changed, then checks both room documents. The driver must not resolve by UUID alone, which would reproduce the error in the test rather than in the dirty collector.

### SYNC-08 — native undo restores stale fields and diverges from the document (high)

**Trigger:** A moves a footprint; B edits its Value; A receives B's change and then undoes its own move.

**Expected collaborative behavior:** revert A's position while retaining B's Value.

**Mechanism:** native undo uses whole-item snapshots/`SwapItemData`; its snapshot predates the peer edit. This explains the stale native Value. The browser reproduction also found that the undo produced no outbound item packet: the local native board reverted to X=100 / Value=`R`, while both Y.Docs and the peer native board remained at X=101 / Value=`PEER-KEPT`. This persisted through a 10-second condition-based wait for the document position. The exact point suppressing that undo packet has not been isolated. The test does **not** establish that this undo overwrites the peer document; it establishes loss of the peer field in local memory and native/document divergence.

**Coverage:** browser test `SYNC-08`; checks the local native position, waits for the document position, then checks preservation of the peer Value. Outbound native packets are attached. Whole-item undo restoration is a known design limitation; the missing outbound update in this specific scenario is an additional observed symptom.

## Build and run

From the sibling superproject:

```sh
CACHE_PROJECT=kicad-wasm-staging KICAD_NO_MONITOR=1 scripts/build-pcbjam.sh kicad_editor pl_editor -- -j 8
cd pcbjam/tests
npm ci --ignore-scripts --no-audit --no-fund
./scripts/setup-kicad-wasm.sh
npx playwright install chromium
npx playwright test --project=kicad-chromium kicad/ysync-audit-2026-09-29.spec.ts --workers=1
npm run lint:determinism
```

The harness also requires the web workspace's locked dependencies (`pnpm install --frozen-lockfile --ignore-scripts` in `pcbjam/web`). The runtime is the staging source plus test hooks, not a previously built editor from another checkout. No production sync fixes are applied.

## Execution results

**Confirmed on staging in Chromium: 17 scenarios, 1 passing control and 16 failing defect assertions covering all eight findings.** No setup or boot failures are included in these results. The final full run started at `2026-09-29T11:20:44Z` and took 92 seconds, with retries disabled. The strengthened undo check was then run separately and reproduced both its failed document-position invariant and lost native Value.

| Finding | Scenarios | Observed result |
| --- | ---: | --- |
| Control | 1 | PASS: native field edit reached both Yjs and peer native memory. |
| SYNC-01 | 1 | FAIL: `[60,50]` became `[62,62]`; the original `[60,60]` remained. Shared and native peer polygon both had the wrong vertex. |
| SYNC-02 | 1 | FAIL: peer moved X=127→157; a global field edit on the parked screen returned the shared symbol to X=127. |
| SYNC-03 | 1 | FAIL: `AUDIT-NEW-LIBRARY` reached the document, then disappeared after the stale native move packet. The editing peer still held the newer native definition, creating further divergence. |
| SYNC-04 | 4 | FAIL: group adoption and member replacement lost native membership in both PCB and schematic editors. |
| SYNC-05 | 5 | FAIL: native snapshots omitted points, generated tuning patterns, and groups; points and generated roots also failed native remote adoption despite being present in Yjs. |
| SYNC-06 | 2 | FAIL: peer native board retained A4/old title after receiving A3/new title; a local revision save also reverted the peer title. |
| SYNC-07 | 1 | FAIL: both parked native symbols changed, but only `b.kicad_sch` emitted a packet; `a.kicad_sch` stayed stale in its room. |
| SYNC-08 | 1 | FAIL: local native undo restored stale Value and X=100, with no undo packet; Yjs and peer stayed at X=101 and the newer Value. |

Other validation completed:

- `kicad_editor` and `pl_editor` staging builds succeeded. The compiler first caught a method-name error in a new test hook; that hook was corrected and rebuilt successfully. Build logs: `logs/build/20260929-130852.log` and `logs/build/20260929-131515.log`.
- The new driver bundles successfully, and a focused TypeScript check of the driver/spec and their imports passes.
- `npm run lint:determinism`: all 210 spec files clean.
- `npm run lint:ci-coverage`: all 210 specs reachable; 12 projects accounted for.
- `git diff --check` passes.

Local retained evidence: `tests/test-results/sync-audit-report.json`, `tests/test-results/sync-audit-undo-report.json`, and per-test traces/screenshots beneath `tests/test-results/`. The JSON reports contain the full attached document/native/wire evidence. Generated build and test artifacts remain untracked/ignored; no large binaries are added to Git.

Run the CI-coverage guard separately from a live Playwright run: its discovery process rewrites the shared `.test-port` file. An intermediate concurrent validation attempt hit that port collision and was discarded; the reported full run completed after the guard exited.

## Limits and next investigation

This is representative end-to-end coverage of the identified issues, not an exhaustive audit of every KiCad object, file version, transport backend, or UI command. The browser runs use the production BroadcastChannel provider, not the remote staging service. Chromium was exercised; Firefox was not run in this audit. `pl_editor` was built, but these specific reproductions drive PCB and schematic editors.

The highest-impact follow-ups are stable identities for repeated polygon vertices, per-screen native baselines for global edits, baseline-aware library-definition writes, native group relinking, and complete enumeration of native collections. Root settings need both a native apply path and finer-grained merging. Dirty tracking must distinguish `(screen, UUID)`. Undo needs separate attention to whole-item restoration and the missing outbound update observed here. No fixes for these findings are included in this worktree.
