/*
 * Revision-ticket protocol for the v2 items bridge.
 *
 * kicadCollabApplyItems() submits pcbnew/eeschema work to a CallAfter +
 * COROUTINE queue, so returning from the embind call is not completion.  A
 * tracked wire carries `_pcbjam:{requestId,ownerGeneration}` and the actual
 * native tail emits a matching onItemsApplied acknowledgement.  The owner is
 * checked again when queued work starts, isolating a destroyed/sheet-switched
 * binding from the editor that replaced it.
 */

#pragma once

#ifdef __EMSCRIPTEN__

#include "collab_common.h"
#include "open_gate.h"

#include <emscripten.h>
#include <nlohmann/json.hpp>
#include <string>
#include <utility>

namespace pcbjam_collab
{

struct ItemsProtocolRequest
{
    std::string requestId;
    std::string ownerGeneration;
    bool        metadataPresent = false;
    bool        metadataValid = true;

    bool tracked() const { return !requestId.empty() && !ownerGeneration.empty(); }
};

inline ItemsProtocolRequest itemsProtocolRequest( const nlohmann::json& aWire )
{
    ItemsProtocolRequest out;

    if( !aWire.is_object() )
        return out;

    auto it = aWire.find( "_pcbjam" );

    if( it == aWire.end() )
        return out;

    out.metadataPresent = true;

    if( !it->is_object() )
    {
        out.metadataValid = false;
        return out;
    }

    auto request = it->find( "requestId" );
    auto owner = it->find( "ownerGeneration" );

    if( request != it->end() && request->is_string() )
        out.requestId = request->get<std::string>();

    if( owner != it->end() && owner->is_string() )
        out.ownerGeneration = owner->get<std::string>();

    out.metadataValid = out.tracked();

    return out;
}

inline std::string& activeItemsOwner()
{
    static std::string owner;
    return owner;
}

inline void setItemsOwner( std::string aOwner )
{
    activeItemsOwner() = std::move( aOwner );
}

/**
 * Acquire only across an idle queue boundary. In particular, a new binding
 * cannot snapshot while an old commit is suspended, its echo-flush is still
 * queued, or a file-open owns the model gate. The JS adapter treats false as
 * a retryable owner-acquire error.
 */
inline bool acquireItemsOwner( std::string aOwner )
{
    if( aOwner.empty() || appliesPending() || pcbjam_open::busy() )
        return false;

    projectionFence().acquireOwner();
    setItemsOwner( std::move( aOwner ) );
    return true;
}

/** Deterministic in-commit suspension used only by the native lifecycle E2E. */
inline int& itemsApplyTestParkMs()
{
    static int duration = 0;
    return duration;
}

inline void setItemsApplyTestPark( int aDurationMs )
{
    itemsApplyTestParkMs() = aDurationMs > 0 ? aDurationMs : 0;
}

inline void parkItemsApplyForTest()
{
    if( itemsApplyTestParkMs() > 0 )
        emscripten_sleep( itemsApplyTestParkMs() );
}

/** Compare-and-release: an old binding cannot clear the owner that replaced it. */
inline void releaseItemsOwner( std::string aOwner )
{
    if( activeItemsOwner() == aOwner )
    {
        projectionFence().releaseOwner();
        activeItemsOwner().clear();
    }
}

inline bool itemsOwnerMatches( const ItemsProtocolRequest& aRequest )
{
    if( aRequest.metadataPresent )
        return aRequest.metadataValid && activeItemsOwner() == aRequest.ownerGeneration;

    // Preserve legacy/direct harness calls only before an acknowledged bridge
    // has acquired the singleton editor. Once owned, untracked work may not
    // bypass lifecycle isolation.
    return activeItemsOwner().empty();
}

inline ProjectionFence::Ticket acceptItemsProjection( const ItemsProtocolRequest& aRequest )
{
    if( !aRequest.tracked() || activeItemsOwner() != aRequest.ownerGeneration )
        return {};

    return projectionFence().accept();
}

inline void emitItemsApplied( const ItemsProtocolRequest& aRequest, const char* aStatus,
                              bool aRetryable = false, const std::string& aError = {},
                              ProjectionFence::Ticket aTicket = {} )
{
    // Settle the native frontier BEFORE calling arbitrary JS. A synchronous
    // save triggered by an ACK observer must see this exact outcome, and a
    // stale ticket from an older owner epoch is ignored by ProjectionFence.
    if( aTicket )
    {
        if( std::string( aStatus ) == "applied" )
            (void) projectionFence().appliedLatest( aTicket );
        else if( aRetryable )
            (void) projectionFence().retryableNotEntered( aTicket );
        else
            (void) projectionFence().failedPermanently( aTicket );
    }

    if( !aRequest.tracked() )
        return; // legacy/direct test calls retain their fire-and-forget behavior

    nlohmann::json ack = {
        { "requestId", aRequest.requestId },
        { "ownerGeneration", aRequest.ownerGeneration },
        { "status", aStatus },
        { "retryable", aRetryable },
    };

    if( !aError.empty() )
        ack["error"] = aError;

    std::string payload = ack.dump();
    EM_ASM( {
        try
        {
            if( window.kicadCollab && window.kicadCollab.onItemsApplied )
                window.kicadCollab.onItemsApplied( UTF8ToString( $0 ) );
        }
        catch( error )
        {
            console.error( "native items acknowledgement listener failed", error );
        }
    }, payload.c_str() );
}

inline void emitStaleItemsOwner( const ItemsProtocolRequest& aRequest,
                                 ProjectionFence::Ticket aTicket = {} )
{
    emitItemsApplied( aRequest, "stale-owner", false,
                      "items request belongs to an inactive binding generation", aTicket );
}

} // namespace pcbjam_collab

#endif // __EMSCRIPTEN__
