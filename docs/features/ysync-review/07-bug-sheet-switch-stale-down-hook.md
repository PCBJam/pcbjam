# Bug 07 — Sheet switch leaves the DOWN hook pointing at the old room; cross-room contamination window

**Severity:** medium (small window on warm rooms; a full network round-trip — or forever — on cold/failed switches)
**Status:** FIXED 2026-07-03 — see [17](17-fixes-bugs-01-07.md) (batch 4: destroyed-flag hook + switch retry). **UP side CLOSED 2026-08-28** — see "8/28 closure" below.

## Where

- `web/standalone/src/wasm/collab/kicad-binding.ts:191-195` — `KicadBinding.destroy()`
  only calls `items.unobserveDeep(observer)`; the DOWN hook registered via
  `bridge.onItems(...)` (→ `window.kicadCollab.onItems`, `moduleItemsBridge`
  `:216-222`) is **never unregistered**
- `web/standalone/src/wasm/collab/sheet-manager.ts:158-203` — `doSwitch`: destroys the
  old binding synchronously, then `await ensureRoom(sheetPath)` (network for a cold
  room), then `bindKicadCollab` re-registers `onItems`
- UP-side mirror: `wasm/bindings/eeschema_embind.cpp:935-943` — a queued
  `schCollabApplyItems` CallAfter applies to `aFrame->GetScreen()` — whatever sheet is
  active **when it runs**, not when it was queued

## The DOWN-side hole (main issue)

Between `old.binding.destroy()` and `bindKicadCollab(room.doc, bridge)` there is an
async gap. During that gap `window.kicadCollab.onItems` still points at the **old
binding's closure**, which writes into the **old sheet's Y.Doc**.

The C++ side has already rebaselined to the new screen (`OnSchSheetChanged` →
`rebaseline()` fires from `DisplayCurrentSheet` before the JS switch completes), so a
local edit in the gap emits a *new-sheet-scoped* diff — and the stale hook applies it
to the *old* room:

- the old room's doc gains the new sheet's items (`applyDeltaToY` upserts them and
  appends root layout slots);
- peers bound to the old room receive them and **add the wrong sheet's items to their
  editor screens**;
- the old sheet's materialized file now contains foreign items.

Window size:

- **Warm room** (already in the pool): one microtask — tiny but nonzero.
- **Cold room** (`switchTo` before `connectAll` finished warming it): a full
  provider connect + `whenSynced()` round-trip.
- **Failed switch** (`ensureRoom` throws — network down): `doSwitch` aborts with
  `activePath = null` and **no retry**; the stale hook stays live indefinitely, and
  every subsequent edit on the new sheet flows into the old room until the user
  navigates again successfully.
- **Coalesced rapid navigation**: superseded switches are skipped
  (`requestedPath !== sheetPath`), correctly — but the hook keeps pointing at the last
  *bound* room, which may be several sheets back, until the final switch completes.

## The UP-side mirror (smaller)

An `applyItems` already queued into the C++ CallAfter pipeline before a navigation
lands on the **new** screen: `doApplyItems` resolves `existing` hierarchy-wide (fine)
but `commit.Add(item, aFrame->GetScreen())` targets the now-active sheet — items from
sheet A's room can be added to sheet B's screen. Sub-frame window; lower priority than
the DOWN side but the fix below covers it too.

## Fix direction

1. **Detach the DOWN hook in `destroy()`**: give the bridge an `offItems()` (or have
   `bindKicadCollab` install a wrapper that checks a `destroyed` flag and drops — or
   buffers — emits). Dropping is acceptable only if the C++ baseline is rolled back;
   otherwise the edit silently never syncs (a mini version of bug 05). Better:
   **buffer** emits while unbound and let the next `seed()`'s adopt/baseline pass
   reconcile them (the adopt already reconciles editor↔doc wholesale, so buffered
   emits can simply be discarded *after* a successful adopt-bind — the adopt reads the
   editor's current truth).
2. **Generation-tag the apply path**: include the target sheet path (the room's file)
   in the wire envelope and have `doApplyItems` verify it against
   `currentScreen()->GetFileName()`, dropping mismatches. This closes both the UP-side
   race and any residual DOWN-side echo.
3. **Retry / re-run failed switches**: on `ensureRoom` failure, keep `requestedPath`
   and re-attempt (with backoff) instead of leaving the editor unbound.

## Verification

Sheet-manager unit test: destroy old binding, delay `ensureRoom` (fake provider),
fire `onItems` during the gap, assert the old doc did NOT change. Integration:
throttle the network, navigate to a cold subsheet and immediately draw a wire; assert
the wire lands in the new sheet's room only.

Repro (2026-07-03): `web/standalone/src/wasm/collab/ysync-repros.test.ts` — 07a
(post-`destroy()` emit must not write into the doc) and 07b (REAL sheet-manager +
REAL kicad-binding + REAL yjs with only `connectKicadDoc` faked; the cold-switch gap
is held open and the stale hook's emit lands in the old sheet's doc). Both `it.fails`.
See [16](16-repro-suite-results-and-empirical-findings.md).

## 8/28 closure — the UP-side window was NOT sub-frame; it corrupted a project

**Field case (staging, `mega-demo-v2`, Arduino Mega repo-as-project):** reload
showed *"The entire schematic could not be loaded … Could not load sheet
'…/Arduino Mega 2560/ATMEGA2560-16AU.kicad_sch' because it already appears as a
direct ancestor … IO_ERROR: Unable to open  for reading"*. The two lines are one
event: KiCad's ancestor check blanks the filename and falls through to
`loadFile("")`. The materialized `ATMEGA2560-16AU.kicad_sch` held the ROOT's
content — all three of the root's `(sheet …)` items with identical uuids (one of
them `Sheetfile "ATMEGA2560-16AU.kicad_sch"` → self-reference) and 49/52 of the
root's symbols; its own items were gone.

**Mechanism (both halves of this doc, chained):**

1. `doSwitch(root)` was parked on `await ensureRoom()` / `await activate()`
   (cold or passive-gateway room). The user entered the subsheet; C++ moved the
   active screen and JS queued `switchTo(sub)`. The `requestedPath` guard only
   ran BEFORE `doSwitch` started, so the root switch resumed, bound the root doc
   and **adopted it onto the subsheet's screen**: doc-only roots (the root's
   items, `(sheet …)` entries included) added, the subsheet's own items removed.
2. `doSwitch(sub)` then bound the subsheet room. Its bind wrote the contaminated
   screen into the subsheet doc (empty room → file-seed + editor-snapshot
   baseline; populated room → the next save-all uploaded the contaminated
   file). From then on every reload materialized the self-referencing sheet.

`doApplyItems` applies with `commit.Add(item, aFrame->GetScreen())` — whatever
screen is active when the deferred coroutine runs — so nothing on the C++ side
could refuse the wrong-screen apply.

**Fix (two layers, red→green):**

- `sheet-manager.ts doSwitch`: `superseded()` re-checks `requestedPath` after
  every await and bails before binding/adopting; the room stays warm (parked).
  Test: `sheet-manager.test.ts` "a switch superseded DURING its connect never
  binds/adopts onto the new screen".
- Envelope tag (fix direction 2): `bindKicadCollab(…, { sheetPath })` stamps
  every `applyItems` wire (remote change + adopt) with `sheet: <project-relative
  path>` (`itemsWireDeltaSchema.sheet`, optional); `eeschema_embind.cpp
  applyTargetsShownSheet()` drops an envelope whose `sheet` is not the shown
  screen's filename (suffix match on the MEMFS absolute path) and logs
  `[collab] applyItems dropped`. Untagged envelopes keep the legacy behaviour
  (single-file tools, older clients). Tests: `kicad-binding.test.ts` (tag
  present on adopt + remote applies, absent when unbound),
  `sheet-manager.test.ts` (each room bound with its own path),
  `tests/kicad/apply-sheet-guard.spec.ts` (e2e: foreign-tagged apply dropped,
  own-tagged + untagged applied).

**Data repair:** an already-corrupted sheet doc is authoritative — re-upload the
original `.kicad_sch` for that path (the room re-seeds from the new file).
