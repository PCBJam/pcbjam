/**
 * What a declarative tour remembers across a reload or an editor switch
 * (tutorial round 2): the steps that latched on an event — a Next press,
 * "the chooser opened", "ERC ran" — and the symbols that were on the sheet
 * when the tour started (the `new:` baseline). Without it every event-only
 * step comes back after a reload, and symbols placed before it stop counting
 * as new. Kept in sessionStorage next to the tour's status (runner.ts), so it
 * lives exactly as long as the tour can resume.
 */

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

/** A baseline this large is not worth a sessionStorage write (the tour just re-reads it). */
const BASELINE_MAX = 5000;

const memoryKey = (storageId: string) => `pcbjam:tour-memory:${storageId}`;

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export function sessionTourMemory(storageId: string): TourMemoryStore {
  return {
    load() {
      try {
        const raw = sessionStorage.getItem(memoryKey(storageId));
        if (!raw) return null;
        const v = JSON.parse(raw) as Record<string, unknown>;
        if (!isIdList(v.latched)) return null;
        return { latched: v.latched, baseline: isIdList(v.baseline) ? v.baseline : null };
      } catch {
        return null;
      }
    },
    save(memory) {
      try {
        const baseline = memory.baseline && memory.baseline.length <= BASELINE_MAX ? memory.baseline : null;
        sessionStorage.setItem(memoryKey(storageId), JSON.stringify({ latched: memory.latched, baseline }));
      } catch {
        /* private mode or full storage — the tour still runs, it just forgets on reload */
      }
    },
  };
}

/** Forget a tour's memory (a fresh start, not a resume). */
export function clearTourMemory(storageId: string): void {
  try {
    sessionStorage.removeItem(memoryKey(storageId));
  } catch {
    /* nothing stored */
  }
}
