/*
 * Toolbar buttons of the host page, for the KiCad WASM build.
 *
 * KiCad has one way to let something outside of it put a button on an editor's top
 * toolbar: an "action" of an API plugin. The toolbar asks the plugin manager for the
 * actions of its kind of editor and adds one button per action, with the action's icon and
 * name; a click goes back to the plugin manager (EDA_DRAW_FRAME::AddApiPluginTools,
 * OnApiPluginInvoke).
 *
 * In this build the plugin manager is ours (api_plugin_stub.cpp: a browser cannot start
 * plugin programs). So the page uses that way for buttons of its own, and KiCad's own code
 * draws them: nothing in KiCad is changed, and the button is rebuilt with the toolbar
 * whenever KiCad rebuilds it.
 *
 * Two things to know:
 *  - KiCad's toolbars ask for plugin buttons only while its setting "enable the KiCad API"
 *    is on. It is switched on while a button of the page is shown and put back after the
 *    last one is gone. In this build the setting starts nothing (there is no API server).
 *  - The buttons sit where KiCad puts plugin buttons: at the end of the top toolbar. A
 *    user who took that place out of a customised toolbar has no such buttons.
 */

#ifndef PCBJAM_HOST_TOOLBAR_BUTTONS_H
#define PCBJAM_HOST_TOOLBAR_BUTTONS_H

#include <vector>

#include <wx/image.h>
#include <wx/string.h>

#include <api/plugin_action_scope.h>

namespace PCBJAM_HOST_TOOLBAR
{

/**
 * Put a button on the top toolbar of the editors of one kind, or change the one that has
 * this identifier (its tooltip, its icon). The open editors rebuild their toolbars a moment
 * later.
 *
 * A click calls Module.onHostToolbarButton( identifier ) in the page, after KiCad's click
 * handler has returned.
 *
 * @param aIcons the icon at one or more sizes; KiCad picks the toolbar's size or scales.
 */
void SetButton( const wxString& aIdentifier, PLUGIN_ACTION_SCOPE aScope, const wxString& aTooltip,
                const std::vector<wxImage>& aIcons );

/// Take the button away. Nothing happens when there is none.
void RemoveButton( const wxString& aIdentifier );

} // namespace PCBJAM_HOST_TOOLBAR

#endif // PCBJAM_HOST_TOOLBAR_BUTTONS_H
