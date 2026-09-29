/**
 * The built-in demo tour (overlay-system 0002 M4), written as a declarative
 * tour definition (0003 phase 2) — the same form a plugin hands the host.
 * Place a Device:R in the schematic editor.
 */
import { compileTour, parseTourDef, type TourDeps, type TourDef } from "./declarative";
import { engineTourDeps } from "./engine";

const CHOOSER = "DIALOG_SYMBOL_CHOOSER";
const NEW_R = { symbols: { libId: "Device:R", min: 1, new: true } } as const;

export const ADD_RESISTOR: TourDef = parseTourDef({
  id: "add-resistor",
  title: "PCBJam guide",
  editor: "eeschema",
  steps: [
    {
      id: "tool",
      target: "tool:eeschema.InteractiveDrawing.placeSymbol",
      title: "Add a symbol",
      text: "Click Place Symbols (or press A), then click on the sheet to open the symbol chooser.",
      lostText: "The Place Symbols button is on the right-hand toolbar.",
      spotlight: true,
      pulse: true,
      until: { any: [{ dialogOpened: CHOOSER }, NEW_R] },
    },
    {
      id: "search",
      when: { dialogOpen: CHOOSER },
      target: `dialog:${CHOOSER}/control:searchctrl`,
      title: "Find the resistor",
      text: "Type R, choose R from the Device library, then press OK.",
      // Right of the field, over the preview: below it would cover the results.
      placement: "right",
      pulse: true,
      until: NEW_R,
    },
    {
      id: "place",
      title: "Place it",
      text: "Click on the sheet to drop the resistor. Nothing on the cursor? Click Place Symbols again.",
      until: NEW_R,
    },
    {
      id: "done",
      target: "new:Device:R",
      title: "That's your first resistor",
      text: "Symbols are the parts of your schematic. Next you would wire it up — press Esc to stop placing, then Next to finish.",
      until: { next: true },
    },
  ],
});

export function addResistorTour(deps: TourDeps = engineTourDeps) {
  return compileTour(ADD_RESISTOR, deps);
}
