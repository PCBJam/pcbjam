/*
 * WASM implementation of kiplatform/io.h
 * Provides file I/O functions for WASM virtual filesystem
 */

#include <kiplatform/io.h>
#include <wx/string.h>
#include <wx/filename.h>
#include <wx/dir.h>
#include <stdio.h>
#include <sys/stat.h>

namespace KIPLATFORM
{
namespace IO
{

FILE* SeqFOpen( const wxString& aPath, const wxString& mode )
{
    // WASM doesn't have special sequential read hints
    // Just use standard fopen
    return fopen( aPath.utf8_str(), mode.utf8_str() );
}

bool DuplicatePermissions( const wxString& aSrc, const wxString& aDest )
{
    // WASM virtual filesystem doesn't have detailed permissions
    return true;
}

bool MakeWriteable( const wxString& aFilePath )
{
    // All files in WASM virtual filesystem are writeable
    return true;
}

bool IsFileHidden( const wxString& aFileName )
{
    // Check for Unix-style hidden files (starting with .)
    wxFileName fn( aFileName );
    wxString name = fn.GetFullName();
    return !name.IsEmpty() && name[0] == '.';
}

TARGET_ATTRS CaptureTargetAttributes( const wxString& aPath )
{
    // No attributes beyond mode bits, and DuplicatePermissions covers those
    return TARGET_ATTRS{};
}

bool ApplyTargetAttributes( const wxString& aPath, const TARGET_ATTRS& aAttrs )
{
    return true;
}

bool FlushToDisk( FILE* aFp )
{
    if( !aFp )
        return false;

    // fflush only. The in-memory filesystem has nothing to commit, and emscripten
    // implements fsync as an async import under JSPI: it would suspend every save, and
    // throw a SuspendError when the save didn't start from a JSPI export.
    return fflush( aFp ) == 0;
}

void LongPathAdjustment( wxFileName& aFilename )
{
    // No-op on non-Windows platforms
}

long long TimestampDir( const wxString& aDirPath, const wxString& aFilespec )
{
    // Mirror the native implementations: accumulate (mtime, size) over files
    // matching the spec so callers can detect library-directory changes. The
    // Emscripten virtual filesystem supports stat(), so this works for MEMFS-
    // backed local libraries (git/network libraries are handled JS-side).
    long long timestamp = 0;

    wxDir dir( aDirPath );

    if( !dir.IsOpened() )
        return timestamp;

    wxString filename;
    bool     cont = dir.GetFirst( &filename, aFilespec, wxDIR_FILES );

    while( cont )
    {
        wxString    fullPath = aDirPath + wxFILE_SEP_PATH + filename;
        struct stat entryStat;

        if( stat( fullPath.fn_str(), &entryStat ) == 0 )
        {
            timestamp += static_cast<long long>( entryStat.st_mtime ) * 1000;
            timestamp += entryStat.st_size;
        }

        cont = dir.GetNext( &filename );
    }

    return timestamp;
}

} // namespace IO
} // namespace KIPLATFORM
