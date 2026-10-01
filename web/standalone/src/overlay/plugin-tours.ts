/**
 * The editor side of the plugin tour/pointer API (overlay-system 0003 phase
 * 3): what `PackageHostOptions.tours` and `.sheet` are made of.
 *
 * Rules (host-owned, a plugin cannot change them):
 *   - everything a plugin shows carries the plugin's manifest name;
 *   - one guide on screen at a time: a plugin tour or pointer is refused
 *     (`busy`) while another tour runs; a plugin's own tour replaces its
 *     pointer, and its pointer is refused while its tour runs;
 *   - `panel:` targets are host-internal (our own React UI);
 *   - when the plugin instance stops (panel closed, restart, disable,
 *     uninstall, revoke — its AbortSignal) its tour stops WITHOUT a status
 *     change (so `resume` works after an editor-switch navigation) and its
 *     pointer is cleared.
 */
import { overlay } from "./api";
import { resolveTarget } from "./targets/resolve";
import { roomCheckpoints, type CheckpointStore } from "./tours/checkpoints";
import { compileTour, parseSheetNets, parseSheetSymbols, parseTourDef, type TourDef, type TourDeps } from "./tours/declarative";
import { engineTourDeps } from "./tours/engine";
import { clearTourMemory, sessionTourMemory } from "./tours/memory";
import { readTourStatus, runningTours, startTour, type TourRunner, type TourStatus } from "./tours/runner";

export interface PluginPointer {
  target: string;
  title?: string;
  text: string;
  lostText?: string;
  placement?: "auto" | "top" | "bottom" | "left" | "right";
  spotlight?: boolean;
  pulse?: boolean;
}

export interface PluginTourAdapter {
  start(tour: unknown, resume: boolean): { status: "started" | "not-active" | "busy" };
  /** True while this plugin's tour runs (the sidebar keeps a hidden panel alive for it). */
  isRunning(): boolean;
  stop(): void;
  status(): { id: string | null; step: number; of: number; state: TourStatus | "none" };
  showPointer(step: PluginPointer): "shown" | "not-found";
  clearPointer(): void;
}

const hostOnlyTarget = (target: string | undefined) => !!target && target.startsWith("panel:");

export function pluginTourAdapter(opts: {
  /** Stable per installed plugin (the sidebar's pluginKey). */
  pluginKey: string;
  /** Manifest name — the host-drawn attribution. */
  pluginName: string;
  /** The editor this page runs ("eeschema" | "pcbnew"). */
  tool: () => string;
  signal: AbortSignal;
  deps?: TourDeps;
  /** Back's document checkpoints (default: the editor's active room). */
  checkpoints?: CheckpointStore;
  /** The plugin's tour started — the sidebar collapses the plugin's panel out of the way. */
  onTourStart?(): void;
  /** The plugin's tour stopped (done, dismissed, or stopped without a status). */
  onTourEnd?(status?: TourStatus): void;
}): PluginTourAdapter {
  const owner = `plugin:${opts.pluginKey}`;
  const storageId = (id: string) => `plugin:${opts.pluginKey}:${id}`;
  let runner: TourRunner | null = null;
  let def: TourDef | null = null;

  const otherTourRunning = () => runningTours().some((t) => t.owner !== owner);
  const ownTourRunning = () => runningTours().some((t) => t.owner === owner);

  const stopOwn = (status?: TourStatus) => {
    runner?.stop(status);
    runner = null;
  };

  opts.signal.addEventListener(
    "abort",
    () => {
      stopOwn();
      overlay.clear(owner);
    },
    { once: true },
  );

  return {
    start(input, resume) {
      opts.signal.throwIfAborted();
      const parsed = parseTourDef(input);
      if (parsed.editor !== opts.tool()) throw new Error(`This tour is for the ${parsed.editor} editor`);
      const bad = parsed.steps.find((s) => hostOnlyTarget(s.target));
      if (bad) throw new Error(`invalid tour: steps.${bad.id}.target: panel targets are not available to plugins`);
      if (resume && readTourStatus(storageId(parsed.id)) !== "active") return { status: "not-active" };
      if (otherTourRunning()) return { status: "busy" };
      overlay.clear(owner); // a pointer gives way to the plugin's own tour
      def = parsed;
      const id = storageId(parsed.id);
      // A fresh start forgets the last run's latches; a resume picks them up.
      if (!resume) clearTourMemory(id);
      const compiled = compileTour(parsed, opts.deps ?? engineTourDeps, {
        memory: sessionTourMemory(id),
        checkpoints: opts.checkpoints ?? roomCheckpoints,
      });
      runner = startTour(compiled, {
        owner,
        attribution: opts.pluginName,
        storageId: id,
        onStop: (status) => opts.onTourEnd?.(status),
      });
      opts.onTourStart?.();
      return { status: "started" };
    },

    stop() {
      stopOwn();
    },

    isRunning: ownTourRunning,

    status() {
      if (!def) return { id: null, step: 0, of: 0, state: "none" };
      const progress = ownTourRunning() ? runner?.progress() : null;
      return {
        id: def.id,
        step: progress?.step ?? 0,
        of: progress?.of ?? def.steps.length,
        state: readTourStatus(storageId(def.id)) ?? "none",
      };
    },

    showPointer(step) {
      opts.signal.throwIfAborted();
      if (hostOnlyTarget(step.target)) throw new Error("panel targets are not available to plugins");
      if (ownTourRunning()) throw new Error("Stop your tour before showing a pointer");
      if (otherTourRunning()) throw new Error("Another guide is showing");
      overlay.show({ ...step, owner, attribution: opts.pluginName });
      return resolveTarget(step.target) ? "shown" : "not-found";
    },

    clearPointer() {
      if (!ownTourRunning()) overlay.clear(owner);
    },
  };
}

/** `PackageHostOptions.sheet`: the shown schematic sheet, JSON-safe. */
export function pluginSheetAdapter(deps: TourDeps = engineTourDeps) {
  const guard = () => {
    if (deps.openBusy()) throw new Error("The document is still loading");
    if (deps.modalDialogOpen()) throw new Error("Close the open dialog first");
  };
  return {
    symbols(): unknown[] {
      guard();
      return parseSheetSymbols(deps.symbols()) ?? [];
    },
    connectivity(): unknown[] {
      guard();
      return parseSheetNets(deps.nets()) ?? [];
    },
  };
}
