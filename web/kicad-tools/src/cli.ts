#!/usr/bin/env node
/**
 * pcbjam-tools — headless KiCad for scripts and AI agents (mcp 0004 §11).
 *
 *   pcbjam-tools --erc|--drc|--lint|--gerbers|… <args>   kicad_tools, unchanged
 *   pcbjam-tools board-shot <file.kicad_pcb> <out.png|out.svg>
 *       [--preset top|bottom|copper|editor] [--layers a,b,…]
 *       [--crop cx,cy,halfW,halfH] [--width px] [--background color|none]
 *   pcbjam-tools schematic-shot <file.kicad_sch> <out.png|out.svg>
 *       [--sheet name] [--crop cx,cy,halfW,halfH] [--width px] [--background color|none]
 *   pcbjam-tools board-3d-shot <file.kicad_pcb> <out.png>
 *       [--view top|bottom|iso|iso-back|front] [--azimuth deg --elevation deg]
 *       [--crop cx,cy,halfW,halfH] [--width px] [--background #rrggbb|none] [--models dir|cdn]
 *   pcbjam-tools step <file.kicad_pcb> <out> [--format step|stepz|glb|stl] [--models dir|cdn] [--models-dir dir]
 *   pcbjam-tools fetch [--to dir]   download + verify the pinned builds (into dir)
 *   pcbjam-tools where        which module builds this CLI uses
 *
 * Exit codes follow kicad_tools: 0 ok, 1 violations found, 2 usage,
 * 4 input invalid, other = failure.
 */
import { boardShot, schematicShot, type Options } from "./commands.ts";
import { runKicadTools } from "./kicad-tools.ts";
import { board3dShot } from "./shot3d.ts";
import { fetchAll, moduleDir, readManifest } from "./modules.ts";
import { stepExport } from "./step.ts";

function options(argv: string[]): { opts: Options; rest: string[] } {
  const opts: Options = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = argv[i + 1];
    if (a.startsWith("--")) opts[a.slice(2)] = next === undefined || next.startsWith("--") ? "true" : argv[++i];
    else rest.push(a);
  }
  return { opts, rest };
}

async function main(): Promise<number> {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h") {
    process.stderr.write(
      "usage: pcbjam-tools <kicad_tools flags…> | board-shot | schematic-shot | board-3d-shot | step | fetch | where — see the README\n",
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
    case "board-3d-shot":
      return board3dShot(rest[0], rest[1], opts);
    case "step":
      return stepExport(rest[0], rest[1], opts);
    case "fetch": {
      const versions = await fetchAll(opts.to);
      process.stderr.write(`pcbjam-tools: ${Object.entries(versions).map(([t, v]) => `${t} ${v}`).join(", ")}${opts.to ? ` -> ${opts.to}` : ""}\n`);
      return 0;
    }
    case "where": {
      const manifest = await readManifest();
      const out = {
        version: manifest.version,
        kicad_tools: await moduleDir("kicad_tools").catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
      };
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
  (err: unknown) => {
    process.stderr.write(`pcbjam-tools: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  },
);
