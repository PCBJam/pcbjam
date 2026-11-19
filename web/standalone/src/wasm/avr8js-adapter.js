/*
 * avr8js, the AVR chip emulator, as the program of a chip part in a live simulation.
 *
 * An Arduino board of the simulation library (an Uno, a Nano) is a "packaged part"
 * (wasm/ngspice-service/ngspice_live.cpp, pj_part_load), like every chip that runs the
 * user's firmware: its files come in one package, and the engine hands them to the adapter
 * the package names. This file is that adapter for avr8js. It runs the sketch on the
 * emulated chip and answers the three calls ngspice's d_cosim makes of every code part.
 * It is the seat Espressif's emulator has in esp-emu-adapter.js.
 *
 * It runs in the simulation thread. live-engine.ts puts this file's text in front of the
 * live Worker's script, so the adapter is there before the engine asks for it. It has no
 * import and no export: it is a script for a Worker and, in a test, a module loaded for
 * what it does.
 *
 * The ports, for a chip with N modelled pads (config.pads lists their numbers):
 *   inputs   0 .. N-1    the level ON each pad, as ngspice computed it
 *            N           the reset pin, 1 = the chip runs (when config.enable is set)
 *   outputs  0 .. N-1    the level the chip drives on each pad
 *            N .. 2N-1   output enable: 1 = the chip drives the pad
 *            2N .. 3N-1  pull-up on
 * A pad's number is 8 * port + bit, port B = 1, C = 2, D = 3: PB5 (Arduino D13) is 13,
 * PC0 (A0) is 16, PD2 (D2) is 26. What the pads do electrically (driver resistance,
 * pull-up resistor, thresholds) is in the part's SPICE model, not here.
 *
 * Time. avr8js counts the chip's clock cycles, and nothing in it runs by itself: this file
 * executes one instruction after the other until the count reaches the time ngspice asked
 * for. A pin change is stamped with the count at that instruction (62.5 ns at 16 MHz) and
 * handed to ngspice at its own time; a pin change from ngspice is given to the chip when
 * ngspice reports it, at most one instruction after its time. The chip's clock never
 * jumps: a sleeping chip is stepped through its sleep like a working one.
 *
 * The program. The page reads the sketch's file (Intel HEX text) and hands this thread
 * the program's bytes as they sit in the chip's program memory ("firmware.bin").
 *
 * Analog inputs. When the sketch starts a conversion (analogRead) the chip takes its sample
 * one and a half converter clock ticks later (12 us with the Arduino core's settings). At
 * that moment this file asks the engine for the voltage on the pad and for the reference
 * (env.volt: the part's model has a "voltage tap" that hands the engine these voltages
 * after every time step), and the conversion ends with that number at the time the real
 * converter needs. Before, it tells the engine when it will measure (env.sampleAt), so the
 * circuit is solved at exactly that moment. config.taps names the tap's inputs in their
 * order: "A0" to "A7" are the converter's channels 0 to 7, "AVCC" is the supply the
 * converter is referenced to by default, "AREF" the reference pin. The converter is ideal:
 * no noise. A part without taps, or an engine without env.volt, cannot measure: a pin then
 * reads 0 and the console says so once.
 *
 * Serial. Every byte the sketch sends arrives here when it is written, and goes to the
 * engine as the chip sent it (env.serial; a line need not be whole), once per step. An
 * engine without env.serial gets whole lines in the part's log, marked "> ". What the
 * user types comes in as bytes (pj_serial) and reaches the sketch at the baud rate the
 * sketch set, one byte after the other; while the sketch has its receiver off (before
 * Serial.begin) the bytes wait. The TX and RX pins themselves do not move: avr8js hands
 * over bytes, not bits (the same for SPI and I2C).
 *
 * avr8js itself is not part of this app. The page takes it from the simulation library,
 * checks it against the library's checksum and hands this thread an address to load it
 * from (config.glueUrl); what that script leaves behind is found in globalThis.__pjGlue
 * under config.emulatorKey.
 */
(function () {
  "use strict";

  function avr8jsAdapter(env) {
    const blobs = env.blobs, config = env.config, out = env.out, log = env.log;
    const ZERO = 0, ONE = 1, STRONG = 0;
    const pads = config.pads, N = pads.length;
    const HZ = config.clock || 16e6;
    // where each voltage sits in the part's voltage tap; -1 = the board has no such input
    const taps = Array.isArray(config.taps) ? config.taps : [];
    const measures = taps.length > 0 && typeof env.volt === "function";
    const GROUP = 5e-8;                                 // pin changes this close go to ngspice together
    // ... and two groups are never closer than this. d_cosim holds one pending change per
    // part: a second one that arrives before the first is placed (its "delay", 1 us in the
    // part's model) takes the first one's place. The later change waits.
    const SPACING = (config.delayUs || 1) * 1.25e-6;
    // Pads with nothing connected in the schematic (config.wired lists the others; without
    // the list every pad counts as wired). ngspice is told nothing about them and nothing it
    // says about them is used: a sketch may toggle such a pin thousands of times a second,
    // and every change handed to ngspice costs analog work although nobody can see it.
    const silent = pads.map((p) => Array.isArray(config.wired) && !config.wired.includes(p));

    // ---- avr8js: one script, loaded once per simulation thread and then shared by every
    // chip of a circuit and by the next run.
    const loaders = (globalThis.__pjGlue = globalThis.__pjGlue || {});
    const key = String(config.emulatorKey || "avr8js");
    if (!loaders[key] && config.glueUrl && typeof importScripts === "function") importScripts(config.glueUrl);
    const lib = loaders[key];
    if (!lib || typeof lib.CPU !== "function" || typeof lib.avrInstruction !== "function")
      throw new Error("the emulator's script is not there");
    const step = lib.avrInstruction;
    // What each chip is made of. avr8js describes these parts of the chip itself.
    const CHIPS = {
      atmega328p: {
        flash: 0x8000, ram: 2048, eeprom: 1024,
        ports: { 1: lib.portBConfig, 2: lib.portCConfig, 3: lib.portDConfig },
        timers: [lib.timer0Config, lib.timer1Config, lib.timer2Config],
      },
    };
    const chip = CHIPS[config.chip];

    // The program memory: the sketch from address 0, 0xff where it has nothing (an erased chip).
    let image = null, dead = false;
    const program = blobs["firmware.bin"];
    if (!chip) { dead = true; log('this page does not know the chip "' + config.chip + '"'); }
    else if (!program || !program.length) { dead = true; log("the chip has no program"); }
    else if (program.length > chip.flash) {
      dead = true;
      log("the sketch does not fit this chip (" + (chip.flash / 1024) + " kB of program memory): it was built for another board");
    } else {
      image = new Uint8Array(chip.flash).fill(0xff);
      image.set(program);
    }
    // the EEPROM keeps what the sketch wrote over a reset, not over a new run
    const eeprom = chip ? new lib.EEPROMMemoryBackend(chip.eeprom) : null;

    let cpu = null, ports = null;
    let base = 0;                    // ngspice time at which the chip's clock read 0
    let powered = false, held = false;
    let enable = config.enable ? -1 : 1;                // -1: ngspice has not said yet
    // What each pad reads, last word from ngspice: 0, 1, or -1 = ngspice cannot say (nothing
    // drives the pin, or it sits between the thresholds).
    const inLevel = new Array(N).fill(-1);
    const told = { level: new Array(N).fill(-1), oe: new Array(N).fill(0), pu: new Array(N).fill(0) };
    const queue = [];                // pin changes ngspice has not been given yet: { t, bit, state }
    let floor = 0;                   // chip time ngspice has been told about; nothing may be stamped before it
    let gate = 0;                    // the next group may not go out before this (SPACING after the last one)
    let changed = false;             // a pin change was queued: the instruction loop looks at this
    let consoleLine = "";
    // The serial line. Out: with an engine that takes the text as it comes, the bytes of a
    // step, handed over at the step's end. In: what the user typed and the sketch has not
    // received yet.
    const sends = typeof env.serial === "function";
    const utf8 = sends ? new TextDecoder() : null;
    const TYPED_MAX = 4096;
    let usart = null, sent = [], saidTyped = false;
    const typed = [];
    let saidAnalog = false;
    const saidChannel = {};          // the converter's channels the board has no pin for, each said once
    const stat = { real: 0, out: 0, inputs: 0, late: 0, maxLateUs: 0, unwired: 0, restarts: 0, readBack: 0, adc: 0, wished: 0, nextReport: 0 };

    const now = () => cpu.cycles / HZ;
    const put = (t, bit, state) => {
      if (silent[bit % N]) { stat.unwired++; return; }
      const at = Math.max(t, floor);
      let i = queue.length;
      while (i > 0 && queue[i - 1].t > at) i--;
      queue.splice(i, 0, { t: at, bit, state });
      changed = true;
    };

    // The sketch's serial output. For an engine without env.serial: whole lines go to the
    // part's log.
    function consoleByte(b) {
      if (sends) { sent.push(b); return; }
      if (b !== 10) {
        if (b !== 13) consoleLine += String.fromCharCode(b);
        if (consoleLine.length > 2000) consoleLine = consoleLine.slice(-300);
        return;
      }
      const line = consoleLine;
      consoleLine = "";
      if (line.trim()) log("> " + (line.length > 300 ? line.slice(0, 300) + " ..." : line));
    }
    function sendSerial() {
      if (!sent.length) return;
      // a character of several bytes can be cut by the end of a step: the decoder keeps its start
      const text = utf8.decode(Uint8Array.from(sent), { stream: true });
      sent = [];
      if (text) env.serial(text);
    }

    // The next typed byte, when the chip can take one. avr8js takes one byte at a time,
    // needs a byte's time at the sketch's baud rate for it, and refuses while the sketch
    // has its receiver off.
    function feed() {
      if (cpu && usart && typed.length && usart.writeByte(typed[0])) typed.shift();
    }

    // A port tells when anything about its pins changes: a level, a direction, a pull-up,
    // also when a timer moves a PWM pin. Each pad of that port is then compared with what
    // ngspice knows.
    function watch(no, port) {
      const mine = [];
      for (let i = 0; i < N; i++) if ((pads[i] >> 3) === no) mine.push(i);
      if (!mine.length) return;
      port.addListener(() => {
        const t = now();
        for (const i of mine) {
          const bit = pads[i] & 7;
          const s = port.pinState(bit);                 // 0 drives low, 1 drives high, 2 input, 3 input with pull-up
          const oe = s < 2 ? 1 : 0, pu = s === 3 ? 1 : 0;
          if (oe && s !== told.level[i]) { told.level[i] = s; put(t, i, s ? ONE : ZERO); stat.out++; }   // the level first, then "drives"
          if (oe !== told.oe[i]) { told.oe[i] = oe; put(t, N + i, oe); }
          if (pu !== told.pu[i]) {
            told.pu[i] = pu; put(t, 2 * N + i, pu);
            // nothing connected: the pad reads what the chip's own pull-up leaves on it
            if (silent[i]) port.setPin(bit, pu === 1);
          }
        }
      });
    }

    // Every pad as it is after a reset: not driven, no pull-up.
    function resetPads(t) {
      for (let i = 0; i < N; i++) {
        put(t, i, ONE); put(t, N + i, ZERO); put(t, 2 * N + i, ZERO);
        told.level[i] = -1; told.oe[i] = told.pu[i] = 0;
      }
    }

    // A fresh chip: its clock at 0, its program at the reset vector.
    function boot() {
      cpu = new lib.CPU(new Uint16Array(image.buffer), chip.ram);
      ports = {};
      for (const no of Object.keys(chip.ports)) { ports[no] = new lib.AVRIOPort(cpu, chip.ports[no]); watch(Number(no), ports[no]); }
      for (const t of chip.timers) new lib.AVRTimer(cpu, t);
      usart = new lib.AVRUSART(cpu, lib.usart0Config, HZ);
      usart.onByteTransmit = consoleByte;
      usart.onRxComplete = feed;
      typed.length = 0;              // what was typed to the chip before its reset is gone, as on a board
      new lib.AVRSPI(cpu, lib.spiConfig, HZ);
      new lib.AVRTWI(cpu, lib.twiConfig, HZ);
      new lib.AVREEPROM(cpu, eeprom);
      // The converter. See "Analog inputs" at the top.
      const adc = new lib.AVRADC(cpu, lib.adcConfig);
      const convert = adc.onADCRead.bind(adc);
      const board = cpu;             // a conversion that is under way when the chip is reset belongs to the old chip
      adc.onADCRead = (input) => {
        stat.adc++;
        const T = lib.ADCMuxInputType, R = lib.ADCReference;
        if (!measures) {
          // avr8js's own converter: every pin reads 0 V, and a conversion takes the real time
          if (!saidAnalog && input.type === T.SingleEnded) {
            saidAnalog = true;
            log("the sketch reads an analog input, and this board cannot measure a voltage here: analogRead gives 0");
          }
          convert(input);
          return;
        }
        const whole = adc.sampleCycles;
        const hold = Math.round((adc.conversionCycles === 25 ? 13.5 : 1.5) * adc.prescaler);
        if (env.sampleAt && env.sampleAt(base + now() + hold / HZ)) stat.wished++;
        cpu.addClockEvent(() => {
          if (cpu !== board) return;
          const t = base + now();
          const volt = (name) => {
            const k = taps.indexOf(name);
            const v = k >= 0 ? env.volt(k, t) : NaN;
            return Number.isFinite(v) ? v : 0;
          };
          let v = 0;
          if (input.type === T.SingleEnded) {
            const name = "A" + input.channel;
            if (taps.indexOf(name) < 0 && !saidChannel[name]) {
              saidChannel[name] = true;
              log("the sketch reads the analog input " + name + ", which this board does not have: it reads 0");
            }
            v = volt(name);
          } else if (input.type === T.Constant) v = input.voltage;
          else if (input.type === T.Temperature) v = 0.378125;   // 25 degrees, avr8js's own number
          const kind = adc.referenceVoltageType;
          const ref = kind === R.Internal1V1 ? 1.1 : kind === R.Internal2V56 ? 2.56 : volt(kind === R.AREF ? "AREF" : "AVCC");
          const result = ref > 0.01 ? Math.min(1023, Math.max(0, Math.floor(v / ref * 1024))) : 1023;
          cpu.addClockEvent(() => { if (cpu === board) adc.completeADCRead(result); }, Math.max(1, whole - hold));
        }, hold);
      };
      consoleLine = "";
      for (let i = 0; i < N; i++) if (!silent[i] && inLevel[i] >= 0) ports[pads[i] >> 3].setPin(pads[i] & 7, inLevel[i] === ONE);
      // one line that explains a chip that does not do what is expected: what its pins were held at
      const at = (v) => pads.filter((_, i) => inLevel[i] === v).join(" ") || "none";
      log("power-up: pads held low by the circuit: " + at(0) + "; held high: " + at(1) + "; the rest float");
    }

    // Start the chip's clock again at ngspice time t.
    function rebase(t) {
      base = t; floor = 0; gate = 0; queue.length = 0;
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
      log("@stat " + JSON.stringify({ t: Number(t.toFixed(6)), real: Number(stat.real.toFixed(1)), out: stat.out, inputs: stat.inputs,
        readBack: stat.readBack, late: stat.late, maxLateUs: Number(stat.maxLateUs.toFixed(3)), restarts: stat.restarts, unwired: stat.unwired,
        adc: stat.adc, wished: stat.wished, waiting: queue.length,
        // which pads the sketch drives, and where it switched on a pull-up (pad numbers)
        drives: pads.filter((_, i) => told.oe[i]), pullUp: pads.filter((_, i) => told.pu[i]) }));
    }

    function start() {
      try { boot(); return true; }
      catch (e) { dead = true; cpu = null; log("the chip did not start: " + e); return false; }
    }

    return {
      // in | out << 8 | inout << 16 | method << 24 (0 = ngspice's "Normal": step, then input)
      pj_setup() { return (N + (config.enable ? 1 : 0)) | ((3 * N) << 8); },

      // ngspice: "advance to this time; stop early, and say when, if a pin changes".
      pj_step(target) {
        if (dead) return target;
        if (!powered) {
          // Power up a microsecond into the run, not at time 0 and not at the very first
          // step: ngspice needs its first steps to settle what the pins read (see inLevel).
          if (!(target >= 1e-6)) return target;
          powered = true;
          rebase(target);
          held = enable !== 1;
          if (held) log("the reset pin is not high: the chip is held in reset");
          else if (!start()) return target;
        }
        const goal = target - base;
        const first = flush(goal);
        if (first >= 0) return base + first;
        if (held) { floor = goal; return target; }

        const started = performance.now();
        const end = Math.ceil(goal * HZ), c = cpu;
        changed = false;
        if (typed.length && !usart.rxBusy) feed();      // the sketch may have switched its receiver on since
        while (c.cycles < end) {
          step(c);
          c.tick();
          if (changed) {
            if (due() <= goal) break;
            changed = false;
          }
        }
        if (sends) sendSerial();
        stat.real += performance.now() - started;
        report(goal);
        const at = flush(goal);
        if (at >= 0) return base + at;
        floor = goal;
        return target;
      },

      // ngspice: "this pad is at this level now".
      pj_input(time, bit, state) {
        if (bit < N && silent[bit]) return;             // a pad with nothing connected reads as the chip's own pull-up leaves it
        if (state !== ZERO && state !== ONE) {
          // between the thresholds. A running chip keeps what the pad read last (as its
          // input stage does); before power-up it means "nothing is driving this pin".
          if (!powered && bit < N) inLevel[bit] = -1;
          return;
        }
        if (bit === N) {                                // the reset pin
          const was = enable;
          enable = state;
          if (!powered || dead || was === state) return;
          if (state === ZERO) {
            held = true; cpu = null;
            resetPads(Math.max(time - base, floor));
            log("reset went low: the chip is held in reset");
          } else {
            rebase(time);
            held = false;
            stat.restarts++;
            if (start()) log("reset went high: the chip starts");
          }
          return;
        }
        if (bit > N) return;
        inLevel[bit] = state;
        if (!powered || dead || held) return;
        // A pad the chip drives is read back like any other (a sketch may read its own
        // output); only changes on the other pads are news from the circuit, and only those
        // are counted.
        if (!told.oe[bit]) {
          const behind = (now() - (time - base)) * 1e6;  // the chip is already past this moment by so much
          stat.inputs++;
          if (behind > 0.5) { stat.late++; if (behind > stat.maxLateUs) stat.maxLateUs = behind; }
        } else stat.readBack++;
        ports[pads[bit] >> 3].setPin(pads[bit] & 7, state === ONE);
      },

      // The user typed this to the chip: bytes for its serial input.
      pj_serial(bytes) {
        if (dead || !powered || held || !cpu) return;   // a chip in reset hears nothing, as on a board
        const room = TYPED_MAX - typed.length;
        for (let i = 0; i < bytes.length && i < room; i++) typed.push(bytes[i]);
        if (bytes.length > room && !saidTyped) {
          saidTyped = true;
          log("typed text was dropped: the sketch does not read its serial input");
        }
        if (!usart.rxBusy) feed();
      },

      pj_unload() { cpu = null; ports = null; usart = null; },
    };
  }

  (globalThis.__pjAdapters = globalThis.__pjAdapters || {})["avr8js"] = avr8jsAdapter;
})();
