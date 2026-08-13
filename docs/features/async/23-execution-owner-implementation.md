# 23 — Execution-owner implementation record

> **Status (2026-08-13): IMPLEMENTED IN SOURCE; FINAL VALIDATION IS ACTIVE.**
> This record matches the current worktree source. The last all-target Docker
> build passed, but source changed after that build. Therefore, that build is
> historical evidence. Focused rebuilds and focused tests cover the later
> changes. The final source-freeze build, the broad non-browser rerun, the full
> browser matrix, and real-application exploration are not complete. Section
> 12 lists each completed and pending result. A focused reducer proves only its
> stated rule. It is not evidence for the complete application matrix.
>
> This document records the code that exists now. It is not a new plan.
> Documents 17, 20, 21, and 22 contain the history and the earlier plans.

## 1. Purpose

The implementation has three separate control layers:

1. The **physical native-entry arbiter** controls scheduled calls from fresh
   browser tasks into exports that can change scheduler state or suspend. Each
   audited browser input gets a monotonic receipt sequence and an immutable
   modal-lease snapshot before the adapter makes a delay decision. A safe
   synchronous adapter can enter inline only when no earlier receipt is still
   pending. Section 4.2.7 explains this ingress FIFO and its native frontier.
2. The **physical context scheduler** controls stacks, Asyncify buffers, parks,
   wakes, and context switches.
3. The **semantic execution owner** controls permission to read or change the
   shared wxWidgets and KiCad state.

These layers solve different problems. The native-entry arbiter answers,
“Can this browser task enter the native scheduler now?” A physical context
answers, “Which stack can run?” An execution owner answers, “Which stateful
transaction can run?”

The implementation does not put all asynchronous work in one queue. Network
requests, WebSocket traffic, and other JavaScript work can stay in flight at
the same time. Only a native operation that reads or changes shared wx/KiCad
state must enter the execution-owner boundary.

## 2. Terms

| Term | Controlled definition |
|---|---|
| **Asyncify** | The Emscripten mechanism that saves and restores a WebAssembly call stack. |
| **MEMFS** | The Emscripten in-memory file system in one WebAssembly module. |
| **IndexedDB** | The browser database used for persistent client cache data. Some source comments use the abbreviation IDB. |
| **R2** | Cloudflare R2 object storage. Library and project body records can use it outside the WebAssembly module. |
| **Durable Object** | A Cloudflare single-instance coordination object used here for a library namespace room and its manifest authority. |
| **Y.Doc** | One Yjs collaborative document. JavaScript can update it without entering native code. |
| **OCC** | Open CASCADE Technology, used by the auxiliary STEP export service. |
| **Physical context** | One scheduler record with one native stack, one Asyncify buffer, one context ID, and one state. Typical states are Fresh, Running, Parked, Ready, and Finished. |
| **Context ID** | The non-zero, process-lifetime identity of a physical context. The scheduler allocates IDs monotonically and never reuses them. It refuses creation when the 32-bit sequence is exhausted. A context ID is not permission to change application state. |
| **Wake token** | A non-zero, process-lifetime identity for one exact scheduler wake. Wake tokens increase monotonically, do not wrap, and are not reused. A matching context ID without the matching wake token is not sufficient. |
| **Park wake** | The explicit record of who can wake a Parked context. Its kind is None, External, RetainedExact, or Cancellable. |
| **Park result** | The `{ accepted, value }` result from `yield_park()`. `accepted` reports whether the park occurred. `value` contains all 32 result bits from the matching wake. |
| **Ready claim** | The scheduler FIFO position and transfer value which already belong to a Ready fiber. A direct transfer cannot replace or merge this claim. |
| **Physical native-entry arbiter** | The bounded JavaScript FIFO that admits calls from fresh browser tasks to native exports that can start, wake, or resume physical contexts. It does not grant semantic owner permission. |
| **Full Asyncify arbiter** | The physical native-entry FIFO, deferred in-place wake FIFO, transition-completion signal, leaf readiness probe, consume-once rewind guard, and terminal trap boundary as one control plane. It controls Asyncify transition safety. It does not order wx or KiCad transactions. |
| **Native-entry job** | One JavaScript arbiter record. It contains a diagnostic site, a callback, an optional coalescing key, and an optional completion-byte reservation. A job without a key is exact. It is not a native execution envelope. |
| **Mailbox reservation** | One JavaScript mailbox capacity unit. A scheduled timer owns it from timer creation until native transport removes the due record. Thus, the bound includes delayed and due records. |
| **Scheduler pump** | One native entry which lets the physical registry run a Ready context. A wake normally marks one context Ready and schedules a separate pump task. |
| **Event pump** | The wx loop work which selects and dispatches eligible execution envelopes and pending wx events. It runs on a dispatch context. |
| **Leaf readiness probe** | `_wxWasmNativeEntryReady()`. This native export reads fail-stop state, the current-context value, transition state, and whether any physical context has a live in-place park. It does not suspend, allocate, drain, start, wake, or resume a context. |
| **Accepted native entry** | A native-entry job for which the leaf probe returned 1. The arbiter removes the job before it calls the job callback. |
| **Immutable browser receipt** | The JavaScript-owned control record for one audited external event. It is made before any delay decision. It contains a monotonic receipt sequence and a frozen modal-lease snapshot. The event payload also contains no borrowed mutable browser event object. |
| **Ingress receipt sequence** | A positive, non-reused JavaScript token that records receipt order across custom DOM adapters and Emscripten-generated canvas callbacks. It is separate from the native execution-envelope sequence. |
| **Ingress lease snapshot** | The immutable `{available, hasLease, targetScope, leaseToken}` value published by native code and copied into a browser receipt. It records modal capability at receipt time. An unavailable snapshot gives no lease capability. |
| **Ingress receipt lease** | The deepest accepting lease in the current lease stack. It is the capability published for new browser receipts. It is normally the active top lease. While a nested top lease is closing, it can be the accepting parent below that top lease. It does not change the active lease or grant admission. |
| **Ingress frontier** | The earliest external receipt which is still pending in JavaScript. A native envelope with the same or a later receipt sequence cannot run across this gap. Earlier ingress and non-ingress work stay eligible. |
| **Level signal** | A signal that says a class of work exists. A second signal with the same key does not add a new payload, so the arbiter can coalesce it. |
| **Exact native entry** | A native-entry job with a distinct payload or target. The arbiter does not coalesce it. Context-wait results and context-sleep wakes are exact entries. |
| **Context-sleep timer lease** | The JavaScript record that owns one positive timed wake for one exact context ID and wake token. The record owns either the pending timer or the exact queued native-entry callback. Context retirement must cancel this lease before it frees the context. |
| **Transition-completion edge** | The point after `Asyncify.maybeStopUnwind()` has completed and the Asyncify and fiber transition state is free. This edge can arm one retained native-entry head. |
| **Fresh browser task** | A new JavaScript macrotask with no active suspending WebAssembly export below it. The arbiter uses a zero-delay task for each accepted entry. |
| **Scheduler drain batch** | One call to `drain_all()` from a fresh scheduler task. It runs no more than 4,096 physical context transitions. |
| **Drain continuation** | One coalesced `sched-pump` job which continues a non-quiescent drain batch in a fresh browser task. It is control-plane work, not a new application event. |
| **Transfer livelock** | Ready work which survives 64 consecutive full scheduler drain batches without one quiescent boundary. The condition is terminal for the Wasm instance. |
| **In-place Asyncify park** | A `handleSleep` suspension which saves the stack that called it and returns to JavaScript. It is not a scheduler-context park and not a symmetric fiber yield. |
| **Fiber suspension** | The saved Emscripten fiber state made by a real fiber context switch. One later fiber resume can consume it. |
| **Consume-once rewind guard** | The JavaScript check that permits a fiber resume only when that fiber has one live, unconsumed fiber suspension and is not in an in-place park. |
| **Semantic execution owner** | A token for one logical stateful transaction. The token can continue across callbacks, physical contexts, and `runOnFiber` parks. |
| **Root owner** | The owner for a new top-level transaction when no other root transaction is active. |
| **Lease** | A narrow permission from one parent owner to one modal or nested target family. |
| **Lease provenance** | The exact lease token that existed when scoped delayed work entered the system. It contains the lease identity, generation, parent, and target scope. A later lease for the same window cannot use it. |
| **Child owner** | The owner for one admitted unit of work under the active lease. A lease has no more than one live child owner at a time. |
| **Scope token** | An opaque top-level-window identity. It contains a pointer value and a generation. Code compares the token but does not dereference it. |
| **Execution-scoped paint sweep** | A synchronous wx paint tail which paints all top-level windows when no modal lease is active, but paints only the top-level window with the exact active lease scope while a modal child is active. |
| **Work class** | The declared type of queued work. The current classes are Ordinary, UserInput, PendingEvents, and ModalLifecycle. |
| **Ordinary work** | A new external transaction. It cannot use a modal lease. |
| **Affiliated continuation** | Work that continues an owner which the producer already retained. It does not create a new owner. |
| **Completion tail** | The final part of a logical operation. It includes all delayed native work which must finish before the operation can release its semantic owner. |
| **Wait token** | The exact positive signed identity of one generic suspension result. JavaScript allocates wait tokens monotonically, stops at `0x7fffffff`, and never reuses them. A wait token is not a context ID, owner ID, or modal scope. |
| **Execution envelope** | A copied native queue record. It contains a callback, payload, work class, scope, optional lease provenance, ordering data, and an optional discard function. |
| **Owner-aware yield** | A `wxYield()` pass that processes only pending events which the current semantic owner can run. It stops when only another owner's events remain. |
| **Same-owner nested ingress** | A bounded `wxYield()` or `Dispatch()` continuation which runs staged UserInput or PendingEvents under the owner already mapped to the current stack. It does not admit a new owner. |
| **Pending-event handler association** | A lifetime-bound link between one non-window `wxEvtHandler` and one exact top-level window family. It lets that handler's queued events carry the same narrow scope as the window. It does not grant the handler access to another modal family. |
| **Pending-event delegate** | A one-event capability that copies the exact active child lease for one initiating window family. The capability applies only to the handler and event supplied to the delegated queue call. It is not stored on a process-wide handler. |
| **Next-modal pending-event capability** | A consume-once marker on one exact `wxEVT_ASYNC_METHOD_CALL` posted by `CallAfter()` to a real `wxWindow` in a dialog family before that dialog becomes modal. The posting owner, real target family, and absence of an older lease are known at queue time. A non-window handler association, scope equality, or another event type cannot create this capability. |
| **Pre-modal pending-event handoff** | The fail-atomic operation which binds only marked next-modal events to the exact lease that their parent owner opens for the same dialog scope. It adds lease provenance without moving the event in the physical wx list. It does not make the parent eligible to run the event. |
| **Owner gateway** | The JavaScript-to-native boundary for audited stateful Emscripten module exports. It returns a Promise. |
| **Gateway ticket** | One owner-gateway job and its Promise. The ticket settles only after JavaScript has a result and native code reports that the exact semantic owner has retired. |
| **Embind submission transport** | The shallow path that carries one numeric gateway job ID through `_wxWasmEmbindSubmit` into the native owner queue. It does not run the stateful body and it does not wait for that body. |
| **Nested Wasm-to-JavaScript-to-Wasm chain** | The delivery stack in which an owned native callback calls JavaScript `deliverMutator()`, which calls the raw Embind WebAssembly wrapper. A suspendable body must not start inside this still-live chain. |
| **Raw Embind thenable** | A Promise-like value returned by the raw Embind wrapper during owner delivery. This value proves that suspension escaped the required transport-only boundary. It is a terminal physical-integrity failure, not an application result. |
| **Transport-only `runOnFiber` entry** | A `runOnFiber` call that retains the current owner when one exists, copies the body into the owner-keyed fiber lane, requests a later owner callback, and returns without starting the coroutine. |
| **Owner-keyed fiber lane** | One FIFO and one active `FiberSlot` for one exact semantic owner. A parked ancestor owner and its active modal child can have separate lanes. Unrelated root owners cannot overlap. All lanes use one aggregate job limit. |
| **Stateful test export** | A browser-test export that reads or changes the same wxWidgets or KiCad model state as production code. A `Test` name does not exempt the export from owner admission. |
| **Native completion gate** | `enqueueNativeCompletion(site, estimatedBytes, fn, onAbandon?)`. It reserves a completed payload, admits one exact physical native entry, and uses `runNativeCompletion` as the terminal trap boundary. It does not start or order the fetch which produced the payload. |
| **Native completion reservation** | The conservative byte estimate for data retained by one queued completion closure. A `Uint8Array` reserves its complete backing buffer. A string reserves two bytes per code unit. The count bound covers closure and path overhead. |
| **Native execution retained-byte lease** | The byte charge for copied data in one native execution envelope. The lease starts before queue publication. It ends after the callback returns or after the discard operation completes. It is separate from a JavaScript native-completion reservation. |
| **Native-entry abandonment callback** | An optional pure-JavaScript function for an exact physical-entry job. Terminal shutdown calls it with `WX_NATIVE_ENTRY_ABANDONED` after the queue and byte reservation are clear. It can reject a JavaScript Promise. It must not call WebAssembly, touch MEMFS or HEAP, or finish a native proxy context. |
| **Native context abandonment** | The terminal rule for a parked or blocked native frame when native integrity is unknown. JavaScript releases its queue and registry references, but it does not wake, reject, unwind, or run cleanup on that frame. Module and worker replacement reclaim it. |
| **Physical terminal handoff** | A no-return coroutine transfer that marks the completed source context Finished before control returns to its caller. The caller can then release the source stack. |
| **Star transfer lane** | A fiber transfer in which the scheduler parks the source, makes the target ready, and selects the next context. |
| **Opaque fcontext handle** | A non-zero numeric token for one live Wasm libcontext record. The token is resolved through a registry. It is not a C++ pointer, and a retired token is never reused. |
| **Physical-root proxy** | A non-owning libcontext protocol record for one exact scheduler-owned dispatch root. It supplies transfer identity for that physical stack. It does not own or release the scheduler stack. |
| **Direct transfer lane** | A transfer in which libcontext selects the validated target directly because no scheduler-owned source context can perform a star transfer. Standalone coroutine harnesses use this lane. The scheduler still records the physical state. |
| **Ready publication transaction** | The operation that publishes a Ready FIFO claim before it changes a context state, consumes a park wake, changes a transfer value, or changes a transfer endpoint. Publication failure leaves the previous state unchanged and retryable. |
| **Initial main-loop progress edge** | The first JavaScript scheduler job for the new wx main-loop context. Main-loop detach is complete only after JavaScript accepts this exact job. |
| **Adopted browser-stack root** | The libcontext protocol record for the original browser main stack. Adoption requires the exact stack bounds captured before the first switch and a local address in the half-open range. A lower stack address of zero is valid. |
| **Source sequence** | A client-side order token for one cache path. Only the current token can publish a late result for that path. |
| **Mutation ID** | An opaque client token that correlates one HTTP library mutation with its WebSocket echo. It is not authorization, identity, or a version. |
| **Receipt identity** | The fields that prove that two mutation receipts describe the same commit: operation, version, and, for a put, hash and size. A matching mutation ID alone is not sufficient. |
| **Projection level signal** | A bounded notice that the native editor does not match the current Y.Doc. It has no transaction payload. One authoritative reconciliation consumes all remote transactions represented by the current Y.Doc version. |
| **Latest-owner projection** | A JavaScript lane with one submitted owner ticket, one pending level, a value captured at submission, and a stop generation. A superseded admitted ticket can finish, but it cannot publish over the latest value. Chrome visibility is one consumer. |
| **Save persistence lane** | One project-relative path with one immutable active byte snapshot and one replaceable latest byte snapshot. Saves for that path keep order. Saves for different paths can run at the same time. |
| **Save outcome** | The result of one host persistence attempt. `committed` confirms publication. `not-committed` confirms no publication. `conflict` confirms that another revision is current. `unknown` means that publication cannot be determined. |
| **Loaded-body base revision** | The server revision of the file body from which the editor model was made. This revision is the compare-and-swap precondition for the next save. A list or metadata response can update an observed revision, but it cannot update this base. |
| **Absorbing save block** | A per-path state after a conflict or unknown save outcome. The current save-hook lifetime continues collaboration callbacks, but it does not submit more persistence writes for that path. Hook replacement clears the state. |
| **Project-file compare-and-swap** | A conditional server publication that succeeds only when the expected revision and, for equivalent normalization, the source storage key still identify the current row. |
| **Projection failure class** | The action selected from an owner-gateway rejection. Valid queue backpressure can retry. A stale resource or terminal Module failure stops the binding projection. An unknown error uses a finite retry circuit. |
| **Projection retry circuit** | The finite sequence of authoritative reconciliation attempts after unknown projection errors. It opens after eight consecutive failures. A later Yjs transaction closes it and requests one full projection from current Y.Doc authority. |
| **Terminal native projection retirement** | The permanent stop state for native projection work in one exact Wasm `Module` or binding lifetime after a terminal owner failure. JavaScript data receipt can continue. A replacement module or binding owns a new stop state. |
| **Retry storm** | An unbounded sequence of native tickets, Promise reactions, logs, or timers which occurs when each later external event re-arms one terminal or permanently failing native lane. One bounded capacity-retry timer is not a retry storm. |
| **Exact-open consumer** | Code which calls `kicadOpenFile()` or `kicadOpenFiles()`. It must await the returned Promise, or retain it, attach a rejection handler immediately, and join it at the intended later barrier. |
| **Sibling restage lane** | The per-path lane that transfers a sibling schematic from a Y.Doc to MEMFS. It retains no more than one submitted owner ticket and one replaceable latest text value. |
| **Sibling reconnect slot** | The one delayed connection attempt allowed for one sibling path. It uses a path-local generation, abort controller, and bounded backoff. Roster changes, teardown, and a successful connection cancel or reset this slot. |
| **Local mutation lane** | The bounded per-path sync-client FIFO for local PUT and DELETE operations. One path runs one operation at a time. Different paths have independent lanes. |
| **Library reload lane** | A bounded level signal for one library item kind. It has no more than one active owner ticket and one pending level. It does not make one native reload job for each WebSocket message. |
| **Multiplexed realtime channel** | One refcounted raw WebSocket for one `(URL, token)` pair. Per-library facades add and remove the library tag. The raw socket closes when its last facade closes. |
| **Namespace operation lane** | The bounded server FIFO that orders manifest and mutation publication for one library namespace across storage `await` points. GET and bundle body reads stay outside it. A mutation stays in the lane while the server reads its request body and changes R2. |
| **Single writer** | The rule that only one Durable Object room shape can mutate one R2 body prefix during a rollout. The current writer is the historical per-library room. |
| **Dirty manifest marker** | A value at the separate versioned state key. It says that the plain legacy manifest can disagree with R2 and must be repaired before use. It includes the last clean baseline. |
| **Source lifecycle generation** | A number that changes when a source or layer closes. Delayed HTTP, WebSocket, repair, open, and projection work must match the current generation before it can publish. |
| **Provider synchronization wait** | The finite wait for a new Y.Doc provider to receive its authoritative initial state. It belongs to one caller lifetime. Abort, timeout, or provider destruction must settle it and remove its exact listener or timer. |
| **Raw session owner** | The exclusive owner of a provider and Y.Doc after initial synchronization but before an editor binding or sheet manager accepts them. It has one release edge and destroys late or abandoned sessions. |
| **Active-sheet generation** | The lifetime of one sheet's item binding, presence bridge, comment controller, follow controller, drift detector, and project-presence document path. It ends synchronously when navigation retires that sheet, before the next room can wait. |
| **Canvas overlay projection** | The host-owned latest-value lane for remote presence or comment pins. All sheet controllers publish through it. A later sheet value or clear invalidates an older queued native ticket, so an old controller cannot clear a new sheet's overlay. |
| **Worker-service generation** | One OCC or ngspice worker lifetime and the exact requests posted to it. A worker fault retires that generation and completes all of its requests with failure. Messages and events from a retired worker cannot affect a replacement worker. This term does not mean a browser Service Worker. |
| **Worker watchdog deadline** | A last-resort limit for one worker boot or one request response. Expiry retires the complete worker generation and settles every exact request in that generation. It is not a scheduler time slice and it does not serialize worker requests. |
| **ngspice event-frame credit** | One exact worker-to-main event frame identified by a monotonic sequence and its UTF-8 byte count. The worker keeps the charge until the main thread returns an acknowledgment with both exact values. |
| **Prepared model body** | Fetched 3D-model bytes plus a synchronous, generation-checked `apply()` operation. Source, IndexedDB, and network work is complete. Native MEMFS publication has not started. |
| **Exact wait completion edge** | `runWaitCompletion(site, token, fn)`. It performs a prepared native operation and resolves the exact wait token in one immediate edge. The operation cannot wait in a general queue behind the waiter which needs it. |
| **Optional model-prefetch lifetime** | The 30-second, abortable Open CASCADE export prefetch. It uses source, IndexedDB, and network work only. Timeout stops selection and makes results from already-started requests inert. |
| **Ancestor close request** | An idempotent `BeginClose()` request for one exact lease below the active top lease. It revokes new admission immediately. Completion and removal remain last-in-first-out. |
| **Modal completion callback** | The public `ShowModal(callback)` completion API. It runs only after the wait resolves, the lease closes, focus is restored, and the same dialog can be opened again. |
| **DOM browser lifetime** | One evaluation of the wx browser adapter with its exact `Module`, listeners, controls, popups, animation callbacks, and monotonic realm IDs. Old lifetime work cannot enter a replacement module. |
| **DOM event-snapshot lease** | The bounded record for copied browser event data. Its count and byte charges start before publication and end on exact pop, discard, or shutdown. |
| **Context-menu lease resolver** | The realm-owned completion function for one native context-menu lease. It stays reachable until the old native lease completes, even when a new adapter lifetime replaces the public adapter object. |
| **KiCad configuration seed** | The minimal KiCad 10.0 settings and library-table files written to MEMFS before `main()`. The seed suppresses unavailable browser features and first-run setup. It never overwrites an existing same-session setting. |
| **GAL recovery boundary** | The existing KiCad repaint catch point that replaces a failed graphics backend or falls back after a GAL update throws. `GAL_UPDATE_CONTEXT` must let an `endUpdate()` exception reach this boundary. |
| **Reducer** | A small deterministic program or test that reproduces one concurrency rule without the full application. |

### 2.1 Independent limits

Equal numeric values in this table do not identify one shared limit. Each row
has a separate owner and a separate release operation.

| Resource | Limit | Scope and ownership |
|---|---:|---|
| Physical native-entry jobs | 4,096 jobs | One JavaScript scheduler FIFO. |
| Native execution envelopes | 4,096 records | One wx execution-owner queue. |
| Native execution retained payload | 64 MiB | One wx execution-owner byte budget. |
| JavaScript native-completion payload | 64 MiB | One physical-entry completion budget. |
| JavaScript mailbox reservations | 4,096 records | Delayed and due records in one scheduler mailbox. |
| Ingress receipt records | 4,096 records | External receipt order in one scheduler. |
| DOM event snapshots | 4,096 records | One DOM adapter lifetime. |
| DOM event-snapshot payload | 16 MiB | Copied strings and values in one DOM adapter lifetime. |
| File-drop batches | 64 batches | One `wx.js` module lifetime. |
| Files in one drop | 4,096 files | One browser drop transaction. |
| Pending file-drop payload | 256 MiB | All live batch reads in one `wx.js` module lifetime. |
| `runOnFiber` jobs | 4,096 jobs | Queued plus active jobs across all owner-keyed lanes. |
| Owner-gateway jobs | 10,000 jobs | One JavaScript mutator registry. |
| Owner-gateway argument payload | 16 MiB | All retained serialized arguments in that registry. |
| Context-sleep leases | 4,096 leases | One JavaScript scheduler. |
| Generic wait records | 4,096 records | One JavaScript scheduler. |
| Save snapshots | 64 MiB | One save-hook lifetime. |
| Save path lanes | 256 paths | One save-hook lifetime. |
| ngspice worker batch | 512 lines or 1 MiB | One UTF-8 JSON event frame. |
| ngspice unacknowledged transport | 64 frames or 8 MiB | One worker generation. |
| ngspice main-thread event queue | 64 frames or 8 MiB | One service generation before handler delivery. |

## 3. Required invariants

The implementation enforces these rules:

1. A physical context owns its stack and its Asyncify buffer.
2. The context registry is the authority for a physical wake.
3. A semantic owner is separate from a physical context.
4. The shared browser main stack, context ID 0, does not give public owner
   permission.
5. Only one root owner exists at a time.
6. An active lease can admit only its declared work classes for its exact
   scope.
7. Only the exact active owner branch can run an affiliated continuation.
8. A wait result resolves by exact token. It does not resolve by stack order.
9. A native trap makes the module terminal before the trap leaves the
   completion boundary.
10. A delayed callback does not touch native state after terminal shutdown.
11. Network transfer is not execution-owner work.
12. A completed native apply is execution-owner work.
13. A completed coroutine becomes physically Finished before its caller can
    release the coroutine stack.
14. A Finished coroutine cannot become ready or run again.
15. A scheduled JavaScript-to-native entry does not start or wake a physical
    context while another physical context is current or a scheduler
    transition is in flight.
16. The readiness probe is a leaf operation. It cannot suspend or change
    scheduler state.
17. The arbiter removes an accepted job before it calls a possibly suspending
    export. It never replays that job because of a shallow Asyncify return.
18. A refused readiness probe retains the FIFO head. It does not start a retry
    timer.
19. A transition-completion edge arms the retained head one time.
20. Level signals can coalesce by key. Live exact context waits and context
    sleeps preserve every payload and FIFO position. Retirement can revoke the
    one exact sleep wake which belongs to the retired context.
21. A stateful browser-test export follows the same owner rule as a production
    export.
22. An owner-backed export does not put a model-mutation tail that determines
    gateway completion in a bare `CallAfter`. It retains the owner through
    `runOnFiber` or another explicit affiliated continuation.
23. Scoped delayed work keeps the exact lease generation that existed when it
    entered. If that lease closes, the work is stale and must be discarded. It
    cannot use capability from a later lease for the same target scope.
24. A modal child processes only pending wx events that have valid owner and
    lease provenance for that child. `wxYield()` returns when only ineligible
    events remain; it does not spin on the physical pending-event count.
25. A public Wasm `fcontext_t` token never aliases a later coroutine. A retired
    token cannot become live again because an allocator reused an address.
26. A saved fcontext slot and an internal `return_to` edge own references. A
    physically releasable, non-current zero-reference context retires
    immediately. A current, Running, or in-place-parked zero-reference context
    is a terminal invariant failure and is not freed.
27. A body response is valid only when its storage fingerprint matches the
    requested manifest entry and that entry stays stable across the read.
28. One R2 body prefix has one writable Durable Object room during a rolling
    room-shape change.
29. One collaboration binding retains no more than one transaction-derived
    projection payload. Any overlap becomes one payload-free projection level
    signal.
30. The legacy Durable Object manifest key always contains a plain
    `SyncManifest`. Dirty recovery state uses a separate versioned key.
31. The native execution-envelope queue has one total limit of 4,096 records.
    Affiliated continuations count against the same limit as all other
    records.
32. If all 16 dispatch contexts are parked in deeper waits, the next dispatch
    request makes the scheduler terminal. The implementation does not discard
    that request and continue.
33. The JavaScript mailbox has no more than 4,096 reservations. The count
    includes timers which are not due and records which are due but not yet
    transported.
34. A positive context sleep owns one cancellable timer lease for an exact
    context ID and wake token. A successful fiber retirement cancels that
    lease before it releases the context stack.
35. Fiber retirement removes the generated Emscripten guard entries which use
    the raw `emscripten_fiber_t` address. Address reuse cannot inherit a stale
    suspension or park record.
36. One sibling restage path retains no more than one submitted owner ticket
    and one latest replacement value.
37. Exact delayed native completions retain no more than 64 MiB of estimated
    payload data in the physical-entry FIFO. Capacity refusal is terminal; it
    cannot discard an exact completion and strand its native waiter.
38. Sync-client local writes and sync-server manifest operations use bounded
    lanes. Independent client paths and independent server namespaces remain
    concurrent.
39. Each Parked context records one `ParkWakeKind`. Release can reclaim a
    Parked context only when the kind is None, or after it successfully revokes
    a Cancellable wake.
40. Park admission is separate from the signed 32-bit wake result. No result,
    including `-1`, is an admission-failure sentinel.
41. Context IDs and scheduler wake tokens increase monotonically. They do not
    wrap and do not identify a later context or wake.
42. An exact wake must match its context, wake kind, and wake token.
43. A Ready fiber already has a scheduler claim. A direct fiber transfer
    cannot enter it or replace its queued transfer value.
44. Same-owner nested ingress can run only UserInput and PendingEvents from a
    bounded entry snapshot. Ordinary and affiliated work stays queued.
45. A modal child can run same-owner nested ingress only with the exact active
    child owner, lease generation, and target scope.
46. A browser event received during Asyncify unwind, rewind, or a fiber
    trampoline is copied and retained. It is staged into native code exactly
    once after the corresponding transition-completion edge.
47. A shown modal receives one exact ModalLifecycle first-paint task. The task
    can paint only that still-shown dialog and cannot run general parent work.
48. Every audited external browser receipt gets one monotonic sequence before
    the adapter decides between inline and delayed staging. A later receipt
    cannot run before the earliest receipt which is still pending in
    JavaScript.
49. Modal capability is the immutable lease snapshot from receipt time. An L1
    receipt cannot use L2 capability, even when L2 uses the same target scope. An
    unavailable snapshot is conservative Ordinary work with no lease. When a
    closing L2 covers an accepting L1, new L1 input captures L1 and waits. It
    cannot enter until L2 closes and L1 has no live child.
50. One scheduler drain batch performs no more than 4,096 transitions. Ready
    work at that boundary causes one coalesced continuation in a fresh browser
    task. A quiescent batch resets the consecutive-exhaustion count.
51. Ready work which survives 64 consecutive full drain batches is a transfer
    livelock. The scheduler fail-stops instead of scheduling forever.
52. A raw Embind thenable during owner delivery is terminal. JavaScript marks
    native integrity unknown and does not use a Promise reaction as a native
    completion edge.
53. Context publication, execution-envelope publication, and pending-event
    provenance publication are transactional. Allocation failure rolls back
    every partial index, queue, or registry change before fail-stop.
54. A null delegated pending event creates no queue or provenance record. A
    null event found in the physical wx pending list is terminal and is not
    treated as blocked work.
55. Each scheduler-owned dispatch root has one non-owning physical-root proxy.
    A proxy cannot release the scheduler stack. Live dispatch-root proxies are
    bounded by the 16-context dispatch depth.
56. `nanosleep()` does not suspend for zero duration. It rounds every positive
    sub-millisecond duration up to 1 ms and splits a duration larger than
    `INT_MAX` milliseconds into bounded timer chunks.
57. Closing a sync source or layer changes its lifecycle generation, aborts
    owned HTTP work, closes or releases realtime channels, cancels timers, and
    makes older callbacks unable to publish.
58. Fetch transfer and WebSocket receipt stay concurrent. Only the later short
    native touch or stateful native apply enters a native gate.
59. The KiCad 10.0 configuration seed disables unavailable Plugin and Content
    Manager table maintenance before editor startup. It does not overwrite an
    existing settings file.
60. An exception from `GAL_UPDATE_CONTEXT::endUpdate()` can reach the existing
    GAL recovery boundary. The destructor must not convert that exception into
    `std::terminate`.
61. A failed OCC or ngspice service worker settles every request posted to that
    worker. It terminates and retires the worker generation. The next request
    starts a new worker. A late message or event from the retired worker is
    inert.
62. A worker `error`, a worker `messageerror`, and a reported boot error close
    the same exact-wait boundary. A synchronous `postMessage()` exception
    removes and settles the exact request before control returns to the caller.
63. A replaceable UI intent cannot use the completion of an older owner ticket
    as proof that the latest value is active. It keeps one ticket in flight and
    submits the latest corrective value after a superseded admitted call.
64. A synchronous mouse-button or title-bar-resize paint tail cannot use a
    global top-level-window sweep while a modal child lease is active. It can
    paint only the top-level window with the exact active scope token.
65. An asynchronous browser resource conversion has an exact source
    generation. An older completion cannot publish over newer state. A stale,
    replaced, or destroyed browser resource is released, and every Promise
    rejection is observed.
66. A worker-origin browser action enters the main runtime through the
    owner-aware wx pending-event path. It cannot use a raw Emscripten main-
    thread proxy callback to enter Wasm and free a heap payload under another
    semantic owner.
67. A completed file read retains the exact wx.js evaluation, Module object,
    batch map, and token generation which accepted the browser drop. A read
    from a retired module cannot publish into or release the same numeric
    token in a replacement module.
68. Each wx.js evaluation owns its graphics-patch poll, timer handles, Module
    object, and initial GL object. A callback or cleanup from a retired
    evaluation cannot patch replacement graphics state or clear replacement
    timers.
69. One save path retains no more than one active immutable snapshot and one
    replaceable latest snapshot. Different paths remain concurrent. One hook
    retains no more than 64 MiB across no more than 256 path lanes.
70. Collaborative projection retries only valid owner-queue backpressure
    without a failure count. A stale or terminal owner failure stops that
    binding projection. Eight consecutive unknown failures open a circuit;
    only a later Yjs transaction starts one new full-authority attempt series.
71. Every exact-open consumer observes the returned Promise. An intentional
    in-flight open installs its rejection handler when it starts, not only at
    the later join point.
72. A pre-modal pending-event handoff applies only to a consume-once
    next-modal capability on an exact asynchronous method-call event for a
    real window in the dialog family. A non-window sidecar with the same owner
    and associated scope cannot receive this capability.
73. Lease binding requires the exact parent owner, no earlier lease on the
    event, and the exact target scope of the newly opened lease. It publishes
    the lease index before it changes any event record and leaves the physical
    wx FIFO unchanged.
74. Opening a modal lease does not let the still-running parent process the
    transferred event. The event can run only after the exact modal child is
    admitted and `CanRunNestedIngress()` accepts that child, lease, class, and
    scope tuple.
75. `BeginClose` revokes pending-event admission for the child. Work which is
    still retained then waits for the stable root drain after the lease closes.
76. Native-entry readiness is false while any physical context has a live
    in-place Asyncify park. A fresh native entry cannot start inside that saved
    capture even when `current()` is 0 and no transition is in flight.
77. An unpublished provider and Y.Doc have one raw session owner. Boot failure,
    open failure, attach failure, unmount, or a late connection destroys both
    objects exactly once unless ownership moved to a binding or sheet manager.
78. `SexprVersionError` is terminal for one sheet switch. Code reports it to
    the caller and does not start a retry timer or report a successful bind.
79. An OCC or ngspice generation cannot wait forever without an event. Boot and
    response watchdog expiry retires that generation and settles all requests
    which belong to it.
80. One sibling path has no more than one connection attempt and one delayed
    reconnect slot. A late completion from an old generation cannot publish a
    session. A successful publication resets its backoff.
81. A Ready FIFO claim is published before code changes a context state,
    consumes a `ParkWake`, changes a transfer value, or changes either transfer
    endpoint. Publication failure leaves the previous state retryable.
82. Main-loop detach becomes externally visible only after the JavaScript
    scheduler accepts the exact initial progress edge. Rejection removes and
    releases the temporary context publication.
83. A browser main-stack range is valid when its size is non-zero. A lower
    address of zero is valid. Root adoption requires exact captured bounds and
    a local address in the half-open range `[stackEnd, stackBase)`.
84. One exact semantic owner has no more than one active `runOnFiber` body. A
    descendant owner can use a separate active lane while an ancestor is
    parked. This does not permit unrelated roots to overlap.
85. An ancestor close request revokes admission for that exact lease
    immediately. Readiness, completion, and removal remain last-in-first-out.
86. `ShowModal(callback)` invokes the callback only after the wait resolves,
    the lease closes, focus is restored, and the dialog is reusable.
87. Copied native execution-envelope payloads retain no more than 64 MiB in
    aggregate. Each lease starts before queue publication and ends after the
    callback returns or after discard completes.
88. An execution envelope with a retained-byte lease cannot coalesce. Capacity
    refusal is terminal because code cannot discard an exact service payload.
89. Queue cleanup clears the submission handshake, callback, argument,
    discard pointer, and byte lease before it invokes arbitrary discard code.
    A zero-byte lease is valid. A non-zero value is not an ownership marker.
90. A terminal `Module` failure cannot be reactivated by later user-interface,
    Yjs, WebSocket, or cache events. A replacement module has a new terminal
    state.
91. An operation on which an exact waiter depends completes through that
    waiter's exact token edge. It cannot wait in a general queue behind that
    waiter.
92. Open CASCADE model prefetch uses source, IndexedDB, and network operations
    only. It does not touch editor MEMFS or the WebAssembly heap. Timeout aborts
    selection and makes later source results inert.
93. A save promotes its pending successor only after an acknowledged commit.
    A conflict or unknown result blocks that path until the save hook is
    replaced.
94. DOM adapter IDs increase monotonically in one browser realm and are not
    reused after same-realm module replacement. Old listeners, controls,
    popups, animation callbacks, snapshots, and cleanup cannot affect the
    replacement.
95. A file-drop reservation remains charged until all non-cancellable
    `File.arrayBuffer()` operations for that batch settle. One failed sibling
    read does not release live sibling bytes.
96. ngspice output is bounded at the worker batch, worker transport, main-
    thread queue, JavaScript completion, and native execution-envelope layers.
    Failure to transfer an exact frame retires the worker generation or makes
    the native module terminal.
97. A loaded-body base revision changes only after a successful body load or
    an acknowledged, strictly advancing save commit. A metadata observation,
    HTTP 409 response, timeout, or transport ambiguity does not change it.
98. A context-menu resolver remains owned by the browser realm that created
    its lease. Adapter replacement cannot remove the only completion edge for
    an old native wait.
99. A DOM event-snapshot charge ends only on exact pop, discard, or shutdown.
    Count and byte capacity failures occur before publication.

## 4. Physical entry, physical contexts, and semantic owners

### 4.1 Physical context operation

`wx/wasm/private/sched_context.h` contains the physical context registry. A
context has its own stack and Asyncify buffer. The scheduler starts, parks,
marks ready, resumes, and destroys contexts by context ID.

The main browser stack is now scheduler-only during normal operation. The wx
main loop runs on a dedicated main-loop context. A fresh JavaScript task starts
or resumes this context. The context parks once per frame. The animation-frame
callback marks it ready again.

wx event dispatch runs on reusable dispatch contexts. A dispatch context does
the following work:

1. It runs eligible execution envelopes.
2. It processes wx events.
3. It parks with the reason `dispatch-idle`.
4. A later fresh task marks it ready and reuses it.

The scheduler can allocate another dispatch context when all existing dispatch
contexts are parked in deeper waits. The implementation has a fixed ceiling.
This ceiling prevents unbounded context memory.

The ceiling is 16 dispatch contexts. A new dispatch request can be the only
completion edge for work which is already admitted. Therefore, the
implementation does not drop the request when all 16 contexts are parked. It
makes the scheduler terminal. This converts excessive modal nesting or a
dispatch-context leak into a bounded failure instead of a permanent wait.

Context creation is also fail-atomic. The scheduler allocates the protocol
record and both stack buffers before publication. It publishes the context map
entry and its Ready FIFO claim as one transaction. If either container
allocation fails, it removes the map entry, frees the new record and buffers,
and returns failure. No live context can remain discoverable without one
scheduler edge that can run it. The libcontext adapter applies the same rule to
its opaque-handle registry and physical-context index. Each failed registration
or binding removes every earlier publication before it returns a null handle.

Before native code starts, wakes, or resumes a context, it checks two
scheduler facts and one saved-capture fact:

- `current()` must be 0.
- `transition_in_flight()` must be false.
- `any_context_has_inplace_park()` must be false.

The third check is required after an in-place `handleSleep` unwind returns to
JavaScript. At that time, no physical context can be current and no unwind or
rewind transition can be active. However, one context can still own the saved
in-place capture. A new native entry in that interval could create a second
rewind root for the same module. The registry records this park from
`wxWasmSchedInplaceParkBegin()` until `wxWasmSchedInplaceParkEnd()`. The leaf
readiness probe remains closed for that complete interval.

The JavaScript arbiter in Section 4.2 performs the main check before it removes
the entry job. The native main-loop, dispatch, scheduler-pump, context-wait,
and context-sleep exports repeat the check as a defensive guard. A direct or
stale caller therefore cannot change physical scheduler state in a busy
interval.

#### 4.1.1 Park-wake ownership

`yield_park()` installs one explicit `ParkWake` record before it changes a
context to Parked. The record has one of four kinds:

| Kind | Meaning | Wake operation | Release rule |
|---|---|---|---|
| None | No delayed callback retains the context. Transfer parks and terminal test parks use this kind. | No external wake is required. | Release can reclaim the Parked context. |
| External | An ordinary callback retains the context, but it has no exact token. Dispatch-idle, frame, and other callbacks with no exact identity use this kind. | `mark_ready(contextId, value)` | Release refuses until the callback consumes the wake. |
| RetainedExact | One callback retains an exact token, but the callback cannot be revoked safely. Generic wx waits use this kind. | `mark_ready_retained(contextId, value, wakeToken)` | Release refuses until the exact callback consumes the wake. |
| Cancellable | One callback retains an exact token and supplies a revocation function. Positive context sleep uses this kind. | `mark_ready_owned(contextId, value, wakeToken)` | Release must revoke the exact callback first. If revocation fails, release refuses without a state change. |

`yield_park()` validates the record before it changes scheduler state. None
and External cannot carry a token. RetainedExact and Cancellable must carry a
non-zero token. Only Cancellable can carry a cancellation function.

An ordinary wake can arrive while its context is still Running. The registry
retains that value for the next External park. It does not use the value for a
new RetainedExact, Cancellable, or None park. The exact park is refused before
state changes, so its producer can revoke the new exact lease. This rule keeps
ordinary and exact wake ownership separate.

#### 4.1.2 Park result and non-reused identities

`yield_park()` returns `ParkResult { accepted, value }`. A refused park returns
`{ false, 0 }`. A successful park returns `accepted == true` and the complete
signed 32-bit value from its matching wake.

The old integer-only API used a negative value as an admission-failure
sentinel. That rule was invalid. A wasm32 pointer or result with bit 31 set is
negative when C++ reads it as `int`. The value `-1` is also valid data. The
separate `accepted` field keeps all result bit patterns available to callers.

Physical context IDs and scheduler wake tokens are non-zero 32-bit sequences.
The registry increments each sequence and never reuses a value. If increment
would leave zero as the next value, the next allocation refuses instead of
wrapping. JavaScript generic-wait tokens use the same no-wrap rule and stop at
`0x7fffffff`, because their C ABI type is a signed `int`.

An exact wake checks both identities. A stale sleep callback cannot wake a
later sleep on the same context because its wake token differs. A callback for
a retired context cannot identify a new context because context IDs are not
reused.

#### 4.1.3 Ready claims are not transferable

Ready is not only a valid saved capture. `fiber_start()` or a wake has already
put the context in the scheduler FIFO and has published its transfer value.
This pair is one Ready claim.

`fiber_enterable()` therefore returns false for Ready. A direct
`fiber_transfer()` to a Ready target refuses without parking its source and
without changing the target value or FIFO position. Only the scheduler can
consume the existing Ready claim.

#### 4.1.4 Fail-atomic Ready publication

`publish_ready_id()` is fallible. Code must publish the FIFO claim before it
changes the state that the claim represents. This rule applies to these paths:

- Context creation.
- Ordinary wake.
- Cancellable wake.
- Retained-exact wake.
- A result which exists before its context parks.
- `fiber_start()`.
- `fiber_transfer()`.
- Terminal fiber transfer.

If FIFO allocation fails, the operation leaves the previous context state,
`ParkWake`, transfer value, and transfer endpoints unchanged. A producer can
then retry or perform its defined terminal action. The test hook
`fail_next_ready_fifo_allocation_for_test()` causes this failure at one exact
publication. The `ready_publication_is_transactional` scenario checks each
state-changing path.

`fiber_swap()` also proves its physical source before it changes a transfer.
The source must be Running. It must be the current direct-lane occupant. The
local address must be in the exact C-stack bounds. The source must not own an
in-place park. Failure leaves the proposed transfer unchanged.

#### 4.1.5 Initial progress and browser-stack adoption

The registry captures the browser main-stack bounds before its first stack
switch. The bounds use a non-zero size as the validity test. A `STACK_FIRST`
application can have the range `[0, 65536)`. The lower address zero is valid.

The adopted browser-stack root uses the captured bounds. Adoption requires an
exact bounds match and a local address in `[stackEnd, stackBase)`. This rule
fixed a root-adoption regression in which the code treated address zero as an
absent stack and refused a valid main stack.

`wxWasmDetachMainLoop()` also uses transactional publication. It temporarily
publishes the fresh main-loop context. It then requests the exact initial
JavaScript scheduler job. It sets the detached state only after JavaScript
accepts that job. Rejection removes the publication and releases the context.
The main loop therefore cannot become detached without one accepted progress
edge.

### 4.2 Physical native-entry arbiter

#### 4.2.1 Reason for the arbiter

Separate contexts have separate native stacks and separate Asyncify data
buffers. This separation is necessary, but it is not sufficient. The
Emscripten Asyncify transition controller is module-wide JavaScript state. It
has one current unwind or rewind operation.

A browser callback can run while a suspending export is unwinding. During
part of this interval, the physical registry can still record a context as
current and can record a transition in flight. A frame callback, timer, or
mailbox callback must not call a pump which marks another context Ready in
this interval. If it does, the old pump can resume the other context inside
the first wake. The new capture then has the wrong JavaScript rewind root.
Separate native stack buffers do not correct this boundary error.

The physical native-entry arbiter prevents this overlap. It is in
`scripts/common/shims/asyncify-scheduler.js`. It controls scheduled calls that
can start, wake, or resume a physical context. It does not intercept every
WebAssembly export. It does not process model work and it does not grant an
execution owner.

#### 4.2.2 Job types

The arbiter uses one FIFO with a maximum of 4096 jobs. Each job has a callback,
a diagnostic site, and an optional coalescing key.

The following entries are level signals:

| Key | Meaning |
|---|---|
| `dispatch` | A top-level wx event or execution-owner envelope needs a dispatch context. |
| `main-loop` | The wx main-loop context needs its initial entry or one frame wake. |
| `mailbox` | The JavaScript mailbox has records for the typed native queue. |
| `sched-pump` | At least one physical context is Ready. |
| `mutator-submit` | The owner gateway has a queued native job to submit. |

Two pending signals with the same key have the same meaning. The arbiter keeps
one signal and counts the other signal as coalesced. The actual payload stays
in the mailbox, owner queue, mutator queue, or physical registry. Therefore,
coalescing the signal does not remove the payload.

The following entries are exact:

- One context-wait result for one wait token.
- One positive context-sleep wake for one `(context ID, wake token)` pair.
- One delayed native completion and its retained-byte reservation.
- One ingress receipt that the scheduler must retain during an Asyncify
  transition.

An exact entry has no coalescing key. The arbiter keeps each payload and its
FIFO position. It cannot replace one exact wake with another wake.

`runWaitCompletion()` is not a FIFO job. It owns the output pointers of one
parked waiter. It prepares the output and resolves that exact wait token in one
immediate JavaScript callback. If the scheduler put this edge behind the
readiness probe, the waiter could keep that probe closed and wait for itself.
The later physical wake still uses the FIFO.

#### 4.2.3 Two-phase admission

Admission has these steps:

1. A producer adds a job with `enqueueNativeEntry()`.
2. The arbiter coalesces a level signal when the same key is already pending.
3. When JavaScript transition state is free, the arbiter arms one zero-delay
   browser task.
4. The task calls `_wxWasmNativeEntryReady()` before it removes the FIFO head.
5. The leaf probe returns 1 only when native admission is live,
   `current()` is 0, `transition_in_flight()` is false, and no physical
   context has a live in-place park.
6. If the probe returns 0, the arbiter retains the head in its position. It
   does not start a retry timer.
7. If the probe returns 1, the arbiter removes the head and clears its level
   key. The entry is now accepted.
8. The arbiter calls the accepted callback one time.
9. The arbiter accepts no more than one entry in that browser task.
10. If the FIFO still has work and transition state is free, the arbiter arms
    a new browser task for the next head.

The leaf probe is phase one. The possibly suspending callback is phase two.
The probe only reads physical state. It cannot allocate, drain, mark a context
Ready, or suspend. JavaScript cannot run another browser callback between the
probe and the accepted call in the same task.

The FIFO uses fail-stop behavior when it reaches its limit or when the leaf
probe is absent. A trap in the probe or the accepted callback also enters the
normal terminal native-trap path.

#### 4.2.4 Non-polling transition signal

A refused probe does not use a timeout loop. The retained head waits for the
transition that made the scheduler busy.

Emscripten calls `Asyncify.maybeStopUnwind()` after every instrumented native
export. Most calls are not transition edges. This includes the call after the
leaf readiness probe.

The shim therefore records an edge before it calls the original function. The
pre-call state must have all these properties:

- `Asyncify.currData` is not null.
- Asyncify is in the Unwinding state.
- The export-call stack is empty.

The shim then calls the original function. The original function changes the
state to Normal and runs the fiber trampoline. The shim arms a retained drain
only when the pre-call predicate was true and the post-call transition state
is free. A Normal-state call after the leaf probe cannot arm the probe again.

This mechanism has no retry period. A long suspend does not create repeated
browser tasks, repeated probes, or a retry storm. A completed transition gives
the retained head one new admission attempt.

#### 4.2.5 No-replay law

The arbiter removes an accepted job before it calls the job callback. This
order is mandatory.

A suspending export can unwind and make its JavaScript wrapper return a shallow
placeholder. That value is not proof that the native operation was refused or
complete. The arbiter therefore does not use the suspending export's return
value as an admission result. The leaf probe is the admission result. After
phase one accepts a job, the arbiter calls the job exactly once and never puts
it back because of the shallow return.

Some exact native exports return a success value for their own target check.
For example, a context-wait resolver can reject an unknown token. This target
result is not an arbiter admission result. The job was already accepted and
consumed before this check.

#### 4.2.6 Relationship to semantic ownership

The physical arbiter and the semantic owner are both necessary.

- The physical arbiter prevents an invalid overlap between module-wide
  Asyncify transition state and physical context start or wake.
- The semantic owner prevents two unrelated native transactions from changing
  shared wxWidgets or KiCad state at the same time.

The physical arbiter does not know a modal scope, owner branch, work class, or
model transaction. It cannot replace the semantic owner. The semantic owner
does not own the module-wide Asyncify transition boundary. It cannot replace
the physical arbiter.

#### 4.2.7 Synchronous DOM entry and transition-time receipt

The implementation preserves synchronous keyboard and mouse results. A safe
adapter can stage an input envelope and run its dispatch in the current fresh
browser task. This supplies the immediate `preventDefault` decision. The path
still uses one total receipt order for audited external input.

The JavaScript scheduler owns these receipt records:

- `ingressReceiptSeq` allocates positive tokens up to `0x7fffffff`.
- `ingressReceipts` holds at most 4,096 immutable records.
- `pendingIngressReceipts` identifies receipts which have not yet crossed the
  JavaScript staging boundary.
- `ingressLeaseSnapshot` is the latest immutable control snapshot published by
  native code.

Native code publishes the lease snapshot when execution ownership starts and
whenever a modal lease opens, starts to close, or closes. The snapshot contains
an explicit availability flag. A valid no-lease snapshot is different from an
unavailable snapshot. Each receipt copies all lease identity, parent,
generation, target-scope, and target-generation fields. Native code reconstructs
the 64-bit fields and validates the complete record. It does not rediscover an
ambient modal at delayed delivery time.

Publication uses the deepest accepting lease, not necessarily the active top
lease. These values differ only during nested close. If L2 has called
`BeginClose` and L1 below it still accepts input, the browser snapshot contains
L1. Native admission still uses L2 as the active lease, so the L1 envelope stays
queued. Stale-envelope checks use the same receipt-capability view. Therefore,
they retain this L1 envelope while L2 covers it, but discard an L2 envelope
after L2 stops accepting. After `CloseLease` removes L2 and the original L1
child returns, normal active-lease admission can run the retained L1 envelope.

The receipt rule has these steps:

1. The adapter copies the complete event payload. It then captures one receipt
   sequence and the current lease snapshot before it decides how to stage.
2. If Asyncify is Unwinding or Rewinding, or a fiber trampoline is running, the
   adapter retains the staging closure in `nativeEntryQueue`.
3. If an older external receipt is already pending, a later custom adapter also
   joins that queue. It does not use the safe inline path.
4. An Emscripten-generated canvas callback captures a receipt at native entry.
   It can copy and stage its native envelope. If the receipt says that an older
   receipt is pending, it cannot drain the envelope inline.
5. Each native execution envelope stores the receipt sequence. Native queue
   insertion orders ingress envelopes by this value.
6. Before native dispatch, the queue reads the earliest receipt which is still
   pending in JavaScript. A native ingress envelope can run only when its
   sequence is earlier than that frontier. This prevents a staged B from
   crossing an unstaged A.
7. The staging leaf must consume the exact receipt token. Failure to consume
   it is terminal. A receipt, payload, or envelope is never replayed.

This closes two overtaking windows. A later custom DOM event cannot run inline
after an earlier event was delayed. A later Emscripten callback cannot stage
natively and drain before the earlier JavaScript closure reaches native code.
Non-ingress work is independent of this order. Native ingress which is already
earlier than the frontier is also eligible. Thus, this is an external-ingress
FIFO, not one global FIFO for all browser and application work.

Receipt-time modal provenance follows the same exact rule. An L1 receipt keeps
L1 even if native code later publishes L2 for the same window. A stale L1
envelope is discarded. It cannot use L2 capability. If the snapshot is unavailable,
native code keeps the payload but changes it to Ordinary work with no target
scope and no lease. This is a conservative fallback, not ambient discovery.

The audited ingress set includes custom DOM controls, forwarded DOM mouse
input, non-main title-bar move, close, and resize, and completed file-drop
batches. It also includes generated keyboard, mouse, touch, wheel, resize,
focus, and before-unload callbacks. File-drop completion deliberately requests
Ordinary admission because the asynchronous file reads can outlive the modal
in which the drop began.

#### 4.2.8 Bounded scheduler drain and continuation

One physical scheduler pump must not run an unbounded transfer chain in one
browser task. `drain_all()` therefore stops after 4,096 successful context
transitions. It then checks the Ready FIFO.

- If no Ready context remains, the batch is quiescent. The scheduler resets
  the consecutive-exhaustion count.
- If Ready work remains, the batch returns `ContinueOnFreshTask`.
  `wxWasmDrainSchedulerBatch()` asks the JavaScript arbiter for one coalesced
  `sched-pump` continuation. The new task continues the same physical work.
- If the arbiter cannot retain that continuation, native execution fail-stops.
  The implementation does not strand a Ready context.
- If 64 consecutive batches use the complete transition budget and never
  become quiescent, `drain_all()` returns `Livelock`. Native execution
  fail-stops instead of creating an infinite sequence of browser tasks.

The 4,096 value is a transition budget. It is not the 4,096 native-entry job
limit, the 4,096 execution-envelope limit, or the 4,096 pending-event limit.
The continuation is scheduler control work. It is not a replayed DOM event and
does not admit a new semantic transaction.

#### 4.2.9 Consume-once fiber rewind guard

The native-entry arbiter prevents a new scheduler entry during a live Asyncify
transition. A second check protects the target of an Emscripten fiber switch.

The scheduler shim wraps `Fibers.finishContextSwitch()` and records two
different states:

- A real fiber switch creates one live fiber suspension. One later resume can
  consume it.
- An in-place `handleSleep` park keeps the body live below JavaScript. It does
  not create a symmetric fiber suspension which another transfer can consume.

Before the generated Emscripten code rewinds a target, the guard requires a
live suspension for a resume path. It consumes that suspension one time. It
also refuses a target which is still in an in-place park. A refused switch
clears the proposed rewind data and uses the established null-transfer path.
It does not rewind stale frames.

The generated guard uses the raw `emscripten_fiber_t` address as its key. The
native registry calls `releaseFiberGuard()` immediately before it releases a
fiber context. This call removes the address from the live-suspension,
internal-park, and park-buffer sets. It also clears the address if it is the
recorded root fiber. Thus, an allocator cannot give a new fiber the guard state
of an old fiber at the same address.

The physical context registry records the begin and end of an in-place park.
The libcontext protocol also records whether its symmetric suspension is live.
These records are physical safety checks. They do not grant a semantic owner,
and they do not create deferred ownership. They do make release fail-stop while
a delayed wake still owns a rewind into the context's caller-owned C stack.

### 4.3 Physical terminal coroutine handoff

Logical coroutine completion and physical context completion are different.
The old Wasm path set the logical `m_running` flag to false. It then used the
normal `jumpOut()` yield. An Asyncify park could make that yield return control
to the caller before the source context became terminal. The caller could then
destroy the coroutine and release its borrowed C stack while the scheduler
still recorded that source as Parked or Suspended. A later scheduler action
could then use a context record for released stack memory.

The Wasm path now uses a terminal operation when the coroutine body returns:

1. `COROUTINE::jumpOut()` keeps the existing sanitizer switch prologue.
2. When `m_running` is false, it calls `libcontext::finish_fcontext()`.
3. `finish_fcontext()` validates the source, target, saved-context pointer,
   and libcontext protocol state.
4. It saves the source context in the caller's output slot.
5. It marks the libcontext source Finished before it transfers control.
6. It increments the target resume epoch exactly once and preserves the final
   invocation value.
7. It selects the star terminal transfer or the direct terminal swap with the
   same rule that the normal scheduler swap uses.
8. The scheduler marks the source physical context Finished before it resumes
   the target.
9. The terminal operation does not return to the source.

`fiber_finish_transfer()` is the star-lane operation. It marks the source
Finished, makes the target Ready, and yields to the scheduler. The scheduler
does not select Finished contexts.

`fiber_finish_swap()` is the direct-lane compatibility operation. It validates
the exact physical source and target before it changes either endpoint. It then
marks the source Finished and enters the protocol-approved target. A mismatch
aborts. The terminal direct transfer cannot continue after a refusal because
there is no safe return path to its completed source. An attempt to resume the
Finished source also aborts.

This change is Wasm-only. Native coroutine operation does not use this terminal
path. A normal `KiYield()` also keeps the normal symmetric jump. The new path
runs only after the coroutine body is complete.

### 4.4 Exact Wasm fcontext lifetime

The old Wasm `fcontext_t` value was a pointer to a C++ protocol object. If code
kept that pointer after release, the allocator could reuse the address for a
new coroutine. The stale value could then name the new coroutine. Keeping old
objects or stacks in a deferred retention list only delayed this alias and
retained large Asyncify buffers.

The Wasm backend now uses an exact lifetime rule:

1. `make_fcontext()` allocates a monotonically increasing 32-bit token.
2. A registry maps that token to the live C++ protocol object.
3. Public `fcontext_t` values contain the token, not the object address.
4. The backend never reuses a token. Token wrap or registry insertion failure
   makes context creation fail.
5. A saved-context slot owns one reference. Replacing the slot releases its old
   target and retains its new target.
6. The first-entry `return_to` handle is also an owning reference. It keeps the
   terminal fallback target live until the source context retires.
7. When the last reference ends, a physically releasable non-current context
   retires immediately. This includes a Finished context and a cancelled
   unfinished context at a real Fresh, Suspended, or Ready boundary. A Parked
   context is releasable only under the ParkWake rules below.
8. Retirement releases the scheduler fiber and Asyncify buffer, unregisters
   the token before it deletes the protocol object, and releases the owned
   `return_to` edge.
9. A failed scheduler-fiber release is terminal. Release is refused for a
   Running context, for any context with an in-place park, and for a Parked
   context with an External or RetainedExact wake. The refusal leaves the
   registry, Asyncify buffer, and caller-owned C stack intact. Libcontext
   aborts before the owner destructor can free that stack. A zero reference
   count on the context which is executing is terminal for the same reason.
10. A Parked context with None has no delayed wake owner and can retire. A
    Parked context with Cancellable must revoke its exact `(context ID, wake
    token)` lease first. Positive context sleep uses this rule to cancel its
    timer or remove its exact callback from the JavaScript native-entry FIFO.
    If the wake source cannot confirm cancellation, release is refused without
    a registry change.
11. Before final deletion, `fiber_release()` removes all generated-fiber guard
    state which is keyed by the raw fiber address.

A later jump through a stale token cannot resolve in the registry. The backend
records a bounded diagnostic and returns the established null transfer result.
It cannot enter released memory, and it cannot alias a later coroutine.

There is no deferred lifetime list. A releasable context with zero references
has no owner and no valid future entry. An unsafe Running or in-place-parked
release does not enter a quarantine and does not continue: the Wasm instance
fail-stops while the live wake allocations remain intact. The terminal handoff
in Section 4.3 makes normal completion reach the releasable path only after the
source is physically Finished.

This handle rule is specific to the wasm32 backend. A compile-time size check
prevents silent token truncation on a future wasm64 build.

The KiCad `COROUTINE` wrapper also checks `m_running` and its context handle
before `Resume()`, `RunMainStack()`, or an internal resume. A resume after
completion returns false. Context-creation failure throws `std::bad_alloc`
before the body can start.

#### 4.4.1 One libcontext proxy for each physical dispatch root

A single global libcontext root cannot describe all scheduler dispatch stacks.
One dispatch root can park in a modal while another dispatch root runs. If a
compatibility singleton still names the parked root, a later transfer can save
or restore protocol state for the wrong C stack.

The Wasm libcontext backend now resolves the source from the physical stack at
each transfer boundary:

1. `context_owning_current_stack()` finds the exact scheduler context whose C
   stack contains the current frame.
2. Tool fibers already have owning libcontext protocol records.
3. A scheduler dispatch root without a protocol record gets one immutable
   physical-root proxy.
4. `scheduler_context_registry()` maps the monotonic scheduler context ID to
   that proxy.
5. The proxy gives `jump_fcontext()` an exact source identity. It does not own
   the stack or Asyncify buffer. It must never call `fiber_release()`.
6. The separate browser main-stack root remains one adopted main-stack record.
   It is used only when no registered scheduler context owns the current frame.

The dispatch pool has a fixed depth of 16. The proxy registry has the same
limit. Before it creates a proxy, libcontext sweeps only a proxy whose physical
scheduler context is gone, whose saved edges are clear, and which is not the
current protocol context. A sweep while the physical root is live, an attempt
to release a scheduler-owned stack, or a seventeenth live dispatch proxy is
terminal.

`wasm_root_proxy_stats_for_test()` reports live, peak, capacity, creation,
release, scheduler-release attempts, and unsafe sweeps. The coroutine-nested
reducer contains the focused assertions for this rule. The final focused
browser run for the current combined source is pending and must be recorded in
Section 12.

### 4.5 Owner mapping

`wxwidgets/src/wasm/evtloop.cpp` has a separate map from physical context ID to
semantic owner token. `wxWasmExecutionScope` installs this map entry for the
native callback. The scope removes the entry when the callback ends.

This map does not make the two identities equal. A transaction can move from a
dispatch context to a KiCad tool fiber and keep the same owner. A later
affiliated cleanup can run on another dispatch context and keep the same owner.

### 4.6 Startup owner

wx initialization changes global state before the normal browser event pump
exists. `wxWasmExecutionBeginStartup` creates a root owner for this interval.
`wxWasmExecutionEndStartup` releases it after initialization and main-loop
publication.

The startup owner is explicit. Code does not infer it from context ID 0.

## 5. Root, lease, and child lifecycle

### 5.1 Root lifecycle

An ordinary envelope requests admission. The coordinator creates a root owner
only when no root owner exists. The admission starts with one owner reference.

Code can retain the owner before work outlives the current callback. Each
retain must have one release. The root retires only when its reference count is
zero and no lease still uses its branch.

### 5.2 Lease lifecycle

A modal or nested wait opens a lease from the current owner. The lease contains
an allowed work mask and one exact scope token.

An input, pending-event, or modal-lifecycle envelope can create a child owner
only when all of these conditions are true:

- The top lease accepts new work.
- The work class is in the allowed mask.
- The envelope has the exact lease scope.
- The lease has no live child owner.

The child can retain its owner across a park. The lease cannot admit a second
child until all references to the first child are released.

`BeginClose()` can identify an exact ancestor lease. The request is
idempotent. It stops new admission for that lease at once, even when a deeper
lease is still active. `LeaseReady()` and `CloseLease()` remain top-only
operations. Therefore, completion and removal keep strict last-in-first-out
order.

`KIWAY_PLAYER::DismissModal()` uses `Exit()` when it closes the current event
loop. It uses `ScheduleExit()` when the target is an active ancestor. The
ancestor request records its close state without removing a lease below the
active top lease.

### 5.3 Exact close sequence

A modal close uses this sequence:

1. The close request records the exact result.
2. `BeginClose` stops new child admission.
3. Browser receipt publication hands capability to the deepest accepting
   parent, if one exists. This does not change the active lease.
4. Existing references for the exact child can run to their tail.
5. The last child release makes the lease ready.
6. The code resolves the exact wait token or exact ready callback.
7. The resumed opener calls `CloseLease`.
8. The coordinator removes the lease.
9. The parent branch becomes eligible again, and a valid parent receipt can
   then be admitted.

The public `ShowModal(callback)` overload is a completion API. It is not an
`EndModal()` callback. Code invokes it only after the wait resolves, the exact
lease closes, focus is restored, and all modal state is reset. The callback can
open the same dialog again.

The code does not use a retry timer for this sequence. A release edge arms the
next execution tick.

If the exact waiter is a parked physical context, `resolveWait()` does not call
the native resolver from the closing callback. It adds one exact native-entry
job with the wait token and result. After the leaf probe accepts the job,
`_wxWasmSchedResolveContextWait()` finds the token's recorded context and marks
only that context Ready. It then adds one coalesced `sched-pump` level signal.
An unknown or refused token causes terminal shutdown. It cannot become a
best-effort wake of another waiter.

The same mechanism handles generic wx bridge waits. JavaScript creates the
wait token before native code parks. If the result arrives early, native code
consumes the retained result and does not park. Otherwise, native code maps
the token to its context and parks with `ParkWake::RetainedExact(token)`.
Resolution uses `mark_ready_retained(contextId, result, token)`.

RetainedExact is intentionally not cancellable. A Promise or provider can
retain native output pointers until it completes. Removing only the scheduler
callback would not revoke those pointers. `fiber_release()` therefore refuses
to free the context and its stack while this wake is live. After the provider
completes, the exact wake consumes the RetainedExact lease. The full result is
then available in `ParkResult.value`; a negative value is data, not a failed
park.

### 5.4 Exact affiliated admission

Liveness and permission are different. `Owns(owner)` shows that a token still
exists. `CanRunAffiliated(owner)` shows that the token is the exact branch that
can run now.

The rules are:

- With no lease, only the referenced root can run affiliated work.
- With a lease, only the referenced child of the top lease can run affiliated
  work.
- When the top lease has no child, no ancestor continuation can run until the
  lease closes.
- `BeginClose` does not block the retained exact child tail.

These rules prevent a retained parent from entering while its modal child is
active. They also prevent a child-zero interval from opening an ancestor race.

### 5.5 Queue policy

The native execution queue has two independent aggregate limits:

- 4,096 retained envelopes.
- 64 MiB of copied retained payload.

The record limit includes ordinary work, modal work, pending events, user
input, and affiliated continuations. There is no affiliated exemption. The
byte limit applies to payloads that declare retained bytes. A zero-byte
payload is valid.

The producer obtains the retained-byte lease before it publishes the envelope.
The queue keeps the lease while the record waits and while its callback runs.
Moving a record out of the queue vector does not release the lease. Callback
return or discard releases it. A retained-byte envelope is exact and cannot
coalesce.

An affiliated continuation can be the only tail which can release the active
owner. Therefore, the queue cannot reject that tail and continue safely. If an
enqueue finds all 4,096 slots occupied, the coordinator enters fail-stop. It
first closes admission. It then detaches the complete retained queue before it
calls any user cleanup. Each detached record calls its optional discard
function no more than one time. A discard function which re-enters fail-stop
cannot find the detached records and cannot discard them again.

The submit-handshake state tells a synchronous producer whether its payload
started, stayed queued, or was discarded during fail-stop. Thus, terminal
cleanup cannot make both the producer and the queue release the same payload.

Before cleanup calls arbitrary discard code, it clears the handshake,
callback, argument, discard pointer, and byte lease in the detached record.
Recursive fail-stop cannot find or release that record a second time.

The queue does not use one global FIFO rule across blocked work classes. A
blocked ordinary envelope cannot hide later modal input that the active lease
permits. The dispatcher scans for the first eligible envelope. It preserves
relative order inside each deferred class.

Only passive mouse movement and resize can coalesce. Coalescing requires
adjacent and consecutive envelopes with the same producer, key, work class,
scope, lease provenance, and coalescing class. All other envelopes are
ordering barriers.

The ngspice bridge converts one worker frame into one owned batch job. It does
not allocate and queue one job for each output line. It charges the greater of
the transport byte count and the conservative C++ vector and string capacity
estimate. The charge remains live until callback return or discard.

### 5.6 Lease provenance for delayed work

A scope token says which top-level window family owns work. It does not say
which modal lifetime created that work. The same window can open modal lease
L1, close it, and later open lease L2 with the same scope token.

This sequence is unsafe if the queue stores only the scope:

1. A timer is scheduled while L1 is active.
2. L1 already has a child, so the timer cannot enter.
3. L1 closes before the mailbox tick stages the timer.
4. The same window opens L2.
5. A scope-only check sees the same window and admits the old L1 timer as an
   L2 child.

The implementation stores the exact `LeaseToken` at ingress. A delayed
mailbox item carries that opaque token through JavaScript and puts it in the
native execution envelope. The dispatcher checks the token before it calls
`Admit()`.

- If the same lease is active and still accepts work, normal class and scope
  admission can continue.
- If close has begun, or another lease is active, the envelope is stale. The
  queue removes it and calls its exact discard callback.
- A stale envelope is never changed to Ordinary work.
- A later lease with the same scope cannot use the old token.

The coalescer also compares lease provenance. Work from two lease generations
cannot replace each other.

If no matching lease exists at ingress, the envelope has no lease provenance.
The normal work-class and target-scope rules then decide its later admission.
Exact provenance prevents one existing lease generation from becoming another
generation. It does not add a new delegated-scope policy.

### 5.7 Owner-aware pending events and `wxYield()`

The wx pending-event list is one physical list. `QueueEvent()` now records
semantic provenance before it adds an event to that list. On the main runtime
thread, the record can contain the current owner, active lease, and target
scope. A worker-thread event has no owner capability and waits for a safe root
drain.

Publication is transactional because `QueueEvent()` has a void API and has
already accepted ownership of the event pointer. The provenance layer first
updates its event map and optional owner and lease indexes under one mutex. If
an allocation fails, it removes every index increment and latches one terminal
Allocation reason. It never leaves an index without its event record.

The physical wx list is the second publication step. The handler lock stays
held while wx appends the list node and publishes the handler in the global
pending-handler index. If either allocation fails, wx removes an appended node,
removes the provenance record, deletes the event exactly once, and wakes the
main pump. A worker can latch this failure, but only the main runtime thread
performs semantic fail-stop cleanup.

Null handling is explicit. `wxWasmExecutionQueueDelegatedPendingEvent()`
rejects a null event before it reaches `QueueEvent()` and changes no accounting.
If a null pointer is ever present in the physical pending list, wx removes that
node and fail-stops. It does not treat the pointer as an ineligible event and
delay it forever.

`ProcessPendingEvents()` scans for the first event that passes both checks:

1. The normal wx event-category check for a selective yield.
2. The execution-owner check for the current root or modal child.

The old `DoYieldFor()` loop used `while (Pending())`. `Pending()` reports that
the physical list is not empty. It does not report that this owner can process
an event. A modal child could therefore leave one parent event in the list and
spin forever.

The Wasm event loop now performs one owner-filtered dispatch pass. An Ordinary
root can then run the normal base-class yield tail. A modal child cannot run
global idle work. It returns after its scoped pending-event pass, even when
another owner's event remains in the physical list.

DOM ingress has a separate native execution-envelope queue. A synchronous
`wxYield()` or `Dispatch()` can continue selected records from this queue, but
only under the owner which is already mapped to the current stack. This is
same-owner recursion. It is not admission of a second root or child.

The nested-ingress rules are:

- Only UserInput and PendingEvents are eligible.
- Ordinary service work and Embind jobs remain queued until the current owner
  retires. Affiliated continuations also remain on their normal boundary.
- A root owner is eligible only when it has no active modal lease. The record
  must not carry modal lease provenance.
- A modal child must be the exact child of the current accepting top lease.
  The record must carry that exact lease token and its exact target scope.
- A stale lease record is removed and its discard callback runs. It cannot use
  a later lease for the same window.
- One call uses the queue depth and sequence at entry as a hard bound. A
  handler which stages more input cannot extend the same `wxYield()` call.

#### 5.7.1 Exact pre-modal `CallAfter()` handoff

One pending-event case exists before a lease exists. Application code can call
`dialog->CallAfter(...)` and then call `dialog->ShowModal()`. `CallAfter()`
queues a `wxEVT_ASYNC_METHOD_CALL` immediately. `ShowModal()` opens the modal
lease later. If the event keeps only its parent provenance, the parent is
blocked as soon as the lease opens and the dialog child cannot use the event.
The callback can then remain in the wx pending list for the complete modal
lifetime. This was the cause of the real tooltip and pointer-scroll failures.

The implementation does not solve this case by transferring all work with the
same owner or scope. `wxWasmExecutionTagPendingEvent()` sets `nextModal` only
when all these facts are true at the queue edge:

- The queued event is exactly `wxEVT_ASYNC_METHOD_CALL`.
- Its event object is exactly the `QueueEvent()` handler.
- That handler is a real `wxWindow` whose top-level family is a `wxDialog`.
- The dialog is not modal yet.
- The event has the exact current semantic owner and exact generated scope.
- The event has no captured lease.
- An active lease, if one exists, has a different scope. This excludes work
  posted after `EndModal()` has changed `IsModal()` but before that exact lease
  closes.

A non-window controller can be associated with the dialog scope. That
association is useful for ordinary scoped pending events, but it cannot set
`nextModal`, because the handler itself is not a real window in the dialog
family. Scope equality is therefore not modal authority.

After `Coordinator::OpenLease()` and publication of the exact modal-lease
record, `wxWasmBindPendingEventsToLease()` scans retained provenance. It selects
only records with `nextModal`, the exact parent owner, no old lease, and the
exact new target scope. It first reserves the complete `byLease` index count.
Only after that allocation succeeds does it copy the new lease into the
selected records and clear each consume-once marker. An allocation failure
latches terminal pending-event failure without partially modifying the event
records. The operation does not remove, reorder, or append an item in the
physical wx pending list, so its FIFO order stays unchanged.

The handoff supplies provenance. It does not supply a runnable stack. In the
short interval after `OpenLease()` and before the modal opener parks, the
current stack still maps to the parent. Both
`wxWasmExecutionHasProcessablePendingEvents()` and
`wxWasmExecutionMayProcessPendingEvent()` reject the parent while any lease is
active. Thus, an `InitDialog()` handler which calls `wxYield()` cannot run the
transferred callback on the parent stack. A nested modal has the same rule: an
outer child cannot consume work transferred to the inner lease.

The callback becomes eligible only after the exact modal child is admitted.
The pending-event path then uses the same
`Coordinator::CanRunNestedIngress()` predicate as staged DOM ingress. The
predicate checks the current child owner, PendingEvents class, lease identity
and generation, target scope and generation, and the accepting state of the
lease. `BeginClose()` makes this predicate false. Any work retained across
close remains in FIFO order until the resumed stable root can drain it.

`DoYieldFor()` checks this staged-ingress queue even when the physical wx
pending-event list is empty. This is required after a positive sleep: the
exact timer wake can resume the owner before the mouse-up reaches the wx
pending-event list. The resumed owner can consume that mouse-up in its next
bounded yield, while an Ordinary request at the queue head remains deferred.

After same-owner ingress, only a root can run global paint and idle work. A
modal child runs its selected pending events without a global model traversal.

### 5.8 Modal and synchronous paint scope

`ShowModal()` can park the user-input owner before the normal post-dispatch
paint tail runs. The modal child must not fix this by running the global paint
loop: that loop can traverse parent model state which the parked owner still
owns. This distinction produced the real first-frame failure: a dialog existed
and accepted drag input, but its client background was still transparent.

The Wasm port now applies the normal application-modal input barrier.
`wxDialog::ShowModal()` creates a real `wxWindowDisabler` after it shows the
dialog. The normal wx enabled flag remains authoritative.
`wxNonOwnedWindow::DoEnable()` copies that state to the browser top-level
window. `wx.js` uses the `wx-inert` class and `HTMLElement.inert`. Therefore,
the parent is disabled in native event policy and in browser input policy. The
lease is not the only modal barrier.

After `Show(true)`, the Wasm dialog port now schedules one zero-delay
ModalLifecycle callback with the exact dialog scope. The callback retains the
dialog until delivery. It checks that the same dialog is still shown and still
needs paint, then calls `HandlePaintRequests()` for that dialog only. If the
dialog closes first, the discard path releases the retention without painting.

The browser task boundary is intentional. It lets the opening DOM callback and
its Asyncify transition complete before the paint enters native code. The
exact modal scope and work class let the active modal child admit the task
without admitting general parent idle or paint work.

Two existing synchronous paint tails also needed this rule. A mouse-button
handler flushes its posted follow-up events and paint requests before it
returns. A DOM title-bar resize refreshes the resized top-level window and
repaints its cleared 2D canvas. Both tails previously called `wxApp::Paint()`,
which scans every top-level window. If either tail ran as a modal child, it
could paint the disabled parent while the parent owner was parked inside the
operation that opened the modal.

`wxApp::PaintCurrentExecutionScope()` preserves the old root behavior. With no
active lease, it scans all top-level windows. With an active modal lease, it
compares each window's complete scope token with the active lease scope and
skips every non-matching window. The generation is part of this comparison, so
address reuse cannot select a later top-level window. The mouse-button and
title-bar-resize tails use this helper. The separate GL-canvas deferral rule is
unchanged: a synchronous tail still leaves a non-main CPU-raytrace canvas for
the normal frame pump.

This is a read-isolation rule, not only an event-dispatch rule. Painting can
call application paint and animation handlers which read model state. A child
therefore cannot use a global sweep merely because the sweep does not admit a
new wx input event.

### 5.9 Narrow modal delegation

Some modal work starts from an object that is not a window. The implementation
does not give all such objects modal permission. It uses three narrow rules.

First, a window-owned `wxTimer` uses its owner window. The Wasm timer port
captures the exact top-level scope and the exact active lease when it arms the
timer. It checks both values at delivery. A stale timer does not run. A periodic
timer skips missed ticks; it does not replay them as a burst.

The tooltip timer uses this rule. Each arm changes the timer owner to the exact
hovered window. The timer also records these two pointers:

- The exact hovered child.
- The exact ancestor that supplied the tooltip text.

`Notify()` checks both pointers and the current hover before it reads the text.
Window destruction cancels the timer and clears all stored pointers. Thus, a
tooltip can run in its modal family, but it cannot use a later hover, a later
lease, or a destroyed window.

Second, KiCad can associate a non-window handler with one window family for the
handler's lifetime. `DIALOG_SHIM::RegisterUnitBinder()` uses this mechanism for
`UNIT_BINDER`. `UnregisterUnitBinder()` removes the association. The base
`wxEvtHandler` destructor also removes it. This last removal prevents a reused
C++ address from inheriting an old scope. A queued event snapshots the current
scope generation. It does not look up an arbitrary active modal at delivery.

Third, one delayed completion can carry a `PendingEventDelegate`. Capture
succeeds only when the caller runs in the active modal child and the supplied
window belongs to that child. The queue call applies the delegate to one exact
handler and event pair. It does not associate the target handler with the
dialog.

The browser action-plugin stub uses the third rule. The Preferences panel calls
`API_PLUGIN_MANAGER::ReloadPlugins(..., this)`. The stub captures a delegate
from that panel and posts one `EDA_EVT_PLUGIN_AVAILABILITY_CHANGED` event to the
panel itself. The Wasm panel binds this completion locally and does not
propagate the command event. This event can re-enable the plugin grid while
Preferences remains modal, but it cannot also run process-wide listeners such
as the parked PCB frame's toolbar rebuild. Native builds retain the upstream
process-wide notification and propagation behavior.

These rules preserve the default policy: work without proven scope and lease
provenance stays outside the modal child.

## 6. JavaScript and browser boundaries

### 6.1 Owner gateway

`scripts/common/shims/asyncify-scheduler.js` wraps the audited stateful module
exports. The wrapper creates a gateway ticket, stores a copied JavaScript job
record, and returns the ticket Promise. It sends only the numeric job ID to
native code. A coalesced `mutator-submit` level signal enters the physical
native-entry arbiter. After physical admission, `_wxWasmEmbindSubmit()` puts a
small native record in the semantic execution-owner queue. This submission is
transport only. It does not call the stateful Embind wrapper.

An eligible native record runs later on a fresh dispatch context under its
semantic owner. Delivery then has this nested chain:

```text
owned native callback -> JavaScript deliverMutator() -> raw Embind Wasm wrapper
```

`deliverMutator()` records the raw wrapper result. If the wrapper calls
`runOnFiber`, `runOnFiber` retains the current owner, copies the body into its
FIFO, requests an affiliated owner callback, and returns. It does not start the
coroutine inside the nested chain. Control first returns through the raw Embind
wrapper and `deliverMutator()` to the owned native callback. A later affiliated
callback on a fresh dispatch stack starts the suspendable body. This second hop
keeps an Asyncify unwind out of the still-live Wasm-to-JavaScript-to-Wasm
delivery chain.

The raw Embind wrapper must return a non-thenable value from this delivery
chain. A raw Promise or another object with a `then` function means that a
suspension or an asynchronous body escaped the transport-only boundary. The
Promise is not a safe completion signal because the native owner callback is
still live and Asyncify can already be unwinding through it.

`deliverMutator()` attaches only a rejection sink to such a thenable. This
prevents an unrelated unhandled-rejection report. It then marks native
integrity unknown and fail-stops with `raw Embind mutator returned a thenable
during owner delivery`. It does not await, retry, or report the thenable as the
application result. A suspendable binding must use `runOnFiber`, which returns
from raw delivery before it starts the body on a later affiliated callback.

The gateway has these bounds:

- At most 10,000 live jobs.
- At most 16 MiB of retained argument data.
- Only primitive or serialized argument values.
- One submitted gateway job at a time.

The export inventory applies the same rule to browser-test hooks. All 30
exported `kicadCollabTest*` local-edit hooks and the six existing read hooks are
in `MUTATOR_NAMES`. They read or change the same document, selection, undo, and
view state as normal input. Only the narrow `kicadTest*` scheduler-collision
levers stay direct. These levers create controlled physical races for reducers;
they are not model transactions.

The public bindings no longer export raw `BOARD`, `FOOTPRINT`, or `PAD`
pointers. A JavaScript caller could keep such a pointer across an owner change
or native object destruction. The binding also no longer exports a generic
`kicadCollabFiberBusy` polling probe. Callers await the exact gateway Promise.
The ticket is the completion contract; a sampled busy flag is not.

The raw wrapper can make the ticket's `resultReady` state true while its
`nativeComplete` state is still false. The Promise settles only when both
states are true. Native code sets `nativeComplete` after the exact semantic
owner retires. Thus, a shallow Emscripten wrapper return is not completion when
`runOnFiber` or a native wait continues the transaction.

### 6.2 Native completion gate

`enqueueNativeCompletion(site, estimatedBytes, fn, onAbandon?)` is for a delayed result
which is now ready to make one short native touch. It reserves the complete
retained payload and puts one exact job in the physical native-entry FIFO. It
does not admit a semantic owner. It also does not start, hold, or serialize the
fetch or service request which produced the result.

After physical admission, `runNativeCompletion(site, fn)` performs these
actions:

1. It checks that the scheduler is live.
2. It checks that native integrity is known.
3. It runs the short native memory, MEMFS, or export operation.
4. If a WebAssembly trap occurs, it marks native integrity unknown.
5. It shuts down the JavaScript command surface before it rethrows the trap.

This order is important. A Promise `catch` block can report an error after a
trap. It cannot retry a native write into the damaged module.

Accepted completion callbacks run one native entry per fresh browser task.
This is physical serialization of the short native touches, not serialization
of network transfers and not permission to mutate the wx/KiCad model. A call
which can park or inspect mutable model state must use the owner gateway.

Queued completion closures have both a 4,096-job bound and a 64 MiB
conservative retained-byte bound. An exact completion cannot be silently
dropped because native code may already be waiting for it. Capacity failure is
therefore terminal. The discard path releases the exact reservation during
shutdown.

An exact entry can also have an optional `onAbandon` callback. This callback
has a narrow contract:

1. It is pure JavaScript.
2. It can reject a Promise or release a JavaScript payload.
3. It cannot use the delivery closure as cleanup.
4. It cannot call a WebAssembly export.
5. It cannot read or write MEMFS or HEAP.
6. It cannot finish a native proxy context.

Shutdown first marks the scheduler dead. It then detaches the complete
physical-entry FIFO, clears every coalescing key, and sets the queued completion
byte count to zero. Only after these actions does it call the optional
abandonment callbacks with a `WX_NATIVE_ENTRY_ABANDONED` error. Thus, a
callback sees a closed and empty scheduler. A queued exact job has one of two
JavaScript outcomes: its delivery closure is consumed, or its abandonment
callback runs. Shutdown never runs both.

`models-bridge.ts` uses this callback for Promise-backed model MEMFS applies
and reads. The callback rejects `runToolNativeEntry`. The rejection also runs
the existing `finally` block that removes the per-reference in-flight record.
A replacement runtime can therefore request that model again. It does not
inherit a Promise that can never settle.

Native wait and proxy producers do not install this callback. Their delivery
closures can contain output pointers, `emscripten_proxy_finish`, or an exact
native wake. These operations are unsafe after terminal native failure. The
scheduler drops those closures and records explicit native context
abandonment instead.

Global `error` and `unhandledrejection` listeners provide a final trap boundary.
Shutdown also removes generated Emscripten browser event listeners. Late custom
callbacks call `canTouchNative` before they touch native state.

### 6.3 DOM events

DOM input starts in `wxwidgets/build/wasm/wx-dom.js`,
`wxwidgets/build/wasm/wx.js`, or an Emscripten browser callback. The shallow
native ingress copies the event data, target scope, work class, and exact
active lease provenance. Native code then puts an execution envelope in the
central queue. If the lease closes before delivery, the dispatcher discards
that envelope. It does not reinterpret the event for a later modal which uses
the same window scope.

The JavaScript adapters take immutable snapshots at receipt time. A text event
keeps the exact input value which existed for that event. Mouse and window
events keep their coordinates and target identity. File drop reads into a
bounded owned batch, and title-bar operations retain their own copied command.
No deferred closure later reads mutable fields from the browser's reused event
object or from a changed DOM control.

One DOM adapter lifetime retains no more than 4,096 event snapshots and 16 MiB
of copied snapshot payload. The adapter charges both limits before it publishes
a token. Exact pop, discard, or shutdown releases the charge. A missing token,
duplicate pop, count overflow, or byte overflow uses the defined refusal or
terminal path. It cannot make one untracked native event.

Forwarded mouse events need wx screen coordinates, not coordinates relative to
the main canvas. This difference matters for a DOM control in a secondary
top-level window. The host can scroll or offset `#window-container` separately
from the canvas. Subtracting the canvas rectangle can then put the event outside
the native modal target and cause valid input to fail scope validation.

`wxWindowWasm::UpdateDomGeometryRecursive()` now publishes each DOM control's
native screen rectangle with its browser rectangle. `forwardedWxScreenPoint()`
measures the pointer offset inside the current browser border box and maps that
offset to the stored native screen box. It also accounts for axis-aligned CSS
scale. The adapter copies the resulting scalar coordinates into the immutable
receipt. Controls from an older or custom host use the canvas-relative fallback.
Rotated or skewed wx host trees are outside this port's geometry contract.

If receipt occurs during Asyncify unwind, rewind, or a fiber trampoline, the
adapter does not call the staging export. It transfers the immutable snapshot
to one exact physical native-entry job. The appropriate transition-completion
edge stages it later, once. This rule fixed the deterministic toolbar case in
which a second click arrived during rewind and previously shut down the
scheduler.

Each wx.js evaluation owns one file-drop lifetime object. The browser handler
captures that object and the exact `Module` before it starts any
`File.arrayBuffer()` request. A replacement evaluation can restart its numeric
batch tokens at one, but an old Promise reaction compares both captured
identities before it publishes or stages native ingress. Old cleanup closures
also capture the old map instead of resolving the global `var` binding at
cleanup time. Thus, an old token 1 cannot overwrite or release a new token 1.
File reads within each accepted batch, and reads from independent live batches,
remain concurrent.

The file-drop lifetime accepts no more than 64 pending batches, 4,096 files in
one batch, and 256 MiB across all pending batches. It reserves the declared
`File.size` values before it starts reads. Browser file reads cannot be
cancelled. The reservation therefore remains live until every
`File.arrayBuffer()` operation in the batch settles. One failed read cannot
release capacity while a sibling read is still live. `Promise.allSettled()`
provides this exact release edge.

The DOM adapter also has one browser-realm lifetime. It captures `ownerModule`
and publishes monotonic lifetime, control, menu, and event-snapshot IDs in that
realm. It does not restart these IDs when the same page evaluates a replacement
module. Replacement first removes the old listeners, destroys old controls and
popups, cancels old animation-frame callbacks, and marks old snapshots inert.
Every callback verifies the lifetime and exact module before native entry.

Context-menu waits use a related lifetime rule. The browser realm owns the map
of exact lease resolvers. Adapter replacement does not delete that map because
an old native lease can still require its completion. Destroying the invoker
requests close with result `-1`. Completion supplies the exact lease scope and
removes its one resolver. A refusal or ambiguous resolver makes the module
terminal.

The handler does not run model code directly on the browser callback stack.
The eligible envelope runs later on a dispatch context. Mouse forwarding,
popup completion, close, resize, and file-drop staging also use the native-
integrity gate.

### 6.4 Timers

A wx timer is classified when native code schedules the browser delay. The
mailbox record contains the callback, payload, work class, target scope,
discard function, coalescing class, and the exact active lease token when one
applies. JavaScript carries the lease ID, parent ID, and generation as six
32-bit words. It does not interpret them. The mailbox tick reconstructs the
native token. It does not recompute modal permission at expiry time.

- A window-owned timer can be ModalLifecycle work for that window's exact
  top-level scope.
- A timer with no valid modal scope is Ordinary work.
- A stale target scope causes the delivery to discard its payload.
- A timer bound to a closed or replaced lease is also stale, even when a new
  lease uses the same target scope.
- A periodic timer skips missed intervals. It does not replay a burst.

The JavaScript mailbox has a limit of 4,096 reservations. One timer takes its
reservation when `enqueueAfter()` accepts it. It keeps that reservation while
the timer is delayed and while its due record waits in the mailbox. Native
transport releases the reservation when it removes the record. Therefore, a
long delay cannot hide retained native payloads outside the bound.

The mailbox call has a void ownership-transfer ABI. It cannot return a native
payload after JavaScript accepts it. If the reservation limit is full, the
scheduler enters fail-stop instead of silently losing the callback. Shutdown
clears all tracked delayed timers, clears all due records, and resets the
reservation count.

There is no 17 ms retry loop. A blocked timer stays in the owner queue. An owner
release or lease transition arms the next tick.

A context-sleep timer is different. Native code reserves one wake token. The
JavaScript scheduler keeps one timer lease for the exact `(context ID, wake
token)` pair. It permits no more than 4,096 live context-sleep leases. A
context can own only one such lease at a time.

At expiry, the timer does not call the wake export directly. It transfers the
lease to one exact native-entry callback with the same context ID and token.
After the leaf probe accepts this callback, the callback removes the lease
before it calls `_pcbjam_context_sleep_wake(contextId, wakeToken)`. The wake
export uses `mark_ready_owned()` and accepts only the matching Cancellable
park. It then adds one coalesced `sched-pump` level signal. The next fresh task
resumes the ready context. The timer does not run model work under timer
authority.

If native code retires the context while it is Parked, `fiber_release()` calls
the lease cancellation function with the context ID and token. JavaScript
requires both values to match before it removes the lease from the map. It then
clears a timer which is not due, or removes the exact callback from the native-
entry FIFO by callback identity. A wrong token, a missing live lease, or an
unremovable callback causes refusal or fail-stop, unless terminal shutdown has
already cleared all leases. Native release keeps the context and stack when
revocation is not confirmed. Shutdown also clears all live context-sleep
timers and leases.

### 6.5 WebSocket events

WebSocket receipt is JavaScript work. Receipt can update a JavaScript Y.Doc or
a sync-client source record without entering native code. A receipt callback
does not wait for an older native projection before it can accept the next
message.

An editor projection is native stateful work. When no projection is pending,
the binding can retain one derived delta and submit it through the owner
gateway. If another Yjs transaction arrives before that apply completes, the
binding discards the derived payload and raises one projection level signal.
It then rebuilds the editor projection from the authoritative current Y.Doc.
Further receipts only update the Y.Doc and the same level signal. They do not
retain more closures, serialized item bodies, or native jobs. WebSocket receipt
therefore stays concurrent, while native projection stays ordered and bounded.

Library-sync WebSocket messages use a separate latest-pending drain for each
path and the source sequence in Section 10. The receive callback does not
write MEMFS or the KiCad heap. A remote message can arrive while an HTTP
mutation, a full sync, or a native editor projection is waiting. Only the
current source sequence can publish to the cache. A later native consumer
crosses the owner gateway when it applies completed library data to wx or
KiCad state.

For one opened library source, a cache reload uses one lane for `symbol` and
one lane for `footprint`. Each lane has no more than one active owner ticket and
one pending level. It does not create one owner job for each WebSocket frame. A
quiet period of 400 ms makes the pending level ready. A separate 2-second
maximum-latency timer starts with the first pending change and does not move
when more frames arrive. The lane keeps at most 64 exact changed names. More
names change the level to whole-kind dirty and clear the partial name list.
Owner-gateway backpressure uses one 1-second retry timer. A non-backpressure
error pauses the lane until a new source change arrives. A terminal owner error
has a different result. It retires every native reload lane for that exact
`Module`. Later WebSocket messages can still update the JavaScript cache, but
they cannot create more native reload tickets for the failed module. A
replacement `Module` has a new reload lifetime and can create new lanes.

This terminal latch prevents a retry storm. A terminal native failure is not a
source-local cache error. If each later WebSocket message re-created the lane,
one failure could create an unbounded sequence of rejected tickets and logs.
Only valid capacity backpressure has one bounded retry timer.

Realtime transport has its own bounds and lifecycle. Multiplexed library layers
share one raw WebSocket for each `(URL, token)` pair. Each library receives a
refcounted facade that adds its library tag. The last facade closes the raw
socket. A dedicated socket reconnects with jittered exponential backoff. The
base resets to 500 ms after an open. A close doubles the base before it arms the
next attempt, so the first retry is 1 second plus jitter. The base stops at
30 seconds, and each retry adds up to 30 percent jitter. `close()` cancels a
pending reconnect and closes the current socket. These rules do not delay HTTP
fetches or JavaScript receipt of frames from another live socket.

Sibling schematic collaboration has an additional MEMFS projection. Its
WebSocket callback first updates the sibling Y.Doc in JavaScript. After the
400 ms debounce, the binding materializes the current document text and puts
it in a per-path restage lane. The lane can hold these items:

- One submitted execution-owner ticket.
- One replaceable latest text value while that ticket is pending.

A newer text value increments the path version. The submitted ticket checks
that version immediately before native delivery. A superseded ticket rejects
with `WX_MUTATOR_STALE` and does not write its old text. The next ticket writes
the one latest value to MEMFS as Ordinary owner work. Thus, WebSocket receipt
stays concurrent, but the MEMFS write is owner-gated and bounded.

A terminal owner error retires the native restage plane for that handle. It
clears the native lane and its timers. The Yjs document, provider, and
WebSocket data plane can remain live. A replacement handle has a new terminal
state. Sheet switching uses the same separation. A terminal native switch
stops later native navigation tickets for that manager, but it does not require
the connected room data to stop.

Provider construction does not prove that a room has supplied its initial
state. `connectKicadDoc()` waits for that state for no more than 30 seconds by
default. The caller can supply an `AbortSignal`, and tests can supply a shorter
deadline. The same deadline starts before lazy provider import and construction.
Import work cannot be force-cancelled, so a provider which finishes after abort
or timeout is destroyed before it can publish. PartyKit and Hocuspocus remove
their exact sync listener on success,
abort, provider destruction, or timeout. BroadcastChannel clears its exact
settle timer on the same edges. A failed `connectKicadDoc()` destroys both the
provider and the unpublished Y.Doc. The boot lifetime owns the entry room,
every sheet-manager room, and every sibling-restage watch. A sibling watch has
its own child signal, so a peer leaving can cancel only that unfinished room
handshake without cancelling concurrent room connections.

The pre-connected entry room has an exclusive raw-session owner while the
editor opens the file. The owner destroys the provider and Y.Doc on boot
failure, open failure, or unmount. If the session finishes after unmount, the
closed owner destroys that late result immediately. A successful attach has
one explicit release: after that release, the binding or sheet manager is the
only owner. This rule prevents both leaked pre-open sockets and double destroy.
`attachKicadCollab()` accepts ownership at function entry, so a synchronous
binding refusal also destroys the provider and Y.Doc.

The lifecycle reducers cover failure before adoption, open failure after
adoption, unmount before a late connection, exact release to a binding, exact
release to a sheet manager, and a synchronous attach refusal. Each case counts
provider and Y.Doc destruction separately. It requires one destroy for every
abandoned object and no destroy by the raw owner after a successful handoff.

The provider deadline does not serialize sockets or fetches. Each room can
connect concurrently. The rule bounds only how long an unpublished room can
keep reconnecting and how long its caller can wait for authoritative state.

A sibling room also needs recovery after its first connection attempt fails.
One `Watch` record owns this recovery for each path. It permits one active
attempt and one delayed reconnect slot. The delays are 1, 2, 4, 8, and 16
seconds, and then 30 seconds for later failures. The watch keeps the absolute
`retryNotBefore` value when roster churn cancels a timer. Thus, repeated
presence updates cannot create parallel dials or bypass the rate limit.

Each attempt has its own generation and linked `AbortController`. Leave,
destroy, or replacement invalidates the generation before it aborts the
attempt. A provider constructor which ignores abort can finish later, but its
generation check destroys the late provider and Y.Doc. A successful
publication resets the failure count and delay. Presence-driven and eager
fallback watches use the same connection lane.

A hierarchical sheet switch retires more than the Yjs item binding. For a real
A-to-B switch, `switchTo()` first destroys A's binding and synchronously
publishes `onActiveChange(null)`. This stops A's presence, comments, follow,
drift, and project-path publication before B's room handshake or owner-gated
seed can wait. A same-sheet request does not publish this null transition.
Failure or timeout leaves the editor explicitly unbound until the existing
bounded retry succeeds. `SexprVersionError` is different: it describes an
incompatible document, not a transient connection failure. `switchTo()`
rejects that error and does not arm a retry timer. Therefore, initial startup
cannot report collaboration as connected when no sheet binding exists.

Remote presence and comment pins use host-owned latest-value projections.
Each sheet controller also carries its active-sheet generation into queued
native reads, starts, releases, viewport fits, comment jumps, and projections.
Destroy or replacement changes that generation. An accepted but not yet
admitted old ticket then fails its guard. Teardown clears enter the same host
projection as normal snapshots; they are not independent native calls.
Therefore, an old controller's late clear cannot wipe a newer sheet's remote
overlay or pins.

### 6.6 Network requests remain parallel

The owner system does not wrap `fetch`. A request can start and wait while
other requests are in flight. The system applies ownership only when completed
data will touch shared native state.

Examples:

- Project staging keeps `STAGE_CONCURRENCY = 8`.
- Symbol, footprint, and 3D-model requests can fetch at the same time.
- Source synchronization can transfer unrelated bodies at the same time.
- Durable Object operation lanes are per namespace. Unrelated libraries stay
  concurrent.

Project staging uses eight independent fetch workers and one explicit runtime
phase edge. Emscripten creates `FS`, and the scheduler script creates its
JavaScript object, before native instantiation finishes. Neither object's
existence proves that native admission is available. `boot.ts` initializes
`window.__pcbjamNativeRuntimeReady` to false. It changes the value to true only
as the final operation of `Module.onRuntimeInitialized`, after the existing
direct chrome seed. Emscripten calls `main()` after this hook returns.

A project body which completes before this explicit edge writes directly to
MEMFS. The lifetime predicate is checked synchronously first. JavaScript
run-to-completion guarantees that the short write finishes before the runtime
callback or `main()` can interleave. A body which reaches publication after the
edge must use `runOwnerJob`; it cannot infer readiness from `FS` or the
scheduler object.

For the late path, a worker copies the completed `Uint8Array` into an immutable
binary string. Two bytes are packed into each string code unit, so the
gateway's conservative string accounting matches the input byte count. The
copy is a primitive gateway argument. Therefore, the owner queue accounts for
its retained bytes, and later mutation of the fetch buffer cannot change the
publication. A staging lane submits one project publication ticket at a time.
This rule prevents eight individually valid files from exceeding the gateway's
aggregate payload limit. Each worker can retain no more than one completed
body while it waits for the lane, and it waits for the exact publication tail
before it fetches another file. Thus, requests start in parallel, while no more
than eight completed project bodies can wait for publication.

The project mount supplies the same lifecycle predicate to both phases. The
early path checks it immediately before the direct write. The owner gateway
checks it immediately before late admission. A body completed by an obsolete
mount cannot write into a new tool lifetime. Synthetic `.kicad_pro`
publication uses the same boundary.

The native boundaries have different behavior:

- A stateful model transaction which reads or changes shared wxWidgets or
  KiCad state uses the owner gateway. The semantic owner orders this
  transaction.
- A prepared operation on which one parked model waiter depends uses
  `runWaitCompletion()`. This edge applies the prepared MEMFS data, allocates
  the result, and resolves the exact wait token without entering a general
  queue. A general queue could place this dependency behind the waiter that it
  must wake.
- An audited short and non-suspending MEMFS, heap-copy, or control export can
  use `enqueueNativeCompletion`. The completed payload then waits in the
  bounded physical native-entry FIFO; the request which produced it did not.
  `runNativeCompletion` checks integrity and makes a trap terminal when the
  accepted short call runs. A worker-proxy 3D-model completion uses this path
  because it has no exact wait token. The call relies on JavaScript
  run-to-completion.

An operation that can park or inspect mutable model state cannot use the
completion gate as an ownership substitute. Neither boundary holds a network
transfer while that transfer waits.

`models-bridge.ts` separates model preparation from native publication. A
prepared model retains fetched bytes and a synchronous, generation-checked
`apply()` operation. Preparation uses the source, IndexedDB, and network only.
The main-thread 3D-model bridge consumes this object in its exact wait
completion edge. A worker proxy uses the native completion gate.

Open CASCADE export model prefetch is optional. It keeps six source requests in
flight. It has a 30-second deadline and one `AbortController`. Timeout aborts
selection and allows export without the optional models. A source request that
was already in flight can still settle, but its result is inert. The prefetch
does not create a late editor MEMFS or WebAssembly-heap operation.

### 6.7 Auxiliary-worker failure closes exact waits

The OCC and ngspice services run in separate workers. An editor-side load,
export, or simulator operation starts one Promise request. Native code then
parks in `wxWasmYieldUntil()`. Therefore, a worker fault must settle the exact
request. Logging the fault is not sufficient. An unsettled Promise would keep
the native context Parked forever.

`occ-service.ts` and `ngspice-service.ts` assign one monotonic generation to
each worker. Every pending request stores that generation. A worker `error` or
`messageerror` performs these actions:

1. It marks the worker generation failed.
2. It resolves every request from that generation. OCC uses
   `{ ok: false, report }`. ngspice uses `{ error }`.
3. It removes the failed worker from the current slot.
4. It terminates the worker.
5. It lets the next request create a new worker generation.

A boot error uses the same retirement path. This includes a JavaScript worker
error before the `ready` message. The error handler rejects the boot Promise.
Thus, the first request always completes. A `messageerror` is also fatal. It
means that the browser could not decode a worker message, which can be the
only response for a pending request.

The message handler accepts a response only when the worker is still current
and the pending request has the same generation. The ngspice event handler uses
the same check. Retirement removes queued events from that generation. Thus, a
late response or simulator event from an old worker cannot affect work which
belongs to its replacement.

Code adds a request to the pending map before it calls `postMessage()`. If
`postMessage()` throws synchronously, code removes that request and resolves it
with an error. Other requests can continue. This rule preserves concurrent
requests and prevents a pending-map leak.

A worker can also become silent without an `error` or `messageerror` event.
Each generation therefore has a boot watchdog, and each posted request has a
response watchdog. The production boot limit is 2 minutes. The production
response limit is 30 minutes. Tests can use shorter values. These limits are
last-resort failure bounds for slow devices. They are not normal scheduling
deadlines.

Expiry retires the complete generation. Retirement clears the boot listener,
all watchdog timers, queued ngspice events for that generation, the Worker,
and its Blob URL. It settles every request from that generation with an error.
The next request can start a new generation. Concurrent requests in one live
generation remain concurrent; the watchdog does not make a serial request
lane.

The ngspice event stream has bounds at each ownership transfer:

1. The worker makes one frame with no more than 512 lines and no more than
   1 MiB of UTF-8 JSON.
2. The worker retains no more than 64 unacknowledged frames and 8 MiB of
   unacknowledged UTF-8 data.
3. Each frame has one monotonic sequence and one exact byte count.
4. The main service accepts no more than 64 queued frames and 8 MiB before
   handler delivery.
5. The main service acknowledges the frame with the exact sequence and byte
   count after it transfers ownership.
6. One frame becomes one JavaScript native-completion job. Native code then
   copies it into one retained execution envelope.
7. The native byte lease uses the greater of the transport byte count and the
   conservative C++ vector and string capacity estimate.

One oversized line, worker-credit overflow, main-queue overflow, or mismatched
acknowledgment retires the exact worker generation. It cannot drop an exact
frame and continue. The native handler is also bound to one exact `Module`.
An old handler checks that identity and cannot enter a replacement module.

The deterministic unit tests cover a fault before readiness, a fault after
readiness, a boot failure reported by the worker, a message decode failure, a
synchronous post failure, silent boot expiry, silent response expiry, restart,
and a late old-worker response or event.

The KiCad Playwright harness uses the same worker-generation rules. Its OCC
provider has a test-only fault hook. The hook waits until two real requests are
in one generation and calls the exact `failDecode` transition which the real
Worker's `onmessageerror` handler uses. One request comes from the native STEP
export bridge. The other request calls the provider directly. The reducer
requires both requests to be pending at the same time. This proves that OCC
requests are not put behind a host-side serial queue. It then requires the
native `occ` wait to close with an error, all pending entries to be removed,
and the next native export to start generation 2 and return real STEP bytes.
The hook is installed only by `tests/kicad/utils/occ-service.ts`. It is not part
of the production provider.

### 6.8 Browser-start and graphics safeguards

The browser build seeds a minimal KiCad 10.0 configuration before `main()`.
The directory is:

```text
/home/kicad/.config/kicad/kicad/10.0
```

`kicad_common.json` suppresses unavailable first-run prompts and sets the 3D
model environment paths. `kicad.json` sets these Plugin and Content Manager
values:

```json
{
  "pcm": {
    "check_for_updates": false,
    "lib_auto_add": false,
    "lib_auto_remove": false
  }
}
```

The seed also writes the symbol, footprint, and design-block library tables.
The tables are empty when no library source is available. Each file uses
write-if-absent behavior. A same-session setting that already exists wins. The
seed prevents browser builds from starting unavailable package maintenance or
walking a library-table kind which the current editor did not load.

Graphics context loss uses the existing KiCad repaint recovery. The destructor
of `GAL_UPDATE_CONTEXT` calls `endUpdate()`. A destructor is implicitly
`noexcept` unless code states otherwise. An exception from `endUpdate()` would
therefore call `std::terminate` before the existing recovery catch could run.
The destructor is now `noexcept(false)`. This lets the exception reach
`EDA_DRAW_PANEL_GAL::DoRePaint()`, which can replace the failed GAL or use its
fallback. This change does not recover a failed scheduler or a WebAssembly
trap. Those failures still require module replacement.

Bitmap conversion has a separate browser lifetime rule.
`createImageBitmap()` is asynchronous. Two calls for the same wx bitmap can
finish in the opposite order from submission. The map record created by
`setBitmapData()` is now the exact conversion generation. A completion can
publish only when that same record still owns the bitmap ID and the bitmap has
not become a memory-DC target. A superseded or post-destruction completion
closes its `ImageBitmap`. Replacement, destruction, and transfer into a memory
DC also close an already published `ImageBitmap`. The rejection branch is
always installed; the retained `ImageData` remains the rendering fallback.
Scheduler shutdown calls the pure-JavaScript `wxDiscardBitmapResources`
hook. It closes every published browser bitmap and clears the generation map.
A conversion which resolves after that cleanup sees that its record is no
longer current and closes its result without touching native state.

The GL binding patch uses the same evaluation-lifetime rule. The generated
Emscripten `GL` object is not always ready when `wx.js` first runs, so startup
polls briefly until it can install the binding shim. The poll is one
self-contained closure. It captures the exact `Module`, initial `GL` object,
interval handle, and deadline handle. It stops after a successful patch, the
deadline, explicit shutdown, or replacement of either captured identity.
Its helper functions are local to that closure. A second evaluation therefore
cannot rebind the helper names used by the first evaluation. A late callback
or cleanup from module A can only clear A's timer handles; it cannot patch
module B's `GL` object or clear B's poll.

Scheduler shutdown also captures the exact `Module` before it defers browser-
resource cleanup to a microtask. The delay lets exact native discard callbacks
release their tokens first. If a replacement module appears during that delay,
the old scheduler still calls only the cleanup hooks captured from its own
module.

The old `showFileDialog()` JavaScript shim was not connected to any C++ or
JavaScript caller. It read each selected file in an unbounded independent
Promise, wrote MEMFS directly, and called a missing `OpenFileCallback` export.
The implementation removes that dead unsafe surface. The working wx file
dialog remains the generic owner-aware wx dialog. External file drops continue
to use their bounded immutable batch transport from Section 6.3.

`wxDoLaunchDefaultBrowser()` and `wxLaunchDefaultApplication()` previously
used `emscripten_async_run_in_main_runtime_thread()` for worker callers. That
callback re-entered Wasm and deleted its `wxString` heap payload without owner
admission. Worker callers now post a `CallAfter` record. The thread-safe pending
event registry classifies it as Ordinary work, and the main owner pump runs it
only after any live modal child releases. Independent browser navigation is
not made into a network or I/O serialization lane.

### 6.9 Latest-owner projection

An exact owner-gateway Promise answers one question: did this ticket finish?
It does not answer a different question: is this result still the value which
the shell wants? A replaceable UI control must keep those facts separate.

`latest-owner-projection.ts` supplies the generic mechanism. It has these
rules:

- It has no more than one running owner ticket.
- Any number of new requests become one pending level.
- It calls `snapshot()` only when it can submit a ticket. Therefore, the next
  ticket reads current JavaScript authority instead of replaying an old value.
- The submission gets a generation predicate. A stale ticket cannot publish
  after replacement or `stop()`.
- Valid owner-capacity backpressure keeps one fixed-rate timer. New input can
  replace the pending level, but it cannot bypass the timer or make another
  Promise chain.
- A stale-owner error is an expected cancellation.
- A terminal owner error permanently stops that projection object and cancels
  its timer. Later input cannot restart native work. A replacement object has a
  new lifetime.
- `stop()` increments the generation, clears the level, and cancels the timer.

These rules prevent a retry storm while external state can continue to change.
They are used for chrome visibility and other host-owned projections.

The editor-chrome toggle exposed this distinction. The old component cached
the last completed value. Consider this receipt order:

1. The native frame is shown, and the cache says shown.
2. The user requests hidden. The hide ticket enters the owner queue.
3. Before that ticket finishes, the user requests shown.
4. The cache still says shown, so the old code submits no show ticket.
5. The accepted hide ticket finishes and hides the frame.

This is an ABA error in the consumer. The owner gateway correctly preserved
the hide ticket. The component incorrectly treated its old cache value as the
current native value while that ticket was still able to change native state.

`chrome-visibility-owner.ts` now uses a latest-owner projection. It has these
rules:

- The native default is shown, so the first shown intent needs no ticket.
- The lane submits no more than one owner ticket at a time.
- A new intent replaces one pending desired boolean and changes its generation.
- The wrapped export checks that generation immediately before native
  admission. A queued obsolete ticket is stale and does not enter native code.
- A ticket which already entered native code can still finish. The lane then
  submits the latest pending intent. It never marks a newer intent complete
  from the older result.
- A `false` result means that the wx frame is not ready. The lane uses one
  300 ms retry wait for no more than 30 seconds. A new intent interrupts that
  wait. Owner-gateway backpressure also uses one bounded retry timer.
- Component teardown invalidates the generation and cancels the retry wait.
  It cannot undo a native call which already started, but it submits no later
  work from the retired component.

`chrome-visibility-owner.test.ts` deterministically accepts a hide ticket,
changes the latest intent to shown, and then completes the old hide. It requires
one corrective show ticket. A second case proves that `stop()` makes the
admission guard false. These tests exercise the Promise lifecycle without a
browser timing delay.

### 6.10 Bounded save persistence

The native save hook runs after KiCad writes the current file to MEMFS. The
browser can then persist those bytes to an API, a local file, or another host.
This persistence can wait. A second save of the same path can arrive before the
first host write finishes.

`save-flow.ts` uses one lane for each project-relative path. A lane has these
rules:

- The active snapshot is immutable. A later save cannot replace its bytes.
- The lane retains at most one pending snapshot. A later save replaces that
  pending snapshot.
- Only an acknowledged `committed` result can promote the pending snapshot.
- A `not-committed` result drops the active and pending snapshots. A later
  explicit native save can create a new lane.
- A `conflict` or `unknown` result drops both snapshots and installs an
  absorbing block for that path. The block remains until hook replacement.
- The status line uses one global generation. An older completion cannot clear
  or replace the status of a newer save notification.
- Different path lanes can call the host persistence function at the same
  time. The mechanism does not serialize all project files.

The hook retains at most 64 MiB of save snapshots and at most 256 active path
lanes. Capacity admission happens before the byte copy. A refused notification
reports a save failure and does not retain its payload. If it replaces an older
pending save, the hook removes that obsolete snapshot first. It does not write
an intermediate state after it reports that the newest state could not enter
the lane.

`save-flow.test.ts` sends 1,000 notifications for one path while the first host
write is parked. If the first write commits, exactly two host writes can start:
the immutable first state and the latest state. Separate cases require no
pending promotion after `not-committed`, `conflict`, or `unknown`. They also
check explicit retry after `not-committed`, absorbing path blocks, cross-path
concurrency, latest-only status, byte capacity, path capacity, and exact abort
on hook retirement.

The remote project source adds a revision compare-and-swap rule. It stores the
revision of the body that the editor actually loaded. It uses that loaded-body
base revision as the next write precondition. A project list, refresh, HTTP 409
response, or other metadata can update an observed revision only. It cannot
change the write base.

Only an acknowledged successful save with one consistent, strictly advancing
revision changes the base. A transport exception can occur after server
publication, so it has an `unknown` outcome. HTTP 409 has a `conflict` outcome.
Neither outcome rebases the editor model. The save hook then applies the
absorbing block described above.

The server first writes an immutable candidate body. It then conditionally
publishes the project-file row for the expected revision. The response includes
the authoritative revision header. Equivalent normalization can keep the
client-visible revision unchanged, but the conditional update also verifies
the source storage key. This storage-key guard prevents an old normalization
result from replacing a newer body with the same revision number.

## 7. `runOnFiber`

`runOnFiber` is the KiCad adapter for model work that requires a tool-style
fiber stack. It is in `wasm/bindings/collab_common.h`.

`runOnFiber` stores work in an owner-keyed fiber lane. Each exact semantic
owner has one FIFO and no more than one active `FiberSlot`. A parked ancestor
and its active modal child can therefore have separate physical fiber slots.
Semantic admission still permits only the exact active branch. Unrelated root
work cannot overlap. All lanes share one aggregate limit of 4,096 queued plus
active fiber jobs.

This owner-keyed design prevents a modal dependency cycle. A parent
`runOnFiber` body can park in `ShowModal()`. The modal child can then submit its
own `runOnFiber` body to close the dialog. One process-wide slot would put the
child behind the parked parent, while the parent could not resume until the
child ran. Separate lanes let the admitted child run without allowing another
root transaction.

Every `runOnFiber` call first copies its job into the lane FIFO and returns
through its current native entry. It does not start the body inline. If the
call has a current semantic owner, it retains that exact owner and queues the
later lane drain as affiliated work. A legacy direct caller has no owner to
retain. It starts with one unbound job lane. Its later drain enters as Ordinary
work on a fresh dispatch context and binds the lane to the owner that this
admission creates.

Four exported test-edit tails previously used a bare `CallAfter`: schematic
`MoveFirst`, schematic `MoveSchItem`, and the PCB and schematic
`ClearSelection` operations. They now use the owner-retaining `runOnFiber`
path. Their gateway Promise therefore covers the logical edit tail instead of
ending when the shallow export schedules a later callback.

This transport-only entry rule is required for an owner-gateway delivery. That
delivery already has an outer native callback below JavaScript and a raw Embind
wrapper above JavaScript. Starting a body inline can park while this nested
Wasm-to-JavaScript-to-Wasm chain is live. The later drain starts the body from a
fresh owner callback instead.

The next lifetime rule is that `COROUTINE::Call()` returning is not proof that
the body is complete. An Asyncify park can make `Call()` return before the
rewind reaches the body tail. Therefore, the active slot in that owner lane
keeps these objects on the heap:

- The coroutine.
- The callable and its captures.
- A weak target reference.
- The semantic owner token.
- The completion and failure state.

The weak target can cancel a queued job only before its body starts. After the
body starts, generic cancellation cannot release its callable or coroutine. A
caller that permits target destruction during a park must put its own weak
handle or generation check inside the body.

Cleanup depends on where the real body tail occurs:

- If the body reaches its tail before `COROUTINE::Call()` returns, the caller
  reaps the returned coroutine directly while the exact owner is still live.
- If `COROUTINE::Call()` returns shallow before the tail, the lane's active slot keeps
  the coroutine, callable, weak target, failure state, and retained owner. The
  later rewind tail queues affiliated cleanup for that exact owner. Cleanup on
  a dispatch stack then reaps the objects and releases the final owner
  reference.

The fiber entry catches exceptions and stores an `exception_ptr`. It does not
unwind an exception across the stack switch. Reaping records the failure on the
exact owner and reports the failure from the dispatch stack. If that owner has
a gateway ticket, native owner completion rejects the ticket. A legacy direct
owner can have no ticket. Allocation and pre-start failures use the same
owner-balance and failure rules.

The real body tail also performs the physical terminal handoff from Section
4.3. This handoff is different from a shallow Asyncify return. The body sets
its logical running state to false before `jumpOut()`. `jumpOut()` then uses
`finish_fcontext()` instead of a normal yield. The caller regains control only
after the source is Finished in libcontext and in the physical scheduler. The
caller can then release the coroutine context and its borrowed C stack. A
shallow return keeps the slot pinned; it does not mark the source Finished and
does not permit cleanup.

This design prevents three old errors:

1. A rewind cannot call a deleted stack-local callable.
2. An unrelated transaction cannot run only to clean up the parked fiber.
3. A caller cannot free a completed coroutine stack while its physical context
   is still Parked or Suspended.

## 8. Owned programmatic opens

Programmatic file opens can enter deep wx and KiCad code and can park. A direct
awaited Emscripten export is not a safe place to start this work.

The JavaScript wrapper now performs this sequence:

1. It creates an exact `open` wait token.
2. It calls a shallow `kicadOpenFileStart` or `kicadOpenFilesStart` export.
3. Native code puts an `OwnedOpenJob` in the ordinary execution queue.
4. A fresh dispatch context admits the job and runs the real open.
5. The exact wait resolves only after the native body returns at its true tail.

The public function returns a Promise. A refused start, lost exact token, or
native trap rejects or fail-stops. The open does not hold the browser callback
stack. A modal input dialog can still receive its exact leased input while the
open owner is parked.

The caller owns that exact Promise. An ordinary caller awaits it before it
uses the opened model. A reducer which intentionally starts later owner work
behind an in-flight open retains the Promise, installs a rejection handler at
once, and awaits it at the stated join barrier. This prevents an open failure
from becoming an unhandled rejection during the intentional wait.

## 9. Sleep behavior

Emscripten's mimalloc uses `sleep(0)` as a processor-yield hint inside allocator
code. This call must not suspend the main thread. A suspension inside malloc
can expose incomplete allocator state to another callback.

`wasm/shims/nanosleep_yield.c` now has these rules:

- A null request fails with `EFAULT`.
- A negative seconds value, a negative nanoseconds value, or a nanoseconds
  value of at least 1,000,000,000 fails with `EINVAL`.
- A zero-duration sleep is a no-op on all threads.
- A positive sleep on the main runtime thread yields.
- A positive sleep on a worker thread uses the worker blocking sleep.
- A positive main-thread sleep uses context sleep when the current frame owns
  the running context and no ordinary wake is already deferred for it.
  Otherwise, it uses the existing in-place yield fallback.
- A positive fraction of 1 ms rounds up to 1 ms. The function must not return
  before the requested duration.
- One browser timer uses no more than `INT_MAX` milliseconds. A larger or
  infinite duration repeats in `INT_MAX` chunks after each wake.

A zero-duration sleep does not create a timer, an Asyncify wake, or a native
entry. `nanosleep()` first validates the POSIX `timespec`; a valid zero request
then succeeds without a park. The direct `pcbjam_context_sleep_ms()` primitive
also refuses zero, negative, and NaN values. It returns 0 so its caller can use
the correct fallback policy.

The timer conversion uses `ceil()`. For example, one nanosecond becomes a 1 ms
timer, not a zero-delay task. A wait larger than the signed browser timer range
does not cast to a wrapped value. `nanosleep()` waits for one `INT_MAX` chunk,
subtracts that chunk from the remaining duration, and repeats. An infinite
request intentionally remains asleep through repeated maximum chunks.

For a positive context sleep, native code reserves a monotonic wake token. It
then acquires one JavaScript timer lease for the exact `(context ID, wake
token)` pair and parks with `ParkWake::Cancellable(token, cancel)`. The browser
timeout adds one exact native-entry job. The two-phase arbiter waits until no
other physical context or scheduler transition is active. It then consumes
the lease and calls `_pcbjam_context_sleep_wake(contextId, wakeToken)` one
time. That export accepts only the matching Cancellable park, marks the exact
context Ready, and adds one `sched-pump` level signal. A second fresh task runs
the scheduler pump.

If the scheduler releases the Parked context before expiry, release must first
cancel the timer lease with both identities. Cancellation clears the pending
timer or removes the exact queued wake. A wrong token or an unremovable lease
makes release fail-stop. The context and its C stack stay allocated in that
failure path. If an in-place `handleSleep` wake owns the stack instead, release
is also refused until that wake completes.

The first context-sleep implementation had a blanket pump-owned veto. It sent
positive sleeps on main-loop and dispatch contexts to the in-place fallback
because those contexts also use frame or dispatch-idle wakes. The explicit
ParkWake model removes this veto. When a context is Running, the pump wake
which made it Ready has already been consumed. The next frame or dispatch-idle
wake is not installed until the context parks for that reason. A positive
sleep can therefore install its Cancellable lease during the Running interval.
If an ordinary wake arrived early and is still pending, the sleep does not
install an exact lease and uses the fallback. This rule prevents two live wake
owners without excluding an entire context type.

This two-task sequence separates the readiness change from context resume. It
also prevents a frame callback, context-wait result, or sleep timer from
resuming a sibling context inside another context's live Asyncify wake.

The in-place `handleSleep` fallback has a different wake queue. If an Asyncify
transition is busy when an in-place wake arrives, the shim retains the exact
wake result in `readyWakes`. The same transition-completion edge drains that
queue in FIFO order. The physical native-entry FIFO and `readyWakes` solve two
parts of the same boundary problem:

- `readyWakes` controls the continuation of an in-place Asyncify capture.
- `nativeEntryQueue` controls a fresh call that can start, wake, or resume a
  physical scheduler context.

The mimalloc reducer enables a test-only counter in the nanosleep shim. The
counter must prove that the allocator made more than zero zero-duration sleep
calls. A self-rearming timer must still count zero event-loop turns during the
synchronous allocator storm. The reducer then queues a timer and makes one
positive sleep. The timer must run during that sleep. The reducer does not
require an exact number of event-loop turns during the positive sleep. The same
reducer checks that an invalid `timespec` returns `EINVAL`, one nanosecond maps
to 1 ms, and a value above `INT_MAX` maps to one `INT_MAX` chunk.

The scheduler-context reducer also releases a context during a cancellable
positive park. It requires one cancellation for the exact context ID and wake
token, no resume of the cancelled body, and immediate context retirement.
JavaScript reducers cancel a lease both before its timer is due and after its
exact wake is queued behind a busy native-entry head. A separate reducer
releases a fiber and checks that all raw-address generated-fiber guard records
are removed.

## 10. Source sequencing, rollout, and server durability

### 10.1 Sync-client source sequencing

One `SyncLayer` can receive the same path from a local HTTP mutation, a
WebSocket message, or a full HTTP sync. Network operations can overlap. A
per-path source sequence prevents an older completion from publishing after a
newer source has claimed that path.

The client uses these rules:

- Local changes for the same path use one explicit FIFO.
- Local changes for different paths can run at the same time.
- Remote changes keep only the latest pending message for one path.
- The remote-path map is bounded. Overflow requests an authoritative repair.
- A full sync has a barrier. It skips a path that a newer source claimed.
- A partial full sync requests a follow-up pass.
- A lifecycle generation makes work inert after `close()`.

The default local-mutation limits are:

| Limit | Value | Scope |
|---|---:|---|
| Active plus queued mutations | 64 | One path |
| Active plus queued mutations | 1,024 | One `SyncLayer` |
| Retained PUT body snapshots | 64 MiB | One `SyncLayer` |

Admission checks these limits before it copies or sends the body. A refusal
rejects with `SyncMutationQueueFullError` and one of these reasons:
`path-mutations`, `layer-mutations`, or `retained-body-bytes`. The refusal of
one path does not block a different path lane.

Realtime processing keeps no more than 256 distinct remote-path drains. Each
drain runs one body operation and keeps only the latest replacement for that
path. If a new distinct path exceeds the limit, the client does not retain its
message. It requests one authoritative repair. Repair requests coalesce, use
an initial delay of 100 ms, and use a maximum retry delay of 30 seconds.

Each local HTTP mutation has an opaque mutation ID. The server copies this ID
to its WebSocket broadcast. The client matches an active mutation or a bounded
completed-mutation record. A mutation ID match is not enough. The client also
compares receipt identity: operation, version, and, for a put, hash and size.
This prevents a replayed or colliding ID from making a different commit look
like the client's own echo.

The WebSocket echo can arrive before the HTTP response. It can also be the only
durable-success evidence when the HTTP response is lost. In that uncertain
case, the client does not publish its local bytes under an unverified hash. It
requests an authoritative sync. A mismatched HTTP receipt and WebSocket echo
also force an authoritative sync. Completed mutation records are bounded to
4,096 IDs.

Body and manifest changes use one atomic `LayerStore.apply()` operation. The
IndexedDB implementation uses one transaction for both stores. A shared lane
orders commits to the same database in one JavaScript realm. The commit lane is
short. It does not contain network I/O. A path-list merge preserves unrelated
manifest entries when two layer lifetimes used different snapshots.

`SyncStack` also sequences merged notifications. It snapshots top-wins path
presence when the layer change occurs. It then delivers notifications in
source order without waiting for an asynchronous body read.

Close is an active lifecycle edge. `SyncLayer.close()` increments its lifecycle
generation and aborts all HTTP requests that belong to the layer. It cancels
the repair timer, clears remote drains and sparse reads, rejects queued local
mutations, closes its realtime channel, and releases its IndexedDB store
reference. An active job can finish its local cleanup, but every publication
path checks the generation before it changes current state.

`LibsSource.dispose()` closes every opened `SyncStack` and releases its socket
facades. It does not delete the IndexedDB cache. A source can be disposed while
a stack-open Promise is pending. The source increments its open generation;
the late stack closes itself instead of installing a subscription in the next
lifetime. The scope source uses a second source generation for late library
lists, batched stack descriptors, pre-sync workers, and realtime promotion.

Bulk library pre-sync uses up to eight workers by default. These workers can
fetch different library stacks in parallel. Bulk mode opens a realtime channel
immediately only for a layer that has a multiplex key. Under the current
per-library single-writer descriptors, the remaining live layers stay
HTTP-only. After the document is open, `enableRealtime()` promotes only the
libraries whose nicknames the document references. A promoted dedicated layer
gets its own socket. A multiplex-capable layer shares one raw socket per
`(URL, token)`. Thus, cache prefetch remains parallel without keeping
approximately 150 idle dedicated WebSockets for one board session.

### 10.2 Collaborative editor projection

Yjs transactions are atomic in JavaScript. Their editor projection is
asynchronous because the owner gateway can wait.

The binding records a remote version before it requests a projection. When no
projection is pending or running, it may retain one transaction-derived delta.
The drain applies that delta only when its version is the next projected
version.

If another transaction arrives while the delta waits or runs, the binding does
not append another Promise closure. It removes the retained delta and raises
one projection level signal. The drain snapshots the editor and re-applies the
current Y.Doc authority. All transactions which arrived before that snapshot
are covered by the same repair. A transaction which arrives during the native
repair raises the same signal and causes one more pass. The immediate repair
loop is bounded.

The drain classifies an owner-gateway failure before it selects recovery:

- A valid `WX_MUTATOR_BACKPRESSURE` error can retry with one exponential timer.
  The retained payload must fit the empty queue. Oversized work is not
  retryable backpressure.
- `WX_MUTATOR_STALE` stops projection for the retired resource.
- Scheduler shutdown, native abandonment, owner-gateway loss, and terminal
  Wasm errors stop projection for that Module lifetime.
- Any other error requests authoritative reconciliation. Eight consecutive
  failures open the projection circuit. The circuit has no timer. A later Yjs
  transaction closes it and requests a full current-Y.Doc projection, so it
  includes changes that arrived before the circuit opened.

One retry timer is the maximum. The delay starts at 100 ms and is capped at
5 seconds. A successful drain resets the delay and unknown-failure count.

The generic reconciler and the KiCad item binding use the same mechanism. A
deterministic reducer parks the first native apply and sends 1,000 more Yjs
transactions. The final editor state must equal the Y.Doc, and the number of
native applies must stay at three or fewer. This proves that WebSocket rate
does not create a closure or full-reconciliation storm.

Destroying the binding increments its generation. Queued projections then
become inert. Resource-affine gateway calls also check their generation
immediately before native delivery.

The collaboration-aware undo path can find a stale UUID after a remote
change. That condition is a normal collaboration conflict, not a modal error.
The PCB and schematic editors report it with `wxLogStatus`. They do not open a
warning dialog and create a new nested wait during conflict recovery.

### 10.3 Durable Object dirty-marker protocol

Each namespace has two Durable Object keys:

```text
manifest[:lib]           = plain SyncManifest
manifest-state:v2[:lib]  = clean version certificate OR dirty baseline
```

This is the rollback-safe publication format. The legacy key never changes
type. An older server can read and write the plain manifest. After a later
return to the new server, a clean certificate whose version differs from that
plain manifest causes reconciliation. Thus, an old-server write cannot remain
silently certified by an unrelated newer state record.

The body objects in R2 are the durable source of truth. The plain manifest is
the versioned index. Its legacy key never contains a wrapper. An older server
can therefore read it after a rollback. The separate state key is either a
clean certificate for the exact manifest version or a dirty marker with the
last clean baseline.

A PUT or DELETE uses this order:

1. The per-namespace operation lane loads the current manifest.
2. Durable Object storage writes a dirty v2 marker with the current baseline.
3. The operation changes R2.
4. The operation builds the next manifest and increments its version.
5. One atomic multi-key write publishes the next plain manifest and its clean
   v2 certificate.
6. The core updates its memory cache.
7. The room broadcasts the committed change.

If step 2 fails, the operation does not touch R2. If R2 succeeds and step 5
fails, the durable dirty record remains. The next load without cached state lists R2 and
repairs the index. The core clears its in-memory cache after a failed mutation.

A load with a clean stored certificate does not list R2. A missing state key means that the plain
manifest came from an older build, so the new build verifies it once. A state
certificate whose version differs from the plain manifest also forces a
verification; this detects a write made after a rollback to an older server.
A missing, legacy, mismatched, or dirty state causes reconciliation when body
listing is available. Reconciliation consumes one new manifest version for
each changed path. It atomically writes the plain manifest and clean
certificate before it broadcasts repair changes. A dirty marker which cannot
list the body store fails closed.

The loader also migrates the short-lived earlier `{ manifest, dirty }` value.
It first publishes a plain rollback-readable manifest and a separate state
marker, then performs any required R2 reconciliation.

Body reads bind each requested path to the expected manifest hash. The core
checks the committed manifest around the body read. A stable hash mismatch
marks the record dirty and fails closed. A bundle also fails closed when a
body is absent or has the wrong storage fingerprint.

The server operation lane is per namespace. A slow write for one library does
not serialize a write for another library.

The default server limits are:

| Limit | Value | Scope |
|---|---:|---|
| Active plus queued operations | 256 | One namespace |
| Retained mutation body bytes | 64 MiB | One namespace |
| Upload stream duration | 2 minutes | One active namespace upload |
| Paths in one body-snapshot request | 4,096 | One HTTP request |
| Live namespace cores | 512 | One multiplexed room |

The operation count includes the active operation. A deferred HTTP PUT enters
the lane before it reads the request body. A queued PUT therefore retains its
body-reader function, not a materialized `ArrayBuffer`. It reads and accounts
the bytes only when it becomes active. Thus, mutations for one namespace are
serial through request-body materialization, R2 change, manifest publication,
and broadcast. A different namespace uses a different lane and can run at the
same time.

The upload deadline starts only when the PUT reaches the lane head and opens
its stream. Queue wait time does not consume the deadline. The server forwards
the request stream through a byte-counting transform to streaming storage. It
does not first make a second full `ArrayBuffer`. The transform stops at the
64 MiB body limit. A two-minute deadline cancels a stalled active upload so it
cannot own the namespace lane for the life of the Durable Object.

One `POST /bodies` request can name no more than 4,096 paths or path-and-hash
entries. This limit bounds validation, manifest lookup, and the parallel body
reads. A multiplexed room creates a core only after route recognition and
authorization. It retains no more than 512 library namespace cores.

The room uses WebSocket hibernation. An idle connected room can leave memory
and later rebuild its cores from Durable Object storage. No source sequence or
uncommitted mutation depends on an in-memory core surviving hibernation. The
512-core limit therefore applies to one live room instance; durable manifests
and body data remain in their stores.

If the operation count or retained-byte budget is full, the room returns HTTP
429 with `Retry-After: 1`. If one body is larger than the namespace byte
limit, or one body-snapshot request has too many paths, it returns HTTP 413. A
timed-out active upload returns HTTP 408 with `Retry-After: 1`. These responses
occur before the refused operation changes R2 or the manifest. A refusal also
cancels an unopened request body so it does not retain transport backpressure.

### 10.4 Coherent body reads without a long lock

The namespace operation lane orders manifest mutations. It does not stay held
while R2 returns body bytes.

`getBodies()` uses this sequence:

1. Read one committed manifest snapshot.
2. Keep only requests whose path and hash match that snapshot.
3. Fetch the bodies in parallel outside the namespace lane.
4. Read the committed manifest again.
5. Return only bodies whose storage fingerprint and final manifest hash still
   match the requested hash.
6. If a body is missing or has a wrong fingerprint while the manifest entry is
   stable, mark the manifest dirty and fail closed.

`getBundle()` uses the same idea for a full snapshot. It reads a manifest,
fetches all bodies in parallel, and reads the manifest again. If the manifest
moved, it retries from the new snapshot. The retry count is three. A repeated
change fails the request instead of returning a mixed manifest/body bundle.

This design lets a write finish while a large uncached bundle reads R2. It does not
make fetch requests serial. The read proves coherence after the parallel I/O.

### 10.5 Rolling protocol compatibility

The body-batch request changed from path-only records to path-and-hash records.
The rolling protocol supports both directions:

- A new client sends both `entries` and the legacy `paths` list. A new server
  uses `entries`. An old server ignores that field and uses `paths`.
- A new server accepts an old path-only request. It binds each path to the hash
  in one current manifest snapshot before it calls the safe body reader.

The mutation ID header is optional. An old client sends no ID. A new server
still commits the write. An old server does not echo the ID, so the new client
uses normal authoritative repair when it cannot correlate the response and
broadcast exactly.

### 10.6 One writer during room-shape rollout

The scope-wide multiplexed room and the historical per-library room can map to
the same R2 body prefix. Their Durable Object manifest records are independent.
If both rooms can write, each can commit a manifest without observing or
broadcasting the other room's write. A shared R2 prefix does not make two DO
indexes one transaction system.

This release therefore keeps the historical room
`mirror:<scope>:<library>` as the only writer. Generated layer descriptors use
that room. The dormant scope-wide room `mirror:<scope>` can still serve reads,
but its `PUT` and `DELETE` requests return HTTP 409 with
`x-pcbjam-sync-action: reload`.

The multiplexed room can become writable only in a coordinated cutover that
moves all writers and manifest authority together. This restriction affects
only writes to one shared R2 namespace. It does not serialize different
libraries, WebSocket receipt, or fetch transfer.

## 11. Code tour

Read the files in this order. The named functions are useful entry points.

### 11.1 Physical scheduler and fiber control

1. `scripts/common/shims/asyncify-scheduler.js`
   - Start with `runNativeIngressReceipt()`. It allocates the receipt sequence,
     freezes the current lease snapshot, and preserves FIFO order across inline
     and delayed adapters.
   - Follow the native-entry drain and transition-completion hooks. They retain
     an exact head without polling or replay.
   - Read `scheduleContextSleep()` and `cancelContextSleep()` for exact timer
     leases.
   - Read `runWaitCompletion()` before `enqueueNativeCompletion()`. The first
     function completes an exact waiter dependency in one edge. The second
     function puts an independent short native operation in the physical FIFO.
   - Read `deliverMutator()`, `completeMutator()`, and `shutdown()`. These show
     the raw-thenable fail-stop, the two-part gateway completion rule, and the
     terminal native-integrity boundary.
2. `wxwidgets/include/wx/wasm/private/sched_context.h`
   - Read `publish_ready_id()`, `create()`, `yield_park()`,
     `mark_ready_owned()`, `fiber_start()`, `fiber_transfer()`, and
     `drain_all()`. They show fail-atomic Ready publication, exact wake
     ownership, Ready claims, the 4,096-transition batch, and the 64-batch
     livelock limit.
   - Read `fail_next_ready_fifo_allocation_for_test()` and the adopted-root
     bounds checks. These show the deterministic allocation failure and the
     valid half-open main-stack range whose lower address can be zero.
   - Then read `note_inplace_park()` and
     `any_context_has_inplace_park()`. They extend physical entry exclusion
     from the transition edge to the complete lifetime of a live in-place
     capture.
3. `kicad/thirdparty/libcontext/libcontext.cpp` and `libcontext.h`
   - Start with `context_owning_current_stack()` and
     `make_dispatch_root_proxy()`. They create one non-owning protocol identity
     for each scheduler-owned dispatch root.
   - Then read `jump_fcontext()`, saved-slot reference handling, and context
     release. These paths separate a normal yield from a terminal handoff and
     prevent a proxy from releasing a scheduler stack.
   - Read the direct `fiber_swap()` source proof and `finish_fcontext()` last.
     The terminal direct path aborts when exact physical validation fails.
4. `kicad/include/tool/coroutine.h`
   - Compare `KiYield()` with `jumpOut()`. `jumpOut()` is the no-return path
     after a coroutine body finishes.

### 11.2 Semantic owner and browser ingress

5. `wxwidgets/include/wx/wasm/private/execution_owner.h`
   - Read `OwnerToken`, `LeaseToken`, `ScopeToken`, `ExecutionEnvelope`,
     `BrowserIngressReceipt`, and `PendingEventDelegate` first.
   - The lower declarations define the public Wasm-private boundary for owner
     retention, handler association, delegated events, and queue admission.
   - Read `RetainedByteBudget`, `BeginClose()`, `LeaseReady()`, and
     `CloseLease()`. They show the independent 64 MiB native payload lease and
     the difference between ancestor close request and top-only completion.
6. `wxwidgets/src/wasm/evtloop.cpp`
   - Follow browser receipt reconstruction, native envelope insertion, and
     `wxWasmEarliestUnstagedBrowserIngressReceiptJs()`. This is the native
     ingress frontier.
   - For pre-modal pending events, read
     `wxWasmExecutionTagPendingEvent()`,
     `wxWasmBindPendingEventsToLease()`,
     `wxWasmExecutionHasProcessablePendingEvents()`, and
     `wxWasmExecutionMayProcessPendingEvent()` in that order. They show the
     narrow next-modal marker, fail-atomic lease binding, and the shared
     `CanRunNestedIngress()` policy before park, during child execution, and
     after `BeginClose()`.
   - Then follow owner admission, lease close, dispatch-context allocation,
     scheduler-drain continuation, and `DoYieldFor()`. These paths join
     physical scheduling to semantic policy.
   - Read `wxWasmDetachMainLoop()` and the initial kick handshake. Detached
     state is published only after JavaScript accepts the progress edge.
   - Follow `wxWasmExecutionQueueOrdinaryRetained()` through callback and
     discard. It keeps the byte lease after the record leaves the queue vector.
7. `wxwidgets/src/common/event.cpp`, `wxwidgets/src/wasm/timer.cpp`, and
   `wxwidgets/src/wasm/tooltip.cpp`
   - `event.cpp` publishes pending-event provenance and removes handler
     associations at destruction.
   - `timer.cpp` captures the exact owner window, scope, and lease when a timer
     arms.
   - `tooltip.cpp` binds each arm to the hovered window, checks the exact hover
     and tooltip ancestor, and clears raw pointers at destruction.
8. `wxwidgets/src/wasm/domevents.cpp`, `wxwidgets/src/wasm/window.cpp`,
   `wxwidgets/build/wasm/wx-dom.js`, and `wxwidgets/build/wasm/wx.js`
   - These files copy DOM values, mouse data, title-bar operations, resizes, and
     completed drops into typed ingress records.
   - In `wx-dom.js`, read `captureDomEventSnapshot()`,
     `forwardedWxScreenPoint()`, and `wxForwardMouse()`. They preserve receipt-
     time values and map a secondary control's browser point to its native wx
     screen rectangle.
   - Then read the browser-realm record, `discardDomBrowserLifetime()`,
     `wxShowContextMenu()`, and the realm-owned popup resolver map. These paths
     bind callbacks to one exact module and retain old context-menu completion
     across adapter replacement.
   - `wx.js` contains staged title-bar move, close, resize, popup, and file-drop
     paths. Read the count and byte reservation before `Promise.allSettled()`.
     The asynchronous file reads can overlap; only completed native staging
     uses the arbiter.

### 11.3 Narrow modal application hooks

9. `kicad/common/dialog_shim.cpp`
   - `RegisterUnitBinder()` associates a non-window binder with one dialog
     family. `UnregisterUnitBinder()` removes the association.
10. `kicad/include/api/api_plugin_manager.h`,
    `kicad/pcbnew/dialogs/panel_pcbnew_action_plugins.cpp`, and
    `wasm/stubs/api_plugin_stub.cpp`
    - The Preferences panel supplies its initiating window to the Wasm-only
      reload overload. On Wasm, the panel binds the completion event locally.
      The stub captures one `PendingEventDelegate` and queues that event to the
      initiating panel. It does not associate the global plugin manager with
      the dialog or run the parked frame's process-wide listeners.
11. `wxwidgets/src/wasm/dialog.cpp`
    - The modal-open path creates the lease, creates `wxWindowDisabler`, and
      schedules the exact first-frame paint. The paint callback can touch only
      the still-shown dialog. The callback overload runs only after exact
      modal cleanup.
    - Read `wxwidgets/src/wasm/nonownedwnd.cpp` with the `wx-inert` handling in
      `wx.js`. It copies native enabled state into the browser input barrier.
    - Then read `wxwidgets/src/wasm/app.cpp` and
      `wxwidgets/src/wasm/toplevel.cpp`. The mouse-button and title-bar-resize
      tails use `PaintCurrentExecutionScope()`: root execution can sweep all
      top-level windows, while a modal child can paint only its exact lease
      scope.

### 11.4 Stateful application boundaries

12. `wasm/bindings/collab_common.h`, `wasm/bindings/eeschema_embind.cpp`, and
    `wasm/bindings/pcbnew_embind.cpp`
    - Follow `FiberLane` and `runOnFiber`. Each exact owner has one FIFO and one
      active slot. The adapter retains the current owner and requests a later
      affiliated callback. It does not start the suspendable body inside raw
      Embind delivery.
    - The editor bindings show weak-target cancellation and owner-retaining
      local-edit tails.
13. `wasm/bindings/owned_open.h` and `wasm/bindings/open_gate.h`
    - These files make programmatic opens Promise-based and settle only at the
      exact native tail.
14. `wasm/shims/context_sleep.cpp` and `wasm/shims/nanosleep_yield.c`
    - Read the exact `(context ID, wake token)` park first. Then read POSIX
      validation, the zero no-op, `ceil()` for sub-millisecond waits, and the
      `INT_MAX` chunk loop.
15. `web/standalone/src/wasm/boot.ts` and `wasm/shims/in_memory_config_pre.js`
    - `boot.ts` seeds the normal KiCad 10.0 MEMFS configuration before `main()`.
      The second file is a separate headless storage fallback; it is not the
      normal application seed.
16. `kicad/include/gal/graphics_abstraction_layer.h` and
    `kicad/common/draw_panel_gal.cpp`
    - The first file lets an `endUpdate()` exception escape the RAII
      destructor. The second file contains the existing `DoRePaint()` recovery
      which replaces or falls back from the failed GAL.
    - For adjacent browser completion boundaries, read
      `wxwidgets/build/wasm/wx.js` around `setBitmapData()` and
      `wxwidgets/src/wasm/utils.cpp`. The first uses record identity as a
      resource generation and closes stale `ImageBitmap` results. The second
      routes worker-origin browser launches through owner-aware `CallAfter`
      instead of a raw main-runtime proxy callback.

### 11.5 Collaboration, libraries, and network lifecycle

17. `web/standalone/src/wasm/latest-owner-projection.ts` and `owner-job.ts`
    - Read `request()`, `drain()`, terminal stop, and `stop()`. These paths show
      one running ticket, one pending level, one fixed-rate capacity retry, and
      exact failure classification.
18. `web/standalone/src/wasm/collab/kicad-binding.ts`,
    `reconciler.ts`, `provider.ts`, `doc-session-owner.ts`,
    `sheet-manager.ts`, and `sibling-restage.ts`
    - These files implement one retained delta, one payload-free repair level,
     one active plus one latest sibling MEMFS value, finite cancellable room
     synchronization, and synchronous active-sheet retirement.
    - `doc-session-owner.ts` owns a provider and Y.Doc between provider sync and
     the one binding handoff. `sheet-manager.ts` reports terminal document
     version errors without retry. `sibling-restage.ts` owns one generation-
     bound, abortable connection attempt and one bounded reconnect slot for
     each path.
    - `presence-kicad.ts`, `comments.ts`, and `follow-user.ts` carry exact
      controller generations into native tickets. `WasmTool.tsx` owns the
      latest remote-overlay and comment-pin projections across sheet changes.
19. `web/standalone/src/wasm/libs/source.ts`, `synced-source.ts`, and
    `models-bridge.ts`
    - Read `LibsSource.dispose()`, `ensure()`, `scheduleEditorReload()`, and
      `enableRealtime()`. They show open generations, bounded reload levels,
      late-open self-close, parallel pre-sync, and deferred realtime for only
      referenced libraries.
    - In `models-bridge.ts`, compare `prepareModelInMemfs()`,
      `runToolNativeEntry()`, and `collectBoardModelFiles()`. Preparation is
      source-only. Exact main-thread waits apply in `runWaitCompletion()`. A
      worker proxy uses the native completion FIFO. OCC collection has no
      editor-native publication.
20. `web/standalone/src/wasm/occ-service.ts`, `ngspice-service.ts`,
    `ngspice-worker.js`, and `wasm/stubs/sharedspice_client.cpp`
    - Read `ensureWorker()`, `retireWorker()`, and the pending-request maps.
      They show exact worker generations, fail-all-pending behavior, restart
      after a worker, decode, or boot fault, and rejection of late messages and
      events from a retired generation.
    - Then read the boot and response watchdogs. A silent worker retires after a
     finite bound. Retirement clears every timer and Blob URL and settles each
     request from that generation.
    - In `ngspice-worker.js`, read batch construction, frame credit, and exact
      acknowledgment. In `ngspice-service.ts`, read the second 64-frame and
      8 MiB bound. In `sharedspice_client.cpp`, read the JavaScript completion
      and retained native execution-envelope transfer.
    - `tests/kicad/utils/occ-service.ts` and
      `tests/kicad/utils/ngspice-service.ts` use the same lifecycle rules in
      the Playwright application harness. `tests/kicad/occ-export.spec.ts`
      faults two concurrent OCC requests, observes native failure completion,
      and proves that a new worker generation can complete a real STEP export.
21. `web/pcbjam-shared/sync-client/src/layer.ts`, `stack.ts`, `store.ts`, and
    `transport.ts`
    - `layer.ts` contains path source sequences, local queue limits, remote
      latest-value drains, HTTP abort, repair backoff, and `close()`.
    - `store.ts` performs atomic body-and-manifest commits. `stack.ts` orders
      merged notifications. `transport.ts` contains refcounted socket
      multiplexing and bounded reconnect backoff.
22. `packages/sync-server/src/core.ts` and `room.ts` in the outer repository
    - `core.ts` contains the namespace mutation lane, streamed upload limit and
      deadline, dirty-marker protocol, and coherent parallel body reads.
    - `room.ts` maps limit failures to HTTP status, bounds body snapshots and
      multiplexed cores, and cancels refused request streams.
23. `apps/server/src/sync-room.ts`, `apps/server/src/sync-room-cutover.ts`, and
    `packages/core/src/services/libs/sync-serve.ts` in the outer repository
    - These files enforce the per-library single writer while the scope-wide
      room remains read-only.
    - For project saves, read `web/standalone/src/lib/project-source.ts` in the
      core repository. Then read `apps/server/src/routes/files.ts` and
      `packages/core/src/services/projects.ts` in the outer repository. These
      files keep the loaded-body base revision, publish immutable candidate
      bodies with a conditional row update, return the revision header, and
      apply the equivalent-normalization storage-key guard.

The three KiCad request bridges are:

- `kicad/eeschema/sch_io/pcbjam_lib/sch_io_pcbjam_lib.cpp`
- `kicad/pcbnew/pcb_io/pcbjam_fp/pcb_io_pcbjam_fp.cpp`
- `kicad/3d-viewer/3d_cache/pcbjam_model_fetch.cpp`

Each bridge starts and waits for its request outside native serialization. A
short, audited, non-suspending final touch can use the native completion gate.
A stateful model transaction uses the owner gateway. An exact waiter dependency
uses `runWaitCompletion()`. None of these boundaries holds a fetch while the
fetch is in flight.

### 11.6 Focused reducers and real-application tests

24. `tests/apps/standalone/sched-context/sched_context_test.cpp` and
    `tests/asyncify/sched-context.spec.ts`
    - These cover exact parks, terminal transfers, transactional creation, and
      a finite drain that crosses the 4,096-transition budget.
25. `tests/apps/standalone/pending-event-owner/` and
    `tests/e2e/pending-event-owner.spec.ts`
    - These cover owner filtering, null handling, allocation rollback, exact
      event deletion, the exact pre-modal `CallAfter()` handoff, the negative
      same-scope sidecar case, the pre-park `InitDialog()` yield, and the
      post-`BeginClose()` no-admission rule.
26. `tests/apps/standalone/coroutine-nested/nested_test.cpp` and
    `tests/e2e/coroutine-nested.spec.ts`
    - These inspect the per-physical-root proxy protocol and its bound of 16.
27. `tests/apps/standalone/mimalloc-storm/mimalloc_storm_test.cpp` and
    `tests/e2e/mimalloc-storm.spec.ts`
    - These inspect allocator `sleep(0)`, positive yielding, invalid
      `timespec` values, sub-millisecond rounding, and maximum timer chunks.
28. `web/standalone/src/wasm/scheduler-shim.test.ts`
    - This file covers ingress FIFO, immutable lease snapshots, raw thenable
      fail-stop, exact wake cancellation, bounds, and terminal shutdown.
29. `tests/e2e/dom-port-bugs.spec.ts`,
    `tests/kicad/action-plugin-reload-modal.spec.ts`,
    `tests/kicad/wasm-config-seed.spec.ts`, and
    `tests/kicad/gal-update-context-recovery.spec.ts`
    - These tests exercise tooltip lifetime and modal delivery, forwarded
      pointer coordinates, the action-plugin delegate, the 10.0 seed, and GAL
      recovery in browser applications.
30. `web/pcbjam-shared/sync-client/test/sequencing.test.ts`,
    `transport.test.ts`, `packages/sync-server/test/core.test.ts`, and
    `packages/sync-server/test/room.test.ts`, plus `room-mux.test.ts`
    - These cover source order, close behavior, socket sharing, queue limits,
      streaming upload limits, and namespace concurrency.
31. `web/standalone/src/wasm/collab/provider.test.ts`,
    `index-lifecycle.test.ts`, `sheet-manager.test.ts`,
    `sibling-restage.test.ts`, `presence-kicad.test.ts`, `comments.test.ts`,
    and `follow-user.test.ts`
    - These cover synchronous provider notification, throwing subscriptions,
      abort and timeout cleanup, deferred-seed retirement, exact watch abort,
      the synchronous A-to-null-to-B sheet transition, and stale queued canvas
      work after controller replacement.
32. `tests/tools/gal-build-contract.ts`,
    `scripts/build-gal-webgl-test.sh`, and `tests/e2e/gal-webgl.spec.ts`
    - These checks require the standalone GAL application to use the same
      Binaryen finalize, Asyncify post-link, and scheduler injection stages as
      the other Wasm applications. They also check `mainWindow`, overlay
      geometry after the factory call, and the rendered WebGL result.
33. `web/standalone/src/wasm/wx-dom-lifetime.test.ts` and
    `wx-browser-lifetime.test.ts`
    - These source files define 8 and 7 unit cases. They cover same-realm
      replacement, non-reused IDs, listener and control cleanup, popup
      resolvers, animation callbacks, event-snapshot accounting, and file-drop
      accounting. Definition counts do not claim an observed pass.
34. `web/standalone/src/wasm/latest-owner-projection.test.ts`,
    `owner-job.test.ts`, `libs/synced-source.test.ts`,
    `collab/sheet-manager.test.ts`, and `collab/sibling-restage.test.ts`
    - These files cover latest-only projection, centralized failure classes,
      terminal module retirement, live JavaScript data planes after native
      retirement, and bounded capacity retry. The latest-owner source defines
      4 unit cases. The synced-source source defines 20 unit cases.
35. `web/standalone/src/wasm/libs/models-bridge.test.ts`,
    `occ-service.test.ts`, `ngspice-service.test.ts`,
    `tests/tools/ngspice-worker-batch-unit.ts`, and
    `tests/tools/ngspice-completion-contract.ts`
    - The model bridge source defines 19 unit cases. The OCC and ngspice
      service sources define 7 and 11 unit cases. The tool reducers check the
      512-line and 1 MiB worker batch, exact 64-frame and 8 MiB credit,
      mismatched acknowledgment, exact module handler, JavaScript completion,
      and native retained-byte transfer. These are definition counts, not
      final-source results.
36. `web/standalone/src/wasm/save-flow.test.ts`,
    `web/standalone/src/lib/project-source.test.ts`,
    `packages/core/src/services/project-file-cas.test.ts`,
    `apps/tests/specs/api/project-file-cas.spec.ts`, and
    `apps/tests/specs/smoke/editor-save-cas.spec.ts`
    - The save-flow source defines 17 unit cases. The combined files cover
      commit-only promotion, absorbing save blocks, loaded-body revisions,
      client and server compare-and-swap, equivalent normalization, API
      conflict, and real-editor save races. The final closed-stack result is
      pending.

This list identifies the intended checks. Section 12 records validation state;
the existence of a reducer is not a final pass result.

## 12. Deterministic reducers and validation

### 12.1 Reducers

The scheduler-context reducer publishes 43 unique deterministic scenario
names. `tests/asyncify/sched-context.spec.ts` defines four Playwright tests:

1. Initial main-loop progress acknowledgment.
2. Static use of the complete physical-entry predicate for scoped DOM work.
3. The 43-scenario invariant battery.
4. Context and memory bounds.

The scenario battery covers these cases:

- Context creation, park, ready, resume, finish, and bounded memory.
- One transition in flight.
- Exact wait delivery.
- Root and child reference balance.
- Parent blocking while a child is active.
- Child-zero blocking while the lease remains open.
- Parent re-enable only after exact lease close.
- Popup scope policy.
- An L1 timer cannot use capability from an L2 lease after the same target
  scope reopens.
- Startup admission.
- `execution_ancestor_close_lifo`: an exact ancestor can request close while a
  child lease remains active, but readiness and removal stay last-in-first-out.
- Queue high-water, coalescing, rejection, and one total 4,096-envelope limit
  which includes affiliated continuations.
- `execution_retained_byte_lease`: native retained payload keeps its lease
  through callback return or discard. Count and byte overflow use the terminal
  path.
- The terminal submit-discard handshake detaches retained ownership before
  cleanup and calls the available discard function one time.
- Direct-lane terminal completion in `fiber_terminal_direct`.
- Star-lane terminal completion in `fiber_terminal_star`.
- Immediate release of a Finished source after the terminal handoff.
- Zero swaps into a non-enterable fiber.
- Zero releases of a fiber that the registry records as Running.
- `execution_owner_positive_sleep_nested_pump`: a parked root resumes from its
  exact positive-sleep token, consumes one same-owner mouse-up in `wxYield()`,
  and leaves an earlier Ordinary service job queued until root retirement. The
  same reducer checks exact modal-child lease and scope provenance.
- `fiber_admission_refusals`: a caller cannot start a stale in-place capture
  or transfer from a source which does not own the running stack.
- `fiber_ready_claim_is_not_transferable`: a direct transfer cannot merge with
  a Ready target's existing FIFO claim or replace its published value.
- `ready_publication_is_transactional`: deterministic FIFO allocation failure
  leaves creation, wake, transfer, and terminal-transfer state unchanged.
- `dispatch_context_release_before_erase` and
  `dispatch_context_release_refusal_retains_id`: a Finished dispatch context
  is removed from its owner vector only after registry release succeeds. A
  stale or refused ID remains visible.
- `fiber_release_inplace_park_refused_until_wake`: a cancellation request
  during a real delayed fiber sleep is refused without mutation; the delayed
  wake resumes the preserved body, ends the exact park, and only the later real
  suspension can be released.
- `generated_scoped_dom_defers_for_direct_inplace_park`: generated scoped DOM
  work remains deferred for the complete direct-lane in-place park.
- `fiber_release_cancels_owned_park`: a Parked context revokes its exact
  Cancellable wake before release. The cancellation function runs one time for
  the exact context ID and wake token, and the cancelled body does not resume.
- `fiber_release_external_park_refused`: an uncancellable External wake keeps
  its target alive until the callback consumes the wake.
- `retained_exact_negative_result_is_data`: a stale token cannot consume a
  RetainedExact park, and a result with bit 31 set remains data because
  `ParkResult.accepted` is separate.
- `owned_wake_token_and_cancel_refusal`: failed cancellation leaves the context
  unchanged; only the matching Cancellable token can wake it.
- `pending_wake_does_not_consume_exact_lease`: a deferred ordinary wake cannot
  satisfy a new exact park. The exact park refuses, and the next External park
  receives the deferred value.
- `fiber_release_clears_generated_guard`: retirement removes the raw fiber
  address from all generated suspension and park guard records.
- `finished_release_retires_handle`: a replacement context gets a different
  token, and a jump through the retired Finished token is refused.
- `suspended_cancel_retires_handle`: cancelling a suspended context releases
  it, a replacement gets a different token, and the stale token cannot re-enter
  the cancelled body.
- `fiber_roundtrip` also checks adopted-root ownership. The adopted browser
  stack must use its exact captured half-open range, including a valid lower
  address of zero.

The Asyncify-races reducer uses production owner admission. Browser transports
can arrive at the same time. Their native bodies do not enter through raw
concurrent `ccall` parks.

The `modal_child_yield_skips_ineligible_pending` case queues a parent event,
opens a modal child, and calls `wxYield()` from that child. The child must
return without consuming the parent event or spinning. After the lease closes,
the root yield must consume the parent event.

The pending-event owner browser reducer also invalidates both the parked parent
frame and the active dialog. Its modal child calls
`PaintCurrentExecutionScope()`. The dialog paint count must increase, the
parent paint count must stay unchanged, and the parent invalidation must remain
pending. After `ShowModal()` returns and the lease closes, the same helper must
paint the parent and clear that invalidation. The reducer logs the three paint
deltas so the Playwright assertion checks the native behavior, not only the
final PASS marker.

The same reducer covers the exact pre-modal pending-event handoff. It queues a
real `dialog->CallAfter()` and a `CallAfter()` on a non-window sidecar which is
associated with the same dialog scope. Lease creation must transfer only the
real dialog event. An `InitDialog()` `wxYield()` must run neither event while
the parent stack is still active. After the parent parks, the real dialog
callback must run exactly once under a child whose parent and exact lease scope
match the opener. The sidecar must remain blocked until the root resumes and
drains it. A second check queues scoped work before close, calls `BeginClose()`,
and proves that a nested `wxYield()` neither consumes the work nor traverses
the ineligible physical list. The stable root drains that work after close.

The scheduler-context reducer supplies the nested-modal policy check without a
browser. It opens L2 from the L1 child and proves that the L1 child cannot use
L2 provenance during the pre-park interval. Only L2's own admitted child can
pass `CanRunNestedIngress()`. After L2 closes, the exact L1 child becomes
eligible for its own L1 pending work again.

The exact owner-safe scenarios include these cases:

- `queued_suspensions_preserve_fifo` queues two suspendable ordinary bodies
  while the current owner is parked. Body A and then body B run only after the
  current owner reaches its tail. This name replaces the old
  `out_of_order_sleep_resolution` name.
- `affiliated_close_unblocks_ordinary` queues an ordinary body and an exact
  affiliated modal close. The close can pass the blocked ordinary body. The
  ordinary body starts only after the modal opener returns. This name replaces
  the old `wakeup_during_transition` name.
- `long_parked_sleep_clobbered_by_swap` keeps two browser timeout transports
  concurrent. Each stateful swap body enters later as Ordinary owner work.
- `retained_child_delays_modal_close` proves that the exact retained child tail
  must finish before the lease closes.

The trace for `affiliated_close_unblocks_ordinary` must have this exact order:

```text
child-handler
b-transport
close-transport
affiliated-close
modal-return
b-start
b-end
```

The JavaScript physical native-entry reducer has four core ordering cases:

1. The leaf probe reports busy. The reducer adds two `main-loop` level
   signals. It requires one retained FIFO job, one coalesced signal, zero job
   calls, and one probe. It then advances fake time by 10,000 ms and requires
   that the probe count stays at one. The fake probe also calls the wrapped
   `maybeStopUnwind()` in its export-finally path. This models an instrumented
   Wasm export and proves that the probe cannot signal itself. The reducer
   then creates a real Unwinding-to-Normal edge. The edge must cause one new
   probe and one job call.
2. The reducer adds three exact jobs with values 0, 1, and 2. Each fake browser
   task can deliver only one job. The final order must be 0, 1, 2.
3. An accepted job increments a call count and models a new Asyncify unwind.
   The arbiter queue must already be empty. After the reducer returns Asyncify
   to Normal and signals transition completion, the call count must still be
   one. This check proves the consume-before-call and no-replay law.
4. An accepted `main-loop` callback adds a new `main-loop` level signal. The
   new signal must remain in the FIFO and run in the next task. This check
   proves that the arbiter removes the old coalescing key before callback code
   can signal the next level.

The same reducer has five receipt-boundary checks:

1. A DOM receipt can enter inline while a semantic context is parked but the
   physical Asyncify boundary is free.
2. A receipt during Asyncify unwind is copied and retained. It runs one time
   after unwind completion.
3. A receipt during Asyncify rewind is copied and retained. It runs one time
   after rewind completion.
4. A receipt while the Emscripten fiber trampoline is active is copied and
   retained. It runs one time after trampoline completion.
5. The real wrapped `maybeStopUnwind()` edge re-arms a retained receipt. The
   test does not call a private drain shortcut for this case.

The JavaScript scheduler unit test creates 50 real wrapped `handleSleep`
wakes. It forces the Asyncify state to transition-busy. It then resolves all
50 wake functions. The scheduler must record 50 deferred wakes and no drained
wakes at that point. The first drain task observes the busy state and retains
the head. Advancing fake time by 10,000 ms must not cause a second attempt. A
real Unwinding-to-Normal edge then restarts the drain. It must deliver values
0 through 49 in strict FIFO order and report 50 drained wakes and an empty
wake queue. This test forces the deferred-wake branch and proves that this
older wake queue also has no retry timer.

The Asyncify browser integration test also checks the scheduler at quiescence.
It requires an empty wake queue, equal deferred and drained counts, and no
unauthorized writes to `Asyncify.currData`.

The mailbox-ordering reducer observes the first raw
`kicadCollabApplyItems` return. It requires this exact intermediate ticket
state:

```text
returned=true, resultReady=true, nativeComplete=false
```

The reducer then awaits both gateway tickets. Apply A must create one segment,
and apply B must move that same segment to its final position. This assertion
proves that both bodies ran in FIFO order and that a raw result did not settle
its ticket before retained-owner completion.

The same browser file has a `runOnFiber` park reducer. The first body parks,
and its gateway ticket must stay pending. The second body cannot start during
that park. The first body reaches its real tail, affiliated cleanup retires its
owner, and only then can the second body run.

The mimalloc reducer covers zero-duration and positive sleep behavior.
Test-only shim counters report all zero-duration calls and the main-runtime-
thread subset. The main-thread count must be above zero, so worker-only
contention cannot produce a false pass. The allocator storm must cause zero
event-loop turns. A later positive sleep must let a queued timer run. The test
does not require exactly one event-loop turn during that positive sleep.

The JavaScript scheduler tests cover physical entry readiness, transition-time
immutable receipt, level coalescing, exact entry FIFO order, no replay,
mailbox FIFO delivery, one owner job in flight, backpressure, exact open
tokens, trap containment, rejected native wakes, shutdown, cancellation of
delayed mailbox timers, cancellation of context sleeps before and after timer
expiry, terminal rejection of a wrong sleep token, bounded nonwrapping
generic-wait tokens, raw generated-fiber guard cleanup, late completion, the
forced deferred-wake case, and the fact that network requests are not wrapped.

The browser reducers also cover these application-visible cases:

- The modal must paint its first frame after `Show(true)` and before the body
  can depend on a later general event pump. The test then drags the same real
  modal by its DOM title bar.
- Twelve alternating toolbar clicks must survive real Asyncify transition
  windows. Every immutable receipt runs one time, in order. The scheduler must
  remain live.
- A parked owner receives two text-input events in one browser task. The two
  queued envelopes must preserve their receipt-time values.
- Drag-and-drop keeps exact file batches and rejects an oversized batch before
  native entry.
- The file-drop module-lifetime reducer starts a slow read in module A,
  evaluates module B with the same restarted numeric token, and then shuts
  down A. A's cleanup and late read must leave B's batch and native stage
  untouched.
- The wx bitmap reducer resolves two `createImageBitmap()` Promises in reverse
  order. It requires the latest pixels to remain current, stale and destroyed
  results to close, and conversion rejection to be observed. Its static
  boundary assertion also prevents worker browser-launch code from restoring
  direct `emscripten_async_run_in_main_runtime_thread()` entry.
- The GL-poll module-lifetime reducer evaluates module A and module B with
  separate fake timer registries and `GL` objects. It invokes A's late
  callbacks and cleanup after B exists. Those actions must neither patch B's
  object nor clear B's timers. Final cleanup must leave no timer from either
  evaluation live.
- A treebook can start empty, receive grouped pages later, lay out those pages,
  and switch their projections without a fixed sleep in the test.

The scheduler inventory reducer also requires all 30 exported
`kicadCollabTest*` local-edit hooks to appear in `MUTATOR_NAMES`. It requires
the narrow `kicadTestArmTimerPark` and `kicadTestFiberParkStart` collision
levers to stay outside that list. The six state-reading `kicadCollabTest*`
hooks remain covered by the gateway-delivery reducer.

The sync-client tests cover local and remote source races, self-echo handling,
exact mutation-receipt comparison, lost HTTP responses, full-sync barriers,
atomic cache publication, close generations, reconnect repair, rolling body-
request compatibility, bounded per-path and per-layer mutation admission,
bounded remote-path repair, and unrelated-path concurrency. The sync-server
tests cover bounded per-namespace admission, HTTP 429 and 413 mapping,
dirty-marker failure, R2 PUT and DELETE recovery, clean-load listing
avoidance, rollback-version mismatch repair, fail-closed reads, coherent
bundles with body I/O outside the namespace lane, repair ordering, mutation-ID
transport, and unrelated-library concurrency. The outer cutover reducers
cover the per-library single-writer rule and HTTP 409 for disabled scope-wide
writes.

The collaboration projection reducers cover both binding implementations.
Each parks one native apply, delivers 1,000 newer Yjs transactions, and
requires final authoritative state with no more than three native apply
attempts. Separate cases prove that valid capacity backpressure advances after
one timer, a terminal owner failure starts no timer, and a permanent unknown
error makes only eight attempts before it waits for a new Yjs transaction.

The save-flow reducer parks one host write and sends 1,000 same-path save
notifications. After an acknowledged first commit, it permits only the first
and latest snapshots to persist. A `not-committed` result drops the captured
successor and permits a later explicit save. A conflict or unknown result drops
the successor and installs an absorbing path block. The reducer also checks
unrelated-path parallelism, latest-only status, exact retirement abort, and the
global byte and path bounds.

The exact-open static audit covers every `kicadOpenFile()` and
`kicadOpenFiles()` test consumer. Ordinary consumers await the exact Promise.
The few reducers which need an open to remain in flight retain and observe it
before they enqueue the colliding work, then await it at their explicit join
barrier.

The sibling-restage reducer parks the first execution-owner ticket and
delivers 1,000 newer Yjs updates for one path. The owner gateway must still
contain only that submitted ticket. The restage lane must retain only the
latest text. After owner release, the obsolete ticket does not write and one
next ticket writes `body-999`. The maximum number of submitted tickets in
flight is one.

The same test group makes the first sibling-room connection fail without a
later presence change. It requires one reconnect timer, bounded backoff, and a
successful later publication. Additional cases prove that repeated presence
notices do not create parallel attempts, leave cancels the timer, destroy
aborts the active attempt, and a late abort-insensitive completion destroys
its own provider and Y.Doc.

The OCC and ngspice unit reducers use short watchdog values. A silent boot and
a silent response must retire the exact generation, settle all concurrent
requests, clear its timers and Blob URL, and permit a later request to create a
new generation. These cases are separate from `error`, `messageerror`, and
synchronous `postMessage()` failure.

### 12.2 Ten implementation stages

This table groups the delivered work into ten stages. These names describe the
current implementation. They are not verbatim phase names from an older plan.

| Stage | State | Result |
|---|---|---|
| 1. Baseline and isolated worktrees | COMPLETE | The outer repository and each changed submodule use a separate worktree branch. Section 13 lists the paths and branches. Existing user work stayed outside this implementation worktree. |
| 2. Physical Asyncify entry arbiter | COMPLETE IN SOURCE | One bounded FIFO admits starts, wakes, and resumes from fresh browser tasks. It uses a leaf probe, transition-completion edges, exact jobs, level coalescing, consume-before-call, and terminal fail-stop. It now also excludes the complete lifetime of an in-place park. |
| 3. Semantic execution owner and queues | COMPLETE IN SOURCE | Root owners, child owners, leases, classes, scopes, queue bounds, and exact retirement order replace the old scalar dispatch interlock. Stateful native work uses this boundary. Network transfer does not. |
| 4. Exact suspension and modal provenance | COMPLETE IN SOURCE | Context IDs, wake tokens, wait tokens, ingress receipts, scope generations, pending-event delegates, and consume-once next-modal capabilities identify the exact work. Modal code cannot use capability from a later lease for the same pointer value. |
| 5. `runOnFiber`, nested ingress, and open ownership | COMPLETE IN SOURCE | `runOnFiber` retains the exact owner to the real body tail. Nested pumps admit only same-owner work from a bounded snapshot. Programmatic opens return exact Promises, and every audited consumer observes them. |
| 6. `sleep(0)` and timer ownership | COMPLETE IN SOURCE | Zero-duration sleep is a true no-op. Positive sleep rounds up, uses exact cancellable timer leases, and splits values above `INT_MAX`. Timer expiry uses the physical native-entry arbiter. |
| 7. Concurrent network ingress and bounded native apply | COMPLETE IN SOURCE | Fetches, sockets, and worker requests can overlap. Only completed native touches enter the short completion gate or the semantic owner. Source sequences, bounded lanes, dirty recovery, and exact mutation receipts prevent stale publication. |
| 8. WebSocket, session, and worker lifecycle ownership | COMPLETE IN SOURCE | Realtime channels, source generations, provider waits, raw document sessions, sheet generations, sibling reconnects, and OCC/ngspice worker generations have exact teardown. Silent workers have finite watchdogs. |
| 9. Reducers, bounds, fail-stop, and coverage | COMPLETE IN SOURCE; DEFINITIVE RERUN PENDING | Deterministic reducers cover physical and semantic order, modal provenance, lifecycle, queue limits, sleeps, workers, source races, and build contracts. CI coverage rejects a declaration-level all-fixme specification. Focused observations are in Section 12.4. The final broad non-browser rerun belongs to Stage 10. |
| 10. Source-freeze build, complete browser matrix, and real-application exploration | ACTIVE; NOT COMPLETE | Focused runs found and corrected additional source and test-harness defects, including the InfoBar click oracle. Source still changed after those runs. The definitive all-target build, broad unit and static rerun, all browser projects, real WebSocket stack, stress lanes, and extended real-application exploration are pending. |

Stages 1 through 9 describe implemented mechanisms. They do not claim that
Stage 10 passed. A later source change must restart the applicable Stage 10
build or test gate.

### 12.3 Defects found and corrected during implementation

| Defect | Cause | Correction |
|---|---|---|
| Pre-modal `CallAfter()` starvation | A real dialog callback could enter the wx pending list before the dialog opened its lease. The parent then parked. The event had no valid child provenance, and the rule against using a later lease correctly kept it blocked. | `CallAfter()` can now mark one exact `wxEVT_ASYNC_METHOD_CALL` for the next modal of the same real window family. Lease open transfers this consume-once capability transactionally. Only the admitted child can run it. A same-scope non-window sidecar cannot use it. |
| Native entry during a live in-place park | The readiness probe checked `current()` and the transition flag. Both values can be clear after unwind while a physical context still owns a live `handleSleep` capture. | The physical registry now exposes `any_context_has_inplace_park()`. The leaf probe stays closed until the exact park-end edge. The browser reducer proves that an independent queued entry waits, runs once after wake, and cannot be forced through by a direct poke. |
| Pre-connected document-session leak | A provider and Y.Doc could connect before editor open, then survive an open failure, unmount, late completion, or failed handoff. Ownership was spread across Promise branches. | `doc-session-owner.ts` gives the raw pair one exclusive owner. It has one adopt edge, one release edge, and one destroy edge. `WasmTool` destroys the pair on every pre-handoff failure and on a late result after unmount. |
| Synchronous attach leak | `attachKicadCollab()` could throw while it created the binding, before the normal returned handle owned teardown. | Ownership now transfers at function entry. A synchronous awareness, bridge, version, or bind failure destroys both the provider and Y.Doc. |
| Terminal document version skew retried forever | `sheet-manager.switchTo()` treated `SexprVersionError` as a transient room failure. It could arm repeated retries and let startup appear connected without a valid binding. | The switch reports `SexprVersionError` to its caller and starts no retry timer. The private queue remains usable for a later explicit navigation, but the failed startup destroys its manager and cannot report success. |
| Silent OCC or ngspice worker stranded a native wait | Error events closed exact requests, but a worker could remain alive and never send `ready` or a response. The editor-side Promise and native parked frame then had no completion edge. | Each generation has a 2-minute boot watchdog. Each request has a 30-minute response watchdog. Expiry retires the generation, settles all requests, clears listeners, timers, queued events, and Blob URLs, and lets the next request create a fresh generation. |
| Sibling room did not recover from an initial connection failure | The sibling restage watch connected when presence first announced a path, but the first failed provider or sync attempt had no later edge if presence did not change again. | Each path now owns one connection attempt and one reconnect slot. Backoff is 1, 2, 4, 8, 16, and then 30 seconds. Attempt generations and abort controllers make late results inert. Leave and destroy cancel the slot. Success resets it. |
| GAL standalone did not use the production Wasm pipeline | The GAL harness omitted the complete Binaryen finalize, Asyncify post-link, and scheduler injection path. Its HTML also lacked `mainWindow`, and the factory could overwrite the requested overlay position. | The build script now uses the production post-link stages. The HTML defines `mainWindow`. It reapplies overlay geometry after factory creation. A deterministic build contract and 30 focused browser checks cover the result. |
| Worker decode fault reducers did not always fault the real lifecycle | The old synthetic fault could bypass the central generation retirement path. A passing test could then prove only its local fake. | The test providers now inject `failDecode` through the same central worker transition used by `messageerror`. Focused OCC and ngspice tests require all concurrent requests to settle and the replacement generation to work. |
| Action-plugin reducer used an invalid browser oracle | The test tried to infer a native toolbar rebuild from DOM state which did not represent that native operation. | A small Wasm-only PCB frame rebuild counter is registered for the reducer. The test now observes the native operation which the modal completion must cause. Production scheduling still uses the exact pending-event delegate. |
| One global `FiberSlot` blocked an admitted modal child | A parent fiber body parked in `ShowModal()`. The admitted child queued the fiber body which had to close that modal. One process-wide slot put the child behind the parent, while the parent required the child to run. | `runOnFiber` now has one lane for each exact semantic owner. The descendant modal child can use its own active slot while the ancestor lane is parked. The semantic owner still prevents unrelated roots from overlapping. |
| Terminal native errors caused a retry storm | Library reload, sheet switch, sibling restage, and generic latest-value consumers could treat a terminal owner failure as a local source error. Later external input could create more tickets for the same failed module or binding. | Central owner-error classification now separates backpressure, stale work, terminal failure, and unknown failure. Terminal failure latches one exact native lifetime. JavaScript data receipt can continue, but later events cannot restart its native projection. |
| The count-only native execution queue could retain excessive service data | The queue limited records to 4,096, but one record could retain a large copied worker batch. Thousands of such records could exceed practical memory before the count limit. | Native execution envelopes now use an independent 64 MiB retained-byte budget. Exact payloads charge before publication and release only after callback return or discard. Capacity refusal is terminal. |
| Ready-state mutation could occur before FIFO publication | A wake or transfer could consume ownership or change endpoints and then fail to allocate its Ready FIFO claim. No retry could reconstruct the old state. | `publish_ready_id()` is fallible and precedes each state mutation. Deterministic allocation failure leaves the context, wake, value, and endpoints unchanged. |
| Main-loop detach could publish without progress | Native code could expose detached state before JavaScript accepted the first scheduler job. A rejected kick left a detached context with no progress edge. | `wxWasmDetachMainLoop()` uses a submission handshake. It publishes detached state only after acceptance. Rejection removes and releases the temporary context. |
| `STACK_FIRST` root adoption rejected a valid zero address | Main-stack validation used address zero as an absent-stack marker. A valid `[0, 65536)` range therefore failed adoption. | The registry captures the original bounds before the first switch and validates a non-zero size. Adoption requires an exact bounds match and a local address in `[stackEnd, stackBase)`. |
| An ancestor `ScheduleExit()` could be refused or close out of order | `BeginClose()` originally assumed that the target was the top lease. A child dialog can be active when a KiCad modal player requests its own exit. | `BeginClose()` can idempotently mark one exact ancestor. `LeaseReady()` and `CloseLease()` remain top-only. `DismissModal()` uses `Exit()` for the current loop and `ScheduleExit()` for an active ancestor. |
| `ShowModal(callback)` could run before complete lease cleanup | The callback overload could be treated as an `EndModal()` hook. Reopening the dialog from the callback could occur under the first lease's incomplete state. | The callback now runs only after blocking `ShowModal()` returns, the exact lease closes, focus is restored, and the dialog state is reusable. |
| Wasm modal state did not enforce both input barriers | A lease controlled native admission, but other top-level windows were not fully disabled in normal wx state and in the DOM. Browser input could still target the parent. | `ShowModal()` creates `wxWindowDisabler`. `wxNonOwnedWindow::DoEnable()` copies enabled state to `wx-inert` and `HTMLElement.inert`. |
| Exact 3D-model apply could wait behind its own waiter | A prepared model apply was put in a general physical or Ordinary-owner queue. The parked requester kept readiness closed until that apply resolved its token. | Main-thread model completion now uses `runWaitCompletion()`. It applies MEMFS, allocates the result, and resolves the exact token in one immediate edge. Worker proxies, which have no exact token, use the native completion gate. |
| OCC prefetch timeout left a late editor-native operation | Optional export prefetch materialized or reread data through editor MEMFS. A timeout could finish export while that late native work remained queued. | Model collection now uses source, IndexedDB, and network only. A 30-second abort stops selection. Already-started results are inert and cannot create an editor-native completion. |
| Old DOM adapter work could enter a replacement module | Same-realm evaluation could restart control IDs and leave listeners, popups, snapshots, or animation callbacks from the old adapter live. | The browser realm owns monotonic IDs and one exact module lifetime. Replacement removes old resources and makes old callbacks inert. Realm-owned popup resolvers preserve only the exact completion edge for an old native lease. |
| A failed file-drop read released capacity before sibling reads settled | `Promise.all()` rejected after the first failure, but other non-cancellable `File.arrayBuffer()` calls remained live. A new batch could then use bytes which were still retained. | The batch uses `Promise.allSettled()`. Its count and byte reservation remains live until every sibling read settles. |
| The ngspice handler could capture a stale lexical `Module` | A global handler installed by module A could remain callable after module B replaced the global module value. The handler could enter the wrong native instance. | Handler installation is bound to the exact module identity. Old handler calls verify that identity and cannot enter a replacement. |
| ngspice batching and transport had no byte bound | A synchronous output stream could create an unbounded microtask batch or unacknowledged worker-to-main frames. | Worker batches stop at 512 lines or 1 MiB. Worker and main transport each use 64-frame and 8 MiB credit. Exact sequence and byte acknowledgments transfer ownership. Native execution uses its separate retained-byte lease. |
| A save failure promoted a successor with unsafe ancestry | The lane promoted the latest captured snapshot after any result. A conflict or ambiguous transport result meant that this snapshot no longer had a proven server base. | Only `committed` promotes. `not-committed` permits a later explicit save. `conflict` and `unknown` install an absorbing path block. Client and server compare-and-swap preserve the loaded-body revision. |
| InfoBar Playwright helper used stale geometry | This was a test-harness defect. A queued relayout moved controls after registry lookup. The coordinate for `Dismiss` then belonged to the action button. | DOM controls and rendered menu rows publish stable browser identities. Playwright locator clicks resolve the live node geometry. Coordinate clicks remain for canvas-only elements. A deterministic test overwrites cached geometry and still requires the `Dismiss` identity to receive the click. |
| Explicit ZLIB sysroot include changed C++ header order | The final Docker build exposed a build-system defect. `ZLIB::ZLIB` published the Emscripten C sysroot as an explicit include. Clang then searched it before the implicit libc++ wrapper directory. A forced C++ header could resolve `<stddef.h>` to the raw C header. The static WebAssembly VRML plug-in failed to compile. | The imported target now publishes only `-sUSE_ZLIB=1`. Emscripten already searches its C sysroot. The correction removes the explicit include and restores the libc++ wrapper order. This defect is not an Asyncify ownership defect. A complete source-frozen build is still pending. |

These corrections are part of the implementation. They are not permission to
weaken the owner, lease, generation, or fail-stop rules when a later test fails.

### 12.4 Current validation state

Validation is active. The complete final evidence must use one source revision
and artifacts made from that revision. A partial browser run is not a final
browser pass.

This document uses four evidence classes:

| Evidence class | Meaning |
|---|---|
| Test definition count | The number of cases in source. It does not prove that a command ran. |
| Focused observed pass | A recorded run of a limited group. It proves only that group and source. |
| Historical pass | A recorded run before a later source change. It can help diagnosis, but it cannot close a current gate. |
| Final-source pass | A run from the recorded source-frozen revisions and artifacts. Only this class can close Stage 10. |

| Gate | Current state |
|---|---|
| Source-frozen revision set | PENDING. Record the outer repository and every submodule revision after implementation source stops changing. |
| Historical seven-target Docker build | HISTORICAL PASS for its recorded source. Log: `logs/build/20260812-172859.log`. Later source changes prevent final use. |
| Focused adopted-root rebuild and reducer | FOCUSED OBSERVED PASS. The standalone build log is `logs/build-wasm-test/20260813-001606.log`. The focused Chromium `battery: every context invariant holds` run passed 1 of 1. This result does not cover the other three sched-context Playwright tests or another browser. |
| Focused ngspice ownership checks | PROVISIONAL FOCUSED EVIDENCE. Recent work ran the scheduler and service group, the worker-batch reducer, both applicable type checks, worker syntax, wx object compilation, and sharedspice syntax compilation. The source-frozen commands and results must run again before this row can become a final-source pass. |
| InfoBar click oracle | CORRECTION COMPLETE IN SOURCE; DEFINITIVE RERUN PENDING. The earlier broad run exposed a stale-coordinate test-harness defect. Stable browser identity and a deterministic stale-geometry case now exist. The earlier broad failure is historical and is not the current expected behavior. |
| ZLIB include-order build defect | CORRECTION COMPLETE IN SOURCE; FINAL BUILD PENDING. A final-build attempt exposed an explicit Emscripten sysroot include before the libc++ wrapper headers in the static WebAssembly VRML plug-in. `ZLIB::ZLIB` no longer publishes that redundant include. The failed attempt is diagnostic evidence, not a final seven-target pass. |
| Final seven-target Docker build | PENDING from the source-frozen revision set. Record the exact command and log. |
| Broad unit, type-check, static-contract, and deterministic suites | PENDING from the source-frozen revision set. Earlier totals, including 458, 907, 168, and later intermediate totals, are stale and are not final evidence. |
| Full Playwright matrix | PENDING. Run every required project with the recorded browser versions, one worker, zero retries, exact failures, and exact skip names. |
| Real WebSocket stack | PENDING. Run the closed application stack and its collaboration, library, session, save, and worker cases. |
| Extended real-application exploration | PENDING. Record each defect, deterministic reproduction, correction, and applicable rerun. |
| Static skip inventory | PENDING FINAL COUNT. Known distinct exclusions include `Display geometry is reported correctly`, the WebAssembly RAM raytracer black-frame camera-deadlock test, and the headed-Xvfb Firefox zoom-anchor fixme. Firefox multi-editor and three-editor resource-budget exclusions must be reported separately for each project that runs. These are not Asyncify-owner passes. |

A reducer proves only its stated invariant. A build log proves only its recorded
source. Focused results can identify and close a specific defect. They do not
replace the pending final all-target build, broad non-browser rerun, full
cross-engine matrix, or real-application exploration.

### 12.5 Evidence rule

Do not combine results from different source revisions into one final pass.
For each final command, record these facts:

- The exact source revision for each repository and submodule.
- The exact command.
- The artifact build log.
- The test result, including failures, retries, and intentional skips.
- The browser and toolchain versions when they can change the result.

Historical artifacts can help to find a defect. They cannot close a final
gate after the source changes. Do not add a source workaround only to make a
historical artifact behave like the new source.

## 13. Branch and worktree map

The isolated outer worktree is:

```text
/Users/V/IdeaProjects/pcbjam-private/.worktrees/asyncify-owner
```

| Repository | Worktree path under the isolated outer worktree | Branch | Purpose |
|---|---|---|---|
| `pcbjam-private` | `.` | `codex/asyncify-execution-owner` | Sync-server changes and submodule pointers. |
| `pcbjam` | `pcbjam` | `codex/asyncify-execution-owner-core` | Scheduler shim, bindings, web app, reducers, and this record. |
| `wxwidgets` | `pcbjam/wxwidgets` | `codex/asyncify-execution-owner-wx` | Physical dispatch integration and semantic owner policy. |
| `kicad` | `pcbjam/kicad` | `codex/asyncify-execution-owner-kicad` | Opaque libcontext tokens, terminal coroutine lifetime, dialog hooks, and async library/model completion gates. |
| `pcbjam-shared` | `pcbjam/web/pcbjam-shared` | `codex/asyncify-source-sequencing-shared` | Sync-client source sequencing and atomic local cache. |
| `binaryen` | `pcbjam/binaryen` | `codex/asyncify-execution-owner-binaryen` | Separate branch for isolation. There are no current source changes. |

## 14. Non-goals and known caveats

### 14.1 No global network mutex

This implementation does not serialize all fetches, WebSocket receives, or
service requests. The owner gateway serializes logical transactions that read
or change shared wxWidgets or KiCad state. A future change must not put network
waits inside the owner queue.

`runNativeCompletion` has a different purpose. It does not admit an owner. It
permits one audited short and non-suspending MEMFS, heap, or native-export
access while integrity is known, and makes a trap terminal before it escapes.
When a delayed result uses `enqueueNativeCompletion`, that completed payload
waits in the physical native-entry FIFO before `runNativeCompletion` runs.
This orders only the short native touches; it does not put their network
requests in the FIFO. A call that can park or inspect mutable model state must
use the owner gateway instead.

The physical native-entry FIFO is also not a browser-event mutex. Fetch
transfers, Promise callbacks that only change JavaScript state, WebSocket
receipt, rendering callbacks, and unrelated service work can continue. Only a
scheduled call that can start, wake, or resume a physical native context uses
this FIFO. A network operation does not keep a native-entry job while it waits.

Some WebSocket data later causes a native effect. For example, sibling
schematic updates later restage MEMFS. The receive callback and Y.Doc update
remain concurrent. Only the later MEMFS owner ticket enters native
serialization.

### 14.2 No cross-tab same-path linearizability

Source order is authoritative inside one `SyncLayer` lifetime. IndexedDB
transactions and manifest-path merges protect atomicity and unrelated paths.
They do not define one total order for two browser tabs that write the same
cache path at the same time.

The current recovery rule is server authority on open, reconnect, or repair. A
stronger same-path contract needs a server epoch or revision in the wire
protocol. The resettable numeric manifest version is not a safe cross-epoch
compare-and-swap token.

### 14.3 Modal delegated scopes are incomplete by design

The active modal lease admits only work with an audited class and exact target
scope. Some producers do not yet have enough provenance. Examples include a
worker-thread `QueueEvent`, an unscoped non-window `CallAfter`, and a timer that
belongs to another top-level family.

These producers stay blocked during the lease. This is the safe default, but a
real modal can wait for one of them. If tests find such a dependency, add a
narrow delegated scope or capability for that producer. Do not admit all
pending events or all timers.

### 14.4 Trap recovery is module replacement

After a native trap, the implementation does not try to unlock native state.
It marks integrity unknown, rejects JavaScript command mirrors where safe, and
stops native ingress. The application must replace the module instance.

Terminal cleanup has two different rules:

- Pure-JavaScript observers are settled. Owner-gateway jobs and public open
  jobs reject. An accepted exact physical-entry job rejects its observer only
  when it supplied the pure-JavaScript `onAbandon` callback.
- Native frames are abandoned. The scheduler clears numeric wait records and
  queued delivery closures without resolving or rejecting their native wait
  Promise. A settlement could start an Asyncify rewind into the failed stack.

The same rule applies to a worker thread blocked in
`emscripten_proxy_sync_with_ctx`. Its queued completion can contain
`emscripten_proxy_finish`. Calling that function after a native trap would
re-enter the damaged module. The scheduler therefore does not call it. The
pthread can remain blocked until the application terminates the failed module
and its worker pool. This is an unavoidable native lifetime limitation of
fail-stop recovery. It is not an unbounded JavaScript queue: the physical-entry
queue has a 4,096-job limit, and shutdown clears the queue, its closures, its
coalescing keys, its wait registry, and its byte accounting.

### 14.5 Queue limits are intentional

The queue limits prevent silent memory growth. Their failure policies are not
all the same:

- Native-entry, JavaScript mailbox, context-sleep, and native execution-
  envelope ownership failures make the module terminal. Continuing could lose
  an exact wake or the only affiliated owner-release tail.
- Sync-client local-lane admission rejects the caller with
  `SyncMutationQueueFullError` before it copies or sends the refused body.
- Sync-server lane admission returns HTTP 429, or HTTP 413 for one body which
  is too large.
- Remote sync overflow discards no accepted native payload. It coalesces the
  condition into an authoritative repair request.

Producers must copy small payloads, batch high-rate data, and coalesce only
approved passive or latest-value work.

### 14.6 Upstream rebase cost remains

The semantic owner is concentrated in Wasm-private wx files, but the wx change
is still large. Future cleanup can move more coordinator code to a dedicated
Wasm-private translation unit. That change must preserve the same public wx
surface and the same deterministic reducers.

### 14.7 An owner is not a physical lifetime fix

The semantic owner prevents two unrelated stateful transactions from entering
the native model at the same time. It does not make a released C stack valid.
The physical terminal handoff is therefore a separate required fix. A future
change must not remove the terminal handoff because owner admission tests pass.
It must also not use physical context state as permission to enter model code.

### 14.8 Scope-wide sync writes are not enabled

The server contains read and routing support for a scope-wide multiplexed
library room. This support is not authority to enable writes. The per-library
room remains the sole writer until one coordinated deployment moves the room
name, manifest authority, clients, and broadcasts together.

### 14.9 Physical suspension state still has cross-checks

The libcontext backend keeps `swap_suspended`, and the physical registry keeps
its own enterable and in-place-park state. The JavaScript consume-once guard
also checks the generated fiber suspension. The code compares these views and
records a bounded divergence diagnostic.

This duplicate state is a remaining maintenance cost. A previous attempt to
use only the registry view refused a valid Symbol Properties yield-back. The
current transfer protocol therefore keeps the libcontext decision and the
JavaScript consume-once check. Removing either check needs one authoritative
model for direct symmetric transfers, scheduler star transfers, and in-place
`handleSleep` parks. Semantic ownership and opaque fcontext handles do not, by
themselves, supply that physical attribution.

### 14.10 Final browser validation is active and pending

The recorded all-target build in
`logs/build/20260812-172859.log` passed for its source. Later source changes add
owner-keyed fiber lanes, transactional Ready publication, main-stack adoption,
native retained-byte leases, terminal projection retirement, exact model-wait
completion, DOM browser lifetimes, save compare-and-swap, and bounded ngspice
transport. Focused rebuilds and tests do not convert the earlier all-target
build into current-source evidence.

An earlier broad wx Chromium run found the InfoBar dismissal failure. The cause
was a stale-coordinate Playwright helper, not an Asyncify-owner failure. The
helper now uses stable browser identity, and a deterministic test reproduces
the old stale geometry. The full broad rerun is still pending, so the browser
gate is not complete.

After the source stops changing, run the all-target build and the broad unit
and static gates again. Then use only those artifacts for the full KiCad and wx
browser matrix, cross-engine lanes, real WebSocket stack, stress groups, and
real-application exploration. Record exact revisions, commands, browser
versions, retries, and intentional skips. Do not report a final combined pass
until every required gate finishes.
