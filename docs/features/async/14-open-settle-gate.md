# 14 — The open-settle gate: prod "indirect call signature mismatch" at board load

## Symptom

Intermittent, prod, mostly Firefox: loading an editor URL (observed on
`…/Arduino Mega 2560.kicad_pcb`) sometimes fails the boot with

```
Error: RuntimeError: indirect call signature mismatch
```

right around the `[collab] maybeStartCollab gate:` console line. Previously
suspected (wrongly) to be related to spaces in filenames.

## Root cause

Three stacked defects:

1. **The "file loaded" signal was a no-op.** `openFileInTool` fires
   `Module.kicadOpenFile(path)` — which runs `OpenProjectFiles` under Asyncify,
   i.e. the embind call unwinds back to JS long before the load finishes — and
   then polls `schematicLoaded()`: *"title is non-empty and does not contain
   'untitled'"*. But pcbnew's pre-open title is `"PCB Editor"` (a fresh frame;
   `PCB_EDIT_FRAME` ctor title), and a real project's title never contains
   "untitled" at any point. The poll therefore passed **on the first check**,
   while the load had barely started. (The heuristic only ever waited for the
   `@local` new-file flow, whose files are literally named `untitled.*`.)

2. **`driveProjectIntoTool` ignored the result** — even an honest `"failed"`
   (60 s timeout) let the boot IIFE continue.

3. **Everything after it drives bare embind entries that walk the model.**
   `maybeStartCollab` → `attachKicadCollab` → `seed()` →
   `kicadCollabSnapshotItems()` (inline board walk + per-item `Format()`), then
   `bindKicadPresence` (GAL `VIEW_OVERLAY` bind). These run while the
   `kicadOpenFile` chain is still **parked mid-mutation of the same
   BOARD/SCH_SCREEN** (progress-reporter yields, futex yields, lib bridges). A
   virtual call that lands on a half-built item reads a garbage vtable slot →
   `call_indirect` hits a wrong-typed table entry → Firefox reports
   `indirect call signature mismatch`. The boot IIFE catches it →
   `Error: RuntimeError: …` in the status overlay.

This is the same reentrancy class as two already-fixed bugs — the wxWidgets
**dispatch interlock** (`wxwidgets/docs/wasm/dispatch-interlock.md`: no event
dispatch while another chain is parked) and drift-trio **finding #10b**
(`kicadCollabFiberBusy`: no bare-embind scratch save while a collab fiber is in
flight) — but through the one entry family neither guard covers: **web-shell
JS → embind calls during the open park**. Timing-dependent, hence "sometimes";
slow Firefox loads widen the window enormously; filename spaces were never
involved.

## Fix

Three layers, mirroring the shape of the earlier interlocks:

1. **Truthful completion signal** — `wasm/bindings/open_gate.h`:
   `pcbjam_open::BusyGuard`, an RAII counter on `kicadOpenFile`'s C++ stack
   frame. Under Asyncify an unwind does not run destructors and a rewind
   resumes past the constructor, so the count is held across every park and
   drops exactly when `OpenProjectFiles` truly returns (the same primitive as
   `wxWasmDispatchGuard`). Exported as `Module.kicadOpenFileBusy()` from all
   four `kicadOpenFile` definitions (pcbnew / eeschema standalone, merged
   kicad_editor, pl_editor), mirroring the `kicadCollabFiberBusy` probe.

2. **JS waits for it** — `open-flow.ts` `waitForOpenSettled()`: after invoking
   the open, poll `kicadOpenFileBusy()` until clear (5 min budget — slow loads
   are real; the poll is free). Escape hatch: a visible **non-progress** dialog
   means the load is parked awaiting user input (file-version confirm, remap…)
   — proceed rather than leave the dialog unanswerable under the boot overlay.
   Feature-detected: wasm builds without the probe fall back to the legacy
   title poll unchanged.

3. **Degrade, don't die** — `driveProjectIntoTool` returns the open outcome;
   on `"failed"` the shell skips the whole collab/presence/drift attach
   (board stays viewable, saves still route). The attach block is additionally
   wrapped so a residual trap logs `[collab] attach failed — continuing
   without collab` instead of failing the boot; `SexprVersionError` ("update
   required") still rethrows.

## Layer 4 — entry guards + the regression spec

The shell gate alone leaves the raw embind entries trappable if anything else
calls them mid-load, and is untestable end-to-end (see below). So the collab
snapshot/apply entries themselves early-return while `pcbjam_open::busy()`:
snapshots return the empty delta, applies drop. `kicadTestSetOpenPark(ms)`
(test-only, default off) makes `kicadOpenFile` Asyncify-park for a fixed time
on entry and again after `OpenProjectFiles` returns — model fully loaded, gate
still closed.

`tests/kicad/collab-load-fuzz.spec.ts` uses that window deterministically: it
opens a ~13k-item generated board and hammers all four entries the whole time
`kicadOpenFileBusy()` is true, asserting the gate engages, mid-load snapshots
are EMPTY (an unguarded build returns the full board → deterministic red),
mid-load applies are dropped (probe segment must not move), nothing traps, and
everything works after settle.

**Why the window must be synthetic:** the wasm port's `wxYield`/progress pump
never parks — the only natural in-load parks are thread-pool waits
(`futex_yield`/`nanosleep_yield`), which on a fast idle machine never happen
(the whole open runs synchronously and JS cannot interleave at all). That is
also why the prod trap correlates with slow machines/Firefox. A second,
`PCBJAM_FUZZ_STRESS=1`-gated test in the same spec hunts those natural parks
under spinning-worker CPU starvation; it cannot gate CI (window engagement is
scheduler-dependent) but is the honest reproducer to loop on a loaded box.

## Residuals / notes

- A trap escaping the open leaves the busy count stuck → the JS poll times out
  (5 min) and boots without collab; same end state as before, minus the trap.
- `kicadSetReadOnly` polling during the load is unaffected (leaf flag flip, no
  model walk) — it has always run during parks, like `kicadCollabFiberBusy`.
- The mid-load modal escape accepts the status-quo risk for that rare case:
  parked-at-a-dialog is a stable park point, not a mid-container-append one.
- Unit coverage: `web/standalone/src/wasm/open-flow.test.ts` (settle wait,
  stuck-busy failure, dialog escape incl. progress-dialog exclusion, legacy
  fallback).
