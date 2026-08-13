/**
 * WASM stubs for GAL WebGL test
 *
 * Provides implementations for symbols needed by WEBGL_GAL but not
 * provided by the minimal test harness.
 */

// Include kiglew.h first to prevent GLEW conflicts
#include "webgl/kiglew.h"

#include <wx/wx.h>
#include <wx/snglinst.h>

// Forward declarations to avoid including heavy headers
namespace KIGFX { class GAL; }

// Include minimal headers
#include <gal/color4d.h>
#include <kiid.h>
#include <gal/hidpi_gl_canvas.h>
#include <gal/graphics_abstraction_layer.h>

//=============================================================================
// COLOR4D static constants
//=============================================================================

namespace KIGFX {

const COLOR4D COLOR4D::BLACK( 0, 0, 0, 1 );
const COLOR4D COLOR4D::WHITE( 1, 1, 1, 1 );
const COLOR4D COLOR4D::UNSPECIFIED( 0, 0, 0, 0 );
const COLOR4D COLOR4D::CLEAR( 0, 0, 0, 0 );

// COLOR4D constructor from EDA_COLOR_T - simplified color lookup
// Matches the actual EDA_COLOR_T enum values in color4d.h
COLOR4D::COLOR4D( EDA_COLOR_T aColor )
{
    switch( aColor )
    {
    case ::BLACK:        r = 0;    g = 0;    b = 0;    a = 1; break;
    case ::DARKDARKGRAY: r = 0.2;  g = 0.2;  b = 0.2;  a = 1; break;
    case ::DARKGRAY:     r = 0.33; g = 0.33; b = 0.33; a = 1; break;
    case ::LIGHTGRAY:    r = 0.67; g = 0.67; b = 0.67; a = 1; break;
    case ::WHITE:        r = 1;    g = 1;    b = 1;    a = 1; break;
    case ::LIGHTYELLOW:  r = 1;    g = 1;    b = 0.33; a = 1; break;
    case ::DARKBLUE:     r = 0;    g = 0;    b = 0.33; a = 1; break;
    case ::DARKGREEN:    r = 0;    g = 0.33; b = 0;    a = 1; break;
    case ::DARKCYAN:     r = 0;    g = 0.33; b = 0.33; a = 1; break;
    case ::DARKRED:      r = 0.33; g = 0;    b = 0;    a = 1; break;
    case ::DARKMAGENTA:  r = 0.33; g = 0;    b = 0.33; a = 1; break;
    case ::DARKBROWN:    r = 0.17; g = 0.08; b = 0;    a = 1; break;
    case ::BLUE:         r = 0;    g = 0;    b = 0.67; a = 1; break;
    case ::GREEN:        r = 0;    g = 0.67; b = 0;    a = 1; break;
    case ::CYAN:         r = 0;    g = 0.67; b = 0.67; a = 1; break;
    case ::RED:          r = 0.67; g = 0;    b = 0;    a = 1; break;
    case ::MAGENTA:      r = 0.67; g = 0;    b = 0.67; a = 1; break;
    case ::BROWN:        r = 0.33; g = 0.17; b = 0;    a = 1; break;
    case ::LIGHTBLUE:    r = 0.33; g = 0.33; b = 1;    a = 1; break;
    case ::LIGHTGREEN:   r = 0.33; g = 1;    b = 0.33; a = 1; break;
    case ::LIGHTCYAN:    r = 0.33; g = 1;    b = 1;    a = 1; break;
    case ::LIGHTRED:     r = 1;    g = 0.33; b = 0.33; a = 1; break;
    case ::LIGHTMAGENTA: r = 1;    g = 0.33; b = 1;    a = 1; break;
    case ::YELLOW:       r = 0.67; g = 0.67; b = 0;    a = 1; break;
    case ::PUREBLUE:     r = 0;    g = 0;    b = 1;    a = 1; break;
    case ::PUREGREEN:    r = 0;    g = 1;    b = 0;    a = 1; break;
    case ::PURECYAN:     r = 0;    g = 1;    b = 1;    a = 1; break;
    case ::PURERED:      r = 1;    g = 0;    b = 0;    a = 1; break;
    case ::PUREMAGENTA:  r = 1;    g = 0;    b = 1;    a = 1; break;
    case ::PUREYELLOW:   r = 1;    g = 1;    b = 0;    a = 1; break;
    case ::LIGHTERORANGE:r = 1;    g = 0.8;  b = 0.6;  a = 1; break;
    case ::DARKORANGE:   r = 0.6;  g = 0.3;  b = 0;    a = 1; break;
    case ::ORANGE:       r = 0.8;  g = 0.5;  b = 0;    a = 1; break;
    case ::LIGHTORANGE:  r = 1;    g = 0.7;  b = 0.4;  a = 1; break;
    case ::PUREORANGE:   r = 1;    g = 0.5;  b = 0;    a = 1; break;
    case UNSPECIFIED_COLOR:
    default:
        r = 0; g = 0; b = 0; a = 0; // Unspecified = transparent
        break;
    }
}

} // namespace KIGFX

//=============================================================================
// KIID
//=============================================================================

KIID niluuid;

// Note: GAL class is provided by graphics_abstraction_layer.cpp

//=============================================================================
// GLU tesselator - now implemented in glu_tess_impl.cpp using earcut.hpp
//=============================================================================

//=============================================================================
// Additional stubs from kicad_stubs.cpp that are needed
//=============================================================================

#include <core/observable.h>

namespace UTIL {
namespace DETAIL {

OBSERVABLE_BASE::OBSERVABLE_BASE() {}
OBSERVABLE_BASE::~OBSERVABLE_BASE() {}
void OBSERVABLE_BASE::on_observers_empty() {}
void OBSERVABLE_BASE::enter_iteration() {}
void OBSERVABLE_BASE::leave_iteration() {}
void OBSERVABLE_BASE::add_observer(void*) {}
void OBSERVABLE_BASE::remove_observer(void*) {}

} // namespace DETAIL
} // namespace UTIL

// UTIL::LINK stubs
namespace UTIL {
LINK::LINK() : token_(nullptr), observer_(nullptr) {}
LINK::LINK(std::shared_ptr<DETAIL::OBSERVABLE_BASE::IMPL> token, void* observer)
    : token_(token), observer_(observer) {}
LINK::LINK(LINK&& other) : token_(std::move(other.token_)), observer_(other.observer_) {
    other.observer_ = nullptr;
}
LINK::~LINK() {}
LINK& LINK::operator=(LINK&& other) {
    token_ = std::move(other.token_);
    observer_ = other.observer_;
    other.observer_ = nullptr;
    return *this;
}
void LINK::reset() { token_.reset(); observer_ = nullptr; }
LINK::operator bool() const { return token_ != nullptr; }
}

// UI dialog stubs
void DisplayError(wxWindow*, const wxString&) {}
void DisplayErrorMessage(wxWindow*, const wxString&, const wxString&) {}

// OpenGL info stub
void SetOpenGLInfo(const char*, const char*, const char*) {}

// Math logging stub
void kimathLogOverflow(double, const char*) {}

// Arc geometry stub
#include <geometry/eda_angle.h>
int GetArcToSegmentCount(int aRadius, int aArcError, const EDA_ANGLE& aArcAngle) {
    double degrees = std::abs(aArcAngle.AsDegrees());
    return std::max(1, (int)(degrees / 10.0));
}

// DPI scaling stub
#include <dpi_scaling.h>
double DPI_SCALING::GetDefaultScaleFactor() { return 1.0; }

// Cursor store stub
#include <gal/cursors.h>
const WX_CURSOR_TYPE CURSOR_STORE::GetCursor(KICURSOR aCursor, bool aHiDPI) {
    return wxCursor(wxCURSOR_ARROW);
}

// VC_SETTINGS::Reset stub
#include <view/view_controls.h>
namespace KIGFX {
void VC_SETTINGS::Reset() {}
}

// KIID constructors
KIID::KIID() {}
KIID::KIID(int aValue) {}

// UTF8 stubs
#include <core/utf8.h>
UTF8::UTF8(const wxString& s) : m_s(s.ToUTF8().data()) {}
int UTF8::uni_forward(const unsigned char* aSequence, unsigned* aResult) {
    if (aSequence && *aSequence) {
        if (aResult) *aResult = (unsigned)*aSequence;
        return 1;
    }
    if (aResult) *aResult = 0;
    return 0;
}

// TEXT_ATTRIBUTES constructor
#include <font/text_attributes.h>
TEXT_ATTRIBUTES::TEXT_ATTRIBUTES(KIFONT::FONT* aFont) {}

// KIFONT stubs
#include <font/font.h>

namespace KIFONT {

FONT* FONT::GetFont(const wxString&, bool, bool, const std::vector<wxString>*, bool) {
    return nullptr;
}

const METRICS& METRICS::Default() {
    static METRICS m;
    return m;
}

void OUTLINE_GLYPH::Triangulate(std::function<void(const VECTOR2I&, const VECTOR2I&, const VECTOR2I&)>) const {}

void FONT::Draw(KIGFX::GAL*, const wxString&, const VECTOR2I&, const VECTOR2I&,
                const TEXT_ATTRIBUTES&, const METRICS&, std::optional<VECTOR2I>,
                wxString*) const {}

// STROKE_GLYPH stubs
STROKE_GLYPH::STROKE_GLYPH( const STROKE_GLYPH& aGlyph )
{
    reserve( aGlyph.size() );
    for( const std::vector<VECTOR2D>& pointList : aGlyph )
        push_back( pointList );
    m_boundingBox = aGlyph.m_boundingBox;
    m_penIsDown = false;
}

void STROKE_GLYPH::AddPoint( const VECTOR2D& aPoint )
{
    if( !m_penIsDown )
    {
        emplace_back();
        back().reserve( 16 );
        m_penIsDown = true;
    }
    back().push_back( aPoint );
}

void STROKE_GLYPH::RaisePen()
{
    m_penIsDown = false;
}

void STROKE_GLYPH::Finalize()
{
}

} // namespace KIFONT

// SHAPE_POLY_SET stub
#include <geometry/shape_poly_set.h>
bool SHAPE_POLY_SET::IsTriangulationUpToDate() const {
    return false;
}

// Bezier curve stub
#include <bezier_curves.h>
void BEZIER_POLY::GetPoly(std::vector<VECTOR2D>& aOutput, double aMinSegLen) {
    if (!m_ctrlPts.empty()) {
        aOutput.push_back(m_ctrlPts.front());
        aOutput.push_back(m_ctrlPts.back());
    }
}

// BITMAP_BASE stubs
#include <bitmap_base.h>

BITMAP_BASE::BITMAP_BASE( const VECTOR2I& pos )
{
    m_scale  = 1.0;
    m_imageType = wxBITMAP_TYPE_PNG;
    m_bitmap = nullptr;
    m_image  = nullptr;
    m_originalImage = nullptr;
    m_ppi    = 91;
    m_pixelSizeIu = 254000.0 / m_ppi;
    m_isMirroredX = false;
    m_isMirroredY = false;
    m_rotation = ANGLE_0;
}

bool BITMAP_BASE::SetImage( const wxImage& aImage )
{
    delete m_image;
    delete m_originalImage;
    delete m_bitmap;

    m_image = new wxImage( aImage );
    m_originalImage = new wxImage( aImage );
    m_bitmap = new wxBitmap( *m_image );
    m_imageType = wxBITMAP_TYPE_PNG;
    return true;
}

//=============================================================================
// PGM_BASE and related stubs (minimal for GL_CONTEXT_MANAGER)
//=============================================================================

// Forward-declared types
class SETTINGS_MANAGER {};
class LIBRARY_MANAGER {};
class BACKGROUND_JOBS_MONITOR {};
class NOTIFICATIONS_MANAGER {};

#include <pgm_base.h>
#include <advanced_config.h>
#include <settings/environment.h>

// Minimal PGM_BASE subclass
class PGM_BASE_TEST : public PGM_BASE {
public:
    PGM_BASE_TEST() : PGM_BASE() {}
    void MacOpenFile(const wxString& aFileName) override {}
};

static PGM_BASE_TEST* s_pgmInstance = nullptr;

PGM_BASE& Pgm() {
    if (!s_pgmInstance) {
        s_pgmInstance = new PGM_BASE_TEST();
    }
    return *s_pgmInstance;
}

// Newer GAL code probes the program via the nullable accessor
// (graphics_abstraction_layer.h GetSettings path); without this the
// -sERROR_ON_UNDEFINED_SYMBOLS=0 stub aborts with
// "missing function: _Z9PgmOrNullv" during WEBGL_GAL creation.
PGM_BASE* PgmOrNull() {
    return &Pgm();
}

const ADVANCED_CFG& ADVANCED_CFG::GetCfg() {
    static ADVANCED_CFG instance;
    return instance;
}

ADVANCED_CFG::ADVANCED_CFG() {
    m_ScreenDPI = 91;
}

const char* GetBuildVersion() {
    return "8.0.0-wasm-test";
}

wxApp& PGM_BASE::App() {
    return *wxTheApp;
}

COMMON_SETTINGS* PGM_BASE::GetCommonSettings() const {
    return nullptr;
}

const wxString& PGM_BASE::GetExecutablePath() const {
    static wxString empty;
    return empty;
}

ENV_VAR_MAP& PGM_BASE::GetLocalEnvVariables() const {
    static ENV_VAR_MAP empty;
    return empty;
}

bool PGM_BASE::SetLanguage(wxString&, bool) { return false; }
const wxString& PGM_BASE::GetTextEditor(bool) { static wxString s; return s; }
void PGM_BASE::SetTextEditor(const wxString&) {}
wxString PGM_BASE::GetLanguageTag() { return wxString(); }
void PGM_BASE::SetLanguagePath() {}
void PGM_BASE::ReadPdfBrowserInfos() {}
bool PGM_BASE::SetLocalEnvVariable(const wxString&, const wxString&) { return false; }
void PGM_BASE::SetLocalEnvVariables() {}
void PGM_BASE::WritePdfBrowserInfos() {}
void PGM_BASE::SetLanguageIdentifier(int) {}
const wxString PGM_BASE::AskUserForPreferredEditor(const wxString&) { return wxString(); }

PGM_BASE::PGM_BASE() {
    m_singleton.Init();
}
PGM_BASE::~PGM_BASE() {}

// Singleton init
#include <singleton.h>
#include "webgl/gl_context_mgr.h"

void KICAD_SINGLETON::Init() {
    m_GLContextManager = new GL_CONTEXT_MANAGER();
}
KICAD_SINGLETON::~KICAD_SINGLETON() {
    delete m_GLContextManager;
    m_GLContextManager = nullptr;
}

// Legacy GL stubs removed - all rendering now uses modern OpenGL ES 3.0
// If you get linker errors about missing GL functions, the calling code needs
// to be rewritten to use VBOs/shaders instead of immediate mode.
