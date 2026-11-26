// The adapter that runs an Arduino board's sketch in avr8js (avr8js-adapter.js), with the
// real avr8js and a real sketch.
//
// Neither is in this repository (avr8js is somebody else's program, kept by the simulation
// library as one script), so the test runs only where both are on the machine:
//
//   PCBJAM_AVR8JS=<the library's avr8js.js> \
//   PCBJAM_AVR_FIRMWARE=<the sketch below, built for an Uno, as .hex> npx vitest run src/wasm/avr8js-adapter.test.ts
//
// The sketch it expects is a plain Arduino sketch: it prints a line with "ready" once,
// toggles D13 every 250 ms, and holds D8 high while D2 (a button to ground with the chip's
// pull-up, read in an interrupt) is low and 200 ms longer. Here the test plays ngspice: it
// says what the pads read and asks the chip to advance.
//
// The test of analogRead needs a second sketch (PCBJAM_AVR_ANALOG_FIRMWARE): the same one
// that also prints "A0 = <analogRead(A0)>, A1 = <analogRead(A1)>" every 200 ms.
//
// The test of the serial line needs a third (PCBJAM_AVR_TALK_FIRMWARE): it prints
// "talk: ready. Type on, off or blink." and the prompt "> " without a line end, reads a
// line, and answers it: "on" switches D8 high and says "the LED is on", any other line
// comes back as 'you typed "<line>" (<n> characters). ...'.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { libraryScript } from "./chip-parts";
import { readIntelHex } from "./intel-hex";

const AVR8JS = process.env.PCBJAM_AVR8JS ?? "";
const FIRMWARE = process.env.PCBJAM_AVR_FIRMWARE ?? "";
const ANALOG = process.env.PCBJAM_AVR_ANALOG_FIRMWARE ?? "";
const TALK = process.env.PCBJAM_AVR_TALK_FIRMWARE ?? "";
const here = AVR8JS && FIRMWARE && existsSync(AVR8JS) && existsSync(FIRMWARE);
const analogHere = here && ANALOG && existsSync(ANALOG);
const talkHere = here && TALK && existsSync(TALK);

interface Part {
  pj_setup(): number;
  pj_step(target: number): number;
  pj_input(time: number, bit: number, state: number, strength: number): void;
  pj_serial(bytes: Uint8Array): void;
  pj_unload(): void;
}
type Adapter = (env: {
  blobs: Record<string, Uint8Array>; config: Record<string, unknown>;
  out: (time: number, bit: number, state: number, strength: number) => void; log: (text: string) => void;
  volt?: (input: number, time: number) => number; sampleAt?: (time: number) => boolean;
  serial?: (text: string) => void;
}) => Part;

// An Uno's pads in the order of its model: D0 to D13 (port D, then port B), A0 to A5 (port C).
const PADS = [24, 25, 26, 27, 28, 29, 30, 31, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21];
const N = PADS.length;
const [BUTTON, LED, BEAT, SPARE] = [PADS.indexOf(26), PADS.indexOf(8), PADS.indexOf(13), PADS.indexOf(28)];
const KEY = "avr8js@test";

describe.skipIf(!here)("the avr8js adapter with the real avr8js", () => {
  const load = (): Adapter => {
    // the page's part: avr8js as a script, the adapter as the worker has it
    vm.runInThisContext(libraryScript(readFileSync(AVR8JS, "utf8"), KEY, "avr8js"));
    vm.runInThisContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "avr8js-adapter.js"), "utf8"));
    return (globalThis as unknown as { __pjAdapters: Record<string, Adapter> }).__pjAdapters["avr8js"]!;
  };

  it("runs the sketch, hands on its pin changes at their times, and answers a pin from the circuit", () => {
    const events: { t: number; bit: number; state: number }[] = [];
    const lines: string[] = [];
    const part = load()({
      blobs: { "firmware.bin": readIntelHex(readFileSync(FIRMWARE, "utf8")) },
      config: { chip: "atmega328p", clock: 16_000_000, pads: PADS, enable: true, wired: [26, 8, 13], emulatorKey: KEY },
      out: (t, bit, state) => events.push({ t, bit, state }),
      log: (text) => lines.push(text),
    });

    // 20 pads and reset in; level, drives and pull-up of every pad out
    expect(part.pj_setup()).toBe((N + 1) | ((3 * N) << 8));

    /** ngspice's side: advance to `until` in steps of 100 us; a step that ends early is taken again. */
    let now = 0;
    const run = (until: number): void => {
      while (now < until) {
        const target = Math.min(until, now + 1e-4);
        for (;;) {
          const reached = part.pj_step(target);
          expect(reached).toBeLessThanOrEqual(target);
          expect(reached).toBeGreaterThanOrEqual(now);
          now = reached;
          if (reached >= target) break;
        }
      }
    };
    const last = (bit: number): number | undefined => [...events].reverse().find((e) => e.bit === bit)?.state;

    // the circuit: reset is high, the button's pin is high (released)
    part.pj_input(0, N, 1, 0);
    part.pj_input(0, BUTTON, 1, 0);
    run(0.7);
    expect(lines.some((l) => l.startsWith("power-up:"))).toBe(true);
    expect(lines.some((l) => /^> .*ready/.test(l))).toBe(true);
    // nothing is reported before its time, and never out of order
    for (let i = 1; i < events.length; i++) expect(events[i]!.t).toBeGreaterThanOrEqual(events[i - 1]!.t);
    // the chip drives its two LED pins, and switched the button's pull-up on
    expect(last(N + LED)).toBe(1);
    expect(last(N + BEAT)).toBe(1);
    expect(last(2 * N + BUTTON)).toBe(1);
    expect(last(LED)).toBe(0);
    // the heartbeat: a change every 250 ms of the chip's own time, to the microsecond
    const beats = events.filter((e) => e.bit === BEAT && e.t > 0.05).map((e) => e.t);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < beats.length; i++) expect(beats[i]! - beats[i - 1]!).toBeCloseTo(0.25, 3);
    // a pad with nothing on it is never reported
    expect(events.some((e) => e.bit % N === SPARE)).toBe(false);

    // the button goes low: the interrupt switches the LED on within microseconds, and it stays on while held
    const pressed = now;
    part.pj_input(pressed, BUTTON, 0, 0);
    run(pressed + 0.05);
    const on = events.find((e) => e.bit === LED && e.state === 1 && e.t >= pressed);
    expect(on).toBeDefined();
    expect(on!.t - pressed).toBeLessThan(0.0001);
    expect(last(LED)).toBe(1);
    expect(lines.some((l) => /^> .*presses 1/.test(l))).toBe(true);
    // released: the LED goes off 200 ms later
    const released = now;
    part.pj_input(released, BUTTON, 1, 0);
    run(released + 0.3);
    const off = events.find((e) => e.bit === LED && e.state === 0 && e.t >= released);
    expect(off).toBeDefined();
    expect(off!.t - released).toBeGreaterThan(0.199);
    expect(off!.t - released).toBeLessThan(0.21);

    // reset low holds the chip in reset: every pad is let go
    part.pj_input(now, N, 0, 0);
    run(now + 0.01);
    expect(last(N + LED)).toBe(0);
    expect(last(N + BEAT)).toBe(0);
    expect(last(2 * N + BUTTON)).toBe(0);
    expect(lines).toContain("reset went low: the chip is held in reset");
    // reset high: the sketch starts again from the beginning
    const ready = lines.filter((l) => /^> .*ready/.test(l)).length;
    part.pj_input(now, N, 1, 0);
    run(now + 0.4);
    expect(lines).toContain("reset went high: the chip starts");
    expect(lines.filter((l) => /^> .*ready/.test(l)).length).toBe(ready + 1);
    expect(last(N + BEAT)).toBe(1);

    part.pj_unload();
  }, 120_000);

  // The engine's side of a measurement: the voltages of the part's tap, and the wish for a time point.
  const TAPS = ["A0", "A1", "A2", "A3", "A4", "A5", "AVCC", "AREF"];
  const analogRun = (config: Record<string, unknown>, volts: Record<string, number> | null) => {
    const lines: string[] = [];
    const asked: { input: number; t: number }[] = [];
    const wished: number[] = [];
    // the engine knows a voltage by its place in the part's tap
    const names = (config.taps as string[] | undefined) ?? [];
    const part = load()({
      blobs: { "firmware.bin": readIntelHex(readFileSync(ANALOG, "utf8")) },
      config: { chip: "atmega328p", clock: 16_000_000, pads: PADS, enable: true, wired: [26, 8, 13, 16, 17], emulatorKey: KEY, ...config },
      out: () => {},
      log: (text) => lines.push(text),
      ...(volts ? {
        volt: (input: number, t: number) => { asked.push({ input, t }); return volts[names[input] ?? ""] ?? NaN; },
        sampleAt: (t: number) => { wished.push(t); return true; },
      } : {}),
    });
    part.pj_setup();
    part.pj_input(0, N, 1, 0);
    part.pj_input(0, BUTTON, 1, 0);
    for (let now = 0; now < 0.45;) {
      const target = now + 1e-4;
      for (;;) { now = part.pj_step(target); if (now >= target) break; }
    }
    part.pj_unload();
    return { lines, asked, wished };
  };

  it.skipIf(!analogHere)("measures a pin through the part's voltage tap, at the moment a real chip samples", () => {
    const { lines, asked, wished } = analogRun({ taps: TAPS }, { A0: 2.5, A1: 1.0, AVCC: 5, AREF: 5 });
    // 2.5 V and 1.0 V of 5 V, in 1024 steps
    expect(lines).toContain("> P7: A0 = 512, A1 = 204");
    expect(lines.some((l) => /cannot measure|does not have/.test(l))).toBe(false);
    // every conversion asked for its pin and for the reference, at the time it had wished for
    const pins = asked.filter((a) => a.input <= 1);
    expect(pins.length).toBeGreaterThanOrEqual(2);
    expect(asked.filter((a) => a.input === TAPS.indexOf("AVCC")).length).toBe(pins.length);
    expect(wished.length).toBe(pins.length);
    pins.forEach((a, i) => expect(Math.abs(a.t - wished[i]!)).toBeLessThan(1e-6));
  }, 120_000);

  it.skipIf(!analogHere)("reads 0 and says so once where nothing can measure", () => {
    // a part without taps
    const none = analogRun({}, { A0: 2.5 });
    expect(none.lines).toContain("> P7: A0 = 0, A1 = 0");
    expect(none.asked).toEqual([]);
    expect(none.lines.filter((l) => /cannot measure a voltage/.test(l)).length).toBe(1);
    // an engine without the call
    const old = analogRun({ taps: TAPS }, null);
    expect(old.lines).toContain("> P7: A0 = 0, A1 = 0");
    expect(old.lines.filter((l) => /cannot measure a voltage/.test(l)).length).toBe(1);
    // a board whose tap has no such input: that one reads 0, the other is measured
    const short = analogRun({ taps: ["A0", "AVCC"] }, { A0: 2.5, AVCC: 5 });
    expect(short.lines).toContain("> P7: A0 = 512, A1 = 0");
    expect(short.lines.filter((l) => /analog input A1, which this board does not have/.test(l)).length).toBe(1);
  }, 120_000);

  // The sketch that talks, with ngspice played by the test: reset high, steps of 100 us.
  const talk = (firmware: string, serial = true) => {
    const events: { t: number; bit: number; state: number }[] = [];
    const lines: string[] = [];
    const chunks: string[] = [];
    const part = load()({
      blobs: { "firmware.bin": readIntelHex(readFileSync(firmware, "utf8")) },
      config: { chip: "atmega328p", clock: 16_000_000, pads: PADS, enable: true, wired: [8, 13], emulatorKey: KEY },
      out: (t, bit, state) => events.push({ t, bit, state }),
      log: (text) => lines.push(text),
      ...(serial ? { serial: (text: string) => chunks.push(text) } : {}),
    });
    let now = 0;
    const run = (until: number): void => {
      while (now < until) {
        const target = Math.min(until, now + 1e-4);
        for (;;) {
          now = part.pj_step(target);
          if (now >= target) break;
        }
      }
    };
    const type = (text: string): void => part.pj_serial(new TextEncoder().encode(text));
    part.pj_input(0, N, 1, 0);
    return { part, events, lines, chunks, run, type, at: () => now, sent: () => chunks.join("") };
  };

  it.skipIf(!talkHere)("hands on what the sketch sends as it sends it, and gives the sketch what is typed", () => {
    const { part, events, lines, run, type, at, sent } = talk(TALK);
    run(0.1);
    // the prompt has no line end: it is there all the same
    expect(sent()).toBe("talk: ready. Type on, off or blink.\r\n> ");
    // and the text is not in the part's own words as well
    expect(lines.some((l) => l.startsWith("> "))).toBe(false);

    const typedAt = at();
    type("on\n");
    run(typedAt + 0.02);
    expect(sent()).toBe("talk: ready. Type on, off or blink.\r\n> the LED is on\r\n> ");
    // three characters at 115200 baud are 260 us; the sketch's loop takes them at once
    const on = events.find((e) => e.bit === LED && e.state === 1 && e.t >= typedAt);
    expect(on).toBeDefined();
    expect(on!.t - typedAt).toBeGreaterThan(0.0002);
    expect(on!.t - typedAt).toBeLessThan(0.002);

    // a line longer than the chip's one-byte receiver arrives whole, one character time after the other
    const long = "the quick brown fox jumps over the lazy dog";
    type(`${long}\n`);
    run(at() + 0.05);
    expect(sent().endsWith(`you typed "${long}" (${long.length} characters). I know: on, off, blink, count\r\n> `)).toBe(true);

    // two lines typed in one go are two lines for the sketch
    type("off\non\n");
    run(at() + 0.05);
    expect(sent().endsWith("the LED is off\r\n> the LED is on\r\n> ")).toBe(true);
    part.pj_unload();
  }, 120_000);

  it.skipIf(!talkHere)("keeps what is typed before the sketch listens, and a chip in reset hears nothing", () => {
    const { part, run, type, at, sent, lines } = talk(TALK);
    // the chip is up, its sketch has not opened the serial line yet
    run(3e-6);
    type("on\n");
    run(0.1);
    expect(sent()).toBe("talk: ready. Type on, off or blink.\r\n> the LED is on\r\n> ");

    // reset low: what is typed now is lost, as on a board; after the reset the sketch starts over
    const held = at();
    part.pj_input(held, N, 0, 0);
    type("blink\n");
    run(held + 0.01);
    part.pj_input(at(), N, 1, 0);
    run(at() + 0.1);
    expect(sent().endsWith("> the LED is on\r\n> talk: ready. Type on, off or blink.\r\n> ")).toBe(true);
    expect(lines.some((l) => /typed text was dropped/.test(l))).toBe(false);
    part.pj_unload();
  }, 120_000);

  it.skipIf(!talkHere)("says once when more is typed than may wait", () => {
    const { part, run, type, lines } = talk(TALK);
    run(0.05);
    type("x".repeat(5000));
    type("y".repeat(5000));
    expect(lines.filter((l) => l === "typed text was dropped: the sketch does not read its serial input")).toHaveLength(1);
    part.pj_unload();
  }, 120_000);

  it.skipIf(!talkHere)("for an engine without the serial line, whole lines go to the part's own words", () => {
    const { part, run, type, at, lines, chunks } = talk(TALK, false);
    run(0.1);
    type("on\n");
    run(at() + 0.02);
    expect(chunks).toEqual([]);
    expect(lines).toContain("> talk: ready. Type on, off or blink.");
    expect(lines).toContain("> > the LED is on");
    part.pj_unload();
  }, 120_000);

  // ---- a chip without a board (the bare ATmega328 parts): its supply and its clock ----

  /** A bare chip with the sketch, and ngspice's side of it. */
  const bare = (config: Record<string, unknown>, program: Uint8Array = readIntelHex(readFileSync(FIRMWARE, "utf8")), engine: Partial<Parameters<Adapter>[0]> = {}) => {
    const events: { t: number; bit: number; state: number }[] = [];
    const lines: string[] = [];
    const part = load()({
      blobs: { "firmware.bin": program },
      config: { chip: "atmega328", clock: 16_000_000, pads: PADS, enable: true, supply: true, wired: [26, 8, 13], emulatorKey: KEY, ...config },
      out: (t, bit, state) => events.push({ t, bit, state }),
      log: (text) => lines.push(text),
      ...engine,
    });
    let now = 0;
    const run = (until: number): void => {
      while (now < until) {
        const target = Math.min(until, now + 1e-4);
        for (;;) { now = part.pj_step(target); if (now >= target) break; }
      }
    };
    return {
      part, events, lines, run,
      at: () => now,
      last: (bit: number): number | undefined => [...events].reverse().find((e) => e.bit === bit)?.state,
      ready: () => lines.filter((l) => /^> .*ready/.test(l)).length,
      beats: (from = 0) => events.filter((e) => e.bit === BEAT && e.t > from).map((e) => e.t),
    };
  };
  const SUPPLY = N + 1;

  it("a chip without a board runs only while its supply is up, and starts from reset when it comes back", () => {
    const { part, lines, run, at, last, ready } = bare({});
    // one more input than a board: the supply, after the pads and the reset pin
    expect(part.pj_setup()).toBe((N + 2) | ((3 * N) << 8));
    // reset is high (held from elsewhere), and nothing says the supply is up
    part.pj_input(0, N, 1, 0);
    part.pj_input(0, BUTTON, 1, 0);
    run(0.3);
    expect(lines).toContain("! the chip has no supply: its VCC pin has less than 1.8 V, so its sketch does not run");
    expect(lines.some((l) => l.includes("reset pin is not high"))).toBe(false);
    expect(ready()).toBe(0);
    expect(last(N + BEAT)).not.toBe(1);

    // the supply comes: the sketch starts from the beginning
    part.pj_input(at(), SUPPLY, 1, 0);
    run(at() + 0.4);
    expect(lines).toContain("the chip has its supply: it starts");
    expect(lines).not.toContain("the supply is back: the chip starts");
    expect(ready()).toBe(1);
    expect(last(N + BEAT)).toBe(1);

    // it goes: every pad is let go, and the chip is silent
    part.pj_input(at(), SUPPLY, 0, 0);
    run(at() + 0.3);
    expect(lines).toContain("the supply went below 1.7 V: the chip stopped");
    expect(last(N + BEAT)).toBe(0);
    expect(last(2 * N + BUTTON)).toBe(0);
    expect(ready()).toBe(1);
    // reset moving while there is no supply starts nothing
    part.pj_input(at(), N, 0, 0);
    part.pj_input(at() + 1e-4, N, 1, 0);
    run(at() + 0.3);
    expect(ready()).toBe(1);

    // and comes back: a second start
    part.pj_input(at(), SUPPLY, 1, 0);
    run(at() + 0.4);
    expect(lines).toContain("the supply is back: the chip starts");
    expect(ready()).toBe(2);
    // with the supply up, reset still holds the chip
    part.pj_input(at(), N, 0, 0);
    run(at() + 0.01);
    expect(lines).toContain("reset went low: the chip is held in reset");
    expect(last(N + BEAT)).toBe(0);
    part.pj_unload();
  }, 120_000);

  it("a chip held in reset with its supply up says the reset, not the supply", () => {
    const { part, lines, run } = bare({});
    part.pj_setup();
    part.pj_input(0, SUPPLY, 1, 0);
    part.pj_input(0, N, 0, 0);
    run(0.05);
    expect(lines).toContain("! the reset pin is not high: the chip is held in reset and its sketch does not run");
    expect(lines.some((l) => l.includes("no supply"))).toBe(false);
    part.pj_unload();
  }, 120_000);

  it("runs at the clock it is told: a sketch built for 16 MHz beats half as fast at 8 MHz, and 16 times slower at 1 MHz", () => {
    const beatsAt = (clock: number, until = 1.3): number[] => {
      const chip = bare({ clock });
      chip.part.pj_setup();
      chip.part.pj_input(0, N, 1, 0);
      chip.part.pj_input(0, SUPPLY, 1, 0);
      chip.part.pj_input(0, BUTTON, 1, 0);
      chip.run(until);
      chip.part.pj_unload();
      return chip.beats(0.05);
    };
    const gaps = (times: number[]): number[] => times.slice(1).map((t, i) => t - times[i]!);
    const fast = gaps(beatsAt(16_000_000)), slow = gaps(beatsAt(8_000_000));
    expect(fast.length).toBeGreaterThanOrEqual(3);
    expect(slow.length).toBeGreaterThanOrEqual(1);
    for (const g of fast) expect(g).toBeCloseTo(0.25, 3);
    for (const g of slow) expect(g).toBeCloseTo(0.5, 3);
    // 1 MHz, the speed of a chip as it leaves the factory (8 MHz divided by 8)
    const slowest = gaps(beatsAt(1_000_000, 9));
    expect(slowest.length).toBeGreaterThanOrEqual(1);
    for (const g of slowest) expect(g).toBeCloseTo(4, 2);
  }, 120_000);

  it("measures against the voltage on its AVCC pin or on its AREF pin, and on the two extra inputs of the larger packages", () => {
    // the sketch answers "a" with analogRead of A0, A6 and A7 against AVCC, and "e" with the same against AREF
    const measured = (taps: string[], volts: Record<string, number>, typed: string): string[] => {
      const { part, lines, run, at } = bare({ taps }, undefined, { volt: (input) => volts[taps[input] ?? ""] ?? NaN, sampleAt: () => true });
      part.pj_setup();
      part.pj_input(0, N, 1, 0);
      part.pj_input(0, SUPPLY, 1, 0);
      part.pj_input(0, BUTTON, 1, 0);
      run(0.05);
      for (const letter of typed) {
        part.pj_serial(new TextEncoder().encode(letter));
        run(at() + 0.05);
      }
      part.pj_unload();
      return lines;
    };
    const ALL = ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "AVCC", "AREF"];
    // a chip on 3.3 V with 2.5 V on AREF: the same three voltages are other numbers against each
    const lines = measured(ALL, { A0: 1.65, A6: 1.1, A7: 2.2, AVCC: 3.3, AREF: 2.5 }, "ae");
    expect(lines).toContain("> uno-demo: analog avcc A0=512 A6=341 A7=682");
    expect(lines).toContain("> uno-demo: analog aref A0=675 A6=450 A7=901");
    expect(lines.some((l) => l.startsWith("! "))).toBe(false);

    // the packages with 28 pins have no A6 and no A7: 0, said once for each
    const small = measured(["A0", "A1", "A2", "A3", "A4", "A5", "AVCC", "AREF"], { A0: 2.5, AVCC: 5, AREF: 5 }, "aa");
    expect(small.filter((l) => l === "> uno-demo: analog avcc A0=512 A6=0 A7=0").length).toBe(2);
    expect(small.filter((l) => /reads the analog input A6, which this (board|part) does not have/.test(l)).length).toBe(1);
    expect(small.filter((l) => /reads the analog input A7/.test(l)).length).toBe(1);

    // AVCC with nothing on it: the chip's converter has no supply, and the sketch is told
    const open = measured(ALL, { A0: 1.65, A6: 0, A7: 0, AVCC: 0, AREF: 0 }, "a");
    expect(open).toContain("> uno-demo: analog avcc A0=1023 A6=1023 A7=1023");
    expect(open.filter((l) => l.includes("measures against AVCC, the supply of its converter, and that pin has no voltage")).length).toBe(1);
  }, 120_000);

  it("follows the chip's own clock divider when a sketch sets it", () => {
    // A program by hand, no Arduino core: CLKPR = 0x80, CLKPR = 1 (the clock divided by 2),
    // PB5 an output, then for ever: toggle PB5 and count 3999 down, 16001 clock cycles a round.
    //   ldi r16,0x80  sts 0x61,r16  ldi r16,1  sts 0x61,r16  sbi DDRB,5
    //   loop: sbi PINB,5  ldi r24,0x9f  ldi r25,0x0f  d: sbiw r24,1  brne d  rjmp loop
    const words = [0xe800, 0x9300, 0x0061, 0xe001, 0x9300, 0x0061, 0x9a25, 0x9a1d, 0xe98f, 0xe09f, 0x9701, 0xf7f1, 0xcffa];
    const program = Uint8Array.from(words.flatMap((w) => [w & 0xff, w >> 8]));
    const { part, events, lines, run } = bare({ wired: [13] }, program);
    part.pj_setup();
    part.pj_input(0, N, 1, 0);
    part.pj_input(0, SUPPLY, 1, 0);
    run(0.05);
    expect(lines).toContain("the sketch set the chip's clock divider to 2: the chip runs at 8 MHz");
    // 16001 cycles at 8 MHz: a toggle every 2.000125 ms (it would be 1.0000625 ms without the divider)
    // (the first millisecond has the pad's levels of the start itself)
    const toggles = events.filter((e) => e.bit === BEAT && e.t > 0.001).map((e) => e.t);
    expect(toggles.length).toBeGreaterThanOrEqual(23);
    expect(toggles.length).toBeLessThanOrEqual(25);
    for (let i = 1; i < toggles.length; i++) expect(toggles[i]! - toggles[i - 1]!).toBeCloseTo(0.002000125, 7);
    part.pj_unload();
  }, 120_000);

  it("stays silent, in words, about a program that is none for this chip", () => {
    const make = load();
    const said = (blobs: Record<string, Uint8Array>, chip = "atmega328p"): string[] => {
      const lines: string[] = [];
      const part = make({ blobs, config: { chip, pads: PADS, enable: true, emulatorKey: KEY }, out: () => { throw new Error("a dead chip moved a pin"); }, log: (text) => lines.push(text) });
      part.pj_input(0, N, 1, 0);
      expect(part.pj_step(0.001)).toBe(0.001);
      part.pj_unload();
      return lines;
    };
    // more program than an ATmega328P holds (32 kB): a sketch for a larger board
    expect(said({ "firmware.bin": new Uint8Array(0x8001) })).toEqual(["! the sketch does not fit this chip (32 kB of program memory): it was built for another board"]);
    expect(said({})).toEqual(["! the chip has no program"]);
    expect(said({ "firmware.bin": new Uint8Array(4) }, "atmega2560")).toEqual(['! this page does not know the chip "atmega2560"']);
  });
});
