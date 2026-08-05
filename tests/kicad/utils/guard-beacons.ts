// Guard-beacon extraction for the mailbox/scheduler migration
// (docs/features/async/17-mailbox-scheduler-plan.md, step S0.3).
//
// Every legacy anti-collision guard announces itself on the console when it fires.
// During the migration each superseded guard is kept as a TRIPWIRE: the mailbox is
// only trusted once the guard it replaces is provably silent across the suite.
// This module turns a TestLogger's consoleLogs into per-family counts so specs can
// assert `expectGuardsSilent(...)` at the step that claims a family.
//
// Rate-limiting caveat: [wx-asyncify] and [collab-fcontext] beacons print the first
// 10 occurrences, then every 100th, embedding "(occurrence N)". `linesSeen` is what
// reached the console; `estimatedTotal` recovers the true count from the highest
// occurrence number when present (else it equals linesSeen). Assertions on SILENCE
// are exact either way: zero fires = zero lines.

export interface BeaconFamilyCount {
  linesSeen: number;
  estimatedTotal: number;
  samples: string[]; // first few matching lines, for the failure message
}

export interface GuardBeaconCounts {
  // wx timer interlock (timer.cpp): parked-dispatch retries
  timerRetry: BeaconFamilyCount;
  // wx dispatch interlock bookkeeping anomalies (evtloop.cpp)
  dispatchAnomaly: BeaconFamilyCount;
  // asyncify-scheduler.js shim: nested-park / wake-aliasing / stale-fiber refusals
  wxAsyncify: BeaconFamilyCount;
  // libcontext swap-layer refusals + hot-main beacons ([collab-fcontext])
  libcontext: BeaconFamilyCount;
  // open-settle gate giving up (open-flow.ts)
  openSettleFailed: BeaconFamilyCount;
  // scheduler build marker — identifies the dual-glue variant, not a guard
  schedulerBuild: boolean;
}

const FAMILY_PATTERNS: Record<
  Exclude<keyof GuardBeaconCounts, 'schedulerBuild'>,
  RegExp
> = {
  timerRetry: /\[wx-timer\] retry storm/,
  dispatchAnomaly: /\[wx-dispatch\] (ERASED|NEGATIVE)/,
  wxAsyncify:
    /\[wx-asyncify\] (concurrent-park|reentrant-state|aliased-wake-live|overlapped-wake|fiber-resume-refused)/,
  libcontext:
    /\[collab-fcontext\] (jump-refused|jump-refused-hot-main|hot-main-swap-out|jump-hot-into-main|jump-ghost|entry-orphaned)/,
  openSettleFailed: /\[open\] load chain never settled/,
};

const OCCURRENCE_RE = /\(occurrence (\d+)\)/;
const SAMPLE_LIMIT = 3;

function emptyFamily(): BeaconFamilyCount {
  return { linesSeen: 0, estimatedTotal: 0, samples: [] };
}

export function countGuardBeacons(consoleLines: string[]): GuardBeaconCounts {
  const counts: GuardBeaconCounts = {
    timerRetry: emptyFamily(),
    dispatchAnomaly: emptyFamily(),
    wxAsyncify: emptyFamily(),
    libcontext: emptyFamily(),
    openSettleFailed: emptyFamily(),
    schedulerBuild: false,
  };

  for (const line of consoleLines) {
    if (line.includes('[wx-scheduler] scaffolding installed')) {
      counts.schedulerBuild = true;
      continue;
    }
    for (const family of Object.keys(FAMILY_PATTERNS) as Array<
      keyof typeof FAMILY_PATTERNS
    >) {
      if (!FAMILY_PATTERNS[family].test(line)) continue;
      const fam = counts[family];
      fam.linesSeen += 1;
      const occ = OCCURRENCE_RE.exec(line);
      const occurrenceTotal = occ ? parseInt(occ[1], 10) : fam.linesSeen;
      fam.estimatedTotal = Math.max(fam.estimatedTotal, occurrenceTotal, fam.linesSeen);
      if (fam.samples.length < SAMPLE_LIMIT) fam.samples.push(line);
    }
  }
  return counts;
}

// Last-seen fcsTotal/rootHotTotal from a __wxAsyncifyDump()/STATE line, if any.
// rootHotTotal must stay 0 post-v0.1.28 — the standing N8 assertion.
export function parseAsyncifyCounters(
  consoleLines: string[]
): { fcsTotal: number; rootHotTotal: number } | null {
  let result: { fcsTotal: number; rootHotTotal: number } | null = null;
  for (const line of consoleLines) {
    const m = /fcsTotal=(\d+) rootHotTotal=(\d+)/.exec(line);
    if (m) result = { fcsTotal: parseInt(m[1], 10), rootHotTotal: parseInt(m[2], 10) };
  }
  return result;
}

// Assert the named guard families never fired. Throws with the offending sample
// lines so the log points straight at the collision the mailbox failed to absorb.
export function expectGuardsSilent(
  consoleLines: string[],
  families: Array<Exclude<keyof GuardBeaconCounts, 'schedulerBuild'>>
): void {
  const counts = countGuardBeacons(consoleLines);
  const noisy = families
    .map((f) => ({ family: f, count: counts[f] }))
    .filter(({ count }) => count.linesSeen > 0);
  if (noisy.length > 0) {
    const detail = noisy
      .map(
        ({ family, count }) =>
          `${family}: ${count.estimatedTotal} fire(s)\n    ${count.samples.join('\n    ')}`
      )
      .join('\n  ');
    throw new Error(`guard beacons fired (expected silent):\n  ${detail}`);
  }
}
