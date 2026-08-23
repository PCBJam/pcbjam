# Yjs correctness model

This directory contains the small formally verified core of pcbjam's Yjs/native
projection protocol. It is intentionally narrower than the application: proofs
are useful only when their abstraction boundary is explicit.

## What is proved

`YjsProperties.dfy` has twelve policy modules and one abstract controller:

| Module | Verified obligation |
| --- | --- |
| `UpdateAlgebra` | Delivery duplication is idempotent and merging an identical update set is associative, commutative, and idempotent. |
| `RoomAdmission` | Two clients admitted to the current document room cannot use different schema versions. |
| `AtomicEpoch` | Seed arbitration selects one complete epoch, is order-independent for unique Yjs operation identities, and never constructs a cross-seed hybrid. |
| `NativeRebase` | An unchanged native conflict domain preserves current Y state; a changed domain preserves local intent; disjoint edits commute and retain both effects. It also proves the counterexample that two writes to one scalar domain do **not** commute. |
| `ConflictDomains` | Independent semantic domains commute; a same-domain conflict selects one whole authored register value and cannot manufacture a hybrid. |
| `AtomicNativeBatch` | Rejected preflight changes nothing and accepted preflight commits the complete prepared result. |
| `GraphClosure` | Canonical references are reconstructed from one certified parent relation; every parent traversal terminates by a strictly decreasing natural rank, so self/cyclic ownership is impossible. |
| `ReferenceBatch` | Group/generator memberships are rebound only as one validated post-batch graph; invalid input preserves the exact prior relation, valid input rebuilds the exact desired relation, and distinct owner rebinds commute. |
| `MonotonicKnowledge` | Embedded definitions are monotonic replica knowledge: hiding a reference removes it only from native materialization, offline compaction retains it, and a later reference revives it. |
| `StructuralProjection` | An item-only hot apply is permitted only while native and Yjs non-item signatures agree; structural drift requires full native rehydration. |
| `DurabilityBoundary` | A revision reported durable is within the persisted frontier and therefore survives restore; flushing advances that frontier through every accepted revision. |
| `SaveCut` | Native projection acknowledgements form one contiguous covered prefix; a successful complete latest-state projection may cover older retryable/not-entered tickets. A save freezes the accepted prefix and may acknowledge persistence only after that cut is covered. Pending timeout or a permanent failure at any outstanding ticket through the cut fails closed, while later accepted work cannot move the frozen cut. |
| `ProjectionKernel` | Owner/request isolation, one-flight/latest-dirty coalescing, monotone successful application, an explicit no-native-flight retry-wait interval with owner/timer isolation and exact-latest wake, terminal fail-stop, clean owner rehydration, and fail-stop on an ambiguously ordered native emission preserve the controller invariant. |

The exported acknowledgement, structural-projection, native-emission, and
save-cut decisions are compiled by Dafny to JavaScript. The standalone
controller executes the first three; an app-independent FIFO refinement
harness executes the save-cut policy. Tests enumerate every classifier input.
Dafny 4.11.0 currently discharges **116 verified obligations with 0 errors** for
this source.

Only those four classifiers are emitted into the generated runtime artifact.
Queue state, promises/timers, native-shadow mutation, owner/request
prefiltering, observers, terminal UI, the concrete native save-drain/deadline
mapping, and recovery plumbing remain handwritten and require unit plus
browser/Wasm refinement evidence.

## Verify and regenerate

The generator requires exactly Dafny
`4.11.0+fcb2042d6d043a2634f0854338c08feeaaaf4ae2` and refuses a different
compiler. The official `dafny-4.11.0-arm64-macos-13.zip` archive used for this
work has SHA-256:

```text
c90c75e7d5db9c6ccbb7127840dfe43f0ac938b039a7ebed146d8ead383a572f
```

From `web/standalone`, with `dafny` on `PATH`:

```sh
pnpm run formal:yjs:check
pnpm run formal:yjs:generate
```

Or set `DAFNY` to the exact executable path. `formal:yjs:check` verifies every
proof, recompiles the kernel, and byte-compares both generated files. Generation
is deterministic: the artifact records the source SHA-256 and compiler build.

The JavaScript compiler emits CommonJS. The generator performs two reviewed
packaging operations: it changes the `bignumber.js` import to ESM and appends a
typed export adapter. The decision body remains Dafny compiler output.

## Trusted boundary and non-claims

This proof does **not** prove the Yjs implementation, V8/WebAssembly, transport,
the KiCad parser, or the TypeScript/C++ codecs. `UpdateAlgebra` starts from the
standard CRDT premise that Yjs state is a function of the set of unique updates;
the pinned Yjs dependency is the trusted merge engine. The production schema is
connected to these abstractions by deterministic combinatorial/differential
tests and real KiCad/Wasm end-to-end tests.

Several modules prove conditional obligations rather than construction of
their premises: graph/reference closure assumes a certified owner/rank
relation, atomic batch assumes pure preparation, structural projection assumes
a complete signature, durability assumes an ordered persisted frontier, and
save-cut assumes the native queue refines its monotonically ticketed FIFO. The
formal result is therefore a proof of selected policies, not a whole-program
theorem.

`RetryWait` models the safety-relevant interval in which no native request is
in flight but exactly one latest desired revision is retained behind an
owner/timer-scoped callback. JavaScript timer fairness, elapsed time and event
loop cancellation remain runtime assumptions; the model proves transitions,
not a deadline or eventual-wake theorem.

In particular, there is no theorem saying every editor action commutes. That is
impossible for concurrent writes to one single-valued field. The implemented
contract is:

- independent declared conflict domains preserve both edits;
- a native snapshot is rebased from its acknowledged base onto current Y state;
- true same-domain conflicts are published to Yjs and use Yjs's deterministic
  register winner;
- incompatible codecs are rejected before joining a room; and
- a terminal projection failure stops applying and permits a fresh native owner
  to be hydrated from canonical Y state. Production intentionally requires an
  explicit reload; the proof does not claim automatic process replacement.

The full proof/evidence ledger lives beside the correctness contract in
`docs/features/yjs-correctness/`.
