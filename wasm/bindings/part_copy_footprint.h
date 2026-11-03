/*
 * libs 0031, footprint editor side (see part_copy_symbol.h for the flow):
 *
 *  - pcbjam_footprint_readonly_notice: KiCad's read-only infobar
 *    (footprint_edit_frame.cpp) asks us first.
 *  - pcbjam_footprint_save_gate: every footprint save (footprint_libraries_utils.cpp,
 *    SaveFootprint) asks us first. A footprint of a read-only library goes
 *    through the page's modal (one row: footprints are saved one at a time)
 *    and is written into the team's default library; the copy then opens in
 *    its place.
 *  - kicadFootprintEditorOpenCopy: the page opens a finished copy (banner flow).
 *
 * Included by pcbnew_embind.cpp only; part_copy_common.h explains why the
 * EM_JS calls are per side.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <string>

#include <emscripten.h>
#include <nlohmann/json.hpp>
#include <wx/app.h>
#include <wx/hyperlink.h>

#include <board.h>
#include <footprint.h>
#include <footprint_edit_frame.h>
#include <frame_type.h>
#include <kiway.h>
#include <kiway_player.h>
#include <lib_id.h>
#include <footprint_library_adapter.h>
#include <pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h>
#include <project_pcb.h>
#include <widgets/wx_infobar.h>

#include "collab_common.h"
#include "part_copy_common.h"

// bridge[method]( ...args ) synchronously; its answer as malloc'd JSON (0 = none).
EM_JS( int, pcbjam_fp_copy_call, ( const char* aMethod, const char* aArgs ), {
    const bridge = globalThis.pcbjamPartCopy;
    const method = UTF8ToString( aMethod );

    if( !bridge || typeof bridge[method] !== 'function' )
        return 0;

    try
    {
        const out = bridge[method]( ...JSON.parse( UTF8ToString( aArgs ) ) );

        if( out == null || typeof out.then === 'function' )
            return 0;

        const text = JSON.stringify( out );
        const len = lengthBytesUTF8( text ) + 1;
        const ptr = _pcbjam_fp_libs_alloc( len );

        if( !ptr )
            return 0;

        stringToUTF8( text, ptr, len );
        return ptr;
    }
    catch( e )
    {
        console.error( 'pcbjamPartCopy.' + method + ' failed:', e );
        return 0;
    }
} );

// bridge[method]( ...args ) asynchronously; its answer resolves wait aToken, never
// synchronously (see pcbjam_libs_request_start for why).
EM_JS( void, pcbjam_fp_copy_start, ( int aToken, const char* aMethod, const char* aArgs ), {
    const finish = ( ptr ) => globalThis.__wxScheduler.resolveWait( aToken, ptr );
    const bridge = globalThis.pcbjamPartCopy;
    const method = UTF8ToString( aMethod );

    if( !bridge || typeof bridge[method] !== 'function' )
    {
        Promise.resolve().then( () => finish( 0 ) );
        return;
    }

    let req;

    try
    {
        req = Promise.resolve( bridge[method]( ...JSON.parse( UTF8ToString( aArgs ) ) ) );
    }
    catch( e )
    {
        console.error( 'pcbjamPartCopy.' + method + ' failed:', e );
        Promise.resolve().then( () => finish( 0 ) );
        return;
    }

    req.then( ( out ) => {
        if( out == null )
            return finish( 0 );

        const text = JSON.stringify( out );
        const len = lengthBytesUTF8( text ) + 1;
        const ptr = _pcbjam_fp_libs_alloc( len );

        if( !ptr )
            return finish( 0 );

        stringToUTF8( text, ptr, len );
        finish( ptr );
    } ).catch( ( e ) => {
        console.error( 'pcbjamPartCopy.' + method + ' failed:', e );
        finish( 0 );
    } );
} );

namespace pcbjam_part_copy {

inline FOOTPRINT_EDIT_FRAME* footprintEditor()
{
    KIWAY_PLAYER* top =
            wxTheApp ? dynamic_cast<KIWAY_PLAYER*>( wxTheApp->GetTopWindow() ) : nullptr;

    return top ? dynamic_cast<FOOTPRINT_EDIT_FRAME*>( top->Kiway().Player( FRAME_FOOTPRINT_EDITOR, false ) )
               : nullptr;
}

/** Open a copy once its library has reloaded, while the original is still on screen. */
inline bool openFootprintCopy( const LIB_ID& aOrig, const LIB_ID& aCopy )
{
    FOOTPRINT_EDIT_FRAME* editor = footprintEditor();

    if( !editor )
        return false;

    pcbjam_collab::runOnCoroutine( editor,
            [aOrig, aCopy]()
            {
                FOOTPRINT_EDIT_FRAME* frame = footprintEditor();

                if( !frame || !frame->GetBoard() || !frame->GetBoard()->GetFirstFootprint()
                        || frame->GetLoadedFPID() != aOrig )
                {
                    return;
                }

                frame->LoadFootprintFromLibrary( aCopy );
            } );

    return true;
}

} // namespace pcbjam_part_copy


extern "C" bool pcbjam_footprint_readonly_notice( FOOTPRINT_EDIT_FRAME* aFrame, WX_INFOBAR* aInfobar )
{
    using namespace pcbjam_part_copy;

    FOOTPRINT* fp = aFrame && aFrame->GetBoard() ? aFrame->GetBoard()->GetFirstFootprint() : nullptr;

    if( !fp || !aInfobar )
        return false;

    const LIB_ID&     id = fp->GetFPID();
    const std::string args = nlohmann::json::array( { "footprint", std::string( id.GetLibNickname().c_str() ),
                                                      std::string( id.GetLibItemName().c_str() ) } )
                                     .dump();

    std::optional<nlohmann::json> out = takeJson( pcbjam_fp_copy_call( "notice", args.c_str() ) );

    if( !out || !out->is_object() || str( *out, "message" ).empty() )
        return false;

    aInfobar->RemoveAllButtons();

    if( wxString label = str( *out, "button" ); !label.empty() )
    {
        wxHyperlinkCtrl* button = new wxHyperlinkCtrl( aInfobar, wxID_ANY, label, wxEmptyString );

        button->Bind( wxEVT_COMMAND_HYPERLINK, std::function<void( wxHyperlinkEvent& )>(
                [args]( wxHyperlinkEvent& )
                {
                    // The page runs the copy and opens it (kicadFootprintEditorOpenCopy).
                    takeJson( pcbjam_fp_copy_call( "copy", args.c_str() ) );
                } ) );

        aInfobar->AddButton( button );
    }

    aInfobar->AddCloseButton();
    aInfobar->ShowMessage( str( *out, "message" ), wxICON_INFORMATION );
    return true;
}


extern "C" int pcbjam_footprint_save_gate( FOOTPRINT_EDIT_FRAME* aFrame, FOOTPRINT* aFootprint )
{
    using namespace pcbjam_part_copy;

    if( !aFrame || !aFootprint || !wxWasmBeginWait )
        return -1;

    const LIB_ID   id = aFootprint->GetFPID();
    const wxString lib = id.GetLibNickname();

    if( lib.empty() || PROJECT_PCB::FootprintLibAdapter( &aFrame->Prj() )->IsFootprintLibWritable( lib ) )
        return -1;

    std::string body;

    {
        PCB_IO_KICAD_SEXPR pi( CTL_FOR_LIBRARY );
        pi.Format( static_cast<const BOARD_ITEM*>( aFootprint ) );
        body = pi.GetStringOutput( false );
    }

    const nlohmann::json row = { { "lib", std::string( id.GetLibNickname().c_str() ) },
                                 { "name", std::string( id.GetLibItemName().c_str() ) },
                                 { "readOnly", true },
                                 { "body", body } };
    const nlohmann::json request = { { "kind", "footprint" },
                                     { "saveAll", false },
                                     { "rows", nlohmann::json::array( { row } ) } };
    const std::string    args = nlohmann::json::array( { request } ).dump();

    std::optional<nlohmann::json> out = awaitJson(
            [&]( int aToken )
            {
                pcbjam_fp_copy_start( aToken, "save", args.c_str() );
            } );

    if( !out || !out->is_object() )
        return -1;      // no page bridge: KiCad's own read-only handling

    if( str( *out, "action" ) != wxS( "save" ) )
        return 0;       // cancelled: nothing written, the edits stay

    for( const nlohmann::json& copied : out->value( "copied", nlohmann::json::array() ) )
    {
        // The copy opens in place of the original once its library has reloaded.
        // `open: false` = its library isn't in this session (a one-library editor):
        // the original comes back as saved instead.
        if( copied.value( "open", true ) )
            openFootprintCopy( id, LIB_ID( str( copied, "targetLib" ), str( copied, "targetName" ) ) );
        else
            openFootprintCopy( id, id );

        return 1;
    }

    return 0;           // the copy failed (the page said why)
}


static bool footprintEditorOpenCopy( std::string aOrigLib, std::string aOrigName, std::string aLib,
                                     std::string aName )
{
    return pcbjam_part_copy::openFootprintCopy(
            LIB_ID( wxString::FromUTF8( aOrigLib ), wxString::FromUTF8( aOrigName ) ),
            LIB_ID( wxString::FromUTF8( aLib ), wxString::FromUTF8( aName ) ) );
}

#endif // __EMSCRIPTEN__
