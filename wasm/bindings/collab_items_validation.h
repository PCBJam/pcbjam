/*
 * Pure validation for the native per-item collaboration wire.
 *
 * Keep this header free of wxWidgets/Emscripten dependencies: the production
 * bindings use it immediately before touching a KiCad model and the adjacent
 * C++ executable test exercises the same code without launching an editor.
 */

#pragma once

#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

namespace pcbjam_collab
{

inline bool validateItemsWireShape( const nlohmann::json& aWire, std::string& aError )
{
    if( !aWire.is_object() )
    {
        aError = "items wire must be an object";
        return false;
    }

    for( const char* category : { "added", "changed", "removed" } )
    {
        auto it = aWire.find( category );

        if( it != aWire.end() && !it->is_array() )
        {
            aError = std::string( "items wire category must be an array: " ) + category;
            return false;
        }
    }

    auto protocol = aWire.find( "_pcbjam" );

    if( protocol != aWire.end() )
    {
        if( !protocol->is_object() )
        {
            aError = "items wire _pcbjam metadata must be an object";
            return false;
        }

        auto request = protocol->find( "requestId" );
        auto owner = protocol->find( "ownerGeneration" );

        if( request == protocol->end() || !request->is_string()
            || request->get_ref<const std::string&>().empty()
            || owner == protocol->end() || !owner->is_string()
            || owner->get_ref<const std::string&>().empty() )
        {
            aError = "items wire _pcbjam metadata needs non-empty request and owner IDs";
            return false;
        }
    }

    auto validateUpserts = [&]( const char* aCategory ) -> bool
    {
        auto category = aWire.find( aCategory );

        if( category == aWire.end() )
            return true;

        for( const nlohmann::json& entry : *category )
        {
            if( !entry.is_object() )
            {
                aError = std::string( "items wire entry must be an object: " ) + aCategory;
                return false;
            }

            auto sexpr = entry.find( "sexpr" );

            if( sexpr == entry.end() || !sexpr->is_string()
                || sexpr->get_ref<const std::string&>().find_first_not_of( " \t\r\n" )
                           == std::string::npos )
            {
                aError = std::string( "items wire entry needs a non-blank sexpr: " ) + aCategory;
                return false;
            }

            auto parent = entry.find( "parent" );

            if( parent != entry.end() && !parent->is_null() && !parent->is_string() )
            {
                aError = std::string( "items wire parent must be string or null: " ) + aCategory;
                return false;
            }
        }

        return true;
    };

    if( !validateUpserts( "added" ) || !validateUpserts( "changed" ) )
        return false;

    auto removed = aWire.find( "removed" );

    if( removed != aWire.end() )
    {
        for( const nlohmann::json& id : *removed )
        {
            if( !id.is_string() || id.get_ref<const std::string&>().empty() )
            {
                aError = "items wire removed UUIDs must be non-empty strings";
                return false;
            }
        }
    }

    aError.clear();
    return true;
}

/**
 * The native appliers splice complete document roots. A non-null parent is a
 * detached child/reference that the board/schematic/page-layout parsers cannot
 * reattach; silently ignoring it would install that child as a new root while
 * acknowledging a state different from Y. The TypeScript projector normally
 * root-lifts these entries, so reject any broken/dangling projection here.
 */
inline bool validateRootLiftedItemsWire( const nlohmann::json& aWire,
                                         std::string& aError )
{
    if( !validateItemsWireShape( aWire, aError ) )
        return false;

    for( const char* categoryName : { "added", "changed" } )
    {
        auto category = aWire.find( categoryName );

        if( category == aWire.end() )
            continue;

        for( const nlohmann::json& entry : *category )
        {
            auto parent = entry.find( "parent" );

            if( parent != entry.end() && !parent->is_null() )
            {
                aError = std::string( "native items wire must be root-lifted: " )
                         + categoryName + " entry has a parent";
                return false;
            }
        }
    }

    aError.clear();
    return true;
}

/**
 * Validate identities after each native parser has extracted the authoritative
 * UUID from its blob. Categories must be sets and mutually disjoint. Apart from
 * defining one deterministic meaning, this prevents staging/deleting the same
 * native pointer twice for adversarial or corrupted batches.
 */
inline bool validateItemsBatchIds( const std::vector<std::string>& aRemoved,
                                   const std::vector<std::string>& aAdded,
                                   const std::vector<std::string>& aChanged,
                                   std::string& aError )
{
    std::set<std::string> seen;

    auto insertCategory = [&]( const std::vector<std::string>& aIds,
                               const char* aCategory ) -> bool
    {
        std::set<std::string> categoryIds;

        for( const std::string& id : aIds )
        {
            if( id.empty() )
            {
                aError = std::string( "empty parsed UUID in " ) + aCategory;
                return false;
            }

            if( !categoryIds.insert( id ).second )
            {
                aError = std::string( "duplicate parsed UUID in " ) + aCategory + ": " + id;
                return false;
            }

            if( !seen.insert( id ).second )
            {
                aError = std::string( "parsed UUID occurs in multiple categories: " ) + id;
                return false;
            }
        }

        return true;
    };

    if( !insertCategory( aRemoved, "removed" ) || !insertCategory( aAdded, "added" )
        || !insertCategory( aChanged, "changed" ) )
        return false;

    aError.clear();
    return true;
}

} // namespace pcbjam_collab
