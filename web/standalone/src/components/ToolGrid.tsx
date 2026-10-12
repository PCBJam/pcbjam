import { TOOL_LABELS, TOOLS, type Tool } from "@pcbjam/shared";
import {
  Calculator,
  CircuitBoard,
  Component,
  Cpu,
  Layers,
  LayoutTemplate,
  type LucideIcon,
  Workflow,
} from "lucide-react";
import { Button } from "@pcbjam/ui";

/** Icon per tool — KiCad-launcher style. */
const TOOL_ICONS: Record<Tool, LucideIcon> = {
  eeschema: Workflow,
  symbol_editor: Component,
  pcbnew: CircuitBoard,
  footprint_editor: Cpu,
  gerbview: Layers,
  calculator: Calculator,
  pl_editor: LayoutTemplate,
};

/**
 * Display order for the launcher, matching KiCad's standalone project-manager
 * list (Image Converter + Plugin Manager are KiCad tools we don't ship). Any
 * tool in TOOLS but missing here is appended, so adding a tool can't drop it.
 */
const TOOL_ORDER: Tool[] = [
  "eeschema", // Schematic Editor
  "symbol_editor", // Symbol Editor
  "pcbnew", // PCB Editor
  "footprint_editor", // Footprint Editor
  "gerbview", // Gerber Viewer
  "calculator", // PCB Calculator
  "pl_editor", // Drawing Sheet Editor
];

function orderedTools(): Tool[] {
  const known = TOOL_ORDER.filter((t) => TOOLS.includes(t));
  const rest = TOOLS.filter((t) => !known.includes(t));
  return [...known, ...rest];
}

/**
 * KiCad-style tool launcher: a grid of icon+text cards, one per tool. Clicking a
 * card launches that tool in-place with no project — the file-less editors browse
 * backend libraries; the document editors (schematic/PCB/drawing sheet) boot to a
 * blank document, the same as opening them from KiCad's project manager.
 */
export function ToolGrid({ onLaunch }: { onLaunch: (tool: Tool) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {orderedTools().map((tool) => {
        const Icon = TOOL_ICONS[tool] ?? Component;
        return (
          <Button
            key={tool}
            type="button"
            onClick={() => onLaunch(tool)}
            variant="outline"
            size="row"
            className="h-auto flex-col items-center justify-center gap-2 rounded-lg p-4 text-center"
          >
            <Icon size={28} className="text-muted-foreground" />
            <span className="text-sm font-medium">{TOOL_LABELS[tool]}</span>
          </Button>
        );
      })}
    </div>
  );
}
