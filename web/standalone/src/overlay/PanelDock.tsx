import { PanelLeft, PanelRight, PictureInPicture2 } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tip, cn } from "@pcbjam/ui";
import { overlayIconClass } from "@/components/OverlayMenu";
import { panelDock, usePanelDock, type DockSide } from "./panel-dock";

/** The name a docked panel's tab shows: `data-dock-title`, else its label. */
function titleOf(id: string): string {
  const el = document.querySelector(`[data-snap-panel="${CSS.escape(id)}"]`);
  return el?.getAttribute("data-dock-title") ?? el?.getAttribute("aria-label") ?? "Panel";
}

/**
 * A floating panel's dock menu (overlay-system 0008), beside its pin: dock the panel to the
 * window's left or right side, where the editor makes room for it (panels on the same side
 * share it as tabs), or float it again.
 */
export function PanelDock({ id, className }: { id: string; className?: string }) {
  usePanelDock();
  const side = panelDock.sideOf(id);
  const dock = (to: DockSide) => panelDock.dock(id, to, titleOf(id));
  const item = "flex items-center gap-2 text-xs";
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Tip content={side ? "Docked: move it, or float it again" : "Dock to a side: the editor makes room for it"}>
          <Button
            type="button"
            variant="plain"
            size="icon-xs"
            data-testid="panel-dock"
            aria-label={side ? `Docked ${side}` : "Dock panel"}
            className={cn("order-last p-1", overlayIconClass, !side && "opacity-50 hover:opacity-100", className)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {side === "left" ? <PanelLeft size={13} /> : <PanelRight size={13} />}
          </Button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[60]">
        {side !== "left" && (
          <DropdownMenuItem data-testid="panel-dock-left" className={item} onSelect={() => dock("left")}>
            <PanelLeft size={14} /> Dock left
          </DropdownMenuItem>
        )}
        {side !== "right" && (
          <DropdownMenuItem data-testid="panel-dock-right" className={item} onSelect={() => dock("right")}>
            <PanelRight size={14} /> Dock right
          </DropdownMenuItem>
        )}
        {side && (
          <DropdownMenuItem data-testid="panel-float" className={item} onSelect={() => panelDock.undock(id)}>
            <PictureInPicture2 size={14} /> Float
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
