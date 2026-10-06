#!/usr/bin/env node
// @ts-check
/**
 * pcbjam-tools — headless KiCad for scripts and AI agents (mcp 0004 §11).
 *
 *   pcbjam-tools --erc|--drc|--lint|--gerbers|… <args>   kicad_tools, unchanged
 *   pcbjam-tools board-shot <file.kicad_pcb> <out.png|out.svg>
 *       [--preset top|bottom|copper|editor] [--layers a,b,…]
 *       [--crop cx,cy,halfW,halfH] [--width px] [--background color|none]
 *   pcbjam-tools schematic-shot <file.kicad_sch> <out.png|out.svg>
 *       [--sheet name] [--crop cx,cy,halfW,halfH] [--width px] [--background color|none]
 *   pcbjam-tools step <file.kicad_pcb> <out> [--format step|stepz|glb|stl] [--models dir]
 *   pcbjam-tools where        which module builds this CLI uses
 *
 * Exit codes follow kicad_tools: 0 ok, 1 violations found, 2 usage,
 * 4 input invalid, other = failure.
 */
import { boardShot, schematicShot } from "./commands.mjs";
import { readManifest, moduleDir } from "./modules.mjs";
import { runKicadTools } from "./kicad-tools.mjs";
import { stepExport } from "./step.mjs";

/** @param {string[]} argv */
function options(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) opts[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
    else rest.push(a);
  }
  return { opts, rest };
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h") {
    process.stderr.write(
      "usage: pcbjam-tools <kicad_tools flags…> | board-shot | schematic-shot | step | where — see the README\n",
    );
    return 2;
  }
  if (cmd.startsWith("--")) return (await runKicadTools([cmd, ...argv], { inherit: true })).exitCode;

  const { opts, rest } = options(argv);
  switch (cmd) {
    case "board-shot":
      return boardShot(rest[0], rest[1], opts);
    case "schematic-shot":
      return schematicShot(rest[0], rest[1], opts);
    case "step":
      return stepExport(rest[0], rest[1], opts);
    case "where": {
      const manifest = await readManifest();
      const out = { version: manifest.version, kicad_tools: await moduleDir("kicad_tools").catch((e) => String(e.message)) };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }
    default:
      process.stderr.write(`pcbjam-tools: unknown command ${cmd}\n`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`pcbjam-tools: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  },
);
