#include "../collab_items_owner.h"

#include <cassert>

using Fence = pcbjam_collab::ProjectionFence;
using Owner = pcbjam_collab::ItemsOwnerEpoch;
using Action = Fence::SaveAction;

int main()
{
    Fence fence;
    Owner owner;

    assert( !owner.tryAcquire( "", fence ) );
    assert( !owner.releaseIfMatches( "", fence ) );
    assert( owner.tryAcquire( "first", fence ) );
    assert( owner.active() == "first" );

    const auto firstEpoch = fence.epoch();
    const auto pending = fence.accept();
    const auto saveCut = fence.beginSave();
    assert( pending );
    assert( saveCut );
    assert( fence.decideSave( saveCut, false ) == Action::Wait );

    // This was the takeover hole: a second acquire used to advance the epoch
    // and reset accepted/applied debt even though the first JS owner survived.
    assert( !owner.tryAcquire( "second", fence ) );
    assert( owner.active() == "first" );
    assert( fence.epoch() == firstEpoch );
    assert( fence.accepted() == pending.sequence );
    assert( fence.mayEnter( pending ) );
    assert( fence.decideSave( saveCut, false ) == Action::Wait );

    // A rejected generation cannot release the real owner or its save cut.
    assert( !owner.releaseIfMatches( "second", fence ) );
    assert( owner.active() == "first" );
    assert( fence.ownerActive() );
    assert( fence.appliedLatest( pending ) );
    assert( fence.decideSave( saveCut, false ) == Action::Persist );
    fence.endSave( saveCut );

    // Nor can takeover erase a terminal projection result once the queue is
    // idle. Only compare-and-release by the active owner opens recovery.
    const auto failed = fence.accept();
    assert( fence.failedPermanently( failed ) );
    assert( !owner.tryAcquire( "second", fence ) );
    assert( fence.epoch() == firstEpoch );
    assert( fence.permanentFailure() == failed.sequence );

    assert( owner.releaseIfMatches( "first", fence ) );
    assert( owner.empty() );
    assert( !fence.ownerActive() );

    assert( owner.tryAcquire( "fresh", fence ) );
    assert( owner.active() == "fresh" );
    assert( fence.epoch() > firstEpoch );
    assert( fence.permanentFailure() == 0 );
    assert( !fence.abandoned() );
    assert( owner.releaseIfMatches( "fresh", fence ) );

    return 0;
}
