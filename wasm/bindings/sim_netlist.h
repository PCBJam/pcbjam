/*
 * Live simulation, the second thing the page asks the schematic for: the SPICE
 * netlist of the whole hierarchy, written by KiCad's own exporter, with every
 * statement marked with the symbol it belongs to.
 *
 *  - kicadSimNetlist: {"lines":[{"text","ref"?,"kind"?}],"items":[{"ref",
 *    "name","device","type","off"?}],"messages":[{"severity","text"}],"ok"},
 *    or {"error":"..."} when no schematic is open or the export gave up.
 *
 *    lines     the netlist in KiCad's order, one entry per statement. A
 *              statement can be several text lines (a .model with its "+"
 *              lines, a text box with several directives). Joined with line
 *              ends they are the netlist as KiCad writes it.
 *      ref     the symbol the statement belongs to. Missing for the title,
 *              the includes, the directives drawn as text and ".end".
 *      kind    "item" (the symbol's own line) or "model" (a .model KiCad
 *              wrote for that symbol)
 *    items     every symbol KiCad made a SPICE item for, in netlist order
 *      name    the item's name in SPICE ("R1", "XU1")
 *      device  KiCad's kind of device ("R", "C", "D", "NPN", "SUBCKT",
 *              "SPICE", ...). Empty when KiCad has no model for the symbol:
 *              its line is then a placeholder that no simulator takes.
 *      type    the model type inside that kind ("", "POT", "DC", ...)
 *      off     only when true: the symbol's model is disabled in KiCad
 *              (Sim.Enable), so it has no line
 *    messages  what the exporter reported or wrote to the log, for example a
 *              model file that was not found. severity: "error", "warning"
 *              or "info".
 *    ok        false when there is an error among the messages: the netlist
 *              can miss symbols, or name a file that is not there
 *
 * What is left out on purpose: simulation commands drawn on the schematic
 * (.tran, .ac, ...) and the "save everything" lines. A live run sets both
 * itself. Include paths are resolved to full paths, so the page can read the
 * files from the editor's file system.
 *
 * Symbols excluded from simulation are not in the netlist at all; they are in
 * kicadSimSymbols (sim_symbols.h), marked.
 *
 * Nothing of KiCad's netlist rules is copied here. The exporter writes the
 * netlist through a formatter of ours, which gets one call per statement and
 * keeps them apart. Which symbol a statement belongs to is not guessed from
 * its text: the exporter's own item list is asked for each item's line and
 * model line, and a statement that is exactly one of them gets that item's
 * reference. No KiCad file changes.
 *
 * Included by eeschema_embind.cpp only. A read: it changes nothing in the
 * schematic. (Like every SPICE export of KiCad, it empties the IBIS model
 * cache folder first.)
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <exception>
#include <map>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <wx/log.h>
#include <wx/string.h>

#include <ki_exception.h>
#include <netlist_exporters/netlist_exporter_spice.h>
#include <reporter.h>
#include <richio.h>
#include <sch_edit_frame.h>
#include <schematic.h>
#include <sim/sim_model.h>
#include <sim/spice_generator.h>

#include "collab_common.h"

namespace pcbjam_sim {

// Keeps the statements apart: the exporter calls Print once per statement, and
// every Print arrives here as one write.
class STATEMENTS : public OUTPUTFORMATTER
{
public:
    std::vector<std::string> list;

protected:
    void write( const char* aOutBuf, int aCount ) override { list.emplace_back( aOutBuf, aCount ); }
};


// Collects what the exporter reports instead of showing it.
class MESSAGES : public REPORTER
{
public:
    nlohmann::json list = nlohmann::json::array();
    bool           hasError = false;

    void Add( const wxString& aText, const char* aSeverity )
    {
        hasError = hasError || std::string( aSeverity ) == "error";
        list.push_back( { { "severity", aSeverity }, { "text", pcbjam_collab::toUtf8( aText ) } } );
    }

    using REPORTER::Report;

    REPORTER& Report( const wxString& aText, SEVERITY aSeverity = RPT_SEVERITY_UNDEFINED ) override
    {
        // the base class keeps the severities seen; the exporter asks it for errors
        REPORTER::Report( aText, aSeverity );

        // A message without a severity counts as an error for the exporter, so it does here.
        if( aSeverity == RPT_SEVERITY_ERROR || aSeverity == RPT_SEVERITY_UNDEFINED )
            Add( aText, "error" );
        else if( aSeverity == RPT_SEVERITY_WARNING )
            Add( aText, "warning" );
        else
            Add( aText, "info" );

        return *this;
    }

    bool HasMessage() const override { return !list.empty(); }
};


// Some findings the exporter does not report: it writes them to wx's log (an include file
// it cannot find), and wx shows the log in a window when the editor is idle. The page asks
// in the background, so nothing may pop up. While one of these lives, errors and warnings
// that are logged go to the messages instead.
class LOG_CATCHER : public wxLog
{
public:
    explicit LOG_CATCHER( MESSAGES& aMessages ) :
            m_messages( aMessages ),
            m_previous( wxLog::SetActiveTarget( this ) )
    {
    }

    ~LOG_CATCHER() override { wxLog::SetActiveTarget( m_previous ); }

protected:
    void DoLogRecord( wxLogLevel aLevel, const wxString& aText, const wxLogRecordInfo& ) override
    {
        if( aLevel <= wxLOG_Error )
            m_messages.Add( aText, "error" );
        else if( aLevel == wxLOG_Warning )
            m_messages.Add( aText, "warning" );
    }

private:
    MESSAGES& m_messages;
    wxLog*    m_previous;
};


inline std::string netlist( SCH_EDIT_FRAME* aFrame )
{
    using nlohmann::json;
    using pcbjam_collab::toUtf8;

    // KiCad's own strings are not promised to be UTF-8; a bad byte is replaced, not thrown.
    const auto text = []( const json& aValue )
    {
        return aValue.dump( -1, ' ', false, json::error_handler_t::replace );
    };

    if( !aFrame )
        return "{\"error\":\"no schematic frame\"}";

    try
    {
        NETLIST_EXPORTER_SPICE exporter( &aFrame->Schematic() );
        STATEMENTS             statements;
        MESSAGES               messages;
        bool                   ok = false;

        {
            LOG_CATCHER logged( messages );

            ok = exporter.DoWriteNetlist( wxEmptyString, NETLIST_EXPORTER_SPICE::OPTION_ADJUST_INCLUDE_PATHS,
                                          statements, messages );
        }

        ok = ok && !messages.hasError;

        struct OWNER
        {
            const SPICE_ITEM* item;
            const char*       kind;
        };

        std::map<std::string, OWNER> owners;
        json                         items = json::array();

        for( const SPICE_ITEM& item : exporter.GetItems() )
        {
            const SIM_MODEL&       model = *item.model;
            const SPICE_GENERATOR& generator = model.SpiceGenerator();

            json entry = { { "ref", item.refName },
                           { "name", generator.ItemName( item ) },
                           { "device", model.GetDeviceInfo().fieldValue },
                           { "type", model.GetTypeInfo().fieldValue } };

            if( model.IsEnabled() )
            {
                owners[generator.ItemLine( item )] = { &item, "item" };

                const std::string modelLine = generator.ModelLine( item );

                if( !modelLine.empty() )
                    owners[modelLine] = { &item, "model" };
            }
            else
            {
                entry["off"] = true;
            }

            items.push_back( entry );
        }

        json lines = json::array();

        for( std::string& statement : statements.list )
        {
            const auto owner = owners.find( statement );

            while( !statement.empty() && ( statement.back() == '\n' || statement.back() == '\r' ) )
                statement.pop_back();

            if( statement.empty() )
                continue;

            json line = { { "text", statement } };

            if( owner != owners.end() )
            {
                line["ref"] = owner->second.item->refName;
                line["kind"] = owner->second.kind;
            }

            lines.push_back( line );
        }

        return text( { { "lines", lines }, { "items", items }, { "messages", messages.list }, { "ok", ok } } );
    }
    catch( const IO_ERROR& e )
    {
        return text( { { "error", toUtf8( e.What() ) } } );
    }
    catch( const std::exception& e )
    {
        return text( { { "error", std::string( e.what() ) } } );
    }
}

} // namespace pcbjam_sim

#endif // __EMSCRIPTEN__
