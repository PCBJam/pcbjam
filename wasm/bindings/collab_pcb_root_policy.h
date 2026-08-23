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

#include <set>

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
