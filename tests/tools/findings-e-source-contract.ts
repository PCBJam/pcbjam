/**
 * Source-contract tripwire for the findings group E fixes that live in C++
 * (EM_JS bridges and KiCad simulator code) and therefore cannot be
 * behaviorally unit-tested without a full wasm build. Same style as the codex
 * thread's contract tools: read the sources, assert the load-bearing tokens
 * are present (and the reverted shapes absent), fail loudly with the finding
 * ID. Run: npm run findings-e:contract
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const read = (rel: string) => readFileSync(path.join(repo, rel), "utf8");

const sharedspice = read("wasm/stubs/sharedspice_client.cpp");
const exporterStub = read("wasm/stubs/exporter_step_stub.cpp");
const oceStub = read("wasm/stubs/oce_plugin_stub.cpp");
const simFrame = read("kicad/eeschema/sim/simulator_frame.cpp");
const ngspiceCpp = read("kicad/eeschema/sim/ngspice.cpp");
const shim = read("scripts/common/shims/jspi-scheduler.js");

// --- structural #ifdef scanner ----------------------------------------------
// The wasm-only-confinement guarantees are asserted on CODE STRUCTURE (is this
// statement lexically inside an `__EMSCRIPTEN__`-conditioned region?), never on
// comment text: a comment-string contract fails on rewording with no behavior
// change and passes when the guard moves outside the ifdef but the comment
// stays — the exact regression it exists to catch.
type Cond = "em" | "not-em" | "other";

function emscriptenLineMap(src: string): boolean[] {
  const stack: Cond[] = [];
  return src.split("\n").map((line) => {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^#\s*ifdef\s+(\w+)/))) {
      stack.push(m[1] === "__EMSCRIPTEN__" ? "em" : "other");
    } else if ((m = t.match(/^#\s*ifndef\s+(\w+)/))) {
      stack.push(m[1] === "__EMSCRIPTEN__" ? "not-em" : "other");
    } else if ((m = t.match(/^#\s*if\b(.*)/))) {
      const cond = m[1];
      const negated = /!\s*defined\s*\(?\s*__EMSCRIPTEN__/.test(cond);
      const positive = /defined\s*\(?\s*__EMSCRIPTEN__/.test(cond) && !negated;
      stack.push(positive ? "em" : negated ? "not-em" : "other");
    } else if (/^#\s*(else|elif)\b/.test(t)) {
      const top = stack[stack.length - 1];
      if (top === "em") stack[stack.length - 1] = "not-em";
      else if (top === "not-em") stack[stack.length - 1] = "em";
    } else if (/^#\s*endif\b/.test(t)) {
      stack.pop();
    }
    return stack.includes("em");
  });
}

/** Line indexes (0-based) of every occurrence of `needle` in `src`. */
function occurrenceLines(src: string, needle: string): number[] {
  const out: number[] = [];
  src.split("\n").forEach((line, i) => {
    if (line.includes(needle)) out.push(i);
  });
  return out;
}

function assertOccurrences(
  src: string,
  map: boolean[],
  needle: string,
  expect: { total: number; insideEm: number },
  label: string,
): void {
  const lines = occurrenceLines(src, needle);
  assert.equal(lines.length, expect.total,
    `${label}: expected ${expect.total} occurrence(s) of "${needle}", found ${lines.length}`);
  const inside = lines.filter((i) => map[i]).length;
  assert.equal(inside, expect.insideEm,
    `${label}: ${inside} of ${lines.length} occurrence(s) of "${needle}" are inside an `
      + `__EMSCRIPTEN__ region, expected ${expect.insideEm}`);
}

// --- E-5: ngspice event handler bound to exact module identity --------------
assert.ok(sharedspice.includes("const installingModule = Module"),
  "E-5: js_ngspice_install_events must capture the installing module");
assert.ok((sharedspice.match(/__pcbjamNgspiceOwnerModule/g) ?? []).length >= 2,
  "E-5: the handler must be stamped AND compared by owner module identity");
assert.ok(sharedspice.includes("globalThis.__ngspiceOnEvent !== handler"),
  "E-5: a superseded handler must disarm itself");
assert.ok(!/if\(\s*globalThis\.__ngspiceOnEvent\s*\)/.test(sharedspice),
  "E-5 REGRESSION: the install-once presence guard is back — presence is not identity");
assert.ok(sharedspice.includes("canTouchNative"),
  "E-5/E-8: event dispatch must check the scheduler liveness gate");

// --- E-8: all four completion sites route native work through the gate ------
for (const [name, src, site] of [
  ["exporter_step_stub.cpp", exporterStub, "'OCC export completion'"],
  ["oce_plugin_stub.cpp", oceStub, "'OCC model completion'"],
  ["sharedspice_client.cpp", sharedspice, "'ngspice request completion'"],
  ["sharedspice_client.cpp", sharedspice, "'ngspice vector completion'"],
] as const) {
  assert.ok(src.includes(`runWaitCompletion( ${site}`),
    `E-8: ${name} must run its ${site} through runWaitCompletion`);
}
for (const [name, src] of [
  ["exporter_step_stub.cpp", exporterStub],
  ["oce_plugin_stub.cpp", oceStub],
  ["sharedspice_client.cpp", sharedspice],
] as const) {
  assert.ok(!/__wxScheduler\.resolveWait\(/.test(src),
    `E-8 REGRESSION: ${name} resolves a wait directly, bypassing the admission gate`);
  assert.ok(/if\(\s*token\s*<=\s*0\s*\)/.test(src),
    `E-8: ${name} must bail when wxWasmBeginWait refuses the token`);
}
for (const symbol of ["runWaitCompletion", "_terminalizeNativeTrap",
  "canTouchNative", "beginWaitRefused"]) {
  assert.ok(shim.includes(symbol),
    `E-8: jspi-scheduler.js must provide ${symbol}`);
}

// --- E-7: per-session run generation, behavioral drops wasm-only ------------
const simMap = emscriptenLineMap(simFrame);

// The acceptance guards (onSimStarted entry, onSimFinished entry, and the
// post-wxYield re-check) are the three `generation != m_simRunGeneration`
// comparisons — every one must sit inside an __EMSCRIPTEN__ region.
assertOccurrences(simFrame, simMap, "generation != m_simRunGeneration",
  { total: 3, insideEm: 3 }, "E-7 acceptance guards");
// The unowned-event drop.
assertOccurrences(simFrame, simMap, "delete event;",
  { total: 1, insideEm: 1 }, "E-7 unowned-event drop");
// The bookkeeping stays UNGUARDED by design (inert on native — every reader
// is guarded): the generation allocator and the event stamping.
assertOccurrences(simFrame, simMap, "= allocateSimRunGeneration()",
  { total: 1, insideEm: 0 }, "E-7 bookkeeping (allocator call)");
assertOccurrences(simFrame, simMap, "SetExtraLong",
  { total: 1, insideEm: 0 }, "E-7 bookkeeping (event stamping)");
assert.ok(simFrame.includes("s_nextSimRunGeneration")
  && simFrame.includes("m_lastAppliedSimRunGeneration"),
  "E-7: simulator_frame.cpp must carry the run-generation mechanism");

// The final-refresh receipt lives at the right altitude: one ifdef'd call in
// kicad, the JS hook knowledge in the stub layer.
assertOccurrences(simFrame, simMap, "pcbjam_sim_run_applied( generation )",
  { total: 1, insideEm: 1 }, "E-7 receipt call");
assert.ok(!simFrame.includes("__pcbjamNgspiceFinalRefreshApplied"),
  "E-7 REGRESSION: the harness hook name is back inside kicad source — it belongs "
    + "to wasm/stubs/sharedspice_client.cpp");
assert.ok(sharedspice.includes("__pcbjamNgspiceFinalRefreshApplied"),
  "E-7: sharedspice_client.cpp must implement the final-refresh receipt hook");

// --- E-12: crash-exit IDLE before RUNNING consumes the pending token --------
// `generation = m_pendingRunGeneration.exchange` appears twice: the RUNNING
// consumption (unguarded bookkeeping) and the IDLE crash-exit fallback
// (behavioral — wasm-only).
assertOccurrences(simFrame, simMap, "generation = m_pendingRunGeneration.exchange",
  { total: 2, insideEm: 1 }, "E-12 IDLE pending fallback");

// --- E-13: a failed launch withdraws its token and resets the busy state ----
assertOccurrences(simFrame, simMap, "m_reporter->SetRunGeneration( 0 )",
  { total: 1, insideEm: 1 }, "E-13 failed-launch reset");

// --- E-11: get_vec clamps v_length to the transferred arrays + frees on fail -
assert.ok(sharedspice.includes("length = Math.min( length, nComp >> 1 )"),
  "E-11: the vector prepare must clamp v_length to the transferred arrays");
assert.ok(/std::free\( vname \);\s*\n\s*std::free\( real \);\s*\n\s*std::free\( comp \);/
  .test(sharedspice),
  "E-11: pcbjam_ngGet_Vec_Info must free the prepare's buffers on every failure path");

// --- E-16: the event handler gates on its INSTALLING module's scheduler -----
assert.ok(sharedspice.includes("const installingScheduler = globalThis.__wxScheduler"),
  "E-16: js_ngspice_install_events must capture the installing scheduler");

// --- E-15: every wxWasmBeginWait caller bails on a refused token -------------
// (The three worker stubs are asserted in the E-8 block above.)
for (const [rel, expectedBegins] of [
  ["wxwidgets/src/wasm/fontenum.cpp", 1],
  ["wxwidgets/src/wasm/clipbrd.cpp", 4],
  ["wxwidgets/src/wasm/dialog.cpp", 1],
  ["wxwidgets/src/wasm/evtloop.cpp", 1],
  ["kicad/3d-viewer/3d_cache/pcbjam_model_fetch.cpp", 1],
  ["kicad/pcbnew/pcb_io/pcbjam_fp/pcb_io_pcbjam_fp.cpp", 1],
  ["kicad/eeschema/sch_io/pcbjam_lib/sch_io_pcbjam_lib.cpp", 1],
] as const) {
  const src = read(rel);
  const begins = (src.match(/=\s*wxWasmBeginWait\s*\(/g) ?? []).length;
  const guards = (src.match(/if\s*\(\s*(?:token|waitToken)\s*<=\s*0\s*\)/g) ?? []).length;
  assert.equal(begins, expectedBegins,
    `E-15: ${rel} should mint ${expectedBegins} wait token(s), found ${begins}`);
  assert.ok(guards >= begins,
    `E-15: ${rel} has ${begins} wxWasmBeginWait call(s) but only ${guards} `
      + "token<=0 guard(s) — a refused token must never start its request");
}
for (const symbol of ["terminalize", "resolveRefused"]) {
  assert.ok(shim.includes(symbol),
    `E-14/E-15: jspi-scheduler.js must provide ${symbol}`);
}

// --- E-9: destructor unregisters the sharedspice callbacks ------------------
assert.ok(/#ifdef __EMSCRIPTEN__[\s\S]{0,400}pcbjam_ngspice_reset_callbacks\( this \)/
  .test(ngspiceCpp),
  "E-9: ~NGSPICE must call pcbjam_ngspice_reset_callbacks(this) under __EMSCRIPTEN__");
assert.ok(/pcbjam_ngspice_reset_callbacks\( void\* aUser \)[\s\S]{0,200}s_user != aUser/
  .test(sharedspice),
  "E-9: the reset must be identity-checked so a stale destructor cannot clear a successor");

console.log("findings-e-source-contract: all green");
