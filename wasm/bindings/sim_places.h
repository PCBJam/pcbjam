/*
 * Live simulation, where the symbols of the OPEN sheet are: what the page needs
 * to put a part's widgets (a zone to press, a glow, a slider) on its symbol and
 * to keep them there when the symbol is moved, rotated or mirrored.
 *
 *  - kicadSimPlaces: {"sheet","sheetPath","iuPerMm","symbols":[{"uuid","ref",
 *    "x","y","m":[a,b,c,d],"bbox":[x0,y0,x1,y1],"body":[x0,y0,x1,y1]}]}, or
 *    {"error":"..."} when no schematic is open.
 *
 *    sheet      the open sheet instance in words ("/", "/Key 1/"), as
 *               kicadSimSymbols names it
 *    sheetPath  the same instance as kicadSheetsGetTree names it (uuids)
 *    iuPerMm    how many of the numbers below make one millimetre
 *    ref        the reference in this sheet instance (a sheet that is used
 *               twice has the same symbols under other references)
 *    x, y       the symbol's place on the sheet (its origin)
 *    m          takes a point of the symbol's own drawing, as its library file
 *               has it (Y up), to the sheet: sheet = (x + a*px + b*py,
 *               y + c*px + d*py). It carries the rotation and the mirroring.
 *    bbox       the drawing and the pins, on the sheet, without any text
 *    body       the drawing alone
 *
 * Sheet numbers are KiCad's internal units with Y down, the same as the
 * viewport's (kicadCollabGetViewport) and kicadItemBBox's.
 *
 * Every symbol of the open sheet is listed, also the ones that are not
 * simulated: the page picks the ones it has widgets for by uuid.
 *
 * Included by eeschema_embind.cpp only. A pure read of what is on screen.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <string>

#include <nlohmann/json.hpp>

#include <base_units.h>
#include <sch_edit_frame.h>
#include <sch_screen.h>
#include <sch_sheet_path.h>
#include <sch_symbol.h>
#include <transform.h>

#include "collab_common.h"

namespace pcbjam_sim {

inline nlohmann::json boxOf( const BOX2I& aBox )
{
    BOX2I box = aBox;
    box.Normalize();
    return nlohmann::json::array( { box.GetLeft(), box.GetTop(), box.GetRight(), box.GetBottom() } );
}

inline std::string places( SCH_EDIT_FRAME* aFrame )
{
    using nlohmann::json;
    using pcbjam_collab::toUtf8;

    if( !aFrame )
        return "{\"error\":\"no schematic frame\"}";

    const SCH_SHEET_PATH& sheet = aFrame->GetCurrentSheet();
    SCH_SCREEN*           screen = sheet.LastScreen();

    if( !screen )
        return "{\"error\":\"no sheet is open\"}";

    json list = json::array();

    for( SCH_ITEM* item : screen->Items().OfType( SCH_SYMBOL_T ) )
    {
        const SCH_SYMBOL* sym = static_cast<const SCH_SYMBOL*>( item );
        const VECTOR2I    pos = sym->GetPosition();
        const TRANSFORM&  t = sym->GetTransform();

        // KiCad keeps a symbol's drawing with Y down; its library file has Y up.
        list.push_back( { { "uuid", toUtf8( sym->m_Uuid.AsString() ) },
                          { "ref", toUtf8( sym->GetRef( &sheet ) ) },
                          { "x", pos.x },
                          { "y", pos.y },
                          { "m", json::array( { t.x1, -t.y1, t.x2, -t.y2 } ) },
                          { "bbox", boxOf( sym->GetBodyAndPinsBoundingBox() ) },
                          { "body", boxOf( sym->GetBodyBoundingBox() ) } } );
    }

    return json( { { "sheet", toUtf8( sheet.PathHumanReadable() ) },
                   { "sheetPath", toUtf8( sheet.PathAsString() ) },
                   { "iuPerMm", schIUScale.IU_PER_MM },
                   { "symbols", list } } )
            .dump();
}

} // namespace pcbjam_sim

#endif // __EMSCRIPTEN__
