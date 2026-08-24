/**
 * kicad_tools CLI contract (tasks-runner 0001 T6) — pins the exact behavior
 * the backend job runner depends on (run-tools-job.ts): --resave/--lint
 * semantics and the exit-code contract (0 ok / 1 lint-fail / 2 usage /
 * 4 input-invalid / 5 write-failed). Only exit 4 flags a file invalid, so a
 * drifting code here silently breaks the upload gate.
 *
 * Sibling of corpus-lint.ts: SKIPs (exit 0) when output/kicad_tools.js is
 * absent; becomes a hard gate in the runner-image CI (tasks-runner 0001 R2).
 *
 * Run: cd tests && npm run tools:contract
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const cli = path.join(repo, "output/kicad_tools.js");

if (!existsSync(cli)) {
  console.log("cli-contract: SKIP — output/kicad_tools.js not built");
  process.exit(0);
}

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Run the CLI; returns { code, stderr } (never throws on non-zero exit). */
function run(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync("node", [cli, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { code: err.status ?? -1, stderr: err.stderr?.toString() ?? "" };
  }
}

function version(file: string): number {
  return Number(/\(version (\d+)\)/.exec(readFileSync(file, "utf8"))?.[1] ?? 0);
}

const tmp = mkdtempSync(path.join(tmpdir(), "cli-contract-"));
const out = (name: string) => path.join(tmp, name);

try {
  const demoPcb = path.join(repo, "tests/fixtures/demo/demo.kicad_pcb");
  const demoSch = path.join(repo, "tests/fixtures/demo/demo.kicad_sch");
  // Multi-sheet schematic from the MIT-licensed shared fixture corpus.
  const hierSch = path.join(
    repo,
    "web/pcbjam-shared/test/fixtures/kicad",
    readdirSync(path.join(repo, "web/pcbjam-shared/test/fixtures/kicad")).find(
      (f) => f === "flat_hierarchy.kicad_sch",
    ) ?? "flat_hierarchy.kicad_sch",
  );
  const qaMod = path.join(
    repo,
    "kicad/qa/data/libraries/Resistor_SMD.pretty/R_0201_0603Metric_Pad0.64x0.40mm_HandSolder.kicad_mod",
  );

  // --- resave: board version bump + relint clean --------------------------
  {
    const r = run(["--resave", demoPcb, out("pcb")]);
    const produced = path.join(out("pcb"), "demo.kicad_pcb");
    check("resave board exits 0", r.code === 0, `exit ${r.code}`);
    check(
      "resave board bumps the format version",
      version(produced) > version(demoPcb),
      `${version(demoPcb)} → ${version(produced)}`,
    );
    check("resaved board lints clean", run(["--lint", produced]).code === 0);
  }

  // --- resave: schematic (single + hierarchy) ------------------------------
  {
    const r = run(["--resave", demoSch, out("sch")]);
    check("resave schematic exits 0", r.code === 0, `exit ${r.code}`);
    const produced = readdirSync(out("sch")).filter((f) => f.endsWith(".kicad_sch"));
    check("single schematic → one sheet file", produced.length === 1, `${produced.length}`);
  }
  if (existsSync(hierSch)) {
    const r = run(["--resave", hierSch, out("hier")]);
    check("resave hierarchy exits 0", r.code === 0, `exit ${r.code}`);
    const produced = readdirSync(out("hier")).filter((f) => f.endsWith(".kicad_sch"));
    check(
      "hierarchical schematic → one file per sheet",
      produced.length > 1,
      `${produced.length} file(s)`,
    );
    check(
      "every produced sheet lints clean",
      produced.every((f) => run(["--lint", path.join(out("hier"), f)]).code === 0),
    );
  }

  // --- resave: footprint keeps the (version) header (CTL_FOR_LIBRARY) ------
  if (existsSync(qaMod)) {
    const r = run(["--resave", qaMod, out("mod")]);
    const produced = path.join(out("mod"), path.basename(qaMod));
    check("resave footprint exits 0", r.code === 0, `exit ${r.code}`);
    check(
      "resaved .kicad_mod carries a (version) header",
      version(produced) > 20200000,
      readFileSync(produced, "utf8").slice(0, 120),
    );
    check("resaved footprint lints clean", run(["--lint", produced]).code === 0);
  } else {
    console.log("skip footprint fixtures (kicad submodule not initialized)");
  }

  // --- resave-batch: N files, one process ----------------------------------
  // The bulk-upload normalization mode: outputs under <outdir>/<index>/,
  // per-file verdicts as "RESAVE-BATCH <index> <exit-code>" stderr lines with
  // the single-file code contract, process exit 0 when the loop completed —
  // an invalid file mid-batch must not mask its neighbors.
  {
    const badMid = out("mid-garbage.kicad_sch");
    writeFileSync(badMid, "not a schematic (");
    const r = spawnSync("node", [cli, "--resave-batch", out("batch"), demoPcb, badMid, demoSch], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = r.stderr?.toString() ?? "";
    const codes = new Map<number, number>();
    for (const m of stderr.matchAll(/^RESAVE-BATCH (\d+) (-?\d+)$/gm)) {
      codes.set(Number(m[1]), Number(m[2]));
    }
    check("batch exits 0 despite an invalid entry", r.status === 0, `exit ${r.status}`);
    check("batch reports one verdict line per entry", codes.size === 3, `${codes.size}`);
    check("batch board entry verdicts 0", codes.get(0) === 0, `${codes.get(0)}`);
    check("batch invalid entry verdicts 4", codes.get(1) === 4, `${codes.get(1)}`);
    check("batch schematic entry verdicts 0", codes.get(2) === 0, `${codes.get(2)}`);
    const producedPcb = path.join(out("batch"), "0", "demo.kicad_pcb");
    check(
      "batch board output lands in its index dir and bumps the version",
      existsSync(producedPcb) && version(producedPcb) > version(demoPcb),
    );
    const producedSch = path.join(out("batch"), "2", "demo.kicad_sch");
    check("batch schematic output lands in its index dir", existsSync(producedSch));
    check(
      "batch invalid entry produced no output dir",
      !existsSync(path.join(out("batch"), "1", path.basename(badMid))),
    );
    check("batch outputs lint clean", run(["--lint", producedPcb, producedSch]).code === 0);

    check("batch usage (no files) exits 2", run(["--resave-batch", out("bu")]).code === 2);
  }

  // --- exit-code contract ---------------------------------------------------
  {
    check("usage (no args) exits 2", run(["--resave"]).code === 2);

    const garbage = out("garbage.kicad_pcb");
    writeFileSync(garbage, "not a board (");
    check("invalid input exits 4 (the upload-gate signal)", run(["--resave", garbage, out("g")]).code === 4);
    check("lint of invalid input exits 1", run(["--lint", garbage]).code === 1);

    const unsupported = out("readme.txt");
    writeFileSync(unsupported, "hello");
    check("unsupported extension exits 2", run(["--resave", unsupported, out("u")]).code === 2);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `cli-contract: ${failures} FAILURE(S)` : "cli-contract: all green");
process.exit(failures ? 1 : 0);
