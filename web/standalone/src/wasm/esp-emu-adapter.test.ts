// The adapter that runs a chip's firmware in Espressif's emulator (esp-emu-adapter.js),
// with the real emulator and a real firmware image.
//
// Neither is in this repository (the emulator is somebody else's program, kept by the
// simulation library), so the test runs only where both are on the machine:
//
//   PCBJAM_ESP_EMU=<folder with esp_emu.js and esp_emu_bg.wasm> \
//   PCBJAM_ESP_FIRMWARE=<merged flash image for an ESP32-C3> npx vitest run src/wasm/esp-emu-adapter.test.ts
//
// The firmware it expects is a plain Arduino sketch: it prints "ready" once, toggles
// GPIO10 every 250 ms, and holds GPIO8 high while GPIO9 (a button to ground with the
// chip's pull-up) is low. Here the test plays ngspice: it says what the pads read and
// asks the chip to advance.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { loaderScript } from "./chip-parts";

const EMU = process.env.PCBJAM_ESP_EMU ?? "";
const FIRMWARE = process.env.PCBJAM_ESP_FIRMWARE ?? "";
const here = EMU && FIRMWARE && existsSync(join(EMU, "esp_emu.js")) && existsSync(join(EMU, "esp_emu_bg.wasm")) && existsSync(FIRMWARE);

interface Part {
  pj_setup(): number;
  pj_step(target: number): number;
  pj_input(time: number, bit: number, state: number, strength: number): void;
  pj_unload(): void;
}
type Adapter = (env: {
  blobs: Record<string, Uint8Array>; config: Record<string, unknown>;
  out: (time: number, bit: number, state: number, strength: number) => void; log: (text: string) => void;
}) => Part;

const PADS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21];
const N = PADS.length;
const [LED, BUTTON, BEAT] = [PADS.indexOf(8), PADS.indexOf(9), PADS.indexOf(10)];
const KEY = "esp-emu@test";

describe.skipIf(!here)("the ESP32 adapter with the real emulator", () => {
  it("boots the firmware, hands on its pin changes at their times, and answers a pin from the circuit", () => {
    // the page's part: the loader as a script, the adapter as the worker has it
    vm.runInThisContext(loaderScript(readFileSync(join(EMU, "esp_emu.js"), "utf8"), KEY));
    vm.runInThisContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "esp-emu-adapter.js"), "utf8"));
    const make = (globalThis as unknown as { __pjAdapters: Record<string, Adapter> }).__pjAdapters["esp-emu"]!;

    const events: { t: number; bit: number; state: number }[] = [];
    const lines: string[] = [];
    const part = make({
      blobs: { "emulator.wasm": readFileSync(join(EMU, "esp_emu_bg.wasm")), "firmware.bin": readFileSync(FIRMWARE) },
      config: {
        chip: "esp32c3", cores: 1, pads: PADS, enable: true, wired: [8, 9, 10], emulatorKey: KEY,
        iomux: { base: 0x60009004, count: 22, pullUpBit: 8, pullDownBit: 7 },
      },
      out: (t, bit, state) => events.push({ t, bit, state }),
      log: (text) => lines.push(text),
    });

    // 15 pads and enable in; level, drives, pull-up and pull-down of every pad out
    expect(part.pj_setup()).toBe((N + 1) | ((4 * N) << 8));

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

    // the circuit: enable is high, the button's pin is high (released)
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
    // the heartbeat: a change every 250 ms of the chip's own time
    const beats = events.filter((e) => e.bit === BEAT && e.t > 0.05).map((e) => e.t);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < beats.length; i++) expect(beats[i]! - beats[i - 1]!).toBeCloseTo(0.25, 2);
    // a pad with nothing on it is never reported
    expect(events.some((e) => e.bit % N === PADS.indexOf(4))).toBe(false);

    // the button goes low: the LED is on within the firmware's next tick (1 ms), and stays on while held
    const pressed = now;
    part.pj_input(pressed, BUTTON, 0, 0);
    run(pressed + 0.05);
    const on = events.find((e) => e.bit === LED && e.state === 1 && e.t >= pressed);
    expect(on).toBeDefined();
    expect(on!.t - pressed).toBeLessThan(0.002);
    expect(last(LED)).toBe(1);

    // enable low holds the chip in reset: every pad is let go
    part.pj_input(now, N, 0, 0);
    run(now + 0.01);
    expect(last(N + LED)).toBe(0);
    expect(last(N + BEAT)).toBe(0);
    expect(lines).toContain("enable went low: the chip is in reset");
    // enable high: it starts again from the beginning
    const ready = lines.filter((l) => /^> .*ready/.test(l)).length;
    part.pj_input(now, BUTTON, 1, 0);
    part.pj_input(now, N, 1, 0);
    run(now + 0.4);
    expect(lines.filter((l) => /^> .*ready/.test(l)).length).toBe(ready + 1);
    expect(last(N + BEAT)).toBe(1);

    part.pj_unload();
  }, 120_000);
});
