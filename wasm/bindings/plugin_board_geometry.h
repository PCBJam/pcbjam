/*
 * Plugin platform `board.geometry` — the open board as finished shapes.
 *
 * A plugin otherwise receives file data ("a roundrect pad, 25% radius, rotated 45°…") and has to
 * re-derive every outline; text in an outline font cannot be derived from file data at all. The
 * engine already knows how to draw all of it, so this hands out what it draws: pads, graphics and
 * text as polygons, footprints with their fields and bounding boxes, optionally tracks, vias and
 * zone fills. Same data a plugin with documents:read can already read — no new disclosure.
 *
 * Contract (the plugin boundary is on the other side of this, in package-host.ts):
 *  - READ-ONLY walk of the live BOARD. Classified PURE-READ in the embind audit
 *    (docs/features/async/18-embind-audit.md): stays synchronous, and like every model-walking
 *    read it returns early while an open is in flight (open_gate.h) instead of walking a
 *    half-built board.
 *  - Nothing a plugin writes reaches this code: the options are three booleans, the cursor is
 *    produced by this file and range-checked on the way back in.
 *  - Bounded per call: stops after aBudgetMs or aMaxChars and returns a cursor. The caller rests
 *    between calls, so a large board never holds the UI thread (one zone outline is the largest
 *    indivisible unit).
 *  - The cursor carries BOARD::GetTimeStamp(); a board that changed between calls answers
 *    CHANGED rather than resuming with shifted indices.
 *
 * Reply: one envelope line `{"ok":true,"next":<cursor|null>}` then newline-delimited JSON records.
 * Lengths are millimetres with 0.1 µm resolution, KiCad axes (Y grows downwards), angles degrees.
 */

#ifndef PCBJAM_PLUGIN_BOARD_GEOMETRY_H
#define PCBJAM_PLUGIN_BOARD_GEOMETRY_H

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <nlohmann/json.hpp>
#include <string>

#include <board.h>
#include <board_design_settings.h>
#include <footprint.h>
#include <geometry/shape_poly_set.h>
#include <lset.h>
#include <pad.h>
#include <pcb_field.h>
#include <pcb_shape.h>
#include <pcb_text.h>
#include <pcb_textbox.h>
#include <pcb_track.h>
#include <zone.h>

#include "collab_common.h"
#include "open_gate.h"

namespace pcbjam_plugin_geometry
{

inline int version()
{
    return 1;
}

// Rendering accuracy for arcs and circles: 20 µm keeps a 1 mm pad round on any screen
// without the point counts of the board's manufacturing tolerance.
static constexpr int ARC_ERROR = 20000;

enum SECTION
{
    S_BOARD = 0,
    S_FOOTPRINTS,
    S_DRAWINGS,
    S_TRACKS,
    S_ZONES,
    S_DONE
};

struct WRITER
{
    std::string out;

    void mm( int aNm )
    {
        long long v = aNm;
        bool      neg = v < 0;

        if( neg )
            v = -v;

        long long units = ( v + 50 ) / 100; // 0.1 µm
        long long whole = units / 10000, frac = units % 10000;

        if( neg && units )
            out += '-';

        out += std::to_string( whole );

        if( frac )
        {
            char digits[5] = { char( '0' + frac / 1000 ), char( '0' + frac / 100 % 10 ),
                               char( '0' + frac / 10 % 10 ), char( '0' + frac % 10 ), 0 };
            int  len = 4;

            while( len && digits[len - 1] == '0' )
                digits[--len] = 0;

            out += '.';
            out += digits;
        }
    }

    void point( const VECTOR2I& aPt )
    {
        out += '[';
        mm( aPt.x );
        out += ',';
        mm( aPt.y );
        out += ']';
    }

    void chain( const SHAPE_LINE_CHAIN& aChain )
    {
        out += '[';

        for( int i = 0; i < aChain.PointCount(); i++ )
        {
            if( i )
                out += ',';

            point( aChain.CPoint( i ) );
        }

        out += ']';
    }

    /** One outline with its holes: {"outline":[[x,y]…],"holes":[[[x,y]…]…]} (holes omitted if none). */
    void polygon( const SHAPE_POLY_SET& aSet, int aOutline )
    {
        out += "{\"outline\":";
        chain( aSet.COutline( aOutline ) );

        if( aSet.HoleCount( aOutline ) )
        {
            out += ",\"holes\":[";

            for( int h = 0; h < aSet.HoleCount( aOutline ); h++ )
            {
                if( h )
                    out += ',';

                chain( aSet.CHole( aOutline, h ) );
            }

            out += ']';
        }

        out += '}';
    }

    void polygons( const SHAPE_POLY_SET& aSet )
    {
        out += '[';

        for( int o = 0; o < aSet.OutlineCount(); o++ )
        {
            if( o )
                out += ',';

            polygon( aSet, o );
        }

        out += ']';
    }

    /** Design strings are user data. A byte sequence that is not UTF-8 must degrade to U+FFFD,
     *  never throw: an exception out of an embind call aborts the engine. */
    void text( const wxString& aText )
    {
        out += nlohmann::json( pcbjam_collab::toUtf8( aText ) )
                       .dump( -1, ' ', false, nlohmann::json::error_handler_t::replace );
    }

    void box( const BOX2I& aBox )
    {
        out += '[';
        mm( aBox.GetLeft() );
        out += ',';
        mm( aBox.GetTop() );
        out += ',';
        mm( aBox.GetRight() );
        out += ',';
        mm( aBox.GetBottom() );
        out += ']';
    }
};

/** Layers whose graphics are worth drawing next to a BOM: silkscreen, fabrication, courtyard, edge. */
inline bool drawnLayer( PCB_LAYER_ID aLayer )
{
    switch( aLayer )
    {
    case F_SilkS:
    case B_SilkS:
    case F_Fab:
    case B_Fab:
    case F_CrtYd:
    case B_CrtYd:
    case Edge_Cuts: return true;
    default: return false;
    }
}

/** A graphic or text item as {"layer","polygons"[, "text"]}; false if it draws nothing here. */
inline bool drawing( WRITER& aW, const BOARD_ITEM* aItem, const FOOTPRINT* aParent )
{
    PCB_LAYER_ID layer = aItem->GetLayer();

    if( !drawnLayer( layer ) )
        return false;

    SHAPE_POLY_SET poly;
    const char*    kind = nullptr;

    switch( aItem->Type() )
    {
    case PCB_SHAPE_T:
        static_cast<const PCB_SHAPE*>( aItem )->TransformShapeToPolySet( poly, layer, 0, ARC_ERROR, ERROR_INSIDE );
        break;

    case PCB_FIELD_T:
    case PCB_TEXT_T:
    {
        const PCB_TEXT* text = static_cast<const PCB_TEXT*>( aItem );

        if( !text->IsVisible() || text->GetShownText( true ).IsEmpty() )
            return false;

        text->TransformTextToPolySet( poly, 0, ARC_ERROR, ERROR_INSIDE );
        kind = "text";

        if( aItem->Type() == PCB_FIELD_T )
        {
            const PCB_FIELD* field = static_cast<const PCB_FIELD*>( aItem );
            kind = field->IsReference() ? "reference" : field->IsValue() ? "value" : "field";
        }

        break;
    }

    case PCB_TEXTBOX_T:
        static_cast<const PCB_TEXTBOX*>( aItem )->TransformTextToPolySet( poly, 0, ARC_ERROR, ERROR_INSIDE );
        kind = "text";
        break;

    default: return false;
    }

    if( !poly.OutlineCount() )
        return false;

    aW.out += "{\"layer\":";
    aW.text( LSET::Name( layer ) );

    if( kind )
    {
        aW.out += ",\"text\":\"";
        aW.out += kind;
        aW.out += '"';
    }

    aW.out += ",\"polygons\":";
    aW.polygons( poly );
    aW.out += '}';
    (void) aParent;
    return true;
}

inline void padRecord( WRITER& aW, const PAD* aPad )
{
    aW.out += "{\"id\":";
    aW.text( aPad->m_Uuid.AsString() );
    aW.out += ",\"number\":";
    aW.text( aPad->GetNumber() );
    aW.out += ",\"net\":";
    aW.text( aPad->GetNetname() );

    if( !aPad->GetPinFunction().IsEmpty() )
    {
        aW.out += ",\"pinFunction\":";
        aW.text( aPad->GetPinFunction() );
    }

    const char* type = "smd";

    switch( aPad->GetAttribute() )
    {
    case PAD_ATTRIB::PTH: type = "tht"; break;
    case PAD_ATTRIB::NPTH: type = "npth"; break;
    case PAD_ATTRIB::CONN: type = "connector"; break;
    default: break;
    }

    aW.out += ",\"type\":\"";
    aW.out += type;
    aW.out += "\",\"pos\":";
    aW.point( aPad->GetPosition() );
    aW.out += ",\"polygons\":{";

    bool first = true;

    for( PCB_LAYER_ID side : { F_Cu, B_Cu } )
    {
        if( !aPad->IsOnLayer( side ) )
            continue;

        SHAPE_POLY_SET poly;
        aPad->TransformShapeToPolygon( poly, side, 0, ARC_ERROR, ERROR_INSIDE );

        if( !poly.OutlineCount() )
            continue;

        aW.out += first ? "\"" : ",\"";
        aW.out += side == F_Cu ? 'F' : 'B';
        aW.out += "\":";
        aW.polygons( poly );
        first = false;
    }

    aW.out += '}';

    if( aPad->HasHole() )
    {
        SHAPE_POLY_SET hole;

        if( aPad->TransformHoleToPolygon( hole, 0, ARC_ERROR, ERROR_INSIDE ) && hole.OutlineCount() )
        {
            aW.out += ",\"hole\":";
            aW.polygons( hole );
        }
    }

    aW.out += '}';
}

inline void footprintRecord( WRITER& aW, const FOOTPRINT* aFp )
{
    aW.out += "{\"$\":\"footprint\",\"id\":";
    aW.text( aFp->m_Uuid.AsString() );
    aW.out += ",\"ref\":";
    aW.text( aFp->GetReference() );
    aW.out += ",\"value\":";
    aW.text( aFp->GetValue() );
    aW.out += ",\"footprint\":";
    aW.text( aFp->GetFPIDAsString() );
    aW.out += ",\"side\":\"";
    aW.out += aFp->IsFlipped() ? 'B' : 'F';
    aW.out += "\",\"pos\":";
    aW.point( aFp->GetPosition() );
    aW.out += ",\"angle\":";
    aW.out += nlohmann::json( aFp->GetOrientationDegrees() ).dump();
    aW.out += ",\"bbox\":";
    aW.box( aFp->GetBoundingBox( false ) );

    int attrs = aFp->GetAttributes();
    aW.out += ",\"attrs\":{\"smd\":";
    aW.out += ( attrs & FP_SMD ) ? "true" : "false";
    aW.out += ",\"tht\":";
    aW.out += ( attrs & FP_THROUGH_HOLE ) ? "true" : "false";
    aW.out += ",\"dnp\":";
    aW.out += ( attrs & FP_DNP ) ? "true" : "false";
    aW.out += ",\"excludeFromBom\":";
    aW.out += ( attrs & FP_EXCLUDE_FROM_BOM ) ? "true" : "false";
    aW.out += ",\"excludeFromPos\":";
    aW.out += ( attrs & FP_EXCLUDE_FROM_POS_FILES ) ? "true" : "false";
    aW.out += ",\"boardOnly\":";
    aW.out += ( attrs & FP_BOARD_ONLY ) ? "true" : "false";
    aW.out += "},\"fields\":{";

    bool first = true;

    for( const PCB_FIELD* field : aFp->GetFields() )
    {
        if( !field || field->IsReference() || field->IsValue() )
            continue;

        if( !first )
            aW.out += ',';

        aW.text( field->GetName() );
        aW.out += ':';
        aW.text( field->GetText() );
        first = false;
    }

    aW.out += "},\"pads\":[";
    first = true;

    for( const PAD* pad : aFp->Pads() )
    {
        if( !first )
            aW.out += ',';

        padRecord( aW, pad );
        first = false;
    }

    aW.out += "],\"drawings\":[";
    first = true;

    auto emit = [&]( const BOARD_ITEM* aItem )
    {
        size_t mark = aW.out.size();

        if( !first )
            aW.out += ',';

        if( drawing( aW, aItem, aFp ) )
            first = false;
        else
            aW.out.resize( mark );
    };

    for( const PCB_FIELD* field : aFp->GetFields() )
    {
        if( field )
            emit( field );
    }

    for( const BOARD_ITEM* item : aFp->GraphicalItems() )
        emit( item );

    aW.out += "]}\n";
}

inline std::string refuse( const char* aCode )
{
    return std::string( "{\"ok\":false,\"error\":\"" ) + aCode + "\"}\n";
}

/**
 * @param aBoard        the live board (caller resolved the frame)
 * @param aOptionsJson  {"tracks":bool,"zones":bool} — booleans only
 * @param aCursorJson   "" to begin, else the `next` of the previous reply
 */
inline std::string read( BOARD* aBoard, const std::string& aOptionsJson, const std::string& aCursorJson,
                         double aBudgetMs, int aMaxChars )
{
    using json = nlohmann::json;

    if( pcbjam_open::busy() )
        return refuse( "BUSY" );

    if( !aBoard )
        return refuse( "NO_BOARD" );

    json options = json::parse( aOptionsJson, nullptr, false );

    if( options.is_discarded() || !options.is_object() )
        return refuse( "INVALID" );

    const bool wantTracks = options.value( "tracks", json( false ) ) == json( true );
    const bool wantZones = options.value( "zones", json( false ) ) == json( true );

    int section = S_BOARD, index = 0, sub = 0;
    int stamp = aBoard->GetTimeStamp();

    if( !aCursorJson.empty() )
    {
        json cursor = json::parse( aCursorJson, nullptr, false );

        if( cursor.is_discarded() || !cursor.is_object() || !cursor.value( "s", json() ).is_number_integer()
            || !cursor.value( "i", json() ).is_number_integer() || !cursor.value( "j", json() ).is_number_integer()
            || !cursor.value( "t", json() ).is_number_integer() )
        {
            return refuse( "INVALID" );
        }

        section = cursor["s"].get<int>();
        index = cursor["i"].get<int>();
        sub = cursor["j"].get<int>();

        if( section < S_BOARD || section >= S_DONE || index < 0 || sub < 0 )
            return refuse( "INVALID" );

        if( cursor["t"].get<int>() != stamp )
            return refuse( "CHANGED" );
    }

    if( aBudgetMs < 1 || aBudgetMs > 50 || aMaxChars < 1024 || aMaxChars > 4 * 1024 * 1024 )
        return refuse( "INVALID" );

    const double deadline = emscripten_get_now() + aBudgetMs;
    WRITER       w;
    auto         spent = [&]() { return emscripten_get_now() >= deadline || (int) w.out.size() >= aMaxChars; };

    // Net names once, so tracks and zones can refer to them by index.
    auto netIndex = [&]( const BOARD_CONNECTED_ITEM* aItem ) { return aItem->GetNetCode(); };

    while( section != S_DONE && !spent() )
    {
        switch( section )
        {
        case S_BOARD:
        {
            w.out += "{\"$\":\"board\",\"units\":\"mm\",\"bbox\":";
            w.box( aBoard->GetBoardEdgesBoundingBox() );

            SHAPE_POLY_SET outline;

            // Unparseable edges leave the outline empty; the edge drawings are still sent below.
            if( aBoard->GetBoardPolygonOutlines( outline, true, nullptr, false, false ) )
            {
                w.out += ",\"outline\":";
                w.polygons( outline );
            }
            else
            {
                w.out += ",\"outline\":[]";
            }

            w.out += ",\"footprints\":" + std::to_string( aBoard->Footprints().size() );

            if( wantTracks || wantZones )
            {
                w.out += ",\"nets\":{";
                bool first = true;

                for( const NETINFO_ITEM* net : aBoard->GetNetInfo() )
                {
                    if( !net || net->GetNetCode() <= 0 )
                        continue;

                    if( !first )
                        w.out += ',';

                    w.out += '"' + std::to_string( net->GetNetCode() ) + "\":";
                    w.text( net->GetNetname() );
                    first = false;
                }

                w.out += '}';
            }

            w.out += "}\n";
            section = S_FOOTPRINTS;
            index = 0;
            break;
        }

        case S_FOOTPRINTS:
        {
            const auto& fps = aBoard->Footprints();

            if( index >= (int) fps.size() )
            {
                section = S_DRAWINGS;
                index = 0;
                break;
            }

            footprintRecord( w, fps[index++] );
            break;
        }

        case S_DRAWINGS:
        {
            const auto& items = aBoard->Drawings();

            if( index >= (int) items.size() )
            {
                section = wantTracks ? S_TRACKS : wantZones ? S_ZONES : S_DONE;
                index = 0;
                break;
            }

            size_t mark = w.out.size();
            w.out += "{\"$\":\"drawing\",\"item\":";

            if( drawing( w, items[index++], nullptr ) )
                w.out += "}\n";
            else
                w.out.resize( mark );

            break;
        }

        case S_TRACKS:
        {
            const auto& tracks = aBoard->Tracks();

            if( index >= (int) tracks.size() )
            {
                section = wantZones ? S_ZONES : S_DONE;
                index = 0;
                break;
            }

            // Batches keep the record count sane on boards with tens of thousands of segments.
            w.out += "{\"$\":\"tracks\",\"items\":[";
            bool first = true;

            for( int n = 0; n < 256 && index < (int) tracks.size(); n++, index++ )
            {
                const PCB_TRACK* track = tracks[index];

                if( !first )
                    w.out += ',';

                first = false;

                if( track->Type() == PCB_VIA_T )
                {
                    const PCB_VIA* via = static_cast<const PCB_VIA*>( track );
                    w.out += "{\"via\":";
                    w.point( via->GetPosition() );
                    w.out += ",\"diameter\":";
                    w.mm( via->GetWidth( F_Cu ) );
                    w.out += ",\"drill\":";
                    w.mm( via->GetDrillValue() );
                }
                else
                {
                    // An arc is sent as the polygon the engine would paint, a segment as two points.
                    w.out += "{\"layer\":";
                    w.text( LSET::Name( track->GetLayer() ) );
                    w.out += ",\"width\":";
                    w.mm( track->GetWidth() );

                    if( track->Type() == PCB_ARC_T )
                    {
                        SHAPE_POLY_SET poly;
                        track->TransformShapeToPolygon( poly, track->GetLayer(), 0, ARC_ERROR, ERROR_INSIDE );
                        w.out += ",\"polygons\":";
                        w.polygons( poly );
                    }
                    else
                    {
                        w.out += ",\"start\":";
                        w.point( track->GetStart() );
                        w.out += ",\"end\":";
                        w.point( track->GetEnd() );
                    }
                }

                w.out += ",\"net\":" + std::to_string( netIndex( track ) ) + "}";
            }

            w.out += "]}\n";
            break;
        }

        case S_ZONES:
        {
            const auto& zones = aBoard->Zones();

            if( index >= (int) zones.size() )
            {
                section = S_DONE;
                break;
            }

            const ZONE* zone = zones[index];

            // `sub` walks (layer, outline) pairs so that one record is one filled outline:
            // the largest indivisible unit of work in this file.
            int  seen = 0;
            bool emitted = false;

            if( !zone->GetIsRuleArea() && zone->IsFilled() )
            {
                for( PCB_LAYER_ID layer : zone->GetLayerSet().Seq() )
                {
                    std::shared_ptr<SHAPE_POLY_SET> fill = zone->GetFilledPolysList( layer );

                    if( !fill )
                        continue;

                    for( int o = 0; o < fill->OutlineCount(); o++, seen++ )
                    {
                        if( seen < sub )
                            continue;

                        w.out += "{\"$\":\"zone\",\"id\":";
                        w.text( zone->m_Uuid.AsString() );
                        w.out += ",\"layer\":";
                        w.text( LSET::Name( layer ) );
                        w.out += ",\"net\":" + std::to_string( netIndex( zone ) ) + ",\"polygon\":";
                        w.polygon( *fill, o );
                        w.out += "}\n";
                        sub = seen + 1;
                        emitted = true;
                        break;
                    }

                    if( emitted )
                        break;
                }
            }

            if( !emitted )
            {
                index++;
                sub = 0;
            }

            break;
        }

        default: section = S_DONE; break;
        }
    }

    std::string envelope = "{\"ok\":true,\"next\":";

    if( section == S_DONE )
        envelope += "null";
    else
        envelope += json( { { "s", section }, { "i", index }, { "j", sub }, { "t", stamp } } ).dump();

    return envelope + "}\n" + w.out;
}

} // namespace pcbjam_plugin_geometry

#endif // __EMSCRIPTEN__
#endif // PCBJAM_PLUGIN_BOARD_GEOMETRY_H
