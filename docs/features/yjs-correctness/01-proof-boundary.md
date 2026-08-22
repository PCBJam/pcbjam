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
currently scoped to the native **item/library-definition bridge**:

```text
native item snapshot -> KicadDoc items -> Y.Doc -> item wire -> fresh native
                                      is canonically equivalent for fixtures
```

Four real-Y.Doc browser cases cover PL, schematic, PCB footprint containment
and PCB items; two further cases check the native wire/file dialect. Non-item
structure is exercised separately through seed/materialization and explicit
fresh-instance recovery. KiCad legitimately normalizes whitespace, numeric
formatting and some order, so byte identity is the wrong oracle. This finite
fixture evidence is not a universal codec theorem.

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
| Unmaterializable authority | raw malformed/future Y never mutates native and is classified consistently during live projection or initial adoption | two preserved app-free red/green pairs plus real-Wasm repair-first E2E; malformed Y needs corrective room update, future Y needs client upgrade |
| Asynchronous projection | one flight plus latest dirty state, explicit no-flight retry wait, owner/request/timer isolation, monotone ACK, exact-latest retry wake, ambiguous-emission fail-stop and a safe fresh-owner transition | Dafny `ProjectionKernel`; generated `decideProjectionAck` and `decideNativeEmission`; exhaustive 32-ACK/2-emission decision tests; deferred bridge and real-Wasm lifecycle/emission E2Es; JS timer fairness remains trusted and product recovery is an explicit reload |
| Native batch effect | preflight rejection changes nothing; `applied` is acknowledged only after the complete prepared commit | conditional Dafny `AtomicNativeBatch`; C++ preflight tests and real-Wasm before/after assertions; exceptional post-staging outcome is terminal and not claimed rolled back |
| Non-item projection | item hot-apply is used only while native and Yjs structural signatures agree | Dafny `StructuralProjection`; binding fail-stop/reload tests and browser recovery E2E |
| Durability boundary | only revisions at or behind the persisted frontier may be reported durable | Dafny `DurabilityBoundary`; ordered-save/last-close integration tests; process loss inside an unacknowledged debounce remains outside the claim |
| Codec/native refinement | production TypeScript/C++ implements the abstract rules for the exercised KiCad documents | finite roundtrip fixtures, unit/integration tests and browser/Wasm E2E; not a theorem about arbitrary C++ or every grammar construct |

The generated acknowledgement and native-emission functions are not
handwritten restatements. Dafny 4.11.0 verifies the model, compiles it to
JavaScript, and the generator checks a source/compiler hash before
byte-comparing the checked-in artifact. Production imports those generated
decisions. See `formal/yjs/README.md`.

Those are two decision classifiers, not a generated application controller.
The queue variables, promises, retry timer, owner/request filtering, native
shadow, observers, terminal overlay and recovery plumbing remain handwritten
and are covered by refinement tests. Likewise, several table rows are
conditional policy lemmas: `GraphClosure` assumes a valid parent/rank
certificate, `AtomicNativeBatch` assumes a prepared result, structural
projection assumes the signature is complete, and durability assumes an
ordered persisted frontier. The tests connect those assumptions to production;
the lemmas do not manufacture that connection by themselves.

## What each original risk meant

### Native snapshots

A snapshot says what the editor looks like now, not which user action produced
it. If native was based on width `0.2`, Y advanced to width `0.4`, and the user
changed only the layer in the stale native copy, naïvely publishing the full
snapshot restores width `0.2`. The binding now keeps an acknowledged native
shadow and applies the base-to-local intent as a three-way rebase over current
Y.

### Inferred identities

Repeated anonymous children such as polygon vertices often have no durable ID
in a KiCad save. Assigning an ID after parsing is not stable: after an
insert-before, positional ID `xy#1` can name a different logical vertex. Only
UUIDs and a deliberately audited semantic key such as `property#Reference` are
independent identities. Everything ambiguous is one atomic sequence value.

### Nested Y.Map/Y.Array merge behavior

Yjs merges each shared child independently. This is powerful only when those
children are true independent conflict domains. Splitting one logical value
into unrelated maps/arrays can produce a syntactically merged state no client
authored. V3 keeps ambiguous sequences atomic, stores layout replacements by
semantic head, and selects concurrent whole-document seeds through one active
epoch pointer.

### Parent/reference invariants

The model redundantly represents a child's `parent` and the parent's/root's
reference to that child. Independent concurrent writes can disagree, create a
cycle, leave an orphan, or reference a missing object. A total analyzer checks
reachability, uniqueness, parent agreement and acyclicity. Canonicalization is
deterministic and idempotent; native preflight rejects an unresolved parent
before any mutation.

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

### Schema versions

Two schemas may interpret identical Y keys with different merge granularity.
Allowing them into one room is corruption, not collaboration. Document room
IDs carry protocol v3 and both gateway and direct-room admission reject missing,
legacy or future versions with 409 before relay/authentication. Presence rooms
stay unversioned because they carry no KiCad document state. This admission gate
does not resolve conflicts; Yjs remains the merge engine.

More precisely, that last statement concerns **valid concurrent values**: the
server never compares native snapshots or chooses their winner. The existing
integrity service does perform schema admission, on-load migration/compaction,
persistence and linting. After a deterministic invalid-document lint and a
known-good checkpoint, it may publish a forward Yjs recovery update. That
server-authored safety correction is outside normal conflict arbitration and is
recorded as a revert, not silently presented as a merge winner. Because lint
does not identify a safe minimal Yjs conflict domain, the checkpoint rewrite
can also reset valid post-checkpoint work present in the failing snapshot. That
coarse recovery is not proved intention-preserving.

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

A native snapshot emitted while a remote apply is unresolved has no trustworthy
causal position: it may describe the model before, during or after that commit.
The browser still rebases and publishes the parseable local intent to Yjs, then
executes the generated `decideNativeEmission` policy. That policy terminalizes
the old owner with `native-emission-order` / `emission-before-ack` /
`recreate-from-yjs`. Later callbacks are absorbing. Production shows a fatal
overlay whose `Reload` action creates the fresh Wasm instance; the E2E opens a
new context from the same canonical Y document and proves zero drift. This is a
deliberate fail-stop proof boundary, not an assertion that the unknowable
in-place model remained synchronized.

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
- The server's confirmed-invalid `.good` checkpoint forward-revert is a coarse
  integrity mechanism, not a conflict theorem. It may reset valid work that
  coexists with invalid content; removing or redesigning it is required if the
  product rule means no server-authored document correction at all.
- In the current JSPI build, a programmatic in-place document load after a
  remote native commit can trap inside wx's `Load PCB` progress phase. The
  lifecycle barrier proves the prior apply drains and ACKs exactly once, but
  does not claim that unsafe same-instance load works. It is a terminal
  boundary: detach ingress and create a fresh editor from canonical Yjs state.
- A raw peer able to delete every v3 marker can make the state look identical
  to a pristine empty document. Normal authenticated clients cannot emit that
  operation; raw/malformed state is a quarantine/recovery boundary.
- Clean last-close persistence is a durability barrier. An infrastructure-wide
  crash inside the bounded save debounce is not advertised as an acknowledged
  durable save; surviving peers/state-vector resync or the next save recovers
  normal interruptions.
