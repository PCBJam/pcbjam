/*
 * Embind dispatcher for the merged kicad_editor WASM image (editor-unification Part 2).
 *
 * The pcbnew and eeschema binding TUs each implement the collab bridge for their own
 * frame and, standalone, register the SAME JS-facing names. In the merged image both
 * TUs are compiled with -DKICAD_MERGED_EMBIND, which
 *   - compiles out their duplicate frame-agnostic definitions (kicadOpenFile,
 *     extern "C" kicadCollabOnSave) — the single definitions live HERE, and
 *   - compiles out their shared-name EMSCRIPTEN_BINDINGS registrations — registered
 *     once HERE, dispatching to the renamed per-editor entries (pcbCollab… and
 *     schCollab…) on whichever editor frame is live. Per-editor unique names
 *     (kicadSaveBoard, kicadSaveSchematic, kicadCollabTestItemBlob, Board_…) keep
 *     flowing from the per-editor blocks unchanged.
 *
 * With the one-frame-per-page-load model exactly one of pcbEditorActive() /
 * schEditorActive() is true — the same dynamic_cast probe every per-editor entry
 * already starts with. JS-facing names and signatures are IDENTICAL to the standalone
 * bundles, so the web app and tests need no per-bundle API differences.
 *
 * Deliberately header-light: no pcbnew/eeschema headers (avoids mixing both include
 * roots in one TU); only the generic KIWAY_PLAYER surface + the extern declarations.
 */

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/bind.h>
#include <algorithm>
#include <string>
#include <vector>
#include <wx/app.h>
#include <wx/string.h>
#include <wx/window.h>
#include <wx/frame.h>
#include <wx/menu.h>
#include <wx/statusbr.h>
#include <wx/aui/framemanager.h>
#include <kiway.h>
#include <kiway_player.h>
#include <pcbjam_read_only.h>
#include <project.h>

#include "pcbjam_libs_reload.h"
#include "open_gate.h"
#include "timer_park.h"
#include "fiber_park.h"

using namespace emscripten;

// Per-editor entry points and frame probes — defined (with external linkage) in
// pcbnew_embind.cpp / eeschema_embind.cpp.
bool        pcbEditorActive();
void        pcbCollabApply( std::string aJson );
void        pcbCollabApplyItems( std::string aJson );
std::string pcbCollabSnapshot();
std::string pcbCollabSnapshotItems();
std::string pcbCollabTestMoveFirst( int aDx, int aDy );
std::string pcbCollabGetPos( std::string aId );
bool        pcbCollabTestRemoveItem( std::string aId );
bool        pcbCollabTestRotateItem( std::string aId, double aDeg );
// Collab-aware undo (ysync miss 09).
bool        pcbCollabTestUndo();
int         pcbCollabTestUndoDepth();
// Presence (collab-presence 0002) + comment pins/panning (0005).
void        pcbCollabPresenceStart();
void        pcbCollabSetRemote( std::string aJson );
void        pcbCollabSetPins( std::string aJson );
void        pcbCollabSetViewport( double aCx, double aCy );
// Follow-user (collab-presence 0008).
void        pcbCollabFitViewport( double aCx, double aCy, double aHalfW, double aHalfH );
void        pcbCollabSetStyle( std::string aJson );
std::string pcbCollabTestListItems( int aCount );
std::string pcbCollabTestDemoSet();
std::string pcbCollabGetViewport();
std::string pcbCollabGetSelection();
// Cross-app selection (collab-presence 0006).
std::string pcbCollabGetSelectionFull();
std::string pcbCollabTestGetCrossMapped();
std::string pcbCollabTestSelectComponent();
bool        pcbCollabTestSelectByUuid( std::string aUuid );
// Selection soft-locks (collab-presence 0007).
void        pcbCollabReleaseSelection( std::string aUuidsJson, std::string aHolder );
std::string pcbCollabTestGetLocked();
std::string pcbCollabTestSelectFirst();
bool        pcbCollabTestClearSelection();
// Live color-theme switch (comments-ux 0002 F4).
void        pcbSetColorTheme( std::string aTheme );
void        pcbSetDarkChrome( bool aDark );

// Post-theme-apply hook shared with pcbjam_theme.h — identical inline-variable
// definition instead of including that header (this TU stays header-light);
// keep the two declarations in sync.
namespace pcbjam_theme
{
inline void ( *g_afterThemeApplied )() = nullptr;
}

bool        schEditorActive();
int         schLibsSymbolUsage( std::string aLibNickname, std::string aSymbolName );
void        schCollabApply( std::string aJson );
void        schCollabApplyItems( std::string aJson );
std::string schCollabSnapshot();
std::string schCollabSnapshotItems();
std::string schCollabTestMoveFirst( int aDx, int aDy );
std::string schCollabGetPos( std::string aId );
bool        schCollabTestRemoveItem( std::string aId );
bool        schCollabTestRotateItem( std::string aId, double aDeg );
// Collab-aware undo (ysync miss 09).
bool        schCollabTestUndo();
int         schCollabTestUndoDepth();
// Presence (collab-presence 0003 — eeschema counterparts) + pins (0005).
void        schCollabPresenceStart();
void        schCollabSetRemote( std::string aJson );
void        schCollabSetPins( std::string aJson );
void        schCollabSetViewport( double aCx, double aCy );
// Follow-user (collab-presence 0008).
void        schCollabFitViewport( double aCx, double aCy, double aHalfW, double aHalfH );
void        schCollabSetStyle( std::string aJson );
// Live color-theme switch (comments-ux 0002 F4).
void        schSetColorTheme( std::string aTheme );
std::string schCollabTestListItems( int aCount );
std::string schCollabTestDemoSet();
std::string schCollabGetViewport();
std::string schCollabGetSelection();
// Cross-app selection (collab-presence 0006).
std::string schCollabGetSelectionFull();
std::string schCollabTestGetCrossMapped();
std::string schCollabTestSelectComponent();
bool        schCollabTestSelectByUuid( std::string aUuid );
// Selection soft-locks (collab-presence 0007).
void        schCollabReleaseSelection( std::string aUuidsJson, std::string aHolder );
std::string schCollabTestGetLocked();
std::string schCollabTestSelectFirst();
bool        schCollabTestClearSelection();


// Programmatically open a project file in the running editor frame, without UI
// automation. Frame-agnostic (any KIWAY_PLAYER); byte-identical to the definition the
// standalone bundles compile from their own binding TU.
static bool kicadOpenFile( std::string path )
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
static bool kicadOpenFileBusy()
{
    return pcbjam_open::busy();
}

// Test-only (collab-load-fuzz): arm the deterministic open parks.
static void kicadTestSetOpenPark( int aMs )
{
    pcbjam_open::testParkMs() = aMs;
}

// Test-only (timer-park repro, timer_park.h): a one-shot wx timer whose
// Notify() Asyncify-parks — the deterministic concurrent-park window.
static bool kicadTestArmTimerPark( int aDelayMs, int aParkMs )
{
    return pcbjam_timer_park::arm( aDelayMs, aParkMs );
}

static std::string kicadTestTimerParkState()
{
    return pcbjam_timer_park::stateJson();
}

// Test-only (fiber-resume-park repro, fiber_park.h): Resume() into an
// asyncify-parked coroutine — the decoded prod board-load trap.
static bool kicadTestFiberParkStart( int aParkMs )
{
    return pcbjam_fiber_park::start( aParkMs );
}

static bool kicadTestFiberParkPrime()
{
    return pcbjam_fiber_park::prime();
}

static bool kicadTestFiberParkPoke()
{
    return pcbjam_fiber_park::poke();
}

static std::string kicadTestFiberParkState()
{
    return pcbjam_fiber_park::stateJson();
}

static bool kicadTestFiberParkStartSecond()
{
    return pcbjam_fiber_park::startSecond();
}

static bool kicadTestFiberParkPokeSecond()
{
    return pcbjam_fiber_park::pokeSecond();
}


// Canvas-only chrome toggle (features/mobile): hide/show every AUI pane
// except the central draw canvas, plus the menubar and status bar, so the GAL
// canvas fills the frame. Generic wxFrame/wxAui surface only (keeps this TU
// header-light and serves both editor frames). Hidden bars release their space
// because the wasm port's frame client-area math skips !IsShown() bars (native
// parity, see wxwidgets/src/wasm/frame.cpp). Returns false until the editor
// frame exists — main() builds it after runtime init — so JS polls this.

// Hide-time visibility snapshot. KiCad keeps several panes hidden by default
// (Search, Properties, Net Inspector, …), so a blanket Show(true) on restore
// would surface panes the user never had open — restore only what the hide
// actually took away. Keyed to the frame so a snapshot never leaks onto a
// different frame's wxAuiManager.
static struct
{
    wxFrame*              frame = nullptr;
    bool                  valid = false;
    bool                  menuShown = false;
    bool                  statusShown = false;
    std::vector<wxString> paneNames;
} s_chromeSnap;

static bool chromeSkipsPane( const wxAuiPaneInfo& aPane )
{
    // keep the central editor canvas (named "DrawFrame" in both editors)
    return aPane.dock_direction == wxAUI_DOCK_CENTER || aPane.name == wxT( "DrawFrame" );
}

static bool kicadSetChrome( bool aShow )
{
    wxFrame* frame =
            wxTheApp ? dynamic_cast<wxFrame*>( wxTheApp->GetTopWindow() ) : nullptr;

    if( !frame )
        return false;

    wxMenuBar*    menuBar = frame->GetMenuBar();
    wxStatusBar*  statusBar = frame->GetStatusBar();
    wxAuiManager* mgr = wxAuiManager::GetManager( frame );

    if( !aShow )
    {
        // A repeated hide keeps the original snapshot (idempotent).
        if( !s_chromeSnap.valid || s_chromeSnap.frame != frame )
        {
            s_chromeSnap.frame = frame;
            s_chromeSnap.menuShown = menuBar && menuBar->IsShown();
            s_chromeSnap.statusShown = statusBar && statusBar->IsShown();
            s_chromeSnap.paneNames.clear();

            if( mgr )
            {
                wxAuiPaneInfoArray& panes = mgr->GetAllPanes();

                for( size_t i = 0; i < panes.GetCount(); ++i )
                {
                    wxAuiPaneInfo& pane = panes.Item( i );

                    if( !chromeSkipsPane( pane ) && pane.IsShown() )
                        s_chromeSnap.paneNames.push_back( pane.name );
                }
            }

            s_chromeSnap.valid = true;
        }
    }

    // A show with no snapshot (or one taken on a different frame) falls back
    // to revealing the standard chrome instead of obeying stale state.
    const bool haveSnap = s_chromeSnap.valid && s_chromeSnap.frame == frame;

    if( menuBar )
        menuBar->Show( aShow && ( haveSnap ? s_chromeSnap.menuShown : true ) );

    // Kept alive rather than detached: KiCad SetStatusText()s on every cursor
    // move, and wxFrameBase wxCHECKs a null status bar.
    if( statusBar )
        statusBar->Show( aShow && ( haveSnap ? s_chromeSnap.statusShown : true ) );

    if( mgr )
    {
        wxAuiPaneInfoArray& panes = mgr->GetAllPanes();

        for( size_t i = 0; i < panes.GetCount(); ++i )
        {
            wxAuiPaneInfo& pane = panes.Item( i );

            if( chromeSkipsPane( pane ) )
                continue;

            if( !aShow )
            {
                pane.Show( false );
            }
            else if( haveSnap )
            {
                if( std::find( s_chromeSnap.paneNames.begin(), s_chromeSnap.paneNames.end(),
                               pane.name )
                    != s_chromeSnap.paneNames.end() )
                {
                    pane.Show( true );
                }
            }
            else if( pane.IsToolbar() )
            {
                // Show with no (or a stale, other-frame) snapshot: reveal the
                // toolbars only — blanket-showing plain panels would surface
                // the default-hidden ones.
                pane.Show( true );
            }
        }

        mgr->Update();
    }

    if( aShow )
        s_chromeSnap.valid = false;

    frame->SendSizeEvent();
    return true;
}


// Read-only viewer lock (read-only-viewer): flips the process-global
// PCBJAM_READ_ONLY flag consumed by TOOL_MANAGER (view-only action allowlist)
// and the selection tools (nothing selectable), and mirrors it onto the
// project so the setup dialogs grey out. Zoom/pan stay live (mouse/touch
// bypass the tool system; keyboard zoom/pan is allowlisted). Returns false
// until the editor frame exists — main() builds it after runtime init — so
// JS polls this; the shell fails CLOSED if it never applies.
static bool kicadSetReadOnly( bool aReadOnly )
{
    KIWAY_PLAYER* frame =
            wxTheApp ? dynamic_cast<KIWAY_PLAYER*>( wxTheApp->GetTopWindow() ) : nullptr;

    if( !frame )
        return false;

    PCBJAM_READ_ONLY::Set( aReadOnly );
    frame->Prj().SetReadOnly( aReadOnly );
    return true;
}


// C++ → JS save notification. Called from BOTH fork save chokepoints
// (PCB_EDIT_FRAME::SavePcbFile and SCH_EDIT_FRAME::saveSchematicFile) — one shared
// definition serves the merged image. No-op without a JS listener.
extern "C" void kicadCollabOnSave( const char* aPath )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onSave )
            window.kicadCollab.onSave( UTF8ToString( $0 ) );
    }, aPath );
}


// Dispatch shims: route each shared JS name to the live editor's implementation.
// The sch path is the fallback arm so a JS call with NO frame up behaves like the
// standalone bundles (the per-editor impls no-op / return empty on a null frame).
static void collabApply( std::string aJson )
{
    pcbEditorActive() ? pcbCollabApply( aJson ) : schCollabApply( aJson );
}

static void collabApplyItems( std::string aJson )
{
    pcbEditorActive() ? pcbCollabApplyItems( aJson ) : schCollabApplyItems( aJson );
}

static std::string collabSnapshot()
{
    return pcbEditorActive() ? pcbCollabSnapshot() : schCollabSnapshot();
}

static std::string collabSnapshotItems()
{
    return pcbEditorActive() ? pcbCollabSnapshotItems() : schCollabSnapshotItems();
}

static std::string collabTestMoveFirst( int aDx, int aDy )
{
    return pcbEditorActive() ? pcbCollabTestMoveFirst( aDx, aDy )
                             : schCollabTestMoveFirst( aDx, aDy );
}

static std::string collabGetPos( std::string aId )
{
    return pcbEditorActive() ? pcbCollabGetPos( aId ) : schCollabGetPos( aId );
}

static bool collabTestRemoveItem( std::string aId )
{
    return pcbEditorActive() ? pcbCollabTestRemoveItem( aId ) : schCollabTestRemoveItem( aId );
}

static bool collabTestRotateItem( std::string aId, double aDeg )
{
    return pcbEditorActive() ? pcbCollabTestRotateItem( aId, aDeg )
                             : schCollabTestRotateItem( aId, aDeg );
}

static bool collabTestUndo()
{
    return pcbEditorActive() ? pcbCollabTestUndo() : schCollabTestUndo();
}

static int collabTestUndoDepth()
{
    return pcbEditorActive() ? pcbCollabTestUndoDepth() : schCollabTestUndoDepth();
}

// Placed-instance count for a library symbol — meaningful only with a schematic
// frame; every other editor answers 0 ("nothing placed here uses it").
static int libsSymbolUsage( std::string aLib, std::string aName )
{
    return schEditorActive() ? schLibsSymbolUsage( aLib, aName ) : 0;
}

// Presence shims (collab-presence 0002 pcbnew / 0003 eeschema): route to the live
// editor's implementation, same pattern as the collab bridge shims above.
static void collabPresenceStart()
{
    pcbEditorActive() ? pcbCollabPresenceStart() : schCollabPresenceStart();
}

static void collabSetRemote( std::string aJson )
{
    pcbEditorActive() ? pcbCollabSetRemote( aJson ) : schCollabSetRemote( aJson );
}

static void collabSetPins( std::string aJson )
{
    pcbEditorActive() ? pcbCollabSetPins( aJson ) : schCollabSetPins( aJson );
}

static void collabSetViewport( double aCx, double aCy )
{
    pcbEditorActive() ? pcbCollabSetViewport( aCx, aCy ) : schCollabSetViewport( aCx, aCy );
}

// Follow-user (collab-presence 0008).
static void collabFitViewport( double aCx, double aCy, double aHalfW, double aHalfH )
{
    pcbEditorActive() ? pcbCollabFitViewport( aCx, aCy, aHalfW, aHalfH )
                      : schCollabFitViewport( aCx, aCy, aHalfW, aHalfH );
}

static void collabSetStyle( std::string aJson )
{
    pcbEditorActive() ? pcbCollabSetStyle( aJson ) : schCollabSetStyle( aJson );
}

// Theme switch (comments-ux 0002 F4): BOTH editors, not just the active one —
// a later frame switch (eeschema-switch-nav) must come up already themed.
// Each side no-ops on a null frame.
static void setColorTheme( std::string aTheme )
{
    // A real theme apply rebuilds the menubar/toolbars, which come back
    // SHOWN — re-hide them when the chrome is supposed to be hidden
    // (read-only viewer / mobile canvas-only). Installed here, not in
    // pcbjam_theme.h, because the chrome snapshot is merged-image state.
    pcbjam_theme::g_afterThemeApplied = []() {
        if( s_chromeSnap.valid )
            kicadSetChrome( false );
    };

    pcbSetColorTheme( aTheme );
    schSetColorTheme( aTheme );
}

// The chrome flag is process-global — one call suffices.
static void setDarkChrome( bool aDark )
{
    pcbSetDarkChrome( aDark );
}

static std::string collabTestListItems( int aCount )
{
    return pcbEditorActive() ? pcbCollabTestListItems( aCount ) : schCollabTestListItems( aCount );
}

static std::string collabTestDemoSet()
{
    return pcbEditorActive() ? pcbCollabTestDemoSet() : schCollabTestDemoSet();
}

static std::string collabGetViewport()
{
    return pcbEditorActive() ? pcbCollabGetViewport() : schCollabGetViewport();
}

static std::string collabGetSelection()
{
    return pcbEditorActive() ? pcbCollabGetSelection() : schCollabGetSelection();
}

static std::string collabGetSelectionFull()
{
    return pcbEditorActive() ? pcbCollabGetSelectionFull() : schCollabGetSelectionFull();
}

static std::string collabTestGetCrossMapped()
{
    return pcbEditorActive() ? pcbCollabTestGetCrossMapped() : schCollabTestGetCrossMapped();
}

static std::string collabTestSelectComponent()
{
    return pcbEditorActive() ? pcbCollabTestSelectComponent() : schCollabTestSelectComponent();
}

static bool collabTestSelectByUuid( std::string aUuid )
{
    return pcbEditorActive() ? pcbCollabTestSelectByUuid( aUuid )
                             : schCollabTestSelectByUuid( aUuid );
}

static void collabReleaseSelection( std::string aUuidsJson, std::string aHolder )
{
    pcbEditorActive() ? pcbCollabReleaseSelection( aUuidsJson, aHolder )
                      : schCollabReleaseSelection( aUuidsJson, aHolder );
}

static std::string collabTestGetLocked()
{
    return pcbEditorActive() ? pcbCollabTestGetLocked() : schCollabTestGetLocked();
}

static std::string collabTestSelectFirst()
{
    return pcbEditorActive() ? pcbCollabTestSelectFirst() : schCollabTestSelectFirst();
}

static bool collabTestClearSelection()
{
    return pcbEditorActive() ? pcbCollabTestClearSelection() : schCollabTestClearSelection();
}


static bool kicadCollabFiberBusyProbe()
{
    return pcbjam_collab::fiberBusy() || !pcbjam_collab::fiberQueue().empty();
}

EMSCRIPTEN_BINDINGS(kicad_editor) {
    // Fiber-queue idle probe (drift-trio finding #10b): a bare-embind-stack
    // save during a parked apply fiber mis-dispatches (table index OOB) — the
    // JS side must defer scratch saves while collab fiber work is in flight.
    function("kicadCollabFiberBusy", &kicadCollabFiberBusyProbe);
    // Programmatic file open (preferred over UI automation from the web app).
    function("kicadOpenFile", &kicadOpenFile);
    function("kicadOpenFileBusy", &kicadOpenFileBusy);
    function("kicadTestSetOpenPark", &kicadTestSetOpenPark);
    function("kicadTestArmTimerPark", &kicadTestArmTimerPark);
    function("kicadTestTimerParkState", &kicadTestTimerParkState);
    function("kicadTestFiberParkStart", &kicadTestFiberParkStart);
    function("kicadTestFiberParkPrime", &kicadTestFiberParkPrime);
    function("kicadTestFiberParkPoke", &kicadTestFiberParkPoke);
    function("kicadTestFiberParkState", &kicadTestFiberParkState);
    function("kicadTestFiberParkStartSecond", &kicadTestFiberParkStartSecond);
    function("kicadTestFiberParkPokeSecond", &kicadTestFiberParkPokeSecond);

    // Canvas-only mobile mode (features/mobile).
    function("kicadSetChrome", &kicadSetChrome);

    // Read-only viewer lock (read-only-viewer).
    function("kicadSetReadOnly", &kicadSetReadOnly);

    // Yjs collaborative bridge entry points — same JS contract as the standalone
    // bundles, dispatched on the active editor frame.
    function("kicadCollabApply", &collabApply);
    function("kicadCollabSnapshot", &collabSnapshot);
    function("kicadCollabApplyItems", &collabApplyItems);
    function("kicadCollabSnapshotItems", &collabSnapshotItems);
    function("kicadCollabTestMoveFirst", &collabTestMoveFirst);
    function("kicadCollabGetPos", &collabGetPos);
    // ysync-review repro hooks (shared names; per-editor-only hooks — pad size,
    // endpoint, field text — flow from the per-editor blocks unchanged).
    function("kicadCollabTestRemoveItem", &collabTestRemoveItem);
    function("kicadCollabTestRotateItem", &collabTestRotateItem);
    // Collab-aware undo (ysync miss 09).
    function("kicadCollabTestUndo", &collabTestUndo);
    function("kicadCollabTestUndoDepth", &collabTestUndoDepth);
    // Presence (collab-presence 0002/0003) + comment pins/panning (0005).
    function("kicadCollabPresenceStart", &collabPresenceStart);
    function("kicadCollabSetRemote", &collabSetRemote);
    function("kicadCollabSetPins", &collabSetPins);
    function("kicadCollabSetViewport", &collabSetViewport);
    // Live color-theme switch (comments-ux 0002 F4).
    function("kicadSetColorTheme", &setColorTheme);
    function("kicadSetDarkChrome", &setDarkChrome);
    // Follow-user (collab-presence 0008).
    function("kicadCollabFitViewport", &collabFitViewport);
    function("kicadCollabSetStyle", &collabSetStyle);
    function("kicadCollabTestListItems", &collabTestListItems);
    function("kicadCollabTestDemoSet", &collabTestDemoSet);
    function("kicadCollabGetViewport", &collabGetViewport);
    function("kicadCollabGetSelection", &collabGetSelection);
    // Cross-app selection (collab-presence 0006).
    function("kicadCollabGetSelectionFull", &collabGetSelectionFull);
    function("kicadCollabTestGetCrossMapped", &collabTestGetCrossMapped);
    function("kicadCollabTestSelectComponent", &collabTestSelectComponent);
    function("kicadCollabTestSelectByUuid", &collabTestSelectByUuid);
    // Selection soft-locks (collab-presence 0007).
    function("kicadCollabReleaseSelection", &collabReleaseSelection);
    function("kicadCollabTestGetLocked", &collabTestGetLocked);
    function("kicadCollabTestSelectFirst", &collabTestSelectFirst);
    function("kicadCollabTestClearSelection", &collabTestClearSelection);
    // Library reload after a remote (synced) lib edit — r2-idb-sync realtime.
    function("kicadLibsReload", &pcbjam_libs::reloadLibrary);
    // Placed-instance count for a library symbol (schematic sessions only —
    // 0 from any other frame; drives the "symbol you are using was updated"
    // toast after a remote lib edit).
    function("kicadLibsSymbolUsage", &libsSymbolUsage);
}

#endif // __EMSCRIPTEN__
