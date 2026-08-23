/*
 * Pure native refinement of the verified SaveCut policy.
 *
 * This header deliberately has no wxWidgets/Emscripten dependency so the
 * owner/ticket/save state machine can be compiled and tested on the host.  The
 * generated truth table is the only save decision policy; this class supplies
 * its concrete premises and rejects stale owner/ticket outcomes.
 */

#pragma once

#include "generated/save_cut_decision.h"

#include <cstdint>

namespace pcbjam_collab
{

class ProjectionFence
{
public:
    using SaveAction = generated::SaveCutAction;

    struct Ticket
    {
        std::uint64_t epoch = 0;
        std::uint64_t sequence = 0;

        explicit operator bool() const noexcept { return sequence != 0; }
    };

    struct SaveCut
    {
        std::uint64_t epoch = 0;
        std::uint64_t accepted = 0;
        std::uint64_t lease = 0;

        explicit operator bool() const noexcept { return lease != 0; }
    };

    /** A newly acquired bridge owner is the explicit recovery boundary. */
    void acquireOwner() noexcept
    {
        ++m_epoch;
        m_ownerActive = true;
        m_accepted = 0;
        m_applied = 0;
        m_permanentFailure = 0;
        m_abandoned = false;
    }

    /**
     * Releasing with unresolved work is fail-stop for this owner epoch.  A
     * later acquireOwner() establishes a fresh epoch and clears that debt.
     */
    void releaseOwner() noexcept
    {
        if( !m_ownerActive )
            return;

        if( m_applied < m_accepted || m_permanentFailure != 0 )
            m_abandoned = true;

        m_ownerActive = false;
        ++m_epoch;
    }

    bool ownerActive() const noexcept { return m_ownerActive; }

    /**
     * Accept one current-owner latest-state projection.  A request received
     * while a save lease is active still receives a ticket, but mayEnter()
     * keeps it out of native until JS retries after the frozen save cut.
     */
    Ticket accept() noexcept
    {
        if( !m_ownerActive || m_abandoned || m_permanentFailure != 0 )
            return {};

        return { m_epoch, ++m_accepted };
    }

    bool mayEnter( Ticket aTicket ) const noexcept
    {
        if( !isCurrentOutstanding( aTicket ) || m_permanentFailure != 0 )
            return false;

        if( m_activeSaveLease == 0 )
            return true;

        return aTicket.epoch == m_activeSaveEpoch
               && aTicket.sequence <= m_activeSaveCut;
    }

    /**
     * A successful ticket represents the bridge's complete latest desired
     * state.  It may therefore cover earlier retryable/not-entered tickets.
     */
    bool appliedLatest( Ticket aTicket ) noexcept
    {
        if( !isCurrentOutstanding( aTicket ) || m_permanentFailure != 0 )
            return false;

        m_applied = aTicket.sequence;
        return true;
    }

    /** Retryable/not-entered leaves debt; only appliedLatest() can clear it. */
    bool retryableNotEntered( Ticket aTicket ) noexcept
    {
        return isCurrentOutstanding( aTicket ) && m_permanentFailure == 0;
    }

    /** A terminal result poisons the current epoch before its JS ACK fires. */
    bool failedPermanently( Ticket aTicket ) noexcept
    {
        if( !isCurrentOutstanding( aTicket ) || m_permanentFailure != 0 )
            return false;

        m_permanentFailure = aTicket.sequence;
        return true;
    }

    /**
     * Freeze both authority epoch and accepted ticket.  A concurrent/nested
     * save fails closed instead of sharing or replacing the existing lease.
     */
    SaveCut beginSave() noexcept
    {
        if( m_activeSaveLease != 0 )
            return {};

        ++m_nextSaveLease;

        if( m_nextSaveLease == 0 )
            ++m_nextSaveLease; // reserve zero as the invalid lease

        m_activeSaveLease = m_nextSaveLease;
        m_activeSaveEpoch = m_epoch;
        m_activeSaveCut = m_accepted;
        return { m_epoch, m_accepted, m_activeSaveLease };
    }

    void endSave( SaveCut aCut ) noexcept
    {
        if( aCut.lease == 0 || aCut.lease != m_activeSaveLease )
            return;

        m_activeSaveLease = 0;
        m_activeSaveEpoch = 0;
        m_activeSaveCut = 0;
    }

    SaveAction decideSave( SaveCut aCut, bool aTimedOut ) const noexcept
    {
        if( !aCut || aCut.lease != m_activeSaveLease )
            return SaveAction::FailClosed;

        const bool ownerChanged = aCut.epoch != m_epoch;
        const bool acknowledgedThroughCut = !ownerChanged && aCut.accepted <= m_applied;
        const bool failedThroughCut = ownerChanged || m_abandoned
                                      || ( m_permanentFailure != 0
                                           && m_permanentFailure <= aCut.accepted );

        return generated::decideSaveCut( acknowledgedThroughCut, aTimedOut,
                                         failedThroughCut );
    }

    std::uint64_t epoch() const noexcept { return m_epoch; }
    std::uint64_t accepted() const noexcept { return m_accepted; }
    std::uint64_t applied() const noexcept { return m_applied; }
    std::uint64_t permanentFailure() const noexcept { return m_permanentFailure; }
    bool abandoned() const noexcept { return m_abandoned; }

private:
    bool isCurrentOutstanding( Ticket aTicket ) const noexcept
    {
        return aTicket && m_ownerActive && aTicket.epoch == m_epoch
               && m_applied < aTicket.sequence && aTicket.sequence <= m_accepted;
    }

    std::uint64_t m_epoch = 0;
    std::uint64_t m_accepted = 0;
    std::uint64_t m_applied = 0;
    std::uint64_t m_permanentFailure = 0;
    bool          m_ownerActive = false;
    bool          m_abandoned = false;

    std::uint64_t m_nextSaveLease = 0;
    std::uint64_t m_activeSaveLease = 0;
    std::uint64_t m_activeSaveEpoch = 0;
    std::uint64_t m_activeSaveCut = 0;
};

/** Own one frozen save cut for the complete native writer lifetime. */
class ProjectionSaveLease
{
public:
    explicit ProjectionSaveLease( ProjectionFence& aFence ) noexcept :
            m_fence( &aFence ),
            m_cut( aFence.beginSave() )
    {}

    ~ProjectionSaveLease() { release(); }

    ProjectionSaveLease( const ProjectionSaveLease& ) = delete;
    ProjectionSaveLease& operator=( const ProjectionSaveLease& ) = delete;

    explicit operator bool() const noexcept { return static_cast<bool>( m_cut ); }

    ProjectionFence::SaveCut cut() const noexcept { return m_cut; }

    ProjectionFence::SaveAction decide( bool aTimedOut ) const noexcept
    {
        return m_fence->decideSave( m_cut, aTimedOut );
    }

    void release() noexcept
    {
        if( m_cut )
        {
            m_fence->endSave( m_cut );
            m_cut = {};
        }
    }

private:
    ProjectionFence*         m_fence;
    ProjectionFence::SaveCut m_cut;
};

} // namespace pcbjam_collab
