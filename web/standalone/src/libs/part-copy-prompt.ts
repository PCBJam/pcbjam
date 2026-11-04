import { useSyncExternalStore } from "react";
import type { CopyDestination, CopyDestinationRequest, SaveModalRequest } from "./part-copy";

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

/** pricing 0006 T3b: the library browser's "Copy to..." question, answered by PartCopyDestinationDialog. */
export interface PendingPartCopyDestination {
  request: CopyDestinationRequest;
  answer(destination: CopyDestination | null): void;
}

let pendingDestination: PendingPartCopyDestination | null = null;

export function askPartCopyDestination(request: CopyDestinationRequest): Promise<CopyDestination | null> {
  pendingDestination?.answer(null);
  return new Promise((resolve) => {
    const entry: PendingPartCopyDestination = {
      request,
      answer(destination) {
        if (pendingDestination !== entry) return;
        pendingDestination = null;
        emit();
        resolve(destination);
      },
    };
    pendingDestination = entry;
    emit();
  });
}

export function usePendingPartCopyDestination(): PendingPartCopyDestination | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pendingDestination,
    () => null,
  );
}
