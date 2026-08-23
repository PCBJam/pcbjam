#include "../collab_projection_fence.h"

#include <cassert>

using Fence = pcbjam_collab::ProjectionFence;
using Action = Fence::SaveAction;
using Lease = pcbjam_collab::ProjectionSaveLease;

int main()
{
    // Generated policy is exhaustive and keeps failure precedence.
    for( unsigned bits = 0; bits < 8; ++bits )
    {
        const bool acknowledged = ( bits & 4U ) != 0;
        const bool timedOut = ( bits & 2U ) != 0;
        const bool failed = ( bits & 1U ) != 0;
        const Action expected = failed ? Action::FailClosed
                                      : acknowledged ? Action::Persist
                                                     : timedOut ? Action::FailClosed
                                                                : Action::Wait;
        assert( pcbjam_collab::generated::decideSaveCut( acknowledged, timedOut, failed )
                == expected );
    }

    // No collaboration owner means no accepted projection debt.
    Fence fence;
    auto idle = fence.beginSave();
    assert( fence.decideSave( idle, false ) == Action::Persist );
    fence.endSave( idle );

    fence.acquireOwner();
    const auto first = fence.accept();
    assert( first );
    const auto firstCut = fence.beginSave();
    assert( fence.mayEnter( first ) );
    assert( fence.decideSave( firstCut, false ) == Action::Wait );
    assert( fence.appliedLatest( first ) );
    assert( fence.decideSave( firstCut, false ) == Action::Persist );

    // The cut stays frozen. New ingress is ticketed as retry debt but cannot
    // enter native while the writer is waiting/starting.
    const auto afterCut = fence.accept();
    assert( afterCut.sequence > firstCut.accepted );
    assert( !fence.mayEnter( afterCut ) );
    assert( fence.retryableNotEntered( afterCut ) );
    assert( fence.decideSave( firstCut, false ) == Action::Persist );
    fence.endSave( firstCut );

    // The concrete RAII lease spans the writer callback. An update accepted
    // after the frozen cut cannot enter native during that callback, and an
    // exception/early return releases the cut at scope exit.
    Fence writerFence;
    writerFence.acquireOwner();
    const auto beforeWriter = writerFence.accept();
    assert( writerFence.appliedLatest( beforeWriter ) );
    Fence::Ticket duringWriter;
    {
        Lease writerLease( writerFence );
        assert( writerLease );
        assert( writerLease.decide( false ) == Action::Persist );
        const auto writerCallback = [&]()
        {
            duringWriter = writerFence.accept();
            assert( duringWriter );
            assert( !writerFence.mayEnter( duringWriter ) );
        };
        writerCallback();
        assert( !writerFence.mayEnter( duringWriter ) );
    }
    assert( writerFence.mayEnter( duringWriter ) );
    assert( writerFence.appliedLatest( duringWriter ) );

    // A later successful latest-state projection covers the retryable debt.
    const auto retry = fence.accept();
    assert( fence.mayEnter( retry ) );
    const auto retryCut = fence.beginSave();
    assert( fence.decideSave( retryCut, false ) == Action::Wait );
    assert( fence.decideSave( retryCut, true ) == Action::FailClosed );
    assert( fence.appliedLatest( retry ) );
    assert( fence.applied() == retry.sequence );
    assert( fence.decideSave( retryCut, false ) == Action::Persist );
    fence.endSave( retryCut );

    // A terminal accepted result blocks this epoch. Unknown/stale tickets
    // cannot advance or poison a different owner epoch.
    const auto bad = fence.accept();
    const auto queuedAfterBad = fence.accept();
    assert( fence.failedPermanently( bad ) );
    assert( !fence.mayEnter( queuedAfterBad ) );
    const auto failedCut = fence.beginSave();
    assert( fence.decideSave( failedCut, false ) == Action::FailClosed );
    assert( !fence.appliedLatest( bad ) );
    assert( !fence.accept() );
    fence.endSave( failedCut );

    const auto failedEpoch = fence.epoch();
    fence.releaseOwner();
    assert( fence.abandoned() );
    auto abandonedCut = fence.beginSave();
    assert( fence.decideSave( abandonedCut, false ) == Action::FailClosed );
    fence.endSave( abandonedCut );

    fence.acquireOwner();
    assert( fence.epoch() > failedEpoch );
    assert( !fence.abandoned() );
    assert( fence.permanentFailure() == 0 );
    auto recoveredCut = fence.beginSave();
    assert( fence.decideSave( recoveredCut, false ) == Action::Persist );
    fence.endSave( recoveredCut );
    assert( !fence.appliedLatest( bad ) );

    // Releasing an owner with pending work is itself an abandoned projection;
    // a fresh owner is the only recovery boundary.
    const auto pending = fence.accept();
    const auto ownerCut = fence.beginSave();
    fence.releaseOwner();
    assert( fence.decideSave( ownerCut, false ) == Action::FailClosed );
    fence.endSave( ownerCut );
    assert( !fence.retryableNotEntered( pending ) );

    auto noOwnerCut = fence.beginSave();
    assert( fence.decideSave( noOwnerCut, false ) == Action::FailClosed );
    fence.endSave( noOwnerCut );
    fence.acquireOwner();
    auto finalCut = fence.beginSave();
    assert( fence.decideSave( finalCut, false ) == Action::Persist );
    assert( !fence.beginSave() ); // nested save cannot steal the active lease
    fence.endSave( finalCut );

    // A clean release leaves an ownerless editor saveable.
    fence.releaseOwner();
    auto cleanOwnerlessCut = fence.beginSave();
    assert( fence.decideSave( cleanOwnerlessCut, false ) == Action::Persist );
    fence.endSave( cleanOwnerlessCut );

    return 0;
}
