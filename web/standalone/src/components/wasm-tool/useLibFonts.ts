import * as React from "react";

export interface LibFontsMenuState {
  /** Font files in the team's libraries. */
  count: number;
}

/**
 * The team library fonts provider (wasm/lib-fonts.ts, fonts 0002) for the session menu: null
 * until boot installed it, and in sessions without one (viewers, no project).
 */
export function useLibFonts(ready: boolean): LibFontsMenuState | null {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const provider = ready ? globalThis.__pcbjamLibFonts : undefined;
    if (!provider) return;
    bump();
    return provider.subscribe(bump);
  }, [ready]);
  const provider = ready ? globalThis.__pcbjamLibFonts : undefined;
  if (!provider) return null;
  return { count: provider.count() };
}
