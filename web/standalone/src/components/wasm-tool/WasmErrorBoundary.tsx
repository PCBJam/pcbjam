// Extracted from WasmTool.tsx (2026-08-25 split) — behavior unchanged.
import * as React from "react";

/**
 * Keeps a poisoned wasm runtime from taking the React tree down with it.
 *
 * The v0.1.21 prod crash logs showed the actual white-screen mechanism: after
 * a wasm trap, some child's EFFECT calls into the dead runtime (an embind
 * entry via a react-query subscription), the throw lands in React's commit,
 * and React unmounts the whole root — destroying the fatal overlay AND the
 * console panel, the two things built to report exactly this. The boundary
 * absorbs descendant render/effect throws: it reports up (the parent promotes
 * its fatal screen, which lives OUTSIDE this boundary) and renders nothing in
 * place of the dead subtree. WasmTool's own state — logs included — survives.
 */
export class WasmErrorBoundary extends React.Component<
  { onFatal: (msg: string) => void; children: React.ReactNode },
  { dead: boolean }
> {
  state = { dead: false };

  static getDerivedStateFromError() {
    return { dead: true };
  }

  componentDidCatch(err: unknown) {
    this.props.onFatal(err instanceof Error ? err.message : String(err));
  }

  render() {
    return this.state.dead ? null : this.props.children;
  }
}

