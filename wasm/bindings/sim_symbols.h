/*
 * Live simulation, what the page asks the schematic for: every symbol of the
 * whole hierarchy (not only the open sheet) with its fields, and for each of
 * its pins the net it is on, under the name KiCad's SPICE exporter writes for
 * that net.
 *
 *  - kicadSimSymbols: {"symbols":[{"uuid","ref","libId","value","sheet",
 *    "sheetPath","excluded"?,"fields":{name:text},"pins":{number:{"name",
 *    "node"?}}}]}, or {"error":"..."} when no schematic is open.
 *
 *    sheet      the sheet instance in words ("/", "/Key 1/")
 *    sheetPath  the same instance as kicadSheetsGetTree names it (uuids)
 *    excluded   only when true: the symbol or its sheet is excluded from
 *               simulation, so KiCad writes no SPICE line for it
 *    fields     every field that has text, by its English name, as shown
 *               (variables resolved); the reference is "ref"
 *    node       missing when the pin has no net
 *
 * The page matches these against the simulation library (@pcbjam/shared,
 * sim-library). Nothing here knows the library, and nothing is written into
 * the schematic.
 *
 * The walk is KiCad's own. The base class of its netlist exporters picks one
 * symbol per reference (the units of a multi-unit part are one part, power
 * symbols are left out), lists its pins and names their nets; the SPICE
 * exporter's own function turns a net name into a SPICE node name. Deriving
 * from the base class opens its two protected functions to us, so no KiCad
 * file changes and none of KiCad's rules is copied here.
 *
 * Included by eeschema_embind.cpp only. A pure read: the connection graph is
 * current after every commit (local or collab).
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <string>

#include <nlohmann/json.hpp>
#include <wx/string.h>

#include <netlist_exporters/netlist_exporter_base.h>
#include <netlist_exporters/netlist_exporter_spice.h>
#include <sch_edit_frame.h>
#include <sch_field.h>
#include <sch_screen.h>
#include <sch_sheet_path.h>
#include <sch_symbol.h>
#include <schematic.h>
#include <string_utils.h>
#include <template_fieldnames.h>

#include "collab_common.h"

namespace pcbjam_sim {

// KiCad's netlist walk, with the two functions we call made public.
class SYMBOL_WALK : public NETLIST_EXPORTER_BASE
{
public:
    explicit SYMBOL_WALK( SCHEMATIC* aSchematic ) : NETLIST_EXPORTER_BASE( aSchematic ) {}

    using NETLIST_EXPORTER_BASE::CreatePinList;
    using NETLIST_EXPORTER_BASE::findNextSymbol;
};

// A pin's name as drawn. CreatePinList reports it as "<name>_<number>", or as
// the number alone when the pin has no name.
inline wxString shownPinName( const PIN_INFO& aPin )
{
    if( aPin.pinName == aPin.num )
        return wxEmptyString;

    const wxString tail = wxT( "_" ) + aPin.num;

    if( aPin.pinName.EndsWith( tail ) )
        return aPin.pinName.Left( aPin.pinName.length() - tail.length() );

    return aPin.pinName;
}

inline std::string symbols( SCH_EDIT_FRAME* aFrame )
{
    using nlohmann::json;
    using pcbjam_collab::toUtf8;

    if( !aFrame )
        return "{\"error\":\"no schematic frame\"}";

    SCHEMATIC&     sch = aFrame->Schematic();
    const wxString variant = sch.GetCurrentVariant();
    SYMBOL_WALK    walk( &sch );
    json           list = json::array();

    for( const SCH_SHEET_PATH& sheet : sch.Hierarchy() )
    {
        SCH_SCREEN* screen = sheet.LastScreen();

        if( !screen )
            continue;

        // The SPICE exporter drops such a sheet with everything on it.
        const bool sheetExcluded = sheet.GetExcludedFromSim();

        for( SCH_ITEM* item : screen->Items().OfType( SCH_SYMBOL_T ) )
        {
            SCH_SYMBOL* sym = walk.findNextSymbol( item, sheet );

            if( !sym )
                continue;

            json fields = json::object();

            for( const SCH_FIELD& field : sym->GetFields() )
            {
                if( field.GetId() == FIELD_T::REFERENCE )
                    continue;

                const wxString text = field.GetShownText( &sheet, false, 0, variant );

                if( !text.IsEmpty() )
                    fields[toUtf8( field.GetCanonicalName() )] = toUtf8( text );
            }

            json pins = json::object();

            for( const PIN_INFO& pin : walk.CreatePinList( sym, sheet, true ) )
            {
                json entry = { { "name", toUtf8( shownPinName( pin ) ) } };

                wxString node = UnescapeString( pin.netName );
                NETLIST_EXPORTER_SPICE::ConvertToSpiceMarkup( &node );

                if( !node.IsEmpty() )
                    entry["node"] = toUtf8( node );

                pins[toUtf8( pin.num )] = entry;
            }

            json entry = { { "uuid", toUtf8( sym->m_Uuid.AsString() ) },
                           { "ref", toUtf8( sym->GetRef( &sheet ) ) },
                           { "libId", toUtf8( sym->GetLibId().Format().wx_str() ) },
                           { "value", toUtf8( sym->GetValue( true, &sheet, false, variant ) ) },
                           { "sheet", toUtf8( sheet.PathHumanReadable() ) },
                           { "sheetPath", toUtf8( sheet.PathAsString() ) },
                           { "fields", fields },
                           { "pins", pins } };

            if( sheetExcluded || sym->ResolveExcludedFromSim( &sheet, variant ) )
                entry["excluded"] = true;

            list.push_back( entry );
        }
    }

    return json( { { "symbols", list } } ).dump();
}

} // namespace pcbjam_sim

#endif // __EMSCRIPTEN__
