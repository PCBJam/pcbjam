# Multiplayer desync audit — response (2026-09-21)

Response to `2026-09-21-multiplayer-desync-audit.md`. All five findings were
reproduced, then fixed. Regression coverage:

- unit: `web/standalone/src/wasm/collab/desync-audit.test.ts` (the audit's three
  `it.fails` cases are now ordinary tests, plus the cases below),
  `sheet-manager.test.ts`
- e2e: `tests/kicad/desync-audit.spec.ts` (native findings, real wasm)

| # | Finding | Reproduced by | Fix |
|---|---------|---------------|-----|
| 1 | P1 cross-sheet commits enter the shown sheet's room | e2e on the pre-fix wasm (child wire emitted on the root's `onItems`) + unit | native routing by owning screen + `onSheetItems` → sheet manager |
| 2 | P1 pl_editor baseline never advances on remote applies | audit's unit test | pl_editor honours the resolver contract |
| 3 | P1 stale native settings overwrite a peer's saved settings | audit's unit test | save-sync diffs against a per-client layout baseline |
| 4 | P2 drawing-sheet repeat edits never reach the wire | e2e | full-blob change detection |
| 5 | P2 definition-only library updates never refresh symbols | audit's unit test | `kdoc_libsymbols` observer + parked-room catch-up |

## 1. Cross-sheet schematic commits

Native (`wasm/bindings/eeschema_embind.cpp`):

- `g_dirty` is now `uuid → owning SCH_SCREEN*`, captured at listener time from the
  item's parent chain (`owningScreen`). A removed item keeps its screen parent, so
  deletions have an owner too. Deliberately not `SCHEMATIC::ResolveItem`: a copied
  sheet file repeats its uuids and a hierarchy-wide lookup answers with the first
  copy.
- `flushDiff` serializes each root on ITS screen (`rootItemOn`, `itemBlob(…, screen)`
  — the `(lib_symbols …)` prelude is read from the selection's screen). Roots of
  the shown screen ride `onItems` as before; the rest batch per owning screen and
  leave on the new hook `window.kicadCollab.onSheetItems(absSheetPath, wireJson)`
  (unresolvable dirty uuid on a foreign screen = that sheet's removal). Without a
  listener the batch is dropped — never folded into the shown room.
- `rebaseline()` only clears dirty marks owned by the shown screen. Side effect: an
  edit still queued when the user navigates away is now routed to the sheet just
  left instead of being dropped.
- Apply side (`resolveOnShown`): removals, replace-by-uuid and the targeted
  rebaseline look items up on the SHOWN screen. The hierarchy-wide lookup pulled
  the item out of another sheet when a doc already held a foreign root (pre-fix
  corruption) or a sheet file was duplicated.

JS (`sheet-manager.ts`, `collab-start.ts`): `registerSheetItemsHook` →
`SheetCollabManager.writeOffSheet(sheetPath, json)`: serialized per manager,
ensures + activates the room (a write is demand, like the layout save-sync) and
writes `itemsWireToDelta(wire, docView)` + carried definitions into THAT room's
doc (origin `off-sheet-edit`). If the sheet became the bound one meanwhile the
batch goes through its binding's `onItems`. A never-seeded empty room is skipped —
its first bind file-seeds and re-upserts the editor snapshot, which holds the edit.

Known limits (unchanged architecture, now documented):

- A parked sheet has no native-view baseline, so the off-sheet write diffs against
  the doc. If a peer edited the same root on that sheet and this client never
  navigated in, this client's (stale) copy of the peer's slots wins. Closing that
  needs the sheet-targeted native apply the sheet-manager header already lists as
  a future upgrade.
- Docs already corrupted by the pre-fix emit (a subsheet root stored in the root
  room) are not repaired automatically. With the screen-scoped apply the stray
  root now shows up as a visible duplicate on the root sheet, where deleting it
  syncs normally.

## 2. pl_editor resolver contract

`kicadCollabApplyItems` (pl_editor) now calls `pcbjam_collab::resolveItemsWire`
right before applying, like pcbnew/eeschema. The apply is synchronous, so the
binding's native view advances at the same moment the model does. No JS change:
the adapter exposing `onResolve` is now truthful for every tool. The unit file
keeps a `resolves: false` module to document why the old shape desynced.

## 3. Settings writeback

`syncLayoutToY(fileDoc, ydoc, origin, baseline?)`: with a baseline (the layout
this editor last agreed on — the file it opened, then each save) only heads and
library definitions the file changed relative to it are reconciled. A peer's A3
survives a save from a client whose native model still says A4; that client's own
title edit still lands. Baselines are held by `WasmTool` (single-room tools) and
per room by the sheet manager (read from MEMFS when the room is created, i.e.
before any save can overwrite the loaded file). Without a baseline the old
whole-file behaviour remains (first-save fallback when the file was unreadable).

Not done (audit's first fix direction): applying remote layout changes to the
native model. There are no native live setters for paper/title block/setup; the
peer sees a remote settings change on reload. Save no longer reverts it.

## 4. Drawing-sheet repeat edits

pl_editor's differ keeps a second baseline of each item's full serialized blob
(`blobMap`). The v2 items wire emits when the scalar projection OR the blob
changed; the legacy scalar wire is unchanged. Covers every persisted field the
projection lacks (repeat count/step/label increment, comment, page option, text
box, font, colour).

## 5. Library-definition-only updates

- `bindKicadCollab` observes `kdoc_libsymbols`; a non-local change re-applies the
  root items using that definition (payload carries it via `libDefs`), minus roots
  the item observer already sends in the same transaction.
- `deltaToItemsWire` resolves the definition under `lib_name ?? lib_id`
  (`itemLibRef`), matching `SCH_SYMBOL::GetSchSymbolLibraryName` and the native
  `findLib` — a diverged local copy previously got no definition on the wire.
- Parked sheet rooms record which definitions changed remotely; the rebind adopt
  takes them as `SeedOptions.refreshLibIds`.
- The "stale save overwrites the new definition" half is closed by the baseline in
  §3 (an untouched definition is not written).
