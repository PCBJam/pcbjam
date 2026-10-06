/**
 * New KiCad project templates (new-kicad-project 0001 §5): every generated
 * variant must load in KiCad, and the rules must actually reach DRC. For each
 * built-in fab profile × tier × layer count: lint passes on the .kicad_sch,
 * .kicad_pcb and .kicad_dru; DRC on the empty board loads the custom rules
 * and reports nothing but the missing outline; a 0.15 mm track and a 0.25 mm
 * via hole are flagged exactly when the template's minimum is above them.
 * (Moved from pcbjam/tests/tools.)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BUILTIN_FAB_PROFILES, defaultChoices, generateKicadProject, profileHasMinimums, resolveFabRules } from "@pcbjam/shared";
import { afterAll, describe, expect, it } from "vitest";
import { HAVE_CLI, run } from "./harness.ts";

interface DrcReport {
  violations?: { type: string; severity: string; description: string }[];
}

function drc(pcb: string): { code: number; stderr: string; report: DrcReport } {
  const out = pcb.replace(/\.kicad_pcb$/, "-drc.json");
  const r = run(["--drc", "--json", pcb, out]);
  return { ...r, report: existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as DrcReport) : {} };
}

const TRACK = '\t(segment (start 10 10) (end 20 10) (width 0.15) (layer "F.Cu") (net 0) (uuid "6f1b9a52-0000-4000-8000-000000000001"))\n';
const VIA = '\t(via (at 30 30) (size 0.6) (drill 0.25) (layers "F.Cu" "B.Cu") (net 0) (uuid "6f1b9a52-0000-4000-8000-000000000002"))\n';

const variants = BUILTIN_FAB_PROFILES.flatMap((profile) =>
  Object.keys(profile.tiers).flatMap((tier) =>
    profile.options.layers.flatMap((layers) =>
      // smallest=true only where the profile publishes absolute minimums.
      (profileHasMinimums(profile) ? [false, true] : [false]).map((smallest) => ({ profile, tier, layers, smallest })),
    ),
  ),
);

const root = mkdtempSync(path.join(tmpdir(), "kicad-templates-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!HAVE_CLI)("new KiCad project templates", () => {
  it.each(variants.map((v) => [`${v.profile.id} ${v.tier} ${v.layers}L${v.smallest ? " smallest" : ""}`, v]))(
    "%s loads and enforces its rules",
    (label, { profile, tier, layers, smallest }) => {
      const dir = path.join(root, label.replace(/\s+/g, "-"));
      mkdirSync(dir, { recursive: true });
      const files = generateKicadProject(
        profile,
        { ...defaultChoices(profile), tier, layers, stackup: undefined, smallest },
        { name: "board", dir: "", date: "2026-10-05" },
      );
      for (const f of files) writeFileSync(path.join(dir, f.path), f.text);
      const pcb = path.join(dir, "board.kicad_pcb");
      const dru = path.join(dir, "board.kicad_dru");
      for (const file of [path.join(dir, "board.kicad_sch"), pcb, ...(existsSync(dru) ? [dru] : [])]) {
        const r = run(["--lint", file]);
        expect(r.code, `lint ${path.basename(file)}: ${r.stderr.trim()}`).toBe(0);
      }

      const empty = drc(pcb);
      expect(empty.stderr).not.toMatch(/custom DRC rules failed to load/);
      // The only expected error: a new board has no outline yet.
      const errors = (empty.report.violations ?? []).filter((v) => v.severity === "error" && v.type !== "invalid_outline");
      expect(errors.map((v) => v.type)).toEqual([]);

      const resolved = resolveFabRules(profile, { tier, layers, copperOuter: defaultChoices(profile).copperOuter, smallest });
      const minTrack = resolved.trackWidth?.mm ?? 0;
      writeFileSync(pcb, readFileSync(pcb, "utf8").replace(/\)\n$/, `${TRACK})\n`));
      const withTrack = drc(pcb);
      const trackFlagged = (withTrack.report.violations ?? []).some((v) => v.type === "track_width");
      expect(trackFlagged, `min track ${minTrack} mm; ${withTrack.stderr.trim()}`).toBe(minTrack > 0.15);

      const minVia = Math.max(resolved.viaDrill?.mm ?? 0, resolved.holeMin?.mm ?? 0);
      writeFileSync(pcb, readFileSync(pcb, "utf8").replace(/\)\n$/, `${VIA})\n`));
      const withVia = drc(pcb);
      const drillFlagged = (withVia.report.violations ?? []).some((v) => v.type === "drill_out_of_range");
      expect(drillFlagged, `via drill ${minVia} mm; ${withVia.stderr.trim()}`).toBe(minVia > 0.25);
    },
  );
});
