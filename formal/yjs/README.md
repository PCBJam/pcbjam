# Yjs correctness model

This directory contains the small formally verified core of pcbjam's Yjs/native
projection protocol. It is intentionally narrower than the application: proofs
are useful only when their abstraction boundary is explicit.

## What is proved

`YjsProperties.dfy` has four policy modules and one executable controller:

| Module | Verified obligation |
| --- | --- |
| `UpdateAlgebra` | Delivery duplication is idempotent and merging an identical update set is associative, commutative, and idempotent. |
| `RoomAdmission` | Two clients admitted to the current document room cannot use different schema versions. |
| `AtomicEpoch` | Seed arbitration selects one complete epoch, is order-independent for unique Yjs operation identities, and never constructs a cross-seed hybrid. |
| `NativeRebase` | An unchanged native conflict domain preserves current Y state; a changed domain preserves local intent; disjoint edits commute and retain both effects. It also proves the counterexample that two writes to one scalar domain do **not** commute. |
| `ProjectionKernel` | Owner/request isolation, one-flight/latest-dirty coalescing, monotone successful application, latest-only retry, terminal fail-stop, and clean owner rehydration preserve the controller invariant. |

The exported acknowledgement decision is compiled by Dafny to JavaScript. The
standalone application imports and executes that generated function; the
32-case test enumerates its complete Boolean input space.

## Verify and regenerate

The generator requires exactly Dafny
`4.11.0+fcb2042d6d043a2634f0854338c08feeaaaf4ae2` and refuses a different
compiler. The official `dafny-4.11.0-arm64-macos-13.zip` archive used for this
work has SHA-256:

```text
c90c75e7d5db9c6ccbb7127840dfe43f0ac938b039a7ebed146d8ead383a572f
```

With `dafny` on `PATH`:

```sh
pnpm --filter @pcbjam/standalone formal:yjs:check
pnpm --filter @pcbjam/standalone formal:yjs:generate
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
connected to these abstractions by differential/property tests and real
KiCad/Wasm end-to-end tests.

In particular, there is no theorem saying every editor action commutes. That is
impossible for concurrent writes to one single-valued field. The implemented
contract is:

- independent declared conflict domains preserve both edits;
- a native snapshot is rebased from its acknowledged base onto current Y state;
- true same-domain conflicts are published to Yjs and use Yjs's deterministic
  register winner;
- incompatible codecs are rejected before joining a room; and
- a terminal projection failure stops applying and rehydrates a fresh native
  owner from canonical Y state.

The full proof/evidence ledger lives beside the correctness contract in
`docs/features/yjs-correctness/`.
