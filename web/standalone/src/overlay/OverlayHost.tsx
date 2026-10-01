import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getOverlayState, overlay, pressButton, subscribeOverlay } from "./api";
import { Celebration, trackPointer } from "./Celebration";
import { layoutCard, spotlightPath, spotlightRect } from "./geometry";
import { installOverlayDemo } from "./demo";
import { installEditorEvents, onEditorEvent, openDialogPtrs } from "./editor-events";
import { dialogRects } from "./obstacles";
import { isCanvasWork, isTargetAction, pointInRect, stepUseKey } from "./target-use";
import { startOverlayTracking } from "./tracker";
import type { OverlayButton } from "./types";
import { glCanvasRect, type CssRect } from "@/wasm/canvas-coords";

/**
 * The overlay layer (overlay-system 0002 M1): spotlight, target ring and the
 * step card. Above panels (z-40) and the wx windows, below dialogs (z-50),
 * the plugin sidebar (z-55) and popovers. Only the card takes pointer
 * events — the dim is visual, clicks reach the real UI underneath. Hidden
 * entirely while a trusted prompt is open.
 *
 * Esc closes only when focus is inside the card: on the canvas Esc belongs
 * to KiCad (cancel the running tool), which tutorials ask users to press.
 */

const BUTTON_LABEL: Record<OverlayButton, string> = { back: "Back", skip: "Skip", next: "Next" };

/**
 * Rects the card should not cover — host UI marked `[data-overlay-obstacle]` (floating plugin
 * panels) and open KiCad dialogs — re-measured per frame while a step is shown: panels are
 * dragged, collapsed, hidden; dialogs open, close and move. `dialog` tells whether any
 * KiCad dialog is among them.
 */
function useObstacles(active: boolean): { rects: CssRect[]; dialog: boolean } {
  const [obstacles, setObstacles] = React.useState<{ rects: CssRect[]; dialog: boolean }>(NO_OBSTACLES);
  React.useEffect(() => {
    if (!active) {
      setObstacles(NO_OBSTACLES);
      return;
    }
    let raf = 0;
    let last = "";
    const frame = () => {
      const canvas = document.getElementById("canvas")?.getBoundingClientRect();
      const panels = Array.from(document.querySelectorAll("[data-overlay-obstacle]"))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
      const dialogs = canvas ? dialogRects(openDialogPtrs(), window.wxElementRegistry?.elements, { x: canvas.left, y: canvas.top }) : [];
      const next = { rects: panels.concat(dialogs), dialog: dialogs.length > 0 };
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setObstacles(next);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return obstacles;
}

const NO_OBSTACLES = { rects: [] as CssRect[], dialog: false };

/** A pointerdown on the sheet or board itself (target-use.ts `isCanvasWork`). */
function isSheetClick(ev: PointerEvent): boolean {
  const el = ev.target as Element | null;
  if (el?.id !== "canvas") return false;
  const origin = el.getBoundingClientRect();
  const dialogs = dialogRects(openDialogPtrs(), window.wxElementRegistry?.elements, { x: origin.left, y: origin.top });
  return isCanvasWork(ev.clientX, ev.clientY, glCanvasRect(), dialogs);
}

/**
 * True once the user used this step's target: clicked inside it, ran its
 * tool's action (hotkey), or clicked on the sheet or board. Keyed by the step
 * (target-use.ts), so the dim comes back only for a new request.
 */
function useTargetUsed(key: string | null, target: string | undefined, rect: CssRect | null): boolean {
  const [usedKey, setUsedKey] = React.useState<string | null>(null);
  const rectRef = React.useRef(rect);
  rectRef.current = rect;
  React.useEffect(() => {
    if (!key || !target) return;
    const mark = () => setUsedKey(key);
    const offAction = onEditorEvent((e) => {
      if (isTargetAction(e, target)) mark();
    });
    // Capture phase: the engine's canvas handlers must not hide the click from us.
    const onDown = (ev: PointerEvent) => {
      const r = rectRef.current;
      if ((r && pointInRect(ev.clientX, ev.clientY, r)) || isSheetClick(ev)) mark();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      offAction();
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [key, target]);
  return key !== null && usedKey === key;
}

function useViewSize(): { w: number; h: number } {
  const [size, setSize] = React.useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  React.useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

export function OverlayHost({ tool }: { tool: string }) {
  const state = React.useSyncExternalStore(subscribeOverlay, getOverlayState);
  const view = useViewSize();
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [card, setCard] = React.useState<{ w: number; h: number } | null>(null);

  React.useEffect(() => installEditorEvents(), []);
  React.useEffect(() => startOverlayTracking(), []);
  React.useEffect(() => trackPointer(), []);
  // After tracking + events: a demo tour shows its first step immediately.
  React.useEffect(() => installOverlayDemo(tool), [tool]);
  // The page navigates away on an editor switch; clear on unmount so owners
  // hear about it (their progress lives with them, not here).
  React.useEffect(() => () => void overlay.clear(undefined, "unmount"), []);

  const { step, target, targetState, paused } = state;
  const stepKey = step ? stepUseKey(step) : null;
  const obstacles = useObstacles(!!step && !paused);
  const used = useTargetUsed(stepKey, step?.target, targetState === "found" && target ? target.rect : null);

  // A celebrating step celebrates once each time it is reached (not on every re-show of the
  // same card). The effect outlives the step: a final "well done" card may end the tour at once.
  const [celebration, setCelebration] = React.useState<number | null>(null);
  const celebrations = React.useRef(0);
  const celebrate = step?.celebrate;
  React.useEffect(() => {
    if (celebrate) setCelebration(++celebrations.current);
  }, [stepKey, celebrate]);
  const celebrationLayer =
    celebration !== null ? <Celebration key={celebration} onDone={() => setCelebration(null)} /> : null;

  React.useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) {
      setCard(null);
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setCard((prev) => (prev && prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [step, paused]);

  if (!step || paused) return celebrationLayer;

  const anchored = targetState === "found" && target ? target : null;
  const layout = card ? layoutCard({ target: anchored?.rect ?? null, card, view, placement: step.placement, obstacles: obstacles.rects }) : null;
  // The dim and the ring point at where to click. Once the user used the target — or a dialog
  // it opened is where they work now — they would only grey out the work (target-use.ts).
  const dialogCovered = obstacles.dialog && !step.target?.startsWith("dialog:");
  const spot =
    anchored && anchored.surface === "ui" && step.spotlight && !dialogCovered && !used ? spotlightRect(anchored.rect) : null;
  const ring = anchored && !used && (step.pulse || anchored.surface === "canvas") ? spotlightRect(anchored.rect, 4) : null;
  const text = targetState === "lost" && step.lostText ? step.lostText : step.text;
  const buttons = step.buttons ?? [];

  return (
    <>
      {celebrationLayer}
      <div data-testid="overlay-root" className="pointer-events-none fixed inset-0 z-[45]">
        {spot && (
          <svg data-testid="overlay-spotlight" className="absolute inset-0 h-full w-full" aria-hidden>
            <path d={spotlightPath(view, spot)} fill="rgba(0,0,0,0.45)" fillRule="evenodd" />
          </svg>
        )}
        {ring && (
          <div
            data-testid="overlay-ring"
            aria-hidden
            className="absolute rounded-lg ring-2 ring-sky-400 motion-safe:animate-pulse"
            style={{ left: ring.x, top: ring.y, width: ring.width, height: ring.height }}
          />
        )}
        <div
          ref={cardRef}
          role="dialog"
          aria-label={step.title ?? "Guide"}
          data-testid="overlay-card"
          data-owner={step.owner}
          data-target-state={targetState}
          data-side={layout?.side ?? ""}
          data-docked={layout?.docked ? "1" : "0"}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              pressButton("close");
            }
          }}
          // Only the buttons take the pointer: the card often sits over the sheet right where the
          // user works (a part follows the mouse below it), so moves and clicks on its body reach
          // the canvas underneath.
          className={cn(
            "pointer-events-none absolute w-80 max-w-[calc(100vw-24px)] rounded-xl bg-white text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 dark:bg-neutral-900 dark:text-white dark:ring-white/15",
            !layout && "invisible",
          )}
          style={{ left: layout?.x ?? 0, top: layout?.y ?? 0 }}
        >
          {layout?.arrow && (
            <div
              aria-hidden
              data-testid="overlay-arrow"
              className="absolute h-3 w-3 rotate-45 bg-white ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/15"
              style={{ left: layout.arrow.x - layout.x - 6, top: layout.arrow.y - layout.y - 6 }}
            />
          )}
          <div className="relative rounded-xl bg-inherit px-4 pb-3 pt-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {(step.attribution || step.progress) && (
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-neutral-500 dark:text-white/50">
                    {step.attribution && (
                      <span data-testid="overlay-attribution" className="truncate">
                        from {step.attribution}
                      </span>
                    )}
                    {step.progress && (
                      <span data-testid="overlay-progress" className="ml-auto shrink-0 tabular-nums">
                        {step.progress.step} / {step.progress.of}
                      </span>
                    )}
                  </div>
                )}
                {step.title && <div className="text-sm font-semibold">{step.title}</div>}
              </div>
              <button
                type="button"
                aria-label="Close guide"
                data-testid="overlay-close"
                onClick={() => pressButton("close")}
                className="pointer-events-auto -mr-1 rounded p-0.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p data-testid="overlay-text" aria-live="polite" className="mt-1 whitespace-pre-line text-sm leading-snug">
              {text}
            </p>
            {buttons.length > 0 && (
              <div className="mt-3 flex items-center justify-end gap-2">
                {buttons.map((b) => (
                  <button
                    key={b}
                    type="button"
                    data-testid={`overlay-${b}`}
                    onClick={() => pressButton(b)}
                    className={cn(
                      "pointer-events-auto rounded-md px-3 py-1 text-xs font-medium",
                      b === "next"
                        ? "bg-sky-600 text-white hover:bg-sky-500"
                        : "text-neutral-600 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10",
                    )}
                  >
                    {BUTTON_LABEL[b]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
