/**
 * New KiCad project templates (new-kicad-project 0001 §5): every generated
 * variant must load in KiCad, and the rules must actually reach DRC.
 *
 * For each built-in fab profile × tier × layer count:
 *   - `kicad_tools --lint` passes on the .kicad_sch, .kicad_pcb and .kicad_dru;
 *   - `kicad_tools --drc --json` on the empty board loads the custom rules
 *     (no "custom DRC rules failed to load") and reports no errors besides
 *     the missing board outline;
 *   - a 0.15 mm track breaks the KiCad-default 0.2 mm minimum but not a fab's
 *     0.1 mm one — proof that .kicad_pro's `board.design_settings.rules` is
 *     read, not silently ignored under a wrong key.
 *
 * SKIPs (exit 0) when output/kicad_tools.js is absent, like corpus-lint.ts.
 * Run: cd tests && npm run tools:templates (also part of tools:contract).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_FAB_PROFILES,
  defaultChoices,
  generateKicadProject,
  resolveFabRules,
} from "../../web/pcbjam-shared/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const cli = path.join(repo, "output/kicad_tools.js");

if (!existsSync(cli)) {
  console.log("kicad-project-templates: SKIP — output/kicad_tools.js not built");
  process.exit(0);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(args: string[]): { code: number; stderr: string } {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

interface DrcReport {
  violations?: { type: string; severity: string; description: string }[];
}

function drc(pcb: string): { code: number; stderr: string; report: DrcReport } {
  const out = pcb.replace(/\.kicad_pcb$/, "-drc.json");
  const r = run(["--drc", "--json", pcb, out]);
  const report = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as DrcReport) : {};
  return { ...r, report };
}

const TRACK = '\t(segment (start 10 10) (end 20 10) (width 0.15) (layer "F.Cu") (net 0) (uuid "6f1b9a52-0000-4000-8000-000000000001"))\n';

const root = mkdtempSync(path.join(tmpdir(), "kicad-templates-"));
try {
  for (const profile of BUILTIN_FAB_PROFILES) {
    for (const tier of Object.keys(profile.tiers)) {
      for (const layers of profile.options.layers) {
        const label = `${profile.id} ${tier} ${layers}L`;
        const dir = path.join(root, `${profile.id}-${tier}-${layers}`);
        mkdirSync(dir, { recursive: true });
        const files = generateKicadProject(
          profile,
          { ...defaultChoices(profile), tier, layers, stackup: undefined },
          { name: "board", dir: "", date: "2026-10-05" },
        );
        for (const f of files) writeFileSync(path.join(dir, f.path), f.text);
        const sch = path.join(dir, "board.kicad_sch");
        const pcb = path.join(dir, "board.kicad_pcb");
        const dru = path.join(dir, "board.kicad_dru");

        for (const file of [sch, pcb, ...(existsSync(dru) ? [dru] : [])]) {
          const r = run(["--lint", file]);
          check(`${label}: lint ${path.basename(file)}`, r.code === 0, r.stderr.trim());
        }

        const empty = drc(pcb);
        check(`${label}: rules load`, !/custom DRC rules failed to load/.test(empty.stderr), empty.stderr.trim());
        // The only expected error: a new board has no outline yet.
        const errors = (empty.report.violations ?? []).filter((v) => v.severity === "error" && v.type !== "invalid_outline");
        check(`${label}: empty board has no DRC errors besides the missing outline`, errors.length === 0, errors.map((v) => v.type).join(", "));

        // A 0.15 mm track: must fail exactly when the template's minimum is above it.
        const minTrack = resolveFabRules(profile, { tier, layers, copperOuter: defaultChoices(profile).copperOuter }).trackWidth?.mm ?? 0;
        writeFileSync(pcb, readFileSync(pcb, "utf8").replace(/\)\n$/, `${TRACK})\n`));
        const withTrack = drc(pcb);
        const flagged = (withTrack.report.violations ?? []).some((v) => v.type === "track_width");
        check(
          `${label}: min track ${minTrack} mm reaches DRC`,
          flagged === minTrack > 0.15,
          `track_width flagged=${flagged}, stderr=${withTrack.stderr.trim()}`,
        );
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`kicad-project-templates: ${failures} failure(s)`);
  process.exit(1);
}
console.log("kicad-project-templates: all variants load and enforce their rules");
