# Multiplayer desync audit — 2026-09-21

Scope: current native editor → client Y.Doc → ProjectRoom/BoardRoom → peer
Y.Doc → native editor path. This is a review, not a production fix. Three
binding reproductions were executed; the two native findings below are traced
through source and still need browser/WASM reproductions.

## Current path

1. pcbnew/eeschema commit listeners mark dirty roots and schedule a settled
   snapshot diff. pl_editor runs its snapshot diff from OnModify.
2. Native onItems emits per-root s-expressions. bindKicadCollab flattens these
   into items, compares against nativeView, and writes slot-level changes and
   library definitions to Yjs using a private origin tag.
3. GatewayDocFacade frames Yjs updates on one multiplexed project websocket.
   ProjectRoom/GatewayHub routes active document channels over a relay to the
   per-document BoardRoom. BoardRoom runs y-partyserver, broadcasts updates,
   and saves Yjs state to R2. Step1/Step2 handshakes reconcile state on joins.
4. A remote item-map event is lifted to root s-expressions and handed to WASM.
   pcbnew/eeschema defer application: flush local intent, resolve the queued
   payload against current Yjs state, apply through a native commit, then
   rebaseline touched items. The JS nativeView advances at resolution time.
5. Non-item layout/settings follow a separate save-only path. Library
   definitions live in kdoc_libsymbols, outside the observed item map.

The DOs can faithfully synchronize Y.Docs while the native editors disagree.
None of the findings below requires a transport failure. No additional
DO-specific bug was established by this review; that is not a certification
of reconnect, compaction, or persistence behavior.

## P1: cross-sheet schematic commits enter the active sheet's room

Source trace:

- kicad/eeschema/annotate.cpp:365 selects symbols across all sheets for
  ANNOTATE_ALL; :430 stages each symbol against its own screen.
- kicad/eeschema/sch_commit.cpp:399 collects changed items across screens and
  :437 delivers them together to the schematic listener.
- wasm/bindings/eeschema_embind.cpp:819 adds every item to one g_dirty set.
- :610 resolves each dirty UUID through the entire schematic hierarchy;
  :678 serializes every dirty root, without checking its owning screen.
- :689 emits one envelope without a sheet path. The installed onItems hook
  belongs to the currently active sheet's binding/Y.Doc.

Trigger: annotate all sheets while the root sheet is active. A symbol from a
subsheet is emitted into the root room and added there because its UUID is
absent. Peers can gain a spurious root-sheet symbol while the actual subsheet
room retains the old annotation. Save's layout-only reconciliation cannot
repair item state in the subsheet room.

Fix direction: retain screen/path ownership when collecting dirty items and
route per-sheet batches to the corresponding document. Merely filtering out
inactive-screen items would replace corruption with lost edits. Scope removal
tracking and serialization context by sheet as well.

Evidence: source trace, not yet browser-reproduced.

## P1: pl_editor's native baseline never advances on remote applies

moduleItemsBridge always exposes onResolve (kicad-binding.ts:786), so the
binding sets resolves=true (:221) and skips advancing nativeView on send
(:373). pl_editor's kicadCollabApplyItems (pl_editor_embind.cpp:531) applies
synchronously and never calls resolveItemsWire/resolveItems. Consequently JS
keeps the pre-apply baseline even though the native model changed.

Reproduction: both start at x=0; A moves text to x=10; B receives it and then
moves it back to x=0. B's new state equals its stale baseline, so no change is
written to Yjs. B displays x=0 while both Y.Docs and A remain at x=10.

Fix direction: expose resolver capability only when the native implementation
actually uses it, or implement the matching resolver contract in pl_editor.

Evidence: executable test using the production module adapter and a module
that models pl_editor's synchronous apply/no-resolver behavior.

## P1: stale native settings overwrite a peer's saved settings

WasmTool.tsx:1197 and sheet-manager.ts:412 reconcile layout on save through
syncLayoutToY. The binding's layout observer (kicad-binding.ts:455) only repairs
duplicate slots; it never updates native paper/title/setup settings. The save
reconciler compares the whole native settings snapshot to current Yjs state,
without a last-applied native baseline.

Reproduction: both open A4; A saves A3; B's Y.Doc receives A3 but B's native
editor remains A4. An ordinary save by B writes A4 back to both Y.Docs,
discarding A's change even though B never edited paper settings. Before the
first save, local settings changes do not reach Yjs at all.

Fix direction: apply remote layout changes to the native model and reconcile
only settings the local user changed relative to the last applied baseline.
A deliberate reload mechanism is an alternative if native live setters are
unavailable, but save must not blindly overwrite remote settings.

Evidence: executable two-document binding/save reproduction.

## P2: drawing-sheet repeat edits never reach the item wire

pl_editor_embind.cpp:174 itemToJson omits m_RepeatCount, m_IncrementVector and
m_IncrementLabel for scalar text/segment/rectangle items. The properties panel
edits those fields (kicad/pagelayout_editor/dialogs/properties_frame.cpp:570).
OnModify emits the full item blob only when that scalar projection changes
(pl_editor_embind.cpp:435), and returns without emitting when it compares
equal (:452).

Trigger: change only repeat count or repeat spacing on existing text or a
line. The native file changes, but no onItems event occurs. Saving does not
rescue it: syncLayoutToY intentionally excludes item content. A later change
to a tracked property may incidentally serialize the missing change.

Fix direction: detect changes with the full serialized item state or track
all persisted fields; the complete blob already exists for the v2 wire.

Evidence: source trace, not yet browser-reproduced.

## P2: library-definition-only updates never refresh native symbols

The DOWN hook writes wireLibSymbols even when the item delta is empty
(kicad-binding.ts:338). The UP hook observes only kdoc_items (:390).
kdoc_libsymbols is read when constructing an item payload but has no observer
that invalidates instances using a changed definition.

Trigger: emit an unchanged symbol instance with a changed lib_symbols
definition (for example a changed library graphic with the same instance
properties). The definition reaches both Y.Docs, but the other editor gets no
apply call. Existing native symbols can retain old geometry until a later
item update or reload. A stale native save can also overwrite the new
definition through syncLayoutToY's library-map upserts.

Fix direction: observe definition changes and refresh affected root instances;
avoid rewriting unchanged native definitions over newer remote definitions.

Evidence: executable onItems → Yjs → peer-binding reproduction.

## Validation and limitations

Added web/standalone/src/wasm/collab/desync-audit.test.ts with three it.fails
cases, following the existing ysync reproduction convention. Temporarily ran
them as ordinary tests and checked that each fails at its intended divergence
assertion, then restored the expected-failure markers.

The focused binding, gateway, sheet-manager, and audit suites contain 76 tests
(73 ordinary tests plus three expected failures). No application/native code
was changed. No WASM rebuild, two-browser runtime test, or deployed DO test
was performed. Prioritize cross-sheet routing, settings writeback, and the
resolver capability mismatch before extending drift reporting.
