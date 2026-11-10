/*
 * The swap of a placed footprint for its library's current one, without a board editor frame
 * (mcp 0006): kicad_tools' --update-from-netlist runs KiCad's BOARD_NETLIST_UPDATER headless,
 * and the updater calls these weak hooks when it has no PCB_EDIT_FRAME.
 *
 *   pcbjam_headless_load_footprint      a footprint by LIB_ID from the staged library folder
 *                                       (<dir>/<Nickname>.pretty/<Name>.kicad_mod)
 *   pcbjam_headless_exchange_footprint  PCB_EDIT_FRAME::ExchangeFootprint's body
 *
 * The swap is a COPY of KiCad 10.0's PCB_EDIT_FRAME::ExchangeFootprint and its two helpers
 * (pcbnew/pcb_edit_frame.cpp). Its three frame calls are replaced, marked "pcbjam:" (the
 * board, PlaceFootprint's position, the flip direction); KiCad master moved the same code to
 * BOARD::ExchangeFootprint (board_exchange_footprint.cpp). Keep it in step on a KiCad rebase
 * (kicad-rebase-housekeeping lists it), and drop it once the fork has master's version.
 *
 * GPL: KiCad code, part of the kicad_tools executable, never linked into closed code.
 */

#include <algorithm>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <board.h>
#include <board_commit.h>
#include <footprint.h>
#include <pad.h>
#include <pcb_field.h>
#include <pcb_group.h>
#include <pcb_dimension.h>
#include <pcb_point.h>
#include <pcb_text.h>
#include <zone.h>
#include <lib_id.h>
#include <pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h>
#include <wx/filename.h>

/** Where --update-from-netlist staged the footprints; empty: none can load. */
std::string g_pcbjamFootprintDir;

namespace
{

/**
 * copy text settings from aSrc to aDest
 * @param aSrc is the PCB_TEXT source
 * @param aDest is the PCB_TEXT target
 * @param aResetText is true to keep the default target text (false to use the aSrc text)
 * @param aResetTextLayers is true to keep the default target layers setting
 * (false to use the aSrc setting)
 * @param aResetTextEffects is true to keep the default target text effects
 * (false to use the aSrc effect)
 * @param aUpdated is a refrence to a bool to keep trace of changes
 */
static void processTextItem( const PCB_TEXT& aSrc, PCB_TEXT& aDest,
                             bool aResetText, bool aResetTextLayers, bool aResetTextEffects,
                             bool aResetTextPositions, bool* aUpdated )
{
    if( aResetText )
        *aUpdated |= aSrc.GetText() != aDest.GetText();
    else
        aDest.SetText( aSrc.GetText() );

    if( aResetTextLayers )
    {
        *aUpdated |= aSrc.GetLayer() != aDest.GetLayer();
        *aUpdated |= aSrc.IsVisible() != aDest.IsVisible();
    }
    else
    {
        aDest.SetLayer( aSrc.GetLayer() );
        aDest.SetVisible( aSrc.IsVisible() );
    }

    VECTOR2I origPos = aDest.GetFPRelativePosition();

    if( aResetTextEffects )
    {
        *aUpdated |= aSrc.GetHorizJustify() != aDest.GetHorizJustify();
        *aUpdated |= aSrc.GetVertJustify() != aDest.GetVertJustify();
        *aUpdated |= aSrc.GetTextSize() != aDest.GetTextSize();
        *aUpdated |= aSrc.GetTextThickness() != aDest.GetTextThickness();
        *aUpdated |= aSrc.GetTextAngle() != aDest.GetTextAngle();
        *aUpdated |= aSrc.IsKnockout() != aDest.IsKnockout();
        aDest.KeepUpright();
    }
    else
    {
        aDest.SetAttributes( aSrc );
        aDest.SetIsKnockout( aSrc.IsKnockout() );
    }

    if( aResetTextPositions )
    {
        *aUpdated |= aSrc.GetFPRelativePosition() != origPos;
        aDest.SetFPRelativePosition( origPos );
    }
    else
    {
        aDest.SetFPRelativePosition( aSrc.GetFPRelativePosition() );
    }

    aDest.SetLocked( aSrc.IsLocked() );
    aDest.SetUuid( aSrc.m_Uuid );
}


template<typename T>
static std::vector<std::pair<T*, T*>> matchItemsBySimilarity( const std::vector<T*>& aExisting,
                                                              const std::vector<T*>& aNew )
{
    struct MATCH_CANDIDATE
    {
        T*      existing;
        T*      updated;
        double  score;
    };

    std::vector<MATCH_CANDIDATE> candidates;

    for( T* existing : aExisting )
    {
        for( T* updated : aNew )
        {
            if( existing->Type() != updated->Type() )
                continue;

            double similarity = existing->Similarity( *updated );

            if constexpr( std::is_same_v<T, PAD> )
            {
                if( existing->GetNumber() == updated->GetNumber() )
                    similarity += 2.0;
            }

            if( similarity <= 0.0 )
                continue;

            candidates.push_back( { existing, updated, similarity } );
        }
    }

    std::sort( candidates.begin(), candidates.end(),
               []( const MATCH_CANDIDATE& a, const MATCH_CANDIDATE& b )
               {
                   if( a.score != b.score )
                       return a.score > b.score;

                   if( a.existing != b.existing )
                       return a.existing < b.existing;

                   return a.updated < b.updated;
               } );

    std::vector<std::pair<T*, T*>> matches;
    matches.reserve( candidates.size() );

    std::unordered_set<T*> matchedExisting;
    std::unordered_set<T*> matchedNew;

    for( const MATCH_CANDIDATE& candidate : candidates )
    {
        if( matchedExisting.find( candidate.existing ) != matchedExisting.end() )
            continue;

        if( matchedNew.find( candidate.updated ) != matchedNew.end() )
            continue;

        matchedExisting.insert( candidate.existing );
        matchedNew.insert( candidate.updated );
        matches.emplace_back( candidate.existing, candidate.updated );
    }

    return matches;
}


void exchangeFootprint( FOOTPRINT* aExisting, FOOTPRINT* aNew,
                        BOARD_COMMIT& aCommit,
                        bool deleteExtraTexts = true,
                        bool resetTextLayers = true,
                        bool resetTextEffects = true,
                        bool resetTextPositions = true,
                        bool resetTextContent = true,
                        bool resetFabricationAttrs = true,
                        bool resetClearanceOverrides = true,
                        bool reset3DModels = true,
                        bool* aUpdated = nullptr )
{
    EDA_GROUP* parentGroup = aExisting->GetParentGroup();
    bool       dummyBool   = false;

    if( !aUpdated )
        aUpdated = &dummyBool;

    if( parentGroup )
    {
        aCommit.Modify( parentGroup->AsEdaItem(), nullptr, RECURSE_MODE::NO_RECURSE );
        parentGroup->RemoveItem( aExisting );
        parentGroup->AddItem( aNew );
    }

    aNew->SetParent( aExisting->GetBoard() ); // pcbjam: the frame's GetBoard(), headless

    // pcbjam: the frame's PlaceFootprint() is its undo bookkeeping plus this; the flip uses
    // KiCad's default direction, as master's BOARD::ExchangeFootprint does.
    aNew->SetPosition( aExisting->GetPosition() );
    aNew->ClearFlags();

    if( aNew->GetLayer() != aExisting->GetLayer() )
        aNew->Flip( aNew->GetPosition(), FLIP_DIRECTION::TOP_BOTTOM );

    if( aNew->GetOrientation() != aExisting->GetOrientation() )
        aNew->SetOrientation( aExisting->GetOrientation() );

    aNew->SetLocked( aExisting->IsLocked() );

    aNew->SetUuid( aExisting->m_Uuid );
    aNew->Reference().SetUuid( aExisting->Reference().m_Uuid );
    aNew->Value().SetUuid( aExisting->Value().m_Uuid );

    std::vector<PAD*> oldPads;
    oldPads.reserve( aExisting->Pads().size() );

    for( PAD* pad : aExisting->Pads() )
        oldPads.push_back( pad );

    std::vector<PAD*> newPads;
    newPads.reserve( aNew->Pads().size() );

    for( PAD* pad : aNew->Pads() )
        newPads.push_back( pad );

    auto padMatches = matchItemsBySimilarity<PAD>( oldPads, newPads );
    std::unordered_set<PAD*> matchedNewPads;

    for( const auto& match : padMatches )
    {
        PAD* oldPad = match.first;
        PAD* newPad = match.second;

        matchedNewPads.insert( newPad );
        newPad->SetUuid( oldPad->m_Uuid );
        newPad->SetLocalRatsnestVisible( oldPad->GetLocalRatsnestVisible() );
        newPad->SetPinFunction( oldPad->GetPinFunction() );
        newPad->SetPinType( oldPad->GetPinType() );

        if( newPad->IsOnCopperLayer() )
            newPad->SetNetCode( oldPad->GetNetCode() );
        else
            newPad->SetNetCode( NETINFO_LIST::UNCONNECTED );
    }

    for( PAD* newPad : aNew->Pads() )
    {
        if( matchedNewPads.find( newPad ) != matchedNewPads.end() )
            continue;

        newPad->ResetUuid();
        newPad->SetNetCode( NETINFO_LIST::UNCONNECTED );
    }

    std::vector<BOARD_ITEM*> oldDrawings;
    oldDrawings.reserve( aExisting->GraphicalItems().size() );

    for( BOARD_ITEM* item : aExisting->GraphicalItems() )
        oldDrawings.push_back( item );

    std::vector<BOARD_ITEM*> newDrawings;
    newDrawings.reserve( aNew->GraphicalItems().size() );

    for( BOARD_ITEM* item : aNew->GraphicalItems() )
        newDrawings.push_back( item );

    auto drawingMatches = matchItemsBySimilarity<BOARD_ITEM>( oldDrawings, newDrawings );
    std::unordered_map<BOARD_ITEM*, BOARD_ITEM*> oldToNewDrawings;
    std::unordered_set<BOARD_ITEM*> matchedNewDrawings;

    for( const auto& match : drawingMatches )
    {
        BOARD_ITEM* oldItem = match.first;
        BOARD_ITEM* newItem = match.second;

        oldToNewDrawings[ oldItem ] = newItem;
        matchedNewDrawings.insert( newItem );
        newItem->SetUuid( oldItem->m_Uuid );
    }

    for( BOARD_ITEM* newItem : newDrawings )
    {
        if( matchedNewDrawings.find( newItem ) == matchedNewDrawings.end() )
            newItem->ResetUuid();
    }

    std::vector<ZONE*> oldZones;
    oldZones.reserve( aExisting->Zones().size() );

    for( ZONE* zone : aExisting->Zones() )
        oldZones.push_back( zone );

    std::vector<ZONE*> newZones;
    newZones.reserve( aNew->Zones().size() );

    for( ZONE* zone : aNew->Zones() )
        newZones.push_back( zone );

    auto zoneMatches = matchItemsBySimilarity<ZONE>( oldZones, newZones );
    std::unordered_set<ZONE*> matchedNewZones;

    for( const auto& match : zoneMatches )
    {
        ZONE* oldZone = match.first;
        ZONE* newZone = match.second;

        matchedNewZones.insert( newZone );
        newZone->SetUuid( oldZone->m_Uuid );
    }

    for( ZONE* newZone : newZones )
    {
        if( matchedNewZones.find( newZone ) == matchedNewZones.end() )
            newZone->ResetUuid();
    }

    std::vector<PCB_POINT*> oldPoints;
    oldPoints.reserve( aExisting->Points().size() );

    for( PCB_POINT* point : aExisting->Points() )
        oldPoints.push_back( point );

    std::vector<PCB_POINT*> newPoints;
    newPoints.reserve( aNew->Points().size() );

    for( PCB_POINT* point : aNew->Points() )
        newPoints.push_back( point );

    auto pointMatches = matchItemsBySimilarity<PCB_POINT>( oldPoints, newPoints );
    std::unordered_set<PCB_POINT*> matchedNewPoints;

    for( const auto& match : pointMatches )
    {
        PCB_POINT* oldPoint = match.first;
        PCB_POINT* newPoint = match.second;

        matchedNewPoints.insert( newPoint );
        newPoint->SetUuid( oldPoint->m_Uuid );
    }

    for( PCB_POINT* newPoint : newPoints )
    {
        if( matchedNewPoints.find( newPoint ) == matchedNewPoints.end() )
            newPoint->ResetUuid();
    }

    std::vector<PCB_GROUP*> oldGroups;
    oldGroups.reserve( aExisting->Groups().size() );

    for( PCB_GROUP* group : aExisting->Groups() )
        oldGroups.push_back( group );

    std::vector<PCB_GROUP*> newGroups;
    newGroups.reserve( aNew->Groups().size() );

    for( PCB_GROUP* group : aNew->Groups() )
        newGroups.push_back( group );

    auto groupMatches = matchItemsBySimilarity<PCB_GROUP>( oldGroups, newGroups );
    std::unordered_set<PCB_GROUP*> matchedNewGroups;

    for( const auto& match : groupMatches )
    {
        PCB_GROUP* oldGroup = match.first;
        PCB_GROUP* newGroup = match.second;

        matchedNewGroups.insert( newGroup );
        newGroup->SetUuid( oldGroup->m_Uuid );
    }

    for( PCB_GROUP* newGroup : newGroups )
    {
        if( matchedNewGroups.find( newGroup ) == matchedNewGroups.end() )
            newGroup->ResetUuid();
    }

    std::vector<PCB_FIELD*> oldFieldsVec;
    std::vector<PCB_FIELD*> newFieldsVec;

    oldFieldsVec.reserve( aExisting->GetFields().size() );

    for( PCB_FIELD* field : aExisting->GetFields() )
    {
        wxCHECK2( field, continue );

        if( field->IsReference() || field->IsValue() )
            continue;

        oldFieldsVec.push_back( field );
    }

    newFieldsVec.reserve( aNew->GetFields().size() );

    for( PCB_FIELD* field : aNew->GetFields() )
    {
        wxCHECK2( field, continue );

        if( field->IsReference() || field->IsValue() )
            continue;

        newFieldsVec.push_back( field );
    }

    auto fieldMatches = matchItemsBySimilarity<PCB_FIELD>( oldFieldsVec, newFieldsVec );
    std::unordered_map<PCB_FIELD*, PCB_FIELD*> oldToNewFields;
    std::unordered_set<PCB_FIELD*> matchedNewFields;

    for( const auto& match : fieldMatches )
    {
        PCB_FIELD* oldField = match.first;
        PCB_FIELD* newField = match.second;

        oldToNewFields[ oldField ] = newField;
        matchedNewFields.insert( newField );
        newField->SetUuid( oldField->m_Uuid );
    }

    for( PCB_FIELD* newField : newFieldsVec )
    {
        if( matchedNewFields.find( newField ) == matchedNewFields.end() )
            newField->ResetUuid();
    }

    std::unordered_map<PCB_TEXT*, PCB_TEXT*> oldToNewTexts;

    for( const auto& match : drawingMatches )
    {
        PCB_TEXT* oldText = dynamic_cast<PCB_TEXT*>( match.first );
        PCB_TEXT* newText = dynamic_cast<PCB_TEXT*>( match.second );

        if( oldText && newText )
            oldToNewTexts[ oldText ] = newText;
    }

    std::set<PCB_TEXT*> handledTextItems;

    for( BOARD_ITEM* oldItem : aExisting->GraphicalItems() )
    {
        PCB_TEXT* oldTextItem = dynamic_cast<PCB_TEXT*>( oldItem );

        if( oldTextItem )
        {
            // Dimensions have PCB_TEXT base but are not treated like texts in the updater
            if( dynamic_cast<PCB_DIMENSION_BASE*>( oldTextItem ) )
                continue;

            PCB_TEXT* newTextItem = nullptr;

            auto textMatchIt = oldToNewTexts.find( oldTextItem );

            if( textMatchIt != oldToNewTexts.end() )
                newTextItem = textMatchIt->second;

            if( newTextItem )
            {
                handledTextItems.insert( newTextItem );
                processTextItem( *oldTextItem, *newTextItem, resetTextContent, resetTextLayers,
                                 resetTextEffects, resetTextPositions, aUpdated );
            }
            else if( deleteExtraTexts )
            {
                *aUpdated = true;
            }
            else
            {
                newTextItem = static_cast<PCB_TEXT*>( oldTextItem->Clone() );
                handledTextItems.insert( newTextItem );
                aNew->Add( newTextItem );
            }
        }
    }

    // Check for any newly-added text items and set the update flag as appropriate
    for( BOARD_ITEM* newItem : aNew->GraphicalItems() )
    {
        PCB_TEXT* newTextItem = dynamic_cast<PCB_TEXT*>( newItem );

        if( newTextItem )
        {
            // Dimensions have PCB_TEXT base but are not treated like texts in the updater
            if( dynamic_cast<PCB_DIMENSION_BASE*>( newTextItem ) )
                continue;

            if( !handledTextItems.contains( newTextItem ) )
            {
                *aUpdated = true;
                break;
            }
        }
    }

    // Copy reference. The initial text is always used, never resetted
    processTextItem( aExisting->Reference(), aNew->Reference(), false, resetTextLayers,
                     resetTextEffects, resetTextPositions, aUpdated );

    // Copy value
    processTextItem( aExisting->Value(), aNew->Value(),
                     // reset value text only when it is a proxy for the footprint ID
                     // (cf replacing value "MountingHole-2.5mm" with "MountingHole-4.0mm")
                     aExisting->GetValue() == aExisting->GetFPID().GetLibItemName().wx_str(),
                     resetTextLayers, resetTextEffects, resetTextPositions, aUpdated );

    std::set<PCB_FIELD*> handledFields;

    // Copy fields in accordance with the reset* flags
    for( PCB_FIELD* oldField : aExisting->GetFields() )
    {
        wxCHECK2( oldField, continue );

        // Reference and value are already handled
        if( oldField->IsReference() || oldField->IsValue() )
            continue;

        PCB_FIELD* newField = nullptr;

        auto fieldMatchIt = oldToNewFields.find( oldField );

        if( fieldMatchIt != oldToNewFields.end() )
            newField = fieldMatchIt->second;

        if( newField )
        {
            handledFields.insert( newField );
            processTextItem( *oldField, *newField, resetTextContent, resetTextLayers,
                             resetTextEffects, resetTextPositions, aUpdated );
        }
        else if( deleteExtraTexts )
        {
            *aUpdated = true;
        }
        else
        {
            newField = new PCB_FIELD( *oldField );
            handledFields.insert( newField );
            aNew->Add( newField );
        }
    }

    // Check for any newly-added fields and set the update flag as appropriate
    for( PCB_FIELD* newField : aNew->GetFields() )
    {
        wxCHECK2( newField, continue );

        // Reference and value are already handled
        if( newField->IsReference() || newField->IsValue() )
            continue;

        if( !handledFields.contains( newField ) )
        {
            *aUpdated = true;
            break;
        }
    }

    if( resetFabricationAttrs )
    {
        // We've replaced the existing footprint with the library one, so the fabrication attrs
        // are already reset.  Just set the aUpdated flag if appropriate.
        if( aNew->GetAttributes() != aExisting->GetAttributes() )
            *aUpdated = true;
    }
    else
    {
        aNew->SetAttributes( aExisting->GetAttributes() );
    }

    if( resetClearanceOverrides )
    {
        if( aExisting->AllowSolderMaskBridges() != aNew->AllowSolderMaskBridges() )
            *aUpdated = true;

        if( ( aExisting->GetLocalClearance() != aNew->GetLocalClearance() )
                || ( aExisting->GetLocalSolderMaskMargin() != aNew->GetLocalSolderMaskMargin() )
                || ( aExisting->GetLocalSolderPasteMargin() != aNew->GetLocalSolderPasteMargin() )
                || ( aExisting->GetLocalSolderPasteMarginRatio() != aNew->GetLocalSolderPasteMarginRatio() )
                || ( aExisting->GetLocalZoneConnection() != aNew->GetLocalZoneConnection() ) )
        {
            *aUpdated = true;
        }
    }
    else
    {
        aNew->SetLocalClearance( aExisting->GetLocalClearance() );
        aNew->SetLocalSolderMaskMargin( aExisting->GetLocalSolderMaskMargin() );
        aNew->SetLocalSolderPasteMargin( aExisting->GetLocalSolderPasteMargin() );
        aNew->SetLocalSolderPasteMarginRatio( aExisting->GetLocalSolderPasteMarginRatio() );
        aNew->SetLocalZoneConnection( aExisting->GetLocalZoneConnection() );
        aNew->SetAllowSolderMaskBridges( aExisting->AllowSolderMaskBridges() );
    }

    if( reset3DModels )
    {
        // We've replaced the existing footprint with the library one, so the 3D models are
        // already reset.  Just set the aUpdated flag if appropriate.
        if( aNew->Models().size() != aExisting->Models().size() )
        {
            *aUpdated = true;
        }
        else
        {
            for( size_t ii = 0; ii < aNew->Models().size(); ++ii )
            {
                if( aNew->Models()[ii] != aExisting->Models()[ii] )
                {
                    *aUpdated = true;
                    break;
                }
            }
        }
    }
    else
    {
        // Preserve model references and all embedded model data.
        aNew->Models() = aExisting->Models();

        for( const auto& [name, file] : aExisting->GetEmbeddedFiles()->EmbeddedFileMap() )
        {
            if( file->type != EMBEDDED_FILES::EMBEDDED_FILE::FILE_TYPE::MODEL )
                continue;

            aNew->GetEmbeddedFiles()->RemoveFile( name, true );
            aNew->GetEmbeddedFiles()->AddFile( new EMBEDDED_FILES::EMBEDDED_FILE( *file ) );
        }
    }

    // Updating other parameters
    aNew->SetPath( aExisting->GetPath() );
    aNew->SetSheetfile( aExisting->GetSheetfile() );
    aNew->SetSheetname( aExisting->GetSheetname() );
    aNew->SetFilters( aExisting->GetFilters() );
    aNew->SetStaticComponentClass( aExisting->GetComponentClass() );

    if( *aUpdated == false )
    {
        // Check pad shapes, graphics, zones, etc. for changes
        if( aNew->FootprintNeedsUpdate( aExisting, BOARD_ITEM::COMPARE_FLAGS::INSTANCE_TO_INSTANCE ) )
            *aUpdated = true;
    }

    aCommit.Remove( aExisting );
    aCommit.Add( aNew );

    aNew->ClearFlags();
}


} // namespace


extern "C" FOOTPRINT* pcbjam_headless_load_footprint( const LIB_ID* aId )
{
    if( g_pcbjamFootprintDir.empty() || !aId || !aId->IsValid() )
        return nullptr;

    wxFileName lib( wxString::FromUTF8( g_pcbjamFootprintDir ), wxEmptyString );
    lib.AppendDir( aId->GetLibNickname().wx_str() + wxS( ".pretty" ) );

    try
    {
        PCB_IO_KICAD_SEXPR io;
        FOOTPRINT*         fp = io.FootprintLoad( lib.GetPath(), aId->GetLibItemName().wx_str() );

        // As FOOTPRINT_EDIT_FRAME's loader: the footprint carries the LIB_ID it was asked by.
        if( fp )
            fp->SetFPID( *aId );

        return fp;
    }
    catch( ... )
    {
        return nullptr; // the updater reports it as "footprint not found"
    }
}


extern "C" void pcbjam_headless_exchange_footprint( FOOTPRINT* aExisting, FOOTPRINT* aNew,
                                                    BOARD_COMMIT* aCommit )
{
    // The dialog's defaults, as BOARD_NETLIST_UPDATER calls the frame's.
    exchangeFootprint( aExisting, aNew, *aCommit );
}
