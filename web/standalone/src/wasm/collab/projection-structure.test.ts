import { describe, expect, it } from "vitest";
import { fileToDoc } from "@pcbjam/shared";
import {
  accountNativeLayoutSave,
  nonItemProjectionSignature,
  nonItemProjectionState,
} from "./projection-structure";

const BASE = `(kicad_pcb
  (version 20241229)
  (paper "A4")
  (lib_symbols (symbol "Device:R" (property "Reference" "R")))
  (symbol (lib_id "Device:R") (at 1 1) (uuid "sym-1"))
  (segment (start 0 0) (end 1 1) (width 0.2) (uuid "seg-1")))`;

describe("non-item native projection signature", () => {
  it("ignores root-item content/order handled by the item bridge", () => {
    const left = fileToDoc(BASE);
    const right = fileToDoc(`(kicad_pcb
      (paper "A4")
      (version 20241229)
      (lib_symbols (symbol "Device:R" (property "Reference" "R")))
      (via (at 9 9) (size 0.8) (uuid "via-2"))
      (symbol (lib_id "Device:R") (at 2 2) (uuid "sym-1"))
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

  it("separates hard layout drift from exact library-definition drift", () => {
    const base = nonItemProjectionState(fileToDoc(BASE));
    const libraryChanged = nonItemProjectionState(
      fileToDoc(
        BASE.replace(
          '(property "Reference" "R")',
          '(property "Reference" "X")',
        ),
      ),
    );
    const layoutChanged = nonItemProjectionState(
      fileToDoc(BASE.replace('(paper "A4")', '(paper "A3")')),
    );

    expect(libraryChanged.hardSignature).toBe(base.hardSignature);
    expect(libraryChanged.libraries).not.toEqual(base.libraries);
    expect(layoutChanged.hardSignature).not.toBe(base.hardSignature);
  });

  it("a layout save accounts only definitions that exact save authored", () => {
    const native = {
      hardSignature: "native-hard",
      libraries: { "Device:R": "R-native" },
    };
    const desired = {
      hardSignature: "saved-hard",
      libraries: {
        "Device:R": "R-native",
        "Device:C": "C-peer-unprojected",
      },
    };

    expect(accountNativeLayoutSave(native, desired, [], true)).toEqual({
      hardSignature: "saved-hard",
      // Device:C merely coexisted in authoritative Y. The native save did not
      // author/touch it, so it must remain visibly unprojected.
      libraries: { "Device:R": "R-native" },
    });
  });

  it("a layout save accounts exact definition upserts and deletions", () => {
    const native = {
      hardSignature: "same-hard",
      libraries: { "Device:R": "old-R", "Device:X": "native-only" },
    };
    const desired = {
      hardSignature: "same-hard",
      libraries: { "Device:R": "saved-R", "Device:C": "saved-C" },
    };

    expect(
      accountNativeLayoutSave(
        native,
        desired,
        ["Device:R", "Device:C", "Device:X"],
        false,
      ),
    ).toEqual({
      hardSignature: "same-hard",
      libraries: { "Device:R": "saved-R", "Device:C": "saved-C" },
    });
  });
});
