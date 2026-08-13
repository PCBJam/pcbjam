/*
 * Run a programmatic editor open as one execution-owner transaction.
 *
 * A direct Embind call cannot safely park while nested inside its JavaScript
 * wrapper. The JS scheduler therefore creates a wait token, calls a shallow
 * `...Start` export, and awaits the token. The real open starts later on a
 * fresh wx dispatch context and owns mutable editor state until its true tail.
 */

#pragma once

#include <exception>
#include <functional>
#include <memory>
#include <utility>

#include <wx/wasm/private/execution_owner.h>
#include <wx/wasm/private/yieldwait.h>

namespace pcbjam_open
{

struct OwnedOpenJob
{
    int token = 0;
    std::function<bool()> body;
};

inline void runOwnedOpen(void *arg)
{
    std::unique_ptr<OwnedOpenJob> job(static_cast<OwnedOpenJob *>(arg));
    bool result = false;

    try
    {
        result = job && job->body && job->body();
    }
    catch (...)
    {
        // The token is the public async boundary. A recoverable C++ failure
        // resolves it as false instead of escaping across the dispatch fiber.
        result = false;
    }

    if (job && !wxWasmResolveWait(job->token, result ? 1 : 0))
        wxWasmExecutionFailStop("owned open lost its exact wait token");
}

inline void discardOwnedOpen(void *arg)
{
    // Native fail-stop/shutdown rejects outstanding open waits in the JS
    // scheduler. This callback only releases the accepted native payload; it
    // must not try to resume the parked opener while ownership is terminal.
    delete static_cast<OwnedOpenJob *>(arg);
}

inline bool startOwnedOpen(int token, std::function<bool()> body)
{
    // A false return means that native code never accepted the job. The
    // JavaScript wrapper owns and rejects that token; do not resolve it here,
    // or the public submit error can race into a successful `false` result.
    if (token <= 0)
        return false;

    if (!body)
        return false;

    std::unique_ptr<OwnedOpenJob> job;

    try
    {
        job.reset(new OwnedOpenJob{token, std::move(body)});
    }
    catch (...)
    {
        return false;
    }

    if (!wxWasmExecutionQueueOrdinary(
            runOwnedOpen, job.get(), discardOwnedOpen))
        return false;

    // Ownership transfers only after the execution queue accepts the job.
    job.release();
    return true;
}

} // namespace pcbjam_open
