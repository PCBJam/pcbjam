/**
 * Going back a step in a tour also takes the work back (tutorial round 2).
 *
 * A checkpoint is the active room's document as it was when a step first
 * showed (`yToDoc`). Back writes it over the room with `upsertDocToY`: a
 * forward edit that touches only what differs. The editor applies it the way
 * it applies a collaborator's change (the binding skips only its own writes,
 * kicad-binding.ts), peers receive it, and no file is rewritten behind the
 * room's back. It is not on KiCad's undo stack.
 *
 * The editor registers the active room's document (WasmTool: the eeschema
 * sheet room, the pcbnew board room). A checkpoint only goes back into the
 * room it came from: after a sheet switch, older checkpoints are dead.
 */
import type * as Y from "yjs";
import { upsertDocToY, yToDoc, type KicadDoc } from "@pcbjam/shared";

/** Transaction origin of a Back restore (not the binding's own, so the editor applies it). */
export const TOUR_BACK_ORIGIN = "tour-back";

export interface Checkpoint {
  readonly doc: Y.Doc;
  readonly snapshot: KicadDoc;
}

export interface CheckpointStore {
  capture(): Checkpoint | null;
  /** False when the checkpoint's room is no longer the active one. */
  restore(checkpoint: Checkpoint): boolean;
}

let active: Y.Doc | null = null;

/** The editor's active room document (null while none is bound). */
export function setTourDoc(doc: Y.Doc | null): void {
  active = doc;
}

export const roomCheckpoints: CheckpointStore = {
  capture() {
    if (!active) return null;
    try {
      return { doc: active, snapshot: yToDoc(active) };
    } catch (err) {
      // A room that has not seeded yet has no document to keep.
      console.warn("[tour] checkpoint skipped:", err);
      return null;
    }
  },
  restore(checkpoint) {
    if (checkpoint.doc !== active) return false;
    upsertDocToY(checkpoint.snapshot, checkpoint.doc, TOUR_BACK_ORIGIN);
    return true;
  },
};
