/*
 * Embind bindings for KiCad eeschema WASM.
 *
 * Picked up automatically by scripts/kicad/build-kicad-target.sh when building
 * the eeschema app (it compiles wasm/bindings/<app>_embind.cpp if present).
 */

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/bind.h>
#include <kiway_player.h>
#include <kiway.h>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>
#include <wx/app.h>
#include <wx/filename.h>
#include <wx/string.h>
#include <wx/window.h>
#include <nlohmann/json.hpp>
#include <kiid.h>
#include <layer_ids.h>
#include <pcbjam_read_only.h>
#include <project.h>
#include <schematic.h>
#include <sch_edit_frame.h>
#include <sch_io/kicad_sexpr/sch_io_kicad_sexpr.h>
#include <sch_sheet.h>
#include <richio.h>
#include <lib_symbol.h>
#include <tools/sch_selection.h>
#include <tools/sch_selection_tool.h>
#include <sch_commit.h>
#include <sch_draw_panel.h>
#include <geometry/eda_angle.h>
#include <math/util.h>
#include <tool/tool_manager.h>
#include <view/view.h>
#include <view/view_overlay.h>
#include <chrono>
#include <wx/event.h>
#include <sch_item.h>
#include <sch_line.h>
#include <sch_junction.h>
#include <sch_no_connect.h>
#include <sch_text.h>
#include <sch_label.h>
#include <sch_symbol.h>
#include <sch_field.h>
#include <sch_shape.h>
#include <eda_shape.h>
#include <stroke_params.h>
#include <sch_screen.h>
#include <sch_sheet_path.h>
#include <schematic_settings.h>
#include <tool/actions.h>
#include <tool/coroutine.h>
#include <pcbjam_remote_lock.h>
#include "collab_common.h"
#include "open_gate.h"
#include "main_stack_runner.h"
#include "collab_presence_core.h"
#include "collab_presence_style.h"
#include "pcbjam_theme.h"
#include "pcbjam_libs_reload.h"
#include "pcbjam_async_policy.h"
#include <algorithm>

using namespace emscripten;
using json = nlohmann::json;

// Programmatically open a project file (schematic) in the running editor frame,
// without UI automation. Mirrors single_top.cpp's MacOpenFile path: the editor
// frame is the app's top window and is a KIWAY_PLAYER. Returns the result of
// OpenProjectFiles, or false if no frame is available — letting the JS caller
// fall back to driving File→Open.
//
// KICAD_MERGED_EMBIND (kicad_editor, editor-unification Part 2): pcbnew_embind.cpp
// defines the identical function and registers the same JS names — in the merged image
// the frame-agnostic duplicates (this + kicadCollabOnSave) and the shared-name
// registrations live once in kicad_editor_embind.cpp, which dispatches the per-editor
// entries (renamed schCollab*/pcbCollab* below; JS-facing names are unchanged).
#ifndef KICAD_MERGED_EMBIND
bool kicadOpenFile( std::string path )
{
    // Held across every Asyncify park of the load; see open_gate.h.
    pcbjam_open::BusyGuard busy;

    if( pcbjam_open::testParkMs() > 0 )
        emscripten_sleep( pcbjam_open::testParkMs() );

    KIWAY_PLAYER* frame =
            wxTheApp ? static_cast<KIWAY_PLAYER*>( wxTheApp->GetTopWindow() ) : nullptr;

    if( !frame )
        return false;

    if( wxWindow* blocking = frame->Kiway().GetBlockingDialog() )
        blocking->Close( true );

    bool ok = frame->OpenProjectFiles(
            std::vector<wxString>( 1, wxString::FromUTF8( path.c_str() ) ) );

    // Test-only post-load park (open_gate.h): model fully loaded, gate still
    // closed — the deterministic window the collab-load-fuzz spec hammers.
    if( pcbjam_open::testParkMs() > 0 )
        emscripten_sleep( pcbjam_open::testParkMs() );

    return ok;
}

// JS-pollable open-in-flight probe (open_gate.h): the web shell defers the
// collab/presence attach until the open chain has truly completed.
bool kicadOpenFileBusy()
{
    return pcbjam_open::busy();
}

// Test-only (collab-load-fuzz): arm the deterministic open parks.
void kicadTestSetOpenPark( int aMs )
{
    pcbjam_open::testParkMs() = aMs;
}

// Read-only viewer lock (read-only-viewer): flips the process-global
// PCBJAM_READ_ONLY flag consumed by TOOL_MANAGER (view-only action allowlist)
// and the selection tools (nothing selectable), and mirrors it onto the
// project so the setup dialogs grey out. Returns false until the editor frame
// exists so JS polls; the shell fails CLOSED if it never applies.
bool kicadSetReadOnly( bool aReadOnly )
{
    KIWAY_PLAYER* frame =
            wxTheApp ? dynamic_cast<KIWAY_PLAYER*>( wxTheApp->GetTopWindow() ) : nullptr;

    if( !frame )
        return false;

    PCBJAM_READ_ONLY::Set( aReadOnly );
    frame->Prj().SetReadOnly( aReadOnly );
    return true;
}
#endif // !KICAD_MERGED_EMBIND

// ───────────────────────────── Yjs collaborative bridge ─────────────────────────────
//
// eeschema's half of the unified bridge contract (features/yjs-bridge/0001, 0003).
// Unlike pl_editor it needs NO kicad-fork change: SCH_ITEM already carries a stable
// KIID, and eeschema has native change machinery, so the adapter is a thin re-use:
//   ChangeSource (emit) = a SCHEMATIC_LISTENER subclass (SCH_COMMIT::Push fires it)
//   apply              = SCH_COMMIT Modify/Remove + Push (drives connectivity recompute)
// The generic JS reconciler / transport / WasmTool wiring are reused unchanged.
//
// Scope of this first commit (0003 §"first PoC"): position-level sync of existing
// items — changed (move/edit) and removed. Decomposed field coverage via reflection,
// constructing arbitrary new item types on `added`, and symbol-instance / multi-sheet
// scoping are deferred (see TODOs). Items are resolved by globally-unique uuid, so
// changed/removed already work across the whole hierarchy without sheet scoping.
namespace {

// Guard so SCH_COMMIT::Push's listener callbacks during apply() aren't re-emitted.
bool s_applyingRemote = false;

using pcbjam_collab::toUtf8;

SCH_EDIT_FRAME* schFrame()
{
    return wxTheApp ? dynamic_cast<SCH_EDIT_FRAME*>( wxTheApp->GetTopWindow() ) : nullptr;
}

// The screen of the sheet the editor is currently showing. Per-sheet collab keys a room
// to each .kicad_sch, so the snapshot/diff that feeds a room must cover ONLY this screen,
// never the whole Hierarchy(). GetCurrentSheet().LastScreen() is the active sheet's screen
// (GetScreen() tracks the same screen and is the fallback before a sheet path exists).
SCH_SCREEN* currentScreen( SCH_EDIT_FRAME* aFrame )
{
    if( !aFrame )
        return nullptr;

    if( SCH_SCREEN* screen = aFrame->GetCurrentSheet().LastScreen() )
        return screen;

    return aFrame->GetScreen();
}

json itemToJson( SCH_ITEM* aItem )
{
    VECTOR2I p = aItem->GetPosition();
    json     j = {
        { "id", toUtf8( aItem->m_Uuid.AsString() ) },
        { "type", toUtf8( aItem->GetClass() ) },
        { "x", p.x },   // internal units; integral, so no quantization needed
        { "y", p.y },
    };

    // Per-type fields needed to reconstruct the item on `added` (0003 converters).
    // Hand-mapped for the wire-editing types; other types sync position-only (move) and
    // are skipped on `added` (logged) until their converters are added.
    if( aItem->Type() == SCH_LINE_T )
    {
        auto* line = static_cast<SCH_LINE*>( aItem );
        j["sx"]    = line->GetStartPoint().x;
        j["sy"]    = line->GetStartPoint().y;
        j["ex"]    = line->GetEndPoint().x;
        j["ey"]    = line->GetEndPoint().y;
        j["layer"] = (int) line->GetLayer();
    }

    if( EDA_TEXT* txt = dynamic_cast<EDA_TEXT*>( aItem ) )
        j["text"] = toUtf8( txt->GetText() );

    if( SCH_LABEL_BASE* lbl = dynamic_cast<SCH_LABEL_BASE*>( aItem ) )
        j["shape"] = (int) lbl->GetShape();

    // Graphic shapes (circle / rectangle / arc / line / bezier): geometry is start/end plus,
    // for an arc, the center, and for a bezier the two control points. Stroke + fill complete it.
    if( aItem->Type() == SCH_SHAPE_T )
    {
        auto* shp   = static_cast<SCH_SHAPE*>( aItem );
        j["stype"]  = (int) shp->GetShape();          // SHAPE_T
        j["sx"]     = shp->GetStart().x;
        j["sy"]     = shp->GetStart().y;
        j["ex"]     = shp->GetEnd().x;
        j["ey"]     = shp->GetEnd().y;
        j["layer"]  = (int) shp->GetLayer();
        j["width"]  = shp->GetStroke().GetWidth();
        j["fill"]   = (int) shp->GetFillMode();

        if( shp->GetShape() == SHAPE_T::ARC )
        {
            VECTOR2I c = shp->GetCenter();
            j["cx"]    = c.x;
            j["cy"]    = c.y;
        }
        else if( shp->GetShape() == SHAPE_T::BEZIER )
        {
            j["c1x"] = shp->GetBezierC1().x;
            j["c1y"] = shp->GetBezierC1().y;
            j["c2x"] = shp->GetBezierC2().x;
            j["c2y"] = shp->GetBezierC2().y;
        }
    }

    return j;
}

// Construct a new SCH_ITEM from a delta item (for `added`), with the delta's uuid
// (m_Uuid is const → const_cast, exactly as the s-expr parser does). Returns nullptr for
// types without a converter yet.
SCH_ITEM* makeItem( const json& j )
{
    std::string type = j.value( "type", "" );
    SCH_ITEM*   item = nullptr;

    if( type == "SCH_LINE" )
    {
        int   layer = j.value( "layer", (int) LAYER_NOTES );
        auto* line  = new SCH_LINE( VECTOR2I( j.value( "sx", 0 ), j.value( "sy", 0 ) ), layer );
        line->SetEndPoint( VECTOR2I( j.value( "ex", 0 ), j.value( "ey", 0 ) ) );
        item = line;
    }
    else if( type == "SCH_JUNCTION" )
    {
        item = new SCH_JUNCTION( VECTOR2I( j.value( "x", 0 ), j.value( "y", 0 ) ) );
    }
    else if( type == "SCH_NO_CONNECT" )
    {
        item = new SCH_NO_CONNECT( VECTOR2I( j.value( "x", 0 ), j.value( "y", 0 ) ) );
    }
    else if( type == "SCH_TEXT" )
    {
        auto* txt = new SCH_TEXT( VECTOR2I( j.value( "x", 0 ), j.value( "y", 0 ) ),
                                  wxString::FromUTF8( j.value( "text", "" ).c_str() ) );

        // Mirror the interactive text tool (sch_drawing_tools.cpp createNewText): parent the
        // item to the schematic and apply the project's default text size, so a remotely-added
        // text resolves variables / renders identically to a locally-placed one.
        if( SCH_EDIT_FRAME* fr = schFrame() )
        {
            txt->SetParent( &fr->Schematic() );
            int sz = fr->Schematic().Settings().m_DefaultTextSize;
            txt->SetTextSize( VECTOR2I( sz, sz ) );
        }

        item = txt;
    }
    else if( type == "SCH_LABEL" || type == "SCH_GLOBALLABEL" || type == "SCH_HIERLABEL" )
    {
        VECTOR2I pos( j.value( "x", 0 ), j.value( "y", 0 ) );
        wxString text = wxString::FromUTF8( j.value( "text", "" ).c_str() );

        SCH_LABEL_BASE* lbl = ( type == "SCH_LABEL" )         ? (SCH_LABEL_BASE*) new SCH_LABEL( pos, text )
                              : ( type == "SCH_GLOBALLABEL" ) ? (SCH_LABEL_BASE*) new SCH_GLOBALLABEL( pos, text )
                                                             : (SCH_LABEL_BASE*) new SCH_HIERLABEL( pos, text );

        if( j.contains( "shape" ) )
            lbl->SetShape( (LABEL_FLAG_SHAPE) j["shape"].get<int>() );

        item = lbl;
    }
    else if( type == "SCH_SHAPE" )
    {
        // Reconstruct from the geometry itemToJson emits. Committing a *new* SCH_SHAPE used to
        // trap in SCH_COMMIT::Push's CHT_ADD path (GAL view->Add → an asyncify invoke_viii
        // mis-dispatch, "memory access out of bounds") because doApply ran off a fiber stack;
        // doApply now runs inside a COROUTINE (kicadCollabApply) so the add dispatches correctly,
        // exactly as a native draw does. (0006/0007.)  NB FILL_T::NO_FILL == 1, not 0.
        SHAPE_T st    = (SHAPE_T) j.value( "stype", (int) SHAPE_T::RECTANGLE );
        int     layer = j.value( "layer", (int) LAYER_NOTES );
        int     width = j.value( "width", 0 );
        FILL_T  fill  = (FILL_T) j.value( "fill", (int) FILL_T::NO_FILL );

        auto* shp = new SCH_SHAPE( st, (SCH_LAYER_ID) layer, width, fill );

        // Rectangle: two corners. Circle: start = center, end = a point on the radius. Both are
        // fully defined by start+end (what itemToJson emits via GetStart()/GetEnd()).
        shp->SetStart( VECTOR2I( j.value( "sx", 0 ), j.value( "sy", 0 ) ) );
        shp->SetEnd( VECTOR2I( j.value( "ex", 0 ), j.value( "ey", 0 ) ) );

        if( st == SHAPE_T::ARC && j.contains( "cx" ) )
        {
            shp->SetCenterX( j["cx"].get<int>() );
            shp->SetCenterY( j["cy"].get<int>() );
        }
        else if( st == SHAPE_T::BEZIER )
        {
            if( j.contains( "c1x" ) )
                shp->SetBezierC1( VECTOR2I( j["c1x"].get<int>(), j["c1y"].get<int>() ) );
            if( j.contains( "c2x" ) )
                shp->SetBezierC2( VECTOR2I( j["c2x"].get<int>(), j["c2y"].get<int>() ) );
        }

        if( SCH_EDIT_FRAME* fr = schFrame() )
            shp->SetParent( &fr->Schematic() );

        item = shp;
    }
    // SCH_SYMBOL `added` is still deferred (needs the s-expr clipboard-blob emit + LoadContent
    // reconstruction; symbol PLACEMENT is also natively blocked until symbol libraries are
    // bundled — see features/yjs-bridge tasks). Symbol move/position already syncs via `changed`.

    if( item )
        const_cast<KIID&>( item->m_Uuid ) = KIID( wxString::FromUTF8( j.value( "id", "" ).c_str() ) );

    return item;
}

// Current model of the ACTIVE screen as an array of item json. One collab room == one
// .kicad_sch screen, so we never fold in the rest of the hierarchy (uuids are unique
// within a screen, so no cross-sheet dedup is needed).
json snapshotItems( SCH_EDIT_FRAME* aFrame )
{
    json arr = json::array();

    if( SCH_SCREEN* screen = currentScreen( aFrame ) )
    {
        for( SCH_ITEM* item : screen->Items() )
            arr.push_back( itemToJson( item ) );
    }

    return arr;
}

// Wire emitters (legacy scalar delta + v2 items): shared, collab_common.h.
using pcbjam_collab::emitDelta;
using pcbjam_collab::emitItemsWire;

// Notify the standalone that the editor switched to a different sheet — a different
// .kicad_sch == a different collab room (ysync subschemas). The path is the active
// screen's load path: the same absolute MEMFS form kicadCollabOnSave emits, so the JS
// side strips the project prefix the same way (relativeProjectPath). No-op without a
// JS listener.
void emitSheetChanged()
{
    SCH_SCREEN* screen = currentScreen( schFrame() );

    if( !screen )
        return;

    std::string s = toUtf8( screen->GetFileName() );
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onSheetChanged )
            window.kicadCollab.onSheetChanged( UTF8ToString( $0 ) );
    }, s.c_str() );
}

// Serialize one live schematic item to its native s-expr via a one-item
// SCH_SELECTION through SCH_IO_KICAD_SEXPR::Format. For a symbol the output also
// carries its (lib_symbols …) definition (that prelude is emitted for any symbol
// in the selection, independent of aForClipboard).
//
// aForClipboard MUST be false. Clipboard mode is a LOSSY, paste-oriented dialect:
// it rewrites `(instances (project … (path …)))` relative to aRelativePath — so a
// symbol on the current sheet collapses to `(path "")` — takes the REFERENCE field
// from the per-sheet instance instead of the ordinal one, and keeps orphaned
// instance data (sch_io_kicad_sexpr.cpp saveSymbol: ~758-766, ~791-806, ~903).
// The Y.Doc is the source of truth for the FILE, so a wire blob must be byte-equal
// to that item's subtree in a full file save; clipboard form would silently strip
// every symbol's sheet path and unit/reference on materialize.
//
// aRelativePath is still required (Format wxCHECKs it non-null) but is unread on
// the aForClipboard=false path.
std::string itemBlob( SCH_EDIT_FRAME* aFrame, SCH_ITEM* aItem )
{
    SCH_SELECTION sel;
    sel.SetScreen( aFrame->GetScreen() );
    sel.Add( aItem );

    STRING_FORMATTER   fmt;
    SCH_IO_KICAD_SEXPR plugin;
    plugin.Format( &sel, &aFrame->GetCurrentSheet(), aFrame->Schematic(), &fmt,
                   /*aForClipboard*/ false );
    return fmt.GetString();
}

// ── Emit via post-settle snapshot diff ───────────────────────────────────────────────────
//
// A local edit is a single SCH_COMMIT::Push that fires OnItemsAdded/Removed/Changed
// synchronously and THEN runs RecalculateConnections (sch_commit.cpp ~402-430). So the native
// listener only ever sees the *pre-cleanup* (raw) geometry, while the connectivity cleanup
// that follows — merging collinear wires, dropping redundant junctions, splitting at new
// crossings — is never reported. Broadcasting those raw per-category lists made the peer
// reconstruct the edit from the raw state and run ITS OWN cleanup, over a different "dirty"
// scope, so on a big connected drag the two peers cleaned up differently and the peer lost
// segments/junctions.
//
// Instead, treat the listener purely as a "something changed" trigger and broadcast a DIFF of
// the full model taken AFTER the edit settles — a CallAfter, which runs once Push (cleanup
// included) has fully returned. That captures tab A's FINAL, already-clean geometry; the peer
// applies it and re-cleaning already-clean geometry is idempotent, so the two converge. (This
// mirrors pl_editor's snapshot-differ.) g_baseline is the last-broadcast state.

// Diff baseline of the ACTIVE screen only (per-sheet collab room scope), keyed by uuid.
std::map<std::string, json> snapshotByUuid( SCH_EDIT_FRAME* aFrame )
{
    std::map<std::string, json> m;

    if( SCH_SCREEN* screen = currentScreen( aFrame ) )
    {
        for( SCH_ITEM* item : screen->Items() )
            m[toUtf8( item->m_Uuid.AsString() )] = itemToJson( item );
    }

    return m;
}

std::map<std::string, json> g_baseline;
bool                        g_flushScheduled = false;

// Roots the listener saw change since the last flush (uuids, captured at callback
// time — removed items may be freed before the flush runs). The scalar snapshot
// diff is a LOSSY projection: rotations/mirrors (anchor unchanged), field text
// edits (the commit stages the SCH_FIELD, which is not a screen item), stroke
// properties etc. never move it (bug 04). Dirty roots emit their v2 blob
// unconditionally; the apply is an idempotent upsert and the TS layer drops
// no-op bodies, so a false positive costs one local serialization.
std::set<std::string> g_dirty;

// Lift a commit-staged item to the SCREEN item the differ tracks (a field/pin/cell
// lifts to its symbol/sheet/label/table — same promotion sch_commit's undo uses).
void noteDirty( SCH_ITEM* aItem )
{
    if( !aItem )
        return;

    while( EDA_ITEM* p = aItem->GetParent() )
    {
        if( !p->IsType( { SCH_SYMBOL_T, SCH_TABLE_T, SCH_SHEET_T, SCH_LABEL_LOCATE_ANY_T } ) )
            break;

        aItem = static_cast<SCH_ITEM*>( p );
    }

    g_dirty.insert( toUtf8( aItem->m_Uuid.AsString() ) );
}

// Re-seed the diff baseline to the current model — after handing out a seed snapshot, or after
// applying a remote delta (so those items aren't re-broadcast as a spurious local diff/echo).
// Declares "current model == broadcast state", so pending dirty marks are stale too — on a
// sheet switch they'd otherwise emit the OLD sheet's items into the new sheet's room.
void rebaseline()
{
    if( SCH_EDIT_FRAME* fr = schFrame() )
        g_baseline = snapshotByUuid( fr );

    g_dirty.clear();
}

// TARGETED rebaseline (bug 05): refresh baseline entries ONLY for the uuids a remote
// apply touched. A global rebaseline() would fold a concurrently-committed local edit
// (its flush is queued BEHIND the apply on the same pending-event list) into the
// baseline and silently swallow it; targeted, the edit still diffs and emits. The
// connectivity cleanup the apply's Push produced likewise stays diffable — the
// post-apply flush broadcasts it (idempotent on the original sender).
void rebaselineTouched( SCH_EDIT_FRAME* aFrame, const std::vector<std::string>& aIds )
{
    for( const std::string& id : aIds )
    {
        g_baseline.erase( id );

        KIID kid( wxString::FromUTF8( id.c_str() ) );

        if( SCH_ITEM* live = aFrame->Schematic().ResolveItem( kid, nullptr, /*allowNull*/ true ) )
            g_baseline[id] = itemToJson( live );
    }
}

// Diff the current (settled, post-cleanup) model against the baseline and broadcast the change.
void flushDiff()
{
    g_flushScheduled = false;

    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return;

    std::map<std::string, json> cur = snapshotByUuid( fr );

    json added = json::array(), changed = json::array(), removed = json::array();

    // v2 items wire (per-item s-expr blobs), built from the same diff. Screen items
    // are already root-level (fields live inside their symbols), so no lifting.
    json                  wAdded = json::array(), wChanged = json::array();
    std::set<std::string> wDone;

    auto blobFor = [&]( const std::string& id, json& aArr )
    {
        if( !wDone.insert( id ).second )
            return;

        KIID kid( wxString::FromUTF8( id.c_str() ) );

        if( SCH_ITEM* item = fr->Schematic().ResolveItem( kid, nullptr, /*allowNull*/ true ) )
            aArr.push_back( json{ { "sexpr", itemBlob( fr, item ) }, { "parent", nullptr } } );
    };

    for( const auto& [id, j] : cur )
    {
        auto it = g_baseline.find( id );

        if( it == g_baseline.end() )
        {
            added.push_back( j );
            blobFor( id, wAdded );
        }
        else if( it->second != j )
        {
            changed.push_back( j );
            blobFor( id, wChanged );
        }
    }

    for( const auto& [id, j] : g_baseline )
    {
        if( !cur.count( id ) )
            removed.push_back( id );
    }

    // Dirty roots (bug 04): whatever the listener saw commit emits its blob on the
    // v2 wire even when the scalar projection didn't move (rotation, field text,
    // stroke edits). wDone dedups against the scalar-diff emits; deleted ids
    // resolve null inside blobFor and skip (the removal loop covered them).
    for( const std::string& id : g_dirty )
        blobFor( id, wChanged );

    g_dirty.clear();

    g_baseline = std::move( cur );

    if( !added.empty() || !changed.empty() || !removed.empty() )
        emitDelta( json{ { "added", added }, { "changed", changed }, { "removed", removed } } );

    if( !wAdded.empty() || !wChanged.empty() || !removed.empty() )
        emitItemsWire( json{ { "added", wAdded }, { "changed", wChanged }, { "removed", removed } } );
}

// Coalesce all the listener callbacks of one commit (and any other edits in the same loop
// turn) into a single post-settle diff. flushDiff runs inside a COROUTINE: its v2 items
// emit serializes items via SCH_IO_KICAD_SEXPR::Format (itemBlob), whose virtual dispatch
// is only reliable on the libcontext fiber stack — on the bare CallAfter stack it traps
// and silently kills the whole flush, legacy emit included (same lesson as doApply, 0007).
void scheduleFlush()
{
    if( g_flushScheduled )
        return;

    g_flushScheduled = true;

    if( SCH_EDIT_FRAME* fr = schFrame() )
        pcbjam_collab::runOnFiber( fr, []() { flushDiff(); } );
    else
        flushDiff();
}

// A hierarchical sheet was just created locally ("Add Sheet"): write its new child screen
// to the child .kicad_sch file and tell the standalone (window.kicadCollab.onSheetCreated),
// so the child is persisted/registered the moment it's created — without waiting for the
// user to enter it or save the project. Otherwise the parent's `(sheet … child)` reference
// dangles for peers / on reload. Deferred onto the fiber stack (CallAfter + COROUTINE):
// SCH_IO_KICAD_SEXPR::Format's virtual dispatch traps on the bare listener/CallAfter stack,
// same as flushDiff/doApply. The sheet is re-resolved by uuid in the deferred body so a
// since-deleted sheet (e.g. an immediate undo) is a no-op rather than a dangling pointer.
void scheduleSheetSave( SCH_SHEET* aSheet )
{
    SCH_EDIT_FRAME* fr = schFrame();
    SCH_SCREEN*     parent = currentScreen( fr );

    if( !fr || !parent || !aSheet->GetScreen() )
        return;

    wxFileName childFn( aSheet->GetFileName() ); // relative "Sheetfile"
    childFn.MakeAbsolute( wxFileName( parent->GetFileName() ).GetPath() );

    std::string childAbs = toUtf8( childFn.GetFullPath() );
    std::string uuid = toUtf8( aSheet->m_Uuid.AsString() );

    pcbjam_collab::runOnFiber( fr, [fr, childAbs, uuid]() {
        KIID      kid( wxString::FromUTF8( uuid.c_str() ) );
        SCH_ITEM* item = fr->Schematic().ResolveItem( kid, nullptr, /*allowNull*/ true );

        if( !item || item->Type() != SCH_SHEET_T )
            return;

        try
        {
            SCH_IO_KICAD_SEXPR io;
            io.SaveSchematicFile( wxString::FromUTF8( childAbs.c_str() ),
                                  static_cast<SCH_SHEET*>( item ), &fr->Schematic() );
        }
        catch( ... )
        {
            return; // a write failure must not abort the runtime
        }

        EM_ASM( {
            if( window.kicadCollab && window.kicadCollab.onSheetCreated )
                window.kicadCollab.onSheetCreated( UTF8ToString( $0 ) );
        }, childAbs.c_str() );
    } );
}

// ChangeSource: the native SCHEMATIC_LISTENER is just a trigger — the actual change set comes
// from the post-settle snapshot diff above. Skipped while applying a remote delta (no echo);
// doApply rebaselines instead.
//
// Presence (collab-presence 0003): schematic changes often change the selection
// too (delete, paste) with no closing canvas event — the trigger below also
// piggybacks a selection re-check. Defined in the presence section further down.
void schedulePresenceSelCheck();

class COLLAB_LISTENER : public SCHEMATIC_LISTENER
{
public:
    void OnSchItemsAdded( SCHEMATIC&, std::vector<SCH_ITEM*>& aItems ) override
    {
        // A newly-added hierarchical sheet → persist + register its child file (above).
        if( !s_applyingRemote )
        {
            for( SCH_ITEM* item : aItems )
                if( item->Type() == SCH_SHEET_T )
                    scheduleSheetSave( static_cast<SCH_SHEET*>( item ) );
        }
        trigger( aItems );
    }
    void OnSchItemsChanged( SCHEMATIC&, std::vector<SCH_ITEM*>& v ) override { trigger( v ); }
    void OnSchItemsRemoved( SCHEMATIC&, std::vector<SCH_ITEM*>& v ) override { trigger( v ); }

    // The editor switched to a different sheet (a different .kicad_sch == a different
    // collab room). Re-baseline so the first edit on the new sheet diffs against ITS
    // screen, not the previous one, then tell the standalone to rebind its room to the
    // now-active sheet file. Fires from SCH_EDIT_FRAME::DisplayCurrentSheet, by which
    // point GetCurrentSheet()/GetScreen() already point at the new sheet.
    void OnSchSheetChanged( SCHEMATIC& ) override
    {
        rebaseline();
        emitSheetChanged();
    }

private:
    // Capture the touched roots at callback time (fields/pins lift to their
    // symbol — noteDirty), then coalesce into one post-settle flush.
    void trigger( const std::vector<SCH_ITEM*>& aItems )
    {
        if( s_applyingRemote )
            return;

        for( SCH_ITEM* item : aItems )
            noteDirty( item );

        scheduleFlush();
        schedulePresenceSelCheck();
    }
};

COLLAB_LISTENER* g_listener = nullptr;

// Get the live SCHEMATIC and ensure our listener is registered on it (idempotent).
SCHEMATIC* ensureBridge()
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return nullptr;

    SCHEMATIC& sch = fr->Schematic();

    if( !g_listener )
    {
        g_listener = new COLLAB_LISTENER();
        sch.AddListener( g_listener );
    }

    return &sch;
}

// ───────────────────────── collab presence (collab-presence 0003) ─────────────────────────
//
// eeschema port of pcbnew's presence layer (0002 — see pcbnew_embind.cpp for the full
// design rationale). The state + event/scheduling machinery live in the shared
// pcbjam_presence::CORE (collab_presence_core.h); this TU supplies only the
// eeschema-specific hooks: frame/tool lookup, KIID resolution via
// SCHEMATIC::ResolveItem, the bare-uuid selection payload, and the per-peer draw
// (cross-app ghosts gated to the CURRENT sheet). Zero kicad-fork changes: wx-layer
// Bind() triggers on the GAL canvas + the COLLAB_LISTENER piggyback, selection read
// post-settle from SCH_SELECTION_TOOL. Rooms are per-sheet (warm pool), so peers
// publishing cursor/selection in the bound room are BY CONSTRUCTION on this same
// sheet file — no sheet filtering is needed for same-room selections; the JS side
// rebinds the whole presence layer on sheet navigation (onSheetChanged) and clears
// the overlay in between.

// Cross-app selection (0006): the schematic items a peer's xsel (symbol uuids
// from a pcbnew peer) resolves to on the CURRENT sheet. Unlike same-room
// selections (per-sheet rooms scope those by construction) xsel arrives
// project-wide, so only items that resolve onto the sheet THIS canvas is
// showing count — a bbox from another sheet's screen would land at meaningless
// coordinates. ONE resolver shared by the ghost render and the test probe
// (kicadCollabTestGetCrossMapped), so the assertion can't drift from the pixels.
std::vector<SCH_ITEM*> resolveXsel( SCH_EDIT_FRAME* aFrame, const pcbjam_presence::PEER& aPeer )
{
    std::vector<SCH_ITEM*> items;

    for( const KIID& id : aPeer.xsel )
    {
        SCH_SHEET_PATH path;
        SCH_ITEM*      item = aFrame->Schematic().ResolveItem( id, &path, /*allowNull*/ true );

        if( item && path.LastScreen() == aFrame->GetScreen() )
            items.push_back( item );
    }

    return items;
}

pcbjam_presence::CORE& presenceCore()
{
    static pcbjam_presence::CORE core = []()
    {
        pcbjam_presence::CORE c;

        // eeschema ships its own defaults (hairline outline, subtler fill/cursor).
        c.style = pcbjam_presence::eeschemaDefaultStyle();

        c.frame = []() -> EDA_DRAW_FRAME* { return schFrame(); };

        c.selectionTool = []( EDA_DRAW_FRAME* fr ) -> SELECTION_TOOL*
        {
            return fr->GetToolManager()->GetTool<SCH_SELECTION_TOOL>();
        };

        // Selection emit = the bare uuid array (0006: eeschema uuids ARE the
        // symbol uuids; pcbnew's counterpart adds fpPaths).
        c.selectionEmitPayload = []( EDA_DRAW_FRAME* fr ) -> json
        {
            return presenceCore().selectionUuids( fr );
        };

        c.resolveItem = []( EDA_DRAW_FRAME* fr, const KIID& id ) -> EDA_ITEM*
        {
            return static_cast<SCH_EDIT_FRAME*>( fr )->Schematic()
                    .ResolveItem( id, nullptr, /*allowNull*/ true );
        };

        c.drawPeerShapes = []( pcbjam_presence::CORE& aCore, EDA_DRAW_FRAME* aFrame,
                               const pcbjam_presence::PEER& peer, const KIGFX::COLOR4D& color,
                               double px )
        {
            SCH_EDIT_FRAME* fr = static_cast<SCH_EDIT_FRAME*>( aFrame );

            for( const KIID& id : peer.selection )
            {
                SCH_SHEET_PATH path;
                SCH_ITEM*      item = fr->Schematic().ResolveItem( id, &path, /*allowNull*/ true );

                if( !item )
                    continue;   // not in this schematic (yet) — skip silently

                pcbjam_presence::drawSelectionBox( aCore.overlay.get(), aCore.chipOverlay.get(),
                                                   aCore.textOverlay.get(),
                                                   item->ViewBBox(), peer.name, color, px,
                                                   aCore.style );
            }

            // Cross-app ghosts (0006) — see resolveXsel for the sheet gating.
            if( !peer.xsel.empty() )
            {
                pcbjam_presence::STYLE ghost = pcbjam_presence::ghostStyle( aCore.style );

                for( SCH_ITEM* item : resolveXsel( fr, peer ) )
                {
                    pcbjam_presence::drawSelectionBox( aCore.overlay.get(), aCore.chipOverlay.get(),
                                                   aCore.textOverlay.get(),
                                                       item->ViewBBox(), peer.name, color, px,
                                                       ghost );
                }
            }
        };

        return c;
    }();

    return core;
}

void schedulePresenceSelCheck()
{
    presenceCore().scheduleSelCheck();
}

} // namespace


namespace {

// SCH_SYMBOL::Move() / SCH_LABEL_BASE::Move() move their child fields (reference, value, …) via
// an inner `field.Move()` — itself a virtual call that mis-dispatches in the apply context, so
// the field text is left behind at its old position while the body moves. Re-move the fields
// with a devirtualized call so the labels follow the symbol on the peer. (The inner call is a
// harmless no-op when it mis-dispatches — the fields stay put — so this doesn't double-move.)
void moveFields( std::vector<SCH_FIELD>& aFields, const VECTOR2I& aDelta )
{
    for( SCH_FIELD& field : aFields )
        field.SCH_FIELD::Move( aDelta );
}

// Move an item to an absolute position for the `changed` path. SCH_ITEM::Move() is virtual;
// dispatching it through the vtable from the apply/CallAfter context hits the asyncify
// call_indirect mis-dispatch and silently NO-OPS (so symbols/junctions/labels never moved on
// the peer — only SCH_LINE worked, via its direct SetStart/EndPoint path). GetPosition() reads
// fine (it's a plain virtual read; see 0003 / eeschema_collab_asyncify_apply). The fix:
// devirtualize Move() with an explicit class-qualified call, which is statically bound — a
// plain wasm `call`, not an instrumented call_indirect — so it actually executes. Composite
// items additionally need their child fields moved (see moveFields).
void moveItemTo( SCH_ITEM* aItem, const VECTOR2I& aNewPos )
{
    VECTOR2I delta = aNewPos - aItem->GetPosition();

    if( delta == VECTOR2I( 0, 0 ) )
        return;

    switch( aItem->Type() )
    {
    case SCH_SYMBOL_T:
    {
        auto* sym = static_cast<SCH_SYMBOL*>( aItem );
        sym->SCH_SYMBOL::Move( delta );
        moveFields( sym->GetFields(), delta );
        break;
    }
    case SCH_JUNCTION_T:   static_cast<SCH_JUNCTION*>( aItem )->SCH_JUNCTION::Move( delta ); break;
    case SCH_NO_CONNECT_T: static_cast<SCH_NO_CONNECT*>( aItem )->SCH_NO_CONNECT::Move( delta ); break;
    case SCH_TEXT_T:       static_cast<SCH_TEXT*>( aItem )->SCH_TEXT::Move( delta ); break;
    case SCH_LABEL_T:
    case SCH_GLOBAL_LABEL_T:
    case SCH_HIER_LABEL_T:
    {
        auto* lbl = static_cast<SCH_LABEL_BASE*>( aItem );
        lbl->SCH_LABEL_BASE::Move( delta );
        moveFields( lbl->GetFields(), delta );
        break;
    }
    default:
        aItem->Move( delta );   // virtual fallback (may no-op in the apply context)
        break;
    }
}

// The actual model mutation, via SCH_COMMIT so connectivity/ERC recompute as for a UI
// edit. (Editor write ops like SCH_ITEM::Move are called through invoke_vii, whose
// asyncify-instrumented dynCall trampoline traps on a stale type — fixed at the JS shim
// layer in scripts/common/shims/dyncall-binding.js.tmpl; see 0003.)
void doApply( SCH_EDIT_FRAME* aFrame, const json& aDelta )
{
    SCHEMATIC& sch = aFrame->Schematic();

    s_applyingRemote = true;

    SCH_COMMIT commit( aFrame );
    bool       staged = false;

    // With SKIP_UNDO no undo picker takes ownership of removed items; the commit
    // detaches them from the screen and we free them after Push. Fields are hidden
    // by CHT_REMOVE, not detached (still owned by their parent), so never freed.
    std::vector<SCH_ITEM*> removedItems;

    for( const json& rid : aDelta.value( "removed", json::array() ) )
    {
        SCH_SHEET_PATH path;
        KIID          id( wxString::FromUTF8( rid.get<std::string>().c_str() ) );

        if( SCH_ITEM* item = sch.ResolveItem( id, &path, /*allowNull*/ true ) )
        {
            commit.Remove( item, path.LastScreen() );

            if( item->Type() != SCH_FIELD_T )
                removedItems.push_back( item );

            staged = true;
        }
    }

    for( const json& j : aDelta.value( "changed", json::array() ) )
    {
        SCH_SHEET_PATH path;
        KIID          id( wxString::FromUTF8( j.value( "id", "" ).c_str() ) );

        if( SCH_ITEM* item = sch.ResolveItem( id, &path, /*allowNull*/ true ) )
        {
            commit.Modify( item, path.LastScreen() );

            if( item->Type() == SCH_LINE_T && j.contains( "sx" ) )
            {
                // Wires reshape (endpoints move independently), so set both points.
                auto* line = static_cast<SCH_LINE*>( item );
                line->SetStartPoint( VECTOR2I( j["sx"].get<int>(), j["sy"].get<int>() ) );
                line->SetEndPoint( VECTOR2I( j["ex"].get<int>(), j["ey"].get<int>() ) );
            }
            else if( j.contains( "x" ) && j.contains( "y" ) )
            {
                moveItemTo( item, VECTOR2I( j["x"].get<int>(), j["y"].get<int>() ) );
            }

            staged = true;
        }
    }

    for( const json& j : aDelta.value( "added", json::array() ) )
    {
        KIID id( wxString::FromUTF8( j.value( "id", "" ).c_str() ) );

        if( sch.ResolveItem( id, nullptr, /*allowNull*/ true ) )
            continue;                       // already present (our own echo)

        if( SCH_ITEM* item = makeItem( j ) )
        {
            commit.Add( item, aFrame->GetScreen() );
            staged = true;
        }
        else
        {
            EM_ASM( { console.log( "[collab] eeschema apply: no converter for added type " + UTF8ToString( $0 ) ); },
                    j.value( "type", "?" ).c_str() );
        }
    }

    // SKIP_UNDO: a peer's edit must never land on this editor's undo stack — Ctrl+Z
    // would revert (and re-broadcast) the peer's work. Undo is local-ops-only; stale
    // local undo entries are dropped/re-resolved by UUID at undo time (miss 09).
    if( staged )
        commit.Push( wxT( "Collaborative edit" ), SKIP_UNDO );

    for( SCH_ITEM* item : removedItems )
        delete item;

    // The applied remote changes (and any connectivity cleanup they triggered) are now the
    // shared state — fold them into the baseline so the post-apply listener flush doesn't
    // re-broadcast them as a local diff (echo).
    rebaseline();
    s_applyingRemote = false;
}

// v2 items apply: removed by uuid; added/changed are an idempotent per-item upsert.
// Each blob is parsed through the clipboard-paste path — LoadContent into a throwaway
// sheet (sch_editor_control.cpp Paste pattern) — then the loaded items are detached,
// matched by uuid against the live model (replace), lib-relinked for symbols, and
// committed. Runs inside the apply COROUTINE (see kicadCollabApplyItems).
void doApplyItems( SCH_EDIT_FRAME* aFrame, const json& aWire )
{
    SCHEMATIC& sch = aFrame->Schematic();

    s_applyingRemote = true;

    SCH_COMMIT commit( aFrame );
    bool       staged = false;

    std::vector<std::string> touched;   // uuids this apply acts on (targeted rebaseline)

    // Owned by nobody once the SKIP_UNDO commit detaches them — freed after Push
    // (fields are hidden, not detached, so excluded). See doApply.
    std::vector<SCH_ITEM*> removedItems;

    for( const json& rid : aWire.value( "removed", json::array() ) )
    {
        SCH_SHEET_PATH path;
        KIID           id( wxString::FromUTF8( rid.get<std::string>().c_str() ) );

        touched.push_back( rid.get<std::string>() );

        if( SCH_ITEM* item = sch.ResolveItem( id, &path, /*allowNull*/ true ) )
        {
            commit.Remove( item, path.LastScreen() );

            if( item->Type() != SCH_FIELD_T )
                removedItems.push_back( item );

            staged = true;
        }
    }

    auto upsert = [&]( const json& w )
    {
        std::string sexpr = w.value( "sexpr", "" );

        if( sexpr.find_first_not_of( " \t\r\n" ) == std::string::npos )
            return;

        // Parse into a throwaway sheet exactly like clipboard paste does. The screen
        // is heap-allocated and owned by the sheet (freed with it).
        SCH_SHEET   tempSheet;
        SCH_SCREEN* tempScreen = new SCH_SCREEN( &sch );
        tempSheet.SetScreen( tempScreen );

        STRING_LINE_READER reader( sexpr, wxT( "collab-items" ) );
        SCH_IO_KICAD_SEXPR plugin;

        try
        {
            plugin.LoadContent( reader, &tempSheet );
        }
        catch( ... )
        {
            EM_ASM( { console.log( "[collab] eeschema applyItems: blob parse failed" ); } );
            return;
        }

        // Resolve a symbol's LIB_SYMBOL: prefer the blob's own (lib_symbols …) cache
        // (a clipboard-style blob carries it), else the live screen's — peers share
        // the same document so the definition is normally already present.
        auto findLib = [&]( SCH_SYMBOL* aSym ) -> LIB_SYMBOL*
        {
            wxString lookup = aSym->GetLibId().Format().wx_str();

            if( !aSym->UseLibIdLookup() )
                lookup = aSym->GetSchSymbolLibraryName();

            auto& tlibs = tempScreen->GetLibSymbols();
            auto  ti    = tlibs.find( lookup );

            if( ti != tlibs.end() )
                return new LIB_SYMBOL( *ti->second );

            auto& libs = aFrame->GetScreen()->GetLibSymbols();
            auto  li   = libs.find( lookup );

            if( li != libs.end() )
                return new LIB_SYMBOL( *li->second );

            return nullptr;
        };

        std::vector<SCH_ITEM*> loaded;

        for( SCH_ITEM* item : tempScreen->Items() )
            loaded.push_back( item );

        for( SCH_ITEM* item : loaded )
        {
            tempScreen->Remove( item );     // detach: tempSheet's dtor must not free it

            SCH_SHEET_PATH path;

            if( SCH_ITEM* existing = sch.ResolveItem( item->m_Uuid, &path, /*allowNull*/ true ) )
            {
                commit.Remove( existing, path.LastScreen() );

                if( existing->Type() != SCH_FIELD_T )
                    removedItems.push_back( existing );
            }

            if( item->Type() == SCH_SYMBOL_T )
            {
                auto* sym = static_cast<SCH_SYMBOL*>( item );

                if( LIB_SYMBOL* lib = findLib( sym ) )
                    sym->SetLibSymbol( lib );
            }

            item->SetParent( &sch );
            touched.push_back( toUtf8( item->m_Uuid.AsString() ) );
            commit.Add( item, aFrame->GetScreen() );
            staged = true;
        }
    };

    for( const json& w : aWire.value( "added", json::array() ) )
        upsert( w );
    for( const json& w : aWire.value( "changed", json::array() ) )
        upsert( w );

    // SKIP_UNDO: remote applies never land on the local undo stack (see doApply).
    if( staged )
        commit.Push( wxT( "Collaborative edit (items)" ), SKIP_UNDO );

    for( SCH_ITEM* item : removedItems )
        delete item;

    // Fold ONLY the applied uuids into the baseline (echo suppression), then flush:
    // anything else that now differs — a concurrent local edit, the connectivity
    // cleanup this apply's Push produced — broadcasts as a normal local diff
    // instead of being swallowed (bug 05).
    rebaselineTouched( aFrame, touched );
    s_applyingRemote = false;
    scheduleFlush();
}

// Test/PoC move (the SCH_COMMIT body for kicadCollabTestMoveFirst, deferred via CallAfter).
void collabTestMove( SCH_EDIT_FRAME* aFrame, SCH_ITEM* aItem, SCH_SCREEN* aScreen, int aDx,
                     int aDy )
{
    SCH_COMMIT commit( aFrame );
    commit.Modify( aItem, aScreen );
    aItem->Move( VECTOR2I( aDx, aDy ) );
    commit.Push( wxT( "Collab test move" ) );
}

} // namespace


// JS → C++. Apply a remote per-item delta by uuid, through SCH_COMMIT so connectivity/
// ERC/hierarchy recompute the same way a UI edit would (0003 §apply).
//
// SCH_COMMIT must run in the editor's Asyncify-rooted main loop — invoking it from this
// embind ccall, or from an emscripten_async_call/setTimeout callback, traps with an
// "indirect call signature mismatch" because those are not the asyncify root (0001 §5).
// wxEvtHandler::CallAfter queues onto the app's pending-event list, which the wasm main
// loop drains every frame via ProcessPendingEvents() (src/wasm/evtloop.cpp) — i.e. the
// exact context real UI edits run in. So defer the whole mutation there.
void schCollabApply( std::string aJson )
{
    // Open-in-flight guard (open_gate.h): never touch the model while a
    // kicadOpenFile Asyncify chain is parked mid-load — commits/virtuals on a
    // half-built schematic mis-dispatch ("indirect call signature mismatch").
    // Callers gate on kicadOpenFileBusy; fuzzed by tests/kicad/collab-load-fuzz.spec.ts.
    if( pcbjam_open::busy() )
        return;

    json delta = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

    if( delta.is_discarded() )
        return;

    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return;

    // Defer to the editor's main-loop context + fiber stack (runOnFiber) so SCH_COMMIT runs
    // like a normal edit: SCH_COMMIT::Push's CHT_ADD of a *new* SCH_SHAPE/SCH_SYMBOL
    // dispatches GAL virtuals (view->Add → ViewGetLayers) through asyncify-instrumented
    // invoke_*; off the fiber stack those mis-dispatch and trap inside KiCad core, which the
    // bridge can't devirtualize. On the fiber stack they dispatch correctly. (0007.)
    pcbjam_collab::runOnFiber( fr, [fr, delta]() { doApply( fr, delta ); } );
}


// JS pull of the full current model as an all-"added" delta (seed/baseline). Also
// registers the change listener on first call.
std::string schCollabSnapshot()
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see schCollabApply
        return json{ { "added", json::array() }, { "changed", json::array() },
                     { "removed", json::array() } }.dump();

    ensureBridge();
    json added = snapshotItems( schFrame() );

    // Seed the diff baseline to exactly the model we're handing out, so the first local edit
    // diffs against this snapshot (and we don't re-broadcast the whole model).
    rebaseline();

    return json{ { "added", added }, { "changed", json::array() },
                 { "removed", json::array() } }.dump();
}


// JS → C++, v2 items wire. Same CallAfter + COROUTINE context as kicadCollabApply
// (LoadContent + SCH_COMMIT must run where native edits run).
void schCollabApplyItems( std::string aJson )
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see schCollabApply
        return;

    json wire = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

    if( wire.is_discarded() )
        return;

    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return;

    pcbjam_collab::runOnFiber( fr, [fr, wire]() { doApplyItems( fr, wire ); } );
}


// JS pull of the ACTIVE screen's model as an all-"added" v2 items wire: one clipboard-
// style blob per item on the current sheet (one collab room == one .kicad_sch screen).
// Registers the listener + rebaselines exactly like kicadCollabSnapshot.
std::string schCollabSnapshotItems()
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see schCollabApply
        return json{ { "added", json::array() }, { "changed", json::array() },
                     { "removed", json::array() } }.dump();

    SCH_EDIT_FRAME* fr = schFrame();

    json added = json::array();

    if( fr )
    {
        ensureBridge();

        if( SCH_SCREEN* screen = currentScreen( fr ) )
        {
            for( SCH_ITEM* item : screen->Items() )
                added.push_back( json{ { "sexpr", itemBlob( fr, item ) }, { "parent", nullptr } } );
        }

        rebaseline();
    }

    return json{ { "added", added }, { "changed", json::array() },
                 { "removed", json::array() } }.dump();
}


// Test/PoC helper: move the first schematic item by (dx,dy) IU via a real SCH_COMMIT,
// firing the listener — a deterministic local edit for the two-tab demo / e2e.
// Returns the moved item's uuid.
std::string schCollabTestMoveFirst( int aDx, int aDy )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return "";

    SCHEMATIC& sch = fr->Schematic();

    for( const SCH_SHEET_PATH& path : sch.Hierarchy() )
    {
        SCH_SCREEN* screen = const_cast<SCH_SHEET_PATH&>( path ).LastScreen();

        if( !screen )
            continue;

        for( SCH_ITEM* item : screen->Items() )
        {
            fr->CallAfter( [fr, item, screen, aDx, aDy]() { collabTestMove( fr, item, screen, aDx, aDy ); } );
            return toUtf8( item->m_Uuid.AsString() );
        }
    }

    return "";
}


// How many placed instances of a library symbol the open schematic holds —
// the JS lib-sync bridge asks after a remote lib update so the editor chrome
// can warn "a symbol you are using changed" (placed SCH_SYMBOLs keep their
// embedded copy across a lib reload, so the user must update explicitly).
// Counts across all unique screens of the hierarchy; 0 without a schematic
// frame (symbol editor / viewer sessions).
int schLibsSymbolUsage( std::string aLibNickname, std::string aSymbolName )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return 0;

    const LIB_ID target( wxString::FromUTF8( aLibNickname.c_str() ),
                         wxString::FromUTF8( aSymbolName.c_str() ) );

    int         count = 0;
    SCH_SCREENS screens( fr->Schematic().Root() );

    for( SCH_SCREEN* screen = screens.GetFirst(); screen; screen = screens.GetNext() )
    {
        for( SCH_ITEM* item : screen->Items().OfType( SCH_SYMBOL_T ) )
        {
            if( static_cast<SCH_SYMBOL*>( item )->GetLibId() == target )
                count++;
        }
    }

    return count;
}


// Test helper: read an item's position by uuid as "x,y" (internal units).
std::string schCollabGetPos( std::string aId )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return "";

    KIID id( wxString::FromUTF8( aId.c_str() ) );

    if( SCH_ITEM* item = fr->Schematic().ResolveItem( id, nullptr, /*allowNull*/ true ) )
    {
        VECTOR2I p = item->GetPosition();
        return std::to_string( p.x ) + "," + std::to_string( p.y );
    }

    return "";
}


// ── ysync-review repro hooks ─────────────────────────────────────────────────
// Local-edit test hooks for the ysync-review repro e2e (docs/features/
// ysync-review on the ysync-review branch): each drives a REAL SCH_COMMIT via
// CallAfter + COROUTINE (the doApply wrapping), so the SCHEMATIC_LISTENER →
// flushDiff emit path runs exactly as for a UI edit. Each returns false when
// the uuid doesn't resolve, letting the spec distinguish "hook missed the
// item" from "differ missed the edit" (bug 04).

// Delete an item by uuid via a real SCH_COMMIT.
bool schCollabTestRemoveItem( std::string aId )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return false;

    SCH_SHEET_PATH path;
    SCH_ITEM* item = fr->Schematic().ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                                  &path, /*allowNull*/ true );

    if( !item )
        return false;

    SCH_SCREEN* screen = path.LastScreen();

    pcbjam_collab::runOnFiber( fr, [fr, item, screen]() {
        SCH_COMMIT commit( fr );
        commit.Remove( item, screen );
        commit.Push( wxT( "Collab test remove" ) );
    } );

    return true;
}

// Rotate an item in place (aDeg snapped to 90° CCW steps) — bug 04: a symbol's
// GetPosition() is unchanged by an in-place rotation and its json carries no
// orientation, so the rotation is invisible to the scalar differ.
bool schCollabTestRotateItem( std::string aId, double aDeg )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return false;

    SCH_SHEET_PATH path;
    SCH_ITEM* item = fr->Schematic().ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                                  &path, /*allowNull*/ true );

    if( !item )
        return false;

    SCH_SCREEN* screen = path.LastScreen();
    int         steps = ( (int) ( aDeg / 90.0 + ( aDeg >= 0 ? 0.5 : -0.5 ) ) % 4 + 4 ) % 4;

    pcbjam_collab::runOnFiber( fr, [fr, item, screen, steps]() {
        SCH_COMMIT commit( fr );
        commit.Modify( item, screen );

        for( int i = 0; i < steps; ++i )
            item->Rotate( item->GetPosition(), /*aRotateCCW*/ true );

        commit.Push( wxT( "Collab test rotate" ) );
    } );

    return true;
}

// Run Edit>Undo / read the undo depth — miss 09; frame-generic, collab_common.h.
bool schCollabTestUndo()
{
    return pcbjam_collab::testUndo( schFrame() );
}

int schCollabTestUndoDepth()
{
    return pcbjam_collab::testUndoDepth( schFrame() );
}

// Set a symbol's Value field text — bug 04: fields live inside the symbol (not
// in screen->Items()) and the symbol json carries no field text, so the most
// common schematic edit after moving things never syncs.
bool schCollabTestSetFieldText( std::string aId, std::string aText )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return false;

    SCH_SHEET_PATH path;
    SCH_ITEM* item = fr->Schematic().ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                                  &path, /*allowNull*/ true );

    if( !item || item->Type() != SCH_SYMBOL_T )
        return false;

    SCH_SYMBOL* sym = static_cast<SCH_SYMBOL*>( item );
    SCH_SCREEN* screen = path.LastScreen();
    wxString    text = wxString::FromUTF8( aText.c_str() );

    pcbjam_collab::runOnFiber( fr, [fr, sym, screen, text]() {
        SCH_COMMIT commit( fr );
        commit.Modify( sym, screen );
        sym->SetValueFieldText( text );
        commit.Push( wxT( "Collab test field text" ) );
    } );

    return true;
}


// ── drift-trio phase B action hooks (standalone-hardening 0008 §5) ───────────
// Creation/mutation primitives for the trio harness's action catalog. Each
// drives a REAL SCH_COMMIT on the fiber stack, so the SCHEMATIC_LISTENER →
// flushDiff emit path runs exactly as for a UI edit. Names are tool-unique
// (registered outside the KICAD_MERGED_EMBIND guard — same convention as
// kicadCollabTestSetFieldText), so the merged image needs no dispatcher.

// Commit a freshly-built item onto the current screen; returns its uuid.
static std::string schCollabTestCommitAdd( SCH_ITEM* aItem, const wxChar* aMsg )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
    {
        delete aItem;
        return "";
    }

    SCH_SCREEN* screen = fr->GetScreen();

    // SCH_COMMIT::Push finds the SCHEMATIC via the ITEM's parent chain and
    // silently skips every listener notification (OnItemsAdded → our emit)
    // when it comes up null — a bare `new SCH_ITEM` has no parent yet, so
    // parent it like the drawing tools do before staging.
    aItem->SetParent( screen );

    std::string id = toUtf8( aItem->m_Uuid.AsString() );
    wxString    msg( aMsg );

    pcbjam_collab::runOnFiber( fr, [fr, aItem, screen, msg]() {
        SCH_COMMIT commit( fr );
        commit.Add( aItem, screen );
        commit.Push( msg );
    } );

    return id;
}

std::string schCollabTestAddWire( int aX1, int aY1, int aX2, int aY2 )
{
    SCH_LINE* line = new SCH_LINE( VECTOR2I( aX1, aY1 ), LAYER_WIRE );
    line->SetEndPoint( VECTOR2I( aX2, aY2 ) );
    return schCollabTestCommitAdd( line, wxT( "Collab test add wire" ) );
}

std::string schCollabTestAddJunction( int aX, int aY )
{
    return schCollabTestCommitAdd( new SCH_JUNCTION( VECTOR2I( aX, aY ) ),
                                   wxT( "Collab test add junction" ) );
}

std::string schCollabTestAddNoConnect( int aX, int aY )
{
    return schCollabTestCommitAdd( new SCH_NO_CONNECT( VECTOR2I( aX, aY ) ),
                                   wxT( "Collab test add no-connect" ) );
}

// aKind: "label" | "global" | "hier".
std::string schCollabTestAddLabel( std::string aKind, std::string aText, int aX, int aY )
{
    wxString        txt = wxString::FromUTF8( aText.c_str() );
    VECTOR2I        pos( aX, aY );
    SCH_LABEL_BASE* label;

    if( aKind == "global" )
        label = new SCH_GLOBALLABEL( pos, txt );
    else if( aKind == "hier" )
        label = new SCH_HIERLABEL( pos, txt );
    else
        label = new SCH_LABEL( pos, txt );

    return schCollabTestCommitAdd( label, wxT( "Collab test add label" ) );
}

// Place another instance of a symbol ALREADY in the schematic's lib_symbols
// cache (the harness fixtures embed their defs — no external lib needed).
std::string schCollabTestAddSymbol( std::string aLibId, int aX, int aY, std::string aRef )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return "";

    SCH_SCREEN* screen = fr->GetScreen();
    wxString    libIdStr = wxString::FromUTF8( aLibId.c_str() );
    LIB_SYMBOL* libSym = nullptr;

    for( const auto& [name, sym] : screen->GetLibSymbols() )
    {
        if( name == libIdStr )
        {
            libSym = sym;
            break;
        }
    }

    if( !libSym )
        return "";

    LIB_ID libId;

    if( libId.Parse( libIdStr ) >= 0 )
        return "";

    SCH_SHEET_PATH& sheet = fr->GetCurrentSheet();
    SCH_SYMBOL* sym = new SCH_SYMBOL( *libSym, libId, &sheet, 1, 1, VECTOR2I( aX, aY ) );
    sym->SetParent( screen );   // Push's SCHEMATIC lookup — see schCollabTestCommitAdd
    sym->SetRef( &sheet, wxString::FromUTF8( aRef.c_str() ) );

    std::string id = toUtf8( sym->m_Uuid.AsString() );

    pcbjam_collab::runOnFiber( fr, [fr, sym, screen]() {
        SCH_COMMIT commit( fr );
        commit.Add( sym, screen );
        commit.Push( wxT( "Collab test add symbol" ) );
    } );

    return id;
}

// By-uuid variant of MoveFirst (same CallAfter + devirtualized move path).
bool schCollabTestMoveSchItem( std::string aId, int aDx, int aDy )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return false;

    SCH_SHEET_PATH probe;
    if( !fr->Schematic().ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ), &probe,
                                      /*allowNull*/ true ) )
        return false;

    // Re-resolve when the deferred body runs: a remote remove can apply in
    // between and the captured pointer would be dangling — the commit would
    // resurrect a deleted item (drift-trio S4 move-vs-delete). Vanished =>
    // the move loses, silently.
    fr->CallAfter( [fr, aId, aDx, aDy]() {
        SCH_SHEET_PATH path;
        SCH_ITEM* item = fr->Schematic().ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                                      &path, /*allowNull*/ true );

        if( item )
            collabTestMove( fr, item, path.LastScreen(), aDx, aDy );
    } );
    return true;
}

bool schCollabTestMirrorSchItem( std::string aId, bool aHorizontal )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return false;

    SCH_SHEET_PATH path;
    SCH_ITEM* item = fr->Schematic().ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                                  &path, /*allowNull*/ true );

    if( !item )
        return false;

    pcbjam_collab::runOnFiber( fr, [fr, aId, aHorizontal]() {   // re-resolve on the fiber (S4)
        SCH_SHEET_PATH path;
        SCH_ITEM* live = fr->Schematic().ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                                      &path, /*allowNull*/ true );

        if( !live )
            return;

        SCH_COMMIT commit( fr );
        commit.Modify( live, path.LastScreen() );

        if( aHorizontal )
            live->MirrorHorizontally( live->GetPosition().x );
        else
            live->MirrorVertically( live->GetPosition().y );

        commit.Push( wxT( "Collab test mirror" ) );
    } );

    return true;
}

// Duplicate (fresh uuids — exercises the Clone()/uuid-churn drift class).
std::string schCollabTestDuplicateSchItem( std::string aId, int aDx, int aDy )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return "";

    SCH_SHEET_PATH path;
    SCH_ITEM* item = fr->Schematic().ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                                  &path, /*allowNull*/ true );

    if( !item )
        return "";

    SCH_SCREEN* screen = path.LastScreen();
    SCH_ITEM*   dup = item->Duplicate( /*addToParentGroup*/ false );
    dup->Move( VECTOR2I( aDx, aDy ) );

    std::string id = toUtf8( dup->m_Uuid.AsString() );

    pcbjam_collab::runOnFiber( fr, [fr, dup, screen]() {
        SCH_COMMIT commit( fr );
        commit.Add( dup, screen );
        commit.Push( wxT( "Collab test duplicate" ) );
    } );

    return id;
}


// Programmatically save the in-memory schematic to a .kicad_sch file, without
// driving the Save As dialog — eeschema's analogue of pl_editor's
// kicadSaveDrawingSheet. Serializes the root sheet via the same SCH_IO_KICAD_SEXPR
// writer eeschema uses, so a test can read the file back from MEMFS and assert the
// file ⇄ Y.Doc round trip (README §A; feature 0004). Single-sheet scope: the round-
// trip fixtures are flat schematics; saving the root sheet writes the whole model.
// C++ → JS save notification (standalone-hardening save routing). Called from the
// kicad fork's save chokepoint (SCH_EDIT_FRAME::saveSchematicFile) after a
// successful write to MEMFS, so the web app can route the saved bytes onward
// (API upload, local-disk write-back, download). No-op without a JS listener.
// KICAD_MERGED_EMBIND: identical definition in pcbnew_embind.cpp; the merged image
// gets the one in kicad_editor_embind.cpp (both fork save chokepoints call it).
#ifndef KICAD_MERGED_EMBIND
extern "C" void kicadCollabOnSave( const char* aPath )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onSave )
            window.kicadCollab.onSave( UTF8ToString( $0 ) );
    }, aPath );
}
#endif // !KICAD_MERGED_EMBIND

// ── presence entry points (collab-presence 0003 — eeschema port of the 0002 set) ────────────

// Install the presence input hooks on the GAL canvas + the fork's soft-lock
// query (idempotent) — shared core. The canvas is the same window across
// sheet navigation, so one install serves the whole session.
void schCollabPresenceStart()
{
    presenceCore().start();
}

// JS → C++: full remote-peers snapshot (same wire as pcbnew's kicadCollabSetRemote).
// Rooms are per-sheet, so the JS rebind pushes a fresh (or empty) snapshot on every
// sheet switch — peers here are always this sheet's.
void schCollabSetRemote( std::string aJson )
{
    presenceCore().setRemote( aJson );
}

// JS → C++ (collab-presence 0005): comment pin dots (same wire as pcbnew).
void schCollabSetPins( std::string aJson )
{
    presenceCore().setPins( aJson );
}

// JS → C++ (presence tuner): live-patch the overlay STYLE and repaint —
// see collab_presence_style.h + pcbnew's counterpart.
void schCollabSetStyle( std::string aJson )
{
    presenceCore().setStyle( aJson );
}

// JS → C++ (comments-ux 0002 F4): live color-theme switch (see pcbjam_theme.h).
void schSetColorTheme( std::string aTheme )
{
    pcbjam_theme::setColorTheme( schFrame(), aTheme );
}

// Pre-main chrome appearance seed (called at onRuntimeInitialized).
void schSetDarkChrome( bool aDark )
{
    pcbjam_theme::setDarkChromeFlag( aDark );
}

// Tuner helper: a VARIED demo-selection set for the current sheet — smallest +
// largest symbol and two bundles of wires (net-ish), mirroring pcbnew's
// pcbCollabTestDemoSet so the style preview shows the range of shapes.
std::string schCollabTestDemoSet()
{
    SCH_EDIT_FRAME* fr = schFrame();

    json groups = json::array();

    if( fr )
    {
        if( SCH_SCREEN* screen = currentScreen( fr ) )
        {
            SCH_SYMBOL* smallest = nullptr;
            SCH_SYMBOL* largest  = nullptr;
            double      minA = 0, maxA = 0;
            std::vector<std::string> wires;

            for( SCH_ITEM* item : screen->Items() )
            {
                if( item->Type() == SCH_SYMBOL_T )
                {
                    BOX2I  bb = item->GetBoundingBox();
                    double a  = (double) bb.GetWidth() * bb.GetHeight();

                    auto* sym = static_cast<SCH_SYMBOL*>( item );

                    if( !smallest || a < minA ) { smallest = sym; minA = a; }
                    if( !largest || a > maxA )  { largest = sym;  maxA = a; }
                }
                else if( item->Type() == SCH_LINE_T && wires.size() < 8 )
                {
                    wires.push_back( toUtf8( item->m_Uuid.AsString() ) );
                }
            }

            if( smallest )
                groups.push_back( { { "label", "symbol small" },
                                    { "ids", { toUtf8( smallest->m_Uuid.AsString() ) } } } );

            if( largest && largest != smallest )
                groups.push_back( { { "label", "symbol large" },
                                    { "ids", { toUtf8( largest->m_Uuid.AsString() ) } } } );

            if( wires.size() >= 2 )
            {
                size_t half = wires.size() / 2;
                groups.push_back( { { "label", "wires A" },
                                    { "ids", std::vector<std::string>( wires.begin(),
                                                                       wires.begin() + half ) } } );
                groups.push_back( { { "label", "wires B" },
                                    { "ids", std::vector<std::string>( wires.begin() + half,
                                                                       wires.end() ) } } );
            }
        }
    }

    return json{ { "groups", groups } }.dump();
}

// Test/tuner helper: the first N item uuids of the CURRENT sheet — real,
// resolvable KIIDs for synthetic remote-selection previews.
std::string schCollabTestListItems( int aCount )
{
    SCH_EDIT_FRAME* fr = schFrame();

    json out = json::array();

    if( fr )
    {
        if( SCH_SCREEN* screen = currentScreen( fr ) )
        {
            for( SCH_ITEM* item : screen->Items() )
            {
                if( (int) out.size() >= aCount )
                    break;

                out.push_back( toUtf8( item->m_Uuid.AsString() ) );
            }
        }
    }

    return out.dump();
}

// JS → C++ (0005): pan the view to a world position (comment panel "jump to pin").
void schCollabSetViewport( double aCx, double aCy )
{
    presenceCore().panTo( aCx, aCy );
}

// JS → C++ (0008 follow-user): fit a leader's world rect into this canvas.
void schCollabFitViewport( double aCx, double aCy, double aHalfW, double aHalfH )
{
    presenceCore().fitViewport( aCx, aCy, aHalfW, aHalfH );
}

// JS pull of the current viewport transform: `{cx,cy,scale,w,h}` with scale = px per
// IU via the GAL matrix (GetScale() is the zoom, not px/IU — pcbnew 0002 lesson).
std::string schCollabGetViewport()
{
    return presenceCore().viewportJson();
}

// JS pull of the CURRENT selection's uuids (presence seed + e2e no-leak probe).
std::string schCollabGetSelection()
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return "[]";

    return presenceCore().selectionUuids( fr ).dump();
}

// JS pull of the current selection in the 0006 payload shape. eeschema has no
// footprint paths — the uuids ARE the symbol uuids — but the export keeps the
// merged image's kicadCollabGetSelectionFull contract uniform across editors.
std::string schCollabGetSelectionFull()
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return "{\"uuids\":[],\"fpPaths\":[]}";

    json payload;
    payload["uuids"]   = presenceCore().selectionUuids( fr );
    payload["fpPaths"] = json::array();
    return payload.dump();
}

// Test probe (0006): the schematic-item uuids the current peers' cross-app
// selections resolve to ON THE CURRENT SHEET — same resolveXsel the render uses.
std::string schCollabTestGetCrossMapped()
{
    json arr = json::array();

    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return arr.dump();

    for( const pcbjam_presence::PEER& peer : presenceCore().peers )
    {
        for( SCH_ITEM* item : resolveXsel( fr, peer ) )
            arr.push_back( toUtf8( item->m_Uuid.AsString() ) );
    }

    return arr.dump();
}

// Test helper: REALLY select the current sheet's first item through the selection
// tool, then run the presence check (programmatic selects close no canvas event).
std::string schCollabTestSelectFirst()
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return "";

    SCH_SCREEN* screen = currentScreen( fr );

    if( !screen )
        return "";

    SCH_ITEM* target = nullptr;

    for( SCH_ITEM* item : screen->Items() )
    {
        target = item;
        break;
    }

    if( !target )
        return "";

    presenceCore().selectItem( target );

    return toUtf8( target->m_Uuid.AsString() );
}

// Test helper (0006): REALLY select the first SYMBOL on the current sheet —
// the deterministic cross-app subject (TestSelectFirst may pick a wire, which
// legitimately maps to nothing in pcbnew). Returns the uuid, "" without one.
std::string schCollabTestSelectComponent()
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return "";

    SCH_SCREEN* screen = currentScreen( fr );

    if( !screen )
        return "";

    SCH_ITEM* target = nullptr;

    for( SCH_ITEM* item : screen->Items().OfType( SCH_SYMBOL_T ) )
    {
        // Power symbols (PWR_FLAG, GND, …) legitimately have no footprint —
        // they'd make the cross-app subject map to nothing by construction.
        if( static_cast<SCH_SYMBOL*>( item )->IsPower() )
            continue;

        target = item;
        break;
    }

    if( !target )
        return "";

    presenceCore().selectItem( target );

    return toUtf8( target->m_Uuid.AsString() );
}

// Test helper (0007): select a SPECIFIC item by uuid — see pcbnew_embind.cpp
// for why the tiebreak specs must not rely on cross-tab iteration order.
bool schCollabTestSelectByUuid( std::string aUuid )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return false;

    SCH_SCREEN* screen = currentScreen( fr );

    if( !screen )
        return false;

    const wxString want = wxString::FromUTF8( aUuid.c_str() );

    for( SCH_ITEM* item : screen->Items() )
    {
        if( item->m_Uuid.AsString() == want )
        {
            presenceCore().selectItem( item );
            return true;
        }
    }

    return false;
}

// JS → C++ (0007): tiebreak release — see pcbnew_embind.cpp for the design
// (cancel-interactive-if-a-tool-holds-them → selective unselect → infobar →
// forced re-emit).
void schCollabReleaseSelection( std::string aUuidsJson, std::string aHolder )
{
    presenceCore().releaseSelection( aUuidsJson, aHolder );
}

// Test probe (0007): the current remote soft-lock set as `[{uuid, name}]`.
std::string schCollabTestGetLocked()
{
    return presenceCore().locksJson();
}

// Test helper: clear the selection through the tool + run the presence check.
bool schCollabTestClearSelection()
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return false;

    fr->CallAfter( [fr]() {
        // ClearSelection is not on the shared SELECTION_TOOL base — the one
        // presence hook that stays editor-typed.
        if( SCH_SELECTION_TOOL* st = fr->GetToolManager()->GetTool<SCH_SELECTION_TOOL>() )
        {
            st->ClearSelection();
            presenceCore().scheduleSelCheck();
        }
    } );

    return true;
}

// Merged-image dispatch probe (kicad_editor_embind.cpp): is the active top window the
// schematic editor? Counterpart of pcbnew_embind.cpp's pcbEditorActive().
bool schEditorActive()
{
    return schFrame() != nullptr;
}


void kicadSaveSchematic( std::string path )
{
    SCH_EDIT_FRAME* fr = schFrame();

    if( !fr )
        return;

    SCHEMATIC& sch = fr->Schematic();

    // Save the CURRENT sheet, not Schematic().Root(): in the wasm open flow the
    // opened document is displayed as the current sheet but can sit under an
    // auto-created project root, so Root()'s own screen holds only a child-sheet
    // symbol (not the loaded items). GetCurrentSheet() is the screen the editor is
    // actually showing — the one whose items the snapshot/round-trip care about.
    SCH_SHEET* sheet = fr->GetCurrentSheet().Last();

    if( !sheet )
        sheet = &sch.Root();

    try
    {
        SCH_IO_KICAD_SEXPR io;
        io.SaveSchematicFile( wxString::FromUTF8( path.c_str() ), sheet, &sch );
    }
    catch( ... )
    {
        // Don't abort the wasm runtime on a save failure; the JS caller detects it
        // by the file being absent / empty.
    }
}


static bool kicadCollabFiberBusyProbe()
{
    return pcbjam_collab::fiberBusy() || !pcbjam_collab::fiberQueue().empty();
}

EMSCRIPTEN_BINDINGS(eeschema) {
    // Programmatic save of the in-memory schematic (round-trip tests, README §A).
    function("kicadSaveSchematic", &kicadSaveSchematic);
    // eeschema-only ysync-review repro hook (name not shared with pcbnew).
    function("kicadCollabTestSetFieldText", &schCollabTestSetFieldText);
    // drift-trio phase B action hooks (tool-unique names, merged-image safe).
    function("kicadCollabTestAddWire", &schCollabTestAddWire);
    function("kicadCollabTestAddJunction", &schCollabTestAddJunction);
    function("kicadCollabTestAddNoConnect", &schCollabTestAddNoConnect);
    function("kicadCollabTestAddLabel", &schCollabTestAddLabel);
    function("kicadCollabTestAddSymbol", &schCollabTestAddSymbol);
    function("kicadCollabTestMoveSchItem", &schCollabTestMoveSchItem);
    function("kicadCollabTestMirrorSchItem", &schCollabTestMirrorSchItem);
    function("kicadCollabTestDuplicateSchItem", &schCollabTestDuplicateSchItem);

#ifndef KICAD_MERGED_EMBIND
    // JS names ALSO registered by pcbnew_embind.cpp — in the merged image these are
    // registered once by kicad_editor_embind.cpp, dispatching on the active frame.
    // Programmatic file open (preferred over UI automation from the web app).
    function("kicadOpenFile", &kicadOpenFile PCBJAM_PARKER_POLICY);
    function("kicadOpenFileBusy", &kicadOpenFileBusy);
    function("kicadTestSetOpenPark", &kicadTestSetOpenPark);
    function("kicadCollabFiberBusy", &kicadCollabFiberBusyProbe);
    // Read-only viewer lock (read-only-viewer).
    function("kicadSetReadOnly", &kicadSetReadOnly);
    // Yjs collaborative bridge entry points (same contract as pl_editor).
    function("kicadCollabApply", &schCollabApply);
    function("kicadCollabSnapshot", &schCollabSnapshot);
    // v2 items bridge: per-item s-expr payloads (ysync 0008).
    function("kicadCollabApplyItems", &schCollabApplyItems);
    function("kicadCollabSnapshotItems", &schCollabSnapshotItems);
    function("kicadCollabTestMoveFirst", &schCollabTestMoveFirst);
    function("kicadCollabGetPos", &schCollabGetPos);
    // ysync-review repro hooks shared with pcbnew (dispatched when merged).
    function("kicadCollabTestRemoveItem", &schCollabTestRemoveItem);
    function("kicadCollabTestRotateItem", &schCollabTestRotateItem);
    function("kicadCollabTestUndo", &schCollabTestUndo);
    function("kicadCollabTestUndoDepth", &schCollabTestUndoDepth);
    // Presence (collab-presence 0003) — shared names with pcbnew's 0002 set.
    function("kicadCollabPresenceStart", &schCollabPresenceStart);
    function("kicadCollabSetRemote", &schCollabSetRemote);
    function("kicadCollabSetPins", &schCollabSetPins);
    function("kicadCollabSetViewport", &schCollabSetViewport);
    // Follow-user (collab-presence 0008).
    function("kicadCollabFitViewport", &schCollabFitViewport);
    function("kicadCollabSetStyle", &schCollabSetStyle);
    // Live color-theme switch (comments-ux 0002 F4).
    function("kicadSetColorTheme", &schSetColorTheme);
    function("kicadSetDarkChrome", &schSetDarkChrome);
    function("kicadCollabTestListItems", &schCollabTestListItems);
    function("kicadCollabTestDemoSet", &schCollabTestDemoSet);
    function("kicadCollabGetViewport", &schCollabGetViewport);
    function("kicadCollabGetSelection", &schCollabGetSelection);
    // Cross-app selection (0006).
    function("kicadCollabGetSelectionFull", &schCollabGetSelectionFull);
    function("kicadCollabTestGetCrossMapped", &schCollabTestGetCrossMapped);
    // Selection soft-locks (0007).
    function("kicadCollabReleaseSelection", &schCollabReleaseSelection);
    function("kicadCollabTestGetLocked", &schCollabTestGetLocked);
    function("kicadCollabTestSelectFirst", &schCollabTestSelectFirst);
    function("kicadCollabTestSelectComponent", &schCollabTestSelectComponent);
    function("kicadCollabTestSelectByUuid", &schCollabTestSelectByUuid);
    function("kicadCollabTestClearSelection", &schCollabTestClearSelection);
    // Library reload after a remote (synced) lib edit — r2-idb-sync realtime.
    function("kicadLibsReload", &pcbjam_libs::reloadLibrary PCBJAM_PARKER_POLICY);
    // Placed-instance count for a library symbol (drives the "a symbol you are
    // using was updated" toast after a remote lib edit).
    function("kicadLibsSymbolUsage", &schLibsSymbolUsage);
#endif // !KICAD_MERGED_EMBIND
}
#endif
