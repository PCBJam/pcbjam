/*
 * fontconfig_wasm.cpp: KiCad's FONTCONFIG for the browser build, which has no fontconfig.
 * Replaces common/font/fontconfig.cpp on wasm (kicad/common/CMakeLists.txt), so the upstream
 * file stays as it is.
 *
 * Fonts come from two places:
 *
 *  - Embedded files. Every font file KiCad hands over in aEmbeddedFiles (the embed cache,
 *    kicad_embedded_<hash>) is read once with FreeType for its family and style and kept for
 *    the whole session, as native fontconfig does with FcConfigAppFontAddFile. Lookups that
 *    come without the document's list (a bold toggle, a collab apply) still find them.
 *
 *  - Font files the user uploaded in a file dialog (the wx port's "Upload from this
 *    computer...", wxwidgets/src/wasm/dialog.cpp, writes them to /tmp/uploads). That folder
 *    is scanned like a fontconfig font folder, so a font added through Embedded Files is in
 *    the Font list without a reload.
 *
 *  - The folders named in PCBJAM_FONT_DIRS (colon-separated), scanned the same way, sub-folders
 *    included. Server-side kicad_tools runs set it to the job's own folder of the team library
 *    fonts its documents use (fonts 0002 F3); /tmp is shared by every job on a host, so they
 *    cannot go to /tmp/uploads. The browser never sets it.
 *
 *  - The browser's installed fonts (Local Font Access API, Chromium only). The web shell
 *    (web/standalone/src/wasm/local-fonts.ts) pushes their names in through
 *    pcbjam_local_fonts_set(); a face's bytes are fetched into MEMFS the first time a lookup
 *    picks it. Fetching is async, so the lookup parks (JSPI) when the caller may park, the
 *    way a wx event handler can; elsewhere (a file load, a collab apply) it only uses faces
 *    already in MEMFS, and the shell fetches the faces a document names before it opens it.
 *
 * Fonts are listed and matched by the family name inside the font file, not by file name,
 * with the same bold/italic rules as the native implementation.
 *
 * A name that matches none of these gets the bundled fallback font (Noto Sans, fonts/README.md)
 * as a substitute, as native fontconfig always substitutes an installed font. KiCad keeps the
 * asked-for name on a substitute, so the text keeps its font name in the model, in collab and
 * on save; with no answer it would fall back to the stroke font and save "KiCad Font".
 */

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <sys/stat.h>
#include <unistd.h>
#include <set>
#include <string>
#include <vector>

#include <ft2build.h>
#include FT_FREETYPE_H

#include <nlohmann/json.hpp>
#include <wx/arrstr.h>
#include <wx/dir.h>
#include <wx/filename.h>

#include <font/fontconfig.h>
#include <font/outline_font.h>
#include <reporter.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/threading.h>
#endif

using namespace fontconfig;

// The fallback font's bytes (fallback_font.cmake).
extern "C" const unsigned char pcbjam_fallback_font[];
extern "C" const size_t        pcbjam_fallback_font_size;

static FONTCONFIG* g_config = nullptr;
static std::mutex  g_fontConfigMutex;

REPORTER* FONTCONFIG::s_reporter = nullptr;


#ifdef __EMSCRIPTEN__
// Scheduler token waits (wxwidgets/src/wasm/evtloop.cpp). Weak: the headless CLIs link no wx
// event loop and never park.
extern "C" int wxWasmBeginWait( const char* aKind ) __attribute__( ( weak ) );
extern "C" int wxWasmYieldUntil( int aToken ) __attribute__( ( weak ) );

// clang-format off
// Whether the running wasm entry may park now (jspi-scheduler.js canPark): inside a wx event
// entry or a KiCad coroutine, not in a plain export such as a collab apply or while a file
// load is in flight.
EM_JS( int, pcbjam_font_may_park, (), {
    const S = globalThis.__wxScheduler;
    return S && typeof S.canPark === "function" && S.canPark() ? 1 : 0;
} );

// Fetch one installed face through the shell's provider and write it to aPath, then resolve
// the wait with 1 (written) or 0.
EM_JS( void, pcbjam_local_font_load_start, ( int aToken, const char* aId, const char* aPath ), {
    const id = UTF8ToString( aId );
    const path = UTF8ToString( aPath );
    const provider = globalThis.__pcbjamLocalFonts;
    let bytes;
    try {
        bytes = Promise.resolve( provider ? provider.load( id ) : null );
    } catch( e ) {
        bytes = Promise.resolve( null );
    }
    const finish = ( data ) => {
        globalThis.__wxScheduler.runWaitCompletion( "local font " + id, aToken, () => {
            if( !data || !data.length )
                return 0;
            FS.mkdirTree( path.substring( 0, path.lastIndexOf( "/" ) ) );
            FS.writeFile( path, data );
            return 1;
        }, 0 );
    };
    bytes.then( finish ).catch( ( e ) => {
        console.warn( "[fonts] loading installed font " + id + " failed: " + e );
        finish( null );
    } );
} );
// clang-format on
#endif


namespace
{

struct FACE
{
    wxString    family;
    wxString    style;
    wxString    file;          // font file in MEMFS
    int         index = 0;     // face index inside a collection (.ttc)
    bool        bold = false;
    bool        italic = false;
    bool        local = false; // an installed font; its file exists once fetched
    std::string localId;       // the browser's key for it (postscript name)
};


const char* const UPLOAD_DIR = "/tmp/uploads";
// /tmp: MEMFS in the browser; kicad_tools runs on node with the host's filesystem (NODERAWFS).
const char* const FALLBACK_DIR = "/tmp/pcbjam-fonts";
const char* const FALLBACK_FILE = "/tmp/pcbjam-fonts/NotoSans-Regular.ttf";
const char* const FALLBACK_FAMILY = "Noto Sans";

std::mutex               g_registryMutex;
FT_Library               g_freeType = nullptr;
std::vector<FACE>        g_embedded;      // every embedded face seen this session
std::set<wxString>       g_embeddedFiles; // embedded files already read
std::vector<FACE>        g_uploaded;      // fonts in UPLOAD_DIR
std::set<wxString>       g_uploadedFiles; // uploaded files already read
std::vector<FACE>        g_local;         // installed fonts, as the shell last reported them


/// The native implementation's style keywords (common/font/fontconfig.cpp FindFont).
void classifyStyle( const wxString& aStyle, bool& aBold, bool& aItalic )
{
    wxString s = aStyle.Lower();

    aBold = !( s.Contains( wxS( "thin" ) ) || s.Contains( wxS( "light" ) )
               || s.Contains( wxS( "regular" ) ) || s.Contains( wxS( "roman" ) )
               || s.Contains( wxS( "book" ) ) || s.Contains( wxS( "medium" ) )
               || s.Contains( wxS( "semibold" ) ) || s.Contains( wxS( "demibold" ) ) )
            && ( s.Contains( wxS( "bold" ) ) || s.Contains( wxS( "heavy" ) )
                 || s.Contains( wxS( "black" ) ) || s.Contains( wxS( "thick" ) )
                 || s.Contains( wxS( "dark" ) ) );

    aItalic = s.Contains( wxS( "italic" ) ) || s.Contains( wxS( "oblique" ) )
              || s.Contains( wxS( "slant" ) );
}


bool freeType()
{
    return g_freeType || FT_Init_FreeType( &g_freeType ) == 0;
}


/// Read every face of a font file into aFaces, once per file (caller holds the lock).
void registerFontFile( const wxString& aFile, std::set<wxString>& aSeen,
                       std::vector<FACE>& aFaces )
{
    if( aSeen.count( aFile ) || !freeType() )
        return;

    FT_Face face = nullptr;

    if( FT_New_Face( g_freeType, aFile.utf8_str(), -1, &face ) != 0 )
        return;

    aSeen.insert( aFile );

    const long count = face->num_faces;
    FT_Done_Face( face );

    for( long i = 0; i < count; ++i )
    {
        if( FT_New_Face( g_freeType, aFile.utf8_str(), i, &face ) != 0 )
            continue;

        if( face->family_name )
        {
            FACE f;
            f.family = wxString::FromUTF8( face->family_name );
            f.style = face->style_name ? wxString::FromUTF8( face->style_name ) : wxString();
            f.file = aFile;
            f.index = (int) i;
            classifyStyle( f.style, f.bold, f.italic );
            aFaces.push_back( f );
        }

        FT_Done_Face( face );
    }
}


void registerEmbeddedFiles( const std::vector<wxString>* aFiles )
{
#ifdef __EMSCRIPTEN__
    // MEMFS reads belong on the main thread (the font-list poll runs on a worker).
    if( !emscripten_is_main_runtime_thread() )
        return;
#endif

    if( !aFiles )
        return;

    std::lock_guard lock( g_registryMutex );

    for( const wxString& file : *aFiles )
        registerFontFile( file, g_embeddedFiles, g_embedded );
}


/// Register the font files of one folder (caller holds the lock).
void scanFontFolder( const wxString& aDir, int aFlags )
{
    if( !wxDir::Exists( aDir ) )
        return;

    wxArrayString files;
    wxDir::GetAllFiles( aDir, &files, wxEmptyString, aFlags );

    for( const wxString& file : files )
    {
        const wxString ext = wxFileName( file ).GetExt().Lower();

        if( ext == wxS( "ttf" ) || ext == wxS( "otf" ) || ext == wxS( "ttc" )
            || ext == wxS( "otc" ) || ext == wxS( "woff" ) )
        {
            registerFontFile( file, g_uploadedFiles, g_uploaded );
        }
    }
}


/// Pick up font files uploaded since the last call, and those of PCBJAM_FONT_DIRS (main
/// thread: MEMFS reads).
void scanUploads()
{
#ifdef __EMSCRIPTEN__
    if( !emscripten_is_main_runtime_thread() )
        return;
#endif

    std::lock_guard lock( g_registryMutex );

    scanFontFolder( UPLOAD_DIR, wxDIR_FILES );

    if( const char* dirs = getenv( "PCBJAM_FONT_DIRS" ) )
    {
        for( const wxString& dir : wxSplit( wxString::FromUTF8( dirs ), ':', '\0' ) )
        {
            if( !dir.IsEmpty() )
                scanFontFolder( dir, wxDIR_FILES | wxDIR_DIRS );
        }
    }
}


/// The face index of an installed font's postscript name inside a fetched collection; 0 for
/// a single-face file.
int localFaceIndex( const FACE& aFace )
{
    std::lock_guard lock( g_registryMutex );
    FT_Face         face = nullptr;

    if( !freeType() || FT_New_Face( g_freeType, aFace.file.utf8_str(), -1, &face ) != 0 )
        return 0;

    const long count = face->num_faces;
    FT_Done_Face( face );

    for( long i = 0; count > 1 && i < count; ++i )
    {
        if( FT_New_Face( g_freeType, aFace.file.utf8_str(), i, &face ) != 0 )
            continue;

        const char* ps = FT_Get_Postscript_Name( face );
        const bool  match = ps && aFace.localId == ps;
        FT_Done_Face( face );

        if( match )
            return (int) i;
    }

    return 0;
}


/// Make an installed face's file available in MEMFS, fetching it if needed. Parks while
/// the browser reads the font, so only on the main thread and where parking is allowed.
bool ensureLocal( FACE& aFace )
{
#ifdef __EMSCRIPTEN__
    if( !wxFileName::FileExists( aFace.file ) )
    {
        if( !emscripten_is_main_runtime_thread() || !wxWasmBeginWait || !wxWasmYieldUntil
            || !pcbjam_font_may_park() )
        {
            return false;
        }

        const int token = wxWasmBeginWait( "local-font" );

        if( token <= 0 )
            return false;

        pcbjam_local_font_load_start( token, aFace.localId.c_str(), aFace.file.utf8_str() );

        if( !wxWasmYieldUntil( token ) )
            return false;
    }

    aFace.index = localFaceIndex( aFace );
    return true;
#else
    return wxFileName::FileExists( aFace.file );
#endif
}


/// Mark a TrueType font "preview and print" in its OS/2 fsType. KiCad embeds only installable
/// or editable fonts (SCHEMATIC::GetFonts, BOARD::GetFonts, the footprint and symbol writers),
/// so the fallback is never embedded into a document: it stands in for a missing font, it is
/// not the font the document asked for. The PDF plotter draws such text as outlines.
void markPreviewAndPrint( std::vector<unsigned char>& aFont )
{
    auto u16 = [&]( size_t at ) { return ( aFont[at] << 8 ) | aFont[at + 1]; };
    auto u32 = [&]( size_t at ) { return ( (size_t) u16( at ) << 16 ) | u16( at + 2 ); };

    if( aFont.size() < 12 )
        return;

    const size_t tables = u16( 4 );

    for( size_t i = 0; i < tables && 12 + 16 * i + 16 <= aFont.size(); ++i )
    {
        const size_t record = 12 + 16 * i;

        if( std::equal( aFont.begin() + record, aFont.begin() + record + 4, "OS/2" ) )
        {
            const size_t fsType = u32( record + 8 ) + 8;

            if( fsType + 2 <= aFont.size() )
            {
                aFont[fsType] = 0x00;
                aFont[fsType + 1] = 0x04; // FT_FSTYPE_PREVIEW_AND_PRINT_EMBEDDING
            }

            return;
        }
    }
}


/// Write the fallback font to MEMFS once (main thread: MEMFS writes); true once it is there.
/// Plain POSIX: it first runs from a static constructor, before wx is up.
bool ensureFallback()
{
    static std::atomic<bool> written = false;

    if( written )
        return true;

#ifdef __EMSCRIPTEN__
    if( !emscripten_is_main_runtime_thread() )
        return false;
#endif

    std::vector<unsigned char> font( pcbjam_fallback_font,
                                     pcbjam_fallback_font + pcbjam_fallback_font_size );
    markPreviewAndPrint( font );

    mkdir( FALLBACK_DIR, 0755 ); // EEXIST is fine

    // On node several kicad_tools processes may write it at once: each writes a private copy
    // and renames it into place, so a reader never sees a partial file.
    const std::string tmp = std::string( FALLBACK_FILE ) + "." + std::to_string( getpid() );
    FILE*             out = fopen( tmp.c_str(), "wb" );

    if( !out )
        return false;

    const bool complete = fwrite( font.data(), 1, font.size(), out ) == font.size();
    fclose( out );
    written = complete && rename( tmp.c_str(), FALLBACK_FILE ) == 0;

    if( !written )
        remove( tmp.c_str() );

    return written;
}


// At startup: static constructors run once, on the main thread, after the filesystem is up.
// Later, the first lookup of a font may come from a worker thread (a schematic load does that),
// which cannot write the file, and KiCad keeps what that lookup returned for the session
// (FONT::GetFont).
[[maybe_unused]] const bool g_fallbackAtStartup = ensureFallback();


/// Rank a face against the wanted style: 0 is exact; bold mismatches weigh more than italic.
int styleDistance( const FACE& aFace, bool aBold, bool aItalic )
{
    return ( aFace.bold != aBold ? 2 : 0 ) + ( aFace.italic != aItalic ? 1 : 0 );
}

} // namespace


extern "C" void pcbjam_local_fonts_set( const char* aJson )
{
    nlohmann::json list = nlohmann::json::parse( aJson ? aJson : "[]", nullptr, false );

    if( !list.is_array() )
        return;

    std::vector<FACE> faces;

    for( const nlohmann::json& entry : list )
    {
        if( !entry.is_object() || !entry.contains( "family" ) || !entry.contains( "id" )
            || !entry.contains( "path" ) )
        {
            continue;
        }

        FACE f;
        f.family = wxString::FromUTF8( entry.value( "family", "" ) );
        f.style = wxString::FromUTF8( entry.value( "style", "" ) );
        f.file = wxString::FromUTF8( entry.value( "path", "" ) );
        f.localId = entry.value( "id", "" );
        f.local = true;
        classifyStyle( f.style, f.bold, f.italic );

        if( !f.family.IsEmpty() && !f.localId.empty() && !f.file.IsEmpty() )
            faces.push_back( f );
    }

    std::lock_guard lock( g_registryMutex );
    g_local = std::move( faces );
}


// For the live embedded-fonts sync (wasm/bindings/embedded_sync.h), which builds without
// FreeType's headers: the same test as SCHEMATIC::GetFonts and BOARD::GetFonts.
wxString pcbjamEmbeddableFontFile( const KIFONT::FONT* aFont )
{
    if( !aFont || aFont->IsStroke() )
        return wxEmptyString;

    using PERMISSION = KIFONT::OUTLINE_FONT::EMBEDDING_PERMISSION;
    const auto*      outline = static_cast<const KIFONT::OUTLINE_FONT*>( aFont );
    const PERMISSION permission = outline->GetEmbeddingPermission();

    if( permission != PERMISSION::EDITABLE && permission != PERMISSION::INSTALLABLE )
        return wxEmptyString;

    return outline->GetFileName();
}


wxString FONTCONFIG::Version()
{
    return wxS( "WASM (no fontconfig)" );
}


FONTCONFIG::FONTCONFIG()
{
}


void fontconfig::FONTCONFIG::SetReporter( REPORTER* aReporter )
{
    std::lock_guard lock( g_fontConfigMutex );
    s_reporter = aReporter;
}


REPORTER* fontconfig::FONTCONFIG::GetReporter()
{
    std::lock_guard lock( g_fontConfigMutex );
    return s_reporter;
}


FONTCONFIG* Fontconfig()
{
    if( !g_config )
        g_config = new FONTCONFIG();

    return g_config;
}


FONTCONFIG::FF_RESULT FONTCONFIG::FindFont( const wxString& aFontName, wxString& aFontFile,
                                            int& aFaceIndex, bool aBold, bool aItalic,
                                            const std::vector<wxString>* aEmbeddedFiles )
{
    registerEmbeddedFiles( aEmbeddedFiles );
    scanUploads();

    // A qualified name ("Times:Bold:Italic") carries its style after the family.
    wxString family = aFontName.BeforeFirst( ':' );
    wxString lower = aFontName.Lower();

    // Native parity: a name that says bold is bold, whatever was asked for.
    if( lower.Contains( wxS( "bold" ) ) || lower.Contains( wxS( "heavy" ) )
        || lower.Contains( wxS( "black" ) ) || lower.Contains( wxS( "thick" ) )
        || lower.Contains( wxS( "dark" ) ) )
    {
        aBold = true;
    }

    if( lower.AfterFirst( ':' ).Contains( wxS( "italic" ) ) )
        aItalic = true;

    // Candidates: this document's embedded faces, then every other embedded face, then the
    // uploaded fonts, then the installed fonts. Copies, so a fetch below can park without
    // holding the lock.
    std::vector<FACE> candidates;

    {
        std::lock_guard lock( g_registryMutex );
        std::set<wxString> own;

        if( aEmbeddedFiles )
            own.insert( aEmbeddedFiles->begin(), aEmbeddedFiles->end() );

        for( int pass = 0; pass < 4; ++pass )
        {
            const std::vector<FACE>& faces = pass < 2    ? g_embedded
                                             : pass == 2 ? g_uploaded
                                                         : g_local;

            for( const FACE& f : faces )
            {
                if( f.family.CmpNoCase( family ) != 0 )
                    continue;

                if( pass == 0 && !own.count( f.file ) )
                    continue;

                if( pass == 1 && own.count( f.file ) )
                    continue;

                candidates.push_back( f );
            }
        }
    }

    // Best style first; the source order above breaks ties.
    std::stable_sort( candidates.begin(), candidates.end(),
                      [&]( const FACE& a, const FACE& b )
                      {
                          return styleDistance( a, aBold, aItalic )
                                 < styleDistance( b, aBold, aItalic );
                      } );

    for( FACE& face : candidates )
    {
        if( face.local && !ensureLocal( face ) )
            continue;

        aFontFile = face.file;
        aFaceIndex = face.index;

        if( aBold && !face.bold && aItalic && !face.italic )
            return FF_RESULT::FF_MISSING_BOLD_ITAL;
        else if( aBold && !face.bold )
            return FF_RESULT::FF_MISSING_BOLD;
        else if( aItalic && !face.italic )
            return FF_RESULT::FF_MISSING_ITAL;
        else if( face.bold != aBold || face.italic != aItalic )
            return FF_RESULT::FF_SUBSTITUTE;

        return FF_RESULT::FF_OK;
    }

    // Not embedded and not installed (or not fetchable here): the fallback font stands in.
    // It has a regular face only, so bold and italic are faked like a missing style.
    if( ensureFallback() )
    {
        aFontFile = wxString::FromUTF8( FALLBACK_FILE );
        aFaceIndex = 0;

        if( aBold && aItalic )
            return FF_RESULT::FF_MISSING_BOLD_ITAL;
        else if( aBold )
            return FF_RESULT::FF_MISSING_BOLD;
        else if( aItalic )
            return FF_RESULT::FF_MISSING_ITAL;
        else if( family.CmpNoCase( FALLBACK_FAMILY ) != 0 )
            return FF_RESULT::FF_SUBSTITUTE;

        return FF_RESULT::FF_OK;
    }

    // Without it (a worker thread before the main thread wrote it), the caller falls back to
    // the KiCad stroke font.
    aFontFile = wxEmptyString;
    aFaceIndex = 0;
    return FF_RESULT::FF_ERROR;
}


void FONTCONFIG::ListFonts( std::vector<std::string>& aFonts, const std::string& aDesiredLang,
                            const std::vector<wxString>* aEmbeddedFiles, bool aForce )
{
    registerEmbeddedFiles( aEmbeddedFiles );
    scanUploads();

    std::set<wxString> families;

    {
        std::lock_guard lock( g_registryMutex );

        for( const FACE& f : g_embedded )
            families.insert( f.family );

        for( const FACE& f : g_uploaded )
            families.insert( f.family );

        for( const FACE& f : g_local )
            families.insert( f.family );
    }

    // FONT_CHOICE adds the KiCad stroke font itself.
    for( const wxString& family : families )
        aFonts.push_back( family.ToStdString( wxConvUTF8 ) );
}

