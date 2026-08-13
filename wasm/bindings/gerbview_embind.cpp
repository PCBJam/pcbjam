/*
 * GerbView embind bindings.
 *
 * GerbView boots without a document (it is one of `FILELESS_TOOLS`), but a
 * project route CAN name a gerber: clicking `Production/gerbers/board-F_Cu.gbr`
 * on the project page deep-links here. Until this TU existed the bundle had no
 * embind surface at all, so the shell staged the file into MEMFS and then had
 * no way to say "open it" — GerbView came up empty and the user had to walk
 * File→Open themselves.
 *
 * A gerber is rarely useful alone (a fabrication set is a stack of layers plus
 * drill files), and `GERBVIEW_FRAME::OpenProjectFiles` already takes a LIST and
 * auto-routes each entry by filename to the gerber / Excellon / job / archive
 * loader, then zoom-fits. So the primary entry point here is the multi-file
 * one: the shell hands over every gerber+drill sibling in the clicked file's
 * folder, and the whole board renders.
 */
#include <emscripten.h>
#include <emscripten/bind.h>
#include <gerbview_frame.h>
#include <kiway_player.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
#include <wx/app.h>
#include <wx/string.h>
#include "open_gate.h"
#include "owned_open.h"
#include "main_stack_runner.h"

using namespace emscripten;
using json = nlohmann::json;

static GERBVIEW_FRAME* gerbFrame()
{
    return wxTheApp ? dynamic_cast<GERBVIEW_FRAME*>( wxTheApp->GetTopWindow() ) : nullptr;
}

static bool openFileSet( const std::vector<wxString>& aFiles )
{
    // Held across every Asyncify park of the load (open_gate.h): the layer load
    // parks, and a wx timer dispatched into a half-built layer set traps.
    pcbjam_open::BusyGuard busy;

    GERBVIEW_FRAME* frame = gerbFrame();

    if( !frame || aFiles.empty() )
        return false;

    return frame->OpenProjectFiles( aFiles, 0 );
}

/** Open ONE gerber/drill file (the generic single-file entry every app has). */
static bool kicadOpenFile( std::string path )
{
    return openFileSet( { wxString::FromUTF8( path.c_str() ) } );
}

/**
 * Open a whole fabrication set: a JSON array of MEMFS paths. Order is the
 * caller's (the shell sorts, so layer order is stable across reloads).
 * GERBVIEW_FRAME caps the set at GERBER_DRAWLAYERS_COUNT internally.
 */
static bool kicadOpenFiles( std::string pathsJson )
{
    json paths = json::parse( pathsJson, nullptr, /*allow_exceptions*/ false );

    if( !paths.is_array() )
        return false;

    std::vector<wxString> files;

    for( const auto& entry : paths )
    {
        if( entry.is_string() )
            files.push_back( wxString::FromUTF8( entry.get<std::string>().c_str() ) );
    }

    return openFileSet( files );
}

static bool kicadOpenFileStart( int token, std::string path )
{
    return pcbjam_open::startOwnedOpen(
            token, [path = std::move( path )]() { return kicadOpenFile( path ); } );
}

static bool kicadOpenFilesStart( int token, std::string pathsJson )
{
    return pcbjam_open::startOwnedOpen(
            token,
            [pathsJson = std::move( pathsJson )]() {
                return kicadOpenFiles( pathsJson );
            } );
}

/** JS-pollable open-in-flight probe — same contract as the editors. */
static bool kicadOpenFileBusy()
{
    return pcbjam_open::busy();
}

EMSCRIPTEN_BINDINGS( gerbview )
{
    function( "kicadOpenFile", &kicadOpenFile );
    function( "kicadOpenFileStart", &kicadOpenFileStart );
    function( "kicadOpenFiles", &kicadOpenFiles );
    function( "kicadOpenFilesStart", &kicadOpenFilesStart );
    function( "kicadOpenFileBusy", &kicadOpenFileBusy );
}
