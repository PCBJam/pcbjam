# Yjs correctness proof boundary

This document states exactly what is proved, what is established by executable
refinement tests, and what remains a trusted assumption. “Surely correct” is
not one undifferentiated claim: a proof of a small policy function does not
prove the Yjs implementation, a JavaScript engine, a Wasm scheduler, or KiCad's
parser.

## The correct convergence statement

It is impossible for every high-level edit to commute. If two users write
different values to one single-valued field, one visible value cannot preserve
both simultaneously.

The implemented contract is instead:

1. Replicas that receive the same set of Yjs updates converge, independently
   of delivery order, duplication and batching.
2. Edits in independent declared conflict domains preserve both intentions.
3. A conflict within one domain resolves to one complete authored value using
   Yjs's deterministic register ordering; it never creates a hybrid value that
   nobody authored.
4. Under fair scheduling, no terminal failure and eventual successful native
   calls, tests support the operational expectation that quiescence brings a
   healthy native editor to the canonical projection of its Y document. The
   current Dafny model proves safety transitions, not this temporal liveness
   statement.

The native roundtrip evidence is likewise semantic, not byte-for-byte, and is
scoped to the native **item/library-definition bridge plus a fresh native
owner/save**:

```text
native snapshot -> KicadDoc -> Y.Doc -> validated root wire -> fresh native save
                                                is semantically equivalent
```

The corpus includes drawing-sheet and schematic fixtures, demo and KiCad QA
boards, PCB groups, a `PCB_GENERATOR`, and the real StickHub board. StickHub
exposed two native-decoder losses that synthetic fixtures had missed: a bare
footprint parsed without a board loses pad nets, and a footprint detached from
a temporary parsing board can retain a dangling component-class reference.
The decoder now parses all roots in a board envelope, maps nets, rebinds the
component class to the live board and detaches through the same ownership
sequence as KiCad paste. Direct assertions pin the real pad UUIDs and net names.

Non-item structure is exercised separately through seed/materialization,
covered schematic-library projection and explicit fresh-instance recovery.
KiCad legitimately normalizes whitespace, numeric formatting and some
top-level order, so byte identity is the wrong oracle. A demo board that moves
an otherwise identical block of tracks on reopen is semantically equal only
after exact UUID membership/content, root state and layout equivalence are
checked. This finite corpus is strong differential evidence, not a universal
codec theorem.

## Proof and evidence stack

| Boundary | Claim | Evidence |
| --- | --- | --- |
| Abstract update delivery | union is associative, commutative and idempotent; duplicates have no effect | Dafny `UpdateAlgebra`; Yjs itself is a pinned trusted dependency |
| Room admission | two admitted document clients cannot use different schema versions | Dafny `RoomAdmission`; gateway and direct-room 409 integration/E2E tests |
| Concurrent initialization | one complete epoch wins; roots from different seeds cannot hybridize | Dafny `AtomicEpoch`; every delivery permutation/duplicate/batching test; divergent three-tab browser test |
| Native snapshot intent | unchanged domains retain current Y, changed domains retain local intent; disjoint domains commute | Dafny `NativeRebase`; app-less three-way rebase tests; held-projection browser scenarios |
| Conflict-domain shape | independent semantic domains commute; a same-domain conflict selects one complete authored value | Dafny `ConflictDomains`; deterministic hybrid counterexamples and update-permutation tests |
| Nested identity | UUID and audited semantic identities merge independently; anonymous sequences are atomic | deterministic counterexamples and permutation tests; this is a schema policy, not inferred identity magic |
| Parent/reference closure | validation terminates; missing, duplicate, cyclic, orphaned and inconsistent relations never reach native | Dafny `GraphClosure` rank/reference model; graph analyzer/canonicalizer unit tests; native parent preflight; real-Wasm malformed-batch E2E |
| Unmaterializable authority | raw malformed/future Y never mutates native and is classified consistently during live projection or initial adoption | two preserved app-free red/green pairs plus real-Wasm repair-first E2E; malformed Y needs an authenticated corrective client update, future Y needs client upgrade |
| Asynchronous projection | one flight plus latest dirty state, explicit no-flight retry wait, owner/request/timer isolation, monotone ACK, exact-latest retry wake, opt-in FIFO proof for pre-ACK emissions and fail-stop for an unproved bridge | Dafny `ProjectionKernel`; generated `decideProjectionAck` and `decideNativeEmission`; exhaustive decision tables; deferred bridge and real-Wasm lifecycle/emission E2Es; JS timer fairness and the production FIFO refinement remain trusted |
| Native batch effect | preflight rejection changes nothing; `applied` is acknowledged only after the complete prepared commit | conditional Dafny `AtomicNativeBatch`; C++ preflight tests and real-Wasm before/after assertions; exceptional post-staging outcome is terminal and not claimed rolled back |
| Non-item projection | item hot-apply is used only while hard signatures agree; a library change additionally needs exact request coverage of all affected consumers | Dafny `StructuralProjection`; binding coverage tests, schematic-library browser cases and fail-stop/reload E2E |
| Save cut | target: persistence only after every native projection through the frozen accepted prefix is acknowledged; timeout/failure through it fails closed | Dafny `SaveCut`; generated classifier exercised by an app-free FIFO harness; real editor save-before-pending-apply and timeout evidence. Concrete C++ currently has only busy/empty: it has neither a fixed cut nor a retained failed-ticket frontier, so a failed apply can be forgotten before writer entry. Full production refinement remains open; timeout recovery is fresh-native-from-Y, not same-owner retry |
| Durability boundary | only revisions at or behind the persisted frontier may be reported durable | Dafny `DurabilityBoundary`; ordered-save/last-close integration tests; process loss inside an unacknowledged debounce remains outside the claim |
| Online epoch rewrite | replacing current-version Y identities is forbidden without a replica fence | deterministic old-replica/fresh-epoch counterexample plus `selectLoadTimeEpochRewrite`; this is an executable safety policy, not a proof that future fencing is complete |
| Backend authority | persist/lint/report/read/admit/reject have no Y-state mutation effect; a live marker forbids stale fallback | finite policy function, production-source absence scan, sync/core integration tests and full-service API scenario; YServer and storage remain trusted |
| Codec/native refinement | production TypeScript/C++ implements the abstract rules for the exercised KiCad documents, including native board-owned references | finite roundtrip fixtures, real corpus, direct pad-net assertions and browser/Wasm save E2E; not a theorem about arbitrary C++ or every grammar construct |

The generated acknowledgement, structural-projection, native-emission and
save-cut functions are not handwritten restatements. Dafny 4.11.0 verifies the
model, compiles it to JavaScript, and the generator checks a
source/compiler hash before byte-comparing the checked-in artifact. Production
executes the first three decisions; an app-independent FIFO refinement harness
executes the save-cut classifier. The source currently verifies 99 obligations
with zero errors. See `formal/yjs/README.md`.

Those are four decision classifiers, not a generated application controller.
The queue variables, promises, retry timer, owner/request filtering, native
shadow, observers, terminal overlay, concrete save drain and recovery plumbing
remain handwritten and are covered by refinement tests. Likewise, several
table rows are conditional policy lemmas: `GraphClosure` assumes a valid
parent/rank certificate, `AtomicNativeBatch` assumes a prepared result,
structural projection assumes the signature/coverage inventory is complete,
durability assumes an ordered persisted frontier, and `SaveCut` assumes a
monotonically ticketed FIFO with a retained failure frontier. The concrete C++
queue exposes only busy/empty, not those tickets or failures. Empty proves that
no body is pending; it does **not** prove that every accepted body succeeded.
The current tests connect only the successful-pending and timeout portions to
production. The lemmas do not manufacture the missing failure refinement or
fixed-cut liveness by themselves.

## What each original risk meant

### Native snapshots

A snapshot says what the editor looks like now, not which user action produced
it. If native was based on width `0.2`, Y advanced to width `0.4`, and the user
changed only the layer in the stale native copy, naïvely publishing the full
snapshot restores width `0.2`. The binding now keeps an acknowledged native
shadow and applies the base-to-local intent as a three-way rebase over current
Y.

**How it is proved:** `NativeRebase` proves the per-domain decision table and
commutation of disjoint domains. Exhaustive app-free histories check additions,
deletions and same-domain conflicts. A held real-Wasm projection then creates a
genuinely stale editor snapshot and asserts that both the local endpoint edit
and the remote width survive. The remaining assumption is that the domain
classifier actually describes the intended KiCad semantics.

### Inferred identities

Repeated anonymous children such as polygon vertices often have no durable ID
in a KiCad save. Assigning an ID after parsing is not stable: after an
insert-before, positional ID `xy#1` can name a different logical vertex. Only
UUIDs and a deliberately audited semantic key such as `property#Reference` are
independent identities. Everything ambiguous is one atomic sequence value.

**How it is proved:** this begins with an impossibility counterexample: the same
two final positional snapshots admit different edit histories, so no snapshot
algorithm can recover the intended element identity. The positive theorem is
conditional: given stable UUID/audited keys, independent registers commute;
anonymous sequences select one complete authored value. Delivery permutations
and insert/edit fixtures test the classifier. A nearest-owner repeated UUID is
kept inline, while a duplicate UUID under a different owner is rejected.

### Nested Y.Map/Y.Array merge behavior

Yjs merges each shared child independently. This is powerful only when those
children are true independent conflict domains. Splitting one logical value
into unrelated maps/arrays can produce a syntactically merged state no client
authored. V3 keeps ambiguous sequences atomic, stores layout replacements by
semantic head, and selects concurrent whole-document seeds through one active
epoch pointer.

**How it is proved:** small counterexamples first demonstrate Y.Array
interleavings and nested-map hybrids. `ConflictDomains` proves that the chosen
atomic/register abstraction cannot synthesize a hybrid, while deterministic
Yjs tests enumerate update delivery order, duplicates and batching. Yjs's own
tie-break/convergence implementation remains trusted.

### Parent/reference invariants

The model redundantly represents a child's `parent` and the parent's/root's
reference to that child. Independent concurrent writes can disagree, create a
cycle, leave an orphan, or reference a missing object. A total analyzer checks
reachability, uniqueness, parent agreement and acyclicity. Canonicalization is
deterministic and idempotent; native preflight rejects an unresolved parent
before any mutation.

**How it is proved:** `GraphClosure` uses a strictly decreasing natural-number
rank to rule out cycles and prove termination. The executable analyzer rejects
missing refs, duplicate refs, orphans, cycles and prototype-key cases;
canonicalization is tested for idempotence. Real-Wasm mixed valid/invalid
batches prove rejection before native mutation. The rank/owner certificate is
computed by handwritten code and is part of the trusted refinement boundary.

### Seed races

Two clients can both observe an empty room and seed at the same time. If layout,
items and libraries are separate top-level writes, ordinary Yjs merging can
produce a cross-file hybrid. V3 builds each seed as a detached complete state
and concurrently assigns that single state to `kdoc_state.active`; Yjs selects
one whole value.

An observer-created empty `kdoc_state` root is not authored state. It is treated
as seedable unless the durable v3 marker or another authored key proves that an
active epoch was deleted. A stamped v3 document with a missing/wrong active
pointer still fails closed.

**How it is proved:** `AtomicEpoch` treats the active epoch pointer as the one
selection event. Finite tests enumerate seed update permutations, duplicates
and batches, and a divergent multi-tab E2E verifies that a late joiner sees one
complete seed. This relies on Yjs deterministically resolving the concurrent
pointer writes.

### Schema versions

Two schemas may interpret identical Y keys with different merge granularity.
Allowing them into one room is corruption, not collaboration. Document room
IDs carry protocol v3 and both gateway and direct-room admission reject missing,
legacy or future versions with 409 before relay. Presence rooms stay unversioned
because they carry no KiCad document state. This gate does not resolve
conflicts; Yjs remains the merge engine.

**How it is proved:** `RoomAdmission` proves that two admitted document clients
share the declared version. Gateway and direct-room tests reject missing,
legacy and future versions before synchronization. Production lint is
report-only and has no room-apply API. The retained schema-upgrade load path is
a separate migration boundary; it is not a theorem about arbitrary offline
legacy replay.

### Asynchronous native projection

Calling a JSPI/embind function can mean only “queued”, not “committed”. Treating
that return as completion loses updates, lets stale work affect a new document,
and can wedge forever after an open or trap. Every request now carries an owner
generation and request ID. Native validates the complete batch, commits it, and
only then emits an acknowledgement. The browser permits one in-flight request,
coalesces all newer Y revisions into one latest follow-up, retries only explicit
transient statuses and fail-stops when native state is unknown. A successful
ACK advances the shadow from the exact submitted wire; it never takes an
ACK-time snapshot that could erase the base of a concurrent local edit.

The production bridge adds a narrower causal fact. Local commit flushes and
remote applies execute in one strict non-interleaving FIFO, remote-apply echoes
are suppressed, and ACK is emitted at the remote body's tail. An `onItems`
callback observed before that ACK must therefore be **pre-apply**. The binding
rebases/publishes it and continues; this covers the real pre-ACK undo/edit case
that the earlier unconditional fail-stop policy rejected.

`decideNativeEmission` still defaults to terminal when a fake, older or
alternate bridge cannot prove that contract. It preserves parseable local
intent in Yjs, retires the old owner with `native-emission-order`, and offers
`recreate-from-yjs`. This is important: the proof did not discover ordering from
a snapshot; it made the production ordering explicit and kept every unproved
implementation fail-closed.

**How it is proved:** `ProjectionKernel` verifies the two-input classifier;
decision-table tests enumerate both causal modes. App-free queue tests pin
strict FIFO and echo suppression, while real-Wasm pre-ACK and lifecycle cases
cross the suspension/commit boundary. The refinement assumes no native path
emits outside that common FIFO.

### Save cut and asynchronous native persistence

An editor save can be dispatched while a JSPI apply coroutine is suspended. A
post-write callback cannot fix this: it would already have serialized stale
native bytes. The writer chokepoints for pcbnew, eeschema and page-layout now
call a pre-save drain. If a successful apply is merely suspended, waiting for
the queue to empty closes the check-to-writer race on the single Wasm thread.
If the 35-second deadline expires, save returns false before the writer and
emits no persistence acknowledgement.

`SaveCut` proves the ideal ticket policy: freeze `accepted` at invocation, wait
until `acknowledged >= cut`, fail on a timeout/failure through the cut, and do
not let later acceptance move the cut. The concrete queue has only `busy` and
`empty`, so it waits for total quiescence. Two gaps remain until native exposes
accepted/ACKed/failed frontiers to save: later arrivals can postpone the save,
and—more seriously—a failed body can leave the queue empty without proving its
ticket succeeded. In that second case the current hook can proceed to a stale
writer. The formal failure theorem therefore is **not yet refined by
production**. A controller projection timeout also terminalizes the owner at
30 seconds; the supported recovery is to recreate native from authoritative Y,
not to retry save in the same native instance.

### Online compaction and the missing replica fence

Snapshot equivalence is not enough to replace a live Yjs history. Re-encoding a
materialized document into a fresh `Y.Doc` changes its client/item identities.
An old replica can later replay a causally valid tail; Yjs merges both epochs,
but the fresh v3 `active` pointer may win and hide the old tail. `onLoad` is only
a new-connection boundary, not proof that hibernated/offline replicas are gone.

The current selector rejects current-version `reason: "compaction"` rewrites.
The deterministic regression constructs the stale tail, forces the fresh
pointer to win and proves that choosing the rewrite loses visible work. A safe
future design needs generation negotiation, exclusion/drain of old writers and
a specified rebase before old identities are discarded. The existing
version-upgrade case was not changed by this slice and remains a separate
assumption.

### Board-owned references in real footprints

The s-expression contains names and IDs, but the in-memory object also holds
pointers owned by a `BOARD`. Parsing a bare StickHub footprint without a board
accepted the operation yet mapped its pads to net 0; the next save omitted
`GND` and `/U2D+`. Parsing it inside a temporary board fixed nets but initially
left its component-class proxy pointing into the soon-destroyed board, causing
a later save failure.

The decoder now uses one board-envelope path for every bare root, calls
`MapNets`, resolves component-class names against the live board, clears the
transient names, detaches the footprint with the same `RemoveAll` ownership
sequence as KiCad paste, and sets its live parent before destroying the
temporary board. This cannot be proved from the TypeScript codec: direct
receiver apply/save assertions over the real pad UUIDs and a real-board corpus
are the refinement evidence. Future board-owned pointer classes remain a C++
audit obligation.

## Trusted boundary and non-claims

- Yjs's secure eventual consistency is trusted and checked continuously with
  update permutation, duplicate, batching, partition and late-join tests.
- V8/SpiderMonkey, WebAssembly/JSPI, Cloudflare transport/storage and KiCad's
  parser/writer are not proved. Native and browser tests are refinement
  evidence across those boundaries.
- Same-domain concurrent writes are deterministic conflicts, not lossless
  merges.
- The conflict-domain classifier (`property` semantic IDs plus conservative
  atomic overrides) and the non-item signature inventory are manually audited;
  their completeness over the evolving KiCad grammar is not proved.
- The generic s-expression drift comparator intentionally treats some repeated
  positional tuples as a multiset and can miss a pure reorder. Ordered-sequence
  conflict tests therefore use direct parsed/numeric assertions; the generic
  drift report is supporting evidence, not a universal roundtrip oracle.
- A malformed authoritative Y state is kept behind the last-good native state.
  It emits one terminal `invalid-y-state / materialization-failed /
  repair-yjs-before-recreate` event during either live projection or initial
  adoption. If no corrective Y update can make it materializable, explicit room
  repair is required; repeatedly recreating the editor from the same malformed
  room deterministically reports repair-first again. A future schema instead
  reports `unsupported-y-version / upgrade-client`.
- The server does not repair collaborative content. Its production event set is
  admit/reject/read/persist/lint/report, each with `yStateMutation: "none"`.
  `.ydoc.good` is forensic evidence only. The historical pure revert helper and
  legacy client event names are not production authority. Repair must arrive as
  an authenticated Yjs protocol update; native recovery then requires explicit
  reload.
- A live-room marker is an authority fence for reads. If validated `/room/state`
  cannot be obtained, serving persisted/raw bytes would be silent drift, so the
  operation fails closed. Availability of that machine read is not proved.
- Current-version online compaction is disabled, not proved safe. Closed-state
  encoding equivalence does not supply a replica fence, and the retained
  version-upgrade path has its own compatibility assumptions.
- The abstract save cut is stronger than the concrete full-drain loop in both
  liveness and failure memory. Continuous later projections may make a safe
  save time out, and a failed projection can currently empty the queue without
  leaving the failure frontier the writer needs. Pending-success and timeout
  cases are covered; failure-through-cut remains an unresolved persistence
  risk until native tickets/frontiers are implemented.
- The real footprint fix covers net and component-class ownership found in the
  exercised corpus. It does not prove that KiCad has no other board-owned
  references in future root types or format versions.
- In the current JSPI build, a programmatic in-place document load after a
  remote native commit can trap inside wx's `Load PCB` progress phase. The
  lifecycle barrier proves the prior apply drains and ACKs exactly once, but
  does not claim that unsafe same-instance load works. It is a terminal
  boundary: detach ingress and create a fresh editor from canonical Yjs state.
- A raw peer able to delete every v3 marker can make the state look identical
  to a pristine empty document. Shipped clients do not emit that operation;
  malicious/raw protocol state is a quarantine/recovery boundary.
- Clean last-close persistence is a durability barrier. An infrastructure-wide
  crash inside the bounded save debounce is not advertised as an acknowledged
  durable save; surviving peers/state-vector resync or the next save recovers
  normal interruptions.
