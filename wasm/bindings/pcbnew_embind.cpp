/*
 * Embind bindings for KiCad WASM
 * Exposes core PCBnew objects to JavaScript
 *
 * This provides a foundation for future Pyodide integration.
 *
 * Note: GetBoard() is not available when KICAD_SCRIPTING=OFF.
 * These bindings expose the classes for use when a board reference
 * is obtained through other means (e.g., from the UI).
 */

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/bind.h>
#include <board.h>
#include <board_commit.h>
#include <pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h>
#include <board_item.h>
#include <footprint.h>
#include <pad.h>
#include <pcb_track.h>
#include <pcb_field.h>
#include <pcb_shape.h>
#include <pcb_text.h>
#include <pcb_group.h>
#include <zone.h>
#include <eda_text.h>
#include <pcb_edit_frame.h>
#include <kicad_clipboard.h>
#include <io/kicad/kicad_io_utils.h>
#include <richio.h>
#include <tools/pcb_selection.h>
#include <tools/pcb_selection_tool.h>
#include <geometry/shape_poly_set.h>
#include <geometry/shape_line_chain.h>
#include <geometry/eda_angle.h>
#include <kiway_player.h>
#include <kiway.h>
#include <kiid.h>
#include <layer_ids.h>
#include <lset.h>
#include <math/util.h>
#include <tool/actions.h>
#include <tool/coroutine.h>
#include <tool/tool_manager.h>
#include <pcbjam_remote_lock.h>
#include <pcbjam_read_only.h>
#include <project.h>
#include <view/view.h>
#include <view/view_overlay.h>
#include <pcb_draw_panel_gal.h>
#include <nlohmann/json.hpp>
#include "collab_common.h"
#include "collab_presence_core.h"
#include "open_gate.h"
#include "collab_presence_style.h"
#include "pcbjam_theme.h"
#include "pcbjam_libs_reload.h"
#include <algorithm>
#include <chrono>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>
#include <wx/app.h>
#include <wx/event.h>
#include <wx/string.h>
#include <wx/window.h>

using namespace emscripten;
using json = nlohmann::json;

// Programmatically open a project file (board/schematic) in the running editor
// frame, without UI automation. Mirrors single_top.cpp's MacOpenFile path:
// the editor frame is the app's top window and is a KIWAY_PLAYER. Returns the
// result of OpenProjectFiles, or false if no frame is available — letting the
// JS caller fall back to driving File→Open.
//
// KICAD_MERGED_EMBIND (kicad_editor, editor-unification Part 2): eeschema_embind.cpp
// defines the identical function and registers the same JS names — in the merged image
// the frame-agnostic duplicates (this + kicadCollabOnSave) and the shared-name
// registrations live once in kicad_editor_embind.cpp, which dispatches the per-editor
// entries (renamed pcbCollab*/schCollab* below; JS-facing names are unchanged).
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
// pcbnew's half of the unified bridge contract (features/yjs-bridge 0001, 0004). Like
// eeschema it needs NO kicad-fork change: BOARD_ITEM already carries a stable KIID, and
// pcbnew has native change machinery, so the adapter is a thin re-use of public API:
//   ChangeSource (emit) = a BOARD_LISTENER subclass (BOARD_COMMIT::Push fires it)
//   apply              = BOARD_COMMIT Add/Modify/Remove + Push (drives connectivity +
//                        ratsnest recompute — mandatory on pcbnew, 0004 §apply)
// The generic JS reconciler / transport / WasmTool wiring are reused unchanged, and the
// emit/apply structure mirrors the (battle-tested) eeschema bridge:
//   - emit  = a POST-SETTLE snapshot DIFF (the listener is just a "something changed"
//             trigger; the real change set is a diff of the full model taken after the
//             edit's BOARD_COMMIT::Push — connectivity cleanup included — has returned,
//             so peers converge by re-applying already-clean geometry). See eeschema 0007.
//   - apply = BOARD_COMMIT run inside a CallAfter + COROUTINE fiber stack, the exact
//             context native tool edits run in, so GAL view->Add of a freshly-constructed
//             item dispatches its asyncify-instrumented virtuals correctly (eeschema 0007).
//
// Scope of this first commit (0004 §"first PoC", matching eeschema commit-3's first cut):
// position/geometry sync of existing items — changed (move/reshape) and removed work for
// ANY top-level item by uuid; `added` reconstructs PCB_TRACK segments natively. Footprint/
// via/zone `added` (which need a library or the s-expr clipboard blob, same class as the
// deferred SCH_SYMBOL add) are logged + skipped until a later commit. Net assignment +
// ratsnest are recomputed by BOARD_COMMIT::Push regardless.
namespace {

// Guard so BOARD_COMMIT::Push's listener callbacks during apply() aren't re-emitted.
bool s_applyingRemote = false;

using pcbjam_collab::toUtf8;

PCB_EDIT_FRAME* pcbFrame()
{
    return wxTheApp ? dynamic_cast<PCB_EDIT_FRAME*>( wxTheApp->GetTopWindow() ) : nullptr;
}

bool isTrackType( KICAD_T t )
{
    return t == PCB_TRACE_T || t == PCB_ARC_T || t == PCB_VIA_T;
}

// Read an item's layer WITHOUT the virtual GetLayer(). That virtual mis-dispatches in the
// non-coroutine emit/snapshot context — it returns 0 (F_Cu) for EVERY item (the same asyncify
// call_indirect class as eeschema's Move()), which silently put every collab-added item/track/
// text on the top copper layer on the peer. A class-qualified `BOARD_ITEM::GetLayer()` is a
// statically-bound (direct) call that just reads m_layer, bypassing call_indirect. Zones keep
// their layer in m_layerSet (not m_layer), so use their non-virtual GetFirstLayer().
int itemLayer( BOARD_ITEM* aItem )
{
    if( aItem->Type() == PCB_ZONE_T )
        return (int) static_cast<ZONE*>( aItem )->GetFirstLayer();

    return (int) aItem->BOARD_ITEM::GetLayer();
}

// Iterate every board item the bridge syncs: the top-level items (tracks, footprints, drawings,
// zones, groups) PLUS each footprint's TEXT children (fields = reference/value/user, and graphic
// PCB_TEXT). The text children are visited by their OWN uuid because a silkscreen reference/value
// can be moved *independently* of its footprint (the footprint origin doesn't change, so syncing
// the footprint as a unit would miss it). Pads and footprint graphic shapes are NOT visited — they
// move only with the footprint. All these uuids live in BOARD::m_itemByIdCache, so apply resolves
// them directly. On a whole-footprint move the children also re-appear in the diff (their absolute
// positions changed); that's redundant but convergent, since apply uses absolute SetPosition.
template <typename Fn>
void forEachTopItem( BOARD& aBoard, Fn&& aFn )
{
    for( PCB_TRACK* t : aBoard.Tracks() )       aFn( static_cast<BOARD_ITEM*>( t ) );

    for( FOOTPRINT* f : aBoard.Footprints() )
    {
        aFn( static_cast<BOARD_ITEM*>( f ) );

        for( PCB_FIELD* fld : f->GetFields() )
        {
            if( fld )
                aFn( static_cast<BOARD_ITEM*>( fld ) );
        }

        for( BOARD_ITEM* g : f->GraphicalItems() )
        {
            if( g->Type() == PCB_TEXT_T )
                aFn( g );
        }
    }

    for( BOARD_ITEM* d : aBoard.Drawings() )    aFn( d );
    for( ZONE* z : aBoard.Zones() )             aFn( static_cast<BOARD_ITEM*>( z ) );
    for( PCB_GROUP* g : aBoard.Groups() )       aFn( static_cast<BOARD_ITEM*>( g ) );
}

// The diff/wire unit for one board item: the fields apply() can act on. Tracks carry their two
// endpoints + width (they reshape, like an eeschema SCH_LINE); everything else syncs position.
// Deliberately NO opaque s-expr blob here — keeping the diff unit to the applicable fields
// avoids broadcasting `changed` entries the peer can only partially apply (which would diverge
// then loop). Added-item reconstruction is handled type-by-type in makeItem instead.
json itemToJson( BOARD_ITEM* aItem )
{
    VECTOR2I p = aItem->GetPosition();
    json     j = {
        { "id", toUtf8( aItem->m_Uuid.AsString() ) },
        { "type", toUtf8( aItem->GetClass() ) },
        { "x", p.x },   // internal units (nm); integral, no quantization needed
        { "y", p.y },
        { "layer", itemLayer( aItem ) },   // devirtualized — aItem->GetLayer() mis-dispatches here
    };

    // Parent footprint uuid (or absent for roots). Carried in the baseline so a
    // REMOVED child can still be attributed to its parent after the live item is
    // gone — flushDiff lifts such removals to a parent re-blob on the v2 wire.
    if( FOOTPRINT* fp = aItem->GetParentFootprint() )
        j["parent"] = toUtf8( fp->m_Uuid.AsString() );

    if( isTrackType( aItem->Type() ) )
    {
        auto* tr   = static_cast<PCB_TRACK*>( aItem );
        j["sx"]    = tr->GetStart().x;
        j["sy"]    = tr->GetStart().y;
        j["ex"]    = tr->GetEnd().x;
        j["ey"]    = tr->GetEnd().y;
        j["width"] = tr->GetWidth();
    }

    // Vias and zones reconstruct NATIVELY on `added` (the s-expr clipboard blob's `(kicad_pcb …)`
    // envelope parse — used for footprints — is asyncify-fragile in wasm for these, the same wall
    // that deferred the eeschema symbol blob). So emit the geometry their makeItem needs.
    if( aItem->Type() == PCB_VIA_T )
    {
        auto* via  = static_cast<PCB_VIA*>( aItem );
        j["drill"] = via->GetDrillValue();
        j["ltop"]  = (int) via->TopLayer();
        j["lbot"]  = (int) via->BottomLayer();
    }
    else if( aItem->Type() == PCB_ZONE_T )
    {
        auto*                 zone = static_cast<ZONE*>( aItem );
        const SHAPE_POLY_SET* poly = zone->Outline();
        json                  pts  = json::array();

        if( poly && poly->OutlineCount() > 0 )
        {
            const SHAPE_LINE_CHAIN& chain = poly->COutline( 0 );

            for( int i = 0; i < chain.PointCount(); ++i )
            {
                const VECTOR2I& p = chain.CPoint( i );
                pts.push_back( { p.x, p.y } );
            }
        }

        j["poly"] = pts;
    }
    // A board-level graphic text (Place→Text) also reconstructs NATIVELY (same asyncify reason as
    // via/zone): emit its size / stroke / angle so makeItem can rebuild it. Footprint child text
    // is synced by move, not `added`, so this is only the board PCB_TEXT case.
    else if( aItem->Type() == PCB_TEXT_T )
    {
        auto* txt    = static_cast<PCB_TEXT*>( aItem );
        j["tw"]      = txt->GetTextSize().x;
        j["th"]      = txt->GetTextSize().y;
        j["thick"]   = txt->GetTextThickness();
        j["angle"]   = txt->GetTextAngle().AsTenthsOfADegree();
        // Justification + mirror anchor the glyphs relative to the text POSITION; without them a
        // left-justified text reconstructs centered and renders visibly offset from the same
        // GetPosition() (peers diverge visually though GetPosition matches). Bold/italic for looks.
        j["hjust"]   = (int) txt->GetHorizJustify();
        j["vjust"]   = (int) txt->GetVertJustify();
        j["mirror"]  = txt->IsMirrored();
        j["bold"]    = txt->IsBold();
        j["italic"]  = txt->IsItalic();
    }

    // Text items (incl. footprint fields / graphic text): carry the string so a move diff is
    // legible and a text `added` can reconstruct. Position-only sync uses x/y above.
    if( EDA_TEXT* txt = dynamic_cast<EDA_TEXT*>( aItem ) )
        j["text"] = toUtf8( txt->GetText() );

    return j;
}

// ── s-expr item blob (the generic `added` mechanism) ─────────────────────────────────────────
//
// For added items beyond the natively-reconstructed PCB_TRACK (footprints, vias, zones, graphic
// shapes/text…), serialize one item with the BOARD writer's control set: a bare `(footprint …)`
// for a footprint, or a fake `(kicad_pcb … <layers> <item>)` envelope for everything else (the
// bare item tokens like `(segment`/`(via`/`(zone` are NOT accepted by the parser top-level, so
// the envelope is required).
//
// The envelope still comes from CLIPBOARD_IO::SaveSelection, which is also what supplies the
// `(layers …)` block the parser needs; CLIPBOARD_IO normally talks to the system clipboard, so
// SetWriter/SetReader redirect it to a string to work headless / in wasm. Footprints take the
// dedicated path below instead — see blobForItem for why the clipboard dialect is wrong here.

// A board writer we can point at a BOARD. PCB_IO_KICAD_SEXPR's default control set is
// CTL_FOR_BOARD — exactly what a .kicad_pcb save uses — but only CLIPBOARD_IO exposes a
// public SetBoard(); m_board is protected on PCB_IO, so a two-line subclass gets us the
// file writer without a fork change.
class WIRE_BOARD_IO : public PCB_IO_KICAD_SEXPR
{
public:
    explicit WIRE_BOARD_IO( BOARD* aBoard ) : PCB_IO_KICAD_SEXPR( CTL_FOR_BOARD )
    {
        m_board = aBoard;
    }
};

// Serialize one live board item to a wire blob (used only for `added` payloads — NOT the
// diff unit, so `changed`/`removed` stay light and the blob never drives change detection).
//
// The blob MUST be byte-equal to that item's subtree in a full .kicad_pcb save: the Y.Doc is
// the source of truth for the FILE, so any writer difference is a permanent, unfixable drift
// and corrupts what a server-side materialize writes.
//
// That is why footprints use CTL_FOR_BOARD and not CLIPBOARD_IO's CTL_FOR_CLIPBOARD. The two
// differ by exactly CTL_OMIT_FOOTPRINT_VERSION (pcb_io_kicad_sexpr.h), so clipboard form emits
//     (footprint "Lib:C1206" (version 20260206) (generator "pcbnew") (generator_version "10.0") …)
// — three tokens a board-embedded footprint never has (pcb_io_kicad_sexpr.cpp ~1201). Every
// footprint of every board drifted on those three lines.
//
// Non-footprints DON'T use SaveSelection either (drift-trio finding, standalone-hardening
// 0008 §10): its "make safe to transfer" step clears the locked flag on the copy
// (kicad_clipboard.cpp ~416) — clipboard semantics; pastes are unlocked — so `(locked yes)`,
// real file content, vanished from every track/via/zone/text blob and a peer's lock never
// reached the doc. Instead the live item is Formatted directly with the FILE writer and
// wrapped in the same synthetic `(kicad_pcb … <layers> <item>)` envelope the apply path
// already parses (the parser rejects bare `(segment`/`(via`/`(zone` at top level).
//
// Footprints also DON'T go through SaveSelection: its "make safe to transfer" step copies the
// footprint, and FOOTPRINT's copy ctor ASSIGNS the mandatory fields into the new footprint's
// freshly-constructed ones (`*existingField = *field`; EDA_ITEM::operator= keeps the target's
// uuid) — so Reference/Value/Datasheet/Description would carry NEW uuids in every blob,
// breaking the wire's identity-by-uuid (every emit would read as field remove+add, and round
// trips lose the field uuids). The copy ctor now restores those uuids itself (footprint.cpp),
// but we keep making the safety copy here so the live item is never mutated.
std::string wrapInBoardEnvelope( BOARD& aBoard, const std::string& aItemSexpr );

std::string blobForItem( BOARD* aBoard, BOARD_ITEM* aItem )
{
    if( aItem->Type() == PCB_FOOTPRINT_T )
    {
        const FOOTPRINT* src = static_cast<const FOOTPRINT*>( aItem );
        FOOTPRINT        copy( *src );

        // The rest of SaveSelection's footprint safety steps, minus the refPoint move
        // (the wire carries absolute positions) and minus SetNetCode(0): zeroing pad
        // nets is a paste-into-FOREIGN-board safety, but collab peers edit the SAME
        // board — nets must survive the wire. KiCad 10 formats pad nets by NAME and
        // the parser resolves by name against the receiver's board (creating the net
        // if missing), so no code remapping is needed on apply.
        //
        // NOTE: unlike SaveSelection we do NOT SetLocked( false ) — `(locked yes)` is
        // real file content and dropping it would drift against the save.
        WIRE_BOARD_IO    io( aBoard );
        STRING_FORMATTER fmt;
        io.SetOutputFormatter( &fmt );
        io.Format( &copy );

        copy.SetParent( nullptr );
        copy.SetParentGroup( nullptr );

        std::string out = fmt.GetString();
        KICAD_FORMAT::Prettify( out, KICAD_FORMAT::FORMAT_MODE::COMPACT_TEXT_PROPERTIES );
        return out;
    }

    // Direct file-writer Format of the LIVE item (no mutation, unlike
    // SaveSelection's transfer copy) + the apply path's own envelope.
    WIRE_BOARD_IO    io( aBoard );
    STRING_FORMATTER fmt;
    io.SetOutputFormatter( &fmt );
    io.Format( aItem );

    std::string body = fmt.GetString();
    KICAD_FORMAT::Prettify( body, KICAD_FORMAT::FORMAT_MODE::COMPACT_TEXT_PROPERTIES );
    return wrapInBoardEnvelope( *aBoard, body );
}

// A bare `(footprint …)` blob carries no `(version …)`, but the parser NEEDS one: it starts at
// m_requiredVersion = 0, and several format decisions are gated on it — most visibly
// `if( m_requiredVersion < 20230620 ) field->SetVisible( false )` in the T_property case
// (pcb_io_kicad_sexpr_parser.cpp), which silently stamps `(hide yes)` onto every mandatory
// field of an applied footprint.
//
// The clipboard dialect got this for free because CTL_FOR_CLIPBOARD emits the version INSIDE
// the footprint form — but that token is not valid board-file content (see blobForItem), so we
// can't keep it in the Y.Doc. Instead re-supply it here, at parse time only: splice
// `(version N)` in right after `(footprint "<lib id>"`, which is exactly where the clipboard
// writer put it. The Y.Doc body stays byte-identical to the file; only the wire→model decode
// sees the token.
static std::string withFootprintVersion( const std::string& aBlob )
{
    static const std::string kHead = "(footprint";

    if( aBlob.compare( 0, kHead.size(), kHead ) != 0 )
        return aBlob;                       // envelope blob — its (kicad_pcb …) carries a version

    if( aBlob.find( "(version " ) != std::string::npos )
        return aBlob;                       // already versioned (older peer, clipboard dialect)

    // Skip the quoted lib id that follows the head keyword, then inject.
    size_t open = aBlob.find( '"', kHead.size() );

    if( open == std::string::npos )
        return aBlob;

    size_t close = open + 1;

    while( close < aBlob.size() && aBlob[close] != '"' )
        close += ( aBlob[close] == '\\' ) ? 2 : 1;

    if( close >= aBlob.size() )
        return aBlob;

    return aBlob.substr( 0, close + 1 )
           + " (version " + std::to_string( SEXPR_BOARD_FILE_VERSION ) + ")"
           + aBlob.substr( close + 1 );
}

// Reconstruct a board item from a wire blob. Parse() returns a bare FOOTPRINT*, or a BOARD*
// (the `(kicad_pcb …)` envelope) holding the single item — in which case detach that item from
// the throw-away board and hand back ownership. Returns nullptr on a parse failure (Parse catches
// internally) or if no item is found. Runs inside the apply COROUTINE.
BOARD_ITEM* makeFromBlob( BOARD& aBoard, const std::string& aBlobIn )
{
    if( aBlobIn.empty() )
        return nullptr;

    const std::string aBlob = withFootprintVersion( aBlobIn );

    CLIPBOARD_IO io;
    io.SetBoard( &aBoard );

    // Parse directly (not io.Parse(), whose catch(...) swallows the error): a
    // failed apply must say WHY, or wire bugs surface as silent non-convergence.
    BOARD_ITEM* parsed = nullptr;           // FOOTPRINT* (bare) | BOARD* (envelope) | nullptr

    try
    {
        parsed = io.PCB_IO_KICAD_SEXPR::Parse( wxString::FromUTF8( aBlob.c_str() ) );
    }
    catch( const IO_ERROR& e )
    {
        EM_ASM( { console.log( "[collab] pcbnew blob parse error: " + UTF8ToString( $0 ) ); },
                std::string( e.What().utf8_str() ).c_str() );
        return nullptr;
    }
    catch( ... )
    {
        EM_ASM( { console.log( "[collab] pcbnew blob parse error: unknown exception" ); } );
        return nullptr;
    }

    if( !parsed )
        return nullptr;

    if( parsed->Type() != PCB_T )
        return parsed;                      // bare footprint — ready to commit.Add

    // Envelope board: remap its net codes onto ours, then lift out the single item it carries.
    BOARD* clip = static_cast<BOARD*>( parsed );
    clip->MapNets( &aBoard );

    BOARD_ITEM* found = nullptr;

    if( !clip->Tracks().empty() )           found = clip->Tracks().front();      // track / via / arc
    else if( !clip->Zones().empty() )       found = clip->Zones().front();
    else if( !clip->Drawings().empty() )    found = clip->Drawings().front();    // shape / text / …
    else if( !clip->Footprints().empty() )  found = clip->Footprints().front();
    else if( !clip->Groups().empty() )      found = clip->Groups().front();

    if( found )
    {
        clip->Remove( found );              // detach so clip's dtor doesn't delete it
        // Reparent onto the REAL board before clip is freed: the item's m_parent still points at
        // clip, and commit.Push/saveCopyInUndoList dereferences GetParent() — a dangling pointer
        // here is what trapped via add ("index out of bounds") and tripped the zone undo assert.
        found->SetParent( &aBoard );
        found->SetParentGroup( nullptr );
    }

    delete clip;
    return found;
}

// Wrap a BARE item s-expr (e.g. one rendered from the Y.Doc Slot body) in the fake
// `(kicad_pcb …)` envelope CLIPBOARD_IO's parser requires for non-footprint items. The
// envelope carries the LIVE board's layer table so the item's layer names resolve — peers
// in a collab session share the same board, so names map 1:1. (Peer-emitted blobs already
// arrive enveloped by blobForItem; this is only for bare payloads.)
std::string wrapInBoardEnvelope( BOARD& aBoard, const std::string& aItemSexpr )
{
    std::string s = "(kicad_pcb (version " + std::to_string( SEXPR_BOARD_FILE_VERSION )
                    + ") (generator \"pcbnew\") (layers";

    auto emit = [&]( PCB_LAYER_ID id )
    {
        const char* type = IsCopperLayer( id ) ? LAYER::ShowType( aBoard.GetLayerType( id ) )
                                               : "user";

        // CANONICAL name (LSET::Name), NOT GetLayerName(): the parser validates
        // position 2 against the fixed layer hash, and user-visible names differ
        // from canonical ones (e.g. "B.Courtyard" vs "B.CrtYd") — the envelope
        // parse threw "not in fixed layer hash" for any board with such layers.
        s += " (" + std::to_string( (int) id ) + " \""
             + std::string( LSET::Name( id ).utf8_str() ) + "\" " + type + ")";
    };

    // Copper first (front→back), then tech/user — the formatBoardLayers order.
    // parseLayers stops counting copper at the first non-copper entry and then
    // rejects the count (<2), so raw Seq() order (which interleaves copper and
    // non-copper ids in the v9 numbering) fails on EVERY bare payload.
    for( PCB_LAYER_ID id : aBoard.GetEnabledLayers().CuStack() )
        emit( id );

    for( PCB_LAYER_ID id : aBoard.GetEnabledLayers().TechAndUserUIOrder() )
        emit( id );

    s += ") " + aItemSexpr + ")";
    return s;
}

// Construct a new BOARD_ITEM from a delta item (for `added`), with the delta's uuid (m_Uuid is
// const → const_cast, exactly as the s-expr parser does). PCB_TRACK segments reconstruct natively
// from their fields (cheap, trap-free); every other type goes through the s-expr clipboard blob
// (`sexpr`, attached to added payloads by the emit side). Returns nullptr if neither applies.
BOARD_ITEM* makeItem( BOARD& aBoard, const json& j )
{
    std::string type = j.value( "type", "" );
    BOARD_ITEM* item = nullptr;

    if( type == "PCB_TRACK" && j.contains( "sx" ) )
    {
        auto* tr = new PCB_TRACK( &aBoard );
        tr->SetStart( VECTOR2I( j.value( "sx", 0 ), j.value( "sy", 0 ) ) );
        tr->SetEnd( VECTOR2I( j.value( "ex", 0 ), j.value( "ey", 0 ) ) );
        tr->SetWidth( j.value( "width", 0 ) );
        // SetLayer is virtual and (like GetLayer) mis-dispatches in this apply context → it no-ops,
        // leaving the item on the default layer. Class-qualify to a direct m_layer write.
        tr->BOARD_ITEM::SetLayer( (PCB_LAYER_ID) j.value( "layer", (int) F_Cu ) );
        item = tr;
    }
    // Via / zone: reconstruct natively from emitted geometry (the envelope-blob parse is
    // asyncify-fragile for these — see itemToJson). The blob is still emitted as a fallback.
    else if( type == "PCB_VIA" && j.contains( "drill" ) )
    {
        auto*    via = new PCB_VIA( &aBoard );
        VECTOR2I c( j.value( "x", 0 ), j.value( "y", 0 ) );
        via->SetPosition( c );
        via->SetWidth( j.value( "width", 0 ) );
        via->SetDrill( j.value( "drill", 0 ) );
        via->SetLayerPair( (PCB_LAYER_ID) j.value( "ltop", (int) F_Cu ),
                           (PCB_LAYER_ID) j.value( "lbot", (int) B_Cu ) );
        item = via;
    }
    else if( type == "ZONE" && j.contains( "poly" ) )
    {
        auto*                 zone = new ZONE( &aBoard );
        std::vector<VECTOR2I> outline;

        for( const json& p : j["poly"] )
        {
            if( p.is_array() && p.size() == 2 )
                outline.emplace_back( p[0].get<int>(), p[1].get<int>() );
        }

        // Zones keep their layer in m_layerSet via SetLayer→SetLayerSet (both virtual, both no-op
        // here). Class-qualify ZONE::SetLayerSet to set it directly (else GetFirstLayer == -1).
        zone->ZONE::SetLayerSet( LSET( { (PCB_LAYER_ID) j.value( "layer", (int) F_Cu ) } ) );

        if( outline.size() >= 3 )
            zone->AddPolygon( outline );

        item = zone;
    }
    else if( type == "PCB_TEXT" && j.contains( "text" ) )
    {
        auto* txt = new PCB_TEXT( &aBoard );
        txt->SetText( wxString::FromUTF8( j.value( "text", "" ).c_str() ) );
        txt->SetPosition( VECTOR2I( j.value( "x", 0 ), j.value( "y", 0 ) ) );
        txt->BOARD_ITEM::SetLayer( (PCB_LAYER_ID) j.value( "layer", (int) F_SilkS ) ); // devirt

        if( j.contains( "tw" ) )
            txt->SetTextSize( VECTOR2I( j.value( "tw", 0 ), j.value( "th", 0 ) ) );

        if( j.contains( "thick" ) )
            txt->SetTextThickness( j.value( "thick", 0 ) );

        if( j.contains( "angle" ) )
            txt->SetTextAngle( EDA_ANGLE( j.value( "angle", 0 ), TENTHS_OF_A_DEGREE_T ) );

        // Restore justification/mirror so the glyphs sit at the same place relative to position.
        if( j.contains( "hjust" ) )
            txt->SetHorizJustify( (GR_TEXT_H_ALIGN_T) j.value( "hjust", (int) GR_TEXT_H_ALIGN_LEFT ) );

        if( j.contains( "vjust" ) )
            txt->SetVertJustify( (GR_TEXT_V_ALIGN_T) j.value( "vjust", (int) GR_TEXT_V_ALIGN_CENTER ) );

        if( j.contains( "mirror" ) )
            txt->SetMirrored( j.value( "mirror", false ) );

        if( j.contains( "bold" ) )
            txt->SetBold( j.value( "bold", false ) );

        if( j.contains( "italic" ) )
            txt->SetItalic( j.value( "italic", false ) );

        item = txt;
    }
    else if( j.contains( "sexpr" ) )
    {
        item = makeFromBlob( aBoard, j.value( "sexpr", "" ) );
    }

    // Force the delta's uuid (the blob already carries the sender's uuid for the item and any
    // children, but set the top-level one explicitly to be certain peers agree on identity).
    if( item )
        const_cast<KIID&>( item->m_Uuid ) = KIID( wxString::FromUTF8( j.value( "id", "" ).c_str() ) );

    return item;
}

// Set an existing item's geometry from a `changed` delta. Tracks reshape via their endpoints
// (independent — like an eeschema wire); everything else moves to an absolute position.
// SetStart/SetEnd/SetPosition run inside the apply COROUTINE (see kicadCollabApply), the same
// fiber context native edits use, so the virtual dispatch resolves correctly.
void applyChanged( BOARD_ITEM* aItem, const json& j )
{
    if( isTrackType( aItem->Type() ) && j.contains( "sx" ) )
    {
        auto* tr = static_cast<PCB_TRACK*>( aItem );
        tr->SetStart( VECTOR2I( j["sx"].get<int>(), j["sy"].get<int>() ) );
        tr->SetEnd( VECTOR2I( j["ex"].get<int>(), j["ey"].get<int>() ) );

        if( j.contains( "width" ) )
            tr->SetWidth( j["width"].get<int>() );
    }
    else if( j.contains( "x" ) && j.contains( "y" ) )
    {
        aItem->SetPosition( VECTOR2I( j["x"].get<int>(), j["y"].get<int>() ) );
    }
}

// Wire emitters (legacy scalar delta + v2 items): shared, collab_common.h.
using pcbjam_collab::emitDelta;
using pcbjam_collab::emitItemsWire;

// ── Emit via post-settle snapshot diff (mirrors eeschema 0007) ───────────────────────────────
//
// A local edit is one BOARD_COMMIT::Push that fires the listener callbacks synchronously and
// THEN recomputes connectivity/ratsnest. The native listener therefore only ever sees the
// pre-cleanup geometry. So treat the listener purely as a "something changed" trigger and
// broadcast a DIFF of the full model taken AFTER the edit settles (a CallAfter, which runs once
// Push has fully returned) — capturing this tab's FINAL geometry. The peer applies that and
// re-applying already-settled geometry is idempotent, so the two converge. g_baseline holds the
// last-broadcast state.

std::map<std::string, json> snapshotByUuid( BOARD& aBoard )
{
    std::map<std::string, json> m;

    forEachTopItem( aBoard, [&]( BOARD_ITEM* item )
                    {
                        std::string id = toUtf8( item->m_Uuid.AsString() );

                        if( !m.count( id ) )
                            m[id] = itemToJson( item );
                    } );

    return m;
}

std::map<std::string, json> g_baseline;
bool                        g_flushScheduled = false;

// Roots the listener saw change since the last flush (uuids, children lifted to
// their footprint at capture time). The scalar snapshot diff below is a LOSSY
// projection (id/type/x/y/layer + a few extras) — edits that don't move the
// projection (pad/zone property edits, anchor-centred rotations, endpoint drags)
// would otherwise never emit (bug 04). Dirty roots emit their v2 blob
// unconditionally; the wire apply is an idempotent upsert, so a false positive
// (a commit that changed nothing) costs one no-op echo.
std::set<std::string> g_dirty;

void noteDirty( BOARD_ITEM* aItem )
{
    if( !aItem )
        return;

    if( FOOTPRINT* fp = aItem->GetParentFootprint() )
        aItem = fp;

    g_dirty.insert( toUtf8( aItem->m_Uuid.AsString() ) );
}

// Re-seed the diff baseline to the current model — after handing out a seed snapshot, or after
// applying a remote delta (so those items aren't re-broadcast as a spurious local diff/echo).
// Declares "current model == broadcast state", so pending dirty marks are stale too.
void rebaseline()
{
    if( PCB_EDIT_FRAME* fr = pcbFrame() )
        g_baseline = snapshotByUuid( *fr->GetBoard() );

    g_dirty.clear();
}

// TARGETED rebaseline (bug 05): refresh baseline entries ONLY for the uuids a remote
// apply touched. A global rebaseline() here would fold a concurrently-committed local
// edit (its flush is queued BEHIND the apply on the same pending-event list) into the
// baseline and silently swallow it; with the targeted update the edit's uuids keep
// their pre-edit entries and the queued flush still emits it. Receiver-side cleanup
// the apply's Push produced likewise stays diffable — the post-apply flush broadcasts
// it, and re-application on the original sender is idempotent.
void rebaselineTouched( BOARD* aBoard, const std::vector<std::string>& aIds )
{
    for( const std::string& id : aIds )
    {
        // Drop the stale entry — and any child entries it owned (their parent
        // field carries the root uuid) — then re-snapshot whatever is live now.
        g_baseline.erase( id );

        for( auto it = g_baseline.begin(); it != g_baseline.end(); )
        {
            if( it->second.value( "parent", std::string() ) == id )
                it = g_baseline.erase( it );
            else
                ++it;
        }

        BOARD_ITEM* live = aBoard->ResolveItem( KIID( wxString::FromUTF8( id.c_str() ) ),
                                                /*allowNull*/ true );

        if( !live )
            continue;

        g_baseline[id] = itemToJson( live );

        if( live->Type() == PCB_FOOTPRINT_T )
        {
            FOOTPRINT* f = static_cast<FOOTPRINT*>( live );

            for( PCB_FIELD* fld : f->GetFields() )
            {
                if( fld )
                    g_baseline[toUtf8( fld->m_Uuid.AsString() )] = itemToJson( fld );
            }

            for( BOARD_ITEM* g : f->GraphicalItems() )
            {
                if( g->Type() == PCB_TEXT_T )
                    g_baseline[toUtf8( g->m_Uuid.AsString() )] = itemToJson( g );
            }
        }
    }
}

// Diff the current (settled, post-cleanup) model against the baseline and broadcast the change.
void flushDiff()
{
    g_flushScheduled = false;

    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return;

    BOARD*                      board = fr->GetBoard();
    std::map<std::string, json> cur   = snapshotByUuid( *board );

    json added = json::array(), changed = json::array(), removed = json::array();

    // v2 items wire (per-item s-expr blobs): each touched id LIFTS to its root live
    // item (footprint children → the footprint), deduped, and the root is blobbed
    // whole — so containment travels and a child edit re-sends its parent subtree.
    json                  wAdded = json::array(), wChanged = json::array();
    std::set<std::string> wDone;

    auto liftBlob = [&]( const std::string& id, json& aArr )
    {
        BOARD_ITEM* live =
                board->ResolveItem( KIID( wxString::FromUTF8( id.c_str() ) ), /*allowNull*/ true );

        if( !live )
            return;

        bool lifted = false;

        if( FOOTPRINT* fp = live->GetParentFootprint() )
        {
            live = fp;
            lifted = true;
        }

        std::string rootId = toUtf8( live->m_Uuid.AsString() );

        if( !wDone.insert( rootId ).second )
            return;

        json w = json{ { "sexpr", blobForItem( board, live ) }, { "parent", nullptr } };

        // A lifted child means its (pre-existing) parent's CONTENT changed.
        ( lifted ? wChanged : aArr ).push_back( w );
    };

    for( const auto& [id, j] : cur )
    {
        auto it = g_baseline.find( id );

        if( it == g_baseline.end() )
        {
            liftBlob( id, wAdded );

            // Skip a newly-added footprint's text CHILDREN: the footprint's own add carries them,
            // and emitting a lone child would (for a field) wrap it in a spurious footprint. (A
            // child-only add onto an existing footprint is therefore not synced yet — rare.)
            BOARD_ITEM* live =
                    board->ResolveItem( KIID( wxString::FromUTF8( id.c_str() ) ), /*allowNull*/ true );

            if( live && live->GetParentFootprint() )
                continue;

            json withBlob = j;

            // Attach an s-expr clipboard blob ONLY for types makeItem reconstructs from it
            // (footprints, board graphics, …). Tracks/vias/zones/text rebuild NATIVELY from the
            // fields itemToJson already emitted, so they need no blob — and skipping it avoids a
            // wasted SaveSelection plus the asyncify-fragile envelope parse for those.
            if( live && !isTrackType( live->Type() ) && live->Type() != PCB_ZONE_T
                && live->Type() != PCB_TEXT_T )
                withBlob["sexpr"] = blobForItem( board, live );

            added.push_back( withBlob );
        }
        else if( it->second != j )
        {
            liftBlob( id, wChanged );
            changed.push_back( j );
        }
    }

    // v2 removals diverge from the legacy wire: a removed footprint CHILD whose
    // parent survives lifts to the parent's re-blob (wChanged) — the new body
    // carries the post-delete child set, and the receiver's parent-replace covers
    // the deletion. A bare child removal would strand a dangling {item} slot in
    // the Y-side parent body (bug 03). The legacy wire keeps the raw uuid list
    // (its receiver skips footprint children anyway).
    json wRemoved = json::array();

    for( const auto& [id, j] : g_baseline )
    {
        if( cur.count( id ) )
            continue;

        removed.push_back( id );

        std::string parentId = j.value( "parent", std::string() );

        if( !parentId.empty() && cur.count( parentId ) )
            liftBlob( parentId, wChanged );
        else
            wRemoved.push_back( id );
    }

    // Dirty roots (bug 04): whatever the listener saw commit emits its blob on
    // the v2 wire even when the scalar projection didn't move. wDone dedups
    // against the scalar-diff emits above; deleted ids resolve null and skip.
    for( const std::string& id : g_dirty )
        liftBlob( id, wChanged );

    g_dirty.clear();

    g_baseline = std::move( cur );

    if( !added.empty() || !changed.empty() || !removed.empty() )
        emitDelta( json{ { "added", added }, { "changed", changed }, { "removed", removed } } );

    if( !wAdded.empty() || !wChanged.empty() || !wRemoved.empty() )
        emitItemsWire( json{ { "added", wAdded }, { "changed", wChanged }, { "removed", wRemoved } } );
}

// Coalesce all the listener callbacks of one commit (and any other edits in the same loop
// turn) into a single post-settle diff.
// flushDiff runs inside a COROUTINE: the v2 items emit serializes ROOT items via
// CLIPBOARD_IO Format (blobForItem), whose virtual dispatch is only reliable on the
// libcontext fiber stack — on the bare CallAfter stack it can trap and silently kill
// the whole flush, legacy emit included (same lesson as doApply / eeschema 0007).
void scheduleFlush()
{
    if( g_flushScheduled )
        return;

    g_flushScheduled = true;

    if( PCB_EDIT_FRAME* fr = pcbFrame() )
        pcbjam_collab::runOnFiber( fr, []() { flushDiff(); } );
    else
        flushDiff();
}

// Presence (collab-presence 0002): board changes often change the selection too
// (delete, paste) with no closing canvas event — piggyback a selection re-check
// on the collab listener trigger. Defined in the presence section below.
void schedulePresenceSelCheck();

// ChangeSource: the native BOARD_LISTENER is just a trigger — the actual change set comes from
// the post-settle snapshot diff above. Skipped while applying a remote delta (no echo); doApply
// rebaselines instead. OnBoardCompositeUpdate (the single combined add/remove/change event,
// 0004) plus the bulk + singular callbacks all funnel into one trigger.
class COLLAB_LISTENER : public BOARD_LISTENER
{
public:
    void OnBoardItemAdded( BOARD&, BOARD_ITEM* i ) override                     { trigger( { i } ); }
    void OnBoardItemsAdded( BOARD&, std::vector<BOARD_ITEM*>& v ) override      { trigger( v ); }
    void OnBoardItemRemoved( BOARD&, BOARD_ITEM* i ) override                   { trigger( { i } ); }
    void OnBoardItemsRemoved( BOARD&, std::vector<BOARD_ITEM*>& v ) override    { trigger( v ); }
    void OnBoardItemChanged( BOARD&, BOARD_ITEM* i ) override                   { trigger( { i } ); }
    void OnBoardItemsChanged( BOARD&, std::vector<BOARD_ITEM*>& v ) override    { trigger( v ); }
    void OnBoardCompositeUpdate( BOARD&, std::vector<BOARD_ITEM*>& a,
                                 std::vector<BOARD_ITEM*>& r,
                                 std::vector<BOARD_ITEM*>& c ) override
    {
        trigger( a );
        trigger( r );
        trigger( c );
    }

private:
    // Capture the touched roots at callback time (uuid strings — removed items
    // may be freed before the flush runs), then coalesce into one flush.
    void trigger( const std::vector<BOARD_ITEM*>& aItems )
    {
        if( s_applyingRemote )
            return;

        for( BOARD_ITEM* item : aItems )
            noteDirty( item );

        scheduleFlush();
        schedulePresenceSelCheck();
    }
};

COLLAB_LISTENER* g_listener = nullptr;

// Get the live BOARD and ensure our listener is registered on it (idempotent).
BOARD* ensureBridge()
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return nullptr;

    BOARD* board = fr->GetBoard();

    if( !g_listener )
    {
        g_listener = new COLLAB_LISTENER();
        board->AddListener( g_listener );
    }

    return board;
}

// The actual model mutation, via BOARD_COMMIT so connectivity + ratsnest recompute exactly as
// for a UI edit (0004 §apply: never bypass the commit for remote ops). Runs inside the apply
// COROUTINE (see kicadCollabApply).
void doApply( PCB_EDIT_FRAME* aFrame, const json& aDelta )
{
    BOARD* board = aFrame->GetBoard();

    s_applyingRemote = true;

    BOARD_COMMIT commit( aFrame );
    bool         staged = false;

    // With SKIP_UNDO no undo picker takes ownership of removed items; the commit
    // detaches them from the board and we free them after Push.
    std::vector<BOARD_ITEM*> removedItems;

    for( const json& rid : aDelta.value( "removed", json::array() ) )
    {
        KIID id( wxString::FromUTF8( rid.get<std::string>().c_str() ) );

        if( BOARD_ITEM* item = board->ResolveItem( id, /*allowNullptr*/ true ) )
        {
            // A footprint text child appears in `removed` when its whole footprint was deleted
            // (it vanished from the sender's snapshot). Removing the footprint cascades to its
            // children, so don't also remove the child here — that would double-remove. (A rare
            // child-only delete with the footprint kept is therefore not synced; acceptable.)
            if( item->GetParentFootprint() )
                continue;

            commit.Remove( item );
            removedItems.push_back( item );
            staged = true;
        }
    }

    for( const json& j : aDelta.value( "changed", json::array() ) )
    {
        KIID id( wxString::FromUTF8( j.value( "id", "" ).c_str() ) );

        if( BOARD_ITEM* item = board->ResolveItem( id, /*allowNullptr*/ true ) )
        {
            commit.Modify( item );
            applyChanged( item, j );
            staged = true;
        }
    }

    for( const json& j : aDelta.value( "added", json::array() ) )
    {
        KIID id( wxString::FromUTF8( j.value( "id", "" ).c_str() ) );

        if( board->ResolveItem( id, /*allowNullptr*/ true ) )
            continue;                       // already present (our own echo)

        if( BOARD_ITEM* item = makeItem( *board, j ) )
        {
            commit.Add( item );
            staged = true;
        }
        else
        {
            EM_ASM( { console.log( "[collab] pcbnew apply: no converter for added type " + UTF8ToString( $0 ) ); },
                    j.value( "type", "?" ).c_str() );
        }
    }

    // SKIP_UNDO: a peer's edit must never land on this editor's undo stack — Ctrl+Z
    // would revert (and re-broadcast) the peer's work. Undo is local-ops-only; stale
    // local undo entries are dropped/re-resolved by UUID at undo time (miss 09).
    if( staged )
        commit.Push( wxT( "Collaborative edit" ), SKIP_UNDO );

    for( BOARD_ITEM* item : removedItems )
        delete item;

    // The applied remote changes (and any connectivity cleanup they triggered) are now the
    // shared state — fold them into the baseline so the post-apply listener flush doesn't
    // re-broadcast them as a local diff (echo).
    rebaseline();
    s_applyingRemote = false;
}

// v2 items apply: removed by uuid; added/changed are an idempotent per-item upsert —
// parse the blob (wrapping bare non-footprint payloads in a live-board envelope),
// then replace any existing item sharing the parsed uuid. Runs inside the apply
// COROUTINE (see kicadCollabApplyItems), via BOARD_COMMIT like every remote op.
void doApplyItems( PCB_EDIT_FRAME* aFrame, const json& aWire )
{
    BOARD* board = aFrame->GetBoard();

    s_applyingRemote = true;

    BOARD_COMMIT commit( aFrame );
    bool         staged = false;

    std::vector<std::string> touched;   // root uuids this apply acts on (targeted rebaseline)

    // Owned by nobody once the SKIP_UNDO commit detaches them — freed after Push.
    std::vector<BOARD_ITEM*> removedItems;

    std::set<std::string> removedIds;

    for( const json& rid : aWire.value( "removed", json::array() ) )
        removedIds.insert( rid.get<std::string>() );

    for( const std::string& rid : removedIds )
    {
        KIID id( wxString::FromUTF8( rid.c_str() ) );

        touched.push_back( rid );

        if( BOARD_ITEM* item = board->ResolveItem( id, /*allowNullptr*/ true ) )
        {
            if( FOOTPRINT* pfp = item->GetParentFootprint() )
            {
                // Covered by the parent's own removal when the whole footprint
                // goes. A BARE child removal must remove the child itself
                // (bug 03 receiving half) — the sender now lifts these to a
                // parent re-blob, but Y-rendered wires can still carry them.
                if( removedIds.count( toUtf8( pfp->m_Uuid.AsString() ) ) )
                    continue;
            }

            commit.Remove( item );

            // A bare child "removal" of a PCB_FIELD_T is a hide, not a detach —
            // the field stays owned by its parent footprint.
            if( item->Type() != PCB_FIELD_T )
                removedItems.push_back( item );

            staged = true;
        }
    }

    auto upsert = [&]( const json& w )
    {
        std::string sexpr = w.value( "sexpr", "" );
        size_t      p     = sexpr.find_first_not_of( " \t\r\n" );

        if( p == std::string::npos )
            return;

        std::string trimmed = sexpr.substr( p );

        // Peer-emitted blobs are already enveloped (or a bare footprint, which the
        // parser accepts top-level); bare Y.Doc-rendered items need the envelope.
        if( trimmed.rfind( "(kicad_pcb", 0 ) != 0 && trimmed.rfind( "(footprint", 0 ) != 0 )
            trimmed = wrapInBoardEnvelope( *board, trimmed );

        BOARD_ITEM* parsed = makeFromBlob( *board, trimmed );

        if( !parsed )
        {
            EM_ASM( { console.log( "[collab] pcbnew applyItems: blob parse failed" ); } );
            return;
        }

        if( BOARD_ITEM* existing = board->ResolveItem( parsed->m_Uuid, /*allowNullptr*/ true ) )
        {
            // Replacing by uuid; a (shouldn't-happen) child match replaces its parent.
            if( FOOTPRINT* fp = existing->GetParentFootprint() )
                existing = fp;

            commit.Remove( existing );
            removedItems.push_back( existing );
        }

        touched.push_back( toUtf8( parsed->m_Uuid.AsString() ) );

        commit.Add( parsed );
        staged = true;
    };

    for( const json& w : aWire.value( "added", json::array() ) )
        upsert( w );
    for( const json& w : aWire.value( "changed", json::array() ) )
        upsert( w );

    // SKIP_UNDO: remote applies never land on the local undo stack (see doApply).
    if( staged )
        commit.Push( wxT( "Collaborative edit (items)" ), SKIP_UNDO );

    for( BOARD_ITEM* item : removedItems )
        delete item;

    // Fold ONLY the applied uuids into the baseline (echo suppression), then flush:
    // anything else that now differs — a concurrent local edit, cleanup this apply's
    // Push produced — broadcasts as a normal local diff instead of being swallowed.
    rebaselineTouched( board, touched );
    s_applyingRemote = false;
    scheduleFlush();
}

// Test/PoC move (the BOARD_COMMIT body for kicadCollabTestMoveFirst). Run inside a COROUTINE by
// the caller: `BOARD_ITEM::Move` is virtual, and dispatched off the app main stack (a bare
// CallAfter) it hits the asyncify call_indirect mis-dispatch and silently NO-OPS — the commit
// dirties the board but the item doesn't move. On the fiber stack (where native tool edits and
// doApply run) it dispatches correctly. (Same lesson as eeschema's devirtualized move.)
void collabTestMove( PCB_EDIT_FRAME* aFrame, BOARD_ITEM* aItem, int aDx, int aDy )
{
    BOARD_COMMIT commit( aFrame );
    commit.Modify( aItem );
    aItem->Move( VECTOR2I( aDx, aDy ) );
    commit.Push( wxT( "Collab test move" ) );
}

// ───────────────────────── collab presence (collab-presence 0002) ─────────────────────────
//
// Ephemeral presence: emit THIS tab's selection + cursor to JS (they ride Yjs awareness),
// and render REMOTE peers' cursors + selection outlines into a per-user-colored
// KIGFX::VIEW_OVERLAY. Never via the SELECTED/BRIGHTENED item flags — those have one
// global color and mutate real selection state (events, serialization, races with the
// local user); the overlay's command list takes a COLOR4D per command, never enters
// m_selection, and never serializes.
//
// Zero kicad-fork changes: the input triggers are wx-layer Bind() handlers on the GAL
// canvas (bound after WX_VIEW_CONTROLS' own, so they run FIRST and Skip() onward), the
// selection is read from PCB_SELECTION_TOOL after the event settles (CallAfter), and the
// repaint is the MakeOverlay()/VIEW::Update()/ForceRefresh() combo the cross-probe flash
// already uses. Selection changes with no closing canvas event (Edit→Select All from the
// menu) are missed until the next input or board change — acceptable for an ephemeral
// layer that fully resyncs on every emit.
//
// The state + event/scheduling machinery live in the shared pcbjam_presence::CORE
// (collab_presence_core.h); this TU supplies only the pcbnew-specific hooks:
// frame/tool lookup, KIID resolution via BOARD::ResolveItem, the {uuids,fpPaths}
// selection payload (0006), and the per-peer draw (exact-outline highlight + xsel
// ghosts matched against footprint GetPath() tails).

// The full selection emit payload (0006): the uuids plus, for every selected
// FOOTPRINT, its schematic link — the GetPath() KIID_PATH string ending in the
// symbol uuid. eeschema peers highlight the corresponding symbols from it.
json selectionPayload( PCB_EDIT_FRAME* aFrame );

// Cross-app selection (0006): the footprints a peer's xsel (eeschema symbol
// uuids) resolves to on this board — every footprint whose GetPath() ends in
// the symbol uuid (a reused sheet legitimately maps one symbol to N
// footprints). The per-call linear scan reflects the live board with no index
// to invalidate; boards are small relative to the redraw's own draw cost.
// ONE resolver shared by the ghost render and the test probe
// (kicadCollabTestGetCrossMapped), so the assertion can't drift from the pixels.
std::vector<FOOTPRINT*> resolveXsel( PCB_EDIT_FRAME* aFrame, const pcbjam_presence::PEER& aPeer )
{
    std::vector<FOOTPRINT*> fps;

    for( const KIID& symId : aPeer.xsel )
    {
        for( FOOTPRINT* fp : aFrame->GetBoard()->Footprints() )
        {
            const KIID_PATH& path = fp->GetPath();

            if( !path.empty() && path.back() == symId )
                fps.push_back( fp );
        }
    }

    return fps;
}

pcbjam_presence::CORE& presenceCore()
{
    static pcbjam_presence::CORE core = []()
    {
        pcbjam_presence::CORE c;

        c.frame = []() -> EDA_DRAW_FRAME* { return pcbFrame(); };

        c.selectionTool = []( EDA_DRAW_FRAME* fr ) -> SELECTION_TOOL*
        {
            return fr->GetToolManager()->GetTool<PCB_SELECTION_TOOL>();
        };

        c.selectionEmitPayload = []( EDA_DRAW_FRAME* fr ) -> json
        {
            return selectionPayload( static_cast<PCB_EDIT_FRAME*>( fr ) );
        };

        c.resolveItem = []( EDA_DRAW_FRAME* fr, const KIID& id ) -> EDA_ITEM*
        {
            return static_cast<PCB_EDIT_FRAME*>( fr )->GetBoard()
                    ->ResolveItem( id, /*aAllowNullptrReturn*/ true );
        };

        c.drawPeerShapes = []( pcbjam_presence::CORE& aCore, EDA_DRAW_FRAME* aFrame,
                               const pcbjam_presence::PEER& peer, const KIGFX::COLOR4D& color,
                               double px )
        {
            PCB_EDIT_FRAME* fr    = static_cast<PCB_EDIT_FRAME*>( aFrame );
            BOARD*          board = fr->GetBoard();

            // Draw ONE item's selection box under the given style. Exact-geometry
            // outline (style shape 5): footprints hug their bounding hull,
            // everything else its transformed shape. Runs on the coroutine fiber
            // (virtual dispatch), falls back to the bbox on anything that can't
            // produce a polygon.
            auto drawItem = [&]( BOARD_ITEM* item, const std::string& name,
                                 const KIGFX::COLOR4D& itemColor,
                                 const pcbjam_presence::STYLE& style )
            {
                SHAPE_POLY_SET outline;

                if( style.selShape == 5 )
                {
                    try
                    {
                        int pad = KiROUND( style.selPaddingPx * px );
                        int err = KiROUND( px ) + 1;

                        if( item->Type() == PCB_FOOTPRINT_T )
                        {
                            outline = static_cast<FOOTPRINT*>( item )->GetBoundingHull();

                            if( pad > 0 )
                                outline.Inflate( pad, CORNER_STRATEGY::ROUND_ALL_CORNERS, err );
                        }
                        else
                        {
                            item->TransformShapeToPolygon( outline, (PCB_LAYER_ID) itemLayer( item ),
                                                           pad, err, ERROR_OUTSIDE );
                        }
                    }
                    catch( ... )
                    {
                        outline.RemoveAllContours();
                    }
                }

                pcbjam_presence::drawSelectionBox( aCore.overlay.get(), aCore.chipOverlay.get(),
                                                   aCore.textOverlay.get(),
                                                   item->ViewBBox(), name, itemColor, px,
                                                   style, &outline );
            };

            for( const KIID& id : peer.selection )
            {
                BOARD_ITEM* item = board->ResolveItem( id, /*aAllowNullptrReturn*/ true );

                if( !item )
                    continue;   // not on this board (yet) — skip silently

                drawItem( item, peer.name, color, aCore.style );
            }

            // Cross-app ghosts (0006) — see resolveXsel for the path-tail matching.
            if( !peer.xsel.empty() )
            {
                pcbjam_presence::STYLE ghost = pcbjam_presence::ghostStyle( aCore.style );

                for( FOOTPRINT* fp : resolveXsel( fr, peer ) )
                    drawItem( fp, peer.name, color, ghost );
            }
        };

        return c;
    }();

    return core;
}

json selectionPayload( PCB_EDIT_FRAME* aFrame )
{
    json payload;
    payload["uuids"]   = presenceCore().selectionUuids( aFrame );
    payload["fpPaths"] = json::array();

    PCB_SELECTION_TOOL* selTool = aFrame->GetToolManager()->GetTool<PCB_SELECTION_TOOL>();

    if( !selTool )
        return payload;

    for( EDA_ITEM* item : selTool->GetSelection() )
    {
        if( item->Type() != PCB_FOOTPRINT_T )
            continue;

        const KIID_PATH& path = static_cast<FOOTPRINT*>( item )->GetPath();

        if( !path.empty() )
            payload["fpPaths"].push_back( toUtf8( path.AsString() ) );
    }

    return payload;
}

void schedulePresenceSelCheck()
{
    presenceCore().scheduleSelCheck();
}

} // namespace


// JS → C++. Apply a remote per-item delta by uuid, through BOARD_COMMIT so connectivity/ratsnest
// recompute the same way a UI edit would (0004 §apply).
//
// BOARD_COMMIT must run in the editor's Asyncify-rooted main loop — invoking it from this embind
// ccall, or from a setTimeout callback, traps with an "indirect call signature mismatch" (those
// aren't the asyncify root). wxEvtHandler::CallAfter queues onto the app's pending-event list,
// drained every frame by the wasm main loop (src/wasm/evtloop.cpp) — the exact context real UI
// edits run in. Additionally run the mutation inside a COROUTINE so it executes on a libcontext
// fiber stack: BOARD_COMMIT::Push's CHT_ADD of a freshly-built item dispatches GAL virtuals
// (view->Add → ViewGetLayers) through asyncify-instrumented invoke_*; off the fiber stack those
// mis-dispatch and trap inside KiCad core, on it they dispatch correctly (eeschema 0007).
void pcbCollabApply( std::string aJson )
{
    // Open-in-flight guard (open_gate.h): never touch the model while a
    // kicadOpenFile Asyncify chain is parked mid-load — commits/virtuals on a
    // half-built board mis-dispatch ("indirect call signature mismatch").
    // Callers gate on kicadOpenFileBusy; fuzzed by tests/kicad/collab-load-fuzz.spec.ts.
    if( pcbjam_open::busy() )
        return;

    json delta = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

    if( delta.is_discarded() )
        return;

    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return;

    pcbjam_collab::runOnFiber( fr, [fr, delta]() { doApply( fr, delta ); } );
}


// JS → C++, v2 items wire. Same CallAfter + COROUTINE context as kicadCollabApply
// (the blob parse + commit must run where native edits run — see above).
void pcbCollabApplyItems( std::string aJson )
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see pcbCollabApply
        return;

    json wire = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

    if( wire.is_discarded() )
        return;

    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return;

    pcbjam_collab::runOnFiber( fr, [fr, wire]() { doApplyItems( fr, wire ); } );
}


// JS pull of the full current model as an all-"added" delta (seed/baseline). Also registers the
// change listener on first call.
std::string pcbCollabSnapshot()
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see pcbCollabApply
        return json{ { "added", json::array() }, { "changed", json::array() },
                     { "removed", json::array() } }.dump();

    BOARD* board = ensureBridge();

    json added = json::array();

    if( board )
    {
        forEachTopItem( *board, [&]( BOARD_ITEM* item ) { added.push_back( itemToJson( item ) ); } );
    }

    // Seed the diff baseline to exactly the model we're handing out, so the first local edit
    // diffs against this snapshot (and we don't re-broadcast the whole model).
    rebaseline();

    return json{ { "added", added }, { "changed", json::array() },
                 { "removed", json::array() } }.dump();
}


// JS pull of the full current model as an all-"added" v2 items wire: one blob per ROOT
// item (a footprint's blob embeds its children — the TS side flattens). Registers the
// listener + rebaselines exactly like kicadCollabSnapshot.
std::string pcbCollabSnapshotItems()
{
    if( pcbjam_open::busy() ) // open in flight (open_gate.h) — see pcbCollabApply
        return json{ { "added", json::array() }, { "changed", json::array() },
                     { "removed", json::array() } }.dump();

    BOARD* board = ensureBridge();

    json added = json::array();

    if( board )
    {
        auto push = [&]( BOARD_ITEM* item )
        {
            added.push_back( json{ { "sexpr", blobForItem( board, item ) }, { "parent", nullptr } } );
        };

        for( FOOTPRINT* fp : board->Footprints() )  push( fp );
        for( PCB_TRACK* t : board->Tracks() )       push( t );
        for( ZONE* z : board->Zones() )             push( z );
        for( BOARD_ITEM* d : board->Drawings() )    push( d );
    }

    rebaseline();

    return json{ { "added", added }, { "changed", json::array() },
                 { "removed", json::array() } }.dump();
}


// Programmatically save the in-memory board to a .kicad_pcb file, without driving
// the Save As dialog — pcbnew's analogue of pl_editor's kicadSaveDrawingSheet.
// Serializes exactly what the editor has loaded via the same writer eeschema/pcbnew
// use, so a test can read the file back from MEMFS and assert the file ⇄ Y.Doc
// round trip (README §A; feature 0004). Uses only public PCB_IO_KICAD_SEXPR API.
// C++ → JS save notification (standalone-hardening save routing). Called from the
// kicad fork's save chokepoint (PCB_EDIT_FRAME::SavePcbFile) after a successful
// write to MEMFS, so the web app can route the saved bytes onward (API upload,
// local-disk write-back, download). No-op without a JS listener.
// KICAD_MERGED_EMBIND: identical definition in eeschema_embind.cpp; the merged image
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

// Merged-image dispatch probe (kicad_editor_embind.cpp): is the active top window the
// PCB editor? Each shared JS entry routes to the pcb*/sch* implementation whose frame
// is live — exactly the null-check its body starts with anyway.
bool pcbEditorActive()
{
    return pcbFrame() != nullptr;
}


void kicadSaveBoard( std::string path )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return;

    BOARD* board = fr->GetBoard();

    if( !board )
        return;

    try
    {
        PCB_IO_KICAD_SEXPR io;
        io.SaveBoard( wxString::FromUTF8( path.c_str() ), board );
    }
    catch( ... )
    {
        // Don't abort the wasm runtime on a save failure; the JS caller detects it
        // by the file being absent / empty.
    }
}


// Test/PoC helper: move the first top-level board item by (dx,dy) IU via a real BOARD_COMMIT,
// firing the listener — a deterministic local edit for the two-tab demo / e2e. Returns the
// moved item's uuid.
std::string pcbCollabTestMoveFirst( int aDx, int aDy )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    std::string movedId;

    forEachTopItem( *fr->GetBoard(), [&]( BOARD_ITEM* item )
                    {
                        if( !movedId.empty() )
                            return;

                        movedId = toUtf8( item->m_Uuid.AsString() );
                        // Main stack + fiber (runOnFiber), so the virtual Move()
                        // dispatches instead of no-opping — same wrapping as doApply.
                        pcbjam_collab::runOnFiber( fr, [fr, item, aDx, aDy]() {
                            collabTestMove( fr, item, aDx, aDy );
                        } );
                    } );

    return movedId;
}


// Test helper: read an item's position by uuid as "x,y" (internal units).
std::string pcbCollabGetPos( std::string aId )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    KIID id( wxString::FromUTF8( aId.c_str() ) );

    if( BOARD_ITEM* item = fr->GetBoard()->ResolveItem( id, /*allowNullptr*/ true ) )
    {
        VECTOR2I p = item->GetPosition();
        return std::to_string( p.x ) + "," + std::to_string( p.y );
    }

    return "";
}


// ── presence entry points (collab-presence 0002) ────────────────────────────────────────────

// Install the presence input hooks on the GAL canvas (idempotent). Called by the JS
// presence binding at collab attach; also implied by the first kicadCollabSetRemote.
// Handlers Skip() so WX_VIEW_CONTROLS' own processing is untouched; selection checks
// run POST-event via CallAfter (the selection tool acts on the same event after us).
void pcbCollabPresenceStart()
{
    presenceCore().start();
}

// JS → C++: full remote-peers snapshot — `{peers:[{id,name,color,cursor:{x,y}|null,
// selection:[uuid]}]}`, trivially derived from awareness.getStates() and idempotent
// (the overlay is cleared + fully redrawn). An empty peers list clears the overlay.
void pcbCollabSetRemote( std::string aJson )
{
    presenceCore().setRemote( aJson );
}

// JS → C++ (collab-presence 0005): comment pin dots — `{pins:[{id,x,y,color,
// resolved}]}`, world IU coords resolved by the TS side from the ydoc anchors.
// Snapshot semantics like SetRemote: cleared + fully redrawn each push.
void pcbCollabSetPins( std::string aJson )
{
    presenceCore().setPins( aJson );
}

// JS → C++ (presence tuner): live-patch the overlay STYLE (partial JSON —
// see collab_presence_style.h) and repaint. Dev-time only in practice, but
// harmless in production (nothing calls it without VITE_PRESENCE_TUNER).
void pcbCollabSetStyle( std::string aJson )
{
    presenceCore().setStyle( aJson );
}

// JS → C++ (comments-ux 0002 F4): live color-theme switch (see pcbjam_theme.h).
void pcbSetColorTheme( std::string aTheme )
{
    pcbjam_theme::setColorTheme( pcbFrame(), aTheme );
}

// Pre-main chrome appearance seed (called at onRuntimeInitialized).
void pcbSetDarkChrome( bool aDark )
{
    pcbjam_theme::setDarkChromeFlag( aDark );
}

// Tuner helper: a VARIED demo-selection set — labeled uuid groups (smallest +
// largest footprint, the two busiest nets' track segments) so the style
// preview shows the real range of shapes instead of two overlapping items.
std::string pcbCollabTestDemoSet()
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    json groups = json::array();

    if( fr )
    {
        BOARD* board = fr->GetBoard();

        // Footprints by bbox area → smallest and largest.
        FOOTPRINT* smallest = nullptr;
        FOOTPRINT* largest  = nullptr;
        double     minA = 0, maxA = 0;

        for( FOOTPRINT* f : board->Footprints() )
        {
            BOX2I  bb = f->GetBoundingBox();
            double a  = (double) bb.GetWidth() * bb.GetHeight();

            if( !smallest || a < minA ) { smallest = f; minA = a; }
            if( !largest || a > maxA )  { largest = f;  maxA = a; }
        }

        if( smallest )
            groups.push_back( { { "label", "fp small (" + toUtf8( smallest->GetReference() ) + ")" },
                                { "ids", { toUtf8( smallest->m_Uuid.AsString() ) } } } );

        if( largest && largest != smallest )
            groups.push_back( { { "label", "fp large (" + toUtf8( largest->GetReference() ) + ")" },
                                { "ids", { toUtf8( largest->m_Uuid.AsString() ) } } } );

        // Tracks grouped by net → the two busiest nets (capped segment lists).
        std::map<std::string, std::vector<std::string>> nets;

        for( PCB_TRACK* t : board->Tracks() )
        {
            std::string net = toUtf8( t->GetNetname() );

            if( !net.empty() )
                nets[net].push_back( toUtf8( t->m_Uuid.AsString() ) );
        }

        std::vector<std::pair<std::string, std::vector<std::string>>> byCount( nets.begin(),
                                                                               nets.end() );
        std::sort( byCount.begin(), byCount.end(),
                   []( const auto& a, const auto& b ) { return a.second.size() > b.second.size(); } );

        for( size_t i = 0; i < byCount.size() && i < 2; ++i )
        {
            auto ids = byCount[i].second;

            if( ids.size() > 12 )
                ids.resize( 12 );

            groups.push_back( { { "label", "net " + byCount[i].first }, { "ids", ids } } );
        }
    }

    return json{ { "groups", groups } }.dump();
}

// Test/tuner helper: the first N top-level item uuids — real, resolvable KIIDs
// for synthetic remote-selection previews (a solo tab has no peer to borrow from).
std::string pcbCollabTestListItems( int aCount )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    json out = json::array();

    if( fr )
    {
        forEachTopItem( *fr->GetBoard(), [&]( BOARD_ITEM* item )
                        {
                            if( (int) out.size() < aCount && !item->GetParentFootprint() )
                                out.push_back( toUtf8( item->m_Uuid.AsString() ) );
                        } );
    }

    return out.dump();
}

// JS → C++ (0005): pan the view to a world position (comment panel "jump to
// pin"). CallAfter + COROUTINE like every other view mutation from JS.
void pcbCollabSetViewport( double aCx, double aCy )
{
    presenceCore().panTo( aCx, aCy );
}

// JS → C++ (0008 follow-user): fit a leader's world rect into this canvas.
void pcbCollabFitViewport( double aCx, double aCy, double aHalfW, double aHalfH )
{
    presenceCore().fitViewport( aCx, aCy, aHalfW, aHalfH );
}

// JS pull of the current viewport transform (world↔screen mapping for the DOM layer):
// `{cx,cy,scale,w,h}` — world center, pixels-per-IU scale, canvas size in px.
std::string pcbCollabGetViewport()
{
    return presenceCore().viewportJson();
}

// JS pull of the CURRENT selection's uuids (presence seed at attach + the e2e's
// no-state-leak probe: a remote render must leave this empty).
std::string pcbCollabGetSelection()
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "[]";

    return presenceCore().selectionUuids( fr ).dump();
}

// JS pull of the current selection WITH the footprints' schematic paths (0006):
// `{uuids:[…], fpPaths:[…]}` — the same payload checkSelection emits. Seeds the
// cross-app presence at attach; GetSelection above keeps its bare-array shape
// for the pre-0006 callers and the e2e no-leak probe.
std::string pcbCollabGetSelectionFull()
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "{\"uuids\":[],\"fpPaths\":[]}";

    return selectionPayload( fr ).dump();
}

// Test probe (0006): the board-item uuids the current peers' cross-app
// selections (xsel symbol uuids) resolve to on THIS board — same resolveXsel
// the render uses, so the assertion target can't drift from the pixels.
std::string pcbCollabTestGetCrossMapped()
{
    json arr = json::array();

    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return arr.dump();

    for( const pcbjam_presence::PEER& peer : presenceCore().peers )
    {
        for( FOOTPRINT* fp : resolveXsel( fr, peer ) )
            arr.push_back( toUtf8( fp->m_Uuid.AsString() ) );
    }

    return arr.dump();
}

// Test helper: REALLY select the first top-level item through the selection tool (the
// same call the cross-probe flash uses), then run the presence check — a programmatic
// select has no closing canvas event. Returns the selected uuid.
std::string pcbCollabTestSelectFirst()
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    BOARD_ITEM* target = nullptr;

    forEachTopItem( *fr->GetBoard(), [&]( BOARD_ITEM* item )
                    {
                        if( !target )
                            target = item;
                    } );

    if( !target )
        return "";

    presenceCore().selectItem( target );

    return toUtf8( target->m_Uuid.AsString() );
}

// Test helper (0006): REALLY select the first FOOTPRINT through the selection
// tool — the deterministic cross-app subject (TestSelectFirst may pick a track,
// which legitimately maps to nothing in eeschema). Returns the uuid, "" if the
// board has no footprints.
std::string pcbCollabTestSelectComponent()
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    FOOTPRINT* target = nullptr;

    for( FOOTPRINT* fp : fr->GetBoard()->Footprints() )
    {
        target = fp;
        break;
    }

    if( !target )
        return "";

    presenceCore().selectItem( target );

    return toUtf8( target->m_Uuid.AsString() );
}

// Test helper (0007): select a SPECIFIC item by uuid through the selection
// tool. The tiebreak specs need both tabs holding the SAME item, and
// cross-tab "first footprint" iteration order is not guaranteed — a
// ysync-materialized board need not match the seeding tab's parse order.
bool pcbCollabTestSelectByUuid( std::string aUuid )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return false;

    BOARD_ITEM* item = fr->GetBoard()->ResolveItem(
            KIID( wxString::FromUTF8( aUuid.c_str() ) ), /*allowNull*/ true );

    if( !item )
        return false;

    presenceCore().selectItem( item );

    return true;
}

// JS → C++ (0007): the local client LOST the selection tiebreak — release the
// contested items (only those) from the live selection. If an interactive
// tool (move/drag) holds them, cancel it first (ESC semantics — the preview
// reverts); a bare cancel is NOT sent when idle, since ESC on the base
// selection tool would clear the whole selection. Ends with a forced
// selection re-emit (programmatic changes close no canvas event).
void pcbCollabReleaseSelection( std::string aUuidsJson, std::string aHolder )
{
    presenceCore().releaseSelection( aUuidsJson, aHolder );
}

// Test probe (0007): the current remote soft-lock set as `[{uuid, name}]`.
std::string pcbCollabTestGetLocked()
{
    return presenceCore().locksJson();
}

// Test helper: clear the selection through the tool + run the presence check.
bool pcbCollabTestClearSelection()
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return false;

    fr->CallAfter( [fr]() {
        // ClearSelection is not on the shared SELECTION_TOOL base — the one
        // presence hook that stays editor-typed.
        if( PCB_SELECTION_TOOL* st = fr->GetToolManager()->GetTool<PCB_SELECTION_TOOL>() )
        {
            st->ClearSelection();
            presenceCore().scheduleSelCheck();
        }
    } );

    return true;
}

// Test helper: the s-expr clipboard blob for an item by uuid (what the emit side attaches to an
// `added` payload). Lets the e2e round-trip the blob add path without a real draw.
std::string kicadCollabTestItemBlob( std::string aId )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    BOARD* board = fr->GetBoard();

    if( BOARD_ITEM* item = board->ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                               /*allowNullptr*/ true ) )
    {
        return blobForItem( board, item );
    }

    return "";
}

// ── ysync-review repro hooks ─────────────────────────────────────────────────
// Local-edit test hooks for the ysync-review repro e2e (docs/features/
// ysync-review on the ysync-review branch): each drives a REAL BOARD_COMMIT on
// the app main stack inside a COROUTINE fiber (the collabTestMove wrapping —
// virtual item mutators mis-dispatch off the fiber stack), so the
// COLLAB_LISTENER → flushDiff emit path runs exactly as for a UI edit. Each
// returns false when the uuid doesn't resolve, letting the spec distinguish
// "hook missed the item" from "differ missed the edit" (bug 04).

// Resolve a live board item by uuid, or null (shared by the hooks below).
static BOARD_ITEM* testResolve( PCB_EDIT_FRAME* aFrame, const std::string& aId )
{
    if( !aFrame )
        return nullptr;

    return aFrame->GetBoard()->ResolveItem( KIID( wxString::FromUTF8( aId.c_str() ) ),
                                            /*allowNullptr*/ true );
}

// Delete an item by uuid. With a footprint CHILD uuid this is the bug-03
// sending half (the UI's fp-text delete): the emit must lift to a parent
// re-blob; today it goes out as a bare child removal.
// Run Edit>Undo / read the undo depth — miss 09; frame-generic, collab_common.h.
bool pcbCollabTestUndo()
{
    return pcbjam_collab::testUndo( pcbFrame() );
}

int pcbCollabTestUndoDepth()
{
    return pcbjam_collab::testUndoDepth( pcbFrame() );
}

bool pcbCollabTestRemoveItem( std::string aId )
{
    PCB_EDIT_FRAME* fr = pcbFrame();
    BOARD_ITEM*     item = testResolve( fr, aId );

    if( !item )
        return false;

    pcbjam_collab::runOnFiber( fr, [fr, item]() {
        BOARD_COMMIT commit( fr );
        commit.Remove( item );
        commit.Push( wxT( "Collab test remove" ) );
    } );

    return true;
}

// Rotate an item about its OWN anchor — bug 04: the scalar json carries no
// orientation for footprints, so an anchor-centred rotation is invisible to
// the differ unless a child's absolute position happens to move.
bool pcbCollabTestRotateItem( std::string aId, double aDeg )
{
    PCB_EDIT_FRAME* fr = pcbFrame();
    BOARD_ITEM*     item = testResolve( fr, aId );

    if( !item )
        return false;

    pcbjam_collab::runOnFiber( fr, [fr, item, aDeg]() {
        BOARD_COMMIT commit( fr );
        commit.Modify( item );
        item->Rotate( item->GetPosition(), EDA_ANGLE( aDeg, DEGREES_T ) );
        commit.Push( wxT( "Collab test rotate" ) );
    } );

    return true;
}

// Resize a pad (the pad-properties dialog edit) — bug 04: pads are not visited
// by forEachTopItem at all, so the edit never reaches either wire.
bool pcbCollabTestSetPadSize( std::string aId, int aW, int aH )
{
    PCB_EDIT_FRAME* fr = pcbFrame();
    BOARD_ITEM*     item = testResolve( fr, aId );

    if( !item || item->Type() != PCB_PAD_T )
        return false;

    PAD* pad = static_cast<PAD*>( item );

    pcbjam_collab::runOnFiber( fr, [fr, pad, aW, aH]() {
        BOARD_COMMIT commit( fr );
        commit.Modify( pad );
        pad->SetSize( PADSTACK::ALL_LAYERS, VECTOR2I( aW, aH ) );
        commit.Push( wxT( "Collab test pad size" ) );
    } );

    return true;
}

// Drag a track/shape END point only — bug 04: Drawings' json is position-only
// and GetPosition() is the START, so an end-point reshape of a graphic shape
// is invisible (tracks DO carry endpoints — the visible control case).
bool pcbCollabTestMoveEndpoint( std::string aId, int aDx, int aDy )
{
    PCB_EDIT_FRAME* fr = pcbFrame();
    BOARD_ITEM*     item = testResolve( fr, aId );

    if( !item || ( !isTrackType( item->Type() ) && item->Type() != PCB_SHAPE_T ) )
        return false;

    pcbjam_collab::runOnFiber( fr, [fr, item, aDx, aDy]() {
        BOARD_COMMIT commit( fr );
        commit.Modify( item );

        if( isTrackType( item->Type() ) )
        {
            auto* t = static_cast<PCB_TRACK*>( item );
            t->SetEnd( t->GetEnd() + VECTOR2I( aDx, aDy ) );
        }
        else
        {
            auto* s = static_cast<PCB_SHAPE*>( item );
            s->SetEnd( s->GetEnd() + VECTOR2I( aDx, aDy ) );
        }

        commit.Push( wxT( "Collab test endpoint" ) );
    } );

    return true;
}

// ── drift-trio phase B action hooks (standalone-hardening 0008 §5) ───────────
// Creation/mutation primitives for the trio harness's action catalog. Each
// drives a REAL BOARD_COMMIT on the fiber stack, so the BOARD_LISTENER →
// flushDiff emit path runs exactly as for a UI edit. Names are tool-unique
// (registered outside the KICAD_MERGED_EMBIND guard — same convention as
// kicadCollabTestSetPadSize), so the merged image needs no dispatcher.

// Commit a freshly-built board item; returns its uuid.
static std::string pcbCollabTestCommitAdd( BOARD_ITEM* aItem, const wxChar* aMsg )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
    {
        delete aItem;
        return "";
    }

    std::string id = toUtf8( aItem->m_Uuid.AsString() );
    wxString    msg( aMsg );

    pcbjam_collab::runOnFiber( fr, [fr, aItem, msg]() {
        BOARD_COMMIT commit( fr );
        commit.Add( aItem );
        commit.Push( msg );
    } );

    return id;
}

std::string pcbCollabTestAddTrack( int aX1, int aY1, int aX2, int aY2, int aWidth,
                                   std::string aLayer )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    BOARD*     board = fr->GetBoard();
    PCB_TRACK* track = new PCB_TRACK( board );
    track->SetStart( VECTOR2I( aX1, aY1 ) );
    track->SetEnd( VECTOR2I( aX2, aY2 ) );
    track->SetWidth( aWidth );
    track->SetLayer( board->GetLayerID( wxString::FromUTF8( aLayer.c_str() ) ) );
    return pcbCollabTestCommitAdd( track, wxT( "Collab test add track" ) );
}

std::string pcbCollabTestAddVia( int aX, int aY, int aSize, int aDrill )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    PCB_VIA* via = new PCB_VIA( fr->GetBoard() );
    via->SetPosition( VECTOR2I( aX, aY ) );
    via->SetWidth( aSize );
    via->SetDrill( aDrill );
    return pcbCollabTestCommitAdd( via, wxT( "Collab test add via" ) );
}

std::string pcbCollabTestAddBoardText( std::string aText, int aX, int aY, std::string aLayer )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    BOARD*    board = fr->GetBoard();
    PCB_TEXT* text = new PCB_TEXT( board );
    text->SetText( wxString::FromUTF8( aText.c_str() ) );
    text->SetTextPos( VECTOR2I( aX, aY ) );
    text->SetLayer( board->GetLayerID( wxString::FromUTF8( aLayer.c_str() ) ) );
    return pcbCollabTestCommitAdd( text, wxT( "Collab test add text" ) );
}

// Rectangular unfilled zone outline on one layer.
std::string pcbCollabTestAddZone( int aX1, int aY1, int aX2, int aY2, std::string aLayer )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !fr )
        return "";

    BOARD* board = fr->GetBoard();
    ZONE*  zone = new ZONE( board );
    zone->SetLayer( board->GetLayerID( wxString::FromUTF8( aLayer.c_str() ) ) );
    zone->Outline()->NewOutline();
    zone->Outline()->Append( aX1, aY1 );
    zone->Outline()->Append( aX2, aY1 );
    zone->Outline()->Append( aX2, aY2 );
    zone->Outline()->Append( aX1, aY2 );
    return pcbCollabTestCommitAdd( zone, wxT( "Collab test add zone" ) );
}

bool pcbCollabTestFlipBoardItem( std::string aId )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !testResolve( fr, aId ) )
        return false;

    pcbjam_collab::runOnFiber( fr, [fr, aId]() {   // re-resolve on the fiber (S4)
        BOARD_ITEM* item = testResolve( fr, aId );

        if( !item )
            return;

        BOARD_COMMIT commit( fr );
        commit.Modify( item );
        item->Flip( item->GetPosition(), FLIP_DIRECTION::LEFT_RIGHT );
        commit.Push( wxT( "Collab test flip" ) );
    } );

    return true;
}

// aField: "Reference" | "Value" (the two mandatory text fields).
bool pcbCollabTestSetFootprintField( std::string aId, std::string aField, std::string aText )
{
    PCB_EDIT_FRAME* fr = pcbFrame();
    BOARD_ITEM*     item = testResolve( fr, aId );

    if( !item || item->Type() != PCB_FOOTPRINT_T )
        return false;

    wxString text = wxString::FromUTF8( aText.c_str() );
    bool     isRef = ( aField == "Reference" );

    if( !isRef && aField != "Value" )
        return false;

    pcbjam_collab::runOnFiber( fr, [fr, aId, text, isRef]() {   // re-resolve on the fiber (S4)
        BOARD_ITEM* live = testResolve( fr, aId );

        if( !live || live->Type() != PCB_FOOTPRINT_T )
            return;

        FOOTPRINT*   fp = static_cast<FOOTPRINT*>( live );
        BOARD_COMMIT commit( fr );
        commit.Modify( fp );

        if( isRef )
            fp->SetReference( text );
        else
            fp->SetValue( text );

        commit.Push( wxT( "Collab test footprint field" ) );
    } );

    return true;
}

bool pcbCollabTestSetBoardItemLocked( std::string aId, bool aLocked )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !testResolve( fr, aId ) )
        return false;

    pcbjam_collab::runOnFiber( fr, [fr, aId, aLocked]() {   // re-resolve on the fiber (S4)
        BOARD_ITEM* item = testResolve( fr, aId );

        if( !item )
            return;

        BOARD_COMMIT commit( fr );
        commit.Modify( item );
        item->SetLocked( aLocked );
        commit.Push( wxT( "Collab test lock" ) );
    } );

    return true;
}

// By-uuid variant of MoveFirst (same fiber + BOARD_COMMIT body).
bool pcbCollabTestMoveBoardItem( std::string aId, int aDx, int aDy )
{
    PCB_EDIT_FRAME* fr = pcbFrame();

    if( !testResolve( fr, aId ) )
        return false;

    // Re-resolve ON the fiber: a remote remove can apply between scheduling
    // and running, and doApplyItems FREES removed items — a captured pointer
    // would be dangling and the commit would resurrect a deleted item
    // (drift-trio S4 move-vs-delete). Vanished => the move loses, silently.
    pcbjam_collab::runOnFiber( fr, [fr, aId, aDx, aDy]() {
        if( BOARD_ITEM* item = testResolve( fr, aId ) )
            collabTestMove( fr, item, aDx, aDy );
    } );
    return true;
}

// Duplicate (fresh uuids — exercises the FOOTPRINT copy-ctor uuid class).
std::string pcbCollabTestDuplicateBoardItem( std::string aId, int aDx, int aDy )
{
    PCB_EDIT_FRAME* fr = pcbFrame();
    BOARD_ITEM*     item = testResolve( fr, aId );

    if( !item )
        return "";

    if( item->GetParentFootprint() )
        return "";                          // duplicate roots only

    BOARD_ITEM* dup = item->Duplicate( /*addToParentGroup*/ false );
    dup->Move( VECTOR2I( aDx, aDy ) );

    std::string id = toUtf8( dup->m_Uuid.AsString() );

    pcbjam_collab::runOnFiber( fr, [fr, dup]() {
        BOARD_COMMIT commit( fr );
        commit.Add( dup );
        commit.Push( wxT( "Collab test duplicate" ) );
    } );

    return id;
}

// Wrapper to return footprints as vector for JS iteration
std::vector<FOOTPRINT*> Board_GetFootprints(BOARD* board) {
    if (!board) return {};
    std::vector<FOOTPRINT*> result;
    for (FOOTPRINT* fp : board->Footprints()) {
        result.push_back(fp);
    }
    return result;
}

// Wrapper to return pads as vector
std::vector<PAD*> Footprint_GetPads(FOOTPRINT* fp) {
    if (!fp) return {};
    std::vector<PAD*> result;
    for (PAD* pad : fp->Pads()) {
        result.push_back(pad);
    }
    return result;
}

// Wrapper for GetFileName since it returns wxString
std::string Board_GetFileName(BOARD* board) {
    if (!board) return "";
    return board->GetFileName().ToStdString();
}

// Wrapper for footprint reference
std::string Footprint_GetReference(FOOTPRINT* fp) {
    if (!fp) return "";
    return fp->GetReference().ToStdString();
}

// Wrapper for footprint value
std::string Footprint_GetValue(FOOTPRINT* fp) {
    if (!fp) return "";
    return fp->GetValue().ToStdString();
}

// Wrapper for pad number
std::string Pad_GetNumber(PAD* pad) {
    if (!pad) return "";
    return pad->GetNumber().ToStdString();
}

// Wrapper for pad pin function
std::string Pad_GetPinFunction(PAD* pad) {
    if (!pad) return "";
    return pad->GetPinFunction().ToStdString();
}

static bool kicadCollabFiberBusyProbe()
{
    return pcbjam_collab::fiberBusy() || !pcbjam_collab::fiberQueue().empty();
}

EMSCRIPTEN_BINDINGS(pcbnew) {
    // Register vector types for iteration
    register_vector<FOOTPRINT*>("FootprintVector");
    register_vector<PAD*>("PadVector");

    // Helper functions that operate on pointers
    // Note: GetBoard() not available - will be added when Pyodide integration is done
    function("Board_GetFootprints", &Board_GetFootprints, allow_raw_pointers());
    function("Board_GetFileName", &Board_GetFileName, allow_raw_pointers());
    function("Footprint_GetPads", &Footprint_GetPads, allow_raw_pointers());
    function("Footprint_GetReference", &Footprint_GetReference, allow_raw_pointers());
    function("Footprint_GetValue", &Footprint_GetValue, allow_raw_pointers());
    function("Pad_GetNumber", &Pad_GetNumber, allow_raw_pointers());
    function("Pad_GetPinFunction", &Pad_GetPinFunction, allow_raw_pointers());

    // Programmatic save of the in-memory board (round-trip tests, README §A).
    function("kicadSaveBoard", &kicadSaveBoard);
    // pcbnew-only test helper (no eeschema counterpart — name is not shared).
    function("kicadCollabTestItemBlob", &kicadCollabTestItemBlob);
    // pcbnew-only ysync-review repro hooks (names not shared with eeschema).
    function("kicadCollabTestSetPadSize", &pcbCollabTestSetPadSize);
    function("kicadCollabTestMoveEndpoint", &pcbCollabTestMoveEndpoint);
    // drift-trio phase B action hooks (tool-unique names, merged-image safe).
    function("kicadCollabTestAddTrack", &pcbCollabTestAddTrack);
    function("kicadCollabTestAddVia", &pcbCollabTestAddVia);
    function("kicadCollabTestAddBoardText", &pcbCollabTestAddBoardText);
    function("kicadCollabTestAddZone", &pcbCollabTestAddZone);
    function("kicadCollabTestFlipBoardItem", &pcbCollabTestFlipBoardItem);
    function("kicadCollabTestSetFootprintField", &pcbCollabTestSetFootprintField);
    function("kicadCollabTestSetBoardItemLocked", &pcbCollabTestSetBoardItemLocked);
    function("kicadCollabTestMoveBoardItem", &pcbCollabTestMoveBoardItem);
    function("kicadCollabTestDuplicateBoardItem", &pcbCollabTestDuplicateBoardItem);

#ifndef KICAD_MERGED_EMBIND
    // JS names ALSO registered by eeschema_embind.cpp — in the merged image these are
    // registered once by kicad_editor_embind.cpp, dispatching on the active frame.
    // Programmatic file open (preferred over UI automation from the web app).
    function("kicadOpenFile", &kicadOpenFile);
    function("kicadOpenFileBusy", &kicadOpenFileBusy);
    function("kicadTestSetOpenPark", &kicadTestSetOpenPark);
    function("kicadCollabFiberBusy", &kicadCollabFiberBusyProbe);
    // Read-only viewer lock (read-only-viewer).
    function("kicadSetReadOnly", &kicadSetReadOnly);
    // Yjs collaborative bridge entry points (same contract as pl_editor / eeschema).
    function("kicadCollabApply", &pcbCollabApply);
    function("kicadCollabSnapshot", &pcbCollabSnapshot);
    // v2 items bridge: per-item s-expr payloads (ysync 0008).
    function("kicadCollabApplyItems", &pcbCollabApplyItems);
    function("kicadCollabSnapshotItems", &pcbCollabSnapshotItems);
    function("kicadCollabTestMoveFirst", &pcbCollabTestMoveFirst);
    function("kicadCollabGetPos", &pcbCollabGetPos);
    // ysync-review repro hooks shared with eeschema (dispatched when merged).
    function("kicadCollabTestRemoveItem", &pcbCollabTestRemoveItem);
    function("kicadCollabTestUndo", &pcbCollabTestUndo);
    function("kicadCollabTestUndoDepth", &pcbCollabTestUndoDepth);
    function("kicadCollabTestRotateItem", &pcbCollabTestRotateItem);
    // Presence (collab-presence 0002) — shared names; eeschema's counterparts land
    // with 0003 (the merged image dispatches pcb-only until then).
    function("kicadCollabPresenceStart", &pcbCollabPresenceStart);
    function("kicadCollabSetRemote", &pcbCollabSetRemote);
    function("kicadCollabSetPins", &pcbCollabSetPins);
    function("kicadCollabSetViewport", &pcbCollabSetViewport);
    // Follow-user (collab-presence 0008).
    function("kicadCollabFitViewport", &pcbCollabFitViewport);
    function("kicadCollabSetStyle", &pcbCollabSetStyle);
    // Live color-theme switch (comments-ux 0002 F4).
    function("kicadSetColorTheme", &pcbSetColorTheme);
    function("kicadSetDarkChrome", &pcbSetDarkChrome);
    function("kicadCollabTestListItems", &pcbCollabTestListItems);
    function("kicadCollabTestDemoSet", &pcbCollabTestDemoSet);
    function("kicadCollabGetViewport", &pcbCollabGetViewport);
    function("kicadCollabGetSelection", &pcbCollabGetSelection);
    // Cross-app selection (0006).
    function("kicadCollabGetSelectionFull", &pcbCollabGetSelectionFull);
    function("kicadCollabTestGetCrossMapped", &pcbCollabTestGetCrossMapped);
    // Selection soft-locks (0007).
    function("kicadCollabReleaseSelection", &pcbCollabReleaseSelection);
    function("kicadCollabTestGetLocked", &pcbCollabTestGetLocked);
    function("kicadCollabTestSelectFirst", &pcbCollabTestSelectFirst);
    function("kicadCollabTestSelectComponent", &pcbCollabTestSelectComponent);
    function("kicadCollabTestSelectByUuid", &pcbCollabTestSelectByUuid);
    function("kicadCollabTestClearSelection", &pcbCollabTestClearSelection);
    // Library reload after a remote (synced) lib edit — r2-idb-sync realtime.
    function("kicadLibsReload", &pcbjam_libs::reloadLibrary);
#endif // !KICAD_MERGED_EMBIND
}
#endif
