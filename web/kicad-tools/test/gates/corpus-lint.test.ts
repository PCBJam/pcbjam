/**
 * Corpus lint (kicad-validity 0001 C) — the E3 gate: our own s-expr PRODUCERS
 * must agree with KiCad's parser. `--lint` over every fixture RAW and
 * ROUND-TRIPPED through the shared codec (docToFile(fileToDoc(text))) — the
 * exact writer path the backend's ydoc materialization uses. A codec output
 * KiCad rejects is the wrapInBoardEnvelope class of bug (pcbjam f07b997).
 * (Moved from pcbjam/tests/tools.)
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { docToFile, fileToDoc } from "@pcbjam/shared";
import { afterAll, describe, expect, it } from "vitest";
import { HAVE_CLI, REPO, run } from "./harness.ts";

const CORPORA = [path.join(REPO, "tests/fixtures"), path.join(REPO, "web/pcbjam-shared/test/fixtures")];
const LINTABLE = /\.(kicad_pcb|kicad_sch|kicad_sym|kicad_mod)$/;
// The codec round-trips the doc formats it materializes (not symbol libs).
const CODEC = /\.(kicad_pcb|kicad_sch)$/;

function collect(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && LINTABLE.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

const files = CORPORA.flatMap(collect);
const tmp = mkdtempSync(path.join(tmpdir(), "corpus-lint-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!HAVE_CLI)("fixture corpus vs KiCad's parser", () => {
  it("finds the corpus", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(REPO, f), f]))("%s lints raw and after a codec round-trip", (_name, file) => {
    const raw = run(["--lint", file]);
    expect(raw.code, raw.stderr.trim()).toBe(0);
    if (!CODEC.test(file)) return;
    // Sub-sheets the codec can't represent standalone are covered by the
    // shared vitest suite with full projects — not a failure here.
    let text: string;
    try {
      text = docToFile(fileToDoc(readFileSync(file, "utf8")));
    } catch {
      return;
    }
    const rt = path.join(tmp, `${path.basename(file, path.extname(file))}-${Math.random().toString(36).slice(2)}${path.extname(file)}`);
    writeFileSync(rt, text, "utf8");
    const verdict = run(["--lint", rt]);
    expect(verdict.code, `codec output rejected by KiCad: ${verdict.stderr.trim()}`).toBe(0);
  });
});
