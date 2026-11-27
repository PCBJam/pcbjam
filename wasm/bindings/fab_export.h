/*
 * KiCad's fabrication exports on a loaded board: Gerbers with their job file,
 * Excellon drill, the IPC-D-356 netlist and the component list (plugins 0002).
 *
 * One implementation for both callers, so their files cannot drift:
 *   - kicad_tools (wasm/cli/pcb_convert_main.cpp) on the server, on a board it
 *     loaded from the project's files;
 *   - the PCB editor (wasm/bindings/pcbnew_embind.cpp, kicadFabExport) in the
 *     browser, on the board it has open (plugins 0029): no board load and no
 *     transfer, the files land in MEMFS under aOutDir/<kind>/ and the page
 *     reads them back.
 *
 * Both take the same options (plugins 0027), read from the same words
 * (parseOptions): kicad_tools from its command line, the editor from the page.
 *
 * The exporters read the board, and the board is the same after them. KiCad's
 * plot code changes a pad while it plots it and puts the sizes back
 * (plot_board_layers.cpp, as for the editor's own Plot dialog); what it leaves
 * behind in a custom padstack is taken out again here (CUSTOM_PADSTACK_KEEPER).
 * The mask options change two board settings for the plot only
 * (MASK_SETTINGS_GUARD).
 *
 * In the editor aOutDir must be outside the project folder: plot-outputs.ts
 * uploads Gerber and drill files closed under the project folder.
 */
#pragma once

#include <algorithm>
#include <chrono>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include <wx/arrstr.h>
#include <wx/dir.h>
#include <wx/filename.h>
#include <wx/string.h>

#include <nlohmann/json.hpp>

#include <base_units.h>
#include <board.h>
#include <board_design_settings.h>
#include <footprint.h>
#include <layer_ids.h>
#include <lset.h>
#include <pad.h>
#include <padstack.h>
#include <pcb_field.h>
#include <pcb_plotter.h>
#include <pcbplot.h>
#include <plotters/plotter_gerber.h>
#include <reporter.h>
#include <exporters/export_d356.h>
#include <exporters/gendrill_excellon_writer.h>
#include <exporters/gerber_jobfile_writer.h>
#include <jobs/job_export_pcb_drill.h>
#include <jobs/job_export_pcb_gerbers.h>

namespace pcbjam_fab_export
{

inline wxString withSlash( const wxString& aDir )
{
    return aDir.EndsWith( wxS( "/" ) ) ? aDir : aDir + wxS( "/" );
}


// plugins 0027: what a manufacturer's own KiCad plugin sets before it plots,
// as options of the Gerber and drill exports. The defaults are the exports as
// they always were; a batch takes the options of both kinds in one list.
struct OPTIONS
{
    // gerbers
    std::optional<std::string> layers;      // --layers a,b,...
    bool        canonicalNames = false;     // --canonical-names
    bool        protelExtensions = true;    // --no-protel-ext
    bool        jobFile = true;             // --no-job-file
    bool        zeroMaskExpansion = false;  // --zero-mask-expansion
    bool        zeroMaskMinWidth = false;   // --zero-mask-min-width
    int         precision = 0;              // --precision 5|6 (0: the job's default)
    // drill
    bool        separatePlated = false;     // --separate-plated
    bool        minimalHeader = false;      // --minimal-header
    bool        routeOvalHoles = false;     // --route-oval-holes
};


// Reads the option words. False on a word that is not an option of the kinds
// asked for: an error for the caller, never ignored (a caller that asked for
// options must not get the plain files back).
inline bool parseOptions( const std::vector<std::string>& aWords, bool aGerbers, bool aDrill,
                          OPTIONS& aOptions )
{
    for( size_t at = 0; at < aWords.size(); ++at )
    {
        const std::string& word = aWords[at];
        const bool         hasValue = at + 1 < aWords.size();

        if( aGerbers && word == "--layers" && hasValue )
        {
            aOptions.layers = aWords[++at];
        }
        else if( aGerbers && word == "--canonical-names" )
        {
            aOptions.canonicalNames = true;
        }
        else if( aGerbers && word == "--no-protel-ext" )
        {
            aOptions.protelExtensions = false;
        }
        else if( aGerbers && word == "--no-job-file" )
        {
            aOptions.jobFile = false;
        }
        else if( aGerbers && word == "--zero-mask-expansion" )
        {
            aOptions.zeroMaskExpansion = true;
        }
        else if( aGerbers && word == "--zero-mask-min-width" )
        {
            aOptions.zeroMaskMinWidth = true;
        }
        else if( aGerbers && word == "--precision" && hasValue )
        {
            const std::string& value = aWords[++at];

            if( value == "5" )
                aOptions.precision = 5;
            else if( value == "6" )
                aOptions.precision = 6;
            else
                return false;
        }
        else if( aDrill && word == "--separate-plated" )
        {
            aOptions.separatePlated = true;
        }
        else if( aDrill && word == "--minimal-header" )
        {
            aOptions.minimalHeader = true;
        }
        else if( aDrill && word == "--route-oval-holes" )
        {
            aOptions.routeOvalHoles = true;
        }
        else
        {
            return false;
        }
    }

    return true;
}


// Layer names, comma separated: KiCad's own (F.Cu) or the board's name for the
// layer. Empty with aError set on a name that is no layer.
inline LSEQ layerList( BOARD* aBoard, const wxString& aArg, std::string& aError )
{
    LSEQ seq;

    for( const wxString& token : wxSplit( aArg, ',' ) )
    {
        bool found = false;

        for( PCB_LAYER_ID layer : LSET::AllLayersMask() )
        {
            if( token == LSET::Name( layer ) || token == aBoard->GetLayerName( layer ) )
            {
                seq.push_back( layer );
                found = true;
                break;
            }
        }

        if( !found )
        {
            aError = "unknown layer '" + std::string( token.ToUTF8() ) + "'";
            return LSEQ();
        }
    }

    return seq;
}


// The layers a Gerber export plots, in plot order: the board's enabled layers
// in stackup order, or the ones asked for. 0, or kicad_tools' exit code with
// aError set: 2 a name that is no layer, 4 none of them is on this board.
inline int gerberLayers( BOARD* aBoard, const OPTIONS& aOptions, LSEQ& aLayers, std::string& aError )
{
    if( !aOptions.layers )
    {
        aLayers = aBoard->GetEnabledLayers().SeqStackupForPlotting();
        return 0;
    }

    const LSEQ asked = layerList( aBoard, wxString::FromUTF8( *aOptions.layers ), aError );

    if( asked.empty() )
        return 2;

    // A fixed list serves every board: a 2-layer board has no In1.Cu to plot.
    for( PCB_LAYER_ID layer : asked )
    {
        if( aBoard->IsLayerEnabled( layer ) )
            aLayers.push_back( layer );
    }

    if( aLayers.empty() )
    {
        aError = "the board has none of the layers asked for";
        return 4;
    }

    return 0;
}


// A manufacturer whose CAM sets the mask openings itself asks for the pads as
// drawn (expansion 0) and for no merged mask webs (minimum width 0). For the
// plot only, and put back, also when plotting throws: the other exports of a
// batch run on the same board, and in the editor it is the board on screen.
struct MASK_SETTINGS_GUARD
{
    BOARD_DESIGN_SETTINGS& m_bds;
    const int              m_expansion;
    const int              m_minWidth;

    MASK_SETTINGS_GUARD( BOARD_DESIGN_SETTINGS& aBds, bool aZeroExpansion, bool aZeroMinWidth ) :
            m_bds( aBds ),
            m_expansion( aBds.m_SolderMaskExpansion ),
            m_minWidth( aBds.m_SolderMaskMinWidth )
    {
        if( aZeroExpansion )
            m_bds.m_SolderMaskExpansion = 0;

        if( aZeroMinWidth )
            m_bds.m_SolderMaskMinWidth = 0;
    }

    ~MASK_SETTINGS_GUARD()
    {
        m_bds.m_SolderMaskExpansion = m_expansion;
        m_bds.m_SolderMaskMinWidth = m_minWidth;
    }

    MASK_SETTINGS_GUARD( const MASK_SETTINGS_GUARD& ) = delete;
    MASK_SETTINGS_GUARD& operator=( const MASK_SETTINGS_GUARD& ) = delete;
};


// KiCad's plot code sets a pad's size and shape for the layer it plots and
// sets them back afterwards (PlotStandardLayer in plot_board_layers.cpp). In a
// padstack with shapes per layer (PADSTACK::MODE::CUSTOM) that write also makes
// an entry for the plotted layer, mask and silkscreen included, and the entry
// stays. The saved file is the same, but the router takes the entry for a
// copper layer the next time it reads the board and stops on an assertion
// (pns_index.cpp). So such padstacks are kept before plotting, and one that
// came out with more layers is put back as it was, also when plotting throws.
class CUSTOM_PADSTACK_KEEPER
{
public:
    explicit CUSTOM_PADSTACK_KEEPER( BOARD* aBoard )
    {
        for( FOOTPRINT* footprint : aBoard->Footprints() )
        {
            for( PAD* pad : footprint->Pads() )
            {
                if( pad->Padstack().Mode() == PADSTACK::MODE::CUSTOM )
                    m_kept.push_back( { pad, pad->Padstack(), pad->Padstack().UniqueLayers().size() } );
            }
        }
    }

    ~CUSTOM_PADSTACK_KEEPER()
    {
        for( KEPT& kept : m_kept )
        {
            if( kept.pad->Padstack().UniqueLayers().size() == kept.layers )
                continue;

            kept.pad->SetPadstack( kept.padstack );
            kept.pad->SetDirty();
        }
    }

    CUSTOM_PADSTACK_KEEPER( const CUSTOM_PADSTACK_KEEPER& ) = delete;
    CUSTOM_PADSTACK_KEEPER& operator=( const CUSTOM_PADSTACK_KEEPER& ) = delete;

private:
    struct KEPT
    {
        PAD*     pad;
        PADSTACK padstack;
        size_t   layers;
    };

    std::vector<KEPT> m_kept;
};


// Mirrors PCBNEW_JOBS_HANDLER::JobExportGerbers with kicad-cli's defaults (a
// default-constructed JOB_EXPORT_PCB_GERBERS) unless an option says otherwise:
// one file per layer of aLayers (gerberLayers), a .gbrjob file, no board plot
// params, fills as they are. aPlotted counts the layers written.
inline bool gerbers( BOARD* aBoard, const wxString& aOutDir, REPORTER& aReporter,
                     const OPTIONS& aOptions, const LSEQ& aLayers, int* aPlotted = nullptr )
{
    const wxString outPath = withSlash( aOutDir );

    JOB_EXPORT_PCB_GERBERS gerberJob;
    gerberJob.m_useProtelFileExtension = aOptions.protelExtensions;
    gerberJob.m_createJobsFile = aOptions.jobFile;

    if( aOptions.precision )
        gerberJob.m_precision = aOptions.precision;

    PCB_PLOT_PARAMS plotOpts;
    PCB_PLOTTER::PlotJobToPlotOpts( plotOpts, &gerberJob, aReporter );

    MASK_SETTINGS_GUARD    maskGuard( aBoard->GetDesignSettings(), aOptions.zeroMaskExpansion,
                                      aOptions.zeroMaskMinWidth );
    GERBER_JOBFILE_WRITER  jobfileWriter( aBoard );
    CUSTOM_PADSTACK_KEEPER padstacks( aBoard );
    int  plotted = 0;
    bool failed = false;

    for( PCB_LAYER_ID layer : aLayers )
    {
        LSEQ plotSequence;
        plotSequence.push_back( layer );

        wxFileName gbrFn( aBoard->GetFileName() );
        wxString   layerName = aBoard->GetLayerName( layer );
        wxString   fileExt = plotOpts.GetUseGerberProtelExtensions()
                                     ? GetGerberProtelExtension( layer )
                                     : wxString( wxS( "gbr" ) );

        // KiCad's own name for the layer (F.SilkS) gives the same file name
        // on every board; the board's name may be anything its owner typed.
        BuildPlotFileName( &gbrFn, outPath,
                           aOptions.canonicalNames ? LSET::Name( layer ) : layerName, fileExt );
        wxString gbrName = gbrFn.GetFullName(); // AddGbrFile wants a non-const ref
        jobfileWriter.AddGbrFile( layer, gbrName );

        GERBER_PLOTTER* plotter = (GERBER_PLOTTER*) StartPlotBoard(
                aBoard, &plotOpts, layer, layerName, gbrFn.GetFullPath(), wxEmptyString,
                wxEmptyString );

        if( !plotter )
        {
            aReporter.Report( wxS( "failed to plot " ) + gbrFn.GetFullName(), RPT_SEVERITY_ERROR );
            failed = true;
            continue;
        }

        // The plotter does not own its render settings (StartPlotBoard made
        // them): both go, also when plotting throws.
        auto release = [&]()
        {
            delete plotter->RenderSettings();
            delete plotter;
        };

        try
        {
            PlotBoardLayers( aBoard, plotter, plotSequence, plotOpts );

            if( plotter->EndPlot() )
            {
                plotted++;
            }
            else
            {
                aReporter.Report( wxS( "failed to finish " ) + gbrFn.GetFullName(), RPT_SEVERITY_ERROR );
                failed = true;
            }
        }
        catch( ... )
        {
            release();
            throw;
        }

        release();
    }

    if( aOptions.jobFile )
    {
        wxFileName jobFn( aBoard->GetFileName() );
        BuildPlotFileName( &jobFn, outPath, wxS( "job" ), wxS( "gbrjob" ) );

        if( !jobfileWriter.CreateJobFile( jobFn.GetFullPath() ) )
        {
            aReporter.Report( wxS( "failed to write " ) + jobFn.GetFullName(), RPT_SEVERITY_ERROR );
            failed = true;
        }
    }

    if( aPlotted )
        *aPlotted = plotted;

    return !failed;
}


// Mirrors PCBNEW_JOBS_HANDLER::JobExportDrill's Excellon branch with the default
// JOB_EXPORT_PCB_DRILL options (kicad-cli defaults) unless an option says
// otherwise; no map files (the writer would drive a plotter for those).
inline bool drill( BOARD* aBoard, const wxString& aOutDir, REPORTER& aReporter,
                   const OPTIONS& aOptions = OPTIONS() )
{
    JOB_EXPORT_PCB_DRILL drillJob;

    // plugins 0027; each stays the job's default unless asked.
    if( aOptions.separatePlated )
        drillJob.m_excellonCombinePTHNPTH = false;

    if( aOptions.minimalHeader )
        drillJob.m_excellonMinimalHeader = true;

    if( aOptions.routeOvalHoles )
        drillJob.m_excellonOvalDrillRoute = true;

    VECTOR2I offset = drillJob.m_drillOrigin == JOB_EXPORT_PCB_DRILL::DRILL_ORIGIN::ABS
                              ? VECTOR2I( 0, 0 )
                              : aBoard->GetDesignSettings().GetAuxOrigin();

    EXCELLON_WRITER::ZEROS_FMT zeroFmt;

    switch( drillJob.m_zeroFormat )
    {
    case JOB_EXPORT_PCB_DRILL::ZEROS_FORMAT::KEEP_ZEROS: zeroFmt = EXCELLON_WRITER::KEEP_ZEROS; break;
    case JOB_EXPORT_PCB_DRILL::ZEROS_FORMAT::SUPPRESS_LEADING: zeroFmt = EXCELLON_WRITER::SUPPRESS_LEADING; break;
    case JOB_EXPORT_PCB_DRILL::ZEROS_FORMAT::SUPPRESS_TRAILING: zeroFmt = EXCELLON_WRITER::SUPPRESS_TRAILING; break;
    case JOB_EXPORT_PCB_DRILL::ZEROS_FORMAT::DECIMAL:
    default: zeroFmt = EXCELLON_WRITER::DECIMAL_FORMAT; break;
    }

    // The upstream precision tables are statics in UI/handler TUs; the values
    // are fixed (metric 3.3, inch 2.4).
    const bool      metric = drillJob.m_drillUnits == JOB_EXPORT_PCB_DRILL::DRILL_UNITS::MM;
    DRILL_PRECISION precision = metric ? DRILL_PRECISION( 3, 3 ) : DRILL_PRECISION( 2, 4 );

    EXCELLON_WRITER writer( aBoard );
    writer.SetFormat( metric, zeroFmt, precision.m_Lhs, precision.m_Rhs );
    writer.SetOptions( drillJob.m_excellonMirrorY, drillJob.m_excellonMinimalHeader, offset,
                       drillJob.m_excellonCombinePTHNPTH );
    writer.SetRouteModeForOvalHoles( drillJob.m_excellonOvalDrillRoute );
    writer.SetMapFileFormat( PLOT_FORMAT::PDF ); // unused: maps off

    return writer.CreateDrillandMapFilesSet( withSlash( aOutDir ), true /*drill*/, false /*map*/,
                                             &aReporter );
}


// The IPC356D_WRITER call of the PCB editor's own export, default settings; the
// nets are the board's (no connectivity rebuild needed).
inline bool ipc356( BOARD* aBoard, const wxString& aOutPath )
{
    IPC356D_WRITER writer( aBoard );
    return writer.Write( aOutPath );
}


// Manufacturer-agnostic placement and BOM data per footprint, and board metrics
// (plugins 0002). Coordinates are absolute board coordinates in mm, as they
// are: no Y flip, no aux-origin subtraction. What a manufacturer wants on top
// (PCBWay: aux-relative positions with Y negated) is the consumer's work.
inline bool fabComponents( BOARD* aBoard, const wxString& aOutPath )
{
    const BOX2I    bbox = aBoard->GetBoardEdgesBoundingBox();
    const VECTOR2I aux = aBoard->GetDesignSettings().GetAuxOrigin();

    nlohmann::json board;
    board["widthMm"] = pcbIUScale.IUTomm( bbox.GetWidth() );
    board["heightMm"] = pcbIUScale.IUTomm( bbox.GetHeight() );
    board["bboxOriginMm"] = { { "x", pcbIUScale.IUTomm( bbox.GetX() ) },
                              { "y", pcbIUScale.IUTomm( bbox.GetY() ) } };
    board["auxOriginMm"] = { { "x", pcbIUScale.IUTomm( aux.x ) },
                             { "y", pcbIUScale.IUTomm( aux.y ) } };
    board["copperLayers"] = aBoard->GetCopperLayerCount();
    board["thicknessMm"] = pcbIUScale.IUTomm( aBoard->GetDesignSettings().GetBoardThickness() );

    nlohmann::json footprints = nlohmann::json::array();

    for( FOOTPRINT* fp : aBoard->Footprints() )
    {
        const VECTOR2I pos = fp->GetPosition();
        const int      attrs = fp->GetAttributes();

        nlohmann::json f;
        f["ref"] = std::string( fp->GetReference().ToUTF8() );
        f["fpid"] = std::string( fp->GetFPID().GetUniStringLibId().ToUTF8() );
        f["side"] = fp->GetLayer() == B_Cu ? "bottom" : "top";
        f["posMm"] = { { "x", pcbIUScale.IUTomm( pos.x ) }, { "y", pcbIUScale.IUTomm( pos.y ) } };
        f["rotationDeg"] = fp->GetOrientationDegrees();
        f["smd"] = bool( attrs & FP_SMD );
        f["excludeFromPos"] = fp->IsExcludedFromPosFiles();
        f["excludeFromBom"] = fp->IsExcludedFromBOM();
        f["dnp"] = fp->IsDNP();

        nlohmann::json          fields = nlohmann::json::object();
        std::vector<PCB_FIELD*> fieldList;
        fp->GetFields( fieldList, false );

        for( PCB_FIELD* field : fieldList )
        {
            const wxString text = field->GetShownText( false );

            if( !text.IsEmpty() )
                fields[std::string( field->GetName().ToUTF8() )] = std::string( text.ToUTF8() );
        }

        f["fields"] = fields;
        footprints.push_back( f );
    }

    nlohmann::json j;
    j["board"] = board;
    j["footprints"] = footprints;

    std::ofstream out( aOutPath.fn_str() );
    out << j.dump( 2 ) << "\n";
    out.close();
    return !out.fail();
}


/**
 * The editor's batch: runs `aKindsCsv` (gerbers, drill, ipc356, fab-components;
 * comma separated) on `aBoard` into `aOutDir`/<kind>/, with the file names
 * kicad_tools --fab-batch writes. `aOptionWords` are the option words of
 * kicad_tools --fab-batch, one per line (--layers and its list are two lines).
 * Answers JSON:
 * { ok, ms, exports: [ { kind, ok, ms, files: [ { name, size } ], messages } ] },
 * or { ok: false, error: "BAD_OPTIONS" } with nothing run, on a word that is
 * not an option of the kinds asked for.
 */
inline std::string run( BOARD* aBoard, const std::string& aOutDir, const std::string& aKindsCsv,
                        const std::string& aOptionWords )
{
    using clock = std::chrono::steady_clock;
    nlohmann::json result;
    nlohmann::json exports = nlohmann::json::array();
    const auto     start = clock::now();
    bool           allOk = true;

    std::vector<std::string> kinds;
    std::stringstream        csv( aKindsCsv );

    for( std::string kind; std::getline( csv, kind, ',' ); )
    {
        if( !kind.empty() )
            kinds.push_back( kind );
    }

    const auto has = [&]( const char* aKind )
    {
        return std::find( kinds.begin(), kinds.end(), aKind ) != kinds.end();
    };

    std::vector<std::string> words;
    std::stringstream        lines( aOptionWords );

    for( std::string word; std::getline( lines, word, '\n' ); )
        words.push_back( word );

    OPTIONS options;

    if( !parseOptions( words, has( "gerbers" ), has( "drill" ), options ) )
        return R"({"ok":false,"error":"BAD_OPTIONS"})";

    for( const std::string& kind : kinds )
    {
        const auto         kindStart = clock::now();
        const wxString     dir = wxString::FromUTF8( aOutDir ) + wxS( "/" ) + wxString::FromUTF8( kind );
        WX_STRING_REPORTER reporter;
        bool               ok = false;

        if( kind != "gerbers" && kind != "drill" && kind != "ipc356" && kind != "fab-components" )
        {
            reporter.Report( wxS( "unknown export" ), RPT_SEVERITY_ERROR );
        }
        else if( !wxFileName::Mkdir( dir, wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
        {
            reporter.Report( wxS( "unable to create " ) + dir, RPT_SEVERITY_ERROR );
        }
        else
        {
            try
            {
                if( kind == "gerbers" )
                {
                    LSEQ        layers;
                    std::string layerError;

                    if( gerberLayers( aBoard, options, layers, layerError ) == 0 )
                        ok = gerbers( aBoard, dir, reporter, options, layers );
                    else
                        reporter.Report( wxString::FromUTF8( layerError ), RPT_SEVERITY_ERROR );
                }
                else if( kind == "drill" )
                {
                    ok = drill( aBoard, dir, reporter, options );
                }
                else if( kind == "ipc356" )
                    ok = ipc356( aBoard, dir + wxS( "/netlist.ipc" ) );
                else
                    ok = fabComponents( aBoard, dir + wxS( "/fab-components.json" ) );
            }
            catch( const std::exception& e )
            {
                reporter.Report( wxString::FromUTF8( e.what() ), RPT_SEVERITY_ERROR );
                ok = false;
            }
        }

        nlohmann::json files = nlohmann::json::array();
        wxArrayString  paths;

        if( wxDir::Exists( dir ) )
            wxDir::GetAllFiles( dir, &paths, wxEmptyString, wxDIR_FILES );

        paths.Sort();

        for( const wxString& path : paths )
        {
            wxFileName fn( path );
            files.push_back( { { "name", std::string( fn.GetFullName().ToUTF8() ) },
                               { "size", (long long) fn.GetSize().GetValue() } } );
        }

        allOk = allOk && ok;
        exports.push_back(
                { { "kind", kind },
                  { "ok", ok },
                  { "ms", std::chrono::duration<double, std::milli>( clock::now() - kindStart ).count() },
                  { "files", files },
                  { "messages", std::string( reporter.GetMessages().ToUTF8() ) } } );
    }

    result["ok"] = allOk;
    result["ms"] = std::chrono::duration<double, std::milli>( clock::now() - start ).count();
    result["exports"] = exports;
    return result.dump();
}

} // namespace pcbjam_fab_export
