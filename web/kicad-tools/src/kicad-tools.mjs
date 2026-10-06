// @ts-check
import { spawn } from "node:child_process";
import { join } from "node:path";
import { moduleDir } from "./modules.mjs";

/**
 * Run the kicad_tools CLI (its own Node process: the module exits the
 * process when done). `inherit` passes stdio through (the plain CLI);
 * otherwise stderr is captured for the caller.
 * @param {string[]} args
 * @param {{ inherit?: boolean }} [opts]
 * @returns {Promise<{ exitCode: number, stderr: string }>}
 */
export async function runKicadTools(args, opts = {}) {
  const dir = await moduleDir("kicad_tools");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, "kicad_tools.js"), ...args], {
      stdio: opts.inherit ? "inherit" : ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
}
