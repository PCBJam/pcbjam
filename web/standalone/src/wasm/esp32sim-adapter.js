/*
 * esp32sim, an open ESP32 emulator, as the program of a chip part in a live simulation.
 *
 * A chip of the simulation library that runs the user's firmware is a "packaged part"
 * (wasm/ngspice-service/ngspice_live.cpp, pj_part_load): its files (the emulator, the
 * chip's ROM, the firmware) come in one package, and the engine hands them to the adapter
 * the package names. This file is that adapter for esp32sim (github.com/mikroverk/esp32sim,
 * MIT). The simulation library builds the emulator from its source with one file added:
 * the functions called esp32sim_cosim_* below, which hand on what the emulator has inside
 * for a circuit simulator (a pad driven from outside, the state of the pads, the stamped
 * list of pad changes, an analog voltage, PWM, serial input). This file runs the firmware
 * image on the emulated chip and answers the calls ngspice's d_cosim makes of every code
 * part.
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
 * Time. The emulator counts the chip's clock cycles and runs for exactly as many as it is
 * asked for, a sleeping chip too. ngspice says "advance to time T"; the chip is run to T
 * in pieces, and after each piece this file looks at the pads. A piece is 20 us long
 * (config.chunkUs) while the pads are busy; every piece in which no pad did anything
 * doubles the next one, up to 500 us (config.quietChunkUs), and a change on a pad, from
 * the chip or from the circuit, makes it short again. So:
 *   - a pad the chip drives and switches: the emulator logs the change with its cycle, and
 *     ngspice gets it at that time, exactly. The same for a pad that starts to drive high,
 *     or is let go while high;
 *   - a pad that starts to drive low or is let go while low, and the pull-up and pull-down
 *     of every pad: seen at the end of the piece, so ngspice gets them up to a piece late
 *     (20 us while the pads are busy, up to 500 us for the first change after a quiet time);
 *   - a pin change from ngspice goes to the chip as it comes. The chip is at ngspice's time
 *     then, except after a piece in which a pad changed: there it is up to a piece ahead.
 *
 * PWM. The chip's PWM unit (LEDC) is described by the emulator as a frequency and a share
 * of high time, not as edges. The edges are made here, counted from the moment the wave
 * was first seen; a change of the wave is seen within a millisecond.
 *
 * Analog inputs. The part's model has a "voltage tap" that hands the engine the voltage on
 * each pad with a converter after every time step (env.volt). config.tapPads names the
 * tap's inputs by GPIO number, in their order. Before the chip is run on, each of these
 * pads is given the voltage it has now; the emulator's converter does the rest (range,
 * resolution, the chip's calibration). A part without taps, or an engine without env.volt:
 * the converter reads what the emulator reads on a pad nobody set.
 *
 * Serial. What the firmware prints on its console goes to the engine as it comes
 * (env.serial; a line need not be whole), or, for an engine without it, as whole lines in
 * the part's log, marked "> ". The console is UART0 or the chip's USB serial, whichever
 * the firmware uses; what comes on both (the ROM's start-up lines, ESP-IDF's log) is shown
 * once. What the user types goes to UART0, and to USB serial as well once the firmware has
 * said something there alone.
 *
 * What the emulator leaves out, and so this part: what a unit other than the PWM unit
 * sends on a pad (UART, I2C, SPI, RMT) is not on the pad: the pad shows its own output
 * register. The boot-mode pins are not read at power-up: the chip always starts its
 * firmware.
 *
 * One chip per instance of the emulator's program: the program is compiled once per
 * simulation thread, and every chip gets an instance of its own.
 *
 * The emulator's own JavaScript (jit.mjs: it installs code the emulator translated for
 * speed) is not part of this app. The page takes it from the simulation library, checks
 * it against the library's checksum and hands this thread an address to load it from
 * (config.glueUrl); what that script leaves behind is found in globalThis.__pjGlue under
 * config.emulatorKey.
 */
(function () {
  "use strict";

  // The chips of the library's parts as the emulator knows them: its name for the bare
  // chip, and the PSRAM its module may carry (firmware built without PSRAM never looks).
  const CHIPS = {
    esp32c3: { board: "esp32c3", psramMb: 0 },
    esp32s3: { board: "none", psramMb: 8 },
  };
  // Why a run ended, by the emulator's code.
  const STOPS = {
    2: "its program reached an instruction the emulator does not have",
    3: "its program stopped at a breakpoint",
    4: "its program fails again and again",
    5: "its program asked a debugger for something",
    9: "it was not started",
  };

  function esp32simAdapter(env) {
    const blobs = env.blobs, config = env.config, out = env.out, log = env.log;
    // What the user has to be told: the chip does not run, or not as its firmware expects.
    // The page shows such a line where the user looks (live-session.ts, "! ").
    const trouble = (text) => log("! " + text);
    const ZERO = 0, ONE = 1, STRONG = 0;
    const pads = config.pads, N = pads.length;
    // the chip runs this long between two looks at its pads: while they are busy, and at most while they are quiet
    const CHUNK_S = (config.chunkUs || 20) * 1e-6, QUIET_CHUNK_S = Math.max(config.chunkUs || 20, config.quietChunkUs || 500) * 1e-6;
    const PWM_LOOK_S = 1e-3;                            // how often the PWM unit is asked what it sends
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
    // The voltage tap: the GPIO each of its inputs is on (-1: not a pad of the chip).
    const tapPads = Array.isArray(config.tapPads) ? config.tapPads : [];
    const measures = tapPads.length > 0 && typeof env.volt === "function";
    const tapVolt = new Array(tapPads.length).fill(NaN);
    const dec = new TextDecoder(), enc = new TextEncoder();
    const chip = CHIPS[config.chip];
    if (!chip) throw new Error("the emulator has no chip \"" + config.chip + "\"");

    // ---- the emulator. Its program is compiled once per simulation thread; a chip is an
    // instance of it.
    const loaders = (globalThis.__pjGlue = globalThis.__pjGlue || {});
    const key = String(config.emulatorKey || "esp32sim");
    if (!loaders[key] && config.glueUrl && typeof importScripts === "function") importScripts(config.glueUrl);
    const glue = loaders[key];
    if (!glue || typeof glue.createJitHost !== "function") throw new Error("the emulator's loader is not there");
    if (!glue.module) glue.module = new WebAssembly.Module(blobs["emulator.wasm"]);

    let w = null;                    // the instance's functions
    let emu = 0;                     // the chip in it, or 0: there is none (not powered, held in reset, stopped)
    let HZ = 0;                      // the chip's clock
    const wall = Date.now();         // the chip's calendar clock starts at the real time and then follows the simulation
    const words = [];                // the emulator's own last lines: said when it cannot go on
    const note = (text) => { if (text) { words.push(String(text).trim()); if (words.length > 6) words.shift(); } };
    const lastWords = () => (words.length ? words[words.length - 1] : "");

    let base = 0;                    // ngspice time at which the chip's clock read 0
    let powered = false, held = false, dead = false;
    // Restarts that came soon after a start, one after the other: a firmware that does not
    // get through its start-up. A restart after the chip ran a while is the firmware's own.
    const QUICK_RESTART_S = 3;
    let quick = 0, startedAt = 0;
    let enable = config.enable ? -1 : 1;                // -1: ngspice has not said yet
    // What each pad reads, last word from ngspice: 0, 1, or -1 = ngspice cannot say (the pin
    // is not connected, or sits between the thresholds). A pad ngspice cannot say anything
    // about is NOT driven: the chip then reads it as nothing outside holds it. At time zero
    // ngspice reports every digital node as low before the circuit has settled, which is
    // why the chip gets its power a microsecond into the run and not before.
    const inLevel = new Array(N).fill(-1);
    // What ngspice has been told of each pad: drives, the level, pull-up, pull-down.
    const told = { oe: new Array(N).fill(0), lv: new Array(N).fill(-1), pu: new Array(N).fill(0), pd: new Array(N).fill(0) };
    // The PWM wave on a pad, or null: { hz, duty, period, high, from, k, level, at } - the next edge is `level` at time `at`.
    const pwm = new Array(N).fill(null);
    let pwmLookAt = 0;
    let chunk = CHUNK_S;             // the length of the next piece
    const lastOf = new Array(N).fill(-1);
    const queue = [];                // pin changes ngspice has not been given yet: { t, bit, state }
    let floor = 0;                   // chip time ngspice has been told about; nothing may be stamped before it
    let gate = 0;                    // the next group may not go out before this (SPACING after the last one)
    let consoleLine = "";
    const stat = { real: 0, runs: 0, inputs: 0, late: 0, maxLateUs: 0, out: 0, unwired: 0, restarts: 0, readBack: 0, nextReport: 0 };

    const now = () => w.esp32sim_cycles(emu) / HZ;
    function withBytes(bytes, f) {
      const p = w.esp32sim_alloc(bytes.length);
      try {
        new Uint8Array(w.memory.buffer).set(bytes, p);
        return f(p, bytes.length);
      } finally { w.esp32sim_free(p, bytes.length); }
    }
    const put = (t, bit, state) => {
      if (silent[bit % N]) { stat.unwired++; return; }
      const at = Math.max(t, floor);
      let i = queue.length;
      while (i > 0 && queue[i - 1].t > at) i--;
      queue.splice(i, 0, { t: at, bit, state });
    };

    // The flash an image was built for is in its header (byte 3, upper half: 1 MB, doubled
    // that many times). A chip with less restarts without end, so the chip gets that much,
    // and never less than the file is long. The emulator's limit is 32 MB.
    function flashMb(image) {
      const built = Math.pow(2, Math.min(7, image[3] >> 4));
      const filled = Math.pow(2, Math.ceil(Math.log2(Math.max(1, image.length / 1048576))));
      return Math.min(32, Math.max(built, filled));
    }

    // A new chip with the firmware in its flash, started through its ROM.
    function create() {
      if (!w) {
        const jit = glue.createJitHost(() => w);
        const imports = Object.assign({ host_profile_now: () => performance.now() }, jit.imports,
          { host_log: (p, n) => note(dec.decode(new Uint8Array(w.memory.buffer, p, n))) });
        w = new WebAssembly.Instance(glue.module, { env: imports }).exports;
      }
      const image = blobs["firmware.bin"], rom = blobs["rom.elf"];
      if (!rom) throw new Error("the chip's ROM did not come with the emulator");
      const psram = typeof config.psramMb === "number" ? config.psramMb : chip.psramMb;
      emu = withBytes(enc.encode(chip.board), (p, n) => w.esp32sim_new(p, n, flashMb(image), psram));
      if (!emu) throw new Error(lastWords() || "the chip could not be made");
      for (const [kind, bytes, what] of [[0, rom, "the chip's ROM"], [5, image, "the firmware image"]])
        if (withBytes(bytes, (p, n) => w.esp32sim_load(emu, kind, p, n)) !== 0) throw new Error(what + " was not taken" + (lastWords() ? ": " + lastWords() : ""));
      w.esp32sim_set_jit(emu, config.jit === false ? 0 : 1);
      if (w.esp32sim_boot(emu, 0) !== 0) throw new Error(lastWords() || "the chip did not start");
      w.esp32sim_cosim_observe(emu, 1);
      HZ = w.esp32sim_cpu_hz(emu);
      for (let i = 0; i < N; i++) if (inLevel[i] >= 0) w.esp32sim_cosim_pin_set(emu, pads[i], inLevel[i]);
      w.esp32sim_cosim_events_take(emu);                // those changes were this file's own
      tapVolt.fill(NaN);
    }
    function destroy() {
      if (emu) { try { w.esp32sim_delete(emu); } catch (e) { /* a chip that broke is left behind */ } emu = 0; }
    }

    // What the firmware prints on its console. An engine that takes the text as it comes
    // gets it so (env.serial; a line need not be whole). An engine without it gets whole
    // lines in the part's log, marked "> ".
    const sends = typeof env.serial === "function";
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
    // The chip has two consoles, USB serial and UART0, and much comes on both: the ROM's
    // start-up lines, and what ESP-IDF logs. The same text is shown once. What one console
    // said is kept for a few milliseconds of chip time, and what the other says is dropped as
    // far as it repeats that. Text that USB serial says alone is the firmware's own console.
    const TWIN_S = 5e-3;
    const lead = { usb: "", uart0: "" };                // said by one console and not repeated by the other yet
    let leadAt = 0, usbTalks = false;
    function forget(t) {
      if (t - leadAt <= TWIN_S) return;
      if (lead.usb) usbTalks = true;
      lead.usb = ""; lead.uart0 = "";
    }
    function said(src, text, t) {
      if (src !== "usb" && src !== "uart0") return;     // the other UARTs are not a console
      const other = src === "usb" ? "uart0" : "usb", twin = lead[other];
      forget(t);
      let k = 0;
      while (k < text.length && k < twin.length && text.charCodeAt(k) === twin.charCodeAt(k)) k++;
      // repeated so far; where the two go apart, the other's text is not waited for any more
      lead[other] = k < text.length ? "" : twin.slice(k);
      if (k === text.length) return;
      lead[src] += text.slice(k);
      leadAt = t;
      consoleText(text.slice(k));
    }

    function restarted(t) {
      stat.restarts++;
      quick = t - startedAt < QUICK_RESTART_S ? quick + 1 : 0;
      startedAt = t;
      if (quick === 4) trouble("the firmware keeps restarting the chip: it does not get through its start-up");
      else if (stat.restarts <= 3) log("the firmware restarted the chip");
    }

    // What the emulator has to say since the last call: the firmware's text, and its own words.
    function drain() {
      const n = w.esp32sim_out_take(emu), t = n ? now() : 0;
      for (let i = 0; i < n; i++) {
        if (w.esp32sim_out_kind(emu, i) !== 1) continue;       // 1 = a line of JSON
        const p = w.esp32sim_out_ptr(emu, i), len = w.esp32sim_out_len(emu, i);
        let m;
        try { m = JSON.parse(dec.decode(new Uint8Array(w.memory.buffer, p, len))); } catch (e) { continue; }
        if (m.t === "serial") said(m.src || "uart0", String(m.data || ""), t);
        else if (m.t === "emu") { note(m.msg); if (/\breset\b/i.test(String(m.msg))) restarted(t); }
      }
    }

    // The next edges of a pad's PWM wave, up to chip time t.
    function wave(i, t) {
      const p = pwm[i];
      while (p.at <= t) {
        if (told.lv[i] !== p.level) { put(p.at, i, p.level ? ONE : ZERO); told.lv[i] = p.level; stat.out++; }
        if (p.high <= 0 || p.high >= p.period) { p.at = Infinity; break; }     // always low, or always high
        if (p.level) { p.level = 0; p.at = p.from + p.k * p.period + p.high; }
        else { p.level = 1; p.k++; p.at = p.from + p.k * p.period; }
      }
    }
    // Which pads carry a PWM wave now, and which one.
    function lookPwm(t) {
      for (let i = 0; i < N; i++) {
        if (silent[i]) continue;
        const hz = w.esp32sim_cosim_pwm(emu, pads[i], 0);
        if (!(hz > 0)) {
          if (pwm[i]) { pwm[i] = null; told.lv[i] = -1; }       // the pad is its output register's again
          continue;
        }
        const duty = w.esp32sim_cosim_pwm(emu, pads[i], 1), p = pwm[i];
        if (p && p.hz === hz && p.duty === duty) continue;
        const period = 1 / hz, high = period * Math.min(1, Math.max(0, duty / 65535));
        pwm[i] = { hz, duty, period, high, from: t, k: 0, level: high > 0 ? 1 : 0, at: t };
      }
    }

    // What the pads did in the piece the chip just ran. The emulator's list has every change
    // of "the chip drives this pad high" with its cycle; the pads' state says the rest.
    // Returns whether a wired pad did anything (the edges of a PWM wave are not counted: they
    // are made here, not found).
    let memory = null, padState = null;
    function collect() {
      let busy = false;
      const n = w.esp32sim_cosim_events_take(emu);
      const events = n ? w.esp32sim_cosim_events_ptr() : 0, states = w.esp32sim_cosim_pads(emu);
      if (memory !== w.memory.buffer) { memory = w.memory.buffer; padState = new Uint8Array(memory, states, 64); }
      const t = now();
      if (t >= pwmLookAt) { pwmLookAt = t + PWM_LOOK_S; lookPwm(t); }
      if (n) {
        const f = new Float64Array(memory, events, 3 * n);      // cycle, GPIO, level
        // the last change of each pad in this piece: a fall there may be the pad being let go
        for (let i = 0; i < n; i++) { const pad = padOf.get(f[3 * i + 1]); if (pad !== undefined) lastOf[pad] = i; }
        for (let i = 0; i < n; i++) {
          const pad = padOf.get(f[3 * i + 1]);
          if (pad === undefined || pwm[pad]) continue;
          if (silent[pad]) { stat.unwired++; continue; }
          const at = f[3 * i] / HZ;
          stat.out++; busy = true;
          if (f[3 * i + 2]) {                           // drives high: a level change, or the pad starts to drive
            put(at, pad, ONE); told.lv[pad] = 1;
            if (!told.oe[pad]) { put(at, N + pad, 1); told.oe[pad] = 1; }
          } else if (lastOf[pad] === i && !((padState[pads[pad]] >> 1) & 1)) {
            put(at, N + pad, 0); told.oe[pad] = 0;      // let go while high
          } else { put(at, pad, ZERO); told.lv[pad] = 0; }
        }
      }
      for (let i = 0; i < N; i++) {
        if (silent[i]) continue;
        const s = padState[pads[i]];
        const lv = s & 1, oe = (s >> 1) & 1, pu = (s >> 2) & 1, pd = (s >> 3) & 1;
        if (pwm[i]) {
          if (oe !== told.oe[i]) { told.oe[i] = oe; put(t, N + i, oe); busy = true; }
          wave(i, t);
        } else if (oe !== told.oe[i]) {
          // starts to drive: the level first, then "drives"
          if (oe) { put(t, i, lv ? ONE : ZERO); told.lv[i] = lv; }
          put(t, N + i, oe); told.oe[i] = oe; busy = true;
        } else if (oe && lv !== told.lv[i]) { put(t, i, lv ? ONE : ZERO); told.lv[i] = lv; busy = true; }
        if (pu !== told.pu[i]) { told.pu[i] = pu; put(t, 2 * N + i, pu); busy = true; }
        if (pd !== told.pd[i]) { told.pd[i] = pd; put(t, 3 * N + i, pd); busy = true; }
      }
      return busy;
    }

    // The voltage on every pad with a converter, as the circuit has it now.
    function measure(t) {
      for (let k = 0; k < tapPads.length; k++) {
        const pad = padOf.get(tapPads[k]);
        if (pad === undefined || silent[pad]) continue;
        const v = env.volt(k, t);
        if (!Number.isFinite(v) || Math.abs(v - tapVolt[k]) < 2e-4) continue;
        tapVolt[k] = v;
        w.esp32sim_cosim_analog(emu, tapPads[k], Math.max(0, v));
      }
    }

    // Every pad as it is after a reset: not driven, no pulls.
    function resetPads(t) {
      for (let i = 0; i < N; i++) {
        put(t, i, ONE);
        put(t, N + i, ZERO); put(t, 2 * N + i, ZERO); put(t, 3 * N + i, ZERO);
        told.oe[i] = told.pu[i] = told.pd[i] = 0;
        told.lv[i] = -1; pwm[i] = null;
      }
    }

    // The chip gets its power, or comes out of reset, at ngspice time t: its clock starts at 0 there.
    function start(t) {
      try { create(); } catch (e) {
        destroy(); dead = true;
        trouble("the emulator did not start: " + (e && e.message ? e.message : e));
        return false;
      }
      base = t; floor = 0; gate = 0; queue.length = 0;
      stat.nextReport = 0; startedAt = 0; pwmLookAt = 0; chunk = CHUNK_S;
      lead.usb = ""; lead.uart0 = ""; leadAt = 0; usbTalks = false;
      resetPads(0);
      // one line that explains a chip that does not come up: what its pins were held at
      const at = (v) => pads.filter((_, i) => inLevel[i] === v).join(" ") || "none";
      log("power-up: pins held low by the circuit: " + at(0) + "; held high: " + at(1) + "; the rest float");
      collect();
      return true;
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
      log("@stat " + JSON.stringify({ t: Number(t.toFixed(6)), real: Number(stat.real.toFixed(1)), runs: stat.runs, out: stat.out,
        inputs: stat.inputs, readBack: stat.readBack, late: stat.late, maxLateUs: Number(stat.maxLateUs.toFixed(3)),
        restarts: stat.restarts, unwired: stat.unwired, memoryMB: Math.round(w.memory.buffer.byteLength / 1048576),
        // which pads the firmware drives, where it switched on a pull resistor, where it sends PWM (GPIO numbers)
        drives: pads.filter((_, i) => told.oe[i]), pullUp: pads.filter((_, i) => told.pu[i]), pullDown: pads.filter((_, i) => told.pd[i]),
        pwm: pads.filter((_, i) => pwm[i]) }));
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
          held = enable !== 1;
          if (held) { base = target; trouble("the enable pin is not high: the chip is held in reset and its firmware does not run"); }
          else if (!start(target)) return target;
        }
        const goal = target - base;
        const first = flush(goal);
        if (first >= 0) return base + first;
        if (held || !emu) { floor = goal; return target; }

        const started = performance.now();
        let pieces = 0;
        if (measures) measure(target);
        for (;;) {
          const t = now();
          if (t >= goal) break;
          const code = w.esp32sim_run(emu, Math.max(1, Math.round(Math.min(goal - t, chunk) * HZ)), wall + (base + t) * 1000);
          stat.runs++;
          if (code !== 0) {
            drain();
            trouble("the chip stopped: " + (STOPS[code] || "the emulator gave up (" + code + ")") + (lastWords() ? ". The emulator says: " + lastWords() : ""));
            dead = true;
            break;
          }
          chunk = collect() ? CHUNK_S : Math.min(QUIET_CHUNK_S, chunk * 2);
          if ((++pieces & 15) === 0) drain();
          if (due() <= goal) break;
        }
        if (!dead) drain();
        stat.real += performance.now() - started;
        report(goal);
        const at = flush(goal);
        if (at >= 0) return base + at;
        floor = goal;
        return target;
      },

      // ngspice: "this pad is at this level now".
      pj_input(time, bit, state) {
        if (bit < N && silent[bit]) return;             // a pad with nothing connected reads as nothing outside holds it
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
            destroy();
            resetPads(Math.max(time - base, floor));
            log("enable went low: the chip is in reset");
          } else {
            held = false;
            if (start(time)) log("enable went high: the chip starts");
          }
          return;
        }
        if (bit > N) return;
        inLevel[bit] = state;
        if (!emu) return;
        // A pad the chip drives is read back like any other (firmware may read its own
        // output); only changes on the other pads are news from the circuit, and only those
        // are counted.
        if (!told.oe[bit]) {
          const behind = (now() - (time - base)) * 1e6;          // the chip is already past this moment by so much
          stat.inputs++;
          if (behind > 0.5) { stat.late++; if (behind > stat.maxLateUs) stat.maxLateUs = behind; }
        } else stat.readBack++;
        w.esp32sim_cosim_pin_set(emu, pads[bit], state);
        w.esp32sim_cosim_events_take(emu);              // the emulator lists this change too: it is not the chip's
        chunk = CHUNK_S;                                // the chip may answer: look closely again
      },

      // The user typed this to the chip: bytes for its console's input.
      pj_serial(bytes) {
        if (dead || !emu || !bytes || !bytes.length) return;       // a chip in reset hears nothing, as on a board
        forget(now());
        withBytes(bytes, (p, n) => {
          w.esp32sim_cosim_uart_input(emu, 0, p, n);
          if (usbTalks) w.esp32sim_cosim_usb_input(emu, p, n);
        });
      },

      pj_unload() { destroy(); w = null; memory = padState = null; },
    };
  }

  (globalThis.__pjAdapters = globalThis.__pjAdapters || {}).esp32sim = esp32simAdapter;
})();
