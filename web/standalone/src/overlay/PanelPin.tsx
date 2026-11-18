import { Pin, PinOff } from "lucide-react";
import { Button, Tip, cn } from "@pcbjam/ui";
import { overlayIconClass } from "@/components/OverlayMenu";
import { panelLayout, usePanelLayout } from "./panel-layout";
import { panelDock, usePanelDock } from "./panel-dock";

/**
 * A floating panel's pin (overlay-system 0007): a pinned panel doesn't move or resize, Arrange
 * leaves it where it is, and the others still snap to it. It sits last in the panel's header
 * (`order-last`), whatever the header holds. A docked panel has none: its side holds it.
 */
export function PanelPin({ id, className }: { id: string; className?: string }) {
  const { pinned } = usePanelLayout();
  usePanelDock();
  const on = pinned.has(id);
  if (panelDock.sideOf(id)) return null;
  return (
    <Tip content={on ? "Pinned: it stays where it is. Click to unpin." : "Pin: keep this panel where it is"}>
      <Button
        type="button"
        variant="plain"
        size="icon-xs"
        data-testid="panel-pin"
        aria-label={on ? "Unpin panel" : "Pin panel"}
        aria-pressed={on}
        className={cn("order-last p-1", overlayIconClass, !on && "opacity-50 hover:opacity-100", className)}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => panelLayout.togglePin(id)}
      >
        {on ? <Pin size={13} /> : <PinOff size={13} />}
      </Button>
    </Tip>
  );
}
