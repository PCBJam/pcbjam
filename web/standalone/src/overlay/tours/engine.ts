/**
 * The live editor as a `TourDeps` (overlay-system 0003): engine reads through
 * the pure bindings (`kicadSheetSymbols`, `kicadSheetNets`, `kicadBoardStatus` — never
 * `kicadCollabSnapshotItems`, which rebaselines the collab differ) and the
 * open-dialog tracking from the engine's editor events.
 */
import { anyDialogOpen, anyModalDialogOpen, openDialog } from "../editor-events";
import type { TourDeps } from "./declarative";

type TourModule = {
  kicadSheetSymbols?: () => unknown;
  kicadSheetNets?: () => unknown;
  kicadBoardStatus?: () => unknown;
  kicadOpenFileBusy?: () => unknown;
};

const mod = () => (globalThis as { Module?: TourModule }).Module;

export const engineTourDeps: TourDeps = {
  symbols: () => mod()?.kicadSheetSymbols?.(),
  nets: () => mod()?.kicadSheetNets?.(),
  board: () => mod()?.kicadBoardStatus?.(),
  openBusy: () => !mod() || mod()!.kicadOpenFileBusy?.() === true,
  dialogOpen: (cls) => !!openDialog(cls),
  anyDialogOpen,
  modalDialogOpen: anyModalDialogOpen,
};
