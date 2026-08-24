/*
 * sym_convert — standalone KiCad file CLI, built as a WebAssembly module.
 *
 * Two modes, one binary (ysync 0009 §7 — the lint tier rides the dieted
 * converter instead of shipping a second wasm):
 *
 *   convert:  --convert-lib <input.lib> <output.kicad_sym>
 *             legacy (.lib) -> S-expression (.kicad_sym) symbol-library
 *             conversion via SCH_IO_MGR::ConvertLibrary. Paths are absolutized
 *             here (the legacy plugin writes an empty lib on relative paths
 *             while exiting 0).
 *
 *   erc:      sym_convert --erc [--json] [--strict] <file.kicad_sch> [<out>]
 *             Headless ERC (pcbjam-mcp 0001 tier 3a). Loads the schematic with
 *             the EESCHEMA_HELPERS::LoadSchematic post-load tail — minus the
 *             SCH_COMMIT / TOOL_MANAGER / Kiface() cleanup chain this diet tree
 *             doesn't link — builds the connection graph, and runs ERC_TESTER
 *             the way kicad-cli's JobSchErc does (no edit frame, no cvpcb).
 *             Tests needing machinery absent headless are force-ignored:
 *             lib-symbol issues + footprint filters (null LIBRARY_MANAGER),
 *             footprint links (no cvpcb kiface), sim models (sim/ TUs pruned).
 *             Writes a kicad-cli-compatible report (text, or JSON with --json)
 *             to <out> (default: <file>-erc.rpt/.json next to the input).
 *             Exit: 0 clean, 1 ERC errors (--strict: also warnings), 2 usage,
 *             4 load/run failure.
 *
 *   netlist:  sym_convert --netlist [--xml] <file.kicad_sch> [<out>]
 *   bom:      sym_convert --bom <file.kicad_sch> [<out>]
 *             KiCad s-expr netlist (default), XML netlist (--xml), or XML BOM
 *             (GNL_OPT_BOM, kicad-cli's python-bom) — mirrors JobExportNetlist /
 *             JobExportPythonBom on the same headless loader as --erc. SPICE
 *             and the legacy vendor formats are not linked (sim/ pruned; the
 *             vendor emitters can be re-admitted in CMake on demand).
 *
 *   plot:     sym_convert --plot [--pdf] <file.kicad_sch> [<out>]
 *             SVG (one file per sheet, into <out> dir, default = input's dir)
 *             or a single multi-page PDF. SCH_PLOTTER + common plotter
 *             backends — no GAL/GL context; stroke-font text.
 *
 *   lint:     sym_convert --lint [--strict] <file> [<file>...]
 *             "OK" = KiCad will load it (not necessarily load it UNCHANGED —
 *             KiCad normalizes while parsing). Per extension:
 *               .kicad_sch          full parse (SCH_IO_KICAD_SEXPR)
 *               .kicad_sym / .lib   full library parse (EnumerateSymbolLib)
 *               .kicad_pcb          full parse (PCB_IO_MGR — merged
 *                                   kicad_tools image only)
 *               other s-expr files  structure-only (parens/strings/atoms)
 *             Every s-expr input additionally gets the uuid lints: duplicate
 *             (uuid) fields inside one node (KiCad keeps the last) and one
 *             uuid value on multiple nodes (eeschema silently Increment()s the
 *             second, pcbnew keeps both) — identity hazards for uuid-keyed
 *             sync. Warnings don't fail the run unless --strict.
 *             Exit: 0 ok, 1 any file failed, 2 usage.
 *
 * No GUI, no renderer, no embind bindings, no JS host logic. Wired into
 * eeschema/CMakeLists.txt behind the KICAD_SYM_CONVERTER_WASM option
 * (see scripts/kicad/build-sym_convert.sh).
 *
 * Targets:
 *   - Node:     built with -sENVIRONMENT=node -sNODERAWFS=1 (the default here);
 *               run with `node sym_convert.js in.lib out.kicad_sym`.
 *   - wasmtime: a follow-up build (no pthreads, -sSTANDALONE_WASM) lets the
 *               same code run host-less under `wasmtime sym_convert.wasm ...`.
 *
 * GPL note: this is GPL KiCad code. The artifact is meant to be invoked as a
 * separate process from the closed ingester, never linked into closed code.
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

#include <wx/arrstr.h>
#include <wx/filename.h>
#include <wx/init.h>
#include <wx/string.h>

#include <ki_exception.h>
#include <lib_symbol.h>
#include <libraries/library_manager.h>
#include <pgm_base.h>
#include <project.h>
#include <settings/settings_manager.h>

#include <io/io_mgr.h>
#include <sch_io/sch_io.h>
#include <sch_io/sch_io_mgr.h>
#include <sch_screen.h>
#include <sch_sheet.h>
#include <sch_sheet_path.h>
#include <schematic.h>

#ifdef KICAD_TOOLS_COMBINED
// Merged image only: full-parse board lint via the pcbnew side
// (pcb_convert_main.cpp) — the standalone eeschema tree has no pcbnew parser.
int pcbToolsLintBoard( const char* aInPath, std::string& aError );
// Merged image only: board load + s-expr rewrite for --resave (kicad-validity
// 0001). 0 resaved / 4 load failed / 5 write failed.
int pcbToolsResaveBoard( const char* aInPath, const char* aOutPath, std::string& aError );
// Merged image only: .kicad_mod full parse (returns pad count or -1) and
// resave (0/4/5) — kicad-validity 0001 S.
int pcbToolsLintFootprint( const char* aInPath, std::string& aError );
int pcbToolsResaveFootprint( const char* aInPath, const char* aOutPath, std::string& aError );
#endif

#include <connection_graph.h>
#include <drawing_sheet/ds_data_model.h>
#include <erc/erc.h>
#include <erc/erc_report.h>
#include <erc/erc_settings.h>
#include <filename_resolver.h>
#include <netlist_exporter_kicad.h>
#include <netlist_exporter_xml.h>
#include <reporter.h>
#include <sch_painter.h>
#include <sch_plotter.h>
#include <sch_reference_list.h>
#include <sch_rule_area.h>
#include <settings/color_settings.h>
#include <widgets/report_severity.h>

// ── minimal KiCad runtime for the schematic-load path ─────────────────────────
// LoadSchematicFile needs a SCHEMATIC with a PROJECT (settings manager), and
// ParseSchematic's tail calls Pgm().GetLanguageTag() (feeding the wasm
// no-fontconfig ListFonts, which is a cheap string walk). A minimal concrete
// PGM_BASE + headless SETTINGS_MANAGER — the qa fixtures' recipe
// (qa/schematic_utils/eeschema_test_utils.cpp) — is all that takes.

namespace
{

/** SYM_CONVERT_TRACE=1: stage prints for diagnosing hangs/traps in the field. */
void trace( const char* aMsg )
{
    if( std::getenv( "SYM_CONVERT_TRACE" ) )
        std::fprintf( stderr, "[trace] %s\n", aMsg );
}


class LINT_PGM : public PGM_BASE
{
public:
    void MacOpenFile( const wxString& ) override {}

    void CreateSettingsManager()
    {
        m_settings_manager = std::make_unique<SETTINGS_MANAGER>();
    }

    // The full InitPgm() is deliberately not run (kiway/curl plumbing); but
    // CONNECTION_GRAPH::Recalculate's submit_loop divides by GetThreadPool()'s
    // thread count, and the pool only exists after m_singleton.Init() —
    // without it --erc wanders on a null-object read (address 0 is readable
    // linear memory under wasm, so null derefs hang instead of trapping).
    void CreateSingleton()
    {
        m_singleton.Init();
    }

    // Same hazard class: netlist export's makeLibraries() (and the ERC lib
    // checks) call Pgm().GetLibraryManager(), which returns *m_library_manager
    // unchecked. An empty manager (no tables loaded) is valid — lookups just
    // return nullopt and the netlist's <libraries/> section stays empty.
    void CreateLibraryManager()
    {
        m_library_manager = std::make_unique<LIBRARY_MANAGER>();
    }
};


SETTINGS_MANAGER& kiRuntime()
{
    static SETTINGS_MANAGER* s_manager = nullptr;

    if( !s_manager )
    {
        // JSON settings need a writable config dir; keep it away from any real
        // user config (0 = don't overwrite an explicit override).
        setenv( "KICAD_CONFIG_HOME", "/tmp/sym_convert-config", 0 );

        // Pin the KiCad thread pool to one worker BEFORE the first
        // ADVANCED_CFG::GetCfg() call latches the value: the link ships only
        // -sPTHREAD_POOL_SIZE=2 preloaded pthread workers, and the default
        // (0 = hardware_concurrency) would spawn a pool the node runtime can
        // only grow after returning to the event loop — which a blocking CLI
        // never does.
        {
            const char* configHome = std::getenv( "KICAD_CONFIG_HOME" );
            wxFileName advCfg( wxString::FromUTF8( configHome ), wxS( "kicad_advanced" ) );

            if( !advCfg.DirExists() )
                advCfg.Mkdir( wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL );

            if( !advCfg.FileExists() )
            {
                if( FILE* f = std::fopen( advCfg.GetFullPath().ToUTF8(), "wb" ) )
                {
                    std::fputs( "MaximumThreads=1\n", f );
                    std::fclose( f );
                }
            }
        }

        // Deliberately leaked: ~PGM_BASE runs Destroy() (curl/sentry cleanup)
        // from the EXIT_RUNTIME static-dtor pass, which the diet stubs out.
        trace( "kiRuntime: constructing LINT_PGM" );
        LINT_PGM* pgm = new LINT_PGM();
        SetPgm( pgm );
        trace( "kiRuntime: constructing SETTINGS_MANAGER" );
        pgm->CreateSettingsManager();
        trace( "kiRuntime: singleton (thread pool)" );
        pgm->CreateSingleton();
        trace( "kiRuntime: library manager (empty)" );
        pgm->CreateLibraryManager();
        s_manager = &pgm->GetSettingsManager();
        trace( "kiRuntime: ready" );
    }

    return *s_manager;
}

// ── structure-only s-expr walk + uuid lints ───────────────────────────────────
// Self-contained (no KiCad parser): balanced parens, terminated strings, and
// the two uuid pathologies. Runs on every s-expr input, INCLUDING fully parsed
// ones — the full parsers *normalize* these instead of reporting them.

struct LINT_REPORT
{
    std::vector<std::string> errors;
    std::vector<std::string> warnings;
};


struct SEXPR_NODE
{
    std::string head;      // first atom after '('
    std::string firstArg;  // second atom (a (uuid "X") node's value)
    int         line = 0;
    int         directUuidFields = 0;
    bool        sawHead = false;
};


void walkSexpr( const std::string& aText, const char* aPath, LINT_REPORT& aOut )
{
    std::vector<SEXPR_NODE> stack;
    std::map<std::string, std::vector<int>> uuidLines; // value -> lines seen on a node
    size_t i = 0;
    int    line = 1;
    int    topLevelForms = 0;

    auto err = [&]( int aLine, const std::string& aMsg )
    {
        char buf[512];
        std::snprintf( buf, sizeof( buf ), "%s:%d: error: %s", aPath, aLine, aMsg.c_str() );
        aOut.errors.push_back( buf );
    };
    auto warn = [&]( int aLine, const std::string& aMsg )
    {
        char buf[512];
        std::snprintf( buf, sizeof( buf ), "%s:%d: warning: %s", aPath, aLine, aMsg.c_str() );
        aOut.warnings.push_back( buf );
    };

    auto atomInto = [&]( SEXPR_NODE* aNode, const std::string& aAtom )
    {
        if( !aNode )
            return;

        if( !aNode->sawHead )
        {
            aNode->head = aAtom;
            aNode->sawHead = true;
        }
        else if( aNode->firstArg.empty() )
        {
            aNode->firstArg = aAtom;
        }
    };

    while( i < aText.size() )
    {
        const char c = aText[i];

        if( c == '\n' )
        {
            line++;
            i++;
        }
        else if( c == ' ' || c == '\t' || c == '\r' )
        {
            i++;
        }
        else if( c == '(' )
        {
            if( stack.empty() )
                topLevelForms++;

            SEXPR_NODE node;
            node.line = line;
            stack.push_back( node );
            i++;
        }
        else if( c == ')' )
        {
            if( stack.empty() )
            {
                err( line, "unbalanced ')'" );
                return;
            }

            SEXPR_NODE closed = stack.back();
            stack.pop_back();
            SEXPR_NODE* parent = stack.empty() ? nullptr : &stack.back();

            if( closed.head == "uuid" && parent )
            {
                parent->directUuidFields++;

                if( parent->directUuidFields == 2 )
                {
                    warn( closed.line,
                          "multiple (uuid) fields directly in one (" + parent->head
                                  + ") node — KiCad keeps only the last" );
                }

                if( !closed.firstArg.empty() )
                {
                    std::string value = closed.firstArg;

                    if( value.size() >= 2 && value.front() == '"' && value.back() == '"' )
                        value = value.substr( 1, value.size() - 2 );

                    uuidLines[value].push_back( closed.line );
                }
            }

            i++;
        }
        else if( c == '"' )
        {
            const int start = line;
            std::string atom;
            atom += c;
            i++;

            while( i < aText.size() && aText[i] != '"' )
            {
                if( aText[i] == '\\' && i + 1 < aText.size() )
                {
                    atom += aText[i];
                    i++;
                }

                if( aText[i] == '\n' )
                    line++;

                atom += aText[i];
                i++;
            }

            if( i >= aText.size() )
            {
                err( start, "unterminated string" );
                return;
            }

            atom += '"';
            i++;
            atomInto( stack.empty() ? nullptr : &stack.back(), atom );
        }
        else
        {
            std::string atom;

            while( i < aText.size() && !std::strchr( " \t\r\n()\"", aText[i] ) )
            {
                atom += aText[i];
                i++;
            }

            if( stack.empty() )
            {
                err( line, "atom outside any (…) form: '" + atom + "'" );
                return;
            }

            atomInto( &stack.back(), atom );
        }
    }

    if( !stack.empty() )
        err( stack.back().line, "unbalanced '(' — " + std::to_string( stack.size() )
                                        + " form(s) never closed" );

    if( topLevelForms == 0 && aOut.errors.empty() )
        err( 1, "no s-expression form found" );

    for( const auto& [value, lines] : uuidLines )
    {
        if( lines.size() < 2 )
            continue;

        std::string msg = "uuid \"" + value + "\" appears on " + std::to_string( lines.size() )
                          + " nodes (also line";
        msg += lines.size() > 2 ? "s" : "";

        for( size_t n = 1; n < lines.size(); n++ )
            msg += ( n > 1 ? ", " : " " ) + std::to_string( lines[n] );

        msg += ") — eeschema silently regenerates the duplicate, pcbnew keeps both";
        warn( lines[0], msg );
    }
}

// ── full-fidelity lints (the linked eeschema parsers) ─────────────────────────

void lintSchematicFile( const wxString& aAbsPath, LINT_REPORT& aOut )
{
    SETTINGS_MANAGER& manager = kiRuntime();
    trace( "lintSchematicFile: LoadProject" );
    // aSetActive=false: the set-active tail calls Pgm().GetLibraryManager()
    // (never constructed on the minimal LINT_PGM — a null vtable call) and the
    // kiway/env plumbing; none of it exists headless. Prj() still resolves to
    // the first loaded project.
    manager.LoadProject( wxEmptyString, false );
    manager.Prj().SetElem( PROJECT::ELEM::LEGACY_SYMBOL_LIBS, nullptr );

    trace( "lintSchematicFile: constructing SCHEMATIC" );
    SCHEMATIC schematic( &manager.Prj() );
    trace( "lintSchematicFile: Reset" );
    schematic.Reset();
    SCH_SHEET* defaultSheet = schematic.GetTopLevelSheet( 0 );

    trace( "lintSchematicFile: LoadSchematicFile" );
    IO_RELEASER<SCH_IO> pi( SCH_IO_MGR::FindPlugin( SCH_IO_MGR::SCH_KICAD ) );
    SCH_SHEET* root = pi->LoadSchematicFile( aAbsPath, &schematic );
    trace( "lintSchematicFile: loaded" );
    schematic.AddTopLevelSheet( root ); // the SCHEMATIC dtor owns the hierarchy
    schematic.RemoveTopLevelSheet( defaultSheet );
    delete defaultSheet;

    // Sub-sheet problems (e.g. a missing child .kicad_sch when linting one
    // materialized sheet) are queued by loadHierarchy, not thrown — only the
    // root file's own parse failure throws. Surface them as warnings.
    if( !pi->GetError().IsEmpty() )
    {
        for( const wxString& msgLine : wxSplit( pi->GetError(), '\n' ) )
        {
            if( !msgLine.IsEmpty() )
                aOut.warnings.push_back( std::string( aAbsPath.ToUTF8() ) + ": warning: sub-sheet: "
                                         + std::string( msgLine.ToUTF8() ) );
        }
    }
}


int lintSymbolLib( const wxString& aAbsPath )
{
    const SCH_IO_MGR::SCH_FILE_T type = SCH_IO_MGR::GuessPluginTypeFromLibPath( aAbsPath );

    if( type == SCH_IO_MGR::SCH_FILE_UNKNOWN )
        THROW_IO_ERROR( wxS( "unrecognized symbol library format" ) );

    IO_RELEASER<SCH_IO> pi( SCH_IO_MGR::FindPlugin( type ) );

    // The vector overload is the one ConvertLibrary exercises (the wxArrayString
    // flavor crashed a dieted build once — an indirectly-reachable-only helper).
    // The symbols stay owned by the plugin's cache; do not delete them.
    std::vector<LIB_SYMBOL*> symbols;
    pi->EnumerateSymbolLib( symbols, aAbsPath );
    return (int) symbols.size();
}

// ── lint driver ───────────────────────────────────────────────────────────────

bool lintOneFile( const char* aPath, bool aStrict )
{
    wxFileName fn( wxString::FromUTF8( aPath ) );
    fn.MakeAbsolute(); // LoadSchematicFile asserts an absolute path
    const wxString absPath = fn.GetFullPath();
    const wxString ext = fn.GetExt().Lower();

    LINT_REPORT report;
    const char* tier = "structure only";
    int symbolCount = -1;
    int footprintCount = -1;

    // The structural walk + uuid lints run on every s-expr format; the legacy
    // .lib format is not an s-expr, so it gets the full parse only.
    if( ext != wxS( "lib" ) )
    {
        std::string text;

        if( FILE* f = std::fopen( aPath, "rb" ) )
        {
            // Heap, not stack: a 64 KB stack buffer equals the default wasm
            // stack SIZE — it silently overflowed into the heap and corrupted
            // mimalloc's structures (trap deep inside _mi_malloc_generic).
            std::vector<char> buf( 65536 );
            size_t got;

            while( ( got = std::fread( buf.data(), 1, buf.size(), f ) ) > 0 )
                text.append( buf.data(), got );

            std::fclose( f );
            walkSexpr( text, aPath, report );
        }
        else
        {
            report.errors.push_back( std::string( aPath ) + ": error: cannot open file" );
        }
    }

    if( report.errors.empty() )
    {
        trace( "lintOneFile: structural walk done, dispatching full parse" );
        try
        {
            if( ext == wxS( "kicad_sch" ) )
            {
                lintSchematicFile( absPath, report );
                tier = "full parse";
            }
            else if( ext == wxS( "kicad_sym" ) || ext == wxS( "lib" ) )
            {
                symbolCount = lintSymbolLib( absPath );
                tier = "full parse";
            }
#ifdef KICAD_TOOLS_COMBINED
            else if( ext == wxS( "kicad_pcb" ) )
            {
                std::string boardError;
                footprintCount = pcbToolsLintBoard( aPath, boardError );

                if( footprintCount < 0 )
                    report.errors.push_back( boardError );
                else
                    tier = "full parse";
            }
            else if( ext == wxS( "kicad_mod" ) )
            {
                std::string fpError;

                if( pcbToolsLintFootprint( aPath, fpError ) < 0 )
                    report.errors.push_back( fpError );
                else
                    tier = "full parse";
            }
#endif
            // Anything else (kicad_wks, kicad_pro …— and kicad_pcb outside
            // the merged kicad_tools image) stays structure-only.
        }
        catch( PARSE_ERROR& pe ) // non-const: ParseProblem() is unqualified
        {
            char buf[1024];
            std::snprintf( buf, sizeof( buf ), "%s:%d:%d: error: %s", aPath, pe.lineNumber,
                           pe.byteIndex, (const char*) pe.ParseProblem().ToUTF8() );
            report.errors.push_back( buf );
        }
        catch( const IO_ERROR& ioe )
        {
            report.errors.push_back( std::string( aPath ) + ": error: "
                                     + std::string( ioe.Problem().ToUTF8() ) );
        }
        catch( const std::exception& e )
        {
            report.errors.push_back( std::string( aPath ) + ": error: " + e.what() );
        }
    }

    for( const std::string& msg : report.errors )
        std::fprintf( stderr, "%s\n", msg.c_str() );

    for( const std::string& msg : report.warnings )
        std::fprintf( stderr, "%s\n", msg.c_str() );

    const bool failed = !report.errors.empty() || ( aStrict && !report.warnings.empty() );

    if( failed )
        std::fprintf( stderr, "%s: FAIL\n", aPath );
    else if( symbolCount >= 0 )
        std::fprintf( stderr, "%s: OK (%s, %d symbols)\n", aPath, tier, symbolCount );
    else if( footprintCount >= 0 )
        std::fprintf( stderr, "%s: OK (%s, %d footprints)\n", aPath, tier, footprintCount );
    else
        std::fprintf( stderr, "%s: OK (%s)\n", aPath, tier );

    return !failed;
}

// ── shared headless schematic loader (pcbjam-mcp 0001 tier 3a) ───────────────
// Load + the EESCHEMA_HELPERS::LoadSchematic post-load tail, minus the
// SCHEMATIC::RecalculateConnections cleanup pass: that path constructs a
// SCH_COMMIT on a TOOL_MANAGER wired to Kiface().KifaceSettings(), none of
// which this diet tree links. Editor-saved files are already normalized; the
// connection graph is built directly, the way the cleanup pass's own tail
// does it. Prints diagnostics and returns null on failure.

std::unique_ptr<SCHEMATIC> loadSchematicHeadless( const char* aInPath )
{
    wxFileName fn( wxString::FromUTF8( aInPath ) );
    fn.MakeAbsolute();
    const wxString absPath = fn.GetFullPath();

    SETTINGS_MANAGER& manager = kiRuntime();

    // ERC severities, exclusions, netclasses and text vars live in the sibling
    // .kicad_pro — load it when present. aSetActive=false as in lintSchematicFile
    // (the set-active tail needs the library manager / kiway plumbing).
    wxFileName pro( fn );
    pro.SetExt( wxS( "kicad_pro" ) );
    trace( "loadSchematicHeadless: LoadProject" );
    const wxString proPath = pro.FileExists() ? pro.GetFullPath() : wxString( wxEmptyString );
    manager.LoadProject( proPath, false );
    // Bind THIS file's project, not Prj(): with aSetActive=false projects
    // accumulate across --resave-batch entries and Prj() keeps returning the
    // first one — the s-expr writer would then stamp the wrong (or an empty)
    // project name into the saved symbol-instance data. GetProject resolves
    // the exact project the LoadProject call above created (or reused).
    PROJECT* loaded = manager.GetProject( proPath );
    PROJECT& project = loaded ? *loaded : manager.Prj();
    project.SetElem( PROJECT::ELEM::LEGACY_SYMBOL_LIBS, nullptr );

    auto schematic = std::make_unique<SCHEMATIC>( &project );
    schematic->Reset();
    SCH_SHEET* defaultSheet = schematic->GetTopLevelSheet( 0 );

    trace( "loadSchematicHeadless: LoadSchematicFile" );
    IO_RELEASER<SCH_IO> pi( SCH_IO_MGR::FindPlugin( SCH_IO_MGR::SCH_KICAD ) );
    SCH_SHEET* root = nullptr;

    try
    {
        root = pi->LoadSchematicFile( absPath, schematic.get() );
    }
    catch( PARSE_ERROR& pe )
    {
        std::fprintf( stderr, "%s:%d:%d: error: %s\n", aInPath, pe.lineNumber, pe.byteIndex,
                      (const char*) pe.ParseProblem().ToUTF8() );
        return nullptr;
    }
    catch( const IO_ERROR& ioe )
    {
        std::fprintf( stderr, "%s: error: %s\n", aInPath,
                      (const char*) ioe.Problem().ToUTF8() );
        return nullptr;
    }

    schematic->AddTopLevelSheet( root ); // the SCHEMATIC dtor owns the hierarchy
    schematic->RemoveTopLevelSheet( defaultSheet );
    delete defaultSheet;

    if( root->GetName().IsEmpty() )
        root->SetName( wxS( "Root" ) );

    trace( "loadSchematicHeadless: post-load fixups" );
    SCH_SHEET_LIST sheetList = schematic->BuildSheetListSortedByPageNumbers();
    SCH_SCREENS    screens( schematic->Root() );

    for( SCH_SCREEN* screen = screens.GetFirst(); screen; screen = screens.GetNext() )
        screen->UpdateLocalLibSymbolLinks();

    if( schematic->RootScreen()->GetFileFormatVersionAtLoad() < 20221002 )
        sheetList.UpdateSymbolInstanceData( schematic->RootScreen()->GetSymbolInstances() );

    sheetList.UpdateSheetInstanceData( schematic->RootScreen()->GetSheetInstances() );

    if( schematic->RootScreen()->GetFileFormatVersionAtLoad() < 20230221 )
        screens.FixLegacyPowerSymbolMismatches();

    // MigrateSimModels() deliberately skipped: legacy sim-model migration lives
    // in the pruned sim/ TUs (undefined here); ERCE_SIMULATION_MODEL is ignored
    // in runErc for the same reason.
    schematic->LoadVariants();

    wxString projectName = project.GetProjectName();

    if( projectName.IsEmpty() )
        projectName = fn.GetName();

    sheetList.CheckForMissingSymbolInstances( projectName );
    screens.PruneOrphanedSymbolInstances( projectName, sheetList );
    screens.PruneOrphanedSheetInstances( projectName, sheetList );
    sheetList.AnnotatePowerSymbols();

    schematic->ConnectionGraph()->Reset();
    schematic->ResolveERCExclusionsPostUpdate();
    schematic->SetSheetNumberAndCount();
    schematic->RecomputeIntersheetRefs();

    for( SCH_SHEET_PATH& sheet : sheetList )
    {
        sheet.UpdateAllScreenReferences();
        sheet.LastScreen()->TestDanglingEnds( nullptr, nullptr );
    }

    std::unordered_set<SCH_SCREEN*> allScreens;

    for( const SCH_SHEET_PATH& path : sheetList )
        allScreens.insert( path.LastScreen() );

    SCH_RULE_AREA::UpdateRuleAreasInScreens( allScreens, nullptr );

    trace( "loadSchematicHeadless: ConnectionGraph Recalculate" );
    schematic->ConnectionGraph()->Recalculate( sheetList, true );

    return schematic;
}


/** Default output path: next to the input, optional suffix, new extension. */
wxString defaultOutPath( const wxFileName& aIn, const wxString& aSuffix, const wxString& aExt )
{
    wxFileName out( aIn );
    out.SetName( out.GetName() + aSuffix );
    out.SetExt( aExt );
    return out.GetFullPath();
}

// ── headless resave — format upgrade (kicad-validity 0001) ───────────────────
// Full parse, then write back in the current file-format version. The write
// goes to <outdir> as files (never stdout): the tools-job runner's contract is
// "walk the output dir", and a hierarchical schematic produces one file per
// sheet, mirroring the sheet files' layout relative to the root file's
// directory (sheets outside it flatten to their basename). Zones/geometry are
// written as-loaded — a format upgrade must not change content.
// Exit: 0 resaved / 2 usage / 4 load or parse failed / 5 write failed. Only 4
// means "the input is not valid KiCad" — the upload gate keys off it.

int resaveSchematic( const char* aInPath, const wxFileName& aInFn, const wxString& aOutDir )
{
    std::unique_ptr<SCHEMATIC> schematic = loadSchematicHeadless( aInPath );

    if( !schematic )
        return 4;

    IO_RELEASER<SCH_IO> pi( SCH_IO_MGR::FindPlugin( SCH_IO_MGR::SCH_KICAD ) );

    const wxString rootDir = aInFn.GetPath( wxPATH_GET_SEPARATOR );

    SCH_SHEET_LIST sheetList = schematic->BuildSheetListSortedByPageNumbers();
    std::unordered_set<SCH_SCREEN*> saved;
    int files = 0;

    for( SCH_SHEET_PATH& path : sheetList )
    {
        SCH_SHEET*  sheet = path.Last();
        SCH_SCREEN* screen = sheet ? sheet->GetScreen() : nullptr;

        if( !screen || !saved.insert( screen ).second )
            continue;

        wxFileName srcFn( screen->GetFileName() );
        srcFn.MakeAbsolute();

        wxString rel;

        if( srcFn.GetFullPath().StartsWith( rootDir, &rel ) )
            ; // rel = path under the root file's directory
        else
            rel = srcFn.GetFullName();

        wxFileName outFn( aOutDir + rel );

        if( !outFn.DirExists() && !outFn.Mkdir( wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
        {
            std::fprintf( stderr, "%s: error: cannot create output directory %s\n", aInPath,
                          (const char*) outFn.GetPath().ToUTF8() );
            return 5;
        }

        try
        {
            pi->SaveSchematicFile( outFn.GetFullPath(), sheet, schematic.get() );
        }
        catch( const IO_ERROR& ioe )
        {
            std::fprintf( stderr, "%s: error: %s\n",
                          (const char*) outFn.GetFullPath().ToUTF8(),
                          (const char*) ioe.Problem().ToUTF8() );
            return 5;
        }

        files++;
    }

    std::fprintf( stderr, "%s: OK (resave, %d sheet files) -> %s\n", aInPath, files,
                  (const char*) aOutDir.ToUTF8() );
    return 0;
}


int runResave( const char* aInPath, const char* aOutDir )
{
    wxFileName inFn( wxString::FromUTF8( aInPath ) );
    inFn.MakeAbsolute();
    const wxString ext = inFn.GetExt().Lower();

    wxFileName outDirFn = wxFileName::DirName( wxString::FromUTF8( aOutDir ) );
    outDirFn.MakeAbsolute();
    const wxString outDir = outDirFn.GetPath( wxPATH_GET_SEPARATOR );

    if( !outDirFn.DirExists() && !outDirFn.Mkdir( wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
    {
        std::fprintf( stderr, "%s: error: cannot create output directory %s\n", aInPath,
                      (const char*) outDir.ToUTF8() );
        return 5;
    }

    if( ext == wxS( "kicad_sch" ) )
        return resaveSchematic( aInPath, inFn, outDir );

    if( ext == wxS( "kicad_sym" ) || ext == wxS( "lib" ) )
    {
        // ConvertLibrary reads any recognized library format and writes the
        // current s-expr format — resave and legacy upgrade in one call.
        const wxString outPath = outDir + inFn.GetName() + wxS( ".kicad_sym" );

        if( !SCH_IO_MGR::ConvertLibrary( nullptr, inFn.GetFullPath(), outPath ) )
        {
            std::fprintf( stderr, "%s: error: failed to convert symbol library\n", aInPath );
            return 4;
        }

        std::fprintf( stderr, "%s: OK (resave) -> %s\n", aInPath,
                      (const char*) outPath.ToUTF8() );
        return 0;
    }

    if( ext == wxS( "kicad_pcb" ) || ext == wxS( "kicad_mod" ) )
    {
#ifdef KICAD_TOOLS_COMBINED
        const wxString outPath = outDir + inFn.GetFullName();
        std::string    error;
        const int rc = ext == wxS( "kicad_pcb" )
                ? pcbToolsResaveBoard( aInPath, (const char*) outPath.ToUTF8(), error )
                : pcbToolsResaveFootprint( aInPath, (const char*) outPath.ToUTF8(), error );

        if( rc != 0 )
            std::fprintf( stderr, "%s\n", error.c_str() );
        else
            std::fprintf( stderr, "%s: OK (resave) -> %s\n", aInPath,
                          (const char*) outPath.ToUTF8() );

        return rc;
#else
        std::fprintf( stderr, "%s: error: board/footprint resave requires the merged "
                              "kicad_tools build\n",
                      aInPath );
        return 2;
#endif
    }

    std::fprintf( stderr, "%s: error: unsupported extension for --resave\n", aInPath );
    return 2;
}

// ── headless ERC ──────────────────────────────────────────────────────────────

int runErc( const char* aInPath, bool aJson, bool aStrict, const char* aOutPath )
{
    wxFileName fn( wxString::FromUTF8( aInPath ) );
    fn.MakeAbsolute();

    std::unique_ptr<SCHEMATIC> schematicHolder = loadSchematicHeadless( aInPath );

    if( !schematicHolder )
        return 4;

    SCHEMATIC& schematic = *schematicHolder;
    PROJECT&   project = schematic.Project();

    // Tests needing machinery this headless runtime doesn't have. Lib-symbol
    // and footprint-filter tests dereference Pgm().GetLibraryManager() (never
    // constructed on LINT_PGM); footprint links need the cvpcb kiface (RunTests
    // also skips it on the null aCvPcb); sim models need the pruned sim/ TUs.
    ERC_SETTINGS& ercSettings = schematic.ErcSettings();
    ercSettings.SetSeverity( ERCE_LIB_SYMBOL_ISSUES, RPT_SEVERITY_IGNORE );
    ercSettings.SetSeverity( ERCE_LIB_SYMBOL_MISMATCH, RPT_SEVERITY_IGNORE );
    ercSettings.SetSeverity( ERCE_FOOTPRINT_FILTERS, RPT_SEVERITY_IGNORE );
    ercSettings.SetSeverity( ERCE_FOOTPRINT_LINK_ISSUES, RPT_SEVERITY_IGNORE );
    ercSettings.SetSeverity( ERCE_SIMULATION_MODEL, RPT_SEVERITY_IGNORE );

    trace( "runErc: RunTests" );
    ERC_TESTER tester( &schematic );
    tester.RunTests( nullptr /*drawing sheet*/, nullptr /*edit frame*/, nullptr /*cvpcb*/,
                     &project, nullptr /*progress*/ );

    auto provider = std::make_shared<SHEETLIST_ERC_ITEMS_PROVIDER>( &schematic );
    provider->SetSeverities( RPT_SEVERITY_ERROR | RPT_SEVERITY_WARNING );

    const int errors = provider->GetCount( RPT_SEVERITY_ERROR );
    const int warnings = provider->GetCount( RPT_SEVERITY_WARNING );

    wxString outPath;

    if( aOutPath )
    {
        outPath = wxString::FromUTF8( aOutPath );
    }
    else
    {
        wxFileName out( fn );
        out.SetName( out.GetName() + wxS( "-erc" ) );
        out.SetExt( aJson ? wxS( "json" ) : wxS( "rpt" ) );
        outPath = out.GetFullPath();
    }

    trace( "runErc: writing report" );
    ERC_REPORT reportWriter( &schematic, EDA_UNITS::MM, provider );
    const bool wrote = aJson ? reportWriter.WriteJsonReport( outPath )
                             : reportWriter.WriteTextReport( outPath );

    if( !wrote )
    {
        std::fprintf( stderr, "%s: error: unable to save ERC report to %s\n", aInPath,
                      (const char*) outPath.ToUTF8() );
        return 4;
    }

    const bool failed = errors > 0 || ( aStrict && warnings > 0 );

    std::fprintf( stderr, "%s: %s (%d errors, %d warnings) -> %s\n", aInPath,
                  failed ? "FAIL" : "OK", errors, warnings, (const char*) outPath.ToUTF8() );

    return failed ? 1 : 0;
}

// ── headless netlist / BOM export ─────────────────────────────────────────────
// Mirrors EESCHEMA_JOBS_HANDLER::JobExportNetlist / JobExportPythonBom. Only
// the KiCad s-expr and XML emitters are linked (SPICE needs the pruned sim/
// TUs; the other legacy formats can be re-admitted on demand).

void warnAnnotationIssues( SCHEMATIC& aSchematic, const char* aInPath )
{
    SCH_REFERENCE_LIST referenceList;
    aSchematic.Hierarchy().GetSymbols( referenceList, SYMBOL_FILTER_ALL );

    if( referenceList.GetCount() > 0 )
    {
        if( referenceList.CheckAnnotation(
                    []( ERCE_T, const wxString&, SCH_REFERENCE*, SCH_REFERENCE* )
                    {
                    } ) > 0 )
        {
            std::fprintf( stderr, "%s: warning: schematic has annotation errors\n", aInPath );
        }
    }

    ERC_TESTER erc( &aSchematic );

    if( erc.TestDuplicateSheetNames( false ) > 0 )
        std::fprintf( stderr, "%s: warning: duplicate sheet names\n", aInPath );
}


int runNetlist( const char* aInPath, bool aXml, bool aBom, const char* aOutPath )
{
    wxFileName fn( wxString::FromUTF8( aInPath ) );
    fn.MakeAbsolute();

    std::unique_ptr<SCHEMATIC> schematic = loadSchematicHeadless( aInPath );

    if( !schematic )
        return 4;

    warnAnnotationIssues( *schematic, aInPath );

    std::unique_ptr<NETLIST_EXPORTER_BASE> helper;
    unsigned netlistOption = 0;
    wxString outPath;

    if( aBom )
    {
        helper = std::make_unique<NETLIST_EXPORTER_XML>( schematic.get() );
        netlistOption = GNL_OPT_BOM;
        outPath = aOutPath ? wxString::FromUTF8( aOutPath )
                           : defaultOutPath( fn, wxS( "-bom" ), wxS( "xml" ) );
    }
    else if( aXml )
    {
        helper = std::make_unique<NETLIST_EXPORTER_XML>( schematic.get() );
        outPath = aOutPath ? wxString::FromUTF8( aOutPath )
                           : defaultOutPath( fn, wxEmptyString, wxS( "xml" ) );
    }
    else
    {
        helper = std::make_unique<NETLIST_EXPORTER_KICAD>( schematic.get() );
        outPath = aOutPath ? wxString::FromUTF8( aOutPath )
                           : defaultOutPath( fn, wxEmptyString, wxS( "net" ) );
    }

    trace( "runNetlist: WriteNetlist" );
    const bool ok = helper->WriteNetlist( outPath, netlistOption, CLI_REPORTER::GetInstance() );

    std::fprintf( stderr, "%s: %s -> %s\n", aInPath, ok ? "OK" : "FAIL",
                  (const char*) outPath.ToUTF8() );

    return ok ? 0 : 4;
}

// ── headless schematic plot (SVG / PDF) ───────────────────────────────────────
// Mirrors EESCHEMA_JOBS_HANDLER::JobExportPlot + its InitRenderSettings: the
// plot path is plotter-based (common/plotters), no GAL context; text renders
// through the already-linked stroke font engine.

int runPlot( const char* aInPath, bool aPdf, const char* aOutPath )
{
    wxFileName fn( wxString::FromUTF8( aInPath ) );
    fn.MakeAbsolute();

    std::unique_ptr<SCHEMATIC> schematic = loadSchematicHeadless( aInPath );

    if( !schematic )
        return 4;

    auto renderSettings = std::make_unique<SCH_RENDER_SETTINGS>();

    // InitRenderSettings replica (default theme, no drawing-sheet override).
    COLOR_SETTINGS* cs = ::GetColorSettings( wxEmptyString );
    renderSettings->LoadColors( cs );
    renderSettings->m_ShowHiddenPins = false;
    renderSettings->m_ShowHiddenFields = false;
    renderSettings->m_ShowPinAltIcons = false;
    renderSettings->SetDefaultPenWidth( schematic->Settings().m_DefaultLineWidth );
    renderSettings->m_LabelSizeRatio = schematic->Settings().m_LabelSizeRatio;
    renderSettings->m_TextOffsetRatio = schematic->Settings().m_TextOffsetRatio;
    renderSettings->m_PinSymbolSize = schematic->Settings().m_PinSymbolSize;
    renderSettings->SetDashLengthRatio( schematic->Settings().m_DashedLineDashRatio );
    renderSettings->SetGapLengthRatio( schematic->Settings().m_DashedLineGapRatio );
    renderSettings->SetDefaultFont( wxEmptyString ); // stroke font (KiCad default)
    renderSettings->SetMinPenWidth( 0 );

    // Drawing sheet: project/schematic setting, else the built-in default.
    {
        wxString sheetPath = schematic->Settings().m_SchDrawingSheetFileName;
        wxString msg;
        FILENAME_RESOLVER resolve;
        resolve.SetProject( &schematic->Project() );
        resolve.SetProgramBase( &Pgm() );

        wxString absolutePath =
                resolve.ResolvePath( sheetPath, wxGetCwd(), { schematic->GetEmbeddedFiles() } );

        if( !DS_DATA_MODEL::GetTheInstance().LoadDrawingSheet( absolutePath, &msg ) )
            std::fprintf( stderr, "%s: warning: drawing sheet load: %s\n", aInPath,
                          (const char*) msg.ToUTF8() );
    }

    // Text bboxes may have been cached during load with no default font set.
    SCH_SCREENS screens( schematic->Root() );

    for( SCH_SCREEN* screen = screens.GetFirst(); screen; screen = screens.GetNext() )
    {
        for( SCH_ITEM* item : screen->Items() )
            item->ClearCaches();

        for( const auto& [libItemName, libSymbol] : screen->GetLibSymbols() )
            libSymbol->ClearCaches();
    }

    SCH_PLOT_OPTS plotOpts;
    plotOpts.m_plotAll = true;
    plotOpts.m_plotDrawingSheet = true;
    plotOpts.m_blackAndWhite = false;

    if( aPdf )
    {
        // Single multi-page PDF.
        plotOpts.m_outputFile = aOutPath ? wxString::FromUTF8( aOutPath )
                                         : defaultOutPath( fn, wxEmptyString, wxS( "pdf" ) );
    }
    else
    {
        // One SVG per sheet into a directory (kicad-cli behavior).
        plotOpts.m_outputDirectory =
                aOutPath ? wxString::FromUTF8( aOutPath ) : fn.GetPath();
    }

    trace( "runPlot: SCH_PLOTTER::Plot" );
    REPORTER& reporter = CLI_REPORTER::GetInstance();
    SCH_PLOTTER plotter( schematic.get() );
    plotter.Plot( aPdf ? PLOT_FORMAT::PDF : PLOT_FORMAT::SVG, plotOpts, renderSettings.get(),
                  &reporter );

    const bool failed = reporter.HasMessageOfSeverity( RPT_SEVERITY_ERROR );

    std::fprintf( stderr, "%s: %s -> %s\n", aInPath, failed ? "FAIL" : "OK",
                  (const char*) ( aPdf ? plotOpts.m_outputFile : plotOpts.m_outputDirectory )
                          .ToUTF8() );

    return failed ? 4 : 0;
}

} // namespace


// Under KICAD_TOOLS_COMBINED (the merged kicad_tools image) this TU compiles
// as a library: the entry point keeps its name and kicad_tools_main.cpp
// dispatches to it; the standalone sym_convert build wraps it in main() below.
int symConvertMain( int argc, char** argv )
{
    // Non-tty stderr is fully buffered under emscripten/musl, so a trap or
    // hang eats every diagnostic printed before it. A CLI's stderr must be
    // unbuffered — losing the error report is worse than the syscall cost.
    setvbuf( stderr, nullptr, _IONBF, 0 );

    // Bring up wxBase (no GUI): wxString / wxFileName / wxFFile rely on the
    // library being initialised.
    wxInitializer initializer( argc, argv );

    if( !initializer.IsOk() )
    {
        std::fprintf( stderr, "sym_convert: wxWidgets initialisation failed\n" );
        return 3;
    }

    if( argc >= 2 && std::strcmp( argv[1], "--erc" ) == 0 )
    {
        // Same rationale as --lint: the minimal runtime never registers app
        // settings, and report output must stay parseable.
        wxDisableAsserts();

        bool json = false;
        bool strict = false;
        int  arg = 2;

        while( arg < argc && std::strncmp( argv[arg], "--", 2 ) == 0 )
        {
            if( std::strcmp( argv[arg], "--json" ) == 0 )
                json = true;
            else if( std::strcmp( argv[arg], "--strict" ) == 0 )
                strict = true;
            else
                break;

            arg++;
        }

        if( arg >= argc )
        {
            std::fprintf( stderr,
                          "usage: sym_convert --erc [--json] [--strict] <file.kicad_sch> [<out>]\n" );
            return 2;
        }

        const char* inPath = argv[arg++];
        const char* outPath = arg < argc ? argv[arg] : nullptr;

        try
        {
            return runErc( inPath, json, strict, outPath );
        }
        catch( const std::exception& e )
        {
            std::fprintf( stderr, "%s: error: %s\n", inPath, e.what() );
            return 4;
        }
    }

    if( argc >= 2 && ( std::strcmp( argv[1], "--netlist" ) == 0
                       || std::strcmp( argv[1], "--bom" ) == 0
                       || std::strcmp( argv[1], "--plot" ) == 0 ) )
    {
        wxDisableAsserts();

        const bool isBom = std::strcmp( argv[1], "--bom" ) == 0;
        const bool isPlot = std::strcmp( argv[1], "--plot" ) == 0;
        bool xml = false;
        bool pdf = false;
        int  arg = 2;

        while( arg < argc && std::strncmp( argv[arg], "--", 2 ) == 0 )
        {
            if( !isPlot && !isBom && std::strcmp( argv[arg], "--xml" ) == 0 )
                xml = true;
            else if( isPlot && std::strcmp( argv[arg], "--pdf" ) == 0 )
                pdf = true;
            else
                break;

            arg++;
        }

        if( arg >= argc )
        {
            std::fprintf( stderr, "usage: sym_convert --netlist [--xml] <file.kicad_sch> [<out>]\n"
                                  "       sym_convert --bom <file.kicad_sch> [<out>]\n"
                                  "       sym_convert --plot [--pdf] <file.kicad_sch> [<out>]\n" );
            return 2;
        }

        const char* inPath = argv[arg++];
        const char* outPath = arg < argc ? argv[arg] : nullptr;

        try
        {
            if( isPlot )
                return runPlot( inPath, pdf, outPath );

            return runNetlist( inPath, xml, isBom, outPath );
        }
        catch( const std::exception& e )
        {
            std::fprintf( stderr, "%s: error: %s\n", inPath, e.what() );
            return 4;
        }
    }

    if( argc >= 2 && std::strcmp( argv[1], "--lint" ) == 0 )
    {
        // The minimal headless runtime never registers app settings;
        // GetAppSettings fails SOFT to defaults but wxFAIL_MSGs on every call,
        // flooding stderr. Lint output must stay parseable — drop the asserts.
        wxDisableAsserts();

        int  firstFile = 2;
        bool strict = false;

        if( argc > firstFile && std::strcmp( argv[firstFile], "--strict" ) == 0 )
        {
            strict = true;
            firstFile++;
        }

        if( argc <= firstFile )
        {
            std::fprintf( stderr, "usage: sym_convert --lint [--strict] <file> [<file>...]\n" );
            return 2;
        }

        bool allOk = true;

        for( int n = firstFile; n < argc; n++ )
            allOk = lintOneFile( argv[n], strict ) && allOk;

        return allOk ? 0 : 1;
    }

    if( argc >= 2 && std::strcmp( argv[1], "--resave" ) == 0 )
    {
        // Same rationale as --lint: headless runtime, parseable output.
        wxDisableAsserts();

        if( argc < 4 )
        {
            std::fprintf( stderr, "usage: kicad_tools --resave <file> <outdir>\n" );
            return 2;
        }

        try
        {
            return runResave( argv[2], argv[3] );
        }
        catch( const std::exception& e )
        {
            std::fprintf( stderr, "%s: error: %s\n", argv[2], e.what() );
            return 4;
        }
    }

    if( argc >= 2 && std::strcmp( argv[1], "--resave-batch" ) == 0 )
    {
        // Batch flavor of --resave (bulk-upload normalization): one process,
        // one runtime init, N inputs. Each input's outputs land in
        // <outdir>/<index>/ (index = position in the input list) so
        // hierarchical-schematic sheet outputs from different roots never
        // collide. Per-file verdicts use the single-file exit contract
        // (0/2/4/5) and are reported on stderr as
        //     RESAVE-BATCH <index> <exit-code>
        // The process exits 0 when the batch LOOP completed — per-file
        // failures live in the verdict lines, so one bad file can't mask the
        // rest of the batch. Exit 2 = usage.
        wxDisableAsserts();

        if( argc < 4 )
        {
            std::fprintf( stderr,
                          "usage: kicad_tools --resave-batch <outdir> <file> [<file>...]\n" );
            return 2;
        }

        for( int n = 3; n < argc; n++ )
        {
            const int index = n - 3;
            char      sub[32];
            std::snprintf( sub, sizeof( sub ), "/%d", index );
            const std::string outDir = std::string( argv[2] ) + sub;
            int               rc;

            try
            {
                rc = runResave( argv[n], outDir.c_str() );
            }
            catch( const std::exception& e )
            {
                std::fprintf( stderr, "%s: error: %s\n", argv[n], e.what() );
                rc = 4;
            }

            // Entries can come from DIFFERENT projects (a bulk upload of a
            // multi-project tree); with aSetActive=false the loaded projects
            // simply accumulate. That is safe because loadSchematicHeadless
            // binds each schematic to ITS OWN project via GetProject — never
            // to Prj(), which keeps returning the first loaded project.
            // (UnloadProject is no help here: unloading the active project
            // immediately reloads a null "" project, which would then shadow
            // every later entry's project name in the saved instance data.)

            std::fprintf( stderr, "RESAVE-BATCH %d %d\n", index, rc );
        }

        return 0;
    }

    if( argc >= 2 && std::strcmp( argv[1], "--convert-lib" ) == 0 && argc >= 4 )
    {
        // The legacy plugin asserts on relative paths and (worse) writes an
        // empty lib while still exiting 0 — absolutize here so callers can't
        // hit that class of bug.
        wxFileName inFn( wxString::FromUTF8( argv[2] ) );
        wxFileName outFn( wxString::FromUTF8( argv[3] ) );
        inFn.MakeAbsolute();
        outFn.MakeAbsolute();

        // aOldFileProps = nullptr: no library-table properties; ConvertLibrary
        // guesses the source format from the path and writes the SCH_KICAD format.
        const bool ok = SCH_IO_MGR::ConvertLibrary( nullptr, inFn.GetFullPath(),
                                                    outFn.GetFullPath() );

        if( ok )
        {
            std::fprintf( stderr, "convert-lib: OK  %s -> %s\n", argv[2], argv[3] );
            return 0;
        }

        std::fprintf( stderr, "convert-lib: FAILED to convert %s\n", argv[2] );
        return 1;
    }

    std::fprintf( stderr, "usage: kicad_tools --convert-lib <input.lib> <output.kicad_sym>\n"
                          "       kicad_tools --lint [--strict] <file> [<file>...]\n"
                          "       kicad_tools --resave <file> <outdir>\n"
                          "       kicad_tools --resave-batch <outdir> <file> [<file>...]\n"
                          "       kicad_tools --erc [--json] [--strict] <file.kicad_sch> [<out>]\n"
                          "       kicad_tools --netlist [--xml] <file.kicad_sch> [<out>]\n"
                          "       kicad_tools --bom <file.kicad_sch> [<out>]\n"
                          "       kicad_tools --plot [--pdf] <file.kicad_sch> [<out>]\n"
                          "       kicad_tools --drc [--json] [--strict] <file.kicad_pcb> [<out>]\n"
                          "       kicad_tools --gerbers <file.kicad_pcb> [<outdir>]\n"
                          "       kicad_tools --drill <file.kicad_pcb> [<outdir>]\n"
                          "       kicad_tools --plot-board [--pdf] [--layers <a,b,...>] <file.kicad_pcb> [<out>]\n" );
    return 2;
}


#ifndef KICAD_TOOLS_COMBINED
int main( int argc, char** argv )
{
    return symConvertMain( argc, argv );
}
#endif
