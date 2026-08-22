import { describe, expect, it } from "vitest";
import { fileToDoc } from "@pcbjam/shared";
import { nonItemProjectionSignature } from "./projection-structure";

const BASE = `(kicad_pcb
  (version 20241229)
  (paper "A4")
  (lib_symbols (symbol "Device:R" (property "Reference" "R")))
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1")))`;

describe("non-item native projection signature", () => {
  it("ignores root-item content/order handled by the item bridge", () => {
    const left = fileToDoc(BASE);
    const right = fileToDoc(`(kicad_pcb
      (paper "A4")
      (version 20241229)
      (lib_symbols (symbol "Device:R" (property "Reference" "R")))
      (via (at 9 9) (size 0.8) (uuid "via-2"))
      (segment (start 7 7) (end 8 8) (width 0.9) (uuid "seg-1")))`);

    expect(nonItemProjectionSignature(right)).toBe(
      nonItemProjectionSignature(left),
    );
  });

  it.each([
    ["root form", BASE.replace("kicad_pcb", "kicad_sch")],
    ["layout head", BASE.replace('(paper "A4")', '(paper "A3")')],
    ["library definition", BASE.replace('(property "Reference" "R")', '(property "Reference" "X")')],
    ["root atom", `(kicad_pcb unexpected ${BASE.slice("(kicad_pcb".length)}`],
  ])("detects a %s change that requires rehydration", (_label, changed) => {
    expect(nonItemProjectionSignature(fileToDoc(changed))).not.toBe(
      nonItemProjectionSignature(fileToDoc(BASE)),
    );
  });
});
