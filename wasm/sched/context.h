/*
 * Scheduler contexts — Design B core, phase D1
 * (pcbjam docs/features/async/20-design-b-core-plan.md §5, §6 D1).
 *
 * THE RULE THIS EXISTS TO ENFORCE: no activity may park "in place". A
 * suspendable activity runs on a scheduler-owned context (its own stack + its
 * own asyncify buffer) and suspends by YIELDING THAT CONTEXT back to the
 * scheduler. The registry below is then authoritative about what is parked and
 * why — never a fiber struct saying one thing while its body sits in a
 * handleSleep the fiber layer cannot see (docs/features/async/19).
 *
 * HOW THIS DIFFERS FROM libcontext (kicad/thirdparty/libcontext), which stays
 * exactly as it is:
 *
 *   - libcontext is SYMMETRIC: any stack may jump_fcontext to any other, so
 *     "is the target safe to enter?" has no recorded answer and is guessed
 *     (swap_suspended, the parked/hot-main refusals). This layer is a STAR:
 *     contexts only ever swap OUT to the scheduler, and only the scheduler
 *     swaps IN. A resume is therefore never a guess — the registry says the
 *     context is Parked/Ready and holds its buffer.
 *   - At most ONE transition is in flight, enforced here rather than hoped for.
 *
 * SCOPE (D1): primitives + registry + memory accounting, exercised only by
 * tests/apps/standalone/sched-context. NO production path is switched to this
 * yet — dispatch moves at D2, waits at D3, bridges at D4.
 *
 * THREADING: main thread only, by construction (doc 21 §2 — every Asyncify
 * park in the tree is main-thread; the lib bridge's worker path is a blocking
 * proxy, not a park). Calling any of this from a pthread is a programming
 * error and is refused loudly.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace pcbjam_sched
{

using ContextId = uint32_t;

/** Registry truth for one context. Only the scheduler mutates it. */
enum class Status
{
    Fresh,      ///< created, never entered
    Running,    ///< currently executing (at most one, plus the scheduler)
    Parked,     ///< yielded, waiting for mark_ready()
    Ready,      ///< mark_ready() called, waiting for drain() to swap it in
    Finished    ///< entry returned; stack/buffer reclaimable
};

const char* status_name( Status aStatus );

/** Per-context sizes. Both are charged to the memory budget (doc 20 risk 1). */
struct Sizes
{
    size_t stack_bytes = 0;
    size_t asyncify_bytes = 0;
};

/**
 * Create a context. It does NOT run until drain() picks it up: creation
 * marks it Ready so the first drain() enters it at aEntry.
 *
 * aLabel is borrowed for the context's lifetime (use a literal); it exists so
 * a stuck context can be named in a beacon instead of only numbered.
 * Returns 0 if the limit is hit or allocation fails.
 */
ContextId create( void ( *aEntry )( void* ), void* aArg, const char* aLabel );

/**
 * Park the CURRENTLY RUNNING context and yield to the scheduler. Returns the
 * result passed to mark_ready(). Must be called on a context (never on the
 * scheduler stack) — returns -1 immediately otherwise.
 *
 * aReason is recorded in the registry: "why is this parked" is exactly the
 * question the doc-19 guessing layer could not answer.
 */
int yield_park( const char* aReason );

/**
 * Mark a Parked context Ready with aResult. Callable from any stack (a JS
 * promise settling, a timer, another context). Does NOT resume it — resuming
 * is drain()'s job, so a wake can never rewind inside another transition
 * (doc 13 §1.4's deferred-wake law, applied to contexts).
 *
 * Returns false if the id is unknown or the context is not Parked.
 */
bool mark_ready( ContextId aId, int aResult );

/**
 * Scheduler entry: resume at most ONE Ready context, running it until it
 * parks or finishes. Returns the id it ran, or 0 if there was nothing to run
 * (or a transition was already in flight). Call from a clean stack — a fresh
 * JS task, never from inside an awaited export (#13302, doc 17 S3).
 */
ContextId drain();

/** True while a swap is in flight; drain() refuses to start another. */
bool transition_in_flight();

/** The running context's id, or 0 when the scheduler stack is running. */
ContextId current();

Status status_of( ContextId aId );

/** Destroy a Finished context and release its stack + buffer. */
bool destroy( ContextId aId );

/**
 * Registry + memory snapshot as JSON, for tests and the D1 memory gate:
 *   live/peakLive/created/finished, transitions, bytes/peakBytes,
 *   perContextBytes, and asyncify high-water usage (asyncifyHighWater) —
 *   the measurement doc 20 risk 1 asks for so buffer sizes get re-derived
 *   from evidence instead of inherited from libcontext's 512K.
 */
std::string stats_json();

/** One line per live context: id, label, status, reason, asyncify usage. */
std::string registry_json();

/** Test hook: reset all counters (does not touch live contexts). */
void reset_stats();

} // namespace pcbjam_sched
