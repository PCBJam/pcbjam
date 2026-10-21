import { WasmMailbox } from "../mailbox";
import { libIndexEnabled } from "./source";

/**
 * Start the background library-index warm-up (libs 0028 section 8.3): the wasm
 * side then pulls every symbol library's index rows into its plugins, one short
 * timer step at a time, so Add Symbol finds them in memory. The export only arms
 * a wx timer; the mailbox holds the call while an open is in flight.
 *
 * `?libwarm=0` turns off just the warm-up (Add Symbol still uses the index,
 * fetched on the click); `?libindex=0` turns off the index altogether.
 */
export function libWarmEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return new URLSearchParams(window.location.search).get("libwarm") !== "0" && libIndexEnabled();
}

interface WarmupModule {
  kicadOpenFileBusy?: () => boolean;
  kicadLibIndexWarmup?: (kind: string) => unknown;
}

export function startLibIndexWarmup(mod: unknown, log: (msg: string) => void): Promise<void> {
  const m = mod as WarmupModule | undefined;
  if (!libWarmEnabled() || typeof m?.kicadLibIndexWarmup !== "function") return Promise.resolve();
  return new WasmMailbox(m)
    .enqueue("kicadLibIndexWarmup", () => m.kicadLibIndexWarmup!("symbol"))
    .then(
      () => log("[libindex] warm-up started"),
      (e) => log(`[libindex] warm-up not started: ${String(e)}`),
    );
}
