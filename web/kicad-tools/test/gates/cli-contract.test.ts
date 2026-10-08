/**
 * kicad_tools CLI contract (tasks-runner 0001 T6) — pins the exact behavior
 * the backend job runner depends on: --resave/--lint semantics and the
 * exit-code contract (0 ok / 1 lint-fail / 2 usage / 4 input-invalid /
 * 5 write-failed). Only exit 4 flags a file invalid, so a drifting code here
 * silently breaks the upload gate. (Moved from pcbjam/tests/tools.)
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HAVE_CLI, REPO, run } from "./harness.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "cli-contract-"));
const out = (name: string) => path.join(tmp, name);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A valid PNG of random RGB pixels (does not compress), base64. */
function noisePng(w: number, h: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let seed = 1;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < w * 3; x++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      raw[y * (w * 3 + 1) + 1 + x] = seed >>> 24;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const version = (file: string) => Number(/\(version (\d+)\)/.exec(readFileSync(file, "utf8"))?.[1] ?? 0);

const demoPcb = path.join(REPO, "tests/fixtures/demo/demo.kicad_pcb");
const demoSch = path.join(REPO, "tests/fixtures/demo/demo.kicad_sch");
const hierSch = path.join(REPO, "web/pcbjam-shared/test/fixtures/kicad/flat_hierarchy.kicad_sch");
const qaMod = path.join(
  REPO,
  "kicad/qa/data/libraries/Resistor_SMD.pretty/R_0201_0603Metric_Pad0.64x0.40mm_HandSolder.kicad_mod",
);
const tuningPcb = path.join(REPO, "kicad/qa/data/pcbnew/diff_pair_uncoupled_tuning_drc.kicad_pcb");

describe.skipIf(!HAVE_CLI)("kicad_tools CLI contract", () => {
  it("resaves a board: version bump, relints clean", () => {
    const r = run(["--resave", demoPcb, out("pcb")]);
    const produced = path.join(out("pcb"), "demo.kicad_pcb");
    expect(r.code, r.stderr).toBe(0);
    expect(version(produced)).toBeGreaterThan(version(demoPcb));
    expect(run(["--lint", produced]).code).toBe(0);
  });

  // Every caller reads only the entry's own file (kicad-validity 0005), so a
  // hierarchy is loaded whole but only the entry sheet is written;
  // --all-sheets keeps the one-file-per-sheet output.
  it("resaves schematics: the entry sheet only, unless --all-sheets", () => {
    const r = run(["--resave", demoSch, out("sch")]);
    expect(r.code, r.stderr).toBe(0);
    expect(readdirSync(out("sch")).filter((f) => f.endsWith(".kicad_sch"))).toHaveLength(1);
    if (!existsSync(hierSch)) return;
    const h = run(["--resave", hierSch, out("hier")]);
    expect(h.code, h.stderr).toBe(0);
    expect(h.stderr).toContain("(resave, 1 sheet files)");
    expect(readdirSync(out("hier"))).toEqual([path.basename(hierSch)]);
    expect(run(["--lint", path.join(out("hier"), path.basename(hierSch))]).code).toBe(0);

    const all = run(["--resave", "--all-sheets", hierSch, out("hier-all")]);
    expect(all.code, all.stderr).toBe(0);
    const produced = readdirSync(out("hier-all")).filter((f) => f.endsWith(".kicad_sch"));
    expect(produced.length).toBeGreaterThan(1);
    for (const f of produced) expect(run(["--lint", path.join(out("hier-all"), f)]).code, f).toBe(0);
  });

  // FormatStreamData sliced a UTF-8 wxString per 76-char line, which is
  // quadratic: a 143 KB image took 3 s, a few of them made a sheet resave
  // take minutes (kicad-validity 0005). The data must come back unchanged.
  it("writes a large image quickly and byte-for-byte", () => {
    const data = noisePng(320, 320);
    const lines: string[] = [];
    for (let i = 0; i < data.length; i += 76) lines.push(`"${data.slice(i, i + 76)}"`);
    const sch = out("big-image.kicad_sch");
    writeFileSync(
      sch,
      `(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")
  (uuid "1c7e2a40-6b1d-4c1e-9f0a-3d4b5c6d7e80") (paper "A4")
  (lib_symbols)
  (image (at 100 100) (scale 1) (uuid "2d8f3b51-7c2e-4d2f-8a1b-4e5c6d7e8f91")
    (data ${lines.join("\n")}))
  (sheet_instances (path "/" (page "1")))
)
`,
    );
    const t0 = Date.now();
    const r = run(["--resave", sch, out("big-image")]);
    const ms = Date.now() - t0;
    expect(r.code, r.stderr).toBe(0);
    const written = readFileSync(path.join(out("big-image"), "big-image.kicad_sch"), "utf8");
    const back = /\(data\s+((?:"[^"]*"\s*)+)\)/.exec(written)?.[1]?.replace(/["\s]/g, "");
    expect(back).toBe(data);
    // ~400 KB of base64: seconds to minutes before the fix, well under 1 s after.
    expect(ms).toBeLessThan(10_000);
  });

  // The headless runtime skips InitPgm(), so each side registers the wx image
  // handlers itself; without them a sheet or board with a picture exits 4 and
  // the upload gate flags a valid file ("Failed to read image data.").
  it("keeps embedded images on both sides", () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const imageSch = out("image.kicad_sch");
    writeFileSync(
      imageSch,
      `(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")
  (uuid "6f1d3c1e-5d0b-4c53-9a0e-2a1b7c9d4e10") (paper "A4")
  (lib_symbols)
  (image (at 100 100) (scale 1) (uuid "0b9a5c1f-3e2d-4f6a-8b7c-1d2e3f4a5b6c")
    (data "${png}"))
  (sheet_instances (path "/" (page "1")))
)
`,
    );
    const sch = run(["--resave", imageSch, out("image-sch")]);
    expect(sch.code, sch.stderr).toBe(0);
    expect(readFileSync(path.join(out("image-sch"), "image.kicad_sch"), "utf8")).toContain("(image");
    expect(run(["--lint", imageSch]).code).toBe(0);

    const imagePcb = out("image.kicad_pcb");
    writeFileSync(
      imagePcb,
      `(kicad_pcb (version 20240108) (generator "pcbnew") (generator_version "8.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user "F.Silkscreen") (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (image (at 100 100) (layer "F.SilkS") (scale 1) (uuid "7c2e4d6f-1a3b-4c5d-9e8f-0a1b2c3d4e5f")
    (data "${png}"))
)
`,
    );
    const pcb = run(["--resave", imagePcb, out("image-pcb")]);
    expect(pcb.code, pcb.stderr).toBe(0);
  });

  // The diet has no pcbnew/generators/, so the CLI registers a stand-in that
  // carries the saved properties through; without it every board with a
  // tuning pattern exits 4 ("Cannot create generated object of type …").
  it.skipIf(!existsSync(tuningPcb))("writes a length-tuning pattern back unchanged", () => {
    const generated = (file: string): string[] => {
      const text = readFileSync(file, "utf8");
      const blocks: string[] = [];
      for (let at = text.indexOf("(generated"); at !== -1; at = text.indexOf("(generated", at + 1)) {
        let depth = 0;
        let end = at;
        do {
          if (text[end] === "(") depth++;
          else if (text[end] === ")") depth--;
          end++;
        } while (depth > 0 && end < text.length);
        blocks.push(text.slice(at, end).replace(/\s+/g, " ").replace(/ \)/g, ")"));
      }
      return blocks.sort();
    };
    const r = run(["--resave", tuningPcb, out("tuning")]);
    expect(r.code, r.stderr).toBe(0);
    const before = generated(tuningPcb);
    expect(before.length).toBeGreaterThan(0);
    expect(generated(path.join(out("tuning"), path.basename(tuningPcb)))).toEqual(before);
    expect(run(["--lint", tuningPcb]).code).toBe(0);
  });

  it.skipIf(!existsSync(qaMod))("resaves a footprint with its (version) header", () => {
    const r = run(["--resave", qaMod, out("mod")]);
    const produced = path.join(out("mod"), path.basename(qaMod));
    expect(r.code, r.stderr).toBe(0);
    expect(version(produced)).toBeGreaterThan(20200000);
    expect(run(["--lint", produced]).code).toBe(0);
  });

  // The bulk-upload normalization mode: outputs under <outdir>/<index>/,
  // per-file verdicts as "RESAVE-BATCH <index> <exit-code>" stderr lines with
  // the single-file code contract, process exit 0 when the loop completed —
  // an invalid file mid-batch must not mask its neighbors.
  it("resave-batch: N files, one process, per-entry verdicts", () => {
    const badMid = out("mid-garbage.kicad_sch");
    writeFileSync(badMid, "not a schematic (");
    const r = run(["--resave-batch", out("batch"), demoPcb, badMid, demoSch]);
    const codes = new Map<number, number>();
    for (const m of r.stderr.matchAll(/^RESAVE-BATCH (\d+) (-?\d+)$/gm)) codes.set(Number(m[1]), Number(m[2]));
    expect(r.code, r.stderr).toBe(0);
    expect(codes).toEqual(new Map([[0, 0], [1, 4], [2, 0]]));
    const producedPcb = path.join(out("batch"), "0", "demo.kicad_pcb");
    expect(existsSync(producedPcb) && version(producedPcb) > version(demoPcb)).toBe(true);
    const producedSch = path.join(out("batch"), "2", "demo.kicad_sch");
    expect(existsSync(producedSch)).toBe(true);
    expect(existsSync(path.join(out("batch"), "1", path.basename(badMid)))).toBe(false);
    expect(run(["--lint", producedPcb, producedSch]).code).toBe(0);
    expect(run(["--resave-batch", out("bu")]).code).toBe(2);
  });

  it("keeps the exit-code contract", () => {
    expect(run(["--resave"]).code).toBe(2);
    const garbage = out("garbage.kicad_pcb");
    writeFileSync(garbage, "not a board (");
    expect(run(["--resave", garbage, out("g")]).code).toBe(4); // the upload-gate signal
    expect(run(["--lint", garbage]).code).toBe(1);
    const unsupported = out("readme.txt");
    writeFileSync(unsupported, "hello");
    expect(run(["--resave", unsupported, out("u")]).code).toBe(2);
  });
});
