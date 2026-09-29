/**
 * The live editor as a `TourDeps` (overlay-system 0003): engine reads through
 * the pure bindings (`kicadSheetSymbols`, `kicadSheetNets` — never
 * `kicadCollabSnapshotItems`, which rebaselines the collab differ) and the
 * open-dialog tracking from the engine's editor events.
 */
import { anyDialogOpen, openDialog } from "../editor-events";
import type { TourDeps } from "./declarative";

type TourModule = {
  kicadSheetSymbols?: () => unknown;
  kicadSheetNets?: () => unknown;
  kicadOpenFileBusy?: () => unknown;
};

const mod = () => (globalThis as { Module?: TourModule }).Module;

export const engineTourDeps: TourDeps = {
  symbols: () => mod()?.kicadSheetSymbols?.(),
  nets: () => mod()?.kicadSheetNets?.(),
  openBusy: () => !mod() || mod()!.kicadOpenFileBusy?.() === true,
  dialogOpen: (cls) => !!openDialog(cls),
  anyDialogOpen,
};
