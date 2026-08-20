import { clog } from "./debug";
import {
  hasPresenceBridge,
  parseSelectionEmit,
  type PresenceKicadModule,
  type PresenceKicadWindow,
} from "./presence-kicad";

/**
 * THIS tab's live canvas selection, as a tiny module-global store (the
 * pin-geometry pattern) — the shell's SelectionInspector renders from it
 * (viewer-panels).
 *
 * Fed from the C++ `window.kicadCollab.onSelection` emit through whichever
 * path owns that handler in the session:
 *
 *   - collab/edit sessions: bindKicadPresence's handler publishes here in
 *     addition to awareness (one extra call in presence-kicad.ts).
 *   - read-only viewers: presence never binds (no room, no awareness), so
 *     `bindLocalSelectionFeed` below installs a minimal handler and starts
 *     the C++ input hooks (kicadCollabPresenceStart) — the emitter is
 *     presence-agnostic and dedupes on its own.
 */

export interface LocalSelection {
  uuids: string[];
  fpPaths?: string[];
}

let current: LocalSelection = { uuids: [] };
const subs = new Set<() => void>();

export function publishLocalSelection(sel: LocalSelection): void {
  current = sel;
  for (const cb of subs) cb();
}

/** `useSyncExternalStore` pair. */
export function subscribeLocalSelection(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getLocalSelection(): LocalSelection {
  return current;
}

/**
 * Selection feed for sessions WITHOUT the presence bridge (read-only viewers):
 * installs the onSelection handler (spread-preserving, same etiquette as
 * bindKicadPresence) and starts the C++ canvas input hooks. The start call is
 * idempotent on the wasm side; under the JSPI scheduler it may return a
 * Promise (queued behind a live open) — fire-and-forget is fine, the seed
 * pull below covers a selection made before the hooks landed.
 */
export function bindLocalSelectionFeed(opts: {
  mod: unknown;
  win: PresenceKicadWindow;
}): { destroy(): void } | null {
  const { win } = opts;

  if (!hasPresenceBridge(opts.mod)) return null;
  const mod = opts.mod as PresenceKicadModule;

  win.kicadCollab = {
    ...win.kicadCollab,
    onSelection: (uuidsJson) => {
      const parsed = parseSelectionEmit(uuidsJson);
      if (parsed) publishLocalSelection(parsed);
    },
  };

  try {
    void mod.kicadCollabPresenceStart();
  } catch (err) {
    clog("local-selection: presence start failed:", err);
  }

  const pull = () => {
    try {
      const parsed = parseSelectionEmit(
        (mod.kicadCollabGetSelectionFull?.() ?? mod.kicadCollabGetSelection()) || "[]",
      );
      if (parsed && JSON.stringify(parsed) !== JSON.stringify(current)) {
        publishLocalSelection(parsed);
      }
    } catch {
      /* frame not up yet / busy — a later gesture re-pulls */
    }
  };

  // Seed: a selection may already exist (rebind), and the C++ emitter only
  // fires on change.
  pull();

  // The C++ emitter hangs off the CANVAS input hooks — a selection resolved
  // through a DOM surface (the clarify popup's rows) produces no canvas
  // event and would never reach the store. Cover it with a bounded pull
  // burst after any pointer/key gesture (no timers while idle; the reads
  // dedupe, so a no-change burst publishes nothing).
  const pullSoon = () => {
    setTimeout(pull, 0);
    setTimeout(pull, 200);
    setTimeout(pull, 600);
  };
  document.addEventListener("pointerup", pullSoon, true);
  document.addEventListener("keyup", pullSoon, true);

  clog("local-selection: feed bound (viewer mode)");

  return {
    destroy() {
      document.removeEventListener("pointerup", pullSoon, true);
      document.removeEventListener("keyup", pullSoon, true);
      if (win.kicadCollab) delete win.kicadCollab.onSelection;
      publishLocalSelection({ uuids: [] });
    },
  };
}
