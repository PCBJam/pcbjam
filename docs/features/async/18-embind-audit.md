# 18 — Embind export audit (doc 17 S1 deliverable)

> **Status: AUDIT (2026-08-05).** The sync-embind classification doc 17 §4 S1 calls for:
> every JS-callable export in `wasm/bindings/`, classified for the mailbox migration.
> Method: all `EMSCRIPTEN_BINDINGS` blocks enumerated; each body followed one level deep.
> Classes: **PURE-READ** (stays synchronous), **MUTATOR** (becomes a queued message),
> **PARKER** (can asyncify-park itself), **TEST-LEVER** (`kicadTest*`, e2e only).

## Headline numbers

**79 distinct JS names** (171 `function()` registrations across 6 bindings blocks —
names duplicate per-bundle behind `#ifndef KICAD_MERGED_EMBIND`; pcb_calculator's block
is empty). No `EMSCRIPTEN_KEEPALIVE` JS entries exist in the tree.

| class | count | migration consequence |
|---|---|---|
| MUTATOR | 47 (33 test-only, 14 production) | queued mailbox message (S1 wrapper / S4) |
| PURE-READ | 20 | stays sync — the allowlist |
| TEST-LEVER | 9 (6 of them park-capable by design) | keep direct — they *stage* collisions |
| PARKER | 3 production (`kicadOpenFile`, `kicadOpenFiles`, `kicadLibsReload`) | fiber contexts at S4 |

**The 14+3 production mutators/IO:** `kicadSetChrome`, `kicadSetReadOnly`,
`kicadCollabApply`, `kicadCollabApplyItems`, `kicadCollabSnapshot`,
`kicadCollabSnapshotItems`, `kicadCollabPresenceStart`, `kicadCollabSetRemote`,
`kicadCollabSetPins`, `kicadCollabSetStyle`, `kicadCollabSetViewport`,
`kicadCollabFitViewport`, `kicadCollabReleaseSelection`, `kicadSetColorTheme`
(park-suspect: settings Save + full chrome rebuild), plus light `kicadSetDarkChrome`
and the three bare-stack I/O entries `kicadSaveBoard` / `kicadSaveSchematic` /
`kicadSaveDrawingSheet`.

**The PURE-READ allowlist (stays sync):** `kicadOpenFileBusy`, `kicadCollabFiberBusy`,
`kicadCollabGetPos`, `kicadCollabGetViewport`, `kicadCollabGetSelection`,
`kicadCollabGetSelectionFull`, `kicadCollabTestGetCrossMapped`, `kicadCollabTestGetLocked`,
`kicadCollabTestListItems`, `kicadCollabTestDemoSet`, `kicadCollabTestItemBlob`,
`kicadCollabTestUndoDepth`, `kicadTestTimerParkState`, `kicadTestFiberParkState`,
`kicadLibsSymbolUsage`, `Board_GetFootprints`, `Board_GetFileName`, `Footprint_GetPads`,
`Footprint_GetReference`, `Footprint_GetValue`, `Pad_GetNumber`, `Pad_GetPinFunction`.
Caveat below: "sync" is safe for the asyncify machinery, but reads that walk the model
still need the open to have settled (N6 territory).

## Guard coverage today

| guard | coverage |
|---|---|
| `pcbjam_open::BusyGuard` (sets the gate) | the 6 open entries |
| `pcbjam_open::busy()` early-return | ONLY 8 names: Collab{Apply,ApplyItems,Snapshot,SnapshotItems} × pcbnew/eeschema/pl_editor |
| `runOnFiber` FIFO (collab_common.h) | ~35 mutators |
| bare `CallAfter`, no fiber | selection/presence sub-paths, eeschema's 2 move test hooks |
| entirely unguarded, bare embind stack | `kicadSetChrome`, `kicadSetReadOnly`, the 3 `kicadSave*`, pl_editor applies (busy-gated but not fibered, inline `HardRedraw`), `kicadCollabTestAddText`, `kicadLibsReload` (fibered, no busy check), and every model-walking PURE-READ |

## Asymmetries the migration must fix (or knowingly accept)

1. **Model-walking pure-reads have no `busy()` gate** (`kicadCollabGetPos`,
   `kicadCollabGetSelection*`, `kicadCollabTestListItems`, `Board_*`/`Footprint_*`/`Pad_*`,
   `kicadLibsSymbolUsage`, `kicadCollabTestItemBlob`) — they can walk a half-built model
   during a parked `OpenProjectFiles`. Same exposure class the gate was built for; the
   mailbox does NOT fix reads (they stay sync) — needs either a busy() early-return with a
   benign empty result, or documented "caller must await settle" (open-flow already does).
2. **pl_editor's `kicadCollabApply`/`ApplyItems` are busy-gated but NOT fibered** — they
   mutate `DS_DATA_MODEL` + `HardRedraw()` on the bare embind stack (pl_editor_embind.cpp:313,
   :515), unlike the pcbnew/eeschema twins. `kicadCollabTestAddText` (PL:597) likewise.
3. **`kicadLibsReload` is the only production PARKER with no `busy()` gate**
   (pcbjam_libs_reload.h — `LoadLibraryEntry` asyncify-suspends per its own header).
4. **eeschema's `schCollabTestMoveFirst`/`MoveSchItem` use bare `CallAfter`** where the
   pcbnew twins use `runOnFiber`.
5. **Split-context construction**: `kicadCollabTestDuplicate*`/`AddSymbol` clone/construct
   items off-fiber then commit on-fiber.
6. `kicadSave*` park-safety rests on MEMFS writes staying synchronous — UNCERTAIN, verify
   before S4 puts saves on fibers.
7. Registration gaps: `kicadSetChrome` merged-image only; the timer/fiber park test levers
   exist in kicad_editor + pcbnew only.

## Consequences for the S1 wrapper (doc 17 S1.5)

Wrap-and-enqueue applies to the **14 production mutators + 3 saves**; test-only mutators
keep direct entry (the harness *wants* to stage collisions). The busy()-gated four
(apply/snapshot pairs) are the first wrap targets — their drop→deliver flip is N2's
subject. `kicadSetDarkChrome` is documented main-thread-safe and can stay direct.

Full per-export table (file:line, evidence, guard) lives in the audit transcript; the
classifications above are the binding contract for S1/S4 work.
