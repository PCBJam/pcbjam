/*
 * kicad_tools — merged headless KiCad CLI, built as ONE WebAssembly module
 * linking both dieted kifaces (pcbjam-mcp 0001 tier 3a).
 *
 * Thin dispatcher over the two per-app entry points (compiled into this image
 * with KICAD_TOOLS_COMBINED, which strips their standalone main()s):
 *
 *   pcbnew side   (pcb_convert_main.cpp):
 *     kicad_tools --drc [--json] [--strict] <file.kicad_pcb> [<out>]
 *     kicad_tools --gerbers <file.kicad_pcb> [<outdir>]
 *     kicad_tools --drill <file.kicad_pcb> [<outdir>]
 *     kicad_tools --plot-board [--pdf] [--layers <a,b,...>] <file.kicad_pcb> [<out>]
 *     kicad_tools --ipc356 <file.kicad_pcb> [<out.ipc>]
 *     kicad_tools --fab-components <file.kicad_pcb> [<out.json>]
 *
 *   eeschema side (sym_convert_main.cpp) — everything else:
 *     kicad_tools --convert-lib <input.lib> <output.kicad_sym>
 *     kicad_tools --lint [--strict] <file> [<file>...]
 *                       (.kicad_pcb/.kicad_mod get a FULL parse here — the
 *                       pcbnew parser is linked; the lint driver calls back
 *                       into pcbToolsLintBoard/pcbToolsLintFootprint)
 *     kicad_tools --resave <file> <outdir>
 *                       (full parse + rewrite in the current file-format
 *                       version — kicad-validity 0001; .kicad_pcb via the
 *                       pcbToolsResaveBoard callback, .kicad_sch one file per
 *                       sheet, .kicad_sym/.lib via ConvertLibrary. Exit 4 =
 *                       input invalid, 5 = write failed)
 *     kicad_tools --erc [--json] [--strict] <file.kicad_sch> [<out>]
 *     kicad_tools --netlist [--xml] <file.kicad_sch> [<out>]
 *     kicad_tools --bom <file.kicad_sch> [<out>]
 *     kicad_tools --plot [--pdf] <file.kicad_sch> [<out>]
 *
 * Each side brings up its own minimal PGM runtime on first use; dispatch is
 * exclusive per process, so the two runtimes never coexist.
 */

#include <cstdio>
#include <cstring>
#include <unistd.h>

int symConvertMain( int argc, char** argv );
int pcbConvertMain( int argc, char** argv );


int main( int argc, char** argv )
{
    int rc;

    if( argc >= 2
        && ( std::strcmp( argv[1], "--drc" ) == 0 || std::strcmp( argv[1], "--gerbers" ) == 0
             || std::strcmp( argv[1], "--drill" ) == 0
             || std::strcmp( argv[1], "--plot-board" ) == 0
             || std::strcmp( argv[1], "--ipc356" ) == 0
             || std::strcmp( argv[1], "--fab-components" ) == 0 ) )
    {
        rc = pcbConvertMain( argc, argv );
    }
    else
    {
        rc = symConvertMain( argc, argv );
    }

    // Skip the EXIT_RUNTIME static-dtor pass (same rationale as
    // pcb_convert_main.cpp, which already does this on its --drc path): with
    // the pcbnew kiface in the image, some dieted-out teardown is reachable
    // through vtable slots from static dtors and traps ("table index is out
    // of bounds") AFTER the subcommand finished, clobbering the exit code.
    std::fflush( nullptr );
    _exit( rc );
}
