#!/usr/bin/env python3
"""Rank subsystems by asyncify-removelist safety using the Sourcetrail db.

Taint = "a suspend point is reachable from this function" (reverse BFS over
call edges from suspend primitives, with base->override pseudo-edges for
virtual dispatch).  Two levels:
  strict  — direct suspend primitives only (Yield/Sleep/ShowModal/progress/
            coroutine/fiber)
  lenient — strict + synchronous event dispatch (ProcessEvent & co), since a
            dispatched handler may suspend and unwind through the dispatcher

Functions never tainted even in lenient mode are removelist candidates.
Blind spots (validate with ASYNCIFY_ADVISE before shipping): std::function /
event-table indirection, function pointers, wx/libc internals outside the cdb.
"""
import re
import sqlite3
from collections import defaultdict, deque

DB = "kicad-wasm.srctrldb"
PCBJAM = "/Users/V/IdeaProjects/pcbjam-private/pcbjam/"
FUNC_TYPES = (4096, 8192)

STRICT_PATTERNS = [
    r"\tnShowModal",  # every ShowModal incl. DIALOG_SHIM/KIDIALOG wrappers
    r"\tnShowWindowModal",
    r"\tnShowQuasiModal",
    r"mwxYield", r"mwxSafeYield", r"mwxYieldIfNeeded",
    r"\tnYield", r"\tnYieldFor", r"\tnDoYieldFor", r"\tnSafeYield",
    r"\tnSleep", r"mwxSleep", r"mwxMilliSleep", r"mwxMicroSleep",
    r"sleep_for", r"sleep_until", r"nanosleep", r"emscripten_sleep",
    r"emscripten_fiber", r"__asyncjs__",
    r"mwxGenericProgressDialog", r"mwxProgressDialog",
    r"mwxMessageBox", r"mwxExecute",
    r"mCOROUTINE<",
]
LENIENT_EXTRA = [
    r"\tnProcessEvent\t", r"\tnSafelyProcessEvent", r"\tnProcessPendingEvents",
    r"\tnHandleEvent\t", r"\tnProcessEventLocally",
]


def main():
    con = sqlite3.connect(DB)

    funcs = {}  # id -> serialized_name
    for nid, name in con.execute(
            f"SELECT id, serialized_name FROM node WHERE type IN {FUNC_TYPES}"):
        funcs[nid] = name

    # callee -> callers (reverse call graph)
    rev = defaultdict(list)
    for s, t in con.execute("SELECT source_node_id, target_node_id FROM edge WHERE type=8"):
        rev[t].append(s)
    # virtual dispatch: caller of Base::f may land in Derived::f, so taint of
    # Derived::f must flow to callers of Base::f -> pseudo-edge callee=Derived,
    # caller-side=Base is wrong; we need: if Derived tainted then Base tainted
    # is NOT true. Correct: call to Base::f can dispatch to Derived::f, so if
    # Derived::f suspends, callers of Base::f suspend. Model: rev[Derived] gets
    # nothing; instead treat Base::f as a caller of every override Derived::f.
    for s, t in con.execute("SELECT source_node_id, target_node_id FROM edge WHERE type=32"):
        # override edge: Derived::f (source) -> Base::f (target)
        rev[s].append(t)  # taint flows Derived -> Base -> Base's callers

    def seeds_for(patterns):
        pats = [re.compile(p) for p in patterns]
        return {nid for nid, name in funcs.items() if any(p.search(name) for p in pats)}

    def closure(seed_ids):
        seen = set(seed_ids)
        q = deque(seed_ids)
        while q:
            n = q.popleft()
            for caller in rev.get(n, ()):
                if caller not in seen:
                    seen.add(caller)
                    q.append(caller)
        return seen

    strict_seeds = seeds_for(STRICT_PATTERNS)
    lenient_seeds = strict_seeds | seeds_for(STRICT_PATTERNS + LENIENT_EXTRA)
    print(f"functions: {len(funcs)}  strict seeds: {len(strict_seeds)}  "
          f"lenient seeds: {len(lenient_seeds)}")

    tainted_strict = closure(strict_seeds)
    tainted_lenient = closure(lenient_seeds)

    # function -> file (prefer definition scope locations, type=1)
    loc = {}
    for typ in (1, 0):
        for eid, path in con.execute(
                "SELECT o.element_id, f.path FROM occurrence o "
                "JOIN source_location sl ON sl.id=o.source_location_id "
                "JOIN file f ON f.id=sl.file_node_id WHERE sl.type=?", (typ,)):
            if eid in funcs and eid not in loc:
                loc[eid] = path

    def module(path):
        if not path.startswith(PCBJAM):
            return None  # std/emsdk/deps headers — not our code
        rel = path[len(PCBJAM):]
        parts = rel.split("/")
        depth = 3 if parts[0] in ("kicad", "build-wasm") else 2
        return "/".join(parts[:depth]) if len(parts) > depth else "/".join(parts[:-1])

    stats = defaultdict(lambda: [0, 0, 0])  # module -> [total, strict, lenient]
    for nid in funcs:
        m = module(loc.get(nid, ""))
        if m is None:
            continue
        stats[m][0] += 1
        if nid in tainted_strict:
            stats[m][1] += 1
        if nid in tainted_lenient:
            stats[m][2] += 1

    rows = [(m, t, s, l, t - l) for m, (t, s, l) in stats.items() if t >= 20]
    rows.sort(key=lambda r: -r[4])
    print(f"\n{'module':<44}{'funcs':>7}{'strict✗':>9}{'lenient✗':>9}{'clean':>7}{'clean%':>8}")
    for m, t, s, l, clean in rows[:45]:
        print(f"{m:<44}{t:>7}{s:>9}{l:>9}{clean:>7}{100*clean//t:>7}%")


if __name__ == "__main__":
    main()
