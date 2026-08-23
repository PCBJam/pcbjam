/*
 * Pure pcbnew collaboration root/reference policy.
 *
 * Keep this header free of KiCad, wxWidgets, and Emscripten dependencies.  The
 * production binding instantiates the templates with BOARD/BOARD_ITEM while the
 * adjacent native unit test uses tiny fake collections.  That gives the manual
 * root inventory, NETINFO dirty fan-out, and accepted-reference mapping one
 * executable specification without booting an editor.
 */

#pragma once

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace pcbjam_collab
{

/**
 * Visit every persisted pcbnew board-file root collection exactly once.
 *
 * Markers are intentionally absent: KiCad's board writer deliberately omits
 * them.  PCB_POINT must be present even though points are much newer and rarer
 * than the original footprint/track/zone/drawing collections.
 */
template <typename Board, typename Fn>
void forEachPcbRootItem( Board& aBoard, Fn&& aFn )
{
    for( auto* item : aBoard.Footprints() ) aFn( item );
    for( auto* item : aBoard.Tracks() )     aFn( item );
    for( auto* item : aBoard.Zones() )      aFn( item );
    for( auto* item : aBoard.Drawings() )   aFn( item );
    for( auto* item : aBoard.Points() )     aFn( item );
    for( auto* item : aBoard.Groups() )     aFn( item );
    for( auto* item : aBoard.Generators() ) aFn( item );
}

enum class PcbDirtyScope
{
    Item,
    NetTable,
};

struct PcbItemTreeIds
{
    std::string              root;
    std::vector<std::string> ids;
};

struct PcbTableCellSpan
{
    int columns = 1;
    int rows = 1;
};

struct PcbRootPersistability
{
    bool                          containsInvalidPolygon = false;
    bool                          isTable = false;
    int                           tableColumns = 0;
    std::vector<PcbTableCellSpan> tableCells;
};

/**
 * Reject parsed roots which KiCad either omits from the writer or cannot pass
 * safely through BOARD_COMMIT geometry. This is deliberately a small semantic
 * summary so the same policy is executable without a BOARD/editor process.
 */
inline bool validatePcbRootPersistability( const PcbRootPersistability& aRoot,
                                           std::string& aError )
{
    if( aRoot.containsInvalidPolygon )
    {
        aError = "PCB root contains a polygon which the writer would omit";
        return false;
    }

    if( !aRoot.isTable )
    {
        aError.clear();
        return true;
    }

    if( aRoot.tableColumns <= 0 || aRoot.tableCells.empty()
        || aRoot.tableCells.size() % static_cast<size_t>( aRoot.tableColumns ) != 0 )
    {
        aError = "PCB table has an invalid row/column shape";
        return false;
    }

    const int rows = static_cast<int>( aRoot.tableCells.size() ) / aRoot.tableColumns;

    for( size_t index = 0; index < aRoot.tableCells.size(); ++index )
    {
        const PcbTableCellSpan& span = aRoot.tableCells[index];
        const int row = static_cast<int>( index ) / aRoot.tableColumns;
        const int column = static_cast<int>( index ) % aRoot.tableColumns;

        if( span.columns <= 0 || span.rows <= 0
            || column + span.columns > aRoot.tableColumns || row + span.rows > rows )
        {
            aError = "PCB table cell span escapes the table";
            return false;
        }
    }

    aError.clear();
    return true;
}

/**
 * Compute the exact UUID universe after a root-replacement batch.
 *
 * A parsed root may reuse UUIDs from the tree it replaces, but no UUID may
 * collide with an unrelated live tree or another parsed tree.  Treating a
 * live child UUID as an upsert root is rejected: the native applier replaces
 * complete persisted roots and cannot safely splice an arbitrary child.
 * Everything is computed in local containers, so rejection has no native
 * side effect.
 */
inline bool projectPcbPostItemUniverse(
        const std::vector<PcbItemTreeIds>& aLiveTrees,
        const std::set<std::string>& aReservedIds,
        const std::vector<std::string>& aRemoved,
        const std::vector<PcbItemTreeIds>& aUpserts,
        std::set<std::string>& aPostRoots,
        std::set<std::string>& aPostItems,
        std::string& aError )
{
    std::map<std::string, std::vector<std::string>> trees;
    std::map<std::string, std::string>              rootByItem;

    auto installTree = [&]( const PcbItemTreeIds& aTree,
                            const char* aContext ) -> bool
    {
        if( aTree.root.empty() || aTree.ids.empty()
            || std::find( aTree.ids.begin(), aTree.ids.end(), aTree.root )
                       == aTree.ids.end() )
        {
            aError = std::string( aContext ) + " PCB item tree has no valid root";
            return false;
        }

        std::set<std::string> local;

        for( const std::string& id : aTree.ids )
        {
            if( id.empty() || !local.insert( id ).second )
            {
                aError = std::string( aContext ) + " PCB item tree repeats UUID: " + id;
                return false;
            }

            auto [it, inserted] = rootByItem.emplace( id, aTree.root );

            if( !inserted )
            {
                aError = std::string( aContext ) + " PCB item UUID collides with root "
                         + it->second + ": " + id;
                return false;
            }
        }

        if( !trees.emplace( aTree.root, aTree.ids ).second )
        {
            aError = std::string( aContext ) + " PCB root occurs more than once: "
                     + aTree.root;
            return false;
        }

        return true;
    };

    for( const PcbItemTreeIds& tree : aLiveTrees )
    {
        if( !installTree( tree, "live" ) )
            return false;
    }

    for( const std::string& id : aReservedIds )
    {
        if( id.empty() )
        {
            aError = "reserved PCB identity is empty";
            return false;
        }

        if( rootByItem.count( id ) )
        {
            aError = "reserved PCB identity collides with a persisted item: " + id;
            return false;
        }
    }

    auto eraseTree = [&]( const std::string& aRoot )
    {
        auto tree = trees.find( aRoot );

        if( tree == trees.end() )
            return;

        for( const std::string& id : tree->second )
            rootByItem.erase( id );

        trees.erase( tree );
    };

    std::set<std::string> upsertRoots;

    for( const PcbItemTreeIds& tree : aUpserts )
        upsertRoots.insert( tree.root );

    for( const std::string& id : aRemoved )
    {
        if( aReservedIds.count( id ) )
        {
            aError = "PCB item removal targets a reserved identity: " + id;
            return false;
        }

        auto item = rootByItem.find( id );

        if( item == rootByItem.end() )
            continue; // idempotent removal of an already-absent UUID

        if( item->second == id )
        {
            eraseTree( id );
        }
        else
        {
            // BOARD_COMMIT promotes owned children (footprint fields/pads,
            // table cells, and future container children) to a modification
            // of their persisted root. Deleting the child pointer afterward
            // would leave that root owning freed memory. The only lossless
            // wire is the root's complete replacement; the raw child removal
            // then becomes redundant and is deliberately ignored.
            if( !upsertRoots.count( item->second ) )
            {
                aError = "PCB child removal requires replacement of root "
                         + item->second + ": " + id;
                return false;
            }
        }
    }

    for( const PcbItemTreeIds& tree : aUpserts )
    {
        for( const std::string& id : tree.ids )
        {
            if( aReservedIds.count( id ) )
            {
                aError = "PCB upsert collides with a reserved identity: " + id;
                return false;
            }
        }

        auto existing = rootByItem.find( tree.root );

        if( existing != rootByItem.end() && existing->second != tree.root )
        {
            aError = "PCB upsert UUID resolves to a child of root " + existing->second
                     + ": " + tree.root;
            return false;
        }

        eraseTree( tree.root );

        if( !installTree( tree, "upsert" ) )
            return false;
    }

    aPostRoots.clear();
    aPostItems.clear();

    for( const auto& [root, ids] : trees )
    {
        (void) ids;
        aPostRoots.insert( root );
    }

    for( const auto& [id, root] : rootByItem )
    {
        (void) root;
        aPostItems.insert( id );
    }

    aError.clear();
    return true;
}

/**
 * Expand one listener callback to the persisted roots whose blobs may differ.
 *
 * A NETINFO_ITEM is not itself board-file item content: current KiCad stores a
 * net name on every connected pad/track/zone/shape.  Add/remove/rename can also
 * reassign those objects without firing an individual item callback, so the
 * only lossless dirty set is every connected root, deduplicated after lifting
 * footprint children to their footprint.
 */
template <typename ChangedPtr, typename ConnectedRange, typename RootFn, typename SinkFn>
void forEachPcbDirtyRoot( ChangedPtr aChanged, PcbDirtyScope aScope,
                          const ConnectedRange& aConnected, RootFn&& aRoot,
                          SinkFn&& aSink )
{
    using RootPtr = decltype( aRoot( aChanged ) );
    std::set<RootPtr> seen;

    auto visit = [&]( auto* aCandidate )
    {
        RootPtr root = aRoot( aCandidate );

        if( root && seen.insert( root ).second )
            aSink( root );
    };

    if( aScope == PcbDirtyScope::NetTable )
    {
        for( auto* item : aConnected )
            visit( item );
    }
    else
    {
        visit( aChanged );
    }
}

/**
 * Resolve the net-name references of an already accepted parsed root.
 *
 * Parsing deliberately does not call this helper: source items continue to
 * reference their isolated envelope board until the complete batch validates.
 * The caller supplies a resolver which may return an existing live net or a
 * not-yet-staged planned net.  Returning null aborts preparation before commit.
 */
template <typename ConnectedRange, typename NameFn, typename ResolveFn, typename AssignFn>
bool resolvePcbConnectedNets( const ConnectedRange& aConnected, NameFn&& aName,
                              ResolveFn&& aResolve, AssignFn&& aAssign )
{
    for( auto&& item : aConnected )
    {
        auto* net = aResolve( aName( item ) );

        if( !net )
            return false;

        aAssign( item, net );
    }

    return true;
}

} // namespace pcbjam_collab
