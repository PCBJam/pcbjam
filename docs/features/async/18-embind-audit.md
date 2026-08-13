# 18 — Embind export audit (doc 17 S1 deliverable)

> **Status: AUDIT (2026-08-05).** The sync-embind classification doc 17 §4 S1 calls for:
> every JS-callable export in `wasm/bindings/`, classified for the mailbox migration.
> Method: all `EMSCRIPTEN_BINDINGS` blocks enumerated; each body followed one level deep.
> Classes: **PURE-READ** (stays synchronous), **MUTATOR** (becomes a queued message),
> **PARKER** (can asyncify-park itself), **TEST-LEVER** (`kicadTest*`, e2e only).

## Implementation amendment (2026-08-11)

The execution-owner implementation narrows the original meaning of **PURE-READ**.
An operation is not safe only because it does not write. A read which dereferences
mutable wx or KiCad state can observe a half-built model while another semantic owner
is parked. Therefore, the owner gateway now queues these reads with the writes:

- `kicadCollabGetPos`, `kicadCollabGetViewport`, `kicadCollabGetSelection`, and
  `kicadCollabGetSelectionFull`;
- `kicadLibsSymbolUsage`;
- the model-walking test/dev probes `kicadCollabTestGetCrossMapped`,
  `kicadCollabTestGetLocked`, `kicadCollabTestListItems`, `kicadCollabTestDemoSet`,
  `kicadCollabTestItemBlob`, and `kicadCollabTestUndoDepth`.

Their JavaScript contract is now `Promise<T>`. The same gateway also contains
`kicadLibsReload`, because that entry starts work with `runOnFiber()` and its ticket
must remain open until the affiliated fiber retires. The library reload source awaits
that ticket before it reads symbol usage or emits its update event.

Only small scheduler/control probes remain synchronous (`kicadOpenFileBusy` and
the timer/fiber park-state probes). The public `kicadCollabFiberBusy` probe was
removed after every consumer switched to the exact owner ticket; polling it was
both redundant and subject to a TOCTOU race. The dormant raw-pointer
`Board_*`/`Footprint_*`/`Pad_*` helpers were also removed. No `GetBoard` entry or
repository caller existed, and queued Embind object handles would not provide a
safe lifetime. A future Python adapter must use copied values or stable IDs under
owner admission. All exported `kicadCollabTest*` local-edit hooks
now use the owner gateway because they change the same document, undo, and selection
state as real UI input. Only the narrow `kicadTest*` scheduler levers stay direct so a
reducer can deliberately stage a park or transition. `kicadSetDarkChrome` stays direct
because it is a startup-only setting applied before the wx application exists. Network
and service fetch functions are not owner-gated; independent requests remain concurrent
and only their completed stateful application crosses the gateway.

The audit also applies to fresh non-Embind service callbacks. In particular,
`pcbjam_ngspice_event` no longer invokes KiCad callbacks directly from a worker
message entry. It copies the event and submits an ordinary execution-owner job.
The worker request and event reception remain concurrent; only the short C++
callback phase is serialized. Exact OCC/ngspice result-buffer writes still use
their matching wait token and wake only the owner that requested them.

## Audit baseline (2026-08-05)

The counts and classifications in this section record the original audit. The
implementation amendment above supersedes its model-read and `kicadLibsReload`
consequences.

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

**The proposed PURE-READ allowlist (amended above):** `kicadOpenFileBusy`, `kicadCollabFiberBusy`,
`kicadCollabGetPos`, `kicadCollabGetViewport`, `kicadCollabGetSelection`,
`kicadCollabGetSelectionFull`, `kicadCollabTestGetCrossMapped`, `kicadCollabTestGetLocked`,
`kicadCollabTestListItems`, `kicadCollabTestDemoSet`, `kicadCollabTestItemBlob`,
`kicadCollabTestUndoDepth`, `kicadTestTimerParkState`, `kicadTestFiberParkState`,
`kicadLibsSymbolUsage`, `Board_GetFootprints`, `Board_GetFileName`, `Footprint_GetPads`,
`Footprint_GetReference`, `Footprint_GetValue`, `Pad_GetNumber`, `Pad_GetPinFunction`.
Caveat below: "sync" is safe for the asyncify machinery, but reads that walk the model
still need the open to have settled (N6 territory).

## Guard coverage at audit time

| guard | coverage |
|---|---|
| `pcbjam_open::BusyGuard` (sets the gate) | the 6 open entries |
| `pcbjam_open::busy()` early-return | ONLY 8 names: Collab{Apply,ApplyItems,Snapshot,SnapshotItems} × pcbnew/eeschema/pl_editor |
| `runOnFiber` FIFO (collab_common.h) | ~35 mutators |
| bare `CallAfter`, no fiber | removed from the audited local-edit hooks; the two schematic move hooks and both editor clear-selection hooks now use `runOnFiber` |
| entirely unguarded, bare embind stack | `kicadSetChrome`, `kicadSetReadOnly`, the 3 `kicadSave*`, pl_editor applies (busy-gated but not fibered, inline `HardRedraw`), `kicadCollabTestAddText`, `kicadLibsReload` (fibered, no busy check), and every model-walking PURE-READ |

## Asymmetries found by the audit

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
4. **Resolved:** eeschema's `schCollabTestMoveFirst`/`MoveSchItem` and both editors'
   clear-selection hooks now use `runOnFiber`, so the owner ticket reaches the logical
   mutation tail instead of ending when a `CallAfter` is scheduled.
5. **Split-context construction**: `kicadCollabTestDuplicate*`/`AddSymbol` clone/construct
   items off-fiber then commit on-fiber.
6. `kicadSave*` park-safety rests on MEMFS writes staying synchronous — UNCERTAIN, verify
   before S4 puts saves on fibers.
7. Registration gaps: `kicadSetChrome` merged-image only; the timer/fiber park test levers
   exist in kicad_editor + pcbnew only.

## Original consequences for the S1 wrapper (doc 17 S1.5)

Wrap-and-enqueue applies to the **14 production mutators + 3 saves**, the model-walking
reads listed in the amendment, and all exported `kicadCollabTest*` local-edit hooks.
The separate `kicadTest*` scheduler levers remain direct because their sole purpose is
to stage a controlled transition. `kicadSetDarkChrome` is documented startup-safe and
can stay direct.

Full per-export table (file:line, evidence, guard) lives in the audit transcript; the
classifications above are the binding contract for S1/S4 work.
