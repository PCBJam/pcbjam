#include "../../../kicad/eeschema/collab_save_scope.h"

#include <cassert>
#include <string>
#include <vector>

namespace
{
bool                     s_saveActive = false;
unsigned                 s_acquireCount = 0;
unsigned                 s_releaseCount = 0;
std::vector<std::string> s_events;

bool acquireSave()
{
    ++s_acquireCount;

    if( s_saveActive )
        return false;

    s_saveActive = true;
    s_events.emplace_back( "acquire" );
    return true;
}

void releaseSave()
{
    assert( s_saveActive );
    ++s_releaseCount;
    s_events.emplace_back( "release" );
    s_saveActive = false;
}

void writeAndNotify( const char* aWrite, const char* aNotify )
{
    assert( s_saveActive );
    s_events.emplace_back( aWrite );
    assert( s_saveActive );
    s_events.emplace_back( aNotify );
}
}

int main()
{
    using Scope = EESCHEMA_COLLAB_SAVE_SCOPE;

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

        assert( s_saveActive );
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
        assert( s_saveActive );
        assert( s_releaseCount == 0 );
    }

    assert( !s_saveActive );
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
    s_saveActive = true;
    {
        Scope rejected( nullptr, acquireSave, releaseSave );
        assert( !rejected );
        assert( !rejected.ownsLease() );

        Scope invalidBorrow( &rejected, acquireSave, releaseSave );
        assert( !invalidBorrow );
        assert( !invalidBorrow.ownsLease() );
    }
    s_saveActive = false;
    assert( s_releaseCount == 2 );

    return 0;
}
