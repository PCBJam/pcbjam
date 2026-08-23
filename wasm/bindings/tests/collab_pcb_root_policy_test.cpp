#include "../collab_pcb_root_policy.h"

#include <cassert>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace
{

struct Item
{
    std::string id;
    Item*       parent = nullptr;
};

struct Board
{
    std::vector<Item*> footprints;
    std::vector<Item*> tracks;
    std::vector<Item*> zones;
    std::vector<Item*> drawings;
    std::vector<Item*> points;
    std::vector<Item*> groups;
    std::vector<Item*> generators;

    const auto& Footprints() const { return footprints; }
    const auto& Tracks() const { return tracks; }
    const auto& Zones() const { return zones; }
    const auto& Drawings() const { return drawings; }
    const auto& Points() const { return points; }
    const auto& Groups() const { return groups; }
    const auto& Generators() const { return generators; }
};

} // namespace

int main()
{
    Item footprint{ "footprint" };
    Item track{ "track" };
    Item zone{ "zone" };
    Item drawing{ "drawing" };
    Item point{ "point" };
    Item group{ "group" };
    Item generator{ "generator" };

    Board board{ { &footprint }, { &track }, { &zone }, { &drawing },
                 { &point }, { &group }, { &generator } };
    std::vector<std::string> roots;
    pcbjam_collab::forEachPcbRootItem( board,
            [&]( Item* aItem ) { roots.push_back( aItem->id ); } );
    assert( ( roots == std::vector<std::string>{ "footprint", "track", "zone", "drawing",
                                                "point", "group", "generator" } ) );

    Item field{ "field", &footprint };
    Item padA{ "pad-a", &footprint };
    Item padB{ "pad-b", &footprint };
    Item netInfo{ "net-info" };
    std::vector<Item*> connected{ &padA, &padB, &track, &zone };
    auto rootOf = []( Item* aItem ) { return aItem && aItem->parent ? aItem->parent : aItem; };

    std::vector<std::string> dirty;
    pcbjam_collab::forEachPcbDirtyRoot( &field, pcbjam_collab::PcbDirtyScope::Item,
            connected, rootOf, [&]( Item* aItem ) { dirty.push_back( aItem->id ); } );
    assert( ( dirty == std::vector<std::string>{ "footprint" } ) );

    dirty.clear();
    pcbjam_collab::forEachPcbDirtyRoot( &netInfo, pcbjam_collab::PcbDirtyScope::NetTable,
            connected, rootOf, [&]( Item* aItem ) { dirty.push_back( aItem->id ); } );
    assert( ( dirty == std::vector<std::string>{ "footprint", "track", "zone" } ) );

    // Parsed references stay inert until the accepted-batch phase explicitly
    // invokes the resolver. Two items sharing a new name reuse one planned net.
    struct Net
    {
        std::string name;
    };
    struct Connected
    {
        std::string id;
        std::string name;
        Net*        net = nullptr;
    };
    struct Blob
    {
        std::string id;
        std::string netName;
    };

    Net existing{ "EXISTING" };
    std::map<std::string, Net> plannedNets;
    int resolverCalls = 0;
    int plannedCreates = 0;
    std::vector<Net*> lastAssignments;

    // Tiny app-free model of the production boundary: parse every entry into isolated values;
    // only after the loop accepts the whole batch may the live/planned-net resolver run.
    auto applyBatch = [&]( const std::vector<Blob>& aBlobs ) -> bool
    {
        std::vector<Connected> parsed;

        for( const Blob& blob : aBlobs )
            parsed.push_back( { blob.id, blob.netName } );

        std::set<std::string> acceptedIds;

        for( const Connected& item : parsed )
        {
            if( !acceptedIds.insert( item.id ).second )
                return false;
        }

        std::vector<Connected*> connected;

        for( Connected& item : parsed )
            connected.push_back( &item );

        bool resolved = pcbjam_collab::resolvePcbConnectedNets(
                connected,
                []( Connected* aItem ) { return aItem->name; },
                [&]( const std::string& aName ) -> Net*
                {
                    ++resolverCalls;

                    if( aName == "EXISTING" )
                        return &existing;

                    auto [it, inserted] = plannedNets.try_emplace( aName, Net{ aName } );

                    if( inserted )
                        ++plannedCreates;

                    // Production deduplicates planned NETINFO_ITEMs by name. Returning the same
                    // pointer here makes that observable without a BOARD or an editor process.
                    return &it->second;
                },
                []( Connected* aItem, Net* aNet ) { aItem->net = aNet; } );

        lastAssignments.clear();

        for( const Connected& item : parsed )
            lastAssignments.push_back( item.net );

        return resolved;
    };

    assert( !applyBatch( { { "root-a", "NEW" }, { "root-a", "NEW" } } ) );
    assert( resolverCalls == 0 );
    assert( plannedCreates == 0 );
    assert( lastAssignments.empty() );

    // Retrying the accepted batch performs resolution once the parse phase is complete, retains
    // the existing mapping, and shares one planned net between both NEW references.
    assert( applyBatch( { { "root-a", "NEW" }, { "root-b", "NEW" },
                          { "root-c", "EXISTING" } } ) );
    assert( resolverCalls == 3 );
    assert( plannedCreates == 1 );
    Net* planned = &plannedNets.at( "NEW" );
    assert( ( lastAssignments == std::vector<Net*>{ planned, planned, &existing } ) );

    // Root replacement is validated over the complete owned UUID tree before
    // the native board is touched. A replacement may reuse its own descendants,
    // but it may not steal a child identity from an unrelated live root.
    using pcbjam_collab::PcbItemTreeIds;
    const std::vector<PcbItemTreeIds> liveTrees{
        { "root-a", { "root-a", "child-a", "child-b" } },
        { "root-b", { "root-b", "child-c" } },
    };
    std::set<std::string> postRoots;
    std::set<std::string> postItems;
    std::string           treeError;

    assert( pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, {}, {}, { { "root-a", { "root-a", "child-a", "child-new" } } },
            postRoots, postItems, treeError ) );
    assert( ( postRoots == std::set<std::string>{ "root-a", "root-b" } ) );
    assert( ( postItems == std::set<std::string>{
            "root-a", "child-a", "child-new", "root-b", "child-c" } ) );

    assert( !pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, {}, {}, { { "root-a", { "root-a", "child-c" } } },
            postRoots, postItems, treeError ) );
    assert( treeError.find( "collides" ) != std::string::npos );

    // A child UUID cannot be promoted into an independently replaceable root.
    assert( !pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, {}, {}, { { "child-a", { "child-a" } } },
            postRoots, postItems, treeError ) );
    assert( treeError.find( "resolves to a child" ) != std::string::npos );

    assert( !pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, {}, {}, { { "root-a", { "root-a", "root-a" } } },
            postRoots, postItems, treeError ) );
    assert( treeError.find( "repeats UUID" ) != std::string::npos );

    // Removing a whole root makes every owned UUID reusable in the same atomic
    // batch. A raw child removal is only meaningful beside the complete
    // replacement root that owns it.
    assert( pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, {}, { "root-b" }, { { "root-c", { "root-c", "child-c" } } },
            postRoots, postItems, treeError ) );
    assert( ( postRoots == std::set<std::string>{ "root-a", "root-c" } ) );
    assert( postItems.count( "child-c" ) == 1 );

    assert( !pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, {}, { "child-a", "already-absent" }, {},
            postRoots, postItems, treeError ) );
    assert( treeError.find( "requires replacement" ) != std::string::npos );

    assert( pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, {}, { "child-a", "already-absent" },
            { { "root-a", { "root-a", "child-b" } } },
            postRoots, postItems, treeError ) );
    assert( postRoots.count( "root-a" ) == 1 );
    assert( postItems.count( "child-a" ) == 0 );
    assert( postItems.count( "child-b" ) == 1 );

    assert( !pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, { "reserved" }, { "reserved" }, {},
            postRoots, postItems, treeError ) );
    assert( treeError.find( "reserved identity" ) != std::string::npos );
    assert( !pcbjam_collab::projectPcbPostItemUniverse(
            liveTrees, { "reserved" }, {}, { { "new", { "new", "reserved" } } },
            postRoots, postItems, treeError ) );
    assert( treeError.find( "reserved identity" ) != std::string::npos );

    using pcbjam_collab::PcbRootPersistability;
    using pcbjam_collab::PcbTableCellSpan;
    assert( pcbjam_collab::validatePcbRootPersistability(
            PcbRootPersistability{}, treeError ) );
    assert( !pcbjam_collab::validatePcbRootPersistability(
            PcbRootPersistability{ true, false, 0, {} }, treeError ) );
    assert( treeError.find( "polygon" ) != std::string::npos );
    assert( !pcbjam_collab::validatePcbRootPersistability(
            PcbRootPersistability{ false, true, 0, {} }, treeError ) );
    assert( !pcbjam_collab::validatePcbRootPersistability(
            PcbRootPersistability{ false, true, 2, { { 1, 1 } } }, treeError ) );
    assert( pcbjam_collab::validatePcbRootPersistability(
            PcbRootPersistability{ false, true, 2,
                    { PcbTableCellSpan{}, PcbTableCellSpan{},
                      PcbTableCellSpan{}, PcbTableCellSpan{} } }, treeError ) );
    assert( !pcbjam_collab::validatePcbRootPersistability(
            PcbRootPersistability{ false, true, 2,
                    { { 3, 1 }, { 1, 1 }, { 1, 1 }, { 1, 1 } } }, treeError ) );
    assert( treeError.find( "span" ) != std::string::npos );

    return 0;
}
