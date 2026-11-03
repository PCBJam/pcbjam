/*
 * Live embedded-fonts sync for the per-editor collab bindings (eeschema_embind.cpp,
 * pcbnew_embind.cpp). Header-only, like collab_common.h.
 *
 * KiCad embeds the fonts a document uses only when it saves with "Embed fonts" on
 * (SCHEMATIC::EmbedFonts, BOARD::EmbedFonts), and only a save carried (embedded_fonts …) and
 * (embedded_files …) into the room. In a room nobody has to save: the text's font name synced
 * at once, the font file never did, and a peer without that font could not draw it. So each
 * flush after an edit:
 *
 *  - with "Embed fonts" on, embeds every outline font a text uses that the document does not
 *    carry yet. Unlike the save, this also covers symbol fields and footprint texts (GAP-5 in
 *    docs/features/fonts/0001-embedded-fonts.md), and it skips a font that is the document's
 *    own embedded copy (the save adds that copy again under its cache name, GAP-1). It never
 *    embeds a font installed on this computer (Local Font Access): any peer can name a font,
 *    and this editor would then send its own copy to the room without the user doing
 *    anything, which also tells the peer what is installed here. Those embed on a save, as
 *    on desktop;
 *  - when the flag or the file set changed, hands both heads, as the file writer formats them,
 *    to JS (kicadCollab.onEmbedded), which merges them into the room per file.
 *
 * The other direction is not live: a peer's native document picks up fonts embedded by
 * others when it next opens the file. KiCad caches each font lookup for the session
 * (FONT::GetFont), so an open editor could not redraw with them anyway.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <set>
#include <string>
#include <emscripten.h>
#include <wx/filename.h>
#include <wx/string.h>
#include <eda_text.h>
#include <embedded_files.h>
#include <richio.h>

namespace KIFONT { class FONT; }

/// The file of an outline font whose license allows embedding, else "" (the stroke font, and
/// the wasm FONTCONFIG's fallback font, which is marked preview-and-print). In
/// wasm/stubs/fontconfig_wasm.cpp: the bindings build without FreeType's headers.
wxString pcbjamEmbeddableFontFile( const KIFONT::FONT* aFont );

namespace pcbjam_embedded {

/// Where the web shell writes installed fonts it fetched (web/standalone/src/wasm/local-fonts.ts
/// LOCAL_FONTS_DIR). Team library fonts go in sub-folders of it; those embed live.
constexpr const char* INSTALLED_FONTS_DIR = "/home/kicad/.local/share/fonts";

/// The font file a text could embed, into aFiles.
inline void collect( const EDA_TEXT* aText, std::set<wxString>& aFiles )
{
    const wxString file = aText ? pcbjamEmbeddableFontFile( aText->GetFont() ) : wxString();

    if( !file.IsEmpty() )
        aFiles.insert( file );
}


/// Embed the font files aFiles does not carry yet. True when a file was added.
inline bool embedFonts( EMBEDDED_FILES& aFiles, const std::set<wxString>& aFonts )
{
    bool added = false;

    for( const wxString& path : aFonts )
    {
        const wxFileName file( path );

        if( !file.IsOk() || file.GetFullName().IsEmpty() || aFiles.HasFile( file.GetFullName() ) )
            continue;

        if( file.GetPath() == wxString::FromUTF8( INSTALLED_FONTS_DIR ) )
            continue;

        // A font read from an embedded file is KiCad's extracted copy,
        // kicad_embedded_<data_hash>.<ext> (EMBEDDED_FILES::GetTemporaryFileName): skip it when
        // this document already carries that file under its own name.
        wxString hash;

        if( file.GetName().StartsWith( wxS( "kicad_embedded_" ), &hash ) )
        {
            bool carried = false;

            for( const auto& [name, entry] : aFiles.EmbeddedFileMap() )
                carried = carried || wxString::FromUTF8( entry->data_hash ) == hash;

            if( carried )
                continue;
        }

        if( EMBEDDED_FILES::EMBEDDED_FILE* entry = aFiles.AddFile( file, false ) )
        {
            entry->type = EMBEDDED_FILES::EMBEDDED_FILE::FILE_TYPE::FONT;
            added = true;
        }
    }

    return added;
}


/// What decides whether the heads changed: the flag, and each file by name and content hash.
inline std::string signature( bool aFontsEmbedded, const EMBEDDED_FILES& aFiles )
{
    std::string out = aFontsEmbedded ? "yes" : "no";

    for( const auto& [name, entry] : aFiles.EmbeddedFileMap() )
        out += "\n" + std::string( name.utf8_str() ) + "\t" + entry->data_hash;

    return out;
}


/// A document holding just (embedded_fonts …) and (embedded_files …), written like the file
/// writers do. aHeads goes before them (eeschema marks the root view with it).
inline std::string text( const char* aRoot, int aVersion, const char* aGenerator,
                         const char* aHeads, bool aFontsEmbedded, const EMBEDDED_FILES& aFiles )
{
    STRING_FORMATTER fmt;
    fmt.Print( "(%s (version %d) (generator \"%s\")%s", aRoot, aVersion, aGenerator, aHeads );
    fmt.Print( "(embedded_fonts %s)", aFontsEmbedded ? "yes" : "no" );

    if( !aFiles.IsEmpty() )
        aFiles.WriteEmbeddedFiles( fmt, true );

    fmt.Print( ")" );
    return fmt.GetString();
}


/// Hand the heads of the document saved at aPath to JS.
inline void emit( const std::string& aPath, const std::string& aText )
{
    EM_ASM( {
        if( window.kicadCollab && window.kicadCollab.onEmbedded )
        {
            // A throwing listener must never unwind the wasm frame that called it (P-1).
            try { window.kicadCollab.onEmbedded( UTF8ToString( $0 ), UTF8ToString( $1 ) ); }
            catch( e ) { console.error( '[pcbjam collab] onEmbedded listener threw', e ); }
        }
    }, aPath.c_str(), aText.c_str() );
}

} // namespace pcbjam_embedded

#endif // __EMSCRIPTEN__
