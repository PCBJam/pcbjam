/**
 * Link stubs for the native 3D-renderer test build.
 *
 * The harness compiles real KiCad 3D-viewer TUs; the symbols those TUs
 * reference from elsewhere in KiCad but only reach through dead branches
 * (m_board / model-cache / app machinery is never populated here) are defined
 * as safe no-ops. One stub per linker error, each annotated with the
 * referencing TU. Seeded from tests/gal-regression/native/kicad_stubs.cpp.
 */

#include "kicad_stubs_3d.h"

#include <advanced_config.h>
#include <pgm_base.h>
#include <singleton.h>
#include <kicad_gl/gl_context_mgr.h>

// PGM_BASE holds unique_ptrs to these — complete types needed to define
// its ctor/dtor here.
#include <background_jobs_monitor.h>
#include <notifications_manager.h>
#include <settings/settings_manager.h>
#include <wx/snglinst.h>

#include <board.h>
#include <pad.h>
#include <pcb_track.h>

#include <libraries/library_manager.h>
#include <project_pcb.h>

#include "3d_cache/3d_cache.h"

//=============================================================================
// PGM_BASE / Pgm() — render_3d_opengl.cpp uses
// Pgm().GetGLContextManager()->RunWithoutCtxLock() during reload().
//=============================================================================

class PGM_BASE_TEST : public PGM_BASE
{
public:
    PGM_BASE_TEST() { m_singleton.m_GLContextManager = new GL_CONTEXT_MANAGER(); }

    void MacOpenFile( const wxString& ) override {}
};

PGM_BASE& Pgm()
{
    static PGM_BASE_TEST* s_pgm = nullptr;

    if( !s_pgm )
        s_pgm = new PGM_BASE_TEST();

    return *s_pgm;
}

// PGM_BASE out-of-line methods (pgm_base.cpp is not compiled) — same stub set
// as the GAL harness.
PGM_BASE::PGM_BASE()
{
}

PGM_BASE::~PGM_BASE()
{
}

wxApp& PGM_BASE::App()
{
    static wxApp* app = nullptr;
    return *app;
}

COMMON_SETTINGS* PGM_BASE::GetCommonSettings() const
{
    return nullptr;
}

const wxString& PGM_BASE::GetExecutablePath() const
{
    static wxString s;
    return s;
}

ENV_VAR_MAP& PGM_BASE::GetLocalEnvVariables() const
{
    static ENV_VAR_MAP map;
    return map;
}

bool PGM_BASE::SetLanguage( wxString&, bool )
{
    return false;
}

const wxString& PGM_BASE::GetTextEditor( bool )
{
    static wxString s;
    return s;
}

void PGM_BASE::SetTextEditor( const wxString& )
{
}

wxString PGM_BASE::GetLanguageTag()
{
    return wxString();
}

void PGM_BASE::SetLanguagePath()
{
}

void PGM_BASE::ReadPdfBrowserInfos()
{
}

bool PGM_BASE::SetLocalEnvVariable( const wxString&, const wxString& )
{
    return false;
}

void PGM_BASE::SetLocalEnvVariables()
{
}

void PGM_BASE::WritePdfBrowserInfos()
{
}

void PGM_BASE::SetLanguageIdentifier( int )
{
}

const wxString PGM_BASE::AskUserForPreferredEditor( const wxString& )
{
    return wxString();
}

//=============================================================================
// ADVANCED_CFG singleton (advanced_config.cpp is not compiled)
//=============================================================================

const ADVANCED_CFG& ADVANCED_CFG::GetCfg()
{
    static ADVANCED_CFG instance;
    return instance;
}

ADVANCED_CFG::ADVANCED_CFG()
{
    // Only fields the compiled TUs actually read; KiCad default DPI.
    m_ScreenDPI = 91;
    m_3DRT_BevelHeight_um = 30;
    m_3DRT_BevelExtentFactor = 1.0 / 16.0;
}

//=============================================================================
// Profiling clock — deterministic zero for the test harness.
//=============================================================================

int64_t GetRunningMicroSecs()
{
    return 0;
}

//=============================================================================
// Destructors of app-machinery members PGM_BASE owns (their real TUs would
// drag the whole settings/library world in; nothing here ever populates them).
//=============================================================================

KICAD_SINGLETON::~KICAD_SINGLETON()
{
    delete m_GLContextManager;
    m_GLContextManager = nullptr;
}

LIBRARY_MANAGER::~LIBRARY_MANAGER() = default;

SETTINGS_MANAGER::~SETTINGS_MANAGER() = default;

//=============================================================================
// STATUSBAR_REPORTER (reporter.cpp drags fontconfig; Redraw() takes REPORTER*
// but the harness always passes nullptr).
//=============================================================================

#include <reporter.h>

REPORTER& STATUSBAR_REPORTER::Report( const wxString&, SEVERITY )
{
    return *this;
}

//=============================================================================
// BOARD / BOARD_ITEM / PAD / PCB_VIA — referenced from create_scene.cpp and
// render_3d_opengl.cpp branches that only run with a real BOARD loaded
// (m_board stays nullptr in this harness).
//=============================================================================

int BOARD::GetCopperLayerCount() const
{
    return 2;
}

const EMBEDDED_FILES* BOARD::GetEmbeddedFiles() const
{
    return nullptr;
}

const wxString BOARD::GetLayerName( PCB_LAYER_ID aLayer ) const
{
    return LayerName( aLayer );
}

int BOARD_ITEM::GetMaxError() const
{
    return ARC_HIGH_DEF;
}

bool PAD::TransformHoleToPolygon( SHAPE_POLY_SET&, int, int, ERROR_LOC ) const
{
    return false;
}

int PCB_VIA::GetDrillValue() const
{
    return 0;
}

void PCB_VIA::LayerPair( PCB_LAYER_ID* aTopLayer, PCB_LAYER_ID* aBottomLayer ) const
{
    if( aTopLayer )
        *aTopLayer = F_Cu;

    if( aBottomLayer )
        *aBottomLayer = B_Cu;
}

std::optional<int> PCB_VIA::GetSecondaryDrillSize() const
{
    return std::nullopt;
}

std::optional<int> PCB_VIA::GetTertiaryDrillSize() const
{
    return std::nullopt;
}

FILLING_MODE PCB_VIA::GetFillingMode() const
{
    return static_cast<FILLING_MODE>( 0 );
}

CAPPING_MODE PCB_VIA::GetCappingMode() const
{
    return static_cast<CAPPING_MODE>( 0 );
}

PLUGGING_MODE PCB_VIA::GetFrontPluggingMode() const
{
    return static_cast<PLUGGING_MODE>( 0 );
}

PLUGGING_MODE PCB_VIA::GetBackPluggingMode() const
{
    return static_cast<PLUGGING_MODE>( 0 );
}

COVERING_MODE PCB_VIA::GetFrontCoveringMode() const
{
    return static_cast<COVERING_MODE>( 0 );
}

COVERING_MODE PCB_VIA::GetBackCoveringMode() const
{
    return static_cast<COVERING_MODE>( 0 );
}

//=============================================================================
// Footprint-model loading chain (Load3dModelsIfNeeded is never called).
//=============================================================================

FOOTPRINT_LIBRARY_ADAPTER* PROJECT_PCB::FootprintLibAdapter( PROJECT* )
{
    return nullptr;
}

wxString LIBRARY_MANAGER::GetFullURI( const LIBRARY_TABLE_ROW*, bool )
{
    return wxString();
}

std::optional<LIBRARY_TABLE_ROW*> LIBRARY_MANAGER_ADAPTER::GetRow( const wxString&,
                                                                   LIBRARY_TABLE_SCOPE ) const
{
    return std::nullopt;
}

S3DMODEL* S3D_CACHE::GetModel( const wxString&, const wxString&,
                               std::vector<const EMBEDDED_FILES*> )
{
    return nullptr;
}

//=============================================================================
// traceGalContext: gl_context_mgr.cpp traces a failed SetCurrent since KiCad
// 10.0.7 (trace_helpers.cpp itself drags the whole trace manager).
//=============================================================================

#include <trace_helpers.h>

const wxChar* const traceGalContext = wxT( "KICAD_GAL_CONTEXT" );
