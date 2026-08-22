# Yjs correctness evidence ledger

This ledger records the counterexample before each fix, the production rule
that closes it, and the recovery boundary when the operation cannot safely be
continued. A browser test is refinement evidence across JavaScript/Wasm/KiCad;
it is not substituted for the smaller app-free regression.

The server is deliberately absent from every normal conflict-policy row. It
never compares two valid native documents or chooses their winner; Yjs does.
It does admit one schema, migrate/compact and persist Yjs state, lint the
materialized document, and—after a repeatable invalid lint plus a known-good
checkpoint—may publish an explicit forward Yjs revert. That integrity recovery
is not an ordinary concurrent-edit policy. It is coarse and is not claimed to
preserve valid post-checkpoint work that coexists with invalid content.

## Final gate snapshot

The final `2026-08-22` verification pass was run from a clean code/test state:

| Gate | Result |
| --- | --- |
| Shared schema/conversion tests | 26 files, 303 tests passed |
| Standalone binding/controller tests | 48 files, 409 tests passed |
| Sync-service admission/persistence tests | 4 files, 43 tests passed |
| TypeScript | standalone typecheck passed; forced monorepo run passed 16/16 tasks with no cache |
| Formal | Dafny 4.11.0 discharged 72 obligations with 0 errors; regeneration was byte-identical |
| Native | C++17 protocol validator compiled under `-Wall -Wextra -Werror` and passed |
| Browser/Wasm refinement | 23/23 single-worker Chromium scenarios passed; no skip, retry or flaky result |
| Production bundle | Vite built 2,229 modules successfully |

The three app-free suites total 755 passing tests. The browser gate includes
the conflict-domain, malformed/structural recovery, two-tab replication,
lifecycle, real-Y.Doc roundtrip and exact native-rebase specs.

| Property | Red evidence | Green rule and app-free evidence | Integration / browser-Wasm evidence | Recovery / non-claim |
| --- | --- | --- | --- | --- |
| Concurrent cold seed is one complete document | `pcbjam-shared@b14f962`: losing-seed items/definitions survived independently | `pcbjam-shared@2e3a401`: detached v3 state selected through one `active` register; all delivery orders, duplicates and batches | `ysync-two-tab`: two divergent simultaneous seeders plus a third late joiner materialize the same one whole epoch | malformed/missing authored epoch is quarantined; pristine observer-created empty root remains seedable |
| Same layout head is one complete group | `pcbjam-shared@b14f962`: concurrent `paper` replacement could coexist | `pcbjam-shared@2e3a401`: plain per-head register; same head selects one authored group and distinct heads merge | `4de887e`: concurrent complete PL `setup` replacements select one parsed authored group, terminalize structural hot-apply and survive an explicitly created fresh native save | a non-item head cannot be hot-applied by the item bridge; production asks the user to reload from Y |
| Same-UUID creation cannot duplicate or hybridize a root | `pcbjam-shared@dfca9d9`: one intact item plus two `version` slots | `pcbjam-shared@b0789a4`: non-item seed is immutable, per-head groups are atomic and the root UUID sequence is only an ordering hint | `78e4c80` schematic wire-vs-text and `6790a28` PL rect-vs-tbtext each serialize one complete authored item with one UUID and reach a fixed point | duplicate/stale ordering hints are deterministically removed during canonical projection |
| Anonymous nested sequences do not acquire fake identity | `pcbjam-shared@afce5f5` and `@38a3503`: insert/edit and leading-atom histories manufactured hybrids | `pcbjam-shared@2e3a401`: anonymous repetitions/positional atoms are one register; semantic identities are explicitly audited | `4de887e`: real pcbnew `gr_poly` `pts` insert-vs-edit projects exactly the complete left or right numeric sequence | same-domain conflict selects one whole authored value; lossless merge is intentionally not claimed |
| Same library ID is one complete definition | no new defect: v3 already used one plain value per definition ID | `pcbjam-shared@0a7c8b9`: distinct IDs both survive; a same-ID conflict selects the complete left or right string in either delivery order | `4de887e`: Eeschema selects one complete `Device:R` semantic marker pair and an explicitly created fresh native instance saves the same winner | native formatting is normalized; semantic definition equivalence, not byte identity, is the oracle |
| Stale native snapshot cannot roll back newer Y | `1eb097e`: two-snapshot publication restored an unchanged stale field | `fc4519d` + `4e0aee6`: exact acknowledged shadow plus pure base/local/current three-way rebase; `native-rebase.test.ts` exercises the exact cases | `30e9478`: one production submission is held before Wasm, then a genuine stale pcbnew `BOARD_COMMIT` endpoint edit preserves both its endpoint and Y's newer disjoint width; explicit fresh native has zero drift | the ambiguous in-flight emission still retires the old owner after publishing both intents; an unknown/absent base is never guessed |
| Parent/reference graph is closed and traversal terminates | `pcbjam-shared@b14f962` and `@b063805`: orphan, duplicate ref, cycle, UUID mismatch and prototype-key cases | total analyzer + deterministic idempotent canonicalizer; Dafny rank/reference model; deterministic malformed cases and all six delivery orders | native lifecycle E2E rejects unresolved parents, malformed suffixes and identity overlap without partial mutation | invalid raw Y stays behind last-good native state until a valid replacement or room repair |
| Malformed/future Y authority is observable and recovery-specific | `4bd37b2`: live malformed Y only logged; `5de3b2b`: fresh join mislabeled it as a native-baseline reload | `2077007` + `eb78fc0`: one centralized classifier emits `invalid-y-state/materialization-failed/repair-yjs-before-recreate`, or `unsupported-y-version/unsupported-version/upgrade-client`, and retires ingress exactly once | `f3636bb`: real Wasm stays byte-identical/inert, immediate fresh join reports repair-first, corrective Y restores materialization, then a fresh owner has zero drift | arbitrary malformed CRDT state is not guessed or auto-repaired; a privileged corrective update is required before reload, while future schema requires a newer client |
| Native preflight and applied ACK are atomic | `e4411a1`, `96b4626`, `c6fde85`: valid prefix, overlap or unresolved parent could reach mutation | `fc4519d`: parse/shape/UUID/root-lift/parent preflight before mutation; standalone C++ validator; `applied` only after complete prepared commit | real-Wasm mixed valid+invalid preflight leaves the exact prior model | an exception after staging begins has unknown outcome and is terminal; rollback of that retired instance is not claimed |
| Native completion means committed, not queued | `49485be`: fire-and-forget return was mistaken for completion | `fc4519d`: owner/request ticket resolves only from post-commit native ACK; exact submitted wire advances the shadow | held real-Wasm apply proves no early completion and exactly one ACK | only explicit `busy`/`unavailable` or known pre-entry failure retries; timeout/trap/unknown state is terminal |
| Native emission during an apply has an explicit causal boundary | `13b6d41`: a normalization emitted before ACK caused a second projection and could loop | `bb00320`: generated Dafny `decideNativeEmission` preserves parseable intent in Y, then terminalizes exactly once; app-free controller regression | `587fc5d`: parked real-Wasm apply, injected parseable emission, absorbing old owner and explicitly created fresh instance with a null full-document drift report | causal before/after order is unknowable; same-instance synchronization is deliberately not claimed |
| Projection queue is bounded and latest-wins | `1eb097e`, `274b9c3`: delayed/failing apply could lose or accumulate desired state | `4e0aee6` + formal `167eb38`: one flight, one latest desired revision and an explicit no-flight retry-wait/timer transition; generated `decideProjectionAck`; burst/latest-only tests | held native-commit E2E crosses the queued/committed boundary | real `busy` is deferred by the JSPI scheduler before native entry and `unavailable` has no reversible same-owner hook, so latest-only retry remains app-free rather than a synthetic Wasm test; timer fairness is trusted |
| Document generations are isolated | `4e88244`, `7ae7337`, `ba81e8a`: stale owner/open/apply completion could cross documents or time out while parked | `fc4519d`: native owner generation, request IDs, open/apply barrier and ACK deadline only after native entry; stale owner/request tests | real-Wasm lifecycle barrier drains and ACKs an accepted apply before open | stale owner/request rejection itself is app-free; this JSPI build's post-apply in-place load is recreate-only |
| Non-item structural drift cannot leave native silently stale | `274b9c3`: item-only projection policy lacked a fail-stop refinement | `4e0aee6`: native/Y non-item signatures must match; later changes are absorbing after `non-item-structure` terminalization | `0564f5f` plus `4de887e`: layout, library and root-structure changes fail closed, absorb later updates and succeed in an explicitly created fresh native instance | the old instance is intentionally stale and inert; production recovery requires the `Reload` action |
| Schema meanings cannot mix in one document room | `pcbjam-shared@f6cab59`; outer `b46023a`, `cd59da9`, `59406f6` | outer `ada9930` + client `1792ea6`: protocol v3 in subscriptions/room IDs; gateway and direct-room reject missing/legacy/future versions with 409 before relay/auth | gateway unit/integration and direct-room Playwright API coverage; this boundary does not involve the editor/Wasm | incompatible clients are refused; presence stays unversioned; the server does not select document values |
| Merely observing an empty v3 root does not poison initialization | `pcbjam-shared@6618a90`, pcbjam `2d71845` | `pcbjam-shared@58885ec`: unauthored empty root is absence; stamped/mutated missing-active root still fails closed | simultaneous empty drawing-sheet seeds plus a late joiner | raw deletion of all compatibility evidence is outside authenticated-client operations and is quarantined when detectable |
| Native items → Yjs → native items crosses the real boundary | `b1cdbb1`: previous “roundtrip” bypassed `Y.Doc` | `b95e295`: native item wire → Slot graph → real Y.Doc → wire → fresh native instance | four real-Y.Doc Chromium item roundtrips (PL, schematic, PCB footprint containment and PCB items) plus two wire-dialect checks | non-item structure is covered separately; generic drift comparison can miss some pure positional-tuple reorder, so this is finite structural evidence rather than a universal theorem |
| Confirmed-invalid server recovery is an explicit Yjs forward operation | existing invalidity/revert regressions | fresh re-materialization + repeat lint + `.good` checkpoint + recorded revert metadata; `computeRevertUpdate` emits a normal Yjs update | outer `revert.spec.ts` exercises full service recovery | this coarse checkpoint rewrite is not proved intent-preserving and may reset valid post-checkpoint domains; disable/redesign it if no server-authored correction is the literal policy |
| Persistence does not regress under overlapping saves | existing reverse-completion regression | ordered latest-snapshot save lane and explicit last-close flush | outer sync-service integration tests; no editor/Wasm refinement is involved | infrastructure loss inside an unacknowledged debounce is not advertised as durable |

Where a red commit is listed, the identifier intentionally keeps the failing
state in history. To audit a fix, run its focused assertion at that red commit,
then at the listed green commit; the regression is retained rather than
replaced by a mock or an expected-failure marker. Rows explicitly marked as
policy characterization did not expose a new production defect. Unless a row
explicitly names an E2E red, its browser/Wasm scenario is later green refinement
evidence, not the same spec preserved at the production-red commit.
