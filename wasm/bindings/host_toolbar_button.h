/*
 * A button of the page on an editor's top toolbar, set from JavaScript.
 *
 * The button itself is KiCad's: see wasm/stubs/host_toolbar_buttons.h for the way it gets
 * there. This file is the part an editor's bindings include: it turns the page's call into
 * that one, with one of KiCad's own icons, so the button looks like its neighbours in the
 * light and in the dark theme.
 *
 *   Module.kicad<Editor>ToolbarButton( id, tooltip, icon ) -> boolean
 *     icon: one of the names in iconByName() below; "" takes the button away.
 *     false: an icon name this build does not know (nothing changes).
 *   Module.onHostToolbarButton = ( id ) => { ... }   a click, told to the page
 */

#pragma once

#include <map>
#include <string>
#include <vector>

#include <wx/image.h>
#include <wx/string.h>

#include <api/plugin_action_scope.h>
#include <bitmaps.h>

#include "../stubs/host_toolbar_buttons.h"

namespace pcbjam_toolbar
{

// The icons the page can ask for, by KiCad's own names for them.
inline bool iconByName( const std::string& aName, BITMAPS& aIcon )
{
    static const std::map<std::string, BITMAPS> icons = {
        { "sim_run", BITMAPS::sim_run },
        { "sim_stop", BITMAPS::sim_stop },
    };

    auto it = icons.find( aName );

    if( it == icons.end() )
        return false;

    aIcon = it->second;
    return true;
}


inline bool setButton( PLUGIN_ACTION_SCOPE aScope, const std::string& aId, const std::string& aTooltip,
                       const std::string& aIcon )
{
    const wxString id = wxString::FromUTF8( aId );

    if( aIcon.empty() )
    {
        PCBJAM_HOST_TOOLBAR::RemoveButton( id );
        return true;
    }

    BITMAPS icon;

    if( !iconByName( aIcon, icon ) )
        return false;

    // every size KiCad's icons come in, for the theme that is on now
    std::vector<wxImage> images;

    for( int height : { 16, 24, 32, 48, 64 } )
    {
        wxImage image = KiBitmap( icon, height ).ConvertToImage();

        if( image.IsOk() )
            images.push_back( image );
    }

    PCBJAM_HOST_TOOLBAR::SetButton( id, aScope, wxString::FromUTF8( aTooltip ), images );
    return true;
}

} // namespace pcbjam_toolbar
