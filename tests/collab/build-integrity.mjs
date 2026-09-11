// Bundle the ysync-integrity browser entry (see browser-entry-integrity.ts).
// Same alias rules as build.mjs's v2 bundle: ONE yjs copy, shared by source.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

await build({
  entryPoints: [path.join(testsDir, "collab/browser-entry-integrity.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(testsDir, "apps/kicad/collab-integrity.js"),
  nodePaths: [path.join(testsDir, "node_modules")],
  external: ["y-partyserver/provider", "@hocuspocus/provider"],
  alias: {
    yjs: path.join(testsDir, "node_modules/yjs"),
    "@pcbjam/shared": path.join(testsDir, "../web/pcbjam-shared/src/index.ts"),
  },
  logLevel: "info",
  target: "es2020",
});

console.log("integrity bundle built → apps/kicad/collab-integrity.js");
