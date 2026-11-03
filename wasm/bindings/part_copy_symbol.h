/*
 * libs 0031, symbol editor side: a symbol of a library the user can't write
 * (a KiCad library, an override, another team's public library) is copied
 * into the team's default library instead of being saved in place.
 *
 *  - pcbjam_symbol_readonly_notice: KiCad's read-only infobar
 *    (symbol_edit_frame.cpp) asks us first; the page's bridge words the notice
 *    and decides whether there is a copy button (members only).
 *  - pcbjam_symbol_save_gate: Save / Save All (symbol_editor_control.cpp) ask
 *    us before writing. When what they write includes parts of a read-only
 *    library, the page's modal lists every part and where it goes; on Save
 *    the page writes the copies, and here the originals are reverted and the
 *    copy on screen opens.
 *  - kicadSymbolEditorOpenCopy: the page opens a finished copy (banner flow).
 *
 * Included by eeschema_embind.cpp only; part_copy_common.h explains why the
 * EM_JS calls are per side. The JS half is web/standalone/src/libs/part-copy.ts.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <string>
#include <utility>
#include <vector>

#include <emscripten.h>
#include <nlohmann/json.hpp>
#include <wx/app.h>
#include <wx/hyperlink.h>

#include <frame_type.h>
#include <kiway.h>
#include <kiway_player.h>
#include <lib_id.h>
#include <lib_symbol.h>
#include <richio.h>
#include <sch_file_versions.h>
#include <sch_io/kicad_sexpr/sch_io_kicad_sexpr_lib_cache.h>
#include <sch_screen.h>
#include <symbol_edit_frame.h>
#include <lib_symbol_library_manager.h>
#include <widgets/wx_infobar.h>

#include "collab_common.h"
#include "part_copy_common.h"

// bridge[method]( ...args ) synchronously; its answer as malloc'd JSON (0 = none).
EM_JS( int, pcbjam_sym_copy_call, ( const char* aMethod, const char* aArgs ), {
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
        const ptr = _pcbjam_libs_alloc( len );

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
EM_JS( void, pcbjam_sym_copy_start, ( int aToken, const char* aMethod, const char* aArgs ), {
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
        const ptr = _pcbjam_libs_alloc( len );

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

inline SYMBOL_EDIT_FRAME* symbolEditor()
{
    KIWAY_PLAYER* top =
            wxTheApp ? dynamic_cast<KIWAY_PLAYER*>( wxTheApp->GetTopWindow() ) : nullptr;

    return top ? dynamic_cast<SYMBOL_EDIT_FRAME*>( top->Kiway().Player( FRAME_SCH_SYMBOL_EDITOR, false ) )
               : nullptr;
}

/**
 * The library of a symbol in the editor. GetCurLib() can come back empty here (it
 * drops a nickname the library adapter doesn't list); KiCad's own read-only check
 * reads the symbol's LIB_ID too.
 */
inline wxString libOf( const LIB_SYMBOL* aSymbol )
{
    return aSymbol ? aSymbol->GetLibId().GetUniStringLibNickname() : wxString();
}

/** One standalone symbol in a kicad_symbol_lib, as the PCBJAM plugin saves it. */
inline std::string flattenedSymbolBody( const LIB_SYMBOL& aSymbol )
{
    std::unique_ptr<LIB_SYMBOL> flat = aSymbol.Flatten();
    STRING_FORMATTER            formatter;

    formatter.Print( "(kicad_symbol_lib (version %d) (generator \"pcbjam\") "
                     "(generator_version \"1.0\")\n",
                     SEXPR_SYMBOL_LIB_FILE_VERSION );
    SCH_IO_KICAD_SEXPR_LIB_CACHE::SaveSymbol( flat.get(), formatter );
    formatter.Print( ")\n" );
    return formatter.GetString();
}

/**
 * Open a copy in the symbol editor once its library has reloaded (the queue
 * runs after the page's invalidate), but only while the original is still on
 * screen: the user may have moved on meanwhile.
 */
inline bool openSymbolCopy( const wxString& aOrigLib, const wxString& aOrigName,
                            const wxString& aLib, const wxString& aName )
{
    SYMBOL_EDIT_FRAME* editor = symbolEditor();

    if( !editor )
        return false;

    pcbjam_collab::runOnCoroutine( editor,
            [aOrigLib, aOrigName, aLib, aName]()
            {
                SYMBOL_EDIT_FRAME* frame = symbolEditor();
                LIB_SYMBOL*        cur = frame ? frame->GetCurSymbol() : nullptr;

                if( !cur || frame->IsSymbolFromSchematic() || libOf( cur ) != aOrigLib
                        || cur->GetName() != aOrigName )
                {
                    return;
                }

                frame->LoadSymbol( LIB_ID( aLib, aName ), frame->GetUnit(), frame->GetBodyStyle() );
            } );

    return true;
}

} // namespace pcbjam_part_copy


extern "C" bool pcbjam_symbol_readonly_notice( SYMBOL_EDIT_FRAME* aFrame, WX_INFOBAR* aInfobar,
                                               wxArrayString* aMsgs )
{
    using namespace pcbjam_part_copy;

    LIB_SYMBOL* symbol = aFrame ? aFrame->GetCurSymbol() : nullptr;

    if( !symbol || !aInfobar || !aMsgs )
        return false;

    const wxString lib = libOf( symbol );
    const wxString name = symbol->GetName();
    const std::string args = nlohmann::json::array( { "symbol", utf8( lib ), utf8( name ) } ).dump();

    std::optional<nlohmann::json> out = takeJson( pcbjam_sym_copy_call( "notice", args.c_str() ) );

    if( !out || !out->is_object() || str( *out, "message" ).empty() )
        return false;

    aMsgs->push_back( str( *out, "message" ) );

    if( wxString label = str( *out, "button" ); !label.empty() )
    {
        wxHyperlinkCtrl* button = new wxHyperlinkCtrl( aInfobar, wxID_ANY, label, wxEmptyString );

        button->Bind( wxEVT_COMMAND_HYPERLINK, std::function<void( wxHyperlinkEvent& )>(
                [args]( wxHyperlinkEvent& )
                {
                    // The page runs the copy and opens it (kicadSymbolEditorOpenCopy).
                    takeJson( pcbjam_sym_copy_call( "copy", args.c_str() ) );
                } ) );

        aInfobar->AddButton( button );
    }

    return true;
}


extern "C" bool pcbjam_symbol_save_gate( SYMBOL_EDIT_FRAME* aFrame, bool aSaveAll )
{
    using namespace pcbjam_part_copy;

    if( !aFrame || !wxWasmBeginWait || aFrame->IsSymbolFromSchematic() )
        return true;

    LIB_SYMBOL_LIBRARY_MANAGER&                 mgr = aFrame->GetLibManager();
    std::vector<std::pair<wxString, wxString>> parts;   // (library, symbol) with unsaved edits

    const auto addLibrary =
            [&]( const wxString& aLib )
            {
                wxArrayString names;
                mgr.GetSymbolNames( aLib, names );

                for( const wxString& name : names )
                {
                    if( mgr.IsSymbolModified( name, aLib ) )
                        parts.emplace_back( aLib, name );
                }
            };

    // What this save writes, as SYMBOL_EDIT_FRAME::Save / SaveAll pick it.
    wxString saveLib;

    if( aSaveAll )
    {
        for( const wxString& lib : mgr.GetLibraryNames() )
        {
            if( mgr.IsLibraryModified( lib ) )
                addLibrary( lib );
        }
    }
    else
    {
        if( aFrame->IsLibraryTreeShown() )
            saveLib = aFrame->GetTreeLIBID().GetUniStringLibNickname();

        if( !saveLib.empty() )
        {
            addLibrary( saveLib );
        }
        else if( LIB_SYMBOL* cur = aFrame->GetCurSymbol() )
        {
            saveLib = libOf( cur );

            if( mgr.IsSymbolModified( cur->GetName(), saveLib ) )
                parts.emplace_back( saveLib, cur->GetName() );
        }
    }

    nlohmann::json rows = nlohmann::json::array();
    bool           anyReadOnly = false;

    for( const auto& [lib, name] : parts )
    {
        nlohmann::json row = { { "lib", utf8( lib ) }, { "name", utf8( name ) } };
        const bool     readOnly = mgr.IsLibraryReadOnly( lib );

        row["readOnly"] = readOnly;

        if( readOnly )
        {
            LIB_SYMBOL* symbol = mgr.GetBufferedSymbol( name, lib );

            if( !symbol )
                continue;

            row["body"] = flattenedSymbolBody( *symbol );
            anyReadOnly = true;
        }

        rows.push_back( std::move( row ) );
    }

    if( !anyReadOnly )
    {
        // Nothing edited in a read-only library: don't let Save offer KiCad's Save As.
        return !( !aSaveAll && rows.empty() && !saveLib.empty() && mgr.IsLibraryReadOnly( saveLib ) );
    }

    const nlohmann::json request = { { "kind", "symbol" }, { "saveAll", aSaveAll }, { "rows", rows } };
    const std::string    args = nlohmann::json::array( { request } ).dump();

    std::optional<nlohmann::json> out = awaitJson(
            [&]( int aToken )
            {
                pcbjam_sym_copy_start( aToken, "save", args.c_str() );
            } );

    if( !out || !out->is_object() )
        return true;    // no page bridge: KiCad's own read-only handling

    if( str( *out, "action" ) != wxS( "save" ) )
        return false;   // cancelled: nothing written, the edits stay

    // The copies are written. The originals go back to their saved state, and
    // the copy of the part on screen opens in its place.
    LIB_SYMBOL*    cur = aFrame->GetCurSymbol();
    const wxString curLib = libOf( cur );
    const wxString curName = cur ? cur->GetName() : wxString();
    const int      unit = aFrame->GetUnit();
    const int      bodyStyle = aFrame->GetBodyStyle();

    for( const nlohmann::json& copied : out->value( "copied", nlohmann::json::array() ) )
    {
        const wxString lib = str( copied, "lib" );
        const wxString name = str( copied, "name" );

        if( !mgr.SymbolExists( name, lib ) )
            continue;

        const bool onScreen = cur && lib == curLib && name == curName;

        if( onScreen )
            aFrame->emptyScreen();

        mgr.RevertSymbol( name, lib );
        mgr.ClearSymbolModified( name, lib );

        if( onScreen )
        {
            aFrame->LoadSymbol( LIB_ID( lib, name ), unit, bodyStyle );

            // `open: false` = the copy's library isn't in this session (a one-library editor).
            if( copied.value( "open", true ) )
                openSymbolCopy( lib, name, str( copied, "targetLib" ), str( copied, "targetName" ) );

            cur = nullptr;
        }
    }

    aFrame->RefreshLibraryTree();
    aFrame->UpdateTitle();

    // Save All goes on with the writable libraries; a Save of a read-only library is done.
    return aSaveAll;
}


static bool symbolEditorOpenCopy( std::string aOrigLib, std::string aOrigName, std::string aLib,
                                  std::string aName )
{
    return pcbjam_part_copy::openSymbolCopy(
            wxString::FromUTF8( aOrigLib ), wxString::FromUTF8( aOrigName ),
            wxString::FromUTF8( aLib ), wxString::FromUTF8( aName ) );
}

#endif // __EMSCRIPTEN__
