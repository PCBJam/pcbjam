# Yjs ⇄ native correctness contract

Status: target contract and evidence map for `codex/yjs-properties`.

This document defines the claims the implementation and regression suite are
allowed to make.  It deliberately does not claim that every pair of KiCad
edits commutes.  A native snapshot does not retain identities for every
anonymous s-expression child, so some simultaneous edits are genuine
conflicts. Correctness means that compatible intentions survive, conflicts
have one documented policy, invalid intermediate data never reaches the
editor, healthy replicas converge, and terminal or malformed cases fail closed
behind an explicit recovery boundary.

## State and equivalence

`Valid(d)` means all of the following:

1. `d` has the `KicadDoc` structural shape.
2. Every item reference resolves to an item.
3. Every item is referenced exactly once.
4. A root reference points to an item whose `parent` is `null`.
5. A reference inside item `p` points to an item whose `parent` is `p`.
6. Every non-null parent exists.
7. The parent graph is acyclic and every traversal terminates.

`a ≈ b` is canonical KiCad equivalence: parsing the rendered documents and
normalizing writer-controlled formatting/order produces the same tree.  Byte
identity is not required because KiCad's native writer normalizes files.

The authoritative state is the current Yjs state epoch.  A native editor is a
fallible asynchronous projection of that epoch.  `desiredRevision` is the
latest valid Y state known to a binding, `inFlightRevision` is at most one
native projection, and `appliedRevision` is the last projection acknowledged
after native commit. The native shadow advances from that exact submitted wire;
an acknowledgement-time snapshot must not destructively redefine the base for
concurrent local intent.

## Laws

These are the target laws. They are not all universal theorems about arbitrary
KiCad input: the evidence ledger distinguishes abstractly proved policy,
finite deterministic/combinatorial tests, real-Wasm refinement, and trusted
dependencies.

### Pure representation

- Canonical roundtrip: `decode(encode(d)) ≈ d` for every representable valid
  document.
- Normalization: `normalize(normalize(d)) = normalize(d)`.
- Delta soundness: applying the semantic delta from `a` to `b` to `a` yields
  `b`, modulo canonical normalization.
- Migration preservation and idempotence: `migrate(d) ≈ d` and a second
  migration is a no-op.
- Compaction preservation: decoding state before and after compaction is
  equivalent, including every registered auxiliary root.

### Replication

- Same-update-set convergence: delivery order, duplication, batching, and a
  temporary partition do not change the final visible state.
- Compatible-intention preservation: edits in independent conflict domains
  both survive.
- Conflict determinism: edits in one conflict domain resolve to one complete
  value; a merge may not construct a hybrid value that no client authored.
- Atomic seed epoch: concurrent first seeds select one complete seed, never a
  union of roots, items, layout, or library definitions.
- Graph closure: decoding and every accepted local transition return `Valid`.

### Native projection

- No forgotten desired revision: a remote Y update is either acknowledged by
  native, superseded by a newer desired revision, or retained for retry.
- No stale publication: local native output is interpreted relative to the
  last acknowledged native shadow; unchanged stale fields may not overwrite
  newer Y fields.
- Preflight/acknowledgement atomicity: a preflight-rejected batch changes
  nothing, and an `applied` acknowledgement occurs only after the complete
  prepared commit. If an exception occurs after native staging begins, the
  outcome is unknown and the instance is terminal; rollback is not claimed.
- Fixed point/no echo: projecting an already-applied revision creates no new
  semantic Y update.
- Conditional eventual projection: under fair scheduling, no terminal failure,
  and eventually successful native calls, quiescence is expected to imply
  `native ≈ decode(Y)`. This is an operational liveness target supported by
  tests, not a temporal theorem in the current Dafny model.
- Lifecycle isolation: completion from an old binding generation cannot mutate
  a new file/room.
- Emission-order safety: if native emits a parseable local snapshot while a
  remote projection is still unacknowledged, the browser publishes that local
  intent to Yjs but does not guess whether the snapshot was taken before or
  after the native commit. It retires that native owner and requires a fresh
  editor to be hydrated from the resulting canonical Y state. Production
  exposes this as an explicit fatal-overlay `Reload` action.
- Structural projection: the live item bridge is used only while the native and
  Yjs non-item signatures agree. A remote root/layout/library-definition change
  retires the current instance and requires explicit recreate-from-Y recovery.

### Failure and durability

- Malformed Y or wire data leaves native at its last-good revision and produces
  one observable terminal rejection. A malformed authority reports
  `repair-yjs-before-recreate`; a future encoding reports `upgrade-client`.
  Reloading an unchanged malformed room is not presented as recovery.
- Busy/open-in-flight is retryable and cannot drop a revision.
- An explicitly transient `busy`/`unavailable` rejection retries from the
  latest desired state with bounded queue size. A timeout, malformed/partial
  result, trap, or any unknown native state is terminal for that Wasm instance:
  recreate it and hydrate from Y.
- A native emission during an unresolved remote apply is an unknown ordering,
  even when both payloads are individually valid. Its intent is retained in
  Yjs, but the old native instance is terminal and may not publish or apply
  again.
- A programmatic document load after a remote native commit is also
  recreate-only in this JSPI build; same-instance continuation is not part of
  the correctness claim.
- An edit is called durable only after the persistence layer has acknowledged
  it; state accepted only into a debounce buffer is not yet durable.

## Conflict domains

The v3 schema uses stable identities where the source format supplies them:

- uuid-bearing items and child references: UUID;
- explicitly keyed records: stable semantic key;
- different field heads: independent map entries;
- anonymous repeated children and positional atoms: one atomic sequence value.

The last row is intentional.  Native snapshots cannot distinguish, in the
general case, "insert a duplicate before element 1" from "replace element 1 and
append its old value".  Assigning random IDs after the fact only hides that
ambiguity.  Until the native bridge emits durable semantic element IDs or
operations, an anonymous sequence is one LWW conflict domain.  Concurrent
edits converge to one whole authored sequence; they do not silently mix or
mis-associate elements.

## Evidence layers and trusted boundary

1. Deterministic unit tests pin each known counterexample and conflict policy.
2. Deterministic combinatorial tests enumerate specified finite fixtures,
   conflict histories, operation traces, delivery orders, duplicates, batches,
   partitions, normalization cases and migrations.
3. The Dafny model proves abstract algebraic and controller invariants for seed
   epochs, projection tickets, retries, lifecycle generations and fail-stop
   recovery; generated decision-table tests enumerate every exported Boolean
   input.
4. Browser/Wasm E2E tests show the production bridge refines the model for real
   KiCad parsers, commits, saves, and reloads.

Yjs's internal CRDT convergence, the JavaScript/Wasm runtime, and KiCad's parser
and writer remain trusted dependencies.  Formal protocol/model results do not
prove arbitrary C++ correct; native differential and E2E tests cover that
refinement boundary.

The handwritten conflict-domain classifier and the completeness of the
non-item projection signature are also trusted semantic boundaries. The Dafny
lemmas assume a correct domain cut and a correct structural signature; finite
schema fixtures and native conflict tests audit that assumption but do not
prove the entire KiCad grammar.

Normal concurrent document values are selected only by Yjs. The sync service
does not compare two valid native snapshots or choose a conflict winner. It is
not otherwise a byte-blind relay: at epoch/storage boundaries it admits one
schema, migrates/compacts Yjs state, persists and lints materialized content,
and can publish a Yjs forward-revert to a known-good checkpoint after a
repeatable invalid-document lint result. That is an explicit integrity recovery
boundary, not ordinary conflict resolution. It is also coarse: without a
machine-readable corrupting-domain proof, it may reset valid post-checkpoint
work that coexists with the invalid content. Intent preservation for this
server-authored recovery is not claimed; disabling or redesigning it is a
separate product-policy decision if “no server document correction” is meant
literally.
