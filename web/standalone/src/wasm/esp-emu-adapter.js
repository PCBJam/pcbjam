/*
 * Espressif's ESP32 emulator as the program of a chip part in a live simulation.
 *
 * A chip of the simulation library that runs the user's firmware is a "packaged part"
 * (wasm/ngspice-service/ngspice_live.cpp, pj_part_load): its files (the emulator, the
 * firmware) come in one package, and the engine hands them to the adapter the package
 * names. This file is that adapter for Espressif's emulator. It runs the firmware image on
 * the emulated chip and answers the three calls ngspice's d_cosim makes of every code part.
 *
 * It runs in the simulation thread. live-engine.ts puts this file's text in front of the
 * live Worker's script (ngspice-live-worker.js), which is the script of the engine's
 * threads too, so the adapter is there before the engine asks for it. It has no import and
 * no export: it is a script for a Worker and, in a test, a module loaded for what it does.
 *
 * The ports, for a chip with N modelled pads (config.pads lists their GPIO numbers):
 *   inputs   0 .. N-1    the level ON each pad, as ngspice computed it
 *            N           the chip's enable pin (when config.enable is set)
 *   outputs  0 .. N-1    the level the chip drives on each pad
 *            N .. 2N-1   output enable: 1 = the chip drives the pad
 *            2N .. 3N-1  pull-up on,  3N .. 4N-1  pull-down on
 * What the pads do electrically (driver resistance, pull resistors, thresholds) is in the
 * part's SPICE model, not here.
 *
 * Time. The emulator has its own clock. ngspice says "advance to time T"; the emulator is
 * run in small batches until its clock reaches T. Which clock: every message of the
 * emulator carries its time, and it sends a "heartbeat" message every 20 us of chip time
 * (the quantum given to cosim_attach). That is the clock used here. Its cycle counter
 * (cycles()) is used as well where it is ahead of the last message, which makes a one-core
 * chip stop within a few instructions of T. On a two-core chip the counter cannot be the
 * clock (while one core sleeps and the other works, the normal state of an Arduino sketch,
 * it hardly moves), so there the heartbeat decides and the chip stops up to about 25 us
 * after T. Two things keep the two clocks together:
 *   - pin changes from the chip arrive stamped with the emulator's time and are handed to
 *     ngspice one at a time, each at its own time;
 *   - pin changes from ngspice are scheduled in the emulator at their ngspice time.
 *
 * A limit of the emulator (1.0.0-rc2), measured: a chip that sleeps (nothing to do until
 * its next timer tick) moves its clock to that tick in ONE step. So a sleeping chip's
 * clock runs ahead of ngspice by up to one tick, and a pin change that arrives meanwhile
 * is seen at the tick: up to 1 ms late with the Arduino core, up to 10 ms with ESP-IDF's
 * default. Nothing is lost and nothing is reported in the past; an awake chip reacts
 * within microseconds.
 *
 * The emulator's own JavaScript (its loader) is not part of this app. The page takes it
 * from the simulation library, checks it against the library's checksum and hands this
 * thread an address to load it from (config.glueUrl); what that script leaves behind is
 * found in globalThis.__pjGlue under config.emulatorKey.
 */
(function () {
  "use strict";

  function espEmuAdapter(env) {
    const blobs = env.blobs, config = env.config, out = env.out, log = env.log;
    const ZERO = 0, ONE = 1, STRONG = 0;
    const NAME = "pcbjam";
    const pads = config.pads, N = pads.length;
    const BATCH = config.batch || 1000;                 // instructions per run, at most
    const QUANTUM_US = config.quantumUs || 20;          // the emulator's clock heartbeat
    // the smallest run: a one-core chip can be stopped almost exactly; a two-core one is told
    // its time by the heartbeat only, so smaller runs than a part of the quantum buy nothing
    const MIN_BATCH = (config.cores || 1) > 1 ? 400 : 16;
    const GROUP = 5e-8;                                 // pin changes this close go to ngspice together
    // ... and two groups are never closer than this. d_cosim holds one pending change per
    // part: a second one that arrives before the first is placed (its "delay", 1 us in the
    // part's model) takes the first one's place. The later change waits.
    const SPACING = (config.delayUs || 1) * 1.25e-6;
    const padOf = new Map(pads.map((g, i) => [g, i]));
    // Pads with nothing connected in the schematic (config.wired lists the others; without
    // the list every pad counts as wired). ngspice is told nothing about them and nothing it
    // says about them is used: a firmware may toggle such a pin thousands of times a second,
    // and every change handed to ngspice costs analog work although nobody can see it.
    const silent = pads.map((g) => Array.isArray(config.wired) && !config.wired.includes(g));
    const dec = new TextDecoder(), enc = new TextEncoder();

    // ---- the few protobuf messages of the emulator's contract for outside parts (esp_cosim.proto)
    const varint = (n) => { const o = []; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
    const fVar = (no, n) => varint(no * 8).concat(varint(n));
    const fLen = (no, body) => varint(no * 8 + 2).concat(varint(body.length), body);
    const message = (ns, field, body) => new Uint8Array((ns > 0 ? fVar(1, ns) : []).concat(fLen(field, body)));
    const register = (mask) => message(0, 4, fVar(1, 1).concat(fLen(2, Array.from(enc.encode(NAME))), fLen(3, fLen(1, fVar(1, mask).concat(fVar(2, mask))))));
    const gpioDrive = (ns, pin, level) => message(ns, 6, fVar(1, pin).concat(fVar(2, level ? 1 : 0)));
    function read(buf) {                                // -> { field number: [values] }
      const o = {};
      let i = 0;
      const rv = () => { let v = 0, m = 1; for (;;) { const b = buf[i++]; v += (b & 127) * m; if (b < 128) return v; m *= 128; } };
      while (i < buf.length) {
        const key = rv(), no = Math.floor(key / 8), wt = key % 8;
        let val;
        if (wt === 0) val = rv();
        else if (wt === 2) { const n = rv(); val = buf.subarray(i, i + n); i += n; }
        else if (wt === 1) { val = buf.subarray(i, i + 8); i += 8; }
        else if (wt === 5) { val = buf.subarray(i, i + 4); i += 4; }
        else throw new Error("unknown wire type " + wt);
        (o[no] = o[no] || []).push(val);
      }
      return o;
    }
    const num = (m, no) => (m[no] ? m[no][0] : 0);

    // ---- the emulator. Its program is compiled and set up once per simulation thread and
    // then shared: by every chip of a circuit, and by the next run. Each chip is its own
    // WasmEmulator object inside it.
    const loaders = (globalThis.__pjGlue = globalThis.__pjGlue || {});
    const key = String(config.emulatorKey || "esp-emu");
    if (!loaders[key] && config.glueUrl && typeof importScripts === "function") importScripts(config.glueUrl);
    const glue = loaders[key];
    if (!glue || typeof glue.WasmEmulator !== "function" || typeof glue.initSync !== "function")
      throw new Error("the emulator's loader is not there");
    if (!glue.ready) {
      const exports = glue.initSync({ module: new WebAssembly.Module(blobs["emulator.wasm"]) });
      glue.memory = () => exports.memory.buffer.byteLength;      // for the statistics
      glue.ready = true;
    }

    let emu = null, perSec = 0;
    let base = 0;                    // ngspice time at which the emulator's clock read 0
    let seen = 0;                    // the latest time (s) the emulator's messages have shown
    let progressAt = 0, stalled = false;
    let powered = false, held = false, dead = false;
    let enable = config.enable ? -1 : 1;                // -1: ngspice has not said yet
    // What each pad reads, last word from ngspice: 0, 1, or -1 = ngspice cannot say (the pin
    // is not connected, or sits between the thresholds). A pad ngspice cannot say anything
    // about is NOT driven: the emulator then reads it as the chip's own pulls leave it. This
    // matters at power-up: at time zero ngspice reports every digital node as low before the
    // circuit has settled, and a chip that sees its boot-mode pins low does not boot.
    const inLevel = new Array(N).fill(-1);
    const told = { oe: new Array(N).fill(0), pu: new Array(N).fill(0), pd: new Array(N).fill(0) };
    // A pad that starts to drive before the emulator has said which level it drives: the
    // firmware switches the output on, and the emulator names the level 2 to 18 us later (on
    // the real chip the level is there at once). So "drives" waits for the level, at most
    // OE_HOLD of chip time; a pad that never gets a level (an open-drain bus that idles
    // high) is then driven at the reset value.
    const OE_HOLD = 50e-6;
    const levelKnown = new Array(N).fill(false);
    const oeWaits = new Array(N).fill(-1);             // since when a pad's "drives" is held back, or -1
    const queue = [];                // pin changes ngspice has not been given yet: { t, bit, state }
    let floor = 0;                   // emulator time ngspice has been told about; nothing may be stamped before it
    let gate = 0;                    // the next group may not go out before this (SPACING after the last one)
    let consoleLine = "";
    const stat = { real: 0, batches: 0, inputs: 0, late: 0, maxLateUs: 0, emuLate: 0, emuMaxLateUs: 0, out: 0, unwired: 0, restarts: 0, readBack: 0, nextReport: 0 };

    const now = () => Math.max(seen, emu.cycles() / perSec);
    const send = (bytes) => emu.cosim_push_inbound(NAME, bytes);
    const put = (t, bit, state) => {
      if (silent[bit % N]) { stat.unwired++; return; }
      const at = Math.max(t, floor);
      let i = queue.length;
      while (i > 0 && queue[i - 1].t > at) i--;
      queue.splice(i, 0, { t: at, bit, state });
    };

    // What the firmware prints on its serial pins. An engine that takes the text as it
    // comes gets it so (env.serial; a line need not be whole). An engine without it gets
    // whole lines in the part's log, marked "> ".
    const sends = typeof env.serial === "function";
    let saidTyped = false;
    function consoleText(text) {
      if (sends) { env.serial(text); return; }
      consoleLine += text;
      for (;;) {
        const cut = consoleLine.indexOf("\n");
        if (cut < 0) break;
        const line = consoleLine.slice(0, cut).split("\r").join("");
        consoleLine = consoleLine.slice(cut + 1);
        if (line.trim()) log("> " + (line.length > 300 ? line.slice(0, 300) + " ..." : line));
      }
      if (consoleLine.length > 2000) consoleLine = consoleLine.slice(-300);
    }

    // What the emulator has to say since the last call: pin levels (stamped), its clock report.
    function collect() {
      for (;;) {
        const f = emu.cosim_take_outbound();
        if (!f.length) break;
        const m = read(f.subarray(2 + (f[0] | (f[1] << 8))));
        const stamp = num(m, 1) / 1e9;
        if (stamp > seen) seen = stamp;
        if (m[3]) {
          const g = read(m[3][0]), pad = padOf.get(num(g, 1));
          if (pad !== undefined) {
            put(stamp, pad, num(g, 2) ? ONE : ZERO); stat.out++;
            levelKnown[pad] = true;
            if (oeWaits[pad] >= 0) { oeWaits[pad] = -1; put(stamp, N + pad, 1); }   // level first, then "drives"
          }
        } else if (m[2]) {
          const c = read(m[2][0]);
          stat.emuLate = num(c, 1);
          stat.emuMaxLateUs = num(c, 2) / 1000;
        } else if (m[5]) {
          const a = read(m[5][0]);
          if (!num(a, 5)) log("the emulator refused us: " + (a[6] ? dec.decode(a[6][0]) : "no reason given"));
        }
      }
      // which pads the chip drives: its output-enable register
      const g = emu.gpio_state(), t = now();
      for (let i = 0; i < N; i++) {
        const pin = pads[i], on = pin < 32 ? (g[2] >>> pin) & 1 : (g[3] >>> (pin - 32)) & 1;
        if (on !== told.oe[i]) {
          told.oe[i] = on;
          if (on && !levelKnown[i]) oeWaits[i] = t;              // wait for its level
          else if (!on && oeWaits[i] >= 0) oeWaits[i] = -1;      // switched off again before anything was said
          else put(t, N + i, on);
        } else if (oeWaits[i] >= 0 && t - oeWaits[i] >= OE_HOLD) { oeWaits[i] = -1; levelKnown[i] = true; put(t, N + i, 1); }
      }
    }

    // Pull-up and pull-down are set by the firmware in the chip's pad registers. The
    // emulator has no call for them, so they are read from the registers' memory.
    function pulls() {
      const io = config.iomux;
      if (!io) return;
      const t = now();
      const mem = emu.read_memory(io.base, 4 * io.count);
      for (let i = 0; i < N; i++) {
        const at = 4 * pads[i], reg = mem[at] | (mem[at + 1] << 8);
        const pu = (reg >>> io.pullUpBit) & 1, pd = (reg >>> io.pullDownBit) & 1;
        if (pu !== told.pu[i]) { told.pu[i] = pu; put(t, 2 * N + i, pu); }
        if (pd !== told.pd[i]) { told.pd[i] = pd; put(t, 3 * N + i, pd); }
      }
    }

    // Every pad as it is after a reset: not driven, no pulls.
    function resetPads(t) {
      for (let i = 0; i < N; i++) {
        put(t, i, ONE);
        put(t, N + i, ZERO); put(t, 2 * N + i, ZERO); put(t, 3 * N + i, ZERO);
        told.oe[i] = told.pu[i] = told.pd[i] = 0;
        levelKnown[i] = false; oeWaits[i] = -1;
      }
    }

    function boot() {
      emu = new glue.WasmEmulator(config.chip);
      emu.load_default_rom();
      emu.load_firmware(blobs["firmware.bin"]);
      perSec = emu.cycles_per_us() * 1e6;
      emu.cosim_attach(QUANTUM_US);
      let mask = 0;
      for (const p of pads) mask += Math.pow(2, p);
      send(register(mask));
      emu.cosim_service();
      for (let i = 0; i < N; i++) if (inLevel[i] >= 0) send(gpioDrive(0, pads[i], inLevel[i]));
      // one line that explains a chip that does not come up: what its pins were held at
      const at = (v) => pads.filter((_, i) => inLevel[i] === v).join(" ") || "none";
      log("power-up: pins held low by the circuit: " + at(0) + "; held high: " + at(1) + "; the rest float");
      collect();
    }

    // Start the chip's clock again at ngspice time t (a reset: the enable pin, or the firmware's own).
    function rebase(t) {
      base = t; floor = 0; gate = 0; queue.length = 0;
      seen = 0;                      // after a restart the emulator's clock starts from 0 again
      stat.nextReport = 0;
      resetPads(0);
    }

    // When the next pin change(s) may go to ngspice: their own time, or later if the last group is too close.
    const due = () => (queue.length ? Math.max(queue[0].t, gate) : Infinity);

    // Hand ngspice the next pin change(s), if they are due. Returns their time, or -1.
    function flush(goal) {
      const t = due();
      if (t > goal) return -1;
      while (queue.length && queue[0].t <= t + GROUP) {
        const q = queue.shift();
        out(base + t, q.bit, q.state, STRONG);
      }
      floor = t;
      gate = t + SPACING;
      return t;
    }

    function report(t) {
      if (!config.stats || t < stat.nextReport) return;
      stat.nextReport = t + config.stats;
      log("@stat " + JSON.stringify({ t: Number(t.toFixed(6)), real: Number(stat.real.toFixed(1)), batches: stat.batches, out: stat.out,
        inputs: stat.inputs, readBack: stat.readBack, late: stat.late, maxLateUs: Number(stat.maxLateUs.toFixed(3)), emuLate: stat.emuLate,
        emuMaxLateUs: Number(stat.emuMaxLateUs.toFixed(3)), restarts: stat.restarts, unwired: stat.unwired, memoryMB: Math.round(glue.memory() / 1048576),
        // which pads the firmware drives, and where it switched on a pull resistor (GPIO numbers)
        drives: pads.filter((_, i) => told.oe[i]), pullUp: pads.filter((_, i) => told.pu[i]), pullDown: pads.filter((_, i) => told.pd[i]) }));
    }

    return {
      // in | out << 8 | inout << 16 | method << 24 (0 = ngspice's "Normal": step, then input)
      pj_setup() { return (N + (config.enable ? 1 : 0)) | ((4 * N) << 8); },

      // ngspice: "advance to this time; stop early, and say when, if a pin changes".
      pj_step(target) {
        if (dead) return target;
        if (!powered) {
          // Power up a microsecond into the run, not at time 0 and not at the very first
          // step: ngspice needs its first steps to settle what the pins read (see inLevel).
          if (!(target >= 1e-6)) return target;
          powered = true;
          try { boot(); } catch (e) { dead = true; emu = null; log("the emulator did not start: " + e); return target; }
          rebase(target);
          held = enable !== 1;
          if (held) log("the enable pin is not high: the chip is held in reset");
        }
        let goal = target - base;
        const first = flush(goal);
        if (first >= 0) return base + first;
        if (held) { floor = goal; return target; }

        const started = performance.now();
        let runs = 0;
        progressAt = started;
        for (;;) {
          const t = now();
          if (t >= goal) break;
          const text = emu.run_batch(Math.max(MIN_BATCH, Math.min(BATCH, Math.ceil((goal - t) * perSec))));
          stat.batches++;
          if (text) consoleText(text);
          if (emu.needs_restart()) {                    // the firmware reset the chip itself
            const at = now();
            emu.restart();
            stat.restarts++;
            if (stat.restarts <= 3) log("the firmware restarted the chip");
            else if (stat.restarts === 4) log("the firmware keeps restarting the chip: it does not get through its start-up (further restarts are only counted)");
            rebase(base + at);                          // its clock starts again from 0 here
            goal = target - base;
            continue;
          }
          collect();
          if ((++runs & 3) === 0) pulls();
          if (due() <= goal) break;
          // a clock that stands still: wait a quarter of a second of real time, then give this step up
          const real = performance.now();
          if (now() > t) { progressAt = real; stalled = false; }
          else if (real - progressAt > 250) { if (!stalled) log("the emulator's clock stands still"); stalled = true; break; }
        }
        pulls();
        stat.real += performance.now() - started;
        report(goal);
        const at = flush(goal);
        if (at >= 0) return base + at;
        floor = goal;
        return target;
      },

      // ngspice: "this pad is at this level now".
      pj_input(time, bit, state) {
        if (bit < N && silent[bit]) return;             // a pad with nothing connected reads as the chip's own pulls leave it
        if (state !== ZERO && state !== ONE) {
          // between the thresholds. A running chip keeps what the pad read last (as its
          // input stage does); before power-up it means "nothing is driving this pin".
          if (!powered && bit < N) inLevel[bit] = -1;
          return;
        }
        if (bit === N) {                                // the enable pin
          const was = enable;
          enable = state;
          if (!powered || dead || was === state) return;
          if (state === ZERO) {
            held = true;
            resetPads(Math.max(time - base, floor));
            log("enable went low: the chip is in reset");
          } else {
            emu.restart();
            stat.restarts++;
            rebase(time);
            held = false;
            for (let i = 0; i < N; i++) if (inLevel[i] >= 0) send(gpioDrive(0, pads[i], inLevel[i]));
            log("enable went high: the chip starts");
          }
          return;
        }
        if (bit > N) return;
        inLevel[bit] = state;
        if (!powered || dead) return;
        const at = time - base, ns = Math.max(0, Math.round(at * 1e9));
        // A pad the chip drives is read back like any other (firmware may read its own
        // output); only changes on the other pads are news from the circuit, and only those
        // are counted.
        if (!told.oe[bit]) {
          const behind = (now() - at) * 1e6;            // the emulator is already past this moment by so much
          stat.inputs++;
          if (behind > 0.5) { stat.late++; if (behind > stat.maxLateUs) stat.maxLateUs = behind; }
        } else stat.readBack++;
        send(gpioDrive(ns, pads[bit], state));          // a sleeping chip sees it at its next tick: see the top of the file
      },

      // The user typed this to the chip: bytes for its serial input (UART0, the pins the
      // console is on).
      pj_serial(bytes) {
        if (dead || !powered || held || !emu) return;   // a chip in reset hears nothing, as on a board
        if (typeof emu.uart_input === "function") emu.uart_input(bytes);
        else if (!saidTyped) { saidTyped = true; log("this emulator takes no typed text"); }
      },

      pj_unload() { if (emu) { emu.free(); emu = null; } },
    };
  }

  (globalThis.__pjAdapters = globalThis.__pjAdapters || {})["esp-emu"] = espEmuAdapter;
})();
