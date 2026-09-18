/*
 * Collab presence core (collab-presence 0002/0003/0005/0006/0007) — the
 * editor-agnostic half of the presence layer, shared by the pcbnew and
 * eeschema binding TUs so the two implementations can't drift.
 *
 * Everything here talks only to the shared KiCad base classes
 * (EDA_DRAW_FRAME, SELECTION_TOOL, KIGFX::VIEW) — the small per-editor
 * remainder (how to resolve a KIID, how to draw one peer's selection/xsel,
 * what the selection emit payload carries) plugs in through CORE's hooks.
 * Each binding TU owns ONE CORE instance in its anonymous namespace, so the
 * merged kicad_editor image keeps today's per-editor state separation.
 *
 * The drawing itself (shapes, labels, cursors, pins, style knobs) stays in
 * collab_presence_style.h; this header owns the state + event/scheduling
 * machinery around it.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>
#include <wx/event.h>
#include <wx/string.h>
#include <nlohmann/json.hpp>

#include <class_draw_panel_gal.h>
#include <eda_draw_frame.h>
#include <eda_item.h>
#include <kiid.h>
#include <pcbjam_remote_lock.h>
#include <tool/selection_tool.h>
#include <tool/tool_manager.h>
#include <view/view.h>
#include <view/view_overlay.h>

#include "collab_common.h"
#include "open_gate.h"
#include "collab_presence_style.h"

namespace pcbjam_presence {

struct PEER
{
    std::string       id;                // awareness identity (cursor-only updates key on it)
    std::string       name;
    KIGFX::COLOR4D    color;
    bool              hasCursor = false;
    VECTOR2D          cursor;            // world coords (IU)
    std::vector<KIID> selection;
    // Cross-app selection (0006): the peer's selection in the OTHER editor,
    // as SYMBOL uuids (pcbnew footprint paths are stripped to their tail by
    // the TS side). Ghost-rendered by the per-editor drawPeerShapes hook.
    std::vector<KIID> xsel;
    // Reviewer = commenter (comments-ux 0003 §5.2): the role is server-
    // verified on the TS side; drawn with reviewerStyle(), never a lock.
    bool              reviewer = false;
};

// Comment pin dot (collab-presence 0005): the GAL half of the hybrid pin —
// zero pan/zoom lag; the clickable hit target + thread popover are DOM.
struct PIN
{
    std::string    id;
    std::string    name;                 // author (palette-override rehash key)
    VECTOR2D       pos;                  // world coords (IU)
    KIGFX::COLOR4D color;
    bool           resolved = false;
    bool           unread   = false;     // comments-ux 0001 C: accent ring
};

inline long long nowMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
                   std::chrono::steady_clock::now().time_since_epoch() )
            .count();
}

/** Findings W-1/W-4: `json::value( key, default )` only defaults on a MISSING
 *  key — a present `null` (what JSON.stringify makes of ±Infinity/NaN) throws
 *  nlohmann type_error.302 across embind. Read numbers permissively. */
inline double numOr( const nlohmann::json& aObj, const char* aKey, double aDefault )
{
    if( !aObj.is_object() )
        return aDefault;

    auto it = aObj.find( aKey );
    return it != aObj.end() && it->is_number() ? it->get<double>() : aDefault;
}

inline KIGFX::COLOR4D parsePeerColor( const std::string& aHex )
{
    if( aHex.size() == 7 && aHex[0] == '#' )
    {
        long v = strtol( aHex.c_str() + 1, nullptr, 16 );
        return KIGFX::COLOR4D( ( ( v >> 16 ) & 0xff ) / 255.0, ( ( v >> 8 ) & 0xff ) / 255.0,
                               ( v & 0xff ) / 255.0, 0.9 );
    }

    return KIGFX::COLOR4D( 0.23, 0.51, 0.96, 0.9 ); // palette blue fallback
}

/**
 * Per-editor presence state + machinery. One instance per binding TU; the
 * hooks below are set once at construction (see presenceCore() in each TU).
 */
struct CORE
{
    using json = nlohmann::json;

    // ── per-editor hooks ──────────────────────────────────────────────────
    /** The live editor frame, or nullptr (the usual dynamic_cast probe). */
    std::function<EDA_DRAW_FRAME*()> frame;

    /** The editor's selection tool (GetTool<> needs the concrete type). */
    std::function<SELECTION_TOOL*( EDA_DRAW_FRAME* )> selectionTool;

    /** What checkSelection hands to JS: a bare uuid array (eeschema) or the
     *  0006 {uuids, fpPaths} payload (pcbnew). */
    std::function<json( EDA_DRAW_FRAME* )> selectionEmitPayload;

    /** Resolve a KIID to a live item, or nullptr (releaseSelection). */
    std::function<EDA_ITEM*( EDA_DRAW_FRAME*, const KIID& )> resolveItem;

    /** Draw ONE peer's selection boxes + cross-app ghosts into the overlays
     *  (item resolution and exact-outline rendering are editor-specific).
     *  Cursors and pins are drawn by the shared redraw loop. */
    std::function<void( CORE&, EDA_DRAW_FRAME*, const PEER&, const KIGFX::COLOR4D&, double )>
            drawPeerShapes;

    // ── state ─────────────────────────────────────────────────────────────
    std::vector<PEER>           peers;
    std::vector<PIN>            pins;
    // Remote soft-locks (0007): uuid → holding peer's display name, derived
    // by the TS side from ALL other clients' live selections (own user's
    // other tabs included). Consulted by the fork's PCBJAM_REMOTE_LOCK query
    // from the selection/move tools. Ephemeral — replaced on every setRemote.
    std::map<KIID, std::string> locks;
    // Every visual knob — see collab_presence_style.h; live-patched by
    // kicadCollabSetStyle (tuner). Editors seed their own defaults.
    STYLE                       style;

    std::shared_ptr<KIGFX::VIEW_OVERLAY> overlay;
    // Name chips + pin dots render one depth unit ABOVE the selection shapes
    // (else an earlier-painted low-alpha fill rejects the chip's fragments and
    // the tag washes out to the fill's alpha), and the text one unit above the
    // chips — see the depth-layering note in collab_presence_style.h.
    std::shared_ptr<KIGFX::VIEW_OVERLAY> chipOverlay;
    std::shared_ptr<KIGFX::VIEW_OVERLAY> textOverlay;
    // Cursors live on their own overlay trio (findings Y-4): a peer's 20 Hz
    // cursor tick repaints these only; the selection/xsel/pin shapes above
    // are repainted only when a selection, lock, pin or zoom changes.
    std::shared_ptr<KIGFX::VIEW_OVERLAY> cursorOverlay;
    std::shared_ptr<KIGFX::VIEW_OVERLAY> cursorChipOverlay;
    std::shared_ptr<KIGFX::VIEW_OVERLAY> cursorTextOverlay;

    bool        started           = false;
    bool        redrawScheduled   = false;
    bool        shapesDirty       = false;
    bool        cursorsDirty      = false;
    bool        docChangeScheduled = false;
    std::string lastShapeSig;        // setRemote dedupe: shapes vs cursor-only change
    bool        selCheckScheduled = false;
    std::string lastSelectionJson;   // dedupe: emit only when the payload changed
    long long   lastCursorEmitMs = 0;
    double      lastVpScale  = 0.0;
    VECTOR2D    lastVpCenter;
    VECTOR2I    lastVpSize;

    // ── local state emit (selection / cursor / viewport) ──────────────────

    json selectionUuids( EDA_DRAW_FRAME* aFrame )
    {
        json uuids = json::array();

        SELECTION_TOOL* selTool = selectionTool( aFrame );

        if( !selTool )
            return uuids;

        for( EDA_ITEM* item : selTool->GetSelection() )
            uuids.push_back( pcbjam_collab::toUtf8( item->m_Uuid.AsString() ) );

        return uuids;
    }

    // Post-settle selection emit: read the selection AFTER the triggering event
    // finished (CallAfter), dedupe against the last emitted set, hand to JS.
    void checkSelection()
    {
        selCheckScheduled = false;

        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        std::string s = selectionEmitPayload( fr ).dump();

        if( s == lastSelectionJson )
            return;

        lastSelectionJson = s;
        pcbjam_collab::emitSelection( s );
    }

    void scheduleSelCheck()
    {
        if( selCheckScheduled )
            return;

        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        selCheckScheduled = true;
        fr->CallAfter( [this]() { checkSelection(); } );
    }

    // Viewport push (world↔screen mapping for the DOM layers, 0005). Zoom also
    // invalidates the overlay's screen-constant sizes → schedule a redraw.
    void emitViewportIfChanged()
    {
        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        KIGFX::VIEW*    view  = fr->GetCanvas()->GetView();
        double          scale = view->GetScale();   // zoom — cheap change detector only
        VECTOR2D        c     = view->GetCenter();
        const VECTOR2I& sz    = view->GetScreenPixelSize();

        // Size participates in the dedupe: the JS worldToScreen maps through
        // w/2,h/2, so a canvas resize (or the boot layout settling after the
        // bind-time seed) with an unchanged scale/center must still re-push —
        // else every DOM pin target is vertically offset until the next
        // pan/zoom.
        if( scale == lastVpScale && c == lastVpCenter && sz == lastVpSize )
            return;

        lastVpScale  = scale;
        lastVpCenter = c;
        lastVpSize   = sz;

        // px per IU via the GAL matrix — GetScale() is the zoom, not px/IU.
        pcbjam_collab::emitViewport( c.x, c.y, view->ToScreen( 1.0 ), sz.x, sz.y );

        if( !peers.empty() )
            scheduleRedraw();
    }

    /** kicadCollabGetViewport: `{cx,cy,scale,w,h}`, scale = px per IU via the
     *  GAL matrix (GetScale() is the zoom, not px/IU — pcbnew 0002 lesson). */
    std::string viewportJson()
    {
        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return "";

        KIGFX::VIEW*    view = fr->GetCanvas()->GetView();
        VECTOR2D        c    = view->GetCenter();
        const VECTOR2I& sz   = view->GetScreenPixelSize();

        return json{ { "cx", c.x }, { "cy", c.y }, { "scale", view->ToScreen( 1.0 ) },
                     { "w", sz.x }, { "h", sz.y } }.dump();
    }

    /** kicadCollabFitViewport (0008 follow-user): fit the given world RECT
     *  (center + half-extents, IU) into this canvas — contain, never crop:
     *  the follower's zoom is derived from ITS OWN canvas size, so leaders
     *  and followers on different monitors see the same world region.
     *  Apply coroutine like every other view mutation from JS. */
    void fitViewport( double aCx, double aCy, double aHalfW, double aHalfH )
    {
        EDA_DRAW_FRAME* fr = frame();

        if( !fr || aHalfW <= 0 || aHalfH <= 0 )
            return;

        pcbjam_collab::runOnCoroutine( fr, [this, fr, aCx, aCy, aHalfW, aHalfH]() {
            KIGFX::VIEW*    view = fr->GetCanvas()->GetView();
            const VECTOR2I& sz   = view->GetScreenPixelSize();

            // Pixels-per-IU that CONTAINS the rect in both axes. GetScale() is
            // the zoom, not px/IU (0002 lesson) — convert via the GAL matrix:
            // zoom scales linearly with px/IU, so target zoom = current zoom ×
            // (target px/IU ÷ current px/IU).
            double pxPerIuNow = view->ToScreen( 1.0 );
            double pxPerIuFit = std::min( sz.x / ( 2.0 * aHalfW ), sz.y / ( 2.0 * aHalfH ) );

            if( pxPerIuNow > 0 && pxPerIuFit > 0 )
                view->SetScale( view->GetScale() * ( pxPerIuFit / pxPerIuNow ) );

            view->SetCenter( VECTOR2D( aCx, aCy ) );
            fr->GetCanvas()->ForceRefresh();
            emitViewportIfChanged();
        } );
    }

    /** kicadCollabSetViewport (0005): pan to a world position (comment panel
     *  "jump to pin"). Apply coroutine like every other view mutation from JS. */
    void panTo( double aCx, double aCy )
    {
        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        pcbjam_collab::runOnCoroutine( fr, [this, fr, aCx, aCy]() {
            fr->GetCanvas()->GetView()->SetCenter( VECTOR2D( aCx, aCy ) );
            fr->GetCanvas()->ForceRefresh();
            emitViewportIfChanged();
        } );
    }

    void onMotion( wxMouseEvent& aEvt )
    {
        aEvt.Skip();

        long long now = nowMs();

        if( now - lastCursorEmitMs < 50 )     // ≤20 emits/s, event-driven (no timers)
            return;

        lastCursorEmitMs = now;

        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        // Screen→world via the non-virtual VIEW::ToWorld (the virtual
        // VIEW_CONTROLS::GetMousePosition mis-dispatched here under the
        // retired asyncify runtime; the direct call stays).
        wxPoint  p     = aEvt.GetPosition();
        VECTOR2D world = fr->GetCanvas()->GetView()->ToWorld( VECTOR2D( p.x, p.y ), true );

        pcbjam_collab::emitCursor( world.x, world.y, true );
        emitViewportIfChanged();                // catches drag-pan while moving
    }

    void onLeave( wxMouseEvent& aEvt )
    {
        aEvt.Skip();
        pcbjam_collab::emitCursor( 0, 0, false );
    }

    // ── remote render ─────────────────────────────────────────────────────

    // Repaint the remote-peers overlays. Runs in CallAfter + COROUTINE via the
    // apply queue — serialized with the applies, same constraint as every
    // other view mutation from JS. Two groups, each repainted only when
    // dirty: SHAPES (selection boxes, cross-app ghosts, comment pins — the
    // expensive part: per-item resolve + outline geometry) and CURSORS.
    void redrawOverlay()
    {
        redrawScheduled = false;

        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        KIGFX::VIEW* view = fr->GetCanvas()->GetView();

        if( !overlay )
        {
            // Depth layering near→deep: text (0) < chips (1) < shapes (2) —
            // fork SetDepthOffset; see collab_presence_style.h.
            overlay = view->MakeOverlay();
            overlay->SetDepthOffset( PRESENCE_SHAPES_DEPTH_OFFSET );
        }

        if( !chipOverlay )
        {
            chipOverlay = view->MakeOverlay();
            chipOverlay->SetDepthOffset( PRESENCE_CHIPS_DEPTH_OFFSET );
        }

        if( !textOverlay )
            textOverlay = makePresenceTextOverlay( view );

        if( !cursorOverlay )
        {
            cursorOverlay = view->MakeOverlay();
            cursorOverlay->SetDepthOffset( PRESENCE_SHAPES_DEPTH_OFFSET );
        }

        if( !cursorChipOverlay )
        {
            cursorChipOverlay = view->MakeOverlay();
            cursorChipOverlay->SetDepthOffset( PRESENCE_CHIPS_DEPTH_OFFSET );
        }

        if( !cursorTextOverlay )
            cursorTextOverlay = makePresenceTextOverlay( view );

        // Screen-constant sizing: px → world units, so cursors/outline widths
        // don't scale with zoom. MUST go through the GAL matrix
        // (ToWorld(double)) — the naive 1/GetScale() is the ZOOM factor, not
        // px-per-IU, and under-sizes the drawing by ~7 orders of magnitude.
        double px = view->ToWorld( 1.0 );

        bool shapes  = shapesDirty;
        bool cursors = cursorsDirty;
        shapesDirty  = false;
        cursorsDirty = false;

        if( shapes )
        {
            overlay->Clear();
            chipOverlay->Clear();
            textOverlay->Clear();

            for( const PEER& peer : peers )
            {
                KIGFX::COLOR4D color = peerColor( style, peer.name, peer.color );

                // Selection boxes + cross-app ghosts: editor-specific resolution.
                drawPeerShapes( *this, fr, peer, color, px );
            }

            // Comment pin dots (0005) — on the CHIPS layer so selection fills
            // can't reject their fragments (see drawPin).
            for( const PIN& pin : pins )
            {
                KIGFX::COLOR4D color = peerColor( style, pin.name, pin.color );
                drawPin( chipOverlay.get(), pin.pos, color, pin.resolved, pin.unread, px, style );
            }

            view->Update( overlay.get() );
            view->Update( chipOverlay.get() );
            view->Update( textOverlay.get() );
        }

        if( cursors )
        {
            cursorOverlay->Clear();
            cursorChipOverlay->Clear();
            cursorTextOverlay->Clear();

            for( const PEER& peer : peers )
            {
                if( !peer.hasCursor )
                    continue;

                KIGFX::COLOR4D color = peerColor( style, peer.name, peer.color );
                const STYLE&   s = peer.reviewer ? reviewerStyle( style ) : style;
                drawCursor( cursorOverlay.get(), cursorChipOverlay.get(), cursorTextOverlay.get(),
                            peer.cursor, peerLabel( style, peer.name, peer.reviewer ), color, px,
                            s );
            }

            view->Update( cursorOverlay.get() );
            view->Update( cursorChipOverlay.get() );
            view->Update( cursorTextOverlay.get() );
        }

        if( !shapes && !cursors )
            return;

        // The canvas repaints on its own only with focus/input — force it,
        // exactly as the cross-probe flash does.
        fr->GetCanvas()->ForceRefresh();
    }

    void scheduleRedraw( bool aShapes = true, bool aCursors = true )
    {
        shapesDirty  = shapesDirty || aShapes;
        cursorsDirty = cursorsDirty || aCursors;

        if( redrawScheduled )
            return;

        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        redrawScheduled = true;
        pcbjam_collab::runOnCoroutine( fr, [this]() { redrawOverlay(); } );
    }

    /** The document changed (local commit OR remote apply — findings Y-1/Y-3):
     *  peers' selection boxes may now sit on deleted/moved items, and the
     *  local selection may have lost items with no closing canvas event.
     *  Queued on the apply coroutine so it runs AFTER the commit/apply body
     *  that raised it: repaint the shapes from the live document and re-check
     *  the local selection. Coalesced per settle. */
    void onDocChanged()
    {
        if( docChangeScheduled )
            return;

        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        docChangeScheduled = true;

        pcbjam_collab::runOnCoroutine( fr, [this]()
        {
            docChangeScheduled = false;

            if( !peers.empty() || !pins.empty() )
            {
                shapesDirty  = true;
                cursorsDirty = true;
                redrawOverlay();
            }

            checkSelection();
        } );
    }

    // ── JS entry-point bodies ─────────────────────────────────────────────

    /** kicadCollabPresenceStart: install the input hooks on the GAL canvas
     *  (idempotent — the canvas is the same window for the whole session) and
     *  the fork's remote soft-lock query (0007). */
    void start()
    {
        EDA_DRAW_FRAME* fr = frame();

        if( !fr || started )
            return;

        started = true;

        // Remote soft-locks (0007): let the selection/move tools consult the
        // peers' live selections through the fork's process-global query.
        PCBJAM_REMOTE_LOCK::SetQuery(
                [this]( const KIID& aId, wxString* aHolder ) -> bool
                {
                    auto it = locks.find( aId );

                    if( it == locks.end() )
                        return false;

                    if( aHolder )
                        *aHolder = wxString::FromUTF8( it->second.c_str() );

                    return true;
                } );

        wxWindow* canvas = fr->GetCanvas();

        canvas->Bind( wxEVT_MOTION, [this]( wxMouseEvent& e ) { onMotion( e ); } );
        canvas->Bind( wxEVT_LEAVE_WINDOW, [this]( wxMouseEvent& e ) { onLeave( e ); } );

        // Handlers Skip() so the view controls' own processing is untouched;
        // selection checks run POST-event via CallAfter (the selection tool
        // acts on the same event after us).
        auto selAndViewport = [this]( wxEvent& e )
        {
            e.Skip();
            scheduleSelCheck();

            if( EDA_DRAW_FRAME* f = frame() )
                f->CallAfter( [this]() { emitViewportIfChanged(); } );
        };

        canvas->Bind( wxEVT_LEFT_UP, [selAndViewport]( wxMouseEvent& e ) { selAndViewport( e ); } );
        canvas->Bind( wxEVT_RIGHT_UP, [selAndViewport]( wxMouseEvent& e ) { selAndViewport( e ); } );
        canvas->Bind( wxEVT_KEY_UP, [selAndViewport]( wxKeyEvent& e ) { selAndViewport( e ); } );
        canvas->Bind( wxEVT_MOUSEWHEEL, [selAndViewport]( wxMouseEvent& e ) { selAndViewport( e ); } );

        // Canvas resizes change the w/h half of the world↔screen transform
        // without touching scale/center — re-push post-layout (CallAfter runs
        // after the GAL's own onSize updated the screen size).
        canvas->Bind( wxEVT_SIZE, [this]( wxSizeEvent& e )
        {
            e.Skip();

            if( EDA_DRAW_FRAME* f = frame() )
                f->CallAfter( [this]() { emitViewportIfChanged(); } );
        } );
    }

    /** kicadCollabSetRemote: full remote-peers snapshot — `{peers:[{id,name,
     *  color,cursor:{x,y}|null,selection:[uuid],xsel:[uuid],reviewer?}],
     *  locks:[{uuid,name}]}`, trivially derived from awareness.getStates() and idempotent
     *  (the overlay is cleared + fully redrawn). Empty peers clears it. */
    void setRemote( const std::string& aJson )
    {
        json j = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

        if( j.is_discarded() )
            return;

        std::vector<PEER> parsed;

        for( const json& p : j.value( "peers", json::array() ) )
        {
            PEER peer;
            peer.id    = p.value( "id", "" );
            peer.name  = p.value( "name", "" );
            peer.color = parsePeerColor( p.value( "color", "" ) );
            peer.reviewer = p.contains( "reviewer" ) && p["reviewer"].is_boolean()
                            && p["reviewer"].get<bool>();

            if( p.contains( "cursor" ) && p["cursor"].is_object() )
            {
                peer.hasCursor = true;
                peer.cursor = VECTOR2D( numOr( p["cursor"], "x", 0.0 ), numOr( p["cursor"], "y", 0.0 ) );
            }

            for( const json& u : p.value( "selection", json::array() ) )
            {
                if( u.is_string() )
                    peer.selection.emplace_back( wxString::FromUTF8( u.get<std::string>().c_str() ) );
            }

            // Cross-app selection (0006): symbol uuids from the OTHER editor.
            for( const json& u : p.value( "xsel", json::array() ) )
            {
                if( u.is_string() )
                    peer.xsel.emplace_back( wxString::FromUTF8( u.get<std::string>().c_str() ) );
            }

            parsed.push_back( std::move( peer ) );
        }

        // Remote soft-locks (0007): every other client's held uuids with the
        // holder's display name for the infobar.
        std::map<KIID, std::string> parsedLocks;

        for( const json& l : j.value( "locks", json::array() ) )
        {
            std::string uuid = l.is_object() ? l.value( "uuid", "" ) : "";

            if( !uuid.empty() )
                parsedLocks[ KIID( wxString::FromUTF8( uuid.c_str() ) ) ] = l.value( "name", "" );
        }

        // Shapes signature (everything but cursors): an unchanged one means
        // this push is a cursor tick — repaint cursors only.
        std::string sig;

        for( const PEER& peer : parsed )
        {
            sig += peer.id + '\x1f' + peer.name + '\x1f' + peer.color.ToCSSString().ToStdString()
                   + ( peer.reviewer ? "\x1fr" : "" ) + '\x1e';

            for( const KIID& k : peer.selection )
                sig += pcbjam_collab::toUtf8( k.AsString() ) + ',';

            sig += '\x1e';

            for( const KIID& k : peer.xsel )
                sig += pcbjam_collab::toUtf8( k.AsString() ) + ',';

            sig += '\x1d';
        }

        for( const auto& [id, name] : parsedLocks )
            sig += pcbjam_collab::toUtf8( id.AsString() ) + '=' + name + ';';

        bool shapesChanged = sig != lastShapeSig;
        lastShapeSig = std::move( sig );

        peers = std::move( parsed );
        locks = std::move( parsedLocks );
        start();
        scheduleRedraw( shapesChanged, true );
    }

    /** kicadCollabSetRemoteCursors (findings Y-4): `{cursors:[{id,cursor:{x,y}|null}]}`
     *  for peers of the last full snapshot — updates their cursors and repaints
     *  the cursor overlays only. Unknown ids are ignored (the next full
     *  snapshot introduces them). */
    void setRemoteCursors( const std::string& aJson )
    {
        json j = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

        if( j.is_discarded() )
            return;

        bool changed = false;

        for( const json& c : j.value( "cursors", json::array() ) )
        {
            std::string id = c.is_object() ? c.value( "id", "" ) : "";

            for( PEER& peer : peers )
            {
                if( peer.id != id )
                    continue;

                if( c.contains( "cursor" ) && c["cursor"].is_object() )
                {
                    peer.hasCursor = true;
                    peer.cursor = VECTOR2D( numOr( c["cursor"], "x", 0.0 ), numOr( c["cursor"], "y", 0.0 ) );
                }
                else
                {
                    peer.hasCursor = false;
                }

                changed = true;
            }
        }

        if( changed )
            scheduleRedraw( false, true );
    }

    /** kicadCollabSetPins (0005): comment pins — `{pins:[{id,name,x,y,
     *  color,resolved,unread}]}`, world IU coords resolved by the TS side
     *  from the ydoc anchors. Snapshot semantics like setRemote. */
    void setPins( const std::string& aJson )
    {
        json j = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

        if( j.is_discarded() )
            return;

        std::vector<PIN> parsed;

        for( const json& p : j.value( "pins", json::array() ) )
        {
            PIN pin;
            pin.id       = p.value( "id", "" );
            pin.name     = p.value( "name", "" );
            pin.pos      = VECTOR2D( numOr( p, "x", 0.0 ), numOr( p, "y", 0.0 ) );
            pin.color    = parsePeerColor( p.value( "color", "" ) );
            pin.resolved = p.value( "resolved", false );
            pin.unread   = p.value( "unread", false );
            parsed.push_back( std::move( pin ) );
        }

        pins = std::move( parsed );
        start();
        scheduleRedraw();
    }

    /** kicadCollabSetStyle (presence tuner): live-patch the overlay STYLE
     *  (partial JSON — see collab_presence_style.h) and repaint. */
    void setStyle( const std::string& aJson )
    {
        json j = json::parse( aJson, nullptr, /*allow_exceptions*/ false );

        if( j.is_discarded() )
            return;

        patchStyle( style, j );
        scheduleRedraw();
    }

    /** kicadCollabReleaseSelection (0007): the local client LOST the selection
     *  tiebreak — release the contested items (only those) from the live
     *  selection. If an interactive tool (move/drag) holds them, cancel it
     *  first (ESC semantics — the preview reverts); a bare cancel is NOT sent
     *  when idle, since ESC on the base selection tool would clear the whole
     *  selection. Ends with a forced selection re-emit (programmatic changes
     *  close no canvas event). */
    void releaseSelection( const std::string& aUuidsJson, const std::string& aHolder )
    {
        json j = json::parse( aUuidsJson, nullptr, /*allow_exceptions*/ false );

        if( j.is_discarded() || !j.is_array() )
            return;

        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        std::vector<KIID> ids;

        for( const json& u : j )
        {
            if( u.is_string() )
                ids.emplace_back( wxString::FromUTF8( u.get<std::string>().c_str() ) );
        }

        if( ids.empty() )
            return;

        wxString holder = wxString::FromUTF8( aHolder.c_str() );

        fr->CallAfter( [this, fr, ids, holder]() {
            if( !fr->ToolStackIsEmpty() )
                fr->GetToolManager()->RunAction( ACTIONS::cancelInteractive );

            SELECTION_TOOL* st = selectionTool( fr );

            if( !st )
                return;

            bool released = false;

            for( const KIID& id : ids )
            {
                EDA_ITEM* item = resolveItem( fr, id );

                if( item && item->IsSelected() )
                {
                    st->RemoveItemFromSel( item );
                    released = true;
                }
            }

            if( released )
            {
                fr->ShowInfoBarWarning( wxString::Format( _( "%s is editing this — released from "
                                                             "your selection." ),
                                                          holder ),
                                        true );
            }

            scheduleSelCheck();
        } );
    }

    /** Test helper: REALLY select an item through the selection tool, then run
     *  the presence check (programmatic selects close no canvas event). */
    void selectItem( EDA_ITEM* aItem )
    {
        EDA_DRAW_FRAME* fr = frame();

        if( !fr )
            return;

        fr->CallAfter( [this, fr, aItem]() {
            if( SELECTION_TOOL* st = selectionTool( fr ) )
            {
                st->AddItemToSel( aItem );
                scheduleSelCheck();
            }
        } );
    }

    /** kicadPluginSelectItems: REPLACE the local selection with the listed items
     *  on behalf of a plugin. Unlike a click this is bulk and blind, and a
     *  selection is a soft-lock claim whose tiebreak ignores who held the item
     *  first (lock-tiebreak.ts) — so an item another client holds is never
     *  taken: it is reported back as `held` (uuid only — who holds it is other
     *  users' presence, which no plugin permission covers). Refused
     *  while a tool is running (would change the selection under a move).
     *
     *  The answer is computed now; the selection itself changes on the next
     *  event-loop turn (never from inside an embind call), re-resolving every
     *  id there so an item deleted in between is skipped, not dereferenced.
     *  Input is a JSON array of uuid strings and nothing else reaches the tools. */
    static constexpr size_t PLUGIN_SELECT_MAX = 500;

    std::string pluginSelect( const std::string& aUuidsJson )
    {
        auto refuse = []( const char* aCode ) {
            return json( { { "ok", false }, { "error", aCode } } ).dump();
        };

        json j = json::parse( aUuidsJson, nullptr, /*allow_exceptions*/ false );

        if( j.is_discarded() || !j.is_array() || j.size() > PLUGIN_SELECT_MAX )
            return refuse( "INVALID" );

        // An open in flight has a half-built model (open_gate.h); the TS adapter checks too.
        if( pcbjam_open::busy() )
            return refuse( "NO_EDITOR" );

        EDA_DRAW_FRAME* fr = frame();

        if( !fr || !selectionTool( fr ) )
            return refuse( "NO_EDITOR" );

        if( !fr->ToolStackIsEmpty() )
            return refuse( "TOOL_ACTIVE" );

        std::vector<KIID> ids;
        std::set<KIID>    seen;
        json              selected = json::array(), held = json::array(), missing = json::array();

        for( const json& u : j )
        {
            if( !u.is_string() || u.get_ref<const std::string&>().size() > 64 )
                return refuse( "INVALID" );

            const std::string& text = u.get_ref<const std::string&>();
            KIID               id( wxString::FromUTF8( text.c_str() ) );

            if( !seen.insert( id ).second )
                continue;

            if( !resolveItem( fr, id ) )
                missing.push_back( text );
            else if( locks.count( id ) )
                held.push_back( text );
            else
            {
                ids.push_back( id );
                selected.push_back( text );
            }
        }

        fr->CallAfter( [this, fr, ids]() {
            SELECTION_TOOL* st = selectionTool( fr );

            if( !st || !fr->ToolStackIsEmpty() )
                return;

            EDA_ITEMS add;

            for( const KIID& id : ids )
            {
                EDA_ITEM* item = resolveItem( fr, id );

                // A lock may have arrived since the answer was computed.
                if( item && !locks.count( id ) )
                    add.push_back( item );
            }

            EDA_ITEMS current;

            for( EDA_ITEM* item : st->GetSelection() )
                current.push_back( item );

            // One selection event for the whole change, not one per half.
            if( !current.empty() )
                st->RemoveItemsFromSel( &current, /*aQuietMode*/ !add.empty() );

            if( !add.empty() )
                st->AddItemsToSel( &add );

            scheduleSelCheck();
        } );

        return json( { { "ok", true }, { "selected", selected }, { "held", held }, { "missing", missing } } )
                .dump();
    }

    /** Test probe (0007): the current remote soft-lock set as `[{uuid, name}]`. */
    std::string locksJson()
    {
        json arr = json::array();

        for( const auto& [id, name] : locks )
            arr.push_back( { { "uuid", pcbjam_collab::toUtf8( id.AsString() ) }, { "name", name } } );

        return arr.dump();
    }
};

} // namespace pcbjam_presence

#endif // __EMSCRIPTEN__
