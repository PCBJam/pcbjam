// Bundle the collab browser entry (reconciler + Yjs + BroadcastChannel transport,
// sourced from the web frontend) into a single IIFE the pl_editor harness loads.
// nodePaths lets esbuild resolve `yjs` from tests/node_modules even though the
// reconciler lives under web/. Output: apps/kicad/collab-bundle.js (global KicadCollab).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAtomic } from "./atomic-build.mjs";

const testsDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

await buildAtomic({
  entryPoints: [path.join(testsDir, "collab/browser-entry.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(testsDir, "apps/kicad/collab-bundle.js"),
  nodePaths: [path.join(testsDir, "node_modules")],
  // The e2e harness only exercises the BroadcastChannel transport; the server
  // providers are reached via dynamic import() that never runs in tests, and
  // their packages are only installed in the web/ pnpm workspace.
  external: ["y-partyserver/provider", "@hocuspocus/provider"],
  logLevel: "info",
  target: "es2020",
});

console.log("collab bundle built → apps/kicad/collab-bundle.js");

// The V2 ("items") bundle — the PRODUCTION collab stack (see browser-entry-v2.ts).
await buildAtomic({
  entryPoints: [path.join(testsDir, "collab/browser-entry-v2.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(testsDir, "apps/kicad/collab-bundle-v2.js"),
  nodePaths: [path.join(testsDir, "node_modules")],
  external: ["y-partyserver/provider", "@hocuspocus/provider"],
  alias: {
    // web/standalone and web/pcbjam-shared are separate pnpm workspaces, so
    // their `yjs` imports resolve to two physical copies. The v2 binding hands
    // Y types across that boundary (instanceof-checked), so force ONE copy —
    // the tests devDep — exactly like the standalone vitest `dedupe: ["yjs"]`.
    yjs: path.join(testsDir, "node_modules/yjs"),
    // Lets this entry (which lives under tests/, outside the web workspaces)
    // import the shared lib by name, resolving to the SAME source instance the
    // standalone collab modules bundle.
    "@pcbjam/shared": path.join(testsDir, "../web/pcbjam-shared/src/index.ts"),
  },
  logLevel: "info",
  target: "es2020",
});

console.log("collab v2 bundle built → apps/kicad/collab-bundle-v2.js");
