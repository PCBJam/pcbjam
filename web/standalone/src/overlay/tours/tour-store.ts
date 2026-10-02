/**
 * Where tours keep their status and memory (tutorial round 2): the browser's localStorage, so a
 * tour outlives the tab. A reload, the page navigation an editor switch does, and closing the tab
 * and coming back to the project later all land on the same step. One key holds the most
 * recently used tours within a size budget; the oldest are forgotten first (a forgotten tour just
 * starts over).
 */
import type { TourMemory } from "./memory";
import type { TourStatus } from "./runner";

const KEY = "pcbjam:tours";
/** Tours remembered at most… */
export const TOURS_KEPT = 40;
/** …in at most this many characters of JSON. */
export const TOURS_CHARS_MAX = 256 * 1024;

export interface TourEntry {
  status?: TourStatus;
  memory?: TourMemory;
  /** Last write (ms since epoch): the least recently used entries go first. */
  at: number;
}

type Store = Pick<Storage, "getItem" | "setItem">;

function store(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // blocked storage: tours still run, they just forget on reload
  }
}

function readAll(s: Store): Record<string, TourEntry> {
  try {
    const v = JSON.parse(s.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, TourEntry>) : {};
  } catch {
    return {};
  }
}

export function readTourEntry(id: string): TourEntry | null {
  const s = store();
  const entry = s ? readAll(s)[id] : undefined;
  return entry && typeof entry === "object" ? entry : null;
}

/** Merge `patch` into a tour's entry (`memory: null` forgets the memory); keeps the store in budget. */
export function updateTourEntry(id: string, patch: { status?: TourStatus; memory?: TourMemory | null }): void {
  const s = store();
  if (!s) return;
  const all = readAll(s);
  const entry: TourEntry = { ...all[id], at: Date.now() };
  if (patch.status) entry.status = patch.status;
  if (patch.memory === null) delete entry.memory;
  else if (patch.memory) entry.memory = patch.memory;
  all[id] = entry;
  // The others, newest first: the oldest go when there are too many or they take too much room.
  const others = Object.keys(all)
    .filter((k) => k !== id)
    .sort((a, b) => (Number(all[b]?.at) || 0) - (Number(all[a]?.at) || 0));
  for (const old of others.splice(TOURS_KEPT - 1)) delete all[old];
  let json = JSON.stringify(all);
  while (json.length > TOURS_CHARS_MAX && others.length) {
    delete all[others.pop()!];
    json = JSON.stringify(all);
  }
  try {
    s.setItem(KEY, json);
  } catch {
    /* quota or blocked storage: the tour still runs, it just forgets on reload */
  }
}
