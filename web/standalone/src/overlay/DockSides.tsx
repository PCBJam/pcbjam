import * as React from "react";
import { Button, cn } from "@pcbjam/ui";
import { DOCK_TABS_H, panelDock, usePanelDock, type DockSide } from "./panel-dock";

/**
 * The docked sides' own chrome (overlay-system 0008): the backdrop under the docked panels,
 * the tab strip when two or more share a side, and the inner edge that resizes the side. The
 * panels place themselves (useDockedStyle).
 */
export function DockSides() {
  usePanelDock();
  return (
    <>
      {(["left", "right"] as const).map((side) => (panelDock.width(side) > 0 ? <Side key={side} side={side} /> : null))}
    </>
  );
}

function Side({ side }: { side: DockSide }) {
  const width = panelDock.width(side);
  const { ids, active, titles } = panelDock.tabs(side);
  const drag = React.useRef<{ x: number; width: number } | null>(null);
  const edge: React.CSSProperties = side === "left" ? { left: width - 3 } : { right: width - 3 };
  return (
    <>
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 z-30 bg-white dark:bg-neutral-950",
          side === "left" ? "left-0 border-r" : "right-0 border-l",
          "border-black/10 dark:border-white/15",
        )}
        style={{ width }}
      />
      {ids.length > 1 && (
        <div
          role="tablist"
          aria-label={`Panels docked ${side}`}
          data-testid={`dock-tabs-${side}`}
          className="absolute top-0 z-40 flex items-end gap-0.5 overflow-x-auto border-b border-black/10 bg-neutral-100 px-1 dark:border-white/15 dark:bg-neutral-900"
          style={{ [side]: 0, width, height: DOCK_TABS_H }}
        >
          {ids.map((id) => (
            <Button
              key={id}
              type="button"
              variant="plain"
              size="xs"
              role="tab"
              aria-selected={id === active}
              data-testid="dock-tab"
              className={cn(
                "h-7 max-w-40 shrink-0 truncate rounded-t-md px-3 text-xs",
                id === active
                  ? "bg-white font-semibold text-neutral-900 dark:bg-neutral-950 dark:text-white"
                  : "text-neutral-500 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10",
              )}
              onClick={() => panelDock.activate(side, id)}
            >
              {titles[id] ?? "Panel"}
            </Button>
          ))}
        </div>
      )}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize the ${side} side`}
        aria-valuenow={width}
        tabIndex={0}
        data-testid={`dock-edge-${side}`}
        className="absolute inset-y-0 z-[41] w-1.5 cursor-col-resize hover:bg-sky-500/40 focus-visible:bg-sky-500/60 focus-visible:outline-none"
        style={{ ...edge, touchAction: "none" }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, width };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          panelDock.setWidth(side, d.width + (side === "left" ? dx : -dx));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const step = (e.shiftKey ? 50 : 10) * (e.key === "ArrowRight" ? 1 : -1);
          panelDock.setWidth(side, width + (side === "left" ? step : -step));
        }}
      />
    </>
  );
}

/**
 * The room the docked sides take, for the editor's box; and, whenever it changes, a window
 * 'resize' so wx sizes its main window to the box again (wx.js's __wxViewportSize).
 */
export function useDockedRoom(): { left: number; right: number } {
  usePanelDock();
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const left = panelDock.width("left");
  const right = panelDock.width("right");
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      if (!left && !right) return;
    }
    // After this render has resized the box; one per frame while a side is dragged.
    const raf = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(raf);
  }, [left, right]);
  return { left, right };
}
