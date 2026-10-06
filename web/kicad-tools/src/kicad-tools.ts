import { spawn } from "node:child_process";
import { join } from "node:path";
import { moduleDir } from "./modules.ts";

/**
 * Run the kicad_tools CLI (its own Node process: the module exits the
 * process when done). `inherit` passes stdio through (the plain CLI);
 * otherwise stderr is captured for the caller.
 */
export async function runKicadTools(
  args: string[],
  opts: { inherit?: boolean } = {},
): Promise<{ exitCode: number; stderr: string }> {
  // KICAD_TOOLS_JS: an exact kicad_tools entry (a local build, a stand-in).
  const js = process.env.KICAD_TOOLS_JS || join(await moduleDir("kicad_tools"), "kicad_tools.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [js, ...args], {
      stdio: opts.inherit ? "inherit" : ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
}
