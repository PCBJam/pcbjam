# Fix 20 — Miss 09 implemented: local-ops-only undo (option 1)

**Status:** DONE, e2e-verified 2026-07-07 (5/5 firefox + collab/ysync regression suites)
**Design:** [09-miss-undo-not-collab-aware.md](09-miss-undo-not-collab-aware.md) option 1,
feasibility per [19-undo-option1-feasibility.md](19-undo-option1-feasibility.md)

Remote applies no longer land on the receiving editor's undo stack: Ctrl+Z after a
peer's edit reverts your own last op, never the peer's, and the adopt "undo bomb" is
gone (adopt creates no undo entry at all — 09's option 3 history-barrier is moot).

## What changed

### KiCad fork

- `eeschema/schematic_undo_redo.cpp` — **UUID stale-pointer guard** in
  `PutDataInPreviousState`, mirroring pcbnew's: every picker (except `DELETED`,
  `PAGESETTINGS`, `REPEAT_ITEM`, and the root sheet, which `ResolveItem` cannot see)
  is existence-checked via `SCHEMATIC::ResolveItem(uuid)`. Missing → picker dropped
  (`not_found` → `wxLogStatus`, no modal). Present-but-different-pointer (a remote
  apply replaced the object, same uuid) → the picker is **re-anchored**
  (`SetPickedItem`) and the restore targets the current live item. Without this,
  undoing an entry whose item a remote apply freed dereferenced a dangling pointer.
- `eeschema/sch_commit.cpp` — `RecalculateConnections` moved **out** of the
  `!( aCommitFlags & SKIP_UNDO )` gate in `pushSchEdit`: a commit that skips undo
  still changes the model, and remote applies rely on the recalc (it was the whole
  point of applying through real commits). `SaveCopyInUndoList` stays gated.
- `pcbnew/undo_redo.cpp` — the "Incomplete undo/redo operation" `wxMessageBox`
  downgraded to `wxLogStatus`: dropped entries are routine in a collab session,
  and a blocking modal would hang the wasm modal pump. `wxLogWarning` is not a
  non-modal substitute in GUI builds: `wxLogGui` flushes warnings through a
  dialog. The status severity writes to the frame status bar and, on Wasm, the
  browser console without entering a modal pump.

### wasm bindings

- `eeschema_embind.cpp` / `pcbnew_embind.cpp` — all four remote-apply Push sites
  (`doApply` + `doApplyItems` per editor) now push with **`SKIP_UNDO`**. Change
  detection is unaffected: emit suppression is keyed off `s_applyingRemote`, not
  undo entries.
- **Removed-item ownership**: under `SKIP_UNDO` no undo picker takes ownership of
  removed items (and the commit deletes the clone image), so the bindings free the
  detached items after Push — both the explicit `removed[]` uuids and the upsert's
  remove-old-before-re-add. Fields are excluded (CHT_REMOVE hides them; they stay
  owned by their parent). Freeing stays in the binding layer, NOT the fork commit
  classes, because existing `SKIP_UNDO` callers (DRC marker flows) manage their
  removed items' lifetimes themselves — freeing in the commit would double-free.
- Test hooks `kicadCollabTestUndo` (runs `ACTIONS::undo` on the main-loop/fiber
  stack) and `kicadCollabTestUndoDepth`, registered per-editor **and** in
  `kicad_editor_embind.cpp`'s dispatcher — the merged image compiles out the
  per-app `EMSCRIPTEN_BINDINGS` registrations, so a shared-name hook that is not
  in the dispatcher silently vanishes from kicad_editor (build even forces the
  relink; it's the registration that's conditional).

## Coverage — tests/kicad/collab-undo.spec.ts (5/5)

| Scenario | Editors |
|---|---|
| Remote apply adds no undo entry; undo reverts own op, peer's delete survives | eeschema + pcbnew |
| Stranded CHANGED entry (remote replaced the item) — undo re-anchors by uuid, no crash | eeschema |
| Stranded entry (remote deleted the item) — picker dropped quietly (log, not modal), no resurrect | eeschema + pcbnew |

Pre-fix, the stranded cases dereferenced freed memory (eeschema had no guard at
all; pcbnew guarded existence but popped a blocking modal).

## Accepted semantics (per doc 19)

- Undo restores the full item image → a peer's concurrent edit to *another field of
  the same item* is clobbered (LWW, converges; same trade-off as opt 14 granularity).
- Duplicate-KIID edge (local delete parked on undo + peer re-adds same uuid + undo)
  remains untested; the differ keys by uuid so it should reconcile — follow-up test.
- Pre-existing local entries that a big adopt strands are dropped on first undo.
