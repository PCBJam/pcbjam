# Yjs ⇄ native correctness contract

Status: executable specification for `codex/yjs-properties`.

This document defines the claims the implementation and regression suite are
allowed to make.  It deliberately does not claim that every pair of KiCad
edits commutes.  A native snapshot does not retain identities for every
anonymous s-expression child, so some simultaneous edits are genuine
conflicts.  Correctness means that compatible intentions survive, conflicts
have one documented policy, invalid intermediate data never reaches the
editor, and all replicas recover to one canonical state.

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
and verified against a native snapshot.

## Laws

The test and model-checking layers must establish these laws.

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
- Atomic batch: native applies every validated entry or none of them.
- Fixed point/no echo: projecting an already-applied revision creates no new
  semantic Y update.
- Eventual projection: with a live editor and eventually successful calls,
  quiescence implies `native ≈ decode(Y)`.
- Lifecycle isolation: completion from an old binding generation cannot mutate
  a new file/room.

### Failure and durability

- Malformed Y or wire data leaves native at its last-good revision and produces
  an observable rejection.
- Busy/open-in-flight is retryable and cannot drop a revision.
- A rejected/timeout apply retries from the latest desired state with bounded
  queue size.  A trap or unknown native state is terminal for that Wasm
  instance: recreate it and hydrate from Y.
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
2. Generated/property tests exercise valid documents, operation traces, update
   permutations, duplicates, partitions, normalization, and migrations.
3. A bounded protocol model checks seed epochs, projection tickets, retries,
   lifecycle generations, and fail-stop recovery over all small schedules.
4. Browser/Wasm E2E tests show the production bridge refines the model for real
   KiCad parsers, commits, saves, and reloads.

Yjs's internal CRDT convergence, the JavaScript/Wasm runtime, and KiCad's parser
and writer remain trusted dependencies.  Formal protocol/model results do not
prove arbitrary C++ correct; native differential and E2E tests cover that
refinement boundary.
