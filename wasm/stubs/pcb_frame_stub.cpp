/*
 * PCB Frame stubs for KiCad WASM build
 * Python action plugins are not available in WASM
 *
 * These stubs provide implementations for methods that are declared in headers
 * but whose implementations depend on scripting features not available in WASM.
 */

#include <pcb_edit_frame.h>
#include <pcb_base_frame.h>
#include <footprint.h>
#include <action_plugin.h>
#include <board.h>

class ACTION_MENU;

// PCB_EDIT_FRAME static method implementations
// These are called from panel_pcbnew_action_plugins.cpp

std::vector<LEGACY_OR_API_PLUGIN> PCB_EDIT_FRAME::GetOrderedActionPlugins()
{
    // Return empty list: no plugins available in WASM
    return {};
}

bool PCB_EDIT_FRAME::GetActionPluginButtonVisible( const wxString& aPluginPath, bool aPluginDefault )
{
    (void)aPluginPath;
    // Return the default value since we can't check settings for non-existent plugins
    return aPluginDefault;
}

void PCB_EDIT_FRAME::buildActionPluginMenus( ACTION_MENU* aActionMenu )
{
    (void)aActionMenu;
    // No-op: action plugins not available in WASM
}

// PCB_BASE_FRAME protected method implementation
// The declaration is NOT guarded by wxUSE_FSWATCHER but the implementation IS,
// so we need a stub when filesystem watcher is not available.
#if !wxUSE_FSWATCHER
void PCB_BASE_FRAME::setFPWatcher( FOOTPRINT* aFootprint )
{
    (void)aFootprint;
    // No-op: filesystem watcher not available in WASM
}
#endif

// Scripting helper functions stub
// These are in pcbnew_scripting_helpers.cpp which is only compiled with KICAD_SCRIPTING
BOARD* LoadBoard( const wxString& aFileName, bool aSetActive, wxString* aReason )
{
    (void)aFileName;
    (void)aSetActive;
    (void)aReason;
    // Scripting not available in WASM
    return nullptr;
}

bool SaveBoard( wxString& aFileName, BOARD* aBoard, bool aSkipSettings )
{
    (void)aFileName;
    (void)aBoard;
    (void)aSkipSettings;
    // Scripting not available in WASM
    return false;
}

BOARD* CreateEmptyBoard()
{
    // Scripting not available in WASM
    return nullptr;
}
