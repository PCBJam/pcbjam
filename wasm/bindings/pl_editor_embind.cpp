/*
 * Embind bindings for KiCad pl_editor (drawing-sheet / page-layout editor) WASM.
 *
 * Picked up automatically by scripts/kicad/build-kicad-target.sh when building
 * the pl_editor app (it compiles wasm/bindings/<app>_embind.cpp if present).
 */

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/bind.h>
#include <kiway_player.h>
#include <kiway.h>
#include <map>
#include <string>
#include <vector>
#include <wx/app.h>
#include <wx/string.h>
#include <wx/window.h>
#include <nlohmann/json.hpp>
#include "open_gate.h"
#include "pcbjam_async_policy.h"
#include <eda_draw_frame.h>
#include <kiid.h>
#include <pcbjam_read_only.h>
#include <project.h>
#include <font/text_attributes.h>
#include <drawing_sheet/ds_data_model.h>
#include <drawing_sheet/ds_data_item.h>
#include <drawing_sheet/ds_file_versions.h>

using namespace emscripten;
using json = nlohmann::json;

// Programmatically open a drawing-sheet file (.kicad_wks) in the running editor
// frame, without UI automation. Mirrors single_top.cpp's MacOpenFile path: the
// editor frame is the app's top window and is a KIWAY_PLAYER (PL_EDITOR_FRAME
// overrides OpenProjectFiles). Returns the result of OpenProjectFiles, or false
// if no frame is available — letting the JS caller fall back to driving
// File→Open.
bool kicadOpenFile( std::string path )
{
    // Held across every suspension of the load; see open_gate.h.
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
// collab attach until the open chain has truly completed.
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

// Programmatically save the in-memory drawing sheet to a .kicad_wks file, without
// driving the Save As dialog. pl_editor edits the process-wide singleton
// DS_DATA_MODEL::GetTheInstance(), so this serializes exactly what the editor has
// loaded — letting a test read the file back from MEMFS and assert the (uuid …)
// round-trip / backfill. (Also a building block for the collab bridge's later
// materialize-to-file path.)
void kicadSaveDrawingSheet( std::string path )
{
    DS_DATA_MODEL::GetTheInstance().Save( wxString::FromUTF8( path.c_str() ) );
}

// ───────────────────────────── Yjs collaborative bridge ─────────────────────────────
//
// pl_editor's half of the unified bridge contract (features/yjs-bridge/0001-0002).
// This lives in the wasm layer (not the kicad fork) so fork divergence stays at the
// single OnModify() hook; everything below uses only public DS_DATA_MODEL / DS_DATA_ITEM
// API. The contract is a per-item delta { added:[item], changed:[item], removed:[uuid] }
// where each item is { id, type, …fields }. text/segment/rect use decomposed scalars
// (field-level merge); polygon/bitmap reuse the native per-item s-expr serializer as an
// opaque `sexpr` blob (item-level merge) — see 0002 §field-mapping.
//
//  C++ → JS (emit):  OnModify → kicadCollabOnModify → snapshot-diff → window.kicadCollab.onDelta(json)
//  JS → C++ (apply): peer delta → Module.kicadCollabApply(json) → mutate model by uuid → HardRedraw
//
namespace {

// Guard: set around apply() so the differ ignores model mutations we caused ourselves
// (apply → HardRedraw/OnModify → differ would otherwise echo them back). 0001 §5.
bool s_applyingRemote = false;

// Last-emitted item-set, keyed by uuid → its field json. The differ's baseline.
std::map<std::string, json> s_snapshot;

std::string toUtf8( const wxString& s ) { return std::string( s.utf8_str() ); }

const char* typeStr( DS_DATA_ITEM::DS_ITEM_TYPE t )
{
    switch( t )
    {
    case DS_DATA_ITEM::DS_TEXT:       return "text";
    case DS_DATA_ITEM::DS_SEGMENT:    return "segment";
    case DS_DATA_ITEM::DS_RECT:       return "rect";
    case DS_DATA_ITEM::DS_POLYPOLYGON:return "polygon";
    case DS_DATA_ITEM::DS_BITMAP:     return "bitmap";
    }
    return "unknown";
}

EDA_DRAW_FRAME* topFrame()
{
    return wxTheApp ? dynamic_cast<EDA_DRAW_FRAME*>( wxTheApp->GetTopWindow() ) : nullptr;
}

DS_DATA_ITEM* findByUuid( DS_DATA_MODEL& aModel, const std::string& aId )
{
    for( DS_DATA_ITEM* it : aModel.GetItems() )
    {
        if( toUtf8( it->m_Uuid.AsString() ) == aId )
            return it;
    }
    return nullptr;
}

// Serialize one item to its opaque s-expr blob via the native per-item formatter. The
// blob already carries (uuid …), so a string compare detects any field change and the
// blob re-parses to a fully-formed item on apply. (0002 mechanism 2.)
std::string itemBlob( DS_DATA_ITEM* aItem )
{
    std::vector<DS_DATA_ITEM*> one{ aItem };
    wxString                   str;
    DS_DATA_MODEL::GetTheInstance().SaveInString( one, &str );
    return toUtf8( str );
}

json itemToJson( DS_DATA_ITEM* aItem )
{
    json j;
    j["id"]     = toUtf8( aItem->m_Uuid.AsString() );
    j["type"]   = typeStr( aItem->GetType() );
    j["name"]   = toUtf8( aItem->m_Name );
    j["x"]      = aItem->m_Pos.m_Pos.x;       // mm (model's native units for data items)
    j["y"]      = aItem->m_Pos.m_Pos.y;
    j["anchor"] = aItem->m_Pos.m_Anchor;

    switch( aItem->GetType() )
    {
    case DS_DATA_ITEM::DS_TEXT:
    {
        auto* t = static_cast<DS_DATA_ITEM_TEXT*>( aItem );
        j["text"]     = toUtf8( t->m_TextBase );
        j["orient"]   = t->m_Orient;
        j["hjustify"] = (int) t->m_Hjustify;
        j["vjustify"] = (int) t->m_Vjustify;
        j["italic"]   = t->m_Italic;
        j["bold"]     = t->m_Bold;
        j["sizeX"]    = t->m_TextSize.x;
        j["sizeY"]    = t->m_TextSize.y;
        break;
    }
    case DS_DATA_ITEM::DS_SEGMENT:
    case DS_DATA_ITEM::DS_RECT:
        j["ex"]        = aItem->m_End.m_Pos.x;
        j["ey"]        = aItem->m_End.m_Pos.y;
        j["eanchor"]   = aItem->m_End.m_Anchor;
        j["linewidth"] = aItem->m_LineWidth;
        break;

    case DS_DATA_ITEM::DS_POLYPOLYGON:
    case DS_DATA_ITEM::DS_BITMAP:
        j["sexpr"] = itemBlob( aItem );        // opaque; item-level merge
        break;
    }

    return j;
}

std::map<std::string, json> snapshotMap()
{
    std::map<std::string, json> out;

    for( DS_DATA_ITEM* it : DS_DATA_MODEL::GetTheInstance().GetItems() )
        out[ toUtf8( it->m_Uuid.AsString() ) ] = itemToJson( it );

    return out;
}

void emit( const json& aDelta )
{
    std::string s = aDelta.dump();
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onDelta )
            window.kicadCollab.onDelta( UTF8ToString( $0 ) );
    }, s.c_str() );
}

// v2 "items" wire emit (ysync 0008): per-item s-expr blobs instead of decomposed
// scalars. A JS runtime registers window.kicadCollab.onItems to opt in; both wires
// are emitted side by side until the scalar path is retired.
void emitItems( const json& aWire )
{
    std::string s = aWire.dump();
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onItems )
            window.kicadCollab.onItems( UTF8ToString( $0 ) );
    }, s.c_str() );
}

// One items-wire entry for a live item: its native blob (SaveInString — a
// self-contained `(kicad_wks …)` envelope; the TS side unwraps). pl_editor's
// model is flat, so parent is always null.
json wireItemFor( DS_DATA_ITEM* aItem )
{
    return json{ { "sexpr", itemBlob( aItem ) }, { "parent", nullptr } };
}

// Apply scalar fields from json onto an existing scalar item (text/segment/rect).
void applyFields( DS_DATA_ITEM* aItem, const json& j )
{
    if( j.contains( "name" ) )   aItem->m_Name        = wxString::FromUTF8( std::string( j["name"] ).c_str() );
    if( j.contains( "x" ) )      aItem->m_Pos.m_Pos.x = j["x"].get<double>();
    if( j.contains( "y" ) )      aItem->m_Pos.m_Pos.y = j["y"].get<double>();
    if( j.contains( "anchor" ) ) aItem->m_Pos.m_Anchor = j["anchor"].get<int>();

    switch( aItem->GetType() )
    {
    case DS_DATA_ITEM::DS_TEXT:
    {
        auto* t = static_cast<DS_DATA_ITEM_TEXT*>( aItem );
        if( j.contains( "text" ) )     t->m_TextBase = wxString::FromUTF8( std::string( j["text"] ).c_str() );
        if( j.contains( "orient" ) )   t->m_Orient   = j["orient"].get<double>();
        if( j.contains( "hjustify" ) ) t->m_Hjustify = (GR_TEXT_H_ALIGN_T) j["hjustify"].get<int>();
        if( j.contains( "vjustify" ) ) t->m_Vjustify = (GR_TEXT_V_ALIGN_T) j["vjustify"].get<int>();
        if( j.contains( "italic" ) )   t->m_Italic   = j["italic"].get<bool>();
        if( j.contains( "bold" ) )     t->m_Bold     = j["bold"].get<bool>();
        if( j.contains( "sizeX" ) )    t->m_TextSize.x = j["sizeX"].get<double>();
        if( j.contains( "sizeY" ) )    t->m_TextSize.y = j["sizeY"].get<double>();
        break;
    }
    case DS_DATA_ITEM::DS_SEGMENT:
    case DS_DATA_ITEM::DS_RECT:
        if( j.contains( "ex" ) )        aItem->m_End.m_Pos.x  = j["ex"].get<double>();
        if( j.contains( "ey" ) )        aItem->m_End.m_Pos.y  = j["ey"].get<double>();
        if( j.contains( "eanchor" ) )   aItem->m_End.m_Anchor = j["eanchor"].get<int>();
        if( j.contains( "linewidth" ) ) aItem->m_LineWidth    = j["linewidth"].get<double>();
        break;

    default:
        break;
    }
}

DS_DATA_ITEM* createScalarItem( const std::string& aType )
{
    if( aType == "text" )    return new DS_DATA_ITEM_TEXT( wxEmptyString );
    if( aType == "segment" ) return new DS_DATA_ITEM( DS_DATA_ITEM::DS_SEGMENT );
    if( aType == "rect" )    return new DS_DATA_ITEM( DS_DATA_ITEM::DS_RECT );
    return nullptr;
}

// Reconstruct a polygon/bitmap from its opaque blob by appending it through the normal
// parser (the blob is a self-contained mini (kicad_wks …) model). Its (uuid …) round-trips.
void addBlob( DS_DATA_MODEL& aModel, const json& j )
{
    if( !j.contains( "sexpr" ) )
        return;

    std::string sexpr = j["sexpr"];
    aModel.SetPageLayout( sexpr.c_str(), /*aAppend*/ true, wxT( "collab-blob" ) );
}

} // namespace


// JS → C++. Apply a remote per-item delta to the model, by uuid. Guarded so the
// resulting model mutations are not re-emitted as local changes.
void kicadCollabApply( std::string aJson )
{
    // Open-in-flight guard (open_gate.h): never touch the model while a
    // kicadOpenFile chain is suspended mid-load; see kicadOpenFileBusy.
    if( pcbjam_open::busy() )
        return;

    json delta = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

    if( delta.is_discarded() )
        return;

    s_applyingRemote = true;

    DS_DATA_MODEL& model = DS_DATA_MODEL::GetTheInstance();

    for( const json& rid : delta.value( "removed", json::array() ) )
    {
        if( DS_DATA_ITEM* item = findByUuid( model, rid.get<std::string>() ) )
        {
            model.Remove( item );
            delete item;
        }
    }

    for( const json& j : delta.value( "changed", json::array() ) )
    {
        std::string id   = j.value( "id", "" );
        std::string type = j.value( "type", "" );
        DS_DATA_ITEM* item = findByUuid( model, id );

        if( type == "polygon" || type == "bitmap" )
        {
            // Blob items merge at item granularity: replace wholesale.
            if( item )
            {
                model.Remove( item );
                delete item;
            }

            addBlob( model, j );
        }
        else if( item )
        {
            applyFields( item, j );
        }
    }

    for( const json& j : delta.value( "added", json::array() ) )
    {
        std::string id   = j.value( "id", "" );
        std::string type = j.value( "type", "" );

        if( !id.empty() && findByUuid( model, id ) )
            continue;                       // already present (our own echo)

        if( type == "polygon" || type == "bitmap" )
        {
            addBlob( model, j );
        }
        else if( DS_DATA_ITEM* item = createScalarItem( type ) )
        {
            item->m_Uuid = KIID( wxString::FromUTF8( id.c_str() ) );
            applyFields( item, j );
            model.Append( item );
        }
    }

    // Rebase the differ on the post-apply state so our own mutations aren't echoed,
    // then rebuild the GAL view from the model. (Selection re-acquire by uuid is a
    // deferred refinement — 0002.)
    s_snapshot = snapshotMap();

    if( EDA_DRAW_FRAME* fr = topFrame() )
        fr->HardRedraw();

    s_applyingRemote = false;
}


// C++ → JS. The snapshot-differ ChangeSource: derive per-item add/remove/change events
// by diffing the current model against the last-emitted snapshot, then emit the delta.
// Called from PL_EDITOR_FRAME::OnModify() (pl_editor's single change chokepoint).
extern "C" void kicadCollabOnModify()
{
    if( s_applyingRemote )
        return;

    std::map<std::string, json> cur = snapshotMap();

    json added   = json::array();
    json changed = json::array();
    json removed = json::array();

    // v2 items wire (per-item s-expr blobs), built from the same diff.
    json wAdded   = json::array();
    json wChanged = json::array();

    DS_DATA_MODEL& model = DS_DATA_MODEL::GetTheInstance();

    for( const auto& [id, j] : cur )
    {
        auto prev = s_snapshot.find( id );

        if( prev == s_snapshot.end() )
        {
            added.push_back( j );

            if( DS_DATA_ITEM* item = findByUuid( model, id ) )
                wAdded.push_back( wireItemFor( item ) );
        }
        else if( prev->second != j )
        {
            changed.push_back( j );

            if( DS_DATA_ITEM* item = findByUuid( model, id ) )
                wChanged.push_back( wireItemFor( item ) );
        }
    }

    for( const auto& [id, j] : s_snapshot )
    {
        if( !cur.count( id ) )
            removed.push_back( id );
    }

    s_snapshot = std::move( cur );

    if( added.empty() && changed.empty() && removed.empty() )
        return;

    emit( json{ { "added", added }, { "changed", changed }, { "removed", removed } } );
    emitItems( json{ { "added", wAdded }, { "changed", wChanged }, { "removed", removed } } );
}


// C++ → JS save notification (standalone-hardening save routing). Called from the
// kicad fork's save chokepoint (PL_EDITOR_FRAME::SaveDrawingSheetFile) after a
// successful write to MEMFS, so the web app can route the saved bytes onward
// (API upload, local-disk write-back, download). No-op without a JS listener.
extern "C" void kicadCollabOnSave( const char* aPath )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onSave )
            window.kicadCollab.onSave( UTF8ToString( $0 ) );
    }, aPath );
}


// JS pull of the full current model as an all-"added" delta, used to seed the Y.Doc on
// join and to (re)baseline the differ. Idempotent.
std::string kicadCollabSnapshot()
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see kicadCollabApply
        return json{ { "added", json::array() }, { "changed", json::array() },
                     { "removed", json::array() } }.dump();

    std::map<std::string, json> cur = snapshotMap();

    json added = json::array();

    for( const auto& [id, j] : cur )
        added.push_back( j );

    s_snapshot = cur;

    return json{ { "added", added }, { "changed", json::array() },
                 { "removed", json::array() } }.dump();
}


// ── v2 "items" bridge: per-item s-expr (ysync 0008 Stage C) ─────────────────────────
//
// Same contract as the scalar bridge but the payload is each item's full native
// s-expr blob: { added: [{sexpr, parent}], changed: [...], removed: [uuid] }.
// Blobs are SaveInString envelopes; apply accepts both enveloped and bare items.

// JS pull of the full current model as an all-"added" items wire. Rebaselines the
// differ exactly like kicadCollabSnapshot, so a v2 consumer gets no echo either.
std::string kicadCollabSnapshotItems()
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see kicadCollabApply
        return json{ { "added", json::array() }, { "changed", json::array() },
                     { "removed", json::array() } }.dump();

    DS_DATA_MODEL& model = DS_DATA_MODEL::GetTheInstance();

    json added = json::array();

    for( DS_DATA_ITEM* item : model.GetItems() )
        added.push_back( wireItemFor( item ) );

    s_snapshot = snapshotMap();

    return json{ { "added", added }, { "changed", json::array() },
                 { "removed", json::array() } }.dump();
}


// JS → C++. Apply a remote items wire: removed by uuid; added/changed are an
// idempotent per-item upsert — append the blob through the normal parser, then
// drop any pre-existing item that shares an appended uuid (replace-by-uuid).
void kicadCollabApplyItems( std::string aJson )
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see kicadCollabApply
        return;

    json wire = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

    if( wire.is_discarded() )
        return;

    s_applyingRemote = true;

    DS_DATA_MODEL& model = DS_DATA_MODEL::GetTheInstance();

    for( const json& rid : wire.value( "removed", json::array() ) )
    {
        if( DS_DATA_ITEM* item = findByUuid( model, rid.get<std::string>() ) )
        {
            model.Remove( item );
            delete item;
        }
    }

    auto upsert = [&]( const json& w )
    {
        std::string sexpr = w.value( "sexpr", "" );

        if( sexpr.empty() )
            return;

        // Bare items (e.g. rendered from the Y.Doc Slot body) get the envelope the
        // drawing-sheet parser requires; peer-emitted blobs already carry it.
        if( sexpr.rfind( "(kicad_wks", 0 ) != 0 )
        {
            sexpr = "(kicad_wks (version " + std::to_string( SEXPR_WORKSHEET_FILE_VERSION )
                    + ") (generator \"pl_editor\") " + sexpr + ")";
        }

        // Snapshot the pre-append item pointers, then append through the parser.
        std::vector<DS_DATA_ITEM*> before = model.GetItems();
        model.SetPageLayout( sexpr.c_str(), /*aAppend*/ true, wxT( "collab-items" ) );

        // Replace-by-uuid: drop any pre-existing item sharing a newly appended uuid.
        // Work on pointer snapshots — model.Remove() mutates the live vector.
        std::vector<DS_DATA_ITEM*> appended( model.GetItems().begin() + before.size(),
                                             model.GetItems().end() );

        for( DS_DATA_ITEM* neu : appended )
        {
            for( DS_DATA_ITEM* old : before )
            {
                if( old->m_Uuid == neu->m_Uuid )
                {
                    model.Remove( old );
                    delete old;
                    break;
                }
            }
        }
    };

    for( const json& w : wire.value( "added", json::array() ) )
        upsert( w );
    for( const json& w : wire.value( "changed", json::array() ) )
        upsert( w );

    // Rebase the differ on the post-apply state so our own mutations aren't echoed,
    // then rebuild the GAL view from the model.
    s_snapshot = snapshotMap();

    if( EDA_DRAW_FRAME* fr = topFrame() )
        fr->HardRedraw();

    s_applyingRemote = false;
}


// Test/PoC helper: perform a genuine local text insert (the same model mutation a
// PL_DRAWING_TOOLS::PlaceItem(DS_TEXT) UI click produces — 0002 §text-insert path) and
// fire OnModify, so the differ emits an `added` delta. Lets a two-tab demo / e2e create
// a deterministic local edit in one tab and observe it propagate, without canvas UI
// automation. Returns the new item's uuid.
std::string kicadCollabTestAddText( std::string aText, double aX, double aY )
{
    DS_DATA_MODEL& model = DS_DATA_MODEL::GetTheInstance();

    auto* item = new DS_DATA_ITEM_TEXT( wxString::FromUTF8( aText.c_str() ) );
    item->m_Pos.m_Pos.x = aX;
    item->m_Pos.m_Pos.y = aY;
    item->m_Pos.m_Anchor = LT_CORNER;
    model.Append( item );

    if( EDA_DRAW_FRAME* fr = topFrame() )
    {
        fr->OnModify();      // -> kicadCollabOnModify -> emit added
        fr->HardRedraw();    // show it locally
    }

    return toUtf8( item->m_Uuid.AsString() );
}

EMSCRIPTEN_BINDINGS(pl_editor) {
    // Programmatic file open (preferred over UI automation from the web app).
    function("kicadOpenFile", &kicadOpenFile PCBJAM_PARKER_POLICY);
    function("kicadOpenFileBusy", &kicadOpenFileBusy);
    function("kicadTestSetOpenPark", &kicadTestSetOpenPark);
    // Read-only viewer lock (read-only-viewer).
    function("kicadSetReadOnly", &kicadSetReadOnly);
    function("kicadSaveDrawingSheet", &kicadSaveDrawingSheet);
    // Yjs collaborative bridge entry points.
    function("kicadCollabApply", &kicadCollabApply);
    function("kicadCollabSnapshot", &kicadCollabSnapshot);
    // v2 items bridge: per-item s-expr payloads (ysync 0008).
    function("kicadCollabApplyItems", &kicadCollabApplyItems);
    function("kicadCollabSnapshotItems", &kicadCollabSnapshotItems);
    function("kicadCollabTestAddText", &kicadCollabTestAddText);
}
#endif
