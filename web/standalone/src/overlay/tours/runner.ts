/**
 * A state-driven guided tour on top of the overlay (overlay-system 0002 M4).
 *
 * A tour never replays a script: on every trigger (engine event, card button,
 * a slow poll) it samples the editor state and shows the FIRST step whose
 * `when` holds. Closing the chooser by accident, placing two parts, or
 * reloading the page all land on the right step by construction.
 *
 * Tour content is data + small predicates; the runner owns the overlay calls,
 * progress numbering and persistence (the browser's localStorage via
 * tour-store.ts, so a tour survives a reload, the page navigation an editor
 * switch does, and a closed tab).
 */
import { overlay } from "../api";
import { onEditorEvent, type EditorEvent } from "../editor-events";
import type { OverlayButton, OverlayStep } from "../types";
import { readTourEntry, updateTourEntry } from "./tour-store";

/** What a tour's sampler sees: engine events plus the card's own buttons. */
export type TourEvent = EditorEvent | { type: "button"; button: OverlayButton };

export type TourStepContent = Omit<OverlayStep, "owner" | "progress">;

export interface TourStep<S> {
  id: string;
  /** Shown when this holds — steps are tested in array order. */
  when(state: S): boolean;
  content(state: S): TourStepContent;
  /** 1-based position shown on the card ("2 / 4"); defaults to array order. */
  position?: number;
  /** The last step: its Next button finishes the tour. */
  final?: boolean;
}

export interface Tour<S> {
  id: string;
  /** Editor the tour runs in ("eeschema" | "pcbnew"). */
  editor: string;
  title: string;
  /** Read the editor state; `events` is every engine event and card-button
   *  press since the last sample. */
  sample(events: TourEvent[]): S;
  steps: TourStep<S>[];
  /** The card's Back: put the editor back to an earlier step (declarative.ts). False: nothing to go back to. */
  back?(): boolean;
}

export type TourStatus = "active" | "done" | "dismissed";

export function readTourStatus(id: string): TourStatus | null {
  const v = readTourEntry(id)?.status;
  return v === "active" || v === "done" || v === "dismissed" ? v : null;
}

function writeTourStatus(id: string, status: TourStatus): void {
  updateTourEntry(id, { status });
}

export interface TourRunner {
  /** Re-sample and show the right step now (triggers call this). */
  tick(): void;
  stop(status?: TourStatus): void;
  currentStep(): string | null;
  /** The shown step's 1-based position and the tour's length; null before the first step. */
  progress(): { step: number; of: number } | null;
}

export interface TourOptions {
  poll?: boolean;
  /** Overlay owner (default `builtin:<tour id>`; plugins: `plugin:<key>`). */
  owner?: string;
  /** Host-drawn "from …" label; wins over the tour's own title (plugins can't choose it). */
  attribution?: string;
  /** Stored identity (default the tour id); plugins namespace theirs by plugin and project. */
  storageId?: string;
  /** Called once when the tour stops, with the status it ended in (none: stopped by its owner). */
  onStop?(status?: TourStatus): void;
}

const POLL_MS = 500;

/** Tours running on this page, by overlay owner — one guide is on screen at a time. */
const running = new Map<string, { tourId: string; runner: TourRunner }>();

export function runningTours(): { owner: string; tourId: string }[] {
  return [...running].map(([owner, { tourId }]) => ({ owner, tourId }));
}

/** Tests: stop every running tour (no status change). */
export function __stopAllToursForTests(): void {
  for (const { runner } of [...running.values()]) runner.stop();
}

export function startTour<S>(tour: Tour<S>, opts: TourOptions = {}): TourRunner {
  const owner = opts.owner ?? `builtin:${tour.id}`;
  const storageId = opts.storageId ?? tour.id;
  const length = Math.max(...tour.steps.map((s, i) => s.position ?? i + 1));
  let pending: TourEvent[] = [];
  let current: string | null = null;
  let shownKey = "";
  let stopped = false;
  running.get(owner)?.runner.stop();
  writeTourStatus(storageId, "active");

  const tick = () => {
    if (stopped) return;
    const events = pending;
    pending = [];
    let state: S;
    try {
      state = tour.sample(events);
    } catch (err) {
      console.error(`[tour:${tour.id}] sample failed:`, err);
      return;
    }
    const idx = tour.steps.findIndex((s) => s.when(state));
    if (idx < 0) return;
    const step = tour.steps[idx]!;
    const content = step.content(state);
    const key = `${step.id}|${JSON.stringify(content)}`;
    current = step.id;
    // Re-show only when something visible changed: a fresh show resets the
    // target tracking and would flicker the card.
    if (key === shownKey && overlay.getState().step?.owner === owner) return;
    shownKey = key;
    overlay.show({
      ...content,
      owner,
      attribution: opts.attribution ?? content.attribution ?? tour.title,
      // The final step always ends on Next; a Back it offers stays.
      buttons: step.final ? [...(content.buttons ?? []).filter((b) => b === "back"), "next"] : content.buttons,
      progress: { step: step.position ?? idx + 1, of: length },
    });
  };

  let scheduled = false;
  const offEvents = onEditorEvent((e) => {
    pending.push(e);
    // Engine events fire from inside a wasm call: sample on a fresh task,
    // never re-entering the engine from within its own emit.
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      tick();
    }, 0);
  });
  const offButton = overlay.on("button", (e) => {
    if (e.owner !== owner) return;
    const step = tour.steps.find((s) => s.id === current);
    if (e.button === "back") {
      try {
        tour.back?.();
      } catch (err) {
        console.error(`[tour:${tour.id}] back failed:`, err);
      }
      tick();
    } else if (step?.final && e.button === "next") stop("done");
    else {
      pending.push({ type: "button", button: e.button });
      tick();
    }
  });
  const offCleared = overlay.on("cleared", (e) => {
    if (e.owner !== owner) return;
    if (e.reason === "user") stop("dismissed");
    // "unmount": the page is going away (editor switch) — stay "active" so the
    // next page resumes; "replaced"/"owner" are our own re-shows.
  });
  const timer = opts.poll === false ? null : setInterval(tick, POLL_MS);

  function stop(status?: TourStatus) {
    if (stopped) return;
    stopped = true;
    offEvents();
    offButton();
    offCleared();
    if (timer) clearInterval(timer);
    if (running.get(owner)?.runner === runner) running.delete(owner);
    if (status) writeTourStatus(storageId, status);
    overlay.clear(owner);
    try {
      opts.onStop?.(status);
    } catch (err) {
      console.error(`[tour:${tour.id}] onStop failed:`, err);
    }
  }

  const runner: TourRunner = {
    tick,
    stop,
    currentStep: () => current,
    progress: () => {
      const idx = tour.steps.findIndex((s) => s.id === current);
      return idx < 0 ? null : { step: tour.steps[idx]!.position ?? idx + 1, of: length };
    },
  };
  running.set(owner, { tourId: tour.id, runner });
  tick();
  return runner;
}
