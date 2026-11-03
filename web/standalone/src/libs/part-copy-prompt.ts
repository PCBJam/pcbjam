import { useSyncExternalStore } from "react";
import type { SaveModalRequest } from "./part-copy";

/**
 * libs 0031: the save modal's question, asked from KiCad's save gate (outside
 * React) and answered by PartCopySaveDialog. One question at a time: a new one
 * cancels the one before (KiCad saves one thing at a time anyway).
 */
export interface PendingPartCopySave {
  request: SaveModalRequest;
  answer(save: boolean): void;
}

let pending: PendingPartCopySave | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function askPartCopySave(request: SaveModalRequest): Promise<boolean> {
  pending?.answer(false);
  return new Promise((resolve) => {
    const entry: PendingPartCopySave = {
      request,
      answer(save) {
        if (pending !== entry) return;
        pending = null;
        emit();
        resolve(save);
      },
    };
    pending = entry;
    emit();
  });
}

export function usePendingPartCopySave(): PendingPartCopySave | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
    () => null,
  );
}
