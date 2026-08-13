// Wire contract shared with the C++ bridge (wasm/bindings/*_embind.cpp).
//
// The data shapes (CollabItem / CollabDelta) and their zod schemas now live in
// MIT `@pcbjam/shared` (collab-wire.ts, ysync 0008) so any consumer — this GPL
// editor, tests, a backend — can validate the wasm from-to JSON against one
// source of truth. This module re-exports them under the established local names
// and keeps the RUNTIME adapter interface (CollabBridge), which is about how this
// app talks to a live wasm Module, not about the data.

import {
  emptyCollabDelta,
  isEmptyCollabDelta,
  type CollabDelta,
  type CollabItem,
} from "@pcbjam/shared";

export { collabDeltaSchema, collabItemSchema, parseCollabDelta } from "@pcbjam/shared";
export type { CollabDelta, CollabItem };

/**
 * The two C++ bridge entry points + the emit hook, abstracted so the reconciler is
 * testable without a real wasm Module. In the browser these map to:
 *   snapshot() -> Module.kicadCollabSnapshot()
 *   apply(d)   -> Module.kicadCollabApply(d)
 *   onDelta(cb): set window.kicadCollab = { onDelta: cb }
 */
export interface CollabBridge {
  snapshot(isCurrent?: () => boolean): string | Promise<string>;
  apply(deltaJson: string, isCurrent?: () => boolean): void | Promise<void>;
  onDelta(cb: (deltaJson: string) => void): void;
}

export const emptyDelta = emptyCollabDelta;
export const isEmptyDelta = isEmptyCollabDelta;
