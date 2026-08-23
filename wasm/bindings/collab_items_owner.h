/*
 * Pure owner-generation guard for the native items projection protocol.
 *
 * Keep the JavaScript owner token and ProjectionFence epoch in one state
 * transition: acquiring a second owner while the first is still active would
 * otherwise reset accepted/applied/failure debt in ProjectionFence and let a
 * later save persist an unprojected document.
 */

#pragma once

#include "collab_projection_fence.h"

#include <string>
#include <utility>

namespace pcbjam_collab
{

class ItemsOwnerEpoch
{
public:
    /** Only an explicitly ownerless editor may start a fresh fence epoch. */
    bool tryAcquire( std::string aOwner, ProjectionFence& aFence )
    {
        if( aOwner.empty() || !m_active.empty() || aFence.ownerActive() )
            return false;

        m_active = std::move( aOwner );
        aFence.acquireOwner();
        return true;
    }

    /** Compare-and-release: a rejected/stale generation has no effect. */
    bool releaseIfMatches( const std::string& aOwner, ProjectionFence& aFence ) noexcept
    {
        if( aOwner.empty() || m_active != aOwner )
            return false;

        aFence.releaseOwner();
        m_active.clear();
        return true;
    }

    const std::string& active() const noexcept { return m_active; }
    bool empty() const noexcept { return m_active.empty(); }

private:
    std::string m_active;
};

} // namespace pcbjam_collab
