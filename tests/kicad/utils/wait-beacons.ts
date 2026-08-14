// Wait-beacon extraction (JSPI-era successor of guard-beacons.ts; the
// mailbox/scheduler migration doc is docs/features/async/17, step S0.3).
//
// Every anti-collision guard announces itself on the console when it fires.
// A superseded guard is kept as a TRIPWIRE: the mailbox is only trusted once
// the guard it replaces is provably silent across the suite. This module turns
// a TestLogger's consoleLogs into per-family counts so specs can assert
// `expectGuardsSilent(...)` at the step that claims a family.
//
// Rate-limiting caveat: the [wx-dispatch] ERASED beacon prints the first 10
// occurrences, then every 100th, embedding "(occurrence N)". `linesSeen` is what
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
  // open-settle gate giving up (open-flow.ts)
  openSettleFailed: BeaconFamilyCount;
  // jspi-scheduler.js turnstile/containment beacons
  wxScheduler: BeaconFamilyCount;
  // libcontext JSPI backend ghost/refused-transition census
  libctxJspi: BeaconFamilyCount;
}

const FAMILY_PATTERNS: Record<keyof GuardBeaconCounts, RegExp> = {
  timerRetry: /\[wx-timer\] retry storm/,
  dispatchAnomaly: /\[wx-dispatch\] (ERASED|NEGATIVE)/,
  openSettleFailed: /\[open\] load chain never settled/,
  wxScheduler:
    /\[wx-scheduler\] (force-clearing stuck window|job tick error|untracked promising entry|activation stack imbalance|resume window misnested)/,
  libctxJspi: /\[libctx-jspi\] ghost\/refused/,
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
    openSettleFailed: emptyFamily(),
    wxScheduler: emptyFamily(),
    libctxJspi: emptyFamily(),
  };

  for (const line of consoleLines) {
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

// Assert the named guard families never fired. Throws with the offending sample
// lines so the log points straight at the collision the mailbox failed to absorb.
export function expectGuardsSilent(
  consoleLines: string[],
  families: Array<keyof GuardBeaconCounts>
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
