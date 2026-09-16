# Import from file: interactive placement (route 2)

Status 2026-09-15: implemented on `fix/paste-follows-cursor` (folded in with the
paste-follows-cursor wx fixes it depends on). Gate:
`tests/kicad/import-place-interactive.spec.ts` (eeschema + pcbnew, RED on a
build without the export, GREEN after); JS unit tests in
`web/standalone/src/wasm/import-item.test.ts`.

## Before

The POC panel (`web/standalone/src/components/ImportItemPanel.tsx`,
`wasm/import-item.ts`) armed a JS click catcher over the GL canvas, mapped the
click to world units itself and inserted the item through the collab apply
bridge (`kicadCollabApplyItems`). Three consequences, all reported by the user:
nothing was on the cursor while choosing the spot; the insert used SKIP_UNDO
(Cmd+Z did nothing); the item was folded into the collab baseline (peers never
received it).

## Now

One export per editor, routed by the merged image
(`wasm/bindings/kicad_editor_embind.cpp`): `Module.kicadPlaceImportedItem(sexpr)`
→ `{ok, error?}`. It takes the same blob the panel already builds and hands
the parsed item to the editor's OWN placement flow on the apply coroutine:

- eeschema (`schPlaceImportedItem`): LoadContent into a throwaway sheet (the
  applyItems parser), detach the symbol, give it the blob's `LIB_SYMBOL`,
  fresh uuid, then `RunAction(SCH_ACTIONS::placeSymbol, PLACE_SYMBOL_PARAMS{sym,
  reannotate=true})` — the chooser path. The symbol hangs off the pointer, R
  rotates, Esc deletes it, the click commits "Place Symbol" (undo entry) and
  `SCH_SCREEN::Append` caches the library definition.
- pcbnew (`pcbPlaceImportedItem`): `makeFromBlob`, fresh uuids, `SetParent`,
  pads to net 0, then the paste recipe from `PCB_CONTROL::placeBoardItems`:
  `BOARD_COMMIT` + select + `RunSynchronousAction(PCB_ACTIONS::move, &commit)`;
  the click pushes "Place Footprint", Esc reverts the commit. (`PCB_ACTIONS::
  placeFootprint` with a pre-built footprint is deliberately not used: it
  expects the caller to have committed the footprint at the origin first,
  which would broadcast that origin position to peers.)

Both commit through the normal path, so the collab bridge's commit listener
broadcasts the placement on the v2 items wire (`window.kicadCollab.onItems`)
exactly like a chooser placement, and Cmd+Z removes it.

The panel calls the export when present (`hasInteractivePlacement`) and keeps
the click-catcher route as a fallback for older editor builds (the CDN build
until this lands).

## Depends on

The two wx parked-dispatch fixes in
`docs/features/wx-parity-bugs/paste-follows-cursor.md`: without them the
pcbnew route (a synchronous move on a parked chain) would neither follow the
pointer nor repaint until the first mouse move.

## Gate shape

Boot with a one-item fixture, zoom to objects, install `window.kicadCollab`,
baseline via `kicadCollabSnapshot`, pointer at A, call the export; assert the
new uuid is selected, the canvas repaints at A before any motion, repaints
again after moving to B, the committed item maps to B, undo depth +1, the
items wire carries the new blob; then a second placement dropped with Esc adds
nothing and leaves the undo depth alone.
