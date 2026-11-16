/**
 * Live simulation, what is heard (wasm/live-sound.ts): mounted while a circuit
 * runs. It draws nothing. A buzzer of the circuit is played while it sounds,
 * on whatever sheet it is, unless the user muted the sound (Session menu).
 *
 * The element it leaves in the page says what goes on, for the tests and for
 * whoever looks: how many parts can be heard, which are heard right now, and
 * whether the browser's audio runs.
 */
import * as React from "react";
import type { LiveFrame } from "@/wasm/live-engine";
import type { LiveSession } from "@/wasm/live-session";
import { createBeeper, liveSoundMuted, tonesFor, type Beeper } from "@/wasm/live-sound";

/** Whether the user muted the simulation's sound, and the way to change it. */
export function useLiveSoundMuted(): [boolean, (muted: boolean) => void] {
  return [React.useSyncExternalStore(liveSoundMuted.subscribe, liveSoundMuted.get), liveSoundMuted.set];
}

export function LiveSound({ session }: { session: LiveSession }): React.ReactElement | null {
  const run = session.run;
  const tones = React.useMemo(() => (run ? tonesFor(run) : []), [run]);
  const [muted] = useLiveSoundMuted();
  const out = React.useRef<HTMLSpanElement>(null);
  const beeper = React.useRef<Beeper | null>(null);

  React.useEffect(() => {
    if (!tones.length) return;
    const b = createBeeper(tones, { muted: liveSoundMuted.get() });
    beeper.current = b;
    let names: string[] = [];
    let index = new Map<string, number>();
    const stopListening = session.onFrame((frame: LiveFrame) => {
      if (frame.names.length !== names.length || frame.names[0] !== names[0]) {
        names = frame.names;
        index = new Map(names.map((name, i) => [name, i]));
      }
      const heard = b.set((tone) => {
        const i = index.get(tone.vector);
        return i === undefined ? 0 : frame.avg[i] ?? 0;
      });
      if (!out.current) return;
      out.current.dataset.heard = heard.join(" ");
      out.current.dataset.state = b.state;
    });
    const wake = (): void => b.wake();
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("keydown", wake, true);
    return () => {
      stopListening();
      window.removeEventListener("pointerdown", wake, true);
      window.removeEventListener("keydown", wake, true);
      b.close();
      beeper.current = null;
    };
  }, [session, tones]);

  React.useEffect(() => {
    beeper.current?.mute(muted);
  }, [muted, tones]);

  if (!tones.length) return null;
  return <span ref={out} hidden data-testid="live-sound-out" data-tones={tones.length} data-muted={muted} data-state="none" data-heard="" />;
}
