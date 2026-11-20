import * as React from "react";
import { X } from "lucide-react";
import { Button, Tip, cn } from "@pcbjam/ui";
import { overlayIconClass } from "@/components/OverlayMenu";
import { useDraggablePanel } from "@/components/useDraggablePanel";
import { PanelDock } from "@/overlay/PanelDock";
import { PanelPin } from "@/overlay/PanelPin";
import { panelDock, type DockSide } from "@/overlay/panel-dock";

const PANEL_W = 360;
const HEADER_H = 40;
/** One panel's width to the left of the chat's spot; on a narrow window, as far left as it fits. */
const BESIDE_RIGHT = `max(12px, min(${PANEL_W + 24}px, calc(100vw - ${PANEL_W + 8}px)))`;

/** A dot that says "new": on a row or a button until the person has opened what it marks. */
export function NewDot({ className, label = "New" }: { className?: string; label?: string }) {
  return (
    <span data-testid="new-dot" className={cn("size-2 shrink-0 rounded-full bg-sky-500", className)}>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Marks a feature that is part of the Pro plan. */
export function ProBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="pro-badge"
      className={cn(
        "shrink-0 rounded bg-neutral-900 px-1.5 text-[10px] font-semibold leading-4 tracking-wide text-white dark:bg-white dark:text-neutral-900",
        className,
      )}
    >
      Pro
    </span>
  );
}

/** A window this wide keeps a usable editor beside a docked panel. */
const ROOMY_W = 1024;
export const roomToDock = (): boolean => window.innerWidth >= ROOMY_W;

/**
 * The first time a panel opens in this browser it joins a side that already
 * holds docked panels, as a tab in front. With no side in use it floats, so
 * the editor keeps its width, unless the panel has a `home`: then it docks
 * there, where the window has room. After that the panel is wherever the
 * person left it, and opening it brings its tab forward.
 */
function useFirstPlace(id: string, title: string, home?: DockSide): void {
  React.useEffect(() => {
    const side = panelDock.sideOf(id);
    if (side) {
      panelDock.activate(side, id);
      return;
    }
    const key = `${id}:placed`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return; // no storage: it floats
    }
    const to = (["right", "left"] as const).find((s) => panelDock.width(s) > 0) ?? (home && roomToDock() ? home : undefined);
    if (to) panelDock.dock(id, to, title);
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

/**
 * A floating panel of the editor shell with the usual chrome: drag by the
 * header, pin, dock to a side (where it shares the side as a tab), close.
 * `id` is its layout key (position, pin and dock are remembered under it).
 */
export function SidePanel({
  id,
  title,
  icon,
  badge,
  testId,
  home,
  beside = false,
  front = false,
  onFront,
  onClose,
  children,
}: {
  id: string;
  title: string;
  icon?: React.ReactNode;
  /** After the title: a version, a plan badge. */
  badge?: React.ReactNode;
  testId: string;
  /** The side it docks to the first time it opens, when no side is in use yet (without one: it floats). */
  home?: DockSide;
  /** Until the person moves it, the panel floats beside the spot the chat opens on, not on it. */
  beside?: boolean;
  /** Of two of these panels that overlap, this one is on top. */
  front?: boolean;
  /** The person pressed on the panel: it should be the one on top. */
  onFront?: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const drag = useDraggablePanel({ storageKey: id, handleWidth: PANEL_W, handleHeight: HEADER_H });
  useFirstPlace(id, title, home);
  const floating: React.CSSProperties = drag.pos
    ? { left: drag.pos.x, top: drag.pos.y }
    : { right: beside ? BESIDE_RIGHT : "calc(12px + var(--plugin-sidebar-offset, 0px))", top: 64 };
  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={title}
      data-testid={testId}
      data-overlay-obstacle=""
      data-snap-panel={drag.snapId}
      data-dock-title={title}
      className={cn(
        "absolute flex max-h-[80vh] w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl bg-white/95 text-neutral-900 shadow-2xl ring-1 ring-inset ring-black/10 backdrop-blur-sm dark:bg-neutral-950/90 dark:text-white dark:ring-white/15",
        front ? "z-[41]" : "z-40",
      )}
      style={drag.docked ?? floating}
      onPointerDownCapture={onFront}
    >
      <div
        className={cn(
          "flex h-10 shrink-0 select-none items-center gap-2 px-3 text-xs font-semibold",
          !drag.docked && "cursor-grab active:cursor-grabbing",
        )}
        style={{ touchAction: "none" }}
        onPointerDown={(e) => drag.onPointerDown(e, rootRef.current!.getBoundingClientRect())}
        onPointerMove={(e) => void drag.onPointerMove(e)}
        onPointerUp={() => void drag.onPointerUp()}
      >
        {icon}
        <span className="min-w-0 truncate">{title}</span>
        {badge}
        <span className="ml-auto flex gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
          <PanelDock id={drag.snapId} className="order-none" />
          <PanelPin id={drag.snapId} className="order-none" />
          <Tip content="Close">
            <Button
              type="button"
              variant="plain"
              size="icon-xs"
              aria-label={`Close ${title}`}
              data-testid={`${testId}-close`}
              className={cn("p-1", overlayIconClass)}
              onClick={onClose}
            >
              <X size={16} />
            </Button>
          </Tip>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}
