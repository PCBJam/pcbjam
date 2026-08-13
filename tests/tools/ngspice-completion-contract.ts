/**
 * Deterministic ngspice completion contract.
 *
 * The browser test must wait for the native final-refresh apply, not a worker
 * finish frame or a periodic vector response.  This source-level gate keeps
 * the native generation, harness receipt, and E2E ordering connected without
 * requiring a KiCad build.
 *
 * Run: cd tests && npm run ngspice:contract
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const native = readFileSync(
  path.join(repo, "kicad/eeschema/sim/simulator_frame.cpp"),
  "utf8",
);
const harness = readFileSync(
  path.join(repo, "tests/kicad/utils/ngspice-service.ts"),
  "utf8",
);
const e2e = readFileSync(
  path.join(repo, "tests/kicad/eeschema-sim.spec.ts"),
  "utf8",
);
const sharedspice = readFileSync(
  path.join(repo, "wasm/stubs/sharedspice_client.cpp"),
  "utf8",
);
const ownerHeader = readFileSync(
  path.join(repo, "wxwidgets/include/wx/wasm/private/execution_owner.h"),
  "utf8",
);
const ownerRuntime = readFileSync(
  path.join(repo, "wxwidgets/src/wasm/evtloop.cpp"),
  "utf8",
);

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }

  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function sliceBetween(text: string, start: string, end: string): string {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  return first >= 0 && last > first ? text.slice(first, last) : "";
}

function ordered(text: string, tokens: string[]): boolean {
  let cursor = -1;

  for (const token of tokens) {
    cursor = text.indexOf(token, cursor + 1);
    if (cursor < 0) return false;
  }

  return true;
}

function exerciseEventModuleReplacement(): boolean {
  const marker = "EM_JS( void, js_ngspice_install_events, (), {";
  const start = sharedspice.indexOf(marker);
  const end = sharedspice.indexOf("\n} );", start + marker.length);
  if (start < 0 || end < 0) return false;

  const body = sharedspice.slice(start + marker.length, end);
  const install = new Function("Module", "lengthBytesUTF8", body) as (
    module: Record<string, unknown>,
    lengthBytes: (value: string) => number,
  ) => void;
  const runtime = globalThis as any;
  const savedHandler = runtime.__ngspiceOnEvent;
  const savedScheduler = runtime.__wxScheduler;
  const deliveries: string[] = [];

  const moduleA = {
    _pcbjam_ngspice_event: () => deliveries.push("A"),
  };
  const moduleB = {
    _pcbjam_ngspice_event: () => deliveries.push("B"),
  };
  const makeScheduler = (ownerModule: typeof moduleA) => {
    const queue: Array<() => void> = [];
    return {
      ownerModule,
      queue,
      canTouchNative: () => true,
      enqueueNativeCompletion: (
        _site: string,
        _bytes: number,
        run: () => void,
      ) => {
        queue.push(run);
        return true;
      },
    };
  };

  try {
    const schedulerA = makeScheduler(moduleA);
    runtime.__wxScheduler = schedulerA;
    install(moduleA, (value) => Buffer.byteLength(value));
    const handlerA = runtime.__ngspiceOnEvent;
    install(moduleA, (value) => Buffer.byteLength(value));
    if (runtime.__ngspiceOnEvent !== handlerA) return false;

    handlerA({ kind: "bg", finished: false });
    if (schedulerA.queue.length !== 1) return false;

    const schedulerB = makeScheduler(moduleB);
    runtime.__wxScheduler = schedulerB;
    install(moduleB, (value) => Buffer.byteLength(value));
    const handlerB = runtime.__ngspiceOnEvent;
    if (handlerB === handlerA) return false;

    // A late call and an already accepted completion from A must both become
    // inert after B owns the realm.
    handlerA({ kind: "bg", finished: false });
    schedulerA.queue.shift()?.();
    if (deliveries.length !== 0 || schedulerA.queue.length !== 0) return false;

    handlerB({ kind: "bg", finished: true });
    schedulerB.queue.shift()?.();
    return deliveries.join(",") === "B";
  } finally {
    runtime.__ngspiceOnEvent = savedHandler;
    runtime.__wxScheduler = savedScheduler;
  }
}

check(
  "event handler is replaced per exact Module lifetime",
  exerciseEventModuleReplacement(),
);
check("event batches transfer into the retained native queue", ordered(sharedspice, [
  "retainedNgspiceEventBytes",
  "wxWasmExecutionQueueOrdinaryRetained",
]));
check("native execution payload bytes have one 64 MiB aggregate budget",
  ownerHeader.includes(
    "constexpr std::size_t MaxQueuedRetainedBytes = 64u * 1024u * 1024u",
  ) && ownerHeader.includes("class RetainedByteBudget"));
check("native payload lease survives take and releases on callback or discard",
  ownerRuntime.includes("wxWasmDispatchJobByteLease byteLease(job)")
    && ownerRuntime.includes("wxWasmReleaseDispatchJobBytes(job)"));

const reporter = sliceBetween(
  native,
  "class SIM_THREAD_REPORTER",
  "BEGIN_EVENT_TABLE",
);
check("reporter has separate pending and active run generations", ordered(reporter, [
  "m_pendingRunGeneration",
  "case SIM_RUNNING:",
  "m_pendingRunGeneration.exchange",
  "m_activeRunGeneration.store",
  "case SIM_IDLE:",
  "m_activeRunGeneration.exchange",
]));
check("started and finished events carry their native generation",
  reporter.includes("event->SetExtraLong( static_cast<long>( generation ) )"));

const runHelper = sliceBetween(
  native,
  "void SIMULATOR_FRAME::runSimulator()",
  "void SIMULATOR_FRAME::onUpdateSim",
);
check("run generations are process-wide across simulator frame reopen", native.includes(
  "static std::atomic<uint32_t> s_nextSimRunGeneration",
) && native.includes("s_nextSimRunGeneration.fetch_add"));
check("run generation is assigned before every simulator Run", ordered(runHelper, [
  "m_simRunGeneration = allocateSimRunGeneration()",
  "m_reporter->SetRunGeneration( m_simRunGeneration )",
  "m_simulator->Run()",
]));
check("all simulator Run calls use the generation helper",
  (native.match(/m_simulator->Run\(\)/g) ?? []).length === 1
    && (native.match(/runSimulator\(\);/g) ?? []).length >= 2);

const finishHandler = sliceBetween(
  native,
  "void SIMULATOR_FRAME::onSimFinished",
  "void SIMULATOR_FRAME::runSimulator",
);
check("stale finish generations are rejected", finishHandler.includes(
  "generation != m_simRunGeneration",
));
check("native receipt follows every final apply step", ordered(finishHandler, [
  "m_ui->OnSimRefresh( true )",
  "RefreshOperatingPointDisplay()",
  "GetCanvas()->Refresh()",
  "m_lastAppliedSimRunGeneration = generation",
  "__pcbjamNgspiceFinalRefreshApplied",
]));
check("the optional browser hook is Emscripten-only", ordered(finishHandler, [
  "#ifdef __EMSCRIPTEN__",
  "__pcbjamNgspiceFinalRefreshApplied",
  "#endif",
]));

check("harness owns and revokes the exact worker URL",
  harness.includes("workerUrl?: string")
    && harness.includes("slot.workerUrl = URL.createObjectURL")
    && harness.includes("new Worker(slot.workerUrl)")
    && harness.includes("URL.revokeObjectURL(slot.workerUrl)"));
check("harness bounds worker boot and request response", harness.includes(
  "ngspice_service boot timed out after",
) && harness.includes("ngspice_service response timed out after"));
check("request receipts require success", harness.includes(
  "&& summary.error === undefined",
));
check("request receipts clear timers on resolve, timeout, cancel, and teardown",
  harness.includes("clearTimeout(waiter.timer)")
    && harness.includes("ngspice request receipt ${reason}")
    && harness.includes("ngspice request receipt canceled by teardown"));

const appliedWait = sliceBetween(
  harness,
  "const waitForAppliedGenerationAfter",
  "const previousAppliedHook",
);
check("applied-generation receipt scans before subscribing", ordered(appliedWait, [
  "appliedGenerations.find",
  "appliedGenerationWaiters.size",
  "appliedGenerationWaiters.add",
]));
check("applied-generation receipt is bounded and cancellable",
  appliedWait.includes("validateReceiptTimeout(timeoutMs)")
    && appliedWait.includes("receipt ${reason}"));

const runSimulation = sliceBetween(
  e2e,
  "async function runSimulation",
  "function distinctColors",
);
check("E2E checkpoints before clicking Run", ordered(runSimulation, [
  "appliedGenerationCheckpoint",
  "clickByTooltip(page, 'Run Simulation'",
  "waitForAppliedGenerationAfter",
]));
check("E2E awaits exact apply before the owner barrier", ordered(runSimulation, [
  "waitForAppliedGenerationAfter",
  "executionBarrier('ngspice final plot apply')",
]));
check("worker finish is not used as native completion evidence",
  !runSimulation.includes("e.kind === 'bg' && e.finished"));
check("successful vector data remains a separate result assertion", ordered(runSimulation, [
  "executionBarrier('ngspice final plot apply')",
  "entry.kind === 'get_vec_info'",
  "entry.error === undefined",
]));

console.log(failures
  ? `ngspice-completion-contract: ${failures} FAILURE(S)`
  : "ngspice-completion-contract: all green");
process.exit(failures ? 1 : 0);
