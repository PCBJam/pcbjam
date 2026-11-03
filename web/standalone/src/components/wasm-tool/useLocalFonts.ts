import * as React from "react";
import type { LocalFontsState } from "@/wasm/local-fonts";

export interface LocalFontsMenuState {
  state: Exclude<LocalFontsState, "unsupported">;
  count: number;
  request: () => void;
}

/**
 * The installed-fonts provider (wasm/local-fonts.ts) for the session menu: null until boot
 * installed it, and in browsers without the Local Font Access API.
 */
export function useLocalFonts(ready: boolean): LocalFontsMenuState | null {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const provider = ready ? globalThis.__pcbjamLocalFonts : undefined;
    if (!provider) return;
    bump();
    return provider.subscribe(bump);
  }, [ready]);
  const provider = ready ? globalThis.__pcbjamLocalFonts : undefined;
  if (!provider) return null;
  const state = provider.state();
  if (state === "unsupported") return null;
  return { state, count: provider.count(), request: () => void provider.request() };
}
