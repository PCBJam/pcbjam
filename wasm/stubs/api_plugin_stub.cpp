/*
 * API Plugin stubs for KiCad WASM build
 * API plugins and server are not available in WASM (no sockets/IPC)
 *
 * The plugin manager has one job here: the toolbar buttons of the host page
 * (host_toolbar_buttons.h). Each is an "action" as KiCad knows it, so KiCad's own toolbar
 * code shows it, and a click is handed to the page.
 */

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <emscripten.h>
#include <nlohmann/json.hpp>
#include <wx/app.h>
#include <wx/filename.h>
#include <wx/frame.h>
#include <wx/toplevel.h>

#include <api/api_plugin.h>
#include <api/api_plugin_manager.h>
#include <api/api_server.h>
#include <json_schema_validator.h>
#include <pgm_base.h>
#include <settings/common_settings.h>

#include "host_toolbar_buttons.h"

// Forward declare and provide minimal definition for KINNG_REQUEST_SERVER
// This is needed because unique_ptr requires a complete type for deletion
class KINNG_REQUEST_SERVER {};

// Event definitions
wxDEFINE_EVENT( API_REQUEST_EVENT, wxCommandEvent );
wxDEFINE_EVENT( EDA_EVT_PLUGIN_MANAGER_JOB_FINISHED, wxCommandEvent );
wxDEFINE_EVENT( EDA_EVT_PLUGIN_AVAILABILITY_CHANGED, wxCommandEvent );

// Static member initialization
wxString KICAD_API_SERVER::s_logFileName;

// ── the host page's toolbar buttons ─────────────────────────────────────────────────────
namespace
{

// An action belongs to a plugin. Ours belong to this one: a plugin with no file behind it.
// KiCad's own class makes it and reports it as "not OK"; nothing is ever started for it.
const API_PLUGIN& hostPlugin()
{
    static JSON_SCHEMA_VALIDATOR validator( nlohmann::json::object() );
    static API_PLUGIN            plugin( wxFileName(), validator );
    return plugin;
}

// The buttons, in the order they were first set. An action cannot be assigned to (it holds
// a reference), so a change replaces the object.
std::vector<std::unique_ptr<PLUGIN_ACTION>> s_hostActions;

// "enable the KiCad API" as it was before the first button of the page
std::optional<bool> s_apiSettingBefore;

auto findHostAction( const wxString& aIdentifier )
{
    return std::find_if( s_hostActions.begin(), s_hostActions.end(),
                         [&]( const std::unique_ptr<PLUGIN_ACTION>& aAction )
                         {
                             return aAction->identifier == aIdentifier;
                         } );
}

// The toolbars ask for plugin buttons only while that setting is on.
void syncApiSetting()
{
    COMMON_SETTINGS* settings = Pgm().GetCommonSettings();

    if( !settings )
        return;

    if( !s_hostActions.empty() )
    {
        if( !s_apiSettingBefore )
            s_apiSettingBefore = settings->m_Api.enable_server;

        settings->m_Api.enable_server = true;
    }
    else if( s_apiSettingBefore )
    {
        settings->m_Api.enable_server = *s_apiSettingBefore;
        s_apiSettingBefore.reset();
    }
}

// What the real plugin manager sends when its plugins changed: the editors rebuild their
// toolbars when it arrives (from the event loop, not from inside this call).
//
// KiCad's handler for it stops after the rebuild. The toolbars then have the size they would
// like to have, not the size the window leaves them: a toolbar longer than the window runs
// out of it and loses its arrow for the tools that do not fit. So a second step, queued
// behind the first, lays the open frames out again, the way KiCad itself does after it
// rebuilt the toolbars for changed settings (Layout and a size event).
void announceChange()
{
    if( !wxTheApp )
        return;

    wxTheApp->QueueEvent( new wxCommandEvent( EDA_EVT_PLUGIN_AVAILABILITY_CHANGED, wxID_ANY ) );

    wxTheApp->CallAfter(
            []()
            {
                for( wxWindow* window : wxTopLevelWindows )
                {
                    wxFrame* frame = dynamic_cast<wxFrame*>( window );

                    if( frame && frame->IsShown() )
                    {
                        frame->Layout();
                        frame->SendSizeEvent();
                    }
                }
            } );
}

} // namespace


void PCBJAM_HOST_TOOLBAR::SetButton( const wxString& aIdentifier, PLUGIN_ACTION_SCOPE aScope,
                                     const wxString& aTooltip, const std::vector<wxImage>& aIcons )
{
    auto action = std::make_unique<PLUGIN_ACTION>( hostPlugin() );
    action->identifier = aIdentifier;
    action->name = aTooltip;
    action->show_button = true;
    action->scopes = { aScope };
    // KiCad takes the dark set only when there is one: these are the icons for the theme
    // that is on now, whichever it is.
    action->icon_light = aIcons;

    auto it = findHostAction( aIdentifier );

    if( it != s_hostActions.end() )
        *it = std::move( action );
    else
        s_hostActions.push_back( std::move( action ) );

    syncApiSetting();
    announceChange();
}


void PCBJAM_HOST_TOOLBAR::RemoveButton( const wxString& aIdentifier )
{
    auto it = findHostAction( aIdentifier );

    if( it == s_hostActions.end() )
        return;

    s_hostActions.erase( it );
    syncApiSetting();
    announceChange();
}

// KICAD_API_SERVER stub implementation
KICAD_API_SERVER::KICAD_API_SERVER() :
    m_readyToReply( false )
{
    // m_server intentionally left as nullptr - API server not available in WASM
}

KICAD_API_SERVER::~KICAD_API_SERVER()
{
    // m_server is nullptr, nothing to clean up
}

void KICAD_API_SERVER::Start()
{
    // No-op: API server not available in WASM
}

void KICAD_API_SERVER::Stop()
{
    // No-op
}

bool KICAD_API_SERVER::Running() const
{
    return false;
}

void KICAD_API_SERVER::RegisterHandler( API_HANDLER* aHandler )
{
    (void)aHandler;
}

void KICAD_API_SERVER::DeregisterHandler( API_HANDLER* aHandler )
{
    (void)aHandler;
}

std::string KICAD_API_SERVER::SocketPath() const
{
    return "";
}

void KICAD_API_SERVER::onApiRequest( std::string* aRequest )
{
    (void)aRequest;
}

void KICAD_API_SERVER::handleApiEvent( wxCommandEvent& aEvent )
{
    (void)aEvent;
}

void KICAD_API_SERVER::log( const std::string& aOutput )
{
    (void)aOutput;
}

// API_PLUGIN_MANAGER stub implementation
API_PLUGIN_MANAGER::API_PLUGIN_MANAGER( wxEvtHandler* aParent ) :
    m_parent( aParent ),
    m_lastPid( 0 ),
    m_raiseTimer( nullptr )
{
}

void API_PLUGIN_MANAGER::ReloadPlugins( std::optional<wxString> aDirectoryToScan,
                                        std::shared_ptr<REPORTER> aReporter )
{
    (void) aDirectoryToScan;
    (void) aReporter;
    // No-op: plugins not available in WASM
}

bool API_PLUGIN_MANAGER::RecreatePluginEnvironment( const wxString& aIdentifier )
{
    (void)aIdentifier;
    return false;
}

void API_PLUGIN_MANAGER::HandlePythonInterpreterChanged()
{
    // No-op: plugins not available in WASM (panel_plugin_settings calls this)
}

// A click on a button of the page. The page is told after KiCad's click handler has
// returned: what the page does next may rebuild the very toolbar the click came from. A
// listener that throws must never unwind a wasm frame.
void API_PLUGIN_MANAGER::InvokeAction( const wxString& aIdentifier,
                                       std::shared_ptr<REPORTER> aReporter )
{
    (void) aReporter;

    if( findHostAction( aIdentifier ) == s_hostActions.end() )
        return;

    const std::string id = aIdentifier.utf8_string();

    EM_ASM( {
        var id = UTF8ToString( $0 );
        setTimeout( function() {
            try
            {
                if( Module.onHostToolbarButton )
                    Module.onHostToolbarButton( id );
            }
            catch( e )
            {
                console.error( '[pcbjam toolbar] onHostToolbarButton listener threw', e );
            }
        }, 0 );
    }, id.c_str() );
}

std::optional<const PLUGIN_ACTION*> API_PLUGIN_MANAGER::GetAction( const wxString& aIdentifier )
{
    auto it = findHostAction( aIdentifier );

    if( it == s_hostActions.end() )
        return std::nullopt;

    return it->get();
}

std::vector<const PLUGIN_ACTION*> API_PLUGIN_MANAGER::GetActionsForScope( PLUGIN_ACTION_SCOPE aScope )
{
    std::vector<const PLUGIN_ACTION*> actions;

    for( const std::unique_ptr<PLUGIN_ACTION>& action : s_hostActions )
    {
        if( action->scopes.contains( aScope ) )
            actions.push_back( action.get() );
    }

    return actions;
}

void API_PLUGIN_MANAGER::processPluginDependencies()
{
}

void API_PLUGIN_MANAGER::processNextJob( wxCommandEvent& aEvent )
{
    (void)aEvent;
}
