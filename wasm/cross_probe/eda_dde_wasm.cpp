/*
 * Cross-probe transport for the KiCad WASM build (replaces common/eda_dde.cpp).
 *
 * Standalone KiCad sends cross-probe commands ("$SELECT: …", "$NET: …",
 * "$CLEAR") to the other editor over a localhost TCP socket (4242 = PCB,
 * 4243 = schematic). Under emscripten that connect() became
 * `new WebSocket("ws://localhost:4242")`, failing on every selection. Here the
 * command goes to the web shell instead, which delivers it to the user's other
 * editor tab over a BroadcastChannel (docs/features/cross-probe/0001 in the
 * private repo); the receiving tab runs it through ExecuteRemoteCommand.
 */

#include <eda_dde.h>

#include <emscripten.h>

static bool s_explicit = false;

/**
 * Set around KiCad's explicit "Select on PCB" / "Select on Schematic" actions
 * (the socket protocol drops their force flag): only an explicit probe may
 * open the other editor's tab.
 */
void PcbjamCrossProbeExplicit( bool aExplicit )
{
    s_explicit = aExplicit;
}


bool SendCommand( int aService, const std::string& aMessage )
{
    const char* tool = aService == KICAD_PCB_PORT_SERVICE_NUMBER   ? "pcbnew"
                       : aService == KICAD_SCH_PORT_SERVICE_NUMBER ? "eeschema"
                                                                   : nullptr;

    if( !tool )
        return false;

    // A JS throw must not escape into the C++ caller (staging-push-ci-fix-0828).
    return EM_ASM_INT(
            {
                try
                {
                    const send = globalThis.kicadCrossProbeSend;

                    if( typeof send !== "function" )
                        return 0;

                    return send( UTF8ToString( $0 ), UTF8ToString( $1 ), !!$2 ) ? 1 : 0;
                }
                catch( e )
                {
                    console.error( "[cross-probe] send failed", e );
                    return 0;
                }
            },
            tool, aMessage.c_str(), s_explicit ? 1 : 0 )
           != 0;
}


void SocketCleanup()
{
}
