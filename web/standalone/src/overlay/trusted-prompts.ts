import * as React from "react";

/**
 * Trusted prompts (plugin consent/file/download/placement, blocking dialogs,
 * Radix dialogs, download consent) and blocking covers (the library-loading
 * overlay over a frozen editor) register here while open; the overlay
 * hides while any is up and resumes afterwards (overlay-system 0002 D5).
 * Hiding rather than z-ordering also covers prompts that live inside z-40
 * panels below the overlay.
 */

let count = 0;
const subs = new Set<() => void>();

function set(next: number): void {
  count = Math.max(0, next);
  for (const cb of subs) cb();
}

/** Returns the release function; call it exactly once. */
export function openTrustedPrompt(): () => void {
  set(count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    set(count - 1);
  };
}

export function trustedPromptCount(): number {
  return count;
}

export function subscribeTrustedPrompts(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** Hold a trusted-prompt registration while `active`. */
export function useTrustedPrompt(active: boolean): void {
  React.useEffect(() => (active ? openTrustedPrompt() : undefined), [active]);
}

export function useTrustedPromptOpen(): boolean {
  return React.useSyncExternalStore(subscribeTrustedPrompts, () => count > 0);
}
