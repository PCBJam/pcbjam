/*
 * JS → editor library reload (r2-idb-sync realtime): drop a PCBJAM lib's
 * in-plugin cache and re-sync the open editor's library tree after a remote
 * (peer) edit landed in the page's SyncStack/IDB.
 *
 * The lib plugins (SCH_IO_PCBJAM_LIB / PCB_IO_PCBJAM_FP) cache parsed items for
 * the plugin instance's lifetime and pin GetModifyHash()/GetLibraryTimestamp()
 * to a constant, so nothing upstream ever re-reads the provider. The one full
 * invalidation is LIBRARY_MANAGER::ReloadLibraryEntry — it erases the LIB_DATA
 * entry INCLUDING the plugin instance (and with it the fat-load cache), the
 * exact pattern the remote-symbol import flows already use
 * (eeschema/widgets/panel_remote_symbol.cpp). LoadLibraryEntry then refetches
 * synchronously (the fat "bodies" crossing — served from the now-fresh IDB, no
 * network), and MAIL_RELOAD_LIB makes an open editor frame rebuild its tree.
 *
 * Header-only (the collab_common.h pattern); common-code includes only, so the
 * merged kicad_editor TU (deliberately eeschema/pcbnew-header-free) can use it.
 * Runs on the apply coroutine: LoadLibraryEntry suspends in the JS bridge, so
 * the reload must serialize with the collab applies and local edits.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <string>
#include <wx/app.h>
#include <wx/string.h>
#include <kiway.h>
#include <kiway_player.h>
#include <libraries/library_manager.h>
#include <mail_type.h>
#include <pgm_base.h>

#include "collab_common.h"

namespace pcbjam_libs {

/**
 * Reload one library from its provider and refresh any open editor tree.
 * @param aKind "symbol" | "footprint" — which lib table the nickname lives in.
 * @param aNickname the lib-table row name (LibInfo.name on the JS side).
 */
inline void reloadLibrary( std::string aKind, std::string aNickname )
{
    KIWAY_PLAYER* top =
            wxTheApp ? dynamic_cast<KIWAY_PLAYER*>( wxTheApp->GetTopWindow() ) : nullptr;

    if( !top )
        return;

    const bool     fp = aKind == "footprint";
    const wxString nick = wxString::FromUTF8( aNickname.c_str() );

    pcbjam_collab::runOnCoroutine( top, [top, fp, nick]()
    {
        LIBRARY_MANAGER&         mgr = Pgm().GetLibraryManager();
        const LIBRARY_TABLE_TYPE type =
                fp ? LIBRARY_TABLE_TYPE::FOOTPRINT : LIBRARY_TABLE_TYPE::SYMBOL;

        // Drop the LIB_DATA entry (plugin instance + its fat-load cache)…
        mgr.ReloadLibraryEntry( type, nick );
        // …and bring the lib back to LOADED synchronously, so the tree sync
        // below reads fresh items instead of re-listing a LOADING stub.
        mgr.LoadLibraryEntry( type, nick );

        // An open editor frame re-syncs its tree from the (now fresh) adapter.
        // The payload names the lib to FORCE-refresh: the symbol tree gates
        // re-enumeration on a modify hash that is a pinned constant for PCBJAM
        // plugins (and its mtime component never moves for a remote edit), so a
        // plain sync would skip the lib; the named node is rebuilt instead.
        // ExpressMail only delivers to frames that exist — no frame is created.
        std::string payload( nick.utf8_str() );
        top->Kiway().ExpressMail( fp ? FRAME_FOOTPRINT_EDITOR : FRAME_SCH_SYMBOL_EDITOR,
                                  MAIL_RELOAD_LIB, payload );
    } );
}

} // namespace pcbjam_libs

#endif // __EMSCRIPTEN__
