import * as React from "react";
import { Users } from "lucide-react";
import { useDraggablePanel } from "@/components/useDraggablePanel";

/**
 * Unified overlay menu (collab-presence 0010): the single circular icon that
 * replaces the old top-right overlay row. The FAB is draggable anywhere over
 * the canvas (pointer capture, 4px click-vs-drag threshold — the comment-pin
 * pattern), its position persists per browser, and its badge shows how many
 * OTHER users are in the session. Clicking opens a panel that stacks the
 * sections WasmTool composes as children (roster, source chip, view-only
 * pill, follow row, comments, chrome toggle, …) — adding a future section is
 * one more child. Renders above everything (z-50, including wx dialogs and
 * toasts) by decision: it is trivially dismissed (click-away, Esc, the FAB)
 * and can be dragged out of the way. Stays up in chrome-hidden mode — it is
 * the canvas-only survivor the chrome toggle used to be.
 *
 * VISUAL SYSTEM. The panel previously stacked whatever its children happened to
 * look like — free-floating pills of different heights, radii and surfaces, all
 * left-aligned with a gap. It read as debris rather than a menu. The primitives
 * below are the fix and the contract:
 *
 *   OverlayMenuSection — a labelled group, separated from its neighbours.
 *   overlayRowClass    — the shared row shape for anything interactive.
 *
 * Children compose these instead of inventing their own chrome. Two deliberate
 * exceptions stay self-styled because they are shared with light-background
 * pages (SourceChip) or own a nontrivial internal layout (PresenceRoster) —
 * those are wrapped in a section rather than restyled.
 */

/** Row shape for any interactive item in the panel. Full-width so the panel
 *  reads as a list; the hover/active states are the only affordance needed. */
export const overlayRowClass =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs " +
  "text-neutral-800 transition-colors hover:bg-black/5 " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-black/30 " +
  "dark:text-white/90 dark:hover:bg-white/10 dark:focus-visible:ring-white/40";

/** A labelled group. `label` is omitted for the first/unnamed group. */
export function OverlayMenuSection({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-full flex-col gap-1 border-t border-black/10 pt-2 first:border-t-0 first:pt-0 dark:border-white/10">
      {label && (
        <div className="px-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-white/40">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

const POS_KEY = "pcbjam:overlay-menu-pos";
const FAB_SIZE = 36;

export function OverlayMenu({
  badge,
  unread = 0,
  unreadMention = false,
  children,
}: {
  /** Peer count shown on the FAB (0 hides the badge). */
  badge: number;
  /** Unread comment threads (comments-ux 0001 C) — amber FAB badge, bottom
   *  corner; rose when one of them mentions the current user. 0 hides it. */
  unread?: number;
  unreadMention?: boolean;
  /** Panel sections, rendered top-to-bottom. Falsy children collapse. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  // Drag/clamp/persist behavior shared with the comments panel (0001 B) —
  // including the always-onscreen restore guarantee.
  const drag = useDraggablePanel({
    storageKey: POS_KEY,
    handleWidth: FAB_SIZE,
    handleHeight: FAB_SIZE,
  });
  const pos = drag.pos;

  // Esc closes (bubble phase, same etiquette as the comment layer — wx also
  // sees the key, matching how every other overlay treats Escape).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Click-away: any pointerdown outside the menu closes it (canvas included —
  // wx pointer handlers bind to #canvas, so this listener still fires).
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const onFabPointerDown = (e: React.PointerEvent) => {
    drag.onPointerDown(e, rootRef.current!.getBoundingClientRect());
  };

  const onFabPointerMove = (e: React.PointerEvent) => {
    // Dragging repositions; the click that follows reopens.
    if (drag.onPointerMove(e)) setOpen(false);
  };

  const onFabPointerUp = () => {
    if (!drag.onPointerUp()) setOpen((o) => !o);
  };

  // Default anchor: top-right (the old row's home). After a drag, explicit px.
  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { right: 12, top: 12 };
  // The panel opens toward the screen's center from wherever the FAB sits.
  const onLeftHalf = pos ? pos.x < window.innerWidth / 2 : false;
  const onTopHalf = pos ? pos.y < window.innerHeight / 2 : true;

  return (
    <div ref={rootRef} className="absolute z-50" style={style}>
      <button
        type="button"
        data-testid="overlay-menu-fab"
        aria-expanded={open}
        title="Session menu — drag to move"
        onPointerDown={onFabPointerDown}
        onPointerMove={onFabPointerMove}
        onPointerUp={onFabPointerUp}
        className={`relative flex h-9 w-9 items-center justify-center rounded-full shadow-lg ring-1 ring-inset transition-colors ${
          open
            ? "bg-sky-600 text-white ring-sky-300/40"
            : "bg-white/90 text-neutral-700 ring-black/15 backdrop-blur-sm hover:bg-white " +
              "dark:bg-neutral-950/80 dark:text-white dark:ring-white/15 dark:hover:bg-neutral-900/90"
        }`}
        style={{ touchAction: "none" }}
      >
        <Users size={16} />
        {badge > 0 && (
          <span
            data-testid="overlay-menu-badge"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold text-white"
          >
            {badge}
          </span>
        )}
        {unread > 0 && (
          <span
            data-testid="overlay-menu-unread-badge"
            title={unreadMention ? "Unread comments — you were mentioned" : "Unread comments"}
            className={`absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white ${
              unreadMention ? "bg-rose-500" : "bg-amber-500"
            }`}
          >
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="overlay-menu-panel"
          className={`absolute flex w-72 flex-col gap-2 rounded-xl bg-white/95 p-2 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:ring-white/15 ${
            onLeftHalf ? "left-0" : "right-0"
          } ${onTopHalf ? "top-11" : "bottom-11"}`}
        >
          <div className="flex items-center justify-between px-2 pt-0.5">
            <span className="text-[11px] font-semibold tracking-wide text-neutral-600 dark:text-white/70">
              Session
            </span>
            {badge > 0 && (
              <span className="text-[10px] text-neutral-400 dark:text-white/40">
                {badge} {badge === 1 ? "other" : "others"} here
              </span>
            )}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
