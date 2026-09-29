/**
 * A state-driven guided tour on top of the overlay (overlay-system 0002 M4).
 *
 * A tour never replays a script: on every trigger (engine event, card button,
 * a slow poll) it samples the editor state and shows the FIRST step whose
 * `when` holds. Closing the chooser by accident, placing two parts, or
 * reloading the page all land on the right step by construction.
 *
 * Tour content is data + small predicates; the runner owns the overlay calls,
 * progress numbering and persistence (sessionStorage, so a tour survives the
 * page navigation an editor switch does).
 */
import { overlay } from "../api";
import { onEditorEvent, type EditorEvent } from "../editor-events";
import type { OverlayButton, OverlayStep } from "../types";

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
}

export type TourStatus = "active" | "done" | "dismissed";

const storageKey = (id: string) => `pcbjam:tour:${id}`;

export function readTourStatus(id: string): TourStatus | null {
  try {
    const v = sessionStorage.getItem(storageKey(id));
    return v === "active" || v === "done" || v === "dismissed" ? v : null;
  } catch {
    return null;
  }
}

function writeTourStatus(id: string, status: TourStatus): void {
  try {
    sessionStorage.setItem(storageKey(id), status);
  } catch {
    /* private mode — the tour just won't resume after a navigation */
  }
}

export interface TourRunner {
  /** Re-sample and show the right step now (triggers call this). */
  tick(): void;
  stop(status?: TourStatus): void;
  currentStep(): string | null;
}

const POLL_MS = 500;

export function startTour<S>(tour: Tour<S>, opts: { poll?: boolean } = {}): TourRunner {
  const owner = `builtin:${tour.id}`;
  let pending: TourEvent[] = [];
  let current: string | null = null;
  let shownKey = "";
  let stopped = false;
  writeTourStatus(tour.id, "active");

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
      attribution: content.attribution ?? tour.title,
      buttons: step.final ? ["next"] : content.buttons,
      progress: { step: step.position ?? idx + 1, of: Math.max(...tour.steps.map((s, i) => s.position ?? i + 1)) },
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
    if (step?.final && e.button === "next") stop("done");
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
    if (status) writeTourStatus(tour.id, status);
    overlay.clear(owner);
  }

  tick();
  return { tick, stop, currentStep: () => current };
}
