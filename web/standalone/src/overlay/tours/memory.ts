/**
 * What a declarative tour remembers across a reload, an editor switch or a closed tab (tutorial
 * round 2): the steps that latched on an event — a Next press, "the chooser opened", "ERC ran" —
 * and the symbols that were on the sheet when the tour started (the `new:` baseline). Without it
 * every event-only step comes back on the next page, and symbols placed before it stop counting
 * as new. Kept with the tour's status in the browser (tour-store.ts), so it lives exactly as long
 * as the tour can resume.
 */
import { readTourEntry, updateTourEntry } from "./tour-store";

export interface TourMemory {
  /** Step ids latched done by an event. */
  latched: string[];
  /** Symbol uuids on the sheet when the tour started; null before the first read. */
  baseline: string[] | null;
}

export interface TourMemoryStore {
  load(): TourMemory | null;
  save(memory: TourMemory): void;
}

/** A baseline this large is not worth a stored copy (the tour just re-reads it). */
const BASELINE_MAX = 1000;

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export function storedTourMemory(storageId: string): TourMemoryStore {
  return {
    load() {
      const v = readTourEntry(storageId)?.memory as Record<string, unknown> | undefined;
      if (!v || typeof v !== "object" || !isIdList(v.latched)) return null;
      return { latched: v.latched, baseline: isIdList(v.baseline) ? v.baseline : null };
    },
    save(memory) {
      const baseline = memory.baseline && memory.baseline.length <= BASELINE_MAX ? memory.baseline : null;
      updateTourEntry(storageId, { memory: { latched: memory.latched, baseline } });
    },
  };
}

/** Forget a tour's memory (a fresh start, not a resume). */
export function clearTourMemory(storageId: string): void {
  updateTourEntry(storageId, { memory: null });
}
