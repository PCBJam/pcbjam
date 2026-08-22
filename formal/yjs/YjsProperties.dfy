// Pure protocol obligations for pcbjam's Yjs/native projection boundary.
//
// This model deliberately does not reimplement Yjs.  `UpdateReplica` models
// the trusted Yjs premise that a replica's durable state is determined by the
// set of uniquely identified CRDT updates it has received.  The theorems below
// prove the pcbjam policies layered on that premise.

module UpdateAlgebra {
  datatype Replica = Replica(seen: set<nat>)

  function Deliver(r: Replica, update: nat): Replica
  {
    Replica(r.seen + {update})
  }

  function Merge(a: Replica, b: Replica): Replica
  {
    Replica(a.seen + b.seen)
  }

  lemma DuplicateDeliveryIsIdempotent(r: Replica, update: nat)
    ensures Deliver(Deliver(r, update), update) == Deliver(r, update)
  {}

  lemma MergeIsCommutative(a: Replica, b: Replica)
    ensures Merge(a, b) == Merge(b, a)
  {}

  lemma MergeIsAssociative(a: Replica, b: Replica, c: Replica)
    ensures Merge(Merge(a, b), c) == Merge(a, Merge(b, c))
  {}

  lemma MergeIsIdempotent(a: Replica)
    ensures Merge(a, a) == a
  {}

  lemma SameUpdateSetHasSameProjection(a: Replica, b: Replica)
    requires a.seen == b.seen
    ensures a == b
  {}
}

module RoomAdmission {
  function Admitted(clientSchema: nat, roomSchema: nat): bool
  {
    clientSchema == roomSchema
  }

  lemma AdmittedClientsCannotMixSchemas(a: nat, b: nat, current: nat)
    requires Admitted(a, current)
    requires Admitted(b, current)
    ensures a == b
  {}

  lemma AVersionMismatchIsRejected(client: nat, current: nat)
    requires client != current
    ensures !Admitted(client, current)
  {}
}

module AtomicEpoch {
  // `stamp` abstracts Yjs's globally unique operation identifier.  The other
  // fields stand for independently stored document roots.  Selecting a Seed
  // value rather than each field separately is the active-epoch rule that
  // prevents a cold-start hybrid.
  datatype Seed = Seed(stamp: nat, layout: int, items: int, libraries: int)

  predicate CompatibleIdentity(a: Seed, b: Seed)
  {
    a.stamp != b.stamp || a == b
  }

  function Select(a: Seed, b: Seed): Seed
  {
    if a.stamp >= b.stamp then a else b
  }

  lemma SelectionIsWhole(a: Seed, b: Seed)
    ensures Select(a, b) == a || Select(a, b) == b
  {}

  lemma SelectionIsCommutative(a: Seed, b: Seed)
    requires CompatibleIdentity(a, b)
    ensures Select(a, b) == Select(b, a)
  {}

  lemma SelectionIsIdempotent(a: Seed)
    ensures Select(a, a) == a
  {}

  lemma SelectionIsAssociative(a: Seed, b: Seed, c: Seed)
    requires CompatibleIdentity(a, b)
    requires CompatibleIdentity(a, c)
    requires CompatibleIdentity(b, c)
    ensures Select(Select(a, b), c) == Select(a, Select(b, c))
  {}
}

module NativeRebase {
  // One value is one declared conflict domain.  A native snapshot conveys
  // intent only where local differs from its acknowledged base.  An unchanged
  // local domain preserves the latest Yjs value; a changed local domain is
  // published back to Yjs, whose register then provides deterministic CRDT
  // arbitration against genuinely concurrent changes.
  function RebaseDomain(base: int, local: int, current: int): int
  {
    if local == base then current else local
  }

  datatype Snapshot = Snapshot(first: int, second: int)

  function Rebase(base: Snapshot, local: Snapshot, current: Snapshot): Snapshot
  {
    Snapshot(
      RebaseDomain(base.first, local.first, current.first),
      RebaseDomain(base.second, local.second, current.second))
  }

  lemma NoLocalIntentPreservesCurrent(base: int, current: int)
    ensures RebaseDomain(base, base, current) == current
  {}

  lemma LocalIntentSurvives(base: int, local: int, current: int)
    requires local != base
    ensures RebaseDomain(base, local, current) == local
  {}

  lemma RebaseIsIdempotent(base: Snapshot, local: Snapshot, current: Snapshot)
    ensures Rebase(base, local, Rebase(base, local, current))
         == Rebase(base, local, current)
  {}

  lemma DisjointNativeEditsCommute(base: Snapshot, localFirst: int,
                                   localSecond: int)
  {
    var editFirst := Snapshot(localFirst, base.second);
    var editSecond := Snapshot(base.first, localSecond);
    assert Rebase(base, editFirst, Rebase(base, editSecond, base))
        == Rebase(base, editSecond, Rebase(base, editFirst, base));
  }

  lemma DisjointNativeEditsPreserveBoth(base: Snapshot, localFirst: int,
                                        localSecond: int)
    ensures Rebase(base,
                   Snapshot(localFirst, base.second),
                   Snapshot(base.first, localSecond))
         == Snapshot(localFirst, localSecond)
  {}

  // This is an intentional counter-theorem: two different writes to the same
  // conflict domain cannot both survive as a single scalar.  Their sequential
  // application order differs; concurrent publication is therefore delegated
  // to the Yjs register's deterministic operation-ID order.
  lemma SameDomainConflictsDoNotCommute()
    ensures RebaseDomain(0, 1, RebaseDomain(0, 2, 0))
         != RebaseDomain(0, 2, RebaseDomain(0, 1, 0))
  {}
}

module ConflictDomains {
  // One register is one complete authored value in one declared semantic
  // conflict domain. `stamp` abstracts Yjs's globally ordered operation ID.
  // Keeping the complete value in the register is the no-hybrid rule.
  datatype Register = Register(stamp: nat, value: int)

  predicate CompatibleIdentity(a: Register, b: Register)
  {
    a.stamp != b.stamp || a == b
  }

  function Select(a: Register, b: Register): Register
  {
    if a.stamp >= b.stamp then a else b
  }

  datatype TwoDomains = TwoDomains(first: Register, second: Register)

  function WriteFirst(s: TwoDomains, value: Register): TwoDomains
  {
    TwoDomains(Select(s.first, value), s.second)
  }

  function WriteSecond(s: TwoDomains, value: Register): TwoDomains
  {
    TwoDomains(s.first, Select(s.second, value))
  }

  lemma AConflictSelectsOneWholeAuthoredValue(a: Register, b: Register)
    ensures Select(a, b) == a || Select(a, b) == b
  {}

  lemma ConflictSelectionIsCommutative(a: Register, b: Register)
    requires CompatibleIdentity(a, b)
    ensures Select(a, b) == Select(b, a)
  {}

  lemma ConflictSelectionIsAssociative(a: Register, b: Register, c: Register)
    requires CompatibleIdentity(a, b)
    requires CompatibleIdentity(a, c)
    requires CompatibleIdentity(b, c)
    ensures Select(Select(a, b), c) == Select(a, Select(b, c))
  {}

  lemma IndependentDomainWritesCommute(s: TwoDomains,
                                       first: Register,
                                       second: Register)
    ensures WriteFirst(WriteSecond(s, second), first)
         == WriteSecond(WriteFirst(s, first), second)
  {}
}

module AtomicNativeBatch {
  // Validation/preparation is pure. The native mutation boundary receives
  // either a completely prepared next state or keeps the exact previous one.
  datatype NativeState = NativeState(digest: int)
  datatype PreparedBatch = PreparedBatch(resultDigest: int)

  function Commit(before: NativeState, prepared: PreparedBatch,
                  valid: bool): NativeState
  {
    if valid then NativeState(prepared.resultDigest) else before
  }

  lemma RejectedBatchChangesNothing(before: NativeState,
                                    prepared: PreparedBatch)
    ensures Commit(before, prepared, false) == before
  {}

  lemma AcceptedBatchCommitsTheCompletePreparedResult(before: NativeState,
                                                       prepared: PreparedBatch)
    ensures Commit(before, prepared, true)
         == NativeState(prepared.resultDigest)
  {}
}

module GraphClosure {
  datatype Owner = Root | Parent(item: nat)

  // `rank` is a well-founded certificate emitted by the pure canonicalizer:
  // every parent has a strictly smaller rank than its child. It connects the
  // practical visited-set implementation to a compact mathematical reason
  // that every parent traversal terminates.
  predicate ParentCertificate(items: set<nat>,
                              owner: map<nat, Owner>,
                              rank: map<nat, nat>)
  {
    owner.Keys == items
    && rank.Keys == items
    && forall item :: item in items ==>
      match owner[item]
        case Root => true
        case Parent(parent) =>
          parent in items && rank[parent] < rank[item]
  }

  datatype Graph = Graph(items: set<nat>,
                         owner: map<nat, Owner>,
                         references: map<nat, Owner>,
                         rank: map<nat, nat>)

  predicate Closed(g: Graph)
  {
    ParentCertificate(g.items, g.owner, g.rank)
    && g.references.Keys == g.items
    && forall item :: item in g.items ==>
      g.references[item] == g.owner[item]
  }

  function CanonicalProjection(items: set<nat>,
                               owner: map<nat, Owner>,
                               rank: map<nat, nat>): Graph
    requires ParentCertificate(items, owner, rank)
  {
    // One source of truth: reconstruct every reference from the selected
    // owner relation instead of independently merging parent and reference.
    Graph(items, owner, owner, rank)
  }

  function ParentDepth(items: set<nat>,
                       owner: map<nat, Owner>,
                       rank: map<nat, nat>,
                       item: nat): nat
    requires ParentCertificate(items, owner, rank)
    requires item in items
    decreases rank[item]
  {
    match owner[item]
      case Root => 0
      case Parent(parent) => 1 + ParentDepth(items, owner, rank, parent)
  }

  lemma CanonicalProjectionIsClosed(items: set<nat>,
                                    owner: map<nat, Owner>,
                                    rank: map<nat, nat>)
    requires ParentCertificate(items, owner, rank)
    ensures Closed(CanonicalProjection(items, owner, rank))
  {}

  lemma ACertifiedItemCannotParentItself(items: set<nat>,
                                         owner: map<nat, Owner>,
                                         rank: map<nat, nat>,
                                         item: nat)
    requires ParentCertificate(items, owner, rank)
    requires item in items
    ensures owner[item] != Parent(item)
  {}

  lemma ACertifiedGraphHasNoTwoCycle(items: set<nat>,
                                     owner: map<nat, Owner>,
                                     rank: map<nat, nat>,
                                     a: nat, b: nat)
    requires ParentCertificate(items, owner, rank)
    requires a in items && b in items
    requires owner[a] == Parent(b)
    ensures owner[b] != Parent(a)
  {}
}

module StructuralProjection {
  datatype Action = HotApplyItems | RehydrateNative

  // Root/layout drift is never expressible through the item bridge. Library
  // drift is hot-applicable only when the runtime has established that every
  // changed definition is carried by the same audited symbol-root request.
  // The coverage predicate is computed by the concrete TypeScript codec; this
  // verified classifier makes the fail-closed policy executable.
  function Decide(hardMatches: bool,
                  librariesMatch: bool,
                  allLibraryChangesCovered: bool): Action
  {
    if hardMatches && (librariesMatch || allLibraryChangesCovered)
    then HotApplyItems
    else RehydrateNative
  }

  lemma HardDriftAlwaysRehydrates(librariesMatch: bool,
                                  allLibraryChangesCovered: bool)
    ensures Decide(false, librariesMatch, allLibraryChangesCovered)
      == RehydrateNative
  {}

  lemma UncoveredLibraryDriftAlwaysRehydrates(hardMatches: bool)
    ensures Decide(hardMatches, false, false) == RehydrateNative
  {}

  lemma EqualLibrariesMayUseTheItemBridge()
    ensures Decide(true, true, false) == HotApplyItems
  {}

  lemma CoveredLibraryDriftMayUseTheItemBridge()
    ensures Decide(true, false, true) == HotApplyItems
  {}

  lemma LibrariesAreNeverBlanketIgnored(hardMatches: bool)
    ensures !hardMatches || Decide(hardMatches, false, false) == RehydrateNative
  {}

  method ExportStructuralProjectionDecision(
      hardMatches: bool,
      librariesMatch: bool,
      allLibraryChangesCovered: bool) returns (action: int)
    ensures action == 1 || action == 4
    ensures !hardMatches ==> action == 4
    ensures hardMatches && librariesMatch ==> action == 1
    ensures hardMatches && !librariesMatch && allLibraryChangesCovered ==> action == 1
    ensures hardMatches && !librariesMatch && !allLibraryChangesCovered ==> action == 4
  {
    action := match Decide(hardMatches, librariesMatch, allLibraryChangesCovered)
      case HotApplyItems => 1
      case RehydrateNative => 4;
  }
}

module DurabilityBoundary {
  datatype Store = Store(accepted: nat, durable: nat)

  ghost predicate Invariant(s: Store)
  {
    s.durable <= s.accepted
  }

  function Accept(s: Store, revision: nat): Store
    requires Invariant(s)
    requires revision >= s.accepted
    ensures Invariant(Accept(s, revision))
  {
    Store(revision, s.durable)
  }

  function Flush(s: Store): Store
    requires Invariant(s)
    ensures Invariant(Flush(s))
    ensures Flush(s).durable == s.accepted
  {
    Store(s.accepted, s.accepted)
  }

  function ReportedDurable(s: Store, revision: nat): bool
  {
    revision <= s.durable
  }

  function Restore(s: Store): nat
  {
    s.durable
  }

  lemma AReportedDurableRevisionSurvivesRestore(s: Store, revision: nat)
    requires Invariant(s)
    requires ReportedDurable(s, revision)
    ensures revision <= Restore(s)
  {}

  lemma FlushMakesEveryAcceptedRevisionDurable(s: Store, revision: nat)
    requires Invariant(s)
    requires revision <= s.accepted
    ensures ReportedDurable(Flush(s), revision)
  {}
}

module ProjectionKernel {
  datatype Action = Ignore | Idle | StartLatest | RetryLatest | Terminal
  datatype Flight =
    NoFlight
    | InFlight(owner: nat, request: nat, revision: nat)
    | RetryWait(owner: nat, timer: nat, revision: nat)
  datatype State = State(
    owner: nat,
    desired: nat,
    applied: nat,
    nextRequest: nat,
    nextTimer: nat,
    flight: Flight,
    dirty: bool,
    terminal: bool)

  ghost predicate Invariant(s: State)
  {
    s.applied <= s.desired
    && (s.terminal ==> s.flight.NoFlight? && !s.dirty)
    && (s.flight.NoFlight? ==> !s.dirty)
    && (s.flight.InFlight? ==>
      s.flight.owner == s.owner
      && s.applied <= s.flight.revision <= s.desired
      && s.flight.request <= s.nextRequest
      && (s.dirty <==> s.flight.revision < s.desired))
    && (s.flight.RetryWait? ==>
      s.flight.owner == s.owner
      && s.applied <= s.flight.revision
      && s.flight.revision == s.desired
      && s.flight.timer <= s.nextTimer
      && s.dirty)
  }

  function Request(s: State, revision: nat): State
    requires Invariant(s)
    ensures Invariant(Request(s, revision))
  {
    if s.terminal || revision <= s.desired then s
    else match s.flight
      case NoFlight =>
        State(s.owner, revision, s.applied, s.nextRequest + 1, s.nextTimer,
              InFlight(s.owner, s.nextRequest + 1, revision), false, false)
      case InFlight(_, _, _) =>
        State(s.owner, revision, s.applied, s.nextRequest, s.nextTimer,
              s.flight, true, false)
      case RetryWait(_, _, _) =>
        // A new desired revision cancels the pending retry timer and starts
        // that new latest state immediately, exactly like requestProjection().
        State(s.owner, revision, s.applied, s.nextRequest + 1, s.nextTimer,
              InFlight(s.owner, s.nextRequest + 1, revision), false, false)
  }

  function RehydrateOwner(s: State): State
    requires Invariant(s)
    ensures Invariant(RehydrateOwner(s))
    ensures RehydrateOwner(s).owner > s.owner
    ensures RehydrateOwner(s).applied == s.desired
    ensures RehydrateOwner(s).flight.NoFlight?
    ensures !RehydrateOwner(s).terminal
  {
    State(s.owner + 1, s.desired, s.desired, s.nextRequest, s.nextTimer,
          NoFlight, false, false)
  }

  function AckDecision(ownerMatches: bool, requestMatches: bool,
                       dirty: bool, ok: bool, retryable: bool): Action
  {
    if !ownerMatches || !requestMatches then Ignore
    else if ok && dirty then StartLatest
    else if ok then Idle
    else if retryable then RetryLatest
    else Terminal
  }

  // Native item emissions are ordered with respect to acknowledged projection
  // tickets. An emission observed while a ticket is still in flight has no
  // trustworthy before/after relation to that ticket: treating it as either
  // side of the acknowledged shadow can manufacture an infinite normalization
  // echo or swallow a concurrent local edit. Preserve the emitted intent at
  // the data layer, then retire this native generation.
  function NativeEmissionDecision(projectionInFlight: bool): Action
  {
    if projectionInFlight then Terminal else Idle
  }

  function Ack(s: State, ackOwner: nat, ackRequest: nat,
               ok: bool, retryable: bool): (State, Action)
    requires Invariant(s)
    ensures Invariant(Ack(s, ackOwner, ackRequest, ok, retryable).0)
  {
    match s.flight
      case NoFlight => (s, Ignore)
      case InFlight(inOwner, inRequest, inRevision) =>
        if ackOwner != s.owner || ackOwner != inOwner || ackRequest != inRequest then
          (s, Ignore)
        else if ok && s.dirty then
          (State(s.owner, s.desired, inRevision, s.nextRequest + 1, s.nextTimer,
                 InFlight(s.owner, s.nextRequest + 1, s.desired), false, false),
           StartLatest)
        else if ok then
          (State(s.owner, s.desired, inRevision, s.nextRequest, s.nextTimer,
                 NoFlight, false, false), Idle)
        else if retryable then
          // The real controller has no native request in flight during
          // backoff. It retains the latest desired revision behind one timer.
          (State(s.owner, s.desired, s.applied, s.nextRequest, s.nextTimer + 1,
                 RetryWait(s.owner, s.nextTimer + 1, s.desired), true, false),
           RetryLatest)
        else
          (State(s.owner, s.desired, s.applied, s.nextRequest, s.nextTimer,
                 NoFlight, false, true), Terminal)
      case RetryWait(_, _, _) => (s, Ignore)
  }

  // A retry callback is owner/timer scoped. A cleared or stale callback is an
  // identity transition; the matching live timer starts one request for the
  // exact latest revision retained during the wait interval.
  function RetryTimer(s: State, timerOwner: nat, timer: nat): (State, Action)
    requires Invariant(s)
    ensures Invariant(RetryTimer(s, timerOwner, timer).0)
  {
    match s.flight
      case RetryWait(waitOwner, waitTimer, waitRevision) =>
        if timerOwner != s.owner || timerOwner != waitOwner || timer != waitTimer then
          (s, Ignore)
        else
          (State(s.owner, s.desired, s.applied, s.nextRequest + 1, s.nextTimer,
                 InFlight(s.owner, s.nextRequest + 1, waitRevision), false, false),
           StartLatest)
      case _ => (s, Ignore)
  }

  lemma StaleOwnerAckIsIdentity(s: State, ackOwner: nat, ackRequest: nat,
                                ok: bool, retryable: bool)
    requires Invariant(s)
    requires ackOwner != s.owner
    ensures Ack(s, ackOwner, ackRequest, ok, retryable) == (s, Ignore)
  {}

  lemma StaleRequestAckIsIdentity(s: State, ackRequest: nat,
                                  ok: bool, retryable: bool)
    requires Invariant(s)
    requires s.flight.InFlight?
    requires ackRequest != s.flight.request
    ensures Ack(s, s.owner, ackRequest, ok, retryable) == (s, Ignore)
  {}

  lemma BusyRequestCoalesces(s: State, revision: nat)
    requires Invariant(s)
    requires s.flight.InFlight?
    requires revision > s.desired
    ensures Request(s, revision).flight == s.flight
    ensures Request(s, revision).desired == revision
    ensures Request(s, revision).dirty
  {}

  lemma MatchingSuccessNeverRegresses(s: State, ackOwner: nat, ackRequest: nat)
    requires Invariant(s)
    requires s.flight.InFlight?
    requires ackOwner == s.owner == s.flight.owner
    requires ackRequest == s.flight.request
    ensures Ack(s, ackOwner, ackRequest, true, false).0.applied >= s.applied
    ensures Ack(s, ackOwner, ackRequest, true, false).0.desired == s.desired
  {}

  lemma DirtySuccessStartsExactlyLatest(s: State, ackOwner: nat,
                                        ackRequest: nat)
    requires Invariant(s)
    requires s.flight.InFlight?
    requires s.dirty
    requires ackOwner == s.owner == s.flight.owner
    requires ackRequest == s.flight.request
    ensures Ack(s, ackOwner, ackRequest, true, false).1 == StartLatest
    ensures Ack(s, ackOwner, ackRequest, true, false).0.flight.InFlight?
    ensures Ack(s, ackOwner, ackRequest, true, false).0.flight.revision == s.desired
  {}

  lemma RetrySchedulesExactlyLatest(s: State, ackOwner: nat, ackRequest: nat)
    requires Invariant(s)
    requires s.flight.InFlight?
    requires ackOwner == s.owner == s.flight.owner
    requires ackRequest == s.flight.request
    ensures Ack(s, ackOwner, ackRequest, false, true).1 == RetryLatest
    ensures Ack(s, ackOwner, ackRequest, false, true).0.flight.RetryWait?
    ensures Ack(s, ackOwner, ackRequest, false, true).0.flight.revision == s.desired
    ensures Ack(s, ackOwner, ackRequest, false, true).0.desired == s.desired
    ensures Ack(s, ackOwner, ackRequest, false, true).0.applied == s.applied
    ensures Ack(s, ackOwner, ackRequest, false, true).0.nextRequest == s.nextRequest
    ensures Ack(s, ackOwner, ackRequest, false, true).0.dirty
  {}

  lemma RetryWaitRetainsLatestWithoutNativeFlight(s: State)
    requires Invariant(s)
    requires s.flight.RetryWait?
    ensures s.flight.revision == s.desired
    ensures s.dirty
    ensures !s.flight.InFlight?
  {}

  lemma MatchingRetryTimerStartsExactlyLatest(s: State)
    requires Invariant(s)
    requires s.flight.RetryWait?
    ensures RetryTimer(s, s.owner, s.flight.timer).1 == StartLatest
    ensures RetryTimer(s, s.owner, s.flight.timer).0.flight.InFlight?
    ensures RetryTimer(s, s.owner, s.flight.timer).0.flight.revision == s.desired
    ensures RetryTimer(s, s.owner, s.flight.timer).0.nextRequest == s.nextRequest + 1
    ensures !RetryTimer(s, s.owner, s.flight.timer).0.dirty
  {}

  lemma StaleRetryTimerIsIdentity(s: State, timerOwner: nat, timer: nat)
    requires Invariant(s)
    requires s.flight.RetryWait?
    requires timerOwner != s.owner || timer != s.flight.timer
    ensures RetryTimer(s, timerOwner, timer) == (s, Ignore)
  {}

  lemma NewerRequestCancelsRetryWaitAndStartsExactlyLatest(s: State, revision: nat)
    requires Invariant(s)
    requires s.flight.RetryWait?
    requires revision > s.desired
    ensures Request(s, revision).desired == revision
    ensures Request(s, revision).flight.InFlight?
    ensures Request(s, revision).flight.revision == revision
    ensures !Request(s, revision).dirty
  {}

  lemma RehydrationCancelsRetryWait(s: State)
    requires Invariant(s)
    requires s.flight.RetryWait?
    ensures RehydrateOwner(s).flight.NoFlight?
    ensures RetryTimer(RehydrateOwner(s), s.owner, s.flight.timer)
      == (RehydrateOwner(s), Ignore)
  {}

  lemma TerminalFailureStopsFlight(s: State, ackOwner: nat, ackRequest: nat)
    requires Invariant(s)
    requires s.flight.InFlight?
    requires ackOwner == s.owner == s.flight.owner
    requires ackRequest == s.flight.request
    ensures Ack(s, ackOwner, ackRequest, false, false).1 == Terminal
    ensures Ack(s, ackOwner, ackRequest, false, false).0.terminal
    ensures Ack(s, ackOwner, ackRequest, false, false).0.flight.NoFlight?
  {}

  lemma InFlightNativeEmissionIsTerminal()
    ensures NativeEmissionDecision(true) == Terminal
  {}

  lemma IdleNativeEmissionMayPublish()
    ensures NativeEmissionDecision(false) == Idle
  {}

  method ExportAckDecision(ownerMatches: bool, requestMatches: bool,
                           dirty: bool, ok: bool, retryable: bool)
      returns (action: int)
    ensures 0 <= action <= 4
    ensures (!ownerMatches || !requestMatches) ==> action == 0
    ensures ownerMatches && requestMatches && ok && dirty ==> action == 2
    ensures ownerMatches && requestMatches && ok && !dirty ==> action == 1
    ensures ownerMatches && requestMatches && !ok && retryable ==> action == 3
    ensures ownerMatches && requestMatches && !ok && !retryable ==> action == 4
  {
    action := match AckDecision(ownerMatches, requestMatches, dirty, ok, retryable)
      case Ignore => 0
      case Idle => 1
      case StartLatest => 2
      case RetryLatest => 3
      case Terminal => 4;
  }


  method ExportNativeEmissionDecision(projectionInFlight: bool)
      returns (action: int)
    ensures action == 1 || action == 4
    ensures projectionInFlight ==> action == 4
    ensures !projectionInFlight ==> action == 1
  {
    action := match NativeEmissionDecision(projectionInFlight)
      case Idle => 1
      case Terminal => 4
      case _ => 4;
  }
}
