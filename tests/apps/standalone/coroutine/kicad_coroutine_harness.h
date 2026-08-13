#pragma once

#include <libcontext.h>

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <utility>

namespace coroutine_test
{

class TestCoroutine
{
public:
    enum class InvocationType
    {
        FromRoot,
        FromRoutine,
        ContinueAfterRoot
    };

    struct Invocation;

private:
    struct Context
    {
        libcontext::fcontext_t ctx = nullptr;
    };

    class CallContext
    {
    public:
        ~CallContext()
        {
#ifdef __EMSCRIPTEN__
            if( !m_mainStackContext || !m_mainStackContext->ctx )
                return;

            libcontext::fcontext_t owned = m_mainStackContext->ctx;
            m_mainStackContext->ctx = nullptr;
            libcontext::release_fcontext( owned );
#endif
        }

        void SetMainStack( Context* aStack )
        {
            m_mainStackContext = aStack;
        }

        Invocation* RunMainStack( TestCoroutine* aCoroutine, std::function<void()> aFunc,
                                  intptr_t aValue )
        {
            m_mainStackFunction = std::move( aFunc );
            Invocation args{ InvocationType::ContinueAfterRoot, aCoroutine, this, aValue };

            return reinterpret_cast<Invocation*>(
                    libcontext::jump_fcontext( &( aCoroutine->m_callee.ctx ), m_mainStackContext->ctx,
                                               reinterpret_cast<intptr_t>( &args ) ) );
        }

        Invocation* Continue( Invocation* aArgs )
        {
            while( aArgs && aArgs->type == InvocationType::ContinueAfterRoot )
            {
                m_mainStackFunction();
                aArgs->type = InvocationType::FromRoot;
                aArgs = aArgs->destination->doResume( aArgs );
            }

            return aArgs;
        }

    private:
        Context*               m_mainStackContext = nullptr;
        std::function<void()>  m_mainStackFunction;
    };

public:
    struct Invocation
    {
        InvocationType  type;
        TestCoroutine*  destination;
        CallContext*    context;
        intptr_t        value;
    };

    using EntryFn = std::function<void( TestCoroutine& )>;

    explicit TestCoroutine( EntryFn aEntry, std::size_t aStackSize = 256 * 1024,
                            std::size_t aStackSkew = 0 ) :
            m_stackSize( aStackSize ),
            m_stackSkew( aStackSkew ),
            m_entry( std::move( aEntry ) )
    {
    }

    ~TestCoroutine()
    {
        if( m_caller.ctx )
            libcontext::release_fcontext( m_caller.ctx );

        if( m_callee.ctx )
            libcontext::release_fcontext( m_callee.ctx );
    }

    bool Call( intptr_t aValue = 0 )
    {
        if( m_callee.ctx || !m_entry )
            return false;

        CallContext ctx;
        Invocation args{ InvocationType::FromRoot, this, &ctx, aValue };
        Invocation* ret = ctx.Continue( doCall( &args ) );
        m_lastReturnValue = ret ? ret->value : 0;
        return Running();
    }

    bool Call( const TestCoroutine& aCoroutine, intptr_t aValue )
    {
        if( m_callee.ctx || !m_entry )
            return false;

        Invocation args{ InvocationType::FromRoutine, this, aCoroutine.m_callContext, aValue };
        Invocation* ret = doCall( &args );
        m_lastReturnValue = ret ? ret->value : 0;
        return Running();
    }

    bool Resume( intptr_t aValue = 0 )
    {
        if( !m_running )
            return false;

        CallContext ctx;
        Invocation args{ InvocationType::FromRoot, this, &ctx, aValue };
        Invocation* ret = ctx.Continue( doResume( &args ) );
        m_lastReturnValue = ret ? ret->value : 0;
        return Running();
    }

    bool Resume( const TestCoroutine& aCoroutine, intptr_t aValue )
    {
        if( !m_running )
            return false;

        Invocation args{ InvocationType::FromRoutine, this, aCoroutine.m_callContext, aValue };
        Invocation* ret = doResume( &args );
        m_lastReturnValue = ret ? ret->value : 0;
        return Running();
    }

    void Yield( intptr_t aValue = 0 )
    {
        jumpOut( InvocationType::FromRoutine, aValue );
    }

    void RunMainStack( std::function<void()> aFunc, intptr_t aValue = 0 )
    {
        if( !m_callContext )
            return;

        Invocation* ret = m_callContext->RunMainStack( this, std::move( aFunc ), aValue );
        updateIncomingInvocation( ret );
    }

    bool Running() const
    {
        return m_running;
    }

    intptr_t CurrentValue() const
    {
        return m_currentInvocation ? m_currentInvocation->value : 0;
    }

    intptr_t LastReturnValue() const
    {
        return m_lastReturnValue;
    }

    std::size_t EntryCount() const
    {
        return m_entryCount;
    }

    // Exposes the opaque token only to the standalone lifetime reducers. They
    // keep a stale copy across destruction and prove that it cannot alias or
    // enter a later context.
    libcontext::fcontext_t ContextHandleForTest() const
    {
        return m_callee.ctx;
    }

private:
    static void callerStub( intptr_t aData )
    {
        Invocation& args = *reinterpret_cast<Invocation*>( aData );

        TestCoroutine* coroutine = args.destination;
        coroutine->m_callContext = args.context;
        coroutine->m_currentInvocation = &args;
        coroutine->m_entryCount += 1;

        if( args.type == InvocationType::FromRoot )
            coroutine->m_callContext->SetMainStack( &coroutine->m_caller );

        coroutine->m_entry( *coroutine );
        coroutine->m_running = false;
        coroutine->jumpOut( InvocationType::FromRoutine, 0 );
    }

    Invocation* doCall( Invocation* aInvocation )
    {
        m_stack = std::make_unique<char[]>( m_stackSize + m_stackSkew );
        char* stackBottom = m_stack.get() + m_stackSkew;
        void* stackTop = stackBottom + m_stackSize;

        m_callee.ctx = libcontext::make_fcontext( stackTop, m_stackSize, callerStub );
        m_running = true;

        return jumpIn( aInvocation );
    }

    Invocation* doResume( Invocation* aInvocation )
    {
        return jumpIn( aInvocation );
    }

    Invocation* jumpIn( Invocation* aInvocation )
    {
        m_currentInvocation = aInvocation;

        return reinterpret_cast<Invocation*>(
                libcontext::jump_fcontext( &( m_caller.ctx ), m_callee.ctx,
                                           reinterpret_cast<intptr_t>( aInvocation ) ) );
    }

    void jumpOut( InvocationType aType, intptr_t aValue )
    {
        Invocation args{ aType, nullptr, nullptr, aValue };

#ifdef __EMSCRIPTEN__
        // Completion is not an ordinary suspension. Finish the physical fiber
        // before the TestCoroutine destructor can release its C stack.
        if( !m_running )
        {
            libcontext::finish_fcontext( &( m_callee.ctx ), m_caller.ctx,
                                         reinterpret_cast<intptr_t>( &args ) );
        }
#endif

        Invocation* ret = reinterpret_cast<Invocation*>(
                libcontext::jump_fcontext( &( m_callee.ctx ), m_caller.ctx,
                                           reinterpret_cast<intptr_t>( &args ) ) );
        updateIncomingInvocation( ret );
    }

    void updateIncomingInvocation( Invocation* aInvocation )
    {
        m_currentInvocation = aInvocation;

        if( !aInvocation )
            return;

        m_callContext = aInvocation->context;

        if( aInvocation->type == InvocationType::FromRoot && m_callContext )
            m_callContext->SetMainStack( &m_caller );
    }

private:
    std::size_t                 m_stackSize;
    std::size_t                 m_stackSkew;
    EntryFn                     m_entry;
    bool                        m_running = false;
    std::unique_ptr<char[]>     m_stack;
    Context                     m_caller;
    Context                     m_callee;
    CallContext*                m_callContext = nullptr;
    Invocation*                 m_currentInvocation = nullptr;
    intptr_t                    m_lastReturnValue = 0;
    std::size_t                 m_entryCount = 0;
};

} // namespace coroutine_test
