#include "../../../kicad/eeschema/collab_save_scope.h"
#include "../collab_projection_fence.h"

#include <cassert>
#include <memory>
#include <string>
#include <vector>

namespace
{
using Fence = pcbjam_collab::ProjectionFence;
using Lease = pcbjam_collab::ProjectionSaveLease;

Fence                    s_fence;
std::unique_ptr<Lease>   s_lease;
bool                     s_forceReject = false;
unsigned                 s_acquireCount = 0;
unsigned                 s_releaseCount = 0;
std::vector<std::string> s_events;

bool acquireSave()
{
    ++s_acquireCount;

    if( s_forceReject || s_lease )
        return false;

    s_lease = std::make_unique<Lease>( s_fence );

    if( !( *s_lease )
        || s_lease->decide( false ) != Fence::SaveAction::Persist )
    {
        s_lease.reset();
        return false;
    }

    s_events.emplace_back( "acquire" );
    return true;
}

void releaseSave()
{
    assert( s_lease );
    ++s_releaseCount;
    s_events.emplace_back( "release" );
    s_lease.reset();
}

void writeAndNotify( const char* aWrite, const char* aNotify )
{
    assert( s_lease );
    s_events.emplace_back( aWrite );
    assert( s_lease );
    s_events.emplace_back( aNotify );
}
}

int main()
{
    using Scope = EESCHEMA_COLLAB_SAVE_SCOPE;

    s_fence.acquireOwner();
    const Fence::Ticket initial = s_fence.accept();
    assert( initial );
    assert( s_fence.appliedLatest( initial ) );

    // A whole project save owns exactly one native cut.  Each schematic file
    // explicitly borrows it, so a multi-sheet traversal never tries to acquire
    // (and reject) a nested cut.
    {
        Scope project( nullptr, acquireSave, releaseSave );
        assert( project );
        assert( project.ownsLease() );
        assert( s_acquireCount == 1 );

        {
            Scope rootSheet( &project, acquireSave, releaseSave );
            assert( rootSheet );
            assert( !rootSheet.ownsLease() );
            assert( s_acquireCount == 1 );
            writeAndNotify( "write-root", "notify-root" );
        }

        assert( s_lease );
        assert( s_releaseCount == 0 );

        {
            Scope childSheet( &project, acquireSave, releaseSave );
            assert( childSheet );
            assert( !childSheet.ownsLease() );
            assert( s_acquireCount == 1 );
            writeAndNotify( "write-child", "notify-child" );
        }

        // The final project callback observes bytes only after the final
        // sheet-map/settings writer, while the outer cut is still frozen.
        writeAndNotify( "write-final-project", "notify-final-project" );
        const Fence::Ticket injectedByFinalCallback = s_fence.accept();
        assert( injectedByFinalCallback );
        assert( !s_fence.mayEnter( injectedByFinalCallback ) );
        assert( s_fence.retryableNotEntered( injectedByFinalCallback ) );
        assert( s_lease );
        assert( s_releaseCount == 0 );

        // Keep the ticket for the post-scope retry assertion.
        assert( injectedByFinalCallback.sequence == 2 );
    }

    assert( !s_lease );
    assert( s_releaseCount == 1 );
    assert( ( s_events == std::vector<std::string>{
                                "acquire",
                                "write-root",
                                "notify-root",
                                "write-child",
                                "notify-child",
                                "write-final-project",
                                "notify-final-project",
                                "release" } ) );

    // Once SaveProject returns, the bridge's retry can enter and its complete
    // latest-state projection covers the callback's retryable ticket.
    const Fence::Ticket retry = s_fence.accept();
    assert( retry );
    assert( s_fence.mayEnter( retry ) );
    assert( s_fence.appliedLatest( retry ) );

    // A direct single-sheet save still owns and releases its own cut.
    {
        Scope direct( nullptr, acquireSave, releaseSave );
        assert( direct );
        assert( direct.ownsLease() );
        assert( s_acquireCount == 2 );
    }
    assert( s_releaseCount == 2 );

    // A failed outer acquisition cannot be turned into a valid lease merely
    // by constructing a borrower.
    s_forceReject = true;
    {
        Scope rejected( nullptr, acquireSave, releaseSave );
        assert( !rejected );
        assert( !rejected.ownsLease() );

        Scope invalidBorrow( &rejected, acquireSave, releaseSave );
        assert( !invalidBorrow );
        assert( !invalidBorrow.ownsLease() );
    }
    s_forceReject = false;
    assert( s_releaseCount == 2 );

    return 0;
}
