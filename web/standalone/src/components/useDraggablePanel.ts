import * as React from "react";
import { registerPanel, startPanelDrag, type PanelDrag } from "@/overlay/panel-layout";

/**
 * Shared draggable-overlay behavior (comments-ux 0001 B), extracted from the
 * 0010 OverlayMenu FAB and reused by the floating comments panel: pointer-
 * capture dragging with a click-vs-drag threshold, viewport clamping, and
 * per-panel position persistence with an ALWAYS-ONSCREEN restore guarantee.
 *
 * Persistence stores FRACTIONS of the viewport's free space, not absolute px:
 * an ordinary window resize keeps the element roughly where the user left it,
 * and a restore can never land offscreen (fractions clamp to [0,1]). Legacy
 * absolute-px entries (pre-fraction format, possibly from a bigger or
 * secondary display) are honored only if the drag handle would still be fully
 * visible — otherwise they are discarded and the caller's default CSS anchor
 * applies. Live window resizes re-clamp mid-session, so the handle can never
 * be stranded outside the viewport.
 *
 * Panels snap (overlay-system 0007): to the window's edges, the other panels and the
 * editor's drawing area, toolbars and panes, unless Alt is held; panels stacked under this one
 * move with it. A locked layout or a pinned panel doesn't start a drag at all, so a click on the
 * handle stays a click. The caller puts `data-snap-panel={snapId}` on the panel's root.
 */

type Pos = { x: number; y: number };

const DRAG_THRESHOLD_PX = 4;

function freeSpace(handleW: number, handleH: number, margin: number) {
  return {
    w: Math.max(0, window.innerWidth - handleW - 2 * margin),
    h: Math.max(0, window.innerHeight - handleH - 2 * margin),
  };
}

/**
 * Resolve a stored position against the CURRENT viewport (pure — exported for
 * tests). Fraction entries always restore onscreen (clamped to [0,1] of the
 * free space); legacy absolute-px entries are honored only if the handle
 * would still be fully visible, else discarded (null = default anchor).
 */
export function restorePosition(
  raw: string | null,
  viewport: { w: number; h: number },
  handleW: number,
  handleH: number,
  margin = 4,
): Pos | null {
  if (!raw) return null;
  let v: Partial<{ fx: number; fy: number; x: number; y: number }>;
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    return null;
  }
  if (typeof v.fx === "number" && typeof v.fy === "number") {
    const w = Math.max(0, viewport.w - handleW - 2 * margin);
    const h = Math.max(0, viewport.h - handleH - 2 * margin);
    return {
      x: margin + Math.min(Math.max(v.fx, 0), 1) * w,
      y: margin + Math.min(Math.max(v.fy, 0), 1) * h,
    };
  }
  if (typeof v.x === "number" && typeof v.y === "number") {
    const onscreen =
      v.x >= 0 && v.y >= 0 && v.x + handleW <= viewport.w && v.y + handleH <= viewport.h;
    return onscreen ? { x: v.x, y: v.y } : null;
  }
  return null;
}

export function useDraggablePanel(opts: {
  storageKey: string;
  /** Clamp box of the DRAG HANDLE (FAB / header bar) — what stays onscreen. */
  handleWidth: number;
  handleHeight: number;
  margin?: number;
  /** False: Arrange leaves it where it is (a button, not a panel). */
  arrange?: false;
}) {
  const { storageKey, handleWidth, handleHeight, margin = 4, arrange } = opts;

  const clamp = React.useCallback(
    (p: Pos): Pos => {
      const f = freeSpace(handleWidth, handleHeight, margin);
      return {
        x: Math.min(Math.max(p.x, margin), margin + f.w),
        y: Math.min(Math.max(p.y, margin), margin + f.h),
      };
    },
    [handleWidth, handleHeight, margin],
  );

  const [pos, setPos] = React.useState<Pos | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return restorePosition(
        localStorage.getItem(storageKey),
        { w: window.innerWidth, h: window.innerHeight },
        handleWidth,
        handleHeight,
        margin,
      );
    } catch {
      return null;
    }
  });

  const persist = React.useCallback(
    (p: Pos) => {
      try {
        const f = freeSpace(handleWidth, handleHeight, margin);
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            fx: f.w > 0 ? (p.x - margin) / f.w : 0,
            fy: f.h > 0 ? (p.y - margin) / f.h : 0,
          }),
        );
      } catch {
        /* private mode — position just doesn't persist */
      }
    },
    [storageKey, handleWidth, handleHeight, margin],
  );

  // Where the store last moved it (a stack, an anchor, Arrange): what its commit saves.
  const latest = React.useRef<Pos | null>(pos);
  React.useEffect(
    () =>
      registerPanel({
        id: storageKey,
        arrange,
        moveTo: (x, y) => {
          latest.current = clamp({ x, y });
          setPos(latest.current);
        },
        commit: () => {
          if (latest.current) persist(latest.current);
        },
      }),
    [storageKey, arrange, clamp, persist],
  );

  // A live resize must not strand the handle outside the shrunken viewport.
  React.useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  const dragRef = React.useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    width: number;
    height: number;
    moved: boolean;
    session: PanelDrag;
  } | null>(null);

  /** `handleRect` = the dragged element's current rect (measured by caller —
   *  the handle may not be the element being repositioned). */
  const onPointerDown = (e: React.PointerEvent, handleRect: { x: number; y: number; width?: number; height?: number }) => {
    const session = startPanelDrag(storageKey);
    if (!session) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: handleRect.x,
      baseY: handleRect.y,
      width: handleRect.width ?? handleWidth,
      height: handleRect.height ?? handleHeight,
      moved: false,
      session,
    };
  };

  /** Returns true the moment the gesture crosses the drag threshold (callers
   *  close popups / mark "this is a drag, not a click" on that edge). */
  const onPointerMove = (e: React.PointerEvent): boolean => {
    const d = dragRef.current;
    if (!d) return false;
    let crossed = false;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return false;
      d.moved = true;
      crossed = true;
    }
    const next = { x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY), w: d.width, h: d.height };
    const snapped = d.session.move(next, e.altKey);
    latest.current = clamp({ x: snapped.x, y: snapped.y });
    setPos(latest.current);
    return crossed;
  };

  /** Ends the gesture; returns whether it was a drag (persisted) or a click. */
  const onPointerUp = (): boolean => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return false;
    if (d.moved) setPos((p) => (p ? (persist(p), p) : p));
    d.session.end(d.moved);
    return d.moved;
  };

  return { pos, onPointerDown, onPointerMove, onPointerUp, snapId: storageKey };
}
