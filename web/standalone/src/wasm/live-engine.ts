// The worker-side wrapper as text (vite ?raw): one source, also read off disk
// by the e2e harness (tests/kicad/sim-live-engine.spec.ts).
import liveWorkerSource from "./ngspice-live-worker.js?raw";
// The adapters that run a chip's firmware in its emulator, as text: they have to be in the
// simulation thread, and the Worker's script is that thread's script too.
import avr8jsAdapterSource from "./avr8js-adapter.js?raw";
import esp32simAdapterSource from "./esp32sim-adapter.js?raw";
import type { Deck } from "@pcbjam/shared/sim-library";
import { resolveWasmBase } from "./wasm-assets";

/**
 * The page's side of the live-simulation engine.
 *
 * A live session is the ngspice_service module once more, in a Worker of its
 * own, driven through its live entry points (wasm/ngspice-service/
 * ngspice_live.cpp, ngspice-live-worker.js). The simulator window's Worker
 * (ngspice-service.ts) is another instance; the two never meet.
 *
 * What the engine does: it runs a circuit without an end, held to the clock.
 * The page sets inputs (a button, a knob) while it runs and reads one snapshot
 * of all values per picture frame.
 *
 * Nothing is started until the first `start()`: a page that never plays a
 * simulation never fetches the module.
 *
 * A crash. WebAssembly cannot recover from a fault inside ngspice or inside a
 * code part, so the Worker is thrown away: a fatal notice from the Worker, an
 * error event, a boot that fails or an answer that does not come all end the
 * same way. Every waiting call is rejected with the reason, `state` becomes
 * "crashed" and `onCrash` is told. The engine itself stays usable:
 * `restart()` (or a new `start()`) boots a fresh Worker and runs the circuit
 * again from time zero, with the inputs where the user left them.
 */

/** What the engine runs. `circuitOf()` makes it from the netlist step's result. */
export interface LiveCircuit {
  /** The circuit, line by line, with its own `.tran` line. */
  deck: string[];
  /** The model files the circuit includes, at the paths it names. */
  files: { path: string; text: string }[];
  /** The simulator's name of every source the user can set -> the value it starts with. */
  inputs: Record<string, number>;
  /** The code of the parts that have some, under the name their model asks for. */
  parts: { name: string; bytes: Uint8Array }[];
}

/**
 * The netlist step's result as the engine takes it. `chips` are the packages
 * of the parts that run an emulator (chip-parts.ts makes them: they need the
 * emulator's files and the firmware). Throws when the circuit cannot run: the
 * step found errors, or a part's code is not there.
 */
export function circuitOf(
  deck: Pick<Deck, "deck" | "files" | "inputs" | "codeParts" | "errors">,
  chips: LiveCircuit["parts"] = [],
): LiveCircuit {
  if (deck.errors.length) throw new Error(deck.errors.join("; "));
  const parts: LiveCircuit["parts"] = [];
  for (const part of deck.codeParts) {
    const bytes = part.kind === "part-wasm" ? part.logic : chips.find((c) => c.name === part.name)?.bytes;
    if (!bytes) throw new Error(`${part.ref ?? part.partId}: the part's code is not loaded`);
    parts.push({ name: part.name, bytes });
  }
  return {
    deck: deck.deck,
    files: deck.files,
    inputs: Object.fromEntries(deck.inputs.map((i) => [i.vector, i.initial])),
    parts,
  };
}

/** One snapshot of the running circuit. */
export interface LiveFrame {
  /** Simulated time reached, in seconds. */
  t: number;
  /** Time points solved since the run began. */
  points: number;
  /** The share of the last frame's time the simulation thread worked (0 to 1). */
  load: number;
  /** Simulated seconds per second over the last frame. */
  achieved: number;
  /** True when the computer cannot keep up: simulated time falls behind the clock. */
  lagging: boolean;
  /** False when the run has ended, by itself or by `stop()`. */
  running: boolean;
  /** Set when the run was halted because a code part could not be loaded: why, in words. */
  problem: string | null;
  /** The simulator's name of every value; `latest[i]` and `avg[i]` belong to `names[i]`. */
  names: string[];
  /** The value at the last solved time point. */
  latest: Float64Array;
  /** The value averaged over the simulated time since the last snapshot. */
  avg: Float64Array;
}

/** A console line: ngspice's own, a code part's, the engine about a part, or the run's begin and end. */
export type LiveLogLine = ["spice" | "part" | "problem" | "run", string];

/**
 * What the chip of one part sent on its serial line since the last batch, as it sent it: a
 * line need not be whole. `part` is the name of the part's code. `dropped` characters did
 * not fit (firmware that prints faster than anybody reads).
 */
export type LiveSerialChunk = [part: string, text: string, dropped: number];

/**
 * idle      nothing was started yet
 * starting  a circuit is being loaded
 * running   it runs
 * paused    it runs, and simulated time stands still
 * stopped   a circuit is loaded and nothing runs: it was stopped, it ended by
 *           itself, or ngspice did not take it
 * crashed   the Worker is gone; `restart()` runs the circuit again
 */
export type LiveState = "idle" | "starting" | "running" | "paused" | "stopped" | "crashed";

export interface LiveEngineOptions {
  /** A line for the app's own log. */
  log?: (msg: string) => void;
  /** Console lines of the run, batched; `dropped` lines did not fit. */
  onLog?: (lines: LiveLogLine[], dropped: number) => void;
  /** What the chips of the run sent on their serial lines, batched. */
  onSerial?: (chunks: LiveSerialChunk[]) => void;
  /** The Worker is gone. The reason is in words. */
  onCrash?: (reason: string) => void;
  /** Maximum time from the first start until a new Worker says it is ready. */
  bootTimeoutMs?: number;
  /** Maximum time for the answer to a small command (an input, a frame). */
  responseTimeoutMs?: number;
  /** Maximum time for a start: loading the circuit takes longer than a frame. */
  startTimeoutMs?: number;
}

export interface LiveEngine {
  readonly state: LiveState;
  /** How often the Worker was thrown away. */
  readonly crashes: number;
  /** Why it was thrown away the last time. */
  readonly lastCrash: string | null;
  /** Load a circuit and run it. A run that is going is replaced. */
  start(circuit: LiveCircuit): Promise<void>;
  /** The same circuit again from time zero, with the inputs as they are now. */
  restart(): Promise<void>;
  stop(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  /** Simulated seconds per second. 1 = real time, 0 = as fast as it goes. */
  setSpeed(speed: number): Promise<void>;
  /** A value the user set. It is kept, so a restart starts with it. */
  setInput(name: string, value: number): Promise<void>;
  /** New code for a part, also while it runs. It is kept for a restart. */
  setPart(name: string, bytes: Uint8Array): Promise<void>;
  /**
   * Text typed to the chip of a part, as the bytes for its serial input. Rejects when
   * nothing runs, or when the circuit has no part of that name.
   */
  sendSerial(name: string, bytes: Uint8Array): Promise<void>;
  /** One snapshot, or null when nothing runs. */
  frame(): Promise<LiveFrame | null>;
  /** Throw the Worker away and forget the circuit. */
  dispose(): void;
}

// Last-resort bounds, not scheduling deadlines: the module is a few megabytes
// to fetch and compile, and a big circuit takes a while to parse.
export const LIVE_BOOT_TIMEOUT_MS = 2 * 60_000;
export const LIVE_RESPONSE_TIMEOUT_MS = 15_000;
export const LIVE_START_TIMEOUT_MS = 60_000;

/**
 * Worker blob parts: prelude with the glue URL, the adapters of the packaged
 * parts (they must be there before the engine's glue runs), the worker source.
 */
export function liveWorkerBlobParts(glueHref: string): string[] {
  return [`self.NGSPICE_GLUE_URL = ${JSON.stringify(glueHref)};\n`, `${esp32simAdapterSource}\n`, `${avr8jsAdapterSource}\n`, liveWorkerSource];
}

interface WorkerResult {
  ok?: boolean;
  error?: string;
  t?: number;
  points?: number;
  load?: number;
  achieved?: number;
  lagging?: boolean;
  running?: boolean;
  latest?: Float64Array;
  avg?: Float64Array;
  names?: string[];
  problem?: string;
}

export function createLiveEngine(options: LiveEngineOptions = {}): LiveEngine {
  const log = options.log ?? (() => undefined);
  const bootTimeoutMs = options.bootTimeoutMs ?? LIVE_BOOT_TIMEOUT_MS;
  const responseTimeoutMs = options.responseTimeoutMs ?? LIVE_RESPONSE_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? LIVE_START_TIMEOUT_MS;

  interface Slot {
    worker?: Worker;
    workerUrl?: string;
    failed: boolean;
    /** The Worker said it is ready: it hears commands now. */
    booted?: boolean;
    ready: Promise<Slot>;
    bootTimer?: ReturnType<typeof setTimeout>;
    rejectBoot?: (reason: Error) => void;
  }

  interface Pending {
    slot: Slot;
    resolve: (res: WorkerResult) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }

  let slot: Slot | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  // What a restart needs: the circuit, and what the user changed since.
  let circuit: LiveCircuit | null = null;
  let inputs: Record<string, number> = {};
  let parts = new Map<string, Uint8Array>();
  let speed = 1;

  let state: LiveState = "idle";
  let crashes = 0;
  let lastCrash: string | null = null;
  let names: string[] = [];
  let frameInFlight: Promise<LiveFrame | null> | null = null;
  // Bumped by every start, stop and crash: an answer that belongs to an older
  // run must not change the state of a newer one.
  let epoch = 0;

  const retire = (s: Slot, why: string, crash: boolean): void => {
    if (s.failed) return;
    s.failed = true;
    if (s.bootTimer !== undefined) clearTimeout(s.bootTimer);
    s.bootTimer = undefined;
    if (slot === s) slot = null;
    try {
      s.worker?.terminate();
    } catch {
      /* already gone */
    }
    if (s.workerUrl) {
      try {
        URL.revokeObjectURL(s.workerUrl);
      } catch {
        /* URL cleanup must not stop the rest */
      }
      s.workerUrl = undefined;
    }
    if (crash) {
      epoch++;
      crashes++;
      lastCrash = why;
      state = "crashed";
      names = [];
      frameInFlight = null;
      log(`[live] the engine's worker is gone: ${why}`);
    }
    // The state is settled before anybody waiting hears of it.
    for (const [id, request] of pending) {
      if (request.slot !== s) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(new Error(why));
    }
    const reject = s.rejectBoot;
    s.rejectBoot = undefined;
    reject?.(new Error(why));
    if (crash) {
      try {
        options.onCrash?.(why);
      } catch (error) {
        log(`[live] onCrash failed: ${String(error)}`);
      }
    }
  };

  const onMessage = (s: Slot, data: Record<string, unknown>): void => {
    if (s.failed || slot !== s) return;
    if (data.fatal !== undefined) {
      retire(s, `the simulation engine stopped working: ${String(data.fatal)}`, true);
      return;
    }
    if (Array.isArray(data.log)) {
      try {
        // the lines first: what the engine says about a part came before what its chip sent after it
        if (data.log.length || data.dropped) options.onLog?.(data.log as LiveLogLine[], Number(data.dropped) || 0);
      } catch (error) {
        log(`[live] onLog failed: ${String(error)}`);
      }
      if (Array.isArray(data.serial)) {
        try {
          options.onSerial?.(data.serial as LiveSerialChunk[]);
        } catch (error) {
          log(`[live] onSerial failed: ${String(error)}`);
        }
      }
      return;
    }
    if (typeof data.id !== "number") return;
    const request = pending.get(data.id);
    if (!request || request.slot !== s) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    const res = (data.res ?? {}) as WorkerResult;
    if (res.error) request.reject(new Error(res.error));
    else request.resolve(res);
  };

  const ensureWorker = (): Promise<Slot> => {
    if (slot) return slot.ready;
    const s = { failed: false } as Slot;
    slot = s;

    const deadline = new Promise<never>((_resolve, reject) => {
      s.rejectBoot = reject;
      s.bootTimer = setTimeout(() => {
        retire(s, `the simulation engine did not start within ${bootTimeoutMs} ms`, true);
      }, bootTimeoutMs);
    });

    const boot = (async () => {
      const base = await resolveWasmBase("ngspice_service");
      if (s.failed) throw new Error("the simulation engine was closed while it started");
      const glue = new URL(`${base}/ngspice_service.js`, window.location.href).href;
      log(`[live] booting the engine from ${base}`);
      s.workerUrl = URL.createObjectURL(
        new Blob(liveWorkerBlobParts(glue), { type: "text/javascript" }),
      );
      const worker = new Worker(s.workerUrl);
      s.worker = worker;
      worker.onerror = (e) =>
        retire(s, `the simulation engine stopped working: ${e.message || "worker error"}`, true);
      worker.onmessageerror = () =>
        retire(s, "the simulation engine stopped working: a message could not be read", true);

      await new Promise<void>((resolve) => {
        worker.onmessage = (e) => {
          const data = (e.data ?? {}) as Record<string, unknown>;
          if (data.ready) {
            if (s.bootTimer !== undefined) clearTimeout(s.bootTimer);
            s.bootTimer = undefined;
            s.rejectBoot = undefined;
            s.booted = true;
            worker.onmessage = (ev) => onMessage(s, (ev.data ?? {}) as Record<string, unknown>);
            resolve();
          } else if (data.bootError !== undefined) {
            retire(s, `the simulation engine did not start: ${String(data.bootError)}`, true);
          } else if (data.fatal !== undefined) {
            retire(s, `the simulation engine did not start: ${String(data.fatal)}`, true);
          }
        };
      });
      if (s.failed) throw new Error("the simulation engine was closed while it started");
      log("[live] the engine is ready");
      return s;
    })();

    s.ready = Promise.race([boot, deadline]).catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      retire(s, why, true);
      throw error instanceof Error ? error : new Error(why);
    });
    return s.ready;
  };

  const send = (
    s: Slot,
    cmd: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WorkerResult> => {
    const worker = s.worker;
    if (!worker || s.failed || slot !== s)
      return Promise.reject(new Error("the simulation engine is not running"));
    const id = nextId++;
    return new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.get(id)?.slot !== s) return;
        retire(s, `the simulation engine did not answer "${cmd}" within ${timeoutMs} ms`, true);
      }, timeoutMs);
      pending.set(id, { slot: s, resolve, reject, timer });
      try {
        worker.postMessage({ id, cmd, ...args });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  /**
   * A command for the Worker that is there. Without one, nothing is sent; neither to one
   * that is still being made: it runs nothing and does not hear commands yet.
   */
  const tell = async (cmd: string, args: Record<string, unknown>): Promise<void> => {
    const s = slot;
    if (!s || s.failed || !s.worker || !s.booted) return;
    await send(s, cmd, args, responseTimeoutMs);
  };

  const launch = async (): Promise<void> => {
    const run = circuit;
    if (!run) throw new Error("there is no circuit to run");
    const mine = ++epoch;
    state = "starting";
    names = [];
    frameInFlight = null;
    try {
      const s = await ensureWorker();
      // a stop (or another start) came while the Worker was being made: this run is not wanted any more
      if (epoch !== mine) throw new Error("the start was given up");
      await send(
        s,
        "start",
        {
          deck: run.deck,
          files: run.files,
          inputs: { ...inputs },
          parts: [...parts].map(([name, bytes]) => ({ name, bytes })),
          speed,
        },
        startTimeoutMs,
      );
      if (epoch === mine) state = "running";
    } catch (error) {
      // A crash has set its own state; anything else leaves a circuit that does not run.
      if (epoch === mine) state = "stopped";
      throw error;
    }
  };

  return {
    get state() {
      return state;
    },
    get crashes() {
      return crashes;
    },
    get lastCrash() {
      return lastCrash;
    },

    start(next: LiveCircuit): Promise<void> {
      circuit = next;
      inputs = { ...next.inputs };
      parts = new Map(next.parts.map((p) => [p.name, p.bytes]));
      return launch();
    },

    restart(): Promise<void> {
      return launch();
    },

    async stop(): Promise<void> {
      const mine = ++epoch;
      frameInFlight = null;
      try {
        await tell("stop", {});
      } catch (error) {
        // A run that cannot be stopped holds the Worker's thread: throw the Worker away.
        const s = slot;
        if (s && epoch === mine) {
          retire(s, `the simulation engine stopped working: ${error instanceof Error ? error.message : String(error)}`, true);
        }
        throw error;
      }
      if (epoch === mine) state = circuit ? "stopped" : "idle";
    },

    async setPaused(paused: boolean): Promise<void> {
      if (state !== "running" && state !== "paused") return;
      const mine = epoch;
      await tell("pause", { paused });
      if (epoch === mine) state = paused ? "paused" : "running";
    },

    async setSpeed(next: number): Promise<void> {
      speed = Number.isFinite(next) && next > 0 ? next : 0;
      await tell("speed", { speed });
    },

    async setInput(name: string, value: number): Promise<void> {
      inputs[name] = value;
      if (state !== "running" && state !== "paused") return;
      await tell("input", { name, value });
    },

    async setPart(name: string, bytes: Uint8Array): Promise<void> {
      parts.set(name, bytes);
      if (state !== "running" && state !== "paused") return;
      await tell("part", { name, bytes });
    },

    async sendSerial(name: string, bytes: Uint8Array): Promise<void> {
      const s = slot;
      if ((state !== "running" && state !== "paused") || !s || s.failed || !s.worker) throw new Error("nothing runs");
      await send(s, "serial", { name, bytes }, responseTimeoutMs);
    },

    frame(): Promise<LiveFrame | null> {
      const s = slot;
      if (!s || s.failed || !s.worker || (state !== "running" && state !== "paused"))
        return Promise.resolve(null);
      if (frameInFlight) return frameInFlight;
      const mine = epoch;
      const asked = send(s, "frame", {}, responseTimeoutMs).then((res): LiveFrame | null => {
        if (epoch !== mine) return null;
        if (res.names) names = res.names;
        const running = res.running !== false;
        // The run ended by itself: ngspice gave up on it, or a code part could not be loaded.
        if (!running) state = "stopped";
        return {
          t: res.t ?? 0,
          points: res.points ?? 0,
          load: res.load ?? 0,
          achieved: res.achieved ?? 0,
          lagging: !!res.lagging,
          running,
          problem: res.problem ?? null,
          names,
          latest: res.latest ?? new Float64Array(0),
          avg: res.avg ?? new Float64Array(0),
        };
      });
      const done = asked.finally(() => {
        if (frameInFlight === done) frameInFlight = null;
      });
      frameInFlight = done;
      return done;
    },

    dispose(): void {
      epoch++;
      const s = slot;
      if (s) retire(s, "the simulation engine was closed", false);
      circuit = null;
      inputs = {};
      parts = new Map();
      names = [];
      frameInFlight = null;
      state = "idle";
    },
  };
}
