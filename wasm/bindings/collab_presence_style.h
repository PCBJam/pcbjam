/*
 * Presence overlay styling (collab-presence tuner) — shared by the pcbnew and
 * eeschema binding TUs so the drawing never diverges between editors.
 *
 * Every visual knob of the remote-presence rendering (selection boxes, name
 * tags, cursors, comment pin dots) lives in STYLE, JSON-patchable at runtime
 * via kicadCollabSetStyle — the dev-time PresenceTuner panel drives it to find
 * the look we want; the chosen values then become the defaults here.
 * Defaults == the shipped look.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include <font/text_attributes.h>
#include <gal/color4d.h>
#include <gal/graphics_abstraction_layer.h>
#include <geometry/eda_angle.h>
#include <geometry/shape_poly_set.h>
#include <math/util.h>
#include <math/box2.h>
#include <view/view.h>
#include <view/view_overlay.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>
#include <wx/string.h>

namespace pcbjam_presence {

using json = nlohmann::json;

// Defaults = the SHIPPED look, picked with the PresenceTuner 2026-07-07.
struct STYLE
{
    // ── selection box ──────────────────────────────────────────────────────
    // 0 rect · 1 corner brackets · 2 underline · 3 rounded rect · 4 filled only
    // 5 exact item outline (pcbnew; eeschema falls back to rect)
    int    selShape       = 5;
    double selStrokeWidth = 6.0;   // px
    double selStrokeAlpha = 0.7;
    double selFillAlpha   = 0.46;  // 0 = no fill
    double selPaddingPx   = 4.0;   // bbox inflate
    double selCornerPx    = 8.0;   // bracket arm length / rounding radius

    // ── selection name tag ────────────────────────────────────────────────
    bool   labelShow     = true;
    double labelSizePx   = 7.5;
    bool   labelChip     = true;   // filled background chip + contrast text
    int    labelVPos     = 1;      // 0 top · 1 bottom
    int    labelHPos     = 1;      // 0 start · 1 end · 2 center
    bool   labelInside   = false;  // inside vs outside the box
    double labelOffsetPx = 0.0;
    // Chip background opacity (label AND cursor chips) — matches the border
    // alpha so badges sit consistently with the selection strokes.
    double chipBgAlpha   = 0.7;

    // ── remote cursor ─────────────────────────────────────────────────────
    // 0 cross · 1 pointer triangle · 2 circle + dot
    int    cursorShape        = 0;
    double cursorSizePx       = 8.0;
    double cursorWidthPx      = 3.0;
    double cursorAlpha        = 1.0;
    bool   cursorLabel        = true;
    double cursorLabelSizePx  = 10.0;
    bool   cursorLabelChip    = true;

    // ── colors ────────────────────────────────────────────────────────────
    // fixedColor: every peer in ONE color ("" = off). palette: recolor peers
    // by name hash from this list ([] = off) — for trying palettes without
    // changing what senders publish. Peer-provided color is the fallback.
    std::string              fixedColor;
    std::vector<std::string> palette;

    // ── comment pins ──────────────────────────────────────────────────────
    // 0 circle dot · 1 figma-style bubble: a round body whose bottom-left
    // corner is squared off — the SHARP CORNER is the anchored point
    // (comments-ux 0001 A, reshaped per user feedback 2026-07-24).
    // Shipped look picked with the tuner 2026-07-24: r9 body, 4px ring,
    // slightly translucent ring+fill. pinRadiusPx is MIRRORED in the
    // standalone's pin-geometry.ts (DEFAULT_PIN_RADIUS_PX) — change together.
    int    pinShape        = 1;
    double pinRadiusPx     = 9.0;
    double pinRingPx       = 4.0;
    double pinRingAlpha    = 0.9;
    double pinFillAlpha    = 0.9;
    double pinResolvedAlpha = 0.3;
    std::string pinUnreadRingColor = "#ffb020"; // unread accent ring ("" = plain white)

    // ── cross-app "ghost" selection (0006) ────────────────────────────────
    // A peer's selection in the OTHER editor (eeschema symbol ⇄ pcbnew
    // footprint) renders with the normal selection shape but its stroke/fill
    // alphas scaled down, so a cross-probe highlight reads distinctly softer
    // than a direct same-document selection.
    double xselAlphaScale = 0.55;

};

/**
 * Shipped eeschema defaults (picked with the PresenceTuner 2026-07-07): the
 * schematic canvas is light and sparse, so the exact-outline highlight wears
 * a hairline stroke, a subtler fill and a softer cursor than pcbnew's.
 * Everything else matches the struct (= pcbnew) defaults.
 */
inline STYLE eeschemaDefaultStyle()
{
    STYLE s;
    s.selStrokeWidth = 1.0;
    s.selFillAlpha   = 0.14;
    s.cursorAlpha    = 0.5;
    return s;
}

inline KIGFX::COLOR4D parseHexColor( const std::string& aHex, const KIGFX::COLOR4D& aFallback )
{
    if( aHex.size() == 7 && aHex[0] == '#' )
    {
        long v = strtol( aHex.c_str() + 1, nullptr, 16 );
        return KIGFX::COLOR4D( ( ( v >> 16 ) & 0xff ) / 255.0, ( ( v >> 8 ) & 0xff ) / 255.0,
                               ( v & 0xff ) / 255.0, 1.0 );
    }

    return aFallback;
}

/** Patch aStyle from a (partial) JSON object — unknown keys ignored, absent
 *  keys keep their value, so the tuner can send full or incremental states. */
inline void patchStyle( STYLE& aStyle, const json& j )
{
    aStyle.selShape       = j.value( "selShape", aStyle.selShape );
    aStyle.selStrokeWidth = j.value( "selStrokeWidth", aStyle.selStrokeWidth );
    aStyle.selStrokeAlpha = j.value( "selStrokeAlpha", aStyle.selStrokeAlpha );
    aStyle.selFillAlpha   = j.value( "selFillAlpha", aStyle.selFillAlpha );
    aStyle.selPaddingPx   = j.value( "selPaddingPx", aStyle.selPaddingPx );
    aStyle.selCornerPx    = j.value( "selCornerPx", aStyle.selCornerPx );

    aStyle.labelShow     = j.value( "labelShow", aStyle.labelShow );
    aStyle.labelSizePx   = j.value( "labelSizePx", aStyle.labelSizePx );
    aStyle.labelChip     = j.value( "labelChip", aStyle.labelChip );
    aStyle.labelVPos     = j.value( "labelVPos", aStyle.labelVPos );
    aStyle.labelHPos     = j.value( "labelHPos", aStyle.labelHPos );
    aStyle.labelInside   = j.value( "labelInside", aStyle.labelInside );
    aStyle.labelOffsetPx = j.value( "labelOffsetPx", aStyle.labelOffsetPx );
    aStyle.chipBgAlpha   = j.value( "chipBgAlpha", aStyle.chipBgAlpha );

    aStyle.cursorShape       = j.value( "cursorShape", aStyle.cursorShape );
    aStyle.cursorSizePx      = j.value( "cursorSizePx", aStyle.cursorSizePx );
    aStyle.cursorWidthPx     = j.value( "cursorWidthPx", aStyle.cursorWidthPx );
    aStyle.cursorAlpha       = j.value( "cursorAlpha", aStyle.cursorAlpha );
    aStyle.cursorLabel       = j.value( "cursorLabel", aStyle.cursorLabel );
    aStyle.cursorLabelSizePx = j.value( "cursorLabelSizePx", aStyle.cursorLabelSizePx );
    aStyle.cursorLabelChip   = j.value( "cursorLabelChip", aStyle.cursorLabelChip );

    aStyle.fixedColor = j.value( "fixedColor", aStyle.fixedColor );

    if( j.contains( "palette" ) && j["palette"].is_array() )
    {
        aStyle.palette.clear();

        for( const json& c : j["palette"] )
        {
            if( c.is_string() )
                aStyle.palette.push_back( c.get<std::string>() );
        }
    }

    aStyle.pinShape         = j.value( "pinShape", aStyle.pinShape );
    aStyle.pinRadiusPx      = j.value( "pinRadiusPx", aStyle.pinRadiusPx );
    aStyle.pinRingPx        = j.value( "pinRingPx", aStyle.pinRingPx );
    aStyle.pinRingAlpha     = j.value( "pinRingAlpha", aStyle.pinRingAlpha );
    aStyle.pinFillAlpha     = j.value( "pinFillAlpha", aStyle.pinFillAlpha );
    aStyle.pinResolvedAlpha = j.value( "pinResolvedAlpha", aStyle.pinResolvedAlpha );
    aStyle.pinUnreadRingColor = j.value( "pinUnreadRingColor", aStyle.pinUnreadRingColor );

    aStyle.xselAlphaScale = j.value( "xselAlphaScale", aStyle.xselAlphaScale );
}

/** The style a cross-app (0006) ghost selection draws with: the given style
 *  with its selection stroke/fill alphas scaled by `xselAlphaScale`. */
inline STYLE ghostStyle( const STYLE& aStyle )
{
    STYLE g = aStyle;
    g.selStrokeAlpha *= aStyle.xselAlphaScale;
    g.selFillAlpha   *= aStyle.xselAlphaScale;
    return g;
}

/** The color a peer renders with under this style (fixed > palette-by-name-hash
 *  > the sender-provided color). */
inline KIGFX::COLOR4D peerColor( const STYLE& aStyle, const std::string& aName,
                                 const KIGFX::COLOR4D& aProvided )
{
    if( !aStyle.fixedColor.empty() )
        return parseHexColor( aStyle.fixedColor, aProvided );

    if( !aStyle.palette.empty() )
    {
        unsigned h = 0x811c9dc5;

        for( char c : aName )
        {
            h ^= (unsigned char) c;
            h *= 0x01000193;
        }

        return parseHexColor( aStyle.palette[h % aStyle.palette.size()], aProvided );
    }

    return aProvided;
}

// Rough bitmap-font advance (the GAL stroke/bitmap glyphs are ~0.75 em wide) —
// good enough to size label chips and right-align labels for the tuner.
inline double textWidth( const std::string& aText, double aGlyphH )
{
    return aText.size() * aGlyphH * 0.75;
}

// Legible text color for a chip background: near-black on light colors,
// white on dark ones (BitmapText draws with the GAL stroke color).
inline KIGFX::COLOR4D chipTextColor( const KIGFX::COLOR4D& aBg )
{
    double lum = 0.299 * aBg.r + 0.587 * aBg.g + 0.114 * aBg.b;
    return lum > 0.6 ? KIGFX::COLOR4D( 0.08, 0.08, 0.08, 1.0 )
                     : KIGFX::COLOR4D( 1.0, 1.0, 1.0, 1.0 );
}

/**
 * The TEXT half of the presence drawing. All labels go through this overlay
 * because a plain VIEW_OVERLAY has two text hazards:
 *   - it draws with whatever justify the last painter left in the GAL
 *     (CENTER is only the reset default) → anchoring was nondeterministic;
 *     this pins TOP-LEFT, which the label math is written against.
 *   - every overlay draws its whole command list at ONE depth
 *     (VIEW_OVERLAY::ViewDraw hard-sets GetMinDepth()) and same-depth
 *     fragments drawn later LOSE the depth test; bitmap glyphs are textured
 *     QUADS whose transparent cells also write depth, so text can neither be
 *     drawn under a chip (erased) nor over one (punches cell-shaped holes).
 *     The SHAPES overlay is therefore pushed DEEPER via the fork's
 *     VIEW_OVERLAY::SetDepthOffset (chips at min+1, text at min) — "rect
 *     first, text on top" then holds regardless of paint order.
 */
class PRESENCE_TEXT_OVERLAY : public KIGFX::VIEW_OVERLAY
{
public:
    void ViewDraw( int aLayer, KIGFX::VIEW* aView ) const override
    {
        KIGFX::GAL* gal = aView->GetGAL();
        gal->SetHorizontalJustify( GR_TEXT_H_ALIGN_LEFT );
        gal->SetVerticalJustify( GR_TEXT_V_ALIGN_TOP );
        KIGFX::VIEW_OVERLAY::ViewDraw( aLayer, aView );
    }
};

/**
 * Depth layering (0007 lesson, extended): each overlay draws its WHOLE
 * command list at one depth, and same-depth fragments drawn later LOSE the
 * depth test — so anything that must render on top of something else needs
 * its own overlay one unit nearer. Three layers, near → deep:
 *   text (0)  <  chips + pin dots (1)  <  selection shapes/fills (2)
 * Chips above fills fixes the washed-out name tags inside low-alpha
 * selection areas (the chip fragments were rejected against the
 * earlier-drawn fill, leaving only the fill's alpha behind the glyphs).
 */
constexpr double PRESENCE_CHIPS_DEPTH_OFFSET  = 1.0;
constexpr double PRESENCE_SHAPES_DEPTH_OFFSET = 2.0;

/** VIEW::MakeOverlay's body, for the text overlay (make + Add to the view). */
inline std::shared_ptr<PRESENCE_TEXT_OVERLAY> makePresenceTextOverlay( KIGFX::VIEW* aView )
{
    auto overlay = std::make_shared<PRESENCE_TEXT_OVERLAY>();
    aView->Add( overlay.get() );
    return overlay;
}

/** Name tag next to (or inside) a box, per the label placement knobs. `px` is
 *  world-units-per-screen-pixel. The chip rect goes to the CHIPS overlay
 *  (above selection fills, below text), the text to the TEXT overlay (nearest
 *  depth + pinned TOP-LEFT justify — see PRESENCE_TEXT_OVERLAY), so the tag
 *  renders solid regardless of what selection geometry it overlaps. */
inline void drawLabel( KIGFX::VIEW_OVERLAY* aChipOv, KIGFX::VIEW_OVERLAY* aTextOv,
                       const BOX2I& aBox, const std::string& aText,
                       const KIGFX::COLOR4D& aColor, double aPx, const STYLE& aS )
{
    if( !aS.labelShow || aText.empty() )
        return;

    double h = aS.labelSizePx * aPx;
    double w = textWidth( aText, h );
    double off = aS.labelOffsetPx * aPx;

    double x = aBox.GetOrigin().x;                                     // start

    if( aS.labelHPos == 1 )
        x = aBox.GetEnd().x - w;                                       // end
    else if( aS.labelHPos == 2 )
        x = ( aBox.GetOrigin().x + aBox.GetEnd().x ) / 2.0 - w / 2.0;  // center

    double y;   // top of the text block

    if( aS.labelVPos == 0 )
        y = aS.labelInside ? aBox.GetOrigin().y + off : aBox.GetOrigin().y - off - h;
    else
        y = aS.labelInside ? aBox.GetEnd().y - off - h : aBox.GetEnd().y + off;

    if( aS.labelChip )
    {
        double padX = 3 * aPx, padY = 2 * aPx;
        aChipOv->SetIsStroke( false );
        aChipOv->SetIsFill( true );
        aChipOv->SetFillColor( aColor.WithAlpha( aS.chipBgAlpha ) );
        aChipOv->Rectangle( VECTOR2D( x - padX, y - padY ),
                            VECTOR2D( x + w + padX, y + h + padY ) );
        aChipOv->SetIsStroke( true );
        aChipOv->SetIsFill( false );
    }

    aTextOv->SetIsStroke( true );
    aTextOv->SetIsFill( false );
    aTextOv->SetStrokeColor( aS.labelChip ? chipTextColor( aColor ) : aColor );
    aTextOv->SetGlyphSize( VECTOR2I( KiROUND( h ), KiROUND( h ) ) );
    aTextOv->BitmapText( wxString::FromUTF8( aText.c_str() ),
                         VECTOR2I( KiROUND( x ), KiROUND( y ) ), ANGLE_0 );
}

/** Selection highlight for one item, in the chosen shape. `aOutline` is the
 *  item's exact geometry for selShape 5 (pcbnew supplies it; eeschema passes
 *  nullptr and shape 5 falls back to the bbox rectangle). Shapes/fills paint
 *  on `aOv` (deepest layer); the name chip goes to `aChipOv` one unit nearer
 *  so it stays solid over any fill (see the depth-layering note above). */
inline void drawSelectionBox( KIGFX::VIEW_OVERLAY* aOv, KIGFX::VIEW_OVERLAY* aChipOv,
                              KIGFX::VIEW_OVERLAY* aTextOv, BOX2I aBox,
                              const std::string& aName, const KIGFX::COLOR4D& aColor, double aPx,
                              const STYLE& aS, const SHAPE_POLY_SET* aOutline = nullptr )
{
    if( aS.selShape == 5 && aOutline && aOutline->OutlineCount() > 0 )
    {
        aOv->SetIsStroke( true );
        aOv->SetIsFill( aS.selFillAlpha > 0.001 );
        aOv->SetStrokeColor( aColor.WithAlpha( aS.selStrokeAlpha ) );
        aOv->SetFillColor( aColor.WithAlpha( aS.selFillAlpha ) );
        aOv->SetLineWidth( aS.selStrokeWidth * aPx );
        aOv->Polygon( *aOutline );

        BOX2I labelBox = aOutline->BBox();
        labelBox.Inflate( KiROUND( aS.selPaddingPx * aPx ) );
        drawLabel( aChipOv, aTextOv, labelBox, aName, aColor, aPx, aS );
        return;
    }

    aBox.Inflate( KiROUND( aS.selPaddingPx * aPx ) );

    const VECTOR2D tl = aBox.GetOrigin();
    const VECTOR2D br = aBox.GetEnd();
    const VECTOR2D tr( br.x, tl.y );
    const VECTOR2D bl( tl.x, br.y );

    bool fill = aS.selFillAlpha > 0.001 || aS.selShape == 4;
    double fillAlpha = aS.selShape == 4 && aS.selFillAlpha <= 0.001 ? 0.18 : aS.selFillAlpha;

    aOv->SetIsStroke( aS.selShape != 4 );
    aOv->SetIsFill( fill );
    aOv->SetStrokeColor( aColor.WithAlpha( aS.selStrokeAlpha ) );
    aOv->SetFillColor( aColor.WithAlpha( fillAlpha ) );
    aOv->SetLineWidth( aS.selStrokeWidth * aPx );

    switch( aS.selShape )
    {
    default:
    case 0: // rectangle (fill rides along when selFillAlpha > 0)
    case 4: // filled only
        aOv->Rectangle( tl, br );
        break;

    case 1: // corner brackets
    {
        if( fill )
        {
            aOv->SetIsStroke( false );
            aOv->Rectangle( tl, br );
            aOv->SetIsStroke( true );
            aOv->SetIsFill( false );
        }

        double arm = std::min( { aS.selCornerPx * aPx, ( br.x - tl.x ) / 2.0,
                                 ( br.y - tl.y ) / 2.0 } );
        aOv->Line( tl, tl + VECTOR2D( arm, 0 ) );
        aOv->Line( tl, tl + VECTOR2D( 0, arm ) );
        aOv->Line( tr, tr + VECTOR2D( -arm, 0 ) );
        aOv->Line( tr, tr + VECTOR2D( 0, arm ) );
        aOv->Line( bl, bl + VECTOR2D( arm, 0 ) );
        aOv->Line( bl, bl + VECTOR2D( 0, -arm ) );
        aOv->Line( br, br + VECTOR2D( -arm, 0 ) );
        aOv->Line( br, br + VECTOR2D( 0, -arm ) );
        break;
    }

    case 2: // underline
        aOv->Line( bl, br );
        break;

    case 3: // rounded rectangle (lines + quarter arcs)
    {
        if( fill )
        {
            aOv->SetIsStroke( false );
            aOv->Rectangle( tl, br );
            aOv->SetIsStroke( true );
            aOv->SetIsFill( false );
        }

        double r = std::min( { aS.selCornerPx * aPx, ( br.x - tl.x ) / 2.0,
                               ( br.y - tl.y ) / 2.0 } );
        aOv->Line( tl + VECTOR2D( r, 0 ), tr + VECTOR2D( -r, 0 ) );
        aOv->Line( bl + VECTOR2D( r, 0 ), br + VECTOR2D( -r, 0 ) );
        aOv->Line( tl + VECTOR2D( 0, r ), bl + VECTOR2D( 0, -r ) );
        aOv->Line( tr + VECTOR2D( 0, r ), br + VECTOR2D( 0, -r ) );
        // Screen-y grows down: the "top-left" corner arc spans 180°→270°.
        aOv->Arc( tl + VECTOR2D( r, r ), r, EDA_ANGLE( 180, DEGREES_T ), EDA_ANGLE( 270, DEGREES_T ) );
        aOv->Arc( tr + VECTOR2D( -r, r ), r, EDA_ANGLE( 270, DEGREES_T ), EDA_ANGLE( 360, DEGREES_T ) );
        aOv->Arc( br + VECTOR2D( -r, -r ), r, EDA_ANGLE( 0, DEGREES_T ), EDA_ANGLE( 90, DEGREES_T ) );
        aOv->Arc( bl + VECTOR2D( r, -r ), r, EDA_ANGLE( 90, DEGREES_T ), EDA_ANGLE( 180, DEGREES_T ) );
        break;
    }
    }

    drawLabel( aChipOv, aTextOv, aBox, aName, aColor, aPx, aS );
}

/** Remote cursor (+ name label) in the chosen shape. The cursor glyph paints
 *  on `aOv`; its label chip on `aChipOv` (same layering as drawSelectionBox). */
inline void drawCursor( KIGFX::VIEW_OVERLAY* aOv, KIGFX::VIEW_OVERLAY* aChipOv,
                        KIGFX::VIEW_OVERLAY* aTextOv,
                        const VECTOR2D& aPos, const std::string& aName,
                        const KIGFX::COLOR4D& aColor, double aPx, const STYLE& aS )
{
    double s = aS.cursorSizePx * aPx;
    KIGFX::COLOR4D c = aColor.WithAlpha( aS.cursorAlpha );

    aOv->SetIsFill( false );
    aOv->SetIsStroke( true );
    aOv->SetStrokeColor( c );
    aOv->SetLineWidth( aS.cursorWidthPx * aPx );

    switch( aS.cursorShape )
    {
    default:
    case 0: // cross
        aOv->Cross( aPos, KiROUND( s ) );
        break;

    case 1: // pointer triangle (mouse-arrow-ish, filled)
    {
        aOv->SetIsFill( true );
        aOv->SetFillColor( c );
        VECTOR2D pts[3] = { aPos, aPos + VECTOR2D( 0.45 * s * 2, 1.6 * s ),
                            aPos + VECTOR2D( 1.1 * s, 1.1 * s ) };
        aOv->Polygon( pts, 3 );
        aOv->SetIsFill( false );
        break;
    }

    case 2: // circle + center dot
        aOv->Circle( aPos, s );
        aOv->SetIsFill( true );
        aOv->SetFillColor( c );
        aOv->Circle( aPos, 1.5 * aPx );
        aOv->SetIsFill( false );
        break;
    }

    if( aS.cursorLabel && !aName.empty() )
    {
        double h = aS.cursorLabelSizePx * aPx;
        double w = textWidth( aName, h );
        // Top-left of the text block, below-right of the cursor glyph
        // (TOP-LEFT anchoring — PRESENCE_OVERLAY pins the GAL justify).
        VECTOR2D at = aPos + VECTOR2D( ( aS.cursorSizePx + 4 ) * aPx,
                                       ( aS.cursorSizePx + 4 ) * aPx );

        // Chip rect on the CHIPS overlay, text on the TEXT overlay (nearest
        // depth) — text on top of its chip, chip on top of selection fills.
        if( aS.cursorLabelChip )
        {
            double padX = 3 * aPx, padY = 2 * aPx;
            aChipOv->SetIsStroke( false );
            aChipOv->SetIsFill( true );
            aChipOv->SetFillColor( aColor.WithAlpha( aS.chipBgAlpha ) );
            aChipOv->Rectangle( at + VECTOR2D( -padX, -padY ),
                                at + VECTOR2D( w + padX, h + padY ) );
            aChipOv->SetIsStroke( true );
            aChipOv->SetIsFill( false );
        }

        aTextOv->SetIsStroke( true );
        aTextOv->SetIsFill( false );
        aTextOv->SetStrokeColor( aS.cursorLabelChip ? chipTextColor( aColor ) : c );
        aTextOv->SetGlyphSize( VECTOR2I( KiROUND( h ), KiROUND( h ) ) );
        aTextOv->BitmapText( wxString::FromUTF8( aName.c_str() ),
                             VECTOR2I( KiROUND( at.x ), KiROUND( at.y ) ), ANGLE_0 );
    }
}

/** Comment pin. Draw onto the CHIPS overlay: at the shapes depth an
 *  earlier-painted selection fill would reject the pin's fragments (the 0005
 *  "drawn last sits above" comment had it backwards — later fragments LOSE).
 *  Bubble shape (comments-ux 0001 A, figma-style): a round body whose
 *  bottom-left corner is squared off; `aPos` is that SHARP CORNER = the
 *  anchored world point, the body center sits at aPos + (r, -r) (screen
 *  up-right; KiCad IU y grows downward). One closed polygon — three sampled
 *  round corners + the sharp one — so the stroke traces the outline exactly
 *  with no depth-order seams. */
inline void drawPin( KIGFX::VIEW_OVERLAY* aOv, const VECTOR2D& aPos, const KIGFX::COLOR4D& aColor,
                     bool aResolved, bool aUnread, double aPx, const STYLE& aS )
{
    double fillAlpha = aResolved ? aS.pinResolvedAlpha : aS.pinFillAlpha;
    double ringAlpha = aResolved ? aS.pinRingAlpha * 0.4 : aS.pinRingAlpha;

    KIGFX::COLOR4D ring( 1, 1, 1, ringAlpha );

    if( aUnread && !aResolved && !aS.pinUnreadRingColor.empty() )
        ring = parseHexColor( aS.pinUnreadRingColor, ring ).WithAlpha( ringAlpha );

    aOv->SetIsStroke( true );
    aOv->SetIsFill( true );
    aOv->SetFillColor( aColor.WithAlpha( fillAlpha ) );
    aOv->SetStrokeColor( ring );
    aOv->SetLineWidth( aS.pinRingPx * aPx );

    if( aS.pinShape == 0 )
    {
        aOv->Circle( aPos, aS.pinRadiusPx * aPx );
        return;
    }

    double   r = aS.pinRadiusPx * aPx;
    VECTOR2D c = aPos + VECTOR2D( r, -r );

    constexpr int SEGS = 24; // sampling of the 270° round part
    VECTOR2D      pts[SEGS + 3];
    int           n = 0;

    pts[n++] = aPos; // the sharp corner

    for( int i = 0; i <= SEGS; i++ )
    {
        // South (90° in y-down coords) → east → north → west: the round part.
        double th = ( 90.0 - 270.0 * i / SEGS ) * M_PI / 180.0;
        pts[n++] = c + VECTOR2D( cos( th ) * r, sin( th ) * r );
    }

    // Close the outline explicitly: the overlay strokes the point list as a
    // polyline, so without repeating the first point the west → sharp-corner
    // edge would have fill but no ring.
    pts[n++] = aPos;

    aOv->Polygon( pts, n );
}

} // namespace pcbjam_presence

#endif // __EMSCRIPTEN__
