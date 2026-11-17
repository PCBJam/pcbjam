import { usePanelLayout } from "./panel-layout";

/** The lines a dragged floating panel snaps to (overlay-system 0007), while the drag lasts. */
export function SnapGuides() {
  const { guides } = usePanelLayout();
  if (!guides.length) return null;
  return (
    <div aria-hidden="true" data-testid="snap-guides" className="pointer-events-none fixed inset-0 z-[60]">
      {guides.map((g, i) => (
        <div
          key={i}
          className="absolute bg-orange-500 dark:bg-orange-400"
          style={
            g.axis === "x"
              ? { left: g.at, top: g.from, width: 1, height: g.to - g.from }
              : { top: g.at, left: g.from, height: 1, width: g.to - g.from }
          }
        />
      ))}
    </div>
  );
}
