# pcbjam Yjs/native sync compared with y-prosemirror

Measured on 2026-08-22. Code LOC means nonblank lines after stripping line and
block comments while preserving strings and regular-expression literals.
Generated Dafny JavaScript is reported separately and excluded from the
repo-owned source total: the audited source is the Dafny model plus its pinned,
byte-comparing generator.

## Size of the correctness surface

| Layer | Physical LOC | Code LOC | What must be understood |
| --- | ---: | ---: | --- |
| Shared Y schema and conversion | 3,482 | 2,371 | parsing, slot identity, v3 epochs, graph validity, deltas, wire validation, native rebase |
| Browser synchronization algorithms | 1,281 | 993 | acknowledged shadow, one-flight projection, generated decisions, retry/fail-stop |
| Browser lifecycle, sheet adapter and recovery host | 4,028 | 2,895 | owner isolation, open/apply barriers, sheet switching, terminal UI and recovery |
| Native C++ integration files (conservative) | 7,218 | 4,653 | snapshot/emit, preflight validation, atomic apply, ownership and adjacent editor bindings |
| Client gateway/schema boundary | 1,325 | 863 | versioned subscriptions, gateway wire and document admission |
| Dafny model and generator | 824 | 678 | update algebra, admission, epochs, rebase, graph and projection policies |

The algorithmic TypeScript core—the first two rows—is **3,364 code lines**. That
is the smallest useful reading set for understanding the representation,
conflict domains, rebase and projection controller. A conservative audit of
the complete 26-file repo-owned production/formal integration boundary is
**18,158 physical / 12,453 code lines**. This includes the whole `WasmTool`
recovery host because malformed-authority classification is observable there.
The C++ and host numbers deliberately count complete integration files,
including adjacent editor-binding/UI code, so the count is reproducible rather
than dependent on subjective line slicing. On the earlier comparable 25-file
manifest that omitted the whole `WasmTool` host, the current result is **14,911
/ 10,066**; most of the apparent scope jump is that newly explicit inclusion,
not code added by these fixes.

“Understand it fully” cannot literally stop at repository code. Yjs's CRDT,
the JavaScript/WebAssembly runtime and KiCad parser/writer are trusted
dependencies. The focused 35-file evidence corpus is **9,477 physical / 7,815
code lines**. Adding it to the conservative production/formal boundary gives a
defensible end-to-end audit surface of **27,635 physical / 20,268 code lines**.
The broader 54-file collaboration corpus is **12,365 / 10,148**, for **30,523 /
22,601** with production/formal source. These evidence sets are alternatives—
the focused set is contained in the broad set—not additional rows to sum
together.

The generated Dafny JavaScript and declaration are **2,308 / 2,218** and are
excluded from those totals. Include the extra 2,218 code lines only if the audit
also reviews compiler output rather than regenerating and byte-comparing it.

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
  -> wait for an owner/request acknowledgement
  -> retry, fail-stop, or rehydrate
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
| Formal evidence | Dafny policy model and generated acknowledgement/emission decisions | The repository ships tests and architectural reasoning, but no formal proof artifact |

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
can retain its separate admission/persistence/lint and invalid-checkpoint
recovery duties without interpreting ordinary conflicts. The cost is explicit:
compatible edits inside the same footprint, symbol, or other root no longer
both survive.

If same-root compatible edits must survive, there is no equally simple
snapshot-based design. The robust long-term analogue of y-prosemirror is to
instrument KiCad's commit layer to emit semantic operations with durable
identities (`set field`, `insert/delete/move child`, `replace atomic sequence`)
and apply those operations directly to Yjs. This costs more native work up
front, but removes inferred intent and most three-way snapshot rebasing.

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
