// What is heard of a running circuit: which parts, how loud, and the browser's audio.
import { describe, expect, it } from "vitest";
import type { LoadedPart, PreparedRun } from "@pcbjam/shared/sim-library";
import { createBeeper, liveSoundMuted, toneHz, tonesFor, voiceGain, type Tone } from "./live-sound";

describe("a pitch as a part gives it", () => {
  it("reads a number, and a setting's words for one", () => {
    expect([2300, "2300", "2.7k", "4k", "20", "20000", "20k"].map(toneHz)).toEqual([2300, 2300, 2700, 4000, 20, 20000, 20000]);
  });

  it("is none when a person would not hear it, or when it is no pitch at all", () => {
    for (const none of [19, 20001, 0, -440, NaN, Infinity, "19", "25k", "", "2k3", "440Hz", "k", null, undefined, true, [440]]) expect([none, toneHz(none)]).toEqual([none, null]);
  });
});

describe("how loud a part is played", () => {
  it("is silent until its first ring shows, then as loud as it is in the circuit, and never more than full", () => {
    expect([0, 0.005, 0.0099, -1, NaN].map(voiceGain)).toEqual([0, 0, 0, 0, 0]);
    expect([0.01, 0.379, 1, 1.4].map(voiceGain)).toEqual([0.01, 0.379, 1, 1]);
  });
});

// A run with a buzzer on two sheets, a speaker and a buzzer whose pitch nobody hears.
const part = (id: string, overlay: Record<string, unknown>[]): LoadedPart =>
  ({ id, manifest: { schema: 1, id, version: 1, title: id, fits: [], pins: ["P", "N"], analog: { file: "m.lib", subckt: id }, overlay }, analog: "", logic: null }) as unknown as LoadedPart;
const placed = (ref: string, partId: string, sheet: string, settings: Record<string, string> = {}) => ({
  ref, uuid: `uuid-${ref}`, sheet, partId, version: 1, rule: 3 as const, name: `X${ref}`, nodes: [], connected: [],
  settings: Object.fromEntries(Object.entries(settings).map(([k, value]) => [k, { value, from: "default" as const }])),
});
const signal = (ref: string, partId: string) => ({ ref, partId, name: "loud", vector: `v.x${ref.toLowerCase()}.vloud#branch` });
const RUN = {
  parts: new Map([
    ["buzzer", part("buzzer", [{ widget: "sound", place: { at: "origin" }, signal: "loud", tone: "$tone" }])],
    ["speaker", part("speaker", [{ widget: "sound", place: { at: "origin" }, signal: "loud" }])],
    ["beeper", part("beeper", [{ widget: "glow", place: { at: "origin" }, signal: "loud" }, { widget: "sound", place: { at: "origin" }, signal: "loud", tone: 440 }])],
  ]),
  placed: [
    placed("BZ1", "buzzer", "/", { tone: "2300" }),
    placed("LS1", "speaker", "/"),
    placed("BZ2", "buzzer", "/Alarm/", { tone: "2.7k" }),
    placed("BZ3", "buzzer", "/", { tone: "5" }),
    placed("BZ4", "beeper", "/"),
    placed("BZ5", "buzzer", "/", { tone: "2300" }), // the run has no signal for it
  ],
  signals: [signal("BZ1", "buzzer"), signal("LS1", "speaker"), signal("BZ2", "buzzer"), signal("BZ3", "buzzer"), signal("BZ4", "beeper")],
} as unknown as Pick<PreparedRun, "placed" | "parts" | "signals">;

describe("the parts of a run that are heard", () => {
  it("are the ones with a tone of their own, on every sheet, with the pitch their setting says", () => {
    expect(tonesFor(RUN)).toEqual([
      { key: "/:uuid-BZ1:0", ref: "BZ1", vector: "v.xbz1.vloud#branch", hz: 2300 },
      { key: "/Alarm/:uuid-BZ2:0", ref: "BZ2", vector: "v.xbz2.vloud#branch", hz: 2700 },
      { key: "/:uuid-BZ4:1", ref: "BZ4", vector: "v.xbz4.vloud#branch", hz: 440 },
    ]);
  });

  it("are none in a run without such a part", () => {
    expect(tonesFor({ ...RUN, placed: RUN.placed.filter((p) => p.partId === "speaker") })).toEqual([]);
  });
});

// The browser's audio, as much of it as is used.
function fakeAudio(startsAs: "running" | "suspended" = "running") {
  const made = { contexts: 0, resumed: 0, suspended: 0, closed: 0 };
  const oscillators: { type: string; hz: number; started: boolean; stopped: boolean; to: string }[] = [];
  const gains: { value: number; target: number; to: string }[] = [];
  const filters: { type: string; hz: number }[] = [];
  let state: "running" | "suspended" | "closed" = startsAs;
  const makeContext = (): AudioContext => {
    made.contexts++;
    const ctx = {
      get state() {
        return state;
      },
      currentTime: 12,
      destination: { is: "out" },
      createGain() {
        const g = { value: 1, target: NaN, to: "" };
        gains.push(g);
        return {
          is: `gain${gains.length - 1}`,
          gain: {
            get value() {
              return g.value;
            },
            set value(v: number) {
              g.value = v;
            },
            setTargetAtTime(v: number) {
              g.target = v;
            },
          },
          connect(to: { is: string }) {
            g.to = to.is;
          },
        };
      },
      createOscillator() {
        const o = { type: "sine", hz: 0, started: false, stopped: false, to: "" };
        oscillators.push(o);
        return {
          set type(v: string) {
            o.type = v;
          },
          frequency: {
            set value(v: number) {
              o.hz = v;
            },
          },
          connect(to: { is: string }) {
            o.to = to.is;
          },
          start() {
            o.started = true;
          },
          stop() {
            o.stopped = true;
          },
        };
      },
      createBiquadFilter() {
        const f = { type: "", hz: 0 };
        filters.push(f);
        return {
          is: `filter${filters.length - 1}`,
          set type(v: string) {
            f.type = v;
          },
          frequency: {
            set value(v: number) {
              f.hz = v;
            },
          },
          connect() {},
        };
      },
      async resume() {
        made.resumed++;
        state = "running";
      },
      async suspend() {
        made.suspended++;
        state = "suspended";
      },
      async close() {
        made.closed++;
        state = "closed";
      },
    };
    return ctx as unknown as AudioContext;
  };
  return { made, oscillators, gains, filters, makeContext };
}

const TONES: Tone[] = [
  { key: "a", ref: "BZ1", vector: "va", hz: 2300 },
  { key: "b", ref: "BZ2", vector: "vb", hz: 9000 },
];
const levels = (a: number, b: number) => (tone: Tone) => (tone.key === "a" ? a : b);

describe("playing the tones of a run", () => {
  it("makes no audio while nothing is to be heard", () => {
    const audio = fakeAudio();
    const beeper = createBeeper(TONES, { makeContext: audio.makeContext });
    expect(beeper.set(levels(0, 0.005))).toEqual([]);
    expect(audio.made.contexts).toBe(0);
    expect(beeper.state).toBe("none");
  });

  it("has one oscillator for a part, at its pitch, and makes it as loud as the part is", () => {
    const audio = fakeAudio();
    const beeper = createBeeper(TONES, { makeContext: audio.makeContext });
    expect(beeper.set(levels(1, 0))).toEqual(["BZ1"]);
    expect(audio.made.contexts).toBe(1);
    expect(beeper.state).toBe("running");
    expect(audio.oscillators.map((o) => [o.type, o.hz, o.started])).toEqual([["square", 2300, true], ["square", 9000, true]]);
    // overtones are cut above three times the pitch, and nothing above what is heard
    expect(audio.filters).toEqual([{ type: "lowpass", hz: 6900 }, { type: "lowpass", hz: 20000 }]);
    // gain 0 is all of them together, far below full; the parts' own are 1 and 2
    expect(audio.gains[0]!.value).toBeGreaterThan(0);
    expect(audio.gains[0]!.value).toBeLessThan(0.3);
    expect(audio.gains[0]!.to).toBe("out");
    expect([audio.gains[1]!.value, audio.gains[2]!.value], "silent when they are made").toEqual([0, 0]);
    expect([audio.gains[1]!.target, audio.gains[2]!.target]).toEqual([1, 0]);
    // the next look: the first is switched off, the second sounds at a third
    expect(beeper.set(levels(0, 0.379))).toEqual(["BZ2"]);
    expect([audio.gains[1]!.target, audio.gains[2]!.target]).toEqual([0, 0.379]);
    expect(beeper.set(levels(0.7, 0.9))).toEqual(["BZ1", "BZ2"]);
    expect(audio.made.contexts, "one audio for the whole run").toBe(1);
  });

  it("plays nothing while it is muted, and goes on when it is not", () => {
    const audio = fakeAudio();
    const beeper = createBeeper(TONES, { makeContext: audio.makeContext, muted: true });
    expect(beeper.set(levels(1, 1))).toEqual([]);
    beeper.wake();
    expect(audio.made.contexts, "muted from the start: no audio is made").toBe(0);
    beeper.mute(false);
    expect(beeper.set(levels(1, 0))).toEqual(["BZ1"]);
    expect(audio.made.contexts).toBe(1);
    beeper.mute(true);
    expect(audio.made.suspended).toBe(1);
    expect(beeper.state).toBe("suspended");
    expect(beeper.set(levels(1, 1)), "muted: nothing is played").toEqual([]);
    expect(audio.made.resumed, "and the audio is left asleep").toBe(0);
    beeper.mute(false);
    expect(audio.made.resumed).toBe(1);
    expect(beeper.set(levels(1, 1))).toEqual(["BZ1", "BZ2"]);
  });

  it("wakes audio the browser holds back, at a press and at every look", () => {
    const audio = fakeAudio("suspended");
    const beeper = createBeeper(TONES, { makeContext: audio.makeContext });
    beeper.wake(); // the first press after Play: the audio is made inside it, silent
    expect(audio.made.contexts).toBe(1);
    expect(audio.gains.slice(1).map((g) => g.value)).toEqual([0, 0]);
    expect(audio.made.resumed).toBe(1);
    expect(beeper.state).toBe("running");
  });

  it("stops everything at the end", () => {
    const audio = fakeAudio();
    const beeper = createBeeper(TONES, { makeContext: audio.makeContext });
    beeper.set(levels(1, 1));
    beeper.close();
    expect(audio.oscillators.every((o) => o.stopped)).toBe(true);
    expect(audio.made.closed).toBe(1);
    expect(beeper.state).toBe("closed");
    expect(beeper.set(levels(1, 1))).toEqual([]);
    beeper.wake();
    beeper.mute(true);
    beeper.close();
    expect(audio.made, "nothing more happens").toEqual({ contexts: 1, resumed: 0, suspended: 0, closed: 1 });
  });

  it("goes without sound in a browser that has no audio, and does not ask again", () => {
    let asked = 0;
    const beeper = createBeeper(TONES, {
      makeContext: () => {
        asked++;
        throw new Error("no audio");
      },
    });
    expect(beeper.set(levels(1, 1))).toEqual([]);
    expect(beeper.set(levels(1, 1))).toEqual([]);
    beeper.wake();
    expect(asked).toBe(1);
    expect(beeper.state).toBe("none");
  });

  it("does nothing for a run without a part that is heard", () => {
    const audio = fakeAudio();
    const beeper = createBeeper([], { makeContext: audio.makeContext });
    expect(beeper.set(() => 1)).toEqual([]);
    beeper.wake();
    expect(audio.made.contexts).toBe(0);
  });
});

describe("muted or not", () => {
  it("is heard until the user mutes it, and tells whoever listens", () => {
    const told: boolean[] = [];
    const stop = liveSoundMuted.subscribe(() => told.push(liveSoundMuted.get()));
    expect(liveSoundMuted.get()).toBe(false);
    liveSoundMuted.set(true);
    liveSoundMuted.set(true);
    expect(liveSoundMuted.get()).toBe(true);
    liveSoundMuted.set(false);
    expect(told).toEqual([true, false]);
    stop();
    liveSoundMuted.set(true);
    expect(told, "nobody listens any more").toEqual([true, false]);
    liveSoundMuted.set(false);
  });
});
