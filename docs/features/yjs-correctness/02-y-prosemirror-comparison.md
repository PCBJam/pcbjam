# pcbjam Yjs/native sync compared with y-prosemirror

Measured on 2026-08-23. Code LOC means nonblank lines after stripping line and
block comments while preserving strings and regular-expression literals.
Generated Dafny JavaScript is reported separately and excluded from the
repo-owned source total: the audited source is the Dafny model plus its pinned,
byte-comparing generator.

## Size of the correctness surface

| Layer | Physical LOC | Code LOC | What must be understood |
| --- | ---: | ---: | --- |
| Shared Y schema and conversion | 3,492 | 2,371 | slot identity, v3 epochs, graph validity, deltas, wire validation, native rebase |
| Browser synchronization algorithms | 1,565 | 1,210 | acknowledged shadow, one-flight projection, library coverage, generated decisions, retry/fail-stop |
| Browser lifecycle, sheet adapter and recovery host | 4,028 | 2,895 | owner isolation, open/apply barriers, sheet switching, terminal UI and recovery |
| Native C++ integration files (conservative) | 7,260 | 4,686 | complete PCB root iterator, snapshot/emit, preflight, temporary-board ownership, save drain and adjacent bindings |
| Client gateway/schema boundary | 1,342 | 870 | versioned subscriptions, reconnect upload, gateway wire and document admission |
| Dafny model and generator | 1,126 | 943 | update algebra, admission, epochs, rebase, graph, projection and save-cut policies |

The measured six-row manifest is **18,813 physical / 12,975 code lines**. Its
shared row accidentally omitted the small tokenizer/parser `sexpr.ts`
(**96 / 72**). The corrected complete boundary is therefore **18,909 physical /
13,047 code lines**.

The smallest useful algorithm reading set is the first two rows plus that
parser: **5,153 physical / 3,653 code lines**. It covers representation,
conflict-domain classification, native three-way rebase, structural/library
coverage and the asynchronous projection controller. A syntactic audit of the
11 central TypeScript files found 338 functions and 859 decision-like sites;
this is not cyclomatic complexity, but it explains why reading only a single
`sync()` function cannot establish correctness. At least six interacting
protocol concerns remain: seed epoch, update convergence, local intent rebase,
native FIFO/ACK, lifecycle/fail-stop and save/durability.

The C++ and lifecycle-host rows deliberately count complete integration files,
including adjacent editor binding/UI code. That makes the count reproducible
instead of depending on subjective line slicing. It also means the full total
is a conservative maintenance boundary, not 13,047 lines of dense CRDT logic.

“Understand it fully” cannot literally stop at repository code. Yjs's CRDT,
the JavaScript/WebAssembly runtime and KiCad parser/writer are trusted
dependencies. The proof plus focused regression corpus pushes the practical
review surface above 20,000 code lines. Generated Dafny JavaScript/declarations
are excluded: the intended audit is the Dafny source, pinned compiler/generator
and byte-comparison, not a manual review of compiler output.

For comparison, stable `y-prosemirror` v1.3.7 at commit
`f89fadd2a8bf15c0c7e6bfcac268883a5fa4e0f8` is **1,800 physical / 1,219 code
lines** for core synchronization/conversion and public-key glue, or **2,192 /
1,502** including cursor and undo, plus **1,152 / 931** test lines. The unstable
rewrite published as `@y/prosemirror` v2.0.0-8 for Yjs v14, pinned here at
commit `67bc372417954d61771d137c4010c41f535535e6`, is **3,094 / 1,635** across
all 12 source files and **7,020 / 4,640** across all 17 tests.

These are not quality-per-line scores. pcbjam's count includes C++, lifecycle,
schema admission and formal policy that `y-prosemirror` does not need; the
`y-prosemirror` count excludes ProseMirror and Yjs themselves. The comparison
measures integration burden, not correctness or design quality.

As a reading estimate, pcbjam's 3,653-line algorithm core is about **3.0×** the
stable y-prosemirror 1,219-line core. The corrected 13,047-line full integration
boundary is about **10.7×**, but that ratio is deliberately apples-to-oranges:
it charges pcbjam for C++, Wasm lifecycle, schema admission, save ordering and
formal policy while charging y-prosemirror for none of ProseMirror, Yjs or the
browser runtime beneath it.

## Why pcbjam is larger

```text
pcbjam

native KiCad commit
  -> full root-item s-expression wire
  -> parse and flatten into a UUID graph
  -> infer local intent against an acknowledged native shadow
  -> three-way rebase onto current Y state
  -> write a versioned v3 Yjs state
  -> distribute Yjs updates
  -> validate/canonicalize the peer's desired graph
  -> submit one queued native projection
  -> preflight + rebind board-owned references + native commit
  -> wait for an owner/request acknowledgement
  -> retry, fail-stop, or explicitly reload
  -> drain accepted projection work before native save
```

```text
y-prosemirror

committed ProseMirror transaction/view update
  <-> synchronous binding, mapping and delta conversion
  <-> Y.XmlFragment / Y.XmlElement / Y.XmlText
```

ProseMirror already supplies a transaction model, schema validation, positions,
synchronous dispatch, and a document tree close to Yjs's XML types. KiCad
instead exposes an opaque mutable C++ model through delayed Wasm calls and
serialization snapshots. Consequently pcbjam must supply identity policy,
intent recovery, graph closure, acknowledgement and lifecycle isolation itself.

| Concern | pcbjam | y-prosemirror |
| --- | --- | --- |
| Shared representation | Versioned KiCad graph: UUID items, a small audited set of semantic field identities, ambiguous sequences kept atomic | Y XML tree mirrors ProseMirror nodes and text |
| Local intent | Reconstructed from a native snapshot relative to an acknowledged shadow | Observed immediately from committed, schema-valid ProseMirror view state and mapped to identity-preserving Y XML; there is no delayed cross-language snapshot/ACK window |
| Identity | UUID roots survive native roundtrips; arbitrary nested identities do not | Y XML nodes retain CRDT identity and the binding maps Y types to ProseMirror nodes |
| Remote projection | Cross-language, queued, asynchronous and fallible | Synchronous ProseMirror dispatch guarded by binding/origin logic |
| Invalid state | Version gate, whole-batch validation, graph canonicalization, quarantine or reload | Conversion must produce a schema-valid ProseMirror document; recovery/normalization is propagated through the binding rather than claiming that arbitrary raw Y nodes are simply removed |
| Initialization | One active epoch selects a complete seed | The authoritative Y type is bound to the editor; initialization is schema-aware |
| Same-domain conflict | One complete authored value wins through Yjs | Y text/tree semantics plus ProseMirror normalization |
| Save/durability | Native projection drain, writer chokepoint, backend persistence frontier | Outside the binding; the host persists application state |
| Recovery | Explicit fresh Wasm owner from canonical Y; malformed Y must be repaired first | Recreate/reconfigure the editor view from the bound Y fragment as the host permits |
| Formal evidence | Dafny policy model and generated ACK, structural, emission and save-cut classifiers | The repository ships tests and architectural reasoning, but no formal proof artifact |

Neither system proves that arbitrary high-level user operations commute.
ProseMirror's server-sequenced `prosemirror-collab` plugin rebases steps through
a mapping; y-prosemirror instead embeds editor structure in Yjs CRDT types.
pcbjam reconstructs semantic intent from delayed snapshots. In all three cases,
“order does not matter” must be stated at the correct layer: the same Yjs update
set converges, while conflicting writes to one logical value still require one
deterministic visible result.

Using ProseMirror as an intermediate representation would not eliminate
pcbjam's KiCad snapshot identity or asynchronous acknowledgement problems and
would add a third projection. It might simplify some schema/tree manipulation,
but establishing a net simplification would require a prototype rather than a
LOC inference.

## Simpler Yjs-only designs

The simplest robust snapshot design is **root atomicity**:

```text
active epoch
  roots      Y.Map<root UUID, complete native s-expression blob>
  globals    Y.Map<semantic head, complete value>
  libraries  Y.Map<library ID, complete definition>
  order      one atomic normalized value
```

Distinct root UUIDs still merge independently. Two concurrent writes to one
root select one whole authored blob, so nested identity inference, hybrid child
merges and most parent repair disappear. The client still needs a root-level
acknowledged-shadow rebase, epochs, schema admission and the asynchronous ACK /
fail-stop controller; atomic roots do not establish the causal order of a stale
native snapshot. Yjs still selects every valid concurrent winner; the server
remains limited to admission, persistence, validated reads and report-only
lint. The cost is explicit: compatible edits inside the same footprint, symbol,
or other root no longer both survive.

If same-root compatible edits must survive, there is no equally simple
snapshot-based design. The robust long-term analogue of y-prosemirror is to
instrument KiCad's commit layer to emit semantic operations with durable
identities (`set field`, `insert/delete/move child`, `replace atomic sequence`)
and apply those operations directly to Yjs. This costs more native work up
front, but removes inferred intent and most three-way snapshot rebasing.

| Direction | Simplicity | Concurrent intent retained | Native work | Recommendation |
| --- | --- | --- | --- | --- |
| Current conservative slot graph | Medium/low | UUID roots and audited fields; anonymous sequences atomic | Existing bridge plus continuing grammar/root/reference audits | Keep while compatibility requires the current document format |
| Atomic root blobs | Highest near-term | Different roots merge; same-root edits conflict as one value | Smaller parser/schema surface, same ACK/save lifecycle | Best simplification if product accepts same-root conflicts |
| Native semantic operations | Lowest initially, highest long-term robustness | Can retain same-root edits where operations have durable identity | Instrument KiCad commits and define operation schema | Best long-term analogue of y-prosemirror |
| ProseMirror intermediate | Low confidence | Does not create missing KiCad identities | Adds a third model/projection | Not recommended without a prototype showing a concrete reduction |

No option removes the native FIFO/ACK, lifecycle isolation, save cut, schema
admission or explicit reload boundary. Those exist because KiCad is an
asynchronous mutable native model, not because the Yjs schema happens to use
slots.

## Primary references

- [Stable y-prosemirror v1.3.7 README and conversion contract](https://github.com/yjs/y-prosemirror/blob/v1.3.7/README.md)
- [Stable v1.3.7 source](https://github.com/yjs/y-prosemirror/tree/v1.3.7/src)
- [Stable sync implementation](https://github.com/yjs/y-prosemirror/blob/v1.3.7/src/plugins/sync-plugin.js)
- [Repository status: stable v13 and unstable v14 rewrite](https://github.com/yjs/y-prosemirror)
- [Rewrite architecture](https://github.com/yjs/y-prosemirror/blob/master/ARCHITECTURE.md)
- [Rewrite caveats](https://github.com/yjs/y-prosemirror/blob/master/CAVEATS.md)
- [Yjs document update API](https://docs.yjs.dev/api/document-updates)
- [Y.Map API](https://docs.yjs.dev/api/shared-types/y.map)
- [Yjs nested shared-type rules](https://docs.yjs.dev/getting-started/working-with-shared-types)
