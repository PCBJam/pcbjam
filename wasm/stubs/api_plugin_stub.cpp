/*
 * API Plugin stubs for KiCad WASM build
 * API plugins and server are not available in WASM (no sockets/IPC)
 */

#include <api/api_plugin_manager.h>
#include <api/api_server.h>
#include <wx/window.h>
#include <wx/wasm/private/execution_owner.h>

// Forward declare and provide minimal definition for KINNG_REQUEST_SERVER
// This is needed because unique_ptr requires a complete type for deletion
class KINNG_REQUEST_SERVER {};

// Event definitions
wxDEFINE_EVENT( API_REQUEST_EVENT, wxCommandEvent );
wxDEFINE_EVENT( EDA_EVT_PLUGIN_MANAGER_JOB_FINISHED, wxCommandEvent );
wxDEFINE_EVENT( EDA_EVT_PLUGIN_AVAILABILITY_CHANGED, wxCommandEvent );

// Static member initialization
wxString KICAD_API_SERVER::s_logFileName;

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

void API_PLUGIN_MANAGER::ReloadPlugins( std::optional<wxString> aDirectoryToScan,
                                        std::shared_ptr<REPORTER> aReporter,
                                        wxWindow* aEventOwner )
{
    (void) aDirectoryToScan;
    (void) aReporter;
    // API plugin subprocesses are unavailable, but the initiating panel still
    // needs its normal completion notification.  Deliver it to that exact
    // window, not wxApp: a delegated wxApp command would also run unrelated
    // global listeners (for example PCB_EDIT_FRAME::RecreateToolbars) while
    // the main frame is parked behind this panel's modal lease.
    if( !aEventOwner )
        return;

    const wx_wasm_execution::PendingEventDelegate delegate =
            wxWasmExecutionCapturePendingEventDelegate( aEventOwner );
    wxWasmExecutionQueueDelegatedPendingEvent(
            static_cast<wxEvtHandler*>( aEventOwner ),
            new wxCommandEvent( EDA_EVT_PLUGIN_AVAILABILITY_CHANGED, wxID_ANY ),
            delegate );
}

void API_PLUGIN_MANAGER::RecreatePluginEnvironment( const wxString& aIdentifier )
{
    (void)aIdentifier;
}

void API_PLUGIN_MANAGER::RecreatePluginEnvironment( const wxString& aIdentifier,
                                                    wxWindow* aEventOwner )
{
    (void)aIdentifier;
    (void)aEventOwner;
}

void API_PLUGIN_MANAGER::InvokeAction( const wxString& aIdentifier,
                                       std::shared_ptr<REPORTER> aReporter )
{
    (void)aIdentifier;
    (void) aReporter;
}

std::optional<const PLUGIN_ACTION*> API_PLUGIN_MANAGER::GetAction( const wxString& aIdentifier )
{
    (void)aIdentifier;
    return std::nullopt;
}

std::vector<const PLUGIN_ACTION*> API_PLUGIN_MANAGER::GetActionsForScope( PLUGIN_ACTION_SCOPE aScope )
{
    (void)aScope;
    return {};
}

void API_PLUGIN_MANAGER::processPluginDependencies()
{
}

void API_PLUGIN_MANAGER::processNextJob( wxCommandEvent& aEvent )
{
    (void)aEvent;
}
