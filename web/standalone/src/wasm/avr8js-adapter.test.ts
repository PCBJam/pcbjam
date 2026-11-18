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
const here = AVR8JS && FIRMWARE && existsSync(AVR8JS) && existsSync(FIRMWARE);
const analogHere = here && ANALOG && existsSync(ANALOG);

interface Part {
  pj_setup(): number;
  pj_step(target: number): number;
  pj_input(time: number, bit: number, state: number, strength: number): void;
  pj_unload(): void;
}
type Adapter = (env: {
  blobs: Record<string, Uint8Array>; config: Record<string, unknown>;
  out: (time: number, bit: number, state: number, strength: number) => void; log: (text: string) => void;
  volt?: (input: number, time: number) => number; sampleAt?: (time: number) => boolean;
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
    expect(said({ "firmware.bin": new Uint8Array(0x8001) })).toEqual(["the sketch does not fit this chip (32 kB of program memory): it was built for another board"]);
    expect(said({})).toEqual(["the chip has no program"]);
    expect(said({ "firmware.bin": new Uint8Array(4) }, "atmega2560")).toEqual(['this page does not know the chip "atmega2560"']);
  });
});
