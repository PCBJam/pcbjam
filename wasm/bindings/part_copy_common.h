/*
 * libs 0031: shared C++ helpers for the read-only part flow (copy a part into
 * a team library instead of editing a library the user can't write). The
 * symbol side lives in part_copy_symbol.h (eeschema's TU), the footprint side
 * in part_copy_footprint.h (pcbnew's TU); each has its own EM_JS bridge calls
 * into `globalThis.pcbjamPartCopy` (web/standalone/src/libs/part-copy.ts),
 * since an EM_JS defined in a header both TUs include would clash in the
 * merged kicad_editor image. This header holds only inline C++.
 *
 * The bridge answers in JSON, written into a malloc'd C string by the JS side
 * (the libs plugins' allocator); takeJson frees it.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>
#include <wx/string.h>

// The wx wasm port's wait registry (evtloop.cpp), as the libs plugins use it.
extern "C" int wxWasmBeginWait( const char* aKind ) __attribute__(( weak ));
extern "C" int wxWasmYieldUntil( int aToken ) __attribute__(( weak ));

namespace pcbjam_part_copy {

/** Take a JSON answer the bridge malloc'd (0 = none); nullopt when absent or unreadable. */
inline std::optional<nlohmann::json> takeJson( int aPtr )
{
    if( !aPtr )
        return std::nullopt;

    char*          text = (char*) (uintptr_t) (uint32_t) aPtr;
    nlohmann::json out = nlohmann::json::parse( text, nullptr, false );
    free( text );

    if( out.is_discarded() )
        return std::nullopt;

    return out;
}

/**
 * Wait for an asynchronous bridge answer: aStart( token ) starts the JS call,
 * which resolves the token with its answer. The page stays live meanwhile (the
 * wait parks the scheduler context, as the libs plugins' requests do).
 */
template <typename START>
std::optional<nlohmann::json> awaitJson( START aStart )
{
    if( !wxWasmBeginWait || !wxWasmYieldUntil )
        return std::nullopt;

    const int token = wxWasmBeginWait( "part-copy" );

    if( token <= 0 )
        return std::nullopt;

    aStart( token );
    return takeJson( wxWasmYieldUntil( token ) );
}

inline std::string utf8( const wxString& aText )
{
    return std::string( aText.utf8_str() );
}

inline wxString str( const nlohmann::json& aObj, const char* aKey )
{
    auto it = aObj.find( aKey );
    return it != aObj.end() && it->is_string() ? wxString::FromUTF8( it->get<std::string>() )
                                               : wxString();
}

} // namespace pcbjam_part_copy

#endif // __EMSCRIPTEN__
