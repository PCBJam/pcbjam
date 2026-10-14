// Bundle the AI chat's agent executor (web/standalone/src/agent/executor.ts)
// with the shared schematic-ops into one IIFE the kicad specs inject
// (agent-executor.spec.ts). Output: apps/kicad/agent-bundle.js (global PcbjamAgent).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAtomic } from "./atomic-build.mjs";

const testsDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const standalone = path.join(testsDir, "../web/standalone");

await buildAtomic({
  entryPoints: [path.join(testsDir, "collab/browser-entry-agent.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(testsDir, "apps/kicad/agent-bundle.js"),
  // The executor's imports resolve from the editor app's workspace.
  nodePaths: [path.join(standalone, "node_modules"), path.join(testsDir, "node_modules")],
  alias: {
    "@": path.join(standalone, "src"),
    "@pcbjam/shared": path.join(testsDir, "../web/pcbjam-shared/src/index.ts"),
  },
  // placement.ts reads the plugin runtime's base for its Worker preflight, which
  // the executor does not use (its blobs are computed, not third-party).
  define: { "import.meta.env": "{}" },
  logLevel: "warning",
  target: "es2020",
});

console.log("agent bundle built → apps/kicad/agent-bundle.js");
