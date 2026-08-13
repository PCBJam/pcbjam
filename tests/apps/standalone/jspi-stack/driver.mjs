// jspi-stack driver — runs the red/green shadow-stack scenarios (#27364).
//
//   node --experimental-wasm-jspi driver.mjs red
//   node --experimental-wasm-jspi driver.mjs green-copy     # Pyodide-style save/restore
//   node --experimental-wasm-jspi driver.mjs green-region   # per-activation stack region + SP swap
//
// Output contract (parsed by the future tests/jspi/jspi-stack.spec.ts):
//   [JSPI_STACK] SCENARIO <name> corruptA=<n> corruptB=<n> corruptNested=<n> verdict=<RED|GREEN|UNEXPECTED>
//
// RED must observe corruption with mitigation OFF (proves the harness can see
// the bug). GREEN legs must be corruption-free across interleaved rounds and
// the nested case.

const DEPTH = 24;
const STOMP_DEPTH = 48;
const REGION_BYTES = 256 * 1024;

const mode = process.argv[2] ?? 'red';
const variant = process.argv[3] ?? 'single'; // single | pthread
const { default: factory } = await import(
  variant === 'pthread' ? './stack_test_pt.mjs' : './stack_test.mjs');

// --- gate plumbing -----------------------------------------------------------
const gates = new Map(); // id -> resolve
let gateHook = null;     // (id) => wrap/observe, set per mitigation

globalThis.__jspiGate = (id) => {
  const base = new Promise((res) => gates.set(id, res));
  return gateHook ? gateHook(id, base) : base;
};

function release(id) {
  const r = gates.get(id);
  if (!r) throw new Error(`no gate armed for id ${id}`);
  gates.delete(id);
  r(0);
}

const m = await factory();
const centralBase = m.stackSave();

// --- mitigations -------------------------------------------------------------
// Bookkeeping keyed by activation id. entryTop[id] = SP at promising entry.
const entryTop = new Map();
const actSp = new Map();
const regions = new Map(); // id -> malloc'd base (green-region)
const snapshots = new Map(); // id -> Uint8Array copy (green-copy)

// Wrap a promising-export call according to the active mitigation. Returns the
// export's promise. `centralRestore` puts the shared SP back for whatever runs
// next on the central stack.
function startActivation(id) {
  if (mode === 'green-region') {
    const base = regions.get(id) ?? m._malloc(REGION_BYTES);
    regions.set(id, base);
    const top = base + REGION_BYTES; // stacks grow down
    const saved = m.stackSave();
    m.stackRestore(top);
    entryTop.set(id, top);
    const p = m._activation(id, DEPTH);
    m.stackRestore(saved);
    return finishActivation(id, p);
  }
  entryTop.set(id, m.stackSave());
  const p = m._activation(id, DEPTH);
  return finishActivation(id, p);
}

// After an activation fully completes, its epilogue leaves the shared SP at
// ITS entry value — restore the central SP before any central-stack wasm runs.
function finishActivation(id, p) {
  return p.then((v) => {
    m.stackRestore(centralBase);
    if (mode === 'green-region') {
      const base = regions.get(id);
      if (base) { m._free(base); regions.delete(id); }
    }
    return v;
  });
}

if (mode === 'green-copy') {
  gateHook = (id, base) => {
    const sp = m.stackSave();
    const top = entryTop.get(id);
    snapshots.set(id, new Uint8Array(m.HEAPU8.buffer, sp, top - sp).slice());
    return base.then((v) => {
      // restore this activation's spilled bytes + SP right before it resumes
      new Uint8Array(m.HEAPU8.buffer).set(snapshots.get(id), sp);
      snapshots.delete(id);
      m.stackRestore(sp);
      return v;
    });
  };
} else if (mode === 'green-region') {
  gateHook = (id, base) => {
    actSp.set(id, m.stackSave());
    return base.then((v) => {
      m.stackRestore(actSp.get(id)); // point shared SP back into this region
      return v;
    });
  };
}
// red: gateHook stays null — raw JSPI, no discipline.

// --- scenarios ---------------------------------------------------------------
async function interleavedRound() {
  // A suspends deep; B suspends below A; A completes (epilogue resets SP above
  // B's live frames); central stomp scribbles downward; B resumes and verifies.
  const pA = startActivation(1);
  const pB = startActivation(2);
  release(1);
  const corruptA = await pA;
  if (mode === 'red') {
    m._stomp(STOMP_DEPTH);
  } else {
    m.stackRestore(centralBase); // central discipline: own SP before central work
    m._stomp(STOMP_DEPTH);
  }
  release(2);
  const corruptB = await pB;
  return { corruptA, corruptB };
}

async function nestedCase() {
  // Second activation starts from the first activation's RESUME path — the
  // "nested modal over a parked tool body" shape.
  const pA = startActivation(3);
  let corruptInner = -1;
  const innerDone = (async () => {
    // arm: when A's gate resolves, immediately start B before A's verify walk
    const pB = startActivation(4);
    release(4);
    corruptInner = await pB;
  })();
  release(3);
  const corruptOuter = await pA;
  await innerDone;
  return { corruptOuter, corruptInner };
}

let totalA = 0, totalB = 0, totalNested = 0;
if (variant === 'pthread') m._start_churn(); // cross-thread allocator churn during parks
const ROUNDS = mode === 'red' ? 1 : 3;
for (let i = 0; i < ROUNDS; i++) {
  const { corruptA, corruptB } = await interleavedRound();
  totalA += corruptA; totalB += corruptB;
}
const { corruptOuter, corruptInner } = await nestedCase();
totalNested = corruptOuter + corruptInner;
if (variant === 'pthread') m._stop_churn();

const corrupted = totalA + totalB + totalNested > 0;
const verdict =
  mode === 'red' ? (corrupted ? 'RED' : 'UNEXPECTED')
                 : (corrupted ? 'UNEXPECTED' : 'GREEN');

console.log(
  `[JSPI_STACK] SCENARIO ${mode} corruptA=${totalA} corruptB=${totalB} ` +
  `corruptNested=${totalNested} verdict=${verdict}`
);
process.exit(verdict === 'UNEXPECTED' ? 1 : 0);
