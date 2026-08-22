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

module ProjectionKernel {
  datatype Action = Ignore | Idle | StartLatest | RetryLatest | Terminal
  datatype Flight = NoFlight | InFlight(owner: nat, request: nat, revision: nat)
  datatype State = State(
    owner: nat,
    desired: nat,
    applied: nat,
    nextRequest: nat,
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
  }

  function Request(s: State, revision: nat): State
    requires Invariant(s)
    ensures Invariant(Request(s, revision))
  {
    if s.terminal || revision <= s.desired then s
    else match s.flight
      case NoFlight =>
        State(s.owner, revision, s.applied, s.nextRequest + 1,
              InFlight(s.owner, s.nextRequest + 1, revision), false, false)
      case InFlight(_, _, _) =>
        State(s.owner, revision, s.applied, s.nextRequest,
              s.flight, true, false)
  }

  function RehydrateOwner(s: State): State
    requires Invariant(s)
    ensures Invariant(RehydrateOwner(s))
    ensures RehydrateOwner(s).owner > s.owner
    ensures RehydrateOwner(s).applied == s.desired
    ensures RehydrateOwner(s).flight.NoFlight?
    ensures !RehydrateOwner(s).terminal
  {
    State(s.owner + 1, s.desired, s.desired, s.nextRequest,
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
          (State(s.owner, s.desired, inRevision, s.nextRequest + 1,
                 InFlight(s.owner, s.nextRequest + 1, s.desired), false, false),
           StartLatest)
        else if ok then
          (State(s.owner, s.desired, inRevision, s.nextRequest,
                 NoFlight, false, false), Idle)
        else if retryable then
          (State(s.owner, s.desired, s.applied, s.nextRequest + 1,
                 InFlight(s.owner, s.nextRequest + 1, s.desired), false, false),
           RetryLatest)
        else
          (State(s.owner, s.desired, s.applied, s.nextRequest,
                 NoFlight, false, true), Terminal)
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

  lemma RetryStartsExactlyLatest(s: State, ackOwner: nat, ackRequest: nat)
    requires Invariant(s)
    requires s.flight.InFlight?
    requires ackOwner == s.owner == s.flight.owner
    requires ackRequest == s.flight.request
    ensures Ack(s, ackOwner, ackRequest, false, true).1 == RetryLatest
    ensures Ack(s, ackOwner, ackRequest, false, true).0.flight.InFlight?
    ensures Ack(s, ackOwner, ackRequest, false, true).0.flight.revision == s.desired
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
}
