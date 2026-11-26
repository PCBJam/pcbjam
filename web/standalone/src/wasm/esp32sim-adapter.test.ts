// The adapter that runs a chip's firmware in the emulator esp32sim (esp32sim-adapter.js),
// with the real emulator and real firmware images.
//
// Neither is in this repository (the emulator is built by the simulation library, the
// images by a sketch's build), so each test runs only where its files are on the machine:
//
//   PCBJAM_ESP32SIM=<folder with esp32sim.wasm, jit.mjs and the chips' ROM files> \
//   PCBJAM_ESP_FIRMWARE=<merged flash image for an ESP32-C3> npx vitest run src/wasm/esp32sim-adapter.test.ts
//
// The firmware it expects is a plain Arduino sketch: it prints "ready" once, toggles
// GPIO10 every 250 ms, and holds GPIO8 high while GPIO9 (a button to ground with the
// chip's pull-up) is low. Here the test plays ngspice: it says what the pads read and
// asks the chip to advance.
//
// More images, each for a test of its own:
//   PCBJAM_ESP_TALK_FIRMWARE    prints "talk: ready. Type on, off or blink." and the prompt
//                               "> " without a line end, reads a line from UART0 and answers
//                               it: "on" switches GPIO8 high and says "the LED is on"
//   PCBJAM_ESP_TIMING_FIRMWARE  the first sketch with a 1 kHz timer wave on GPIO6 and a PWM
//                               wave of 1 kHz, a quarter of the time high, on GPIO5
//   PCBJAM_ESP_ANALOG_FIRMWARE  reads GPIO2 with analogReadMilliVolts every 100 ms, prints
//                               "A: raw <n> mv <n>" and holds GPIO8 high above 1650 mV
//   PCBJAM_ESP_S3_FIRMWARE      for an ESP32-S3: toggles GPIO2 every 100 us in a busy loop,
//                               and GPIO5 follows the button on GPIO0
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { jitHostScript } from "./chip-parts";

const EMU = process.env.PCBJAM_ESP32SIM ?? "";
const file = (name: string | undefined): string => (name && existsSync(name) ? name : "");
const FIRMWARE = file(process.env.PCBJAM_ESP_FIRMWARE);
const TALK = file(process.env.PCBJAM_ESP_TALK_FIRMWARE);
const TIMING = file(process.env.PCBJAM_ESP_TIMING_FIRMWARE);
const ANALOG = file(process.env.PCBJAM_ESP_ANALOG_FIRMWARE);
const S3 = file(process.env.PCBJAM_ESP_S3_FIRMWARE);
const C3_ROM = "esp32c3_rev3_rom.elf", S3_ROM = "esp32s3_rev0_rom.elf";
const emuHere = !!EMU && ["esp32sim.wasm", "jit.mjs", C3_ROM].every((name) => existsSync(join(EMU, name)));

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
  serial?: (text: string) => void; volt?: (input: number, time: number) => number;
}) => Part;

const C3_PADS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21];
const KEY = "esp32sim@test";

interface Bench {
  part: Part;
  N: number;
  events: { t: number; bit: number; state: number }[];
  lines: string[];
  chunks: string[];
  now: () => number;
  /** ngspice's side: advance to `until` in steps of at most `step`; a step that ends early is taken again. */
  run: (until: number, step?: number) => void;
  bit: (gpio: number) => number;
  last: (bit: number) => number | undefined;
  sent: () => string;
}

/** A chip on the bench: the adapter as the worker has it, with this test as ngspice. */
function bench(o: { chip: string; rom: string; pads: number[]; firmware: string; wired: number[]; serial?: boolean; tapPads?: number[]; volt?: (input: number, time: number) => number }): Bench {
  // the page's part: the emulator's script as a script, the adapter as the worker has it
  vm.runInThisContext(jitHostScript(readFileSync(join(EMU, "jit.mjs"), "utf8"), KEY));
  vm.runInThisContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "esp32sim-adapter.js"), "utf8"));
  const make = (globalThis as unknown as { __pjAdapters: Record<string, Adapter> }).__pjAdapters.esp32sim!;
  const events: Bench["events"] = [], lines: string[] = [], chunks: string[] = [];
  const N = o.pads.length;
  const part = make({
    blobs: { "emulator.wasm": readFileSync(join(EMU, "esp32sim.wasm")), "rom.elf": readFileSync(join(EMU, o.rom)), "firmware.bin": readFileSync(o.firmware) },
    config: { chip: o.chip, pads: o.pads, enable: true, wired: o.wired, emulatorKey: KEY, ...(o.tapPads ? { tapPads: o.tapPads } : {}) },
    out: (t, bit, state) => events.push({ t, bit, state }),
    log: (text) => lines.push(text),
    ...(o.serial ? { serial: (text: string) => chunks.push(text) } : {}),
    ...(o.volt ? { volt: o.volt } : {}),
  });
  let now = 0;
  const run = (until: number, step = 1e-4): void => {
    while (now < until) {
      const target = Math.min(until, now + step);
      for (;;) {
        const reached = part.pj_step(target);
        expect(reached).toBeLessThanOrEqual(target);
        expect(reached).toBeGreaterThanOrEqual(now);
        now = reached;
        if (reached >= target) break;
      }
    }
  };
  return {
    part, N, events, lines, chunks, run, now: () => now,
    bit: (gpio) => o.pads.indexOf(gpio),
    last: (bit) => [...events].reverse().find((e) => e.bit === bit)?.state,
    sent: () => chunks.join(""),
  };
}

describe.skipIf(!emuHere || !FIRMWARE)("the esp32sim adapter with the real emulator", () => {
  it("boots the firmware, hands on its pin changes at their times, and answers a pin from the circuit", () => {
    const b = bench({ chip: "esp32c3", rom: C3_ROM, pads: C3_PADS, firmware: FIRMWARE, wired: [8, 9, 10] });
    const { part, N, events, lines } = b;
    const [LED, BUTTON, BEAT] = [b.bit(8), b.bit(9), b.bit(10)];

    // 15 pads and enable in; level, drives, pull-up and pull-down of every pad out
    expect(part.pj_setup()).toBe((N + 1) | ((4 * N) << 8));

    // the circuit: enable is high, the button's pin is high (released)
    part.pj_input(0, N, 1, 0);
    part.pj_input(0, BUTTON, 1, 0);
    b.run(0.7);
    expect(lines.some((l) => l.startsWith("power-up:"))).toBe(true);
    expect(lines.some((l) => /^> .*ready/.test(l))).toBe(true);
    // the ROM's start-up lines come on both of the chip's consoles and are shown once
    expect(lines.filter((l) => /^> ESP-ROM:/.test(l)).length).toBe(1);
    expect(lines.some((l) => l.startsWith("! "))).toBe(false);
    // nothing is reported before its time, and never out of order
    for (let i = 1; i < events.length; i++) expect(events[i]!.t).toBeGreaterThanOrEqual(events[i - 1]!.t);
    // the chip drives its two LED pins, and switched the button's pull-up on
    expect(b.last(N + LED)).toBe(1);
    expect(b.last(N + BEAT)).toBe(1);
    expect(b.last(2 * N + BUTTON)).toBe(1);
    expect(b.last(LED)).toBe(0);
    // the heartbeat: a change every 250 ms of the chip's own time, to the microsecond
    const beats = events.filter((e) => e.bit === BEAT && e.t > 0.05).map((e) => e.t);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < beats.length; i++) expect(Math.abs(beats[i]! - beats[i - 1]! - 0.25)).toBeLessThan(2e-6);
    // a pad with nothing on it is never reported
    expect(events.some((e) => e.bit % N === b.bit(4))).toBe(false);

    // the button goes low: the chip sees it at once (asleep or not), and the LED stays on while held
    const pressed = b.now();
    part.pj_input(pressed, BUTTON, 0, 0);
    b.run(pressed + 0.05);
    const on = events.find((e) => e.bit === LED && e.state === 1 && e.t >= pressed);
    expect(on).toBeDefined();
    expect(on!.t - pressed).toBeLessThan(1e-4);
    expect(b.last(LED)).toBe(1);

    // enable low holds the chip in reset: every pad is let go
    part.pj_input(b.now(), N, 0, 0);
    b.run(b.now() + 0.01);
    expect(b.last(N + LED)).toBe(0);
    expect(b.last(N + BEAT)).toBe(0);
    expect(lines).toContain("enable went low: the chip is in reset");
    // enable high: it starts again from the beginning
    const ready = lines.filter((l) => /^> .*ready/.test(l)).length;
    part.pj_input(b.now(), BUTTON, 1, 0);
    part.pj_input(b.now(), N, 1, 0);
    b.run(b.now() + 0.4);
    expect(lines).toContain("enable went high: the chip starts");
    expect(lines.filter((l) => /^> .*ready/.test(l)).length).toBe(ready + 1);
    expect(b.last(N + BEAT)).toBe(1);

    part.pj_unload();
  }, 120_000);

  it("a chip whose enable pin is not high does not run, and says so", () => {
    const b = bench({ chip: "esp32c3", rom: C3_ROM, pads: C3_PADS, firmware: FIRMWARE, wired: [8, 9, 10] });
    b.part.pj_input(0, b.N, 0, 0);
    b.run(0.05);
    expect(b.lines.some((l) => l.startsWith("! the enable pin is not high"))).toBe(true);
    expect(b.lines.some((l) => l.startsWith("> "))).toBe(false);
    // it comes up when enable goes high
    b.part.pj_input(b.now(), b.N, 1, 0);
    b.run(b.now() + 0.3);
    expect(b.lines.some((l) => /^> .*ready/.test(l))).toBe(true);
    b.part.pj_unload();
  }, 120_000);

  it("two chips run side by side, each in an instance of its own", () => {
    const one = bench({ chip: "esp32c3", rom: C3_ROM, pads: C3_PADS, firmware: FIRMWARE, wired: [10] });
    const two = bench({ chip: "esp32c3", rom: C3_ROM, pads: C3_PADS, firmware: FIRMWARE, wired: [10] });
    one.part.pj_input(0, one.N, 1, 0);
    two.part.pj_input(0, two.N, 1, 0);
    // the second gets its power 100 ms after the first: its heartbeat is that much behind
    one.run(0.1);
    for (let t = 0.1; t < 0.9; t += 0.01) { one.run(t + 0.01); two.run(t - 0.1 + 0.01); }
    const beats = (b: Bench): number[] => b.events.filter((e) => e.bit === b.bit(10) && e.t > 0.05).map((e) => e.t);
    expect(beats(one).length).toBeGreaterThanOrEqual(2);
    expect(beats(two).length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(beats(one)[0]! - beats(two)[0]!)).toBeLessThan(2e-6);
    one.part.pj_unload();
    two.part.pj_unload();
  }, 120_000);

  it.skipIf(!TALK)("hands on what the firmware sends as it sends it, and gives the firmware what is typed", () => {
    const b = bench({ chip: "esp32c3", rom: C3_ROM, pads: C3_PADS, firmware: TALK, wired: [8, 10], serial: true });
    const { part, N, events, lines } = b;
    const LED = b.bit(8);
    const type = (text: string): void => part.pj_serial(new TextEncoder().encode(text));

    part.pj_input(0, N, 1, 0);
    // typed before the chip has power: nothing hears it, and nothing breaks
    type("off\n");
    b.run(0.7);
    // the prompt has no line end: it is there all the same, after whatever the chip's start-up printed
    expect(b.sent().endsWith("talk: ready. Type on, off or blink.\r\n> ")).toBe(true);
    // and the text is not in the part's own words as well
    expect(lines.some((l) => l.startsWith("> "))).toBe(false);

    const typedAt = b.now();
    type("on\n");
    b.run(typedAt + 0.05);
    expect(b.sent().endsWith("> the LED is on\r\n> ")).toBe(true);
    const on = events.find((e) => e.bit === LED && e.state === 1 && e.t >= typedAt);
    expect(on).toBeDefined();
    expect(on!.t - typedAt).toBeLessThan(0.01);

    const long = "the quick brown fox jumps over the lazy dog";
    type(`${long}\n`);
    b.run(b.now() + 0.05);
    expect(b.sent().endsWith(`you typed "${long}" (${long.length} characters). I know: on, off, blink, count\r\n> `)).toBe(true);

    // a chip held in reset hears nothing; after it the firmware starts over
    part.pj_input(b.now(), N, 0, 0);
    type("blink\n");
    b.run(b.now() + 0.01);
    part.pj_input(b.now(), N, 1, 0);
    b.run(b.now() + 0.5);
    expect(b.sent().endsWith("talk: ready. Type on, off or blink.\r\n> ")).toBe(true);
    expect(b.sent()).not.toContain("the LED blinks");

    part.pj_unload();
  }, 120_000);

  it.skipIf(!TIMING)("a timer's wave comes out edge by edge at its times, and the PWM unit's wave is made from what it says", () => {
    const b = bench({ chip: "esp32c3", rom: C3_ROM, pads: C3_PADS, firmware: TIMING, wired: [5, 6] });
    const [PWM, WAVE] = [b.bit(5), b.bit(6)];
    b.part.pj_input(0, b.N, 1, 0);
    b.run(0.4, 2e-5);
    // the timer's 1 kHz wave: an edge every 500 us, to a tenth of a microsecond
    const edges = b.events.filter((e) => e.bit === WAVE && e.t > 0.1).map((e) => e.t);
    expect(edges.length).toBeGreaterThan(400);
    for (let i = 1; i < edges.length; i++) expect(Math.abs(edges[i]! - edges[i - 1]! - 5e-4)).toBeLessThan(1e-7);
    // the PWM wave: 1 kHz, high for a quarter of it
    const pwm = b.events.filter((e) => e.bit === PWM && e.t > 0.1);
    const ups = pwm.filter((e) => e.state === 1).map((e) => e.t), downs = pwm.filter((e) => e.state === 0).map((e) => e.t);
    expect(ups.length).toBeGreaterThan(200);
    for (let i = 1; i < ups.length; i++) expect(Math.abs(ups[i]! - ups[i - 1]! - 1e-3)).toBeLessThan(3e-6);
    const down = downs.find((t) => t > ups[10]!)!;
    expect(Math.abs(down - ups[10]! - 2.5e-4)).toBeLessThan(3e-6);
    expect(b.last(b.N + PWM)).toBe(1);
    b.part.pj_unload();
  }, 120_000);

  it.skipIf(!ANALOG)("a pad with a converter measures the voltage the circuit has on it", () => {
    // the circuit: 0.5 V on GPIO2, then 2.5 V from 0.6 s, then 1.0 V from 1.0 s
    const volts = (t: number): number => (t < 0.6 ? 0.5 : t < 1.0 ? 2.5 : 1.0);
    const b = bench({ chip: "esp32c3", rom: C3_ROM, pads: C3_PADS, firmware: ANALOG, wired: [2, 8], tapPads: [0, 1, 2, 3, 4, 5], volt: (input, t) => (input === 2 ? volts(t) : 0) });
    const LED = b.bit(8);
    b.part.pj_input(0, b.N, 1, 0);
    b.run(1.4, 1e-3);
    const read = b.lines.flatMap((l) => { const m = /^> A: raw \d+ mv (\d+)/.exec(l); return m ? [Number(m[1])] : []; });
    for (const mv of [500, 2500, 1000]) expect(read.some((v) => Math.abs(v - mv) <= 15)).toBe(true);
    expect(read.every((v) => [500, 2500, 1000].some((mv) => Math.abs(v - mv) <= 15))).toBe(true);
    // the LED is on while the pad is above 1650 mV: from the first reading after 0.6 s to the first after 1.0 s
    // (a pad's level is reported once at power-up, before the chip drives it: that is not the LED)
    const on = b.events.find((e) => e.bit === LED && e.state === 1 && e.t > 0.1), off = b.events.find((e) => e.bit === LED && e.state === 0 && e.t > (on?.t ?? 9));
    expect(on!.t).toBeGreaterThan(0.6);
    expect(on!.t).toBeLessThan(0.72);
    expect(off!.t).toBeGreaterThan(1.0);
    expect(off!.t).toBeLessThan(1.12);
    b.part.pj_unload();
  }, 120_000);
});

describe.skipIf(!emuHere || !S3 || !existsSync(join(EMU, S3_ROM)))("the esp32sim adapter with an ESP32-S3", () => {
  it("runs the two-core chip: a busy loop's wave at its times, and a button answered", () => {
    const pads = [0, 2, 4, 5, 42];
    const b = bench({ chip: "esp32s3", rom: S3_ROM, pads, firmware: S3, wired: [0, 2, 5] });
    const [BUTTON, LOOP, LED] = [b.bit(0), b.bit(2), b.bit(5)];
    b.part.pj_input(0, b.N, 1, 0);
    b.part.pj_input(0, BUTTON, 1, 0);
    b.run(0.6, 2e-5);
    expect(b.lines.some((l) => l.startsWith("! "))).toBe(false);
    expect(b.lines.some((l) => /^> .*ready/.test(l))).toBe(true);
    // the loop toggles its pad every 100 us of the chip's own time
    const edges = b.events.filter((e) => e.bit === LOOP && e.t > 0.5).map((e) => e.t);
    expect(edges.length).toBeGreaterThan(500);
    for (let i = 1; i < edges.length; i++) expect(Math.abs(edges[i]! - edges[i - 1]! - 1e-4)).toBeLessThan(2e-6);
    const pressed = b.now();
    b.part.pj_input(pressed, BUTTON, 0, 0);
    b.run(pressed + 0.01, 2e-5);
    const on = b.events.find((e) => e.bit === LED && e.state === 1 && e.t >= pressed);
    expect(on).toBeDefined();
    expect(on!.t - pressed).toBeLessThan(1e-4);
    b.part.pj_unload();
  }, 240_000);
});
