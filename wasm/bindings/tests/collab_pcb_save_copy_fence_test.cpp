#include "../collab_projection_fence.h"

#include <cassert>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

using Fence = pcbjam_collab::ProjectionFence;
using Lease = pcbjam_collab::ProjectionSaveLease;

namespace
{
template<typename MUTATE, typename WRITE, typename EXPORT>
bool savePcbCopyModel( Fence& aFence, MUTATE&& aMutate, WRITE&& aWrite, EXPORT&& aExport )
{
    Lease saveLease( aFence );

    if( !saveLease )
        return false;

    if( saveLease.decide( false ) != Fence::SaveAction::Persist )
        return false;

    aMutate();
    aWrite();
    aExport();
    return true;
}

std::string loadPcbFilesSource()
{
    std::ifstream source( "kicad/pcbnew/files.cpp" );
    assert( source && "run this host test from the pcbjam repository root" );

    std::ostringstream contents;
    contents << source.rdbuf();
    return contents.str();
}

void assertProductionGuardCoversWholeCopyPath()
{
    const std::string source = loadPcbFilesSource();
    const std::size_t begin = source.find( "bool PCB_EDIT_FRAME::SavePcbCopy(" );
    const std::size_t end = source.find( "bool PCB_EDIT_FRAME::importFile(", begin );
    assert( begin != std::string::npos );
    assert( end != std::string::npos );

    const std::string body = source.substr( begin, end - begin );
    const std::size_t guard = body.find( "COLLAB_SAVE_GUARD collabSaveGuard" );
    const std::size_t failClosed = body.find( "if( !collabSaveGuard )" );
    const std::size_t projectMutation = body.find( "SaveProjectLocalSettings()" );
    const std::size_t boardMutation = body.find( "SynchronizeNetsAndNetClasses" );
    const std::size_t boardWriter = body.find( "pi->SaveBoard" );
    const std::size_t projectExport = body.find( "SaveProjectCopy" );
    const std::size_t rulesExport = body.find( "KiCopyFile" );

    assert( guard != std::string::npos );
    assert( failClosed != std::string::npos );
    assert( projectMutation != std::string::npos );
    assert( boardMutation != std::string::npos );
    assert( boardWriter != std::string::npos );
    assert( projectExport != std::string::npos );
    assert( rulesExport != std::string::npos );
    assert( guard < failClosed );
    assert( failClosed < projectMutation );
    assert( guard < boardMutation );
    assert( guard < boardWriter );
    assert( guard < projectExport );
    assert( guard < rulesExport );
}
}

int main()
{
    assertProductionGuardCoversWholeCopyPath();

    Fence fence;
    fence.acquireOwner();
    const auto initial = fence.accept();
    assert( fence.appliedLatest( initial ) );

    Fence::Ticket duringMutation;
    Fence::Ticket duringWriter;
    Fence::Ticket duringExport;
    bool nestedSaveRejected = false;

    assert( savePcbCopyModel(
            fence,
            [&]()
            {
                duringMutation = fence.accept();
                assert( !fence.mayEnter( duringMutation ) );
            },
            [&]()
            {
                duringWriter = fence.accept();
                assert( !fence.mayEnter( duringMutation ) );
                assert( !fence.mayEnter( duringWriter ) );

                Lease nestedSave( fence );
                nestedSaveRejected = !nestedSave;
            },
            [&]()
            {
                duringExport = fence.accept();
                assert( !fence.mayEnter( duringMutation ) );
                assert( !fence.mayEnter( duringWriter ) );
                assert( !fence.mayEnter( duringExport ) );
            } ) );
    assert( nestedSaveRejected );

    // Scope exit releases the one Save-a-Copy lease. A latest-state retry may
    // now enter and acknowledges every ticket accumulated at its frozen cut.
    assert( fence.mayEnter( duringExport ) );
    assert( fence.appliedLatest( duringExport ) );
    assert( fence.applied() == duringExport.sequence );

    // Exceptions and early returns cannot strand the save lease.
    bool threw = false;

    try
    {
        savePcbCopyModel(
                fence,
                []() {},
                []() { throw std::runtime_error( "writer failed" ); },
                []() {} );
    }
    catch( const std::runtime_error& )
    {
        threw = true;
    }

    assert( threw );
    Lease afterFailure( fence );
    assert( afterFailure );

    return 0;
}
