/**
 * The internal demo tour (overlay-system 0002 M4): place a Device:R in the
 * schematic editor. The reference consumer for the plugin API (0003) — every
 * step is either a target + text, or a state check.
 */
import { openDialog, type EditorEvent } from "../editor-events";
import type { Tour } from "./runner";

const CHOOSER = "DIALOG_SYMBOL_CHOOSER";
const PLACE_SYMBOL = "eeschema.InteractiveDrawing.placeSymbol";

export interface AddResistorState {
  chooserOpen: boolean;
  /** The chooser was closed at least once (a part may be on the cursor). */
  afterChooser: boolean;
  /** UUID of a Device:R placed since the tour started (on the current sheet). */
  resistor: string | null;
}

/**
 * UUIDs of the placed symbols with `libId`, from `Module.kicadSheetSymbols()`
 * (`[{uuid, libId}]` for the current sheet — a pure engine read).
 */
export function placedSymbolUuids(sheetSymbolsJson: string, libId: string): string[] {
  let rows: unknown;
  try {
    rows = JSON.parse(sheetSymbolsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is { uuid: string; libId: string } => typeof r?.uuid === "string" && r.libId === libId)
    .map((r) => r.uuid.toLowerCase());
}

type SymbolsModule = { kicadSheetSymbols?: () => unknown; kicadOpenFileBusy?: () => unknown };

/** The current sheet's symbols, or undefined while a file open is in flight
 *  (the sheet is still empty then, which would poison the baseline). */
function engineSymbols(): unknown {
  const mod = (window as { Module?: SymbolsModule }).Module;
  if (!mod || mod.kicadOpenFileBusy?.() === true) return undefined;
  return mod.kicadSheetSymbols?.();
}

export function addResistorTour(snapshot: () => unknown = engineSymbols): Tour<AddResistorState> {
  let afterChooser = false;
  // Resistors already on the sheet when the tour started don't count.
  let existing: Set<string> | null = null;
  // Sticky: an in-flight open answers an empty snapshot, which must not
  // un-finish the tour for a tick.
  let resistor: string | null = null;

  return {
    id: "add-resistor",
    editor: "eeschema",
    title: "PCBJam guide",
    sample(events: EditorEvent[]) {
      for (const e of events) {
        if (e.type === "dialogClosed" && e.cls === CHOOSER) afterChooser = true;
        if (e.type === "action" && e.name === PLACE_SYMBOL && !openDialog(CHOOSER)) afterChooser = false;
      }
      const chooserOpen = !!openDialog(CHOOSER);
      // No engine reads while the chooser's modal loop is running.
      if (!resistor && !chooserOpen) {
        const raw = snapshot();
        if (typeof raw === "string") {
          const uuids = placedSymbolUuids(raw, "Device:R");
          if (!existing) existing = new Set(uuids);
          else resistor = uuids.find((u) => !existing!.has(u)) ?? null;
        }
      }
      return { chooserOpen, afterChooser, resistor };
    },
    steps: [
      {
        id: "done",
        position: 4,
        final: true,
        when: (s) => !!s.resistor,
        content: (s) => ({
          target: `item:${s.resistor}`,
          title: "That's your first resistor",
          text: "Symbols are the parts of your schematic. Next you would wire it up — press Esc to stop placing, then Next to finish.",
        }),
      },
      {
        id: "search",
        position: 2,
        when: (s) => s.chooserOpen,
        content: () => ({
          target: `dialog:${CHOOSER}/control:searchctrl`,
          title: "Find the resistor",
          text: "Type R, choose R from the Device library, then press OK.",
          // Right of the field, over the preview: below it would cover the results.
          placement: "right",
          pulse: true,
        }),
      },
      {
        id: "place",
        position: 3,
        when: (s) => s.afterChooser,
        content: () => ({
          title: "Place it",
          text: "Click on the sheet to drop the resistor. Nothing on the cursor? Click Place Symbols again.",
        }),
      },
      {
        id: "tool",
        position: 1,
        when: () => true,
        content: () => ({
          target: `tool:${PLACE_SYMBOL}`,
          title: "Add a symbol",
          text: "Click Place Symbols (or press A), then click on the sheet to open the symbol chooser.",
          lostText: "The Place Symbols button is on the right-hand toolbar.",
          spotlight: true,
          pulse: true,
        }),
      },
    ],
  };
}
