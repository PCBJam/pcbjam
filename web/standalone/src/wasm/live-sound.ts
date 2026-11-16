/**
 * Live simulation, what is heard: a part that has a tone of its own (a buzzer
 * with its electronics inside) is played through the computer's speakers
 * while the circuit makes it sound.
 *
 *   - which parts: the ones whose "sound" widget says a `tone`, a pitch in
 *     Hz (the part's setting, as a rule). A speaker has none: what it plays
 *     comes from the circuit, and is shown as rings only;
 *   - how loud: the part's own signal, the one its rings follow. A part is
 *     heard from its first ring on;
 *   - of the whole circuit that runs, not of the open sheet alone: a buzzer
 *     is heard whether it is on the screen or not;
 *   - the browser's audio is made when there is something to hear, or on the
 *     first press of a button or key after Play (some browsers start audio
 *     inside such a press only);
 *   - the user can mute it. That is kept in the browser.
 */
import type { PreparedRun } from "@pcbjam/shared/sim-library";
import { SOUND_STEPS } from "./live-overlay";

/** One part that is heard. */
export interface Tone {
  /** The widget's key: the sheet, the symbol and the widget's place in the part's list. */
  key: string;
  ref: string;
  /** The simulator's name of the part's loudness (1 is its full loudness). */
  vector: string;
  /** The pitch, in Hz. */
  hz: number;
}

/** What a person hears, in Hz. */
export const TONE_LEAST_HZ = 20;
export const TONE_MOST_HZ = 20000;

/** A pitch as a part gives it: 2300, "2300" or "2.3k". Null when it is none that is heard. */
export function toneHz(value: unknown): number | null {
  let hz: number;
  if (typeof value === "number") hz = value;
  else if (typeof value === "string" && /^[0-9]+(\.[0-9]+)?k?$/.test(value)) hz = value.endsWith("k") ? Number(value.slice(0, -1)) * 1000 : Number(value);
  else return null;
  return Number.isFinite(hz) && hz >= TONE_LEAST_HZ && hz <= TONE_MOST_HZ ? hz : null;
}

/** The parts of a run that are heard: every "sound" widget with a tone, on whatever sheet. */
export function tonesFor(run: Pick<PreparedRun, "placed" | "parts" | "signals">): Tone[] {
  const tones: Tone[] = [];
  for (const placed of run.placed) {
    const overlay = run.parts.get(placed.partId)?.manifest.overlay ?? [];
    overlay.forEach((entry, index) => {
      if (entry.widget !== "sound" || entry.tone === undefined || !entry.signal) return;
      const said = entry.tone;
      const hz = toneHz(typeof said === "string" && said.startsWith("$") ? placed.settings[said.slice(1)]?.value : said);
      const signal = run.signals.find((s) => s.ref === placed.ref && s.name === entry.signal);
      if (hz === null || !signal) return;
      tones.push({ key: `${placed.sheet}:${placed.uuid}:${index}`, ref: placed.ref, vector: signal.vector, hz });
    });
  }
  return tones;
}

/** A part is heard from this loudness on: where its first ring shows. */
export const HEARD_FROM = SOUND_STEPS[0]!;

/** How loud a part is played, from 0 to 1, for its loudness in the circuit. */
export function voiceGain(level: number): number {
  if (!(level >= HEARD_FROM)) return 0;
  return Math.min(1, level);
}

/** All the parts together are played this loud at most times their number: a beep, not an alarm. */
const MASTER_GAIN = 0.12;
/** A tone comes and goes within this time, in seconds: no click when a part is switched. */
const SMOOTH_S = 0.015;
/** What is left of a tone's overtones: above this many times its pitch they are cut. A bare square wave is harsh. */
const SOFTEN_AT = 3;

export type BeeperState = "none" | "running" | "suspended" | "closed";

export interface Beeper {
  /**
   * The loudness of every part right now. Makes the browser's audio when there is
   * something to hear. Returns the references of the parts that are played.
   */
  set(levelOf: (tone: Tone) => number): string[];
  /** A button or key was pressed: the audio is made, or woken, inside that press. */
  wake(): void;
  mute(muted: boolean): void;
  /** The browser's audio: "none" while it was not made yet. */
  readonly state: BeeperState;
  /** Silence, and the audio is given back. */
  close(): void;
}

export interface BeeperOptions {
  muted?: boolean;
  /** For tests: makes the browser's audio. */
  makeContext?: () => AudioContext;
}

const browserContext = (): AudioContext => {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("this browser has no audio");
  return new Ctor();
};

/** Plays the tones of one run. One oscillator for a part, silent until the part sounds. */
export function createBeeper(tones: readonly Tone[], options: BeeperOptions = {}): Beeper {
  const makeContext = options.makeContext ?? browserContext;
  let muted = options.muted ?? false;
  let closed = false;
  let failed = false; // the browser has no audio: not tried again
  let ctx: AudioContext | null = null;
  const gains = new Map<string, GainNode>();
  const oscillators: OscillatorNode[] = [];

  function start(): boolean {
    if (ctx) return true;
    if (closed || failed || !tones.length) return false;
    try {
      ctx = makeContext();
      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
      for (const tone of tones) {
        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.value = tone.hz;
        const soft = ctx.createBiquadFilter();
        soft.type = "lowpass";
        soft.frequency.value = Math.min(tone.hz * SOFTEN_AT, TONE_MOST_HZ);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(soft);
        soft.connect(gain);
        gain.connect(master);
        osc.start();
        oscillators.push(osc);
        gains.set(tone.key, gain);
      }
      return true;
    } catch {
      failed = true;
      ctx = null;
      return false;
    }
  }

  /** A browser may hold new audio back until a press: asked to go on whenever it stands still. */
  function goOn(): void {
    if (ctx && !muted && ctx.state === "suspended") void ctx.resume().catch(() => {});
  }

  return {
    set(levelOf) {
      if (closed) return [];
      const heard = tones.filter((tone) => voiceGain(levelOf(tone)) > 0);
      if (!muted && heard.length > 0) start();
      if (ctx) {
        goOn();
        const now = ctx.currentTime;
        for (const tone of tones) gains.get(tone.key)?.gain.setTargetAtTime(voiceGain(levelOf(tone)), now, SMOOTH_S);
      }
      // without audio (muted, or a browser that has none) nothing is played
      return ctx && !muted ? heard.map((tone) => tone.ref) : [];
    },
    wake() {
      if (closed || muted) return;
      start();
      goOn();
    },
    mute(next) {
      if (closed || muted === next) return;
      muted = next;
      if (!ctx) return;
      if (muted) void ctx.suspend().catch(() => {});
      else goOn();
    },
    get state(): BeeperState {
      if (closed) return "closed";
      if (!ctx) return "none";
      return ctx.state === "running" ? "running" : "suspended";
    },
    close() {
      if (closed) return;
      closed = true;
      for (const osc of oscillators) {
        try {
          osc.stop();
        } catch {
          /* it never ran */
        }
      }
      void ctx?.close().catch(() => {});
      ctx = null;
    },
  };
}

// --- muted or not: the user's choice, kept in the browser ---------------------

const MUTED_KEY = "pcbjam:live-sound";
const listeners = new Set<() => void>();

function readMuted(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(MUTED_KEY) === "off";
  } catch {
    return false; // blocked storage: it is heard
  }
}
let mutedNow: boolean | null = null;

/** Whether the user muted the simulation's sound. For React: `useSyncExternalStore(subscribe, get)`. */
export const liveSoundMuted = {
  get(): boolean {
    if (mutedNow === null) mutedNow = readMuted();
    return mutedNow;
  },
  set(muted: boolean): void {
    if (liveSoundMuted.get() === muted) return;
    mutedNow = muted;
    try {
      if (muted) localStorage.setItem(MUTED_KEY, "off");
      else localStorage.removeItem(MUTED_KEY);
    } catch {
      /* not remembered */
    }
    for (const fn of [...listeners]) fn();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
