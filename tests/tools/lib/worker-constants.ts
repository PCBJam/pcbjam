import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Parse `const NAME = <numeric expr>;` constants out of a JS/TS source — the
 * ONE source of truth for the ngspice transport numbers. The reducer and the
 * parity tripwire derive their expectations from here instead of hardcoding
 * copies that silently go stale when the protocol numbers move.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");

export function readRepoFile(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

export function parseConstants(
  source: string,
  names: readonly string[],
  label: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of names) {
    const m = source.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
    if (!m) throw new Error(`${label}: constant ${name} not found`);
    const expr = m[1]!.trim();
    // Strictly digits/arithmetic/underscores — anything else is rejected, so
    // the Function() evaluation below can only compute a number, never run
    // code from the scanned source.
    if (!/^[\d\s*+\-()_]+$/.test(expr)) {
      throw new Error(`${label}: constant ${name} is not a numeric expression: ${expr}`);
    }
    out[name] = Function(`"use strict"; return (${expr});`)() as number;
  }
  return out;
}

export const NGSPICE_WORKER_REL = "web/standalone/src/wasm/ngspice-worker.js";

export const NGSPICE_WORKER_CONSTANTS = [
  "MAX_EVENT_BATCH_LINES",
  "MAX_EVENT_BATCH_UTF8_BYTES",
  "MAX_EVENT_UNACKED_FRAMES",
  "MAX_EVENT_UNACKED_UTF8_BYTES",
  "MAX_DEFERRED_EVENTS",
  "MAX_DEFERRED_UTF8_BYTES",
] as const;

/** The production worker's transport constants, parsed from its source. */
export function ngspiceWorkerConstants(): Record<string, number> {
  return parseConstants(
    readRepoFile(NGSPICE_WORKER_REL),
    NGSPICE_WORKER_CONSTANTS,
    NGSPICE_WORKER_REL,
  );
}
