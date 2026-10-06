import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The kicad_tools gates run the CLI the way production does: through the
 * built pcbjam-tools driver (dist/cli.js; `pnpm test:gates` builds it), with
 * kicad_tools flags passed through. The WebAssembly comes from
 * KICAD_TOOLS_WASM_DIR / KICAD_TOOLS_JS, else the pcbjam checkout's output/.
 *
 * Without a kicad_tools build the gates SKIP — unless
 * PCBJAM_REQUIRE_KICAD_TOOLS=1 (CI legs that build or ship it), where a
 * missing build fails instead of passing silently.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const PKG = path.resolve(here, "../..");
/** The pcbjam repository root. */
export const REPO = path.resolve(PKG, "../..");
const DRIVER = path.join(PKG, "dist/cli.js");

const wasmDir = process.env.KICAD_TOOLS_WASM_DIR || path.join(REPO, "output");
export const HAVE_CLI = Boolean(process.env.KICAD_TOOLS_JS) || existsSync(path.join(wasmDir, "kicad_tools.js"));

if (!HAVE_CLI && process.env.PCBJAM_REQUIRE_KICAD_TOOLS === "1") {
  throw new Error(`kicad_tools gates: no build in ${wasmDir} (PCBJAM_REQUIRE_KICAD_TOOLS=1)`);
}
if (HAVE_CLI && !existsSync(DRIVER)) {
  throw new Error("kicad_tools gates: dist/cli.js missing — run `pnpm build` (pnpm test:gates does)");
}

/** Run `pcbjam-tools <args>`; never throws on a non-zero exit. */
export function run(args: string[]): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [DRIVER, ...args], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}
